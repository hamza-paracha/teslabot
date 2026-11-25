import { describe, it, expect, vi } from "vitest";
import { normalize } from "../src/tesla/normalization";
import { runScheduled } from "../src/scheduled";
import { Store } from "../src/storage/database";
import { e, store, vin, req } from "./helpers/app";

const id = "a".repeat(24);
const reading = (battery: number, state = "Disconnected") =>
  normalize(
    {
      charge_state: {
        battery_level: battery,
        battery_range: (battery * 4.5) / 1.609344,
        charging_state: state,
        timestamp: Date.now(),
      },
      climate_state: { inside_temp: 18, timestamp: Date.now() },
      vehicle_state: { locked: true, timestamp: Date.now() },
    },
    id,
    "Car",
    false,
  );
const admin = (path: string, body?: unknown) =>
  req(path, {
    ...(body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
const mcp = (path: string, body: unknown) =>
  req(path, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + e.MCP_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
const settings = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  time_zone: "UTC",
  notify: { format: "ntfy", url: "https://ntfy.example.com/secret-topic" },
  plug_in: { enabled: true, local_hour: 0, below_percentage: 50 },
  briefings: {
    enabled: true,
    lead_minutes: 45,
    reserve_percentage: 20,
    only_when_tight: true,
  },
  ...overrides,
});
function notifier(ok = true) {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    ok ? new Response("ok") : new Response("no", { status: 500 }),
  );
}
const deliveryKey = (init?: RequestInit) =>
  new Headers(init?.headers).get("Idempotency-Key");

describe("alert settings", () => {
  it("stores the destination privately and keeps it when omitted", async () => {
    const saved = (await (
      await admin("/admin/alerts", settings())
    ).json()) as any;
    expect(saved.settings.notify).toEqual({
      format: "ntfy",
      host: "ntfy.example.com",
      configured: true,
    });
    const shown = await (await admin("/admin/alerts")).text();
    expect(shown).not.toContain("secret-topic");
    await admin(
      "/admin/alerts",
      settings({ notify: { format: "json" }, enabled: false }),
    );
    expect((await store.get<any>("alert_settings")).notify).toEqual({
      format: "json",
      url: "https://ntfy.example.com/secret-topic",
    });
  });
  it("rejects insecure destinations and enabling without one", async () => {
    for (const body of [
      settings({
        notify: { format: "ntfy", url: "http://ntfy.example.com/t" },
      }),
      settings({
        notify: { format: "ntfy", url: "https://u:p@ntfy.example.com/t" },
      }),
      settings({ notify: null }),
    ])
      expect((await admin("/admin/alerts", body)).status).toBe(400);
  });
});

describe("scheduled alerts", () => {
  it("sends one plug-in reminder per local day, only when unplugged and low", async () => {
    await store.putMany({
      selected: { id, vin },
      summary: reading(30),
      alert_settings: settings(),
    });
    const tesla = vi.fn();
    vi.stubGlobal("fetch", tesla);
    const send = notifier();
    await runScheduled(e, undefined, Date.now(), send);
    await runScheduled(e, undefined, Date.now(), send);
    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0];
    expect(String(url)).toBe("https://ntfy.example.com/secret-topic");
    expect(init?.headers).toMatchObject({ Title: "Plug in tonight?" });
    expect(String(init?.body)).toContain("30% and the car isn't plugged in");
    expect(deliveryKey(init)).toMatch(/^[a-f0-9]{64}$/);
    await runScheduled(e, undefined, Date.now() + 86400000, send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(deliveryKey(send.mock.calls[1][1])).not.toBe(deliveryKey(init));
    expect(tesla).not.toHaveBeenCalled();
    await store.putMany({
      summary: reading(30, "Charging"),
      alert_state: { plug_in_checked_date: null, handled: {} },
    });
    await runScheduled(e, undefined, Date.now(), send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      (await store.get<any>("alert_state")).plug_in_checked_date,
    ).not.toBeNull();
  });
  it("retries after a failed delivery and reports the error", async () => {
    await store.putMany({
      selected: { id, vin },
      summary: reading(30),
      alert_settings: settings({
        notify: { format: "json", url: "https://hooks.example.com/alerts" },
      }),
    });
    vi.stubGlobal("fetch", vi.fn());
    const fail = notifier(false);
    await runScheduled(e, undefined, Date.now(), fail);
    expect(
      ((await (await admin("/admin/alerts")).json()) as any).state,
    ).toMatchObject({
      last_error: "notification_rejected",
      plug_in_checked_date: null,
    });
    const send = notifier();
    await runScheduled(e, undefined, Date.now(), send);
    expect(send).toHaveBeenCalledTimes(1);
    const key = deliveryKey(fail.mock.calls[0][1]);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(deliveryKey(send.mock.calls[0][1])).toBe(key);
  });
  it("does not post the same reminder again if saving alert status fails", async () => {
    await store.putMany({
      selected: { id, vin },
      summary: reading(30),
      alert_settings: settings(),
    });
    vi.stubGlobal("fetch", vi.fn());
    const now = Date.now();
    const put = vi.spyOn(Store.prototype, "put");
    const send = notifier().mockImplementationOnce(async () => {
      put.mockRejectedValueOnce(new Error("D1 unavailable"));
      return new Response("ok");
    });
    try {
      expect(await runScheduled(e, undefined, now, send)).toMatchObject([
        { ran: false, reason: "failed" },
      ]);
      expect(await store.get("alert_state")).toBeNull();
      expect(await runScheduled(e, undefined, now, send)).toMatchObject([
        { ran: true, sent: [], checked: ["plug_in"] },
      ]);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      put.mockRestore();
    }
  });
  it("does nothing and contacts nobody when alerts are off", async () => {
    await store.putMany({
      selected: { id, vin },
      summary: reading(10),
      alert_settings: { ...settings(), enabled: false },
    });
    const send = notifier();
    expect(await runScheduled(e, undefined, Date.now(), send)).toMatchObject([
      { account: "", ran: false, reason: "alerts_disabled" },
    ]);
    expect(send).not.toHaveBeenCalled();
  });
  it("briefs a tight departure, follows a moved event and drops a cancelled one", async () => {
    await store.putMany({
      selected: { id, vin },
      summary: reading(40),
      alert_settings: settings({
        plug_in: { enabled: false, local_hour: 0, below_percentage: 50 },
      }),
    });
    vi.stubGlobal("fetch", vi.fn());
    const soon = new Date(Date.now() + 30 * 60000).toISOString();
    const scheduled = (await (
      await mcp("/api/briefings", {
        events: [
          {
            event_id: "dentist",
            title: "Dentist\u0007",
            departs_at: soon,
            total_distance_km: 150,
          },
          {
            event_id: "gym",
            title: "Gym",
            departs_at: soon,
            total_distance_km: 5,
          },
        ],
      })
    ).json()) as any;
    expect(scheduled.delivery.active).toBe(true);
    expect(scheduled.briefings.map((b: any) => b.title)).toEqual([
      "Dentist",
      "Gym",
    ]);
    const send = notifier();
    await runScheduled(e, undefined, Date.now(), send);
    // Only the tight trip is sent; the short one is checked silently.
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0][1]?.body)).toContain(
      "Dentist: leave around",
    );
    expect(String(send.mock.calls[0][1]?.body)).toContain(
      "below your 20% reserve",
    );
    await runScheduled(e, undefined, Date.now(), send);
    expect(send).toHaveBeenCalledTimes(1);
    const later = new Date(Date.now() + 3 * 3600000).toISOString();
    await mcp("/api/briefings", {
      events: [
        {
          event_id: "dentist",
          title: "Dentist",
          departs_at: later,
          total_distance_km: 150,
        },
      ],
    });
    await runScheduled(e, undefined, Date.now(), send);
    expect(send).toHaveBeenCalledTimes(1);
    await runScheduled(e, undefined, Date.parse(later) - 30 * 60000, send);
    expect(send).toHaveBeenCalledTimes(2);
    const firstKey = deliveryKey(send.mock.calls[0][1]);
    expect(firstKey).toMatch(/^[a-f0-9]{64}$/);
    expect(deliveryKey(send.mock.calls[1][1])).not.toBe(firstKey);
    const cancelled = (await (
      await mcp("/api/briefings", {
        events: [
          {
            event_id: "dentist",
            title: "Dentist",
            departs_at: later,
            cancelled: true,
          },
        ],
      })
    ).json()) as any;
    expect(cancelled.briefings.map((b: any) => b.event_id)).toEqual(["gym"]);
  });
  it("disconnect removes alert settings, briefings and trips", async () => {
    await store.putMany({
      owner_tokens: { access_token: "x", expires_at: Date.now() + 3600000 },
      selected: { id, vin },
      alert_settings: settings(),
      briefings: { items: [] },
      trips: { trips: [], outcomes: [] },
      alert_state: { handled: {} },
    });
    expect((await admin("/auth/disconnect", {})).status).toBe(200);
    for (const key of ["alert_settings", "briefings", "trips", "alert_state"])
      expect(await store.get(key)).toBeNull();
  });
});
