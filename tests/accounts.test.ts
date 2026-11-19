import { describe, it, expect, vi } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import app from "../src/index";
import { Store } from "../src/storage/database";
import { normalize } from "../src/tesla/normalization";
import { TeslaClient } from "../src/tesla/client";
import { runScheduled } from "../src/scheduled";
import { e, store, origin, vin, tokens, req } from "./helpers/app";

const b64 = (value: unknown) =>
  btoa(JSON.stringify(value))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
const idToken = (sub: string, aud = "client-id") =>
  `${b64({ alg: "RS256" })}.${b64({ sub, aud, iss: "https://auth.tesla.com/oauth2/v3" })}.sig`;
function teslaAs(sub: string) {
  const upstream = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.hostname === "fleet-auth.prd.vn.cloud.tesla.com")
      return Response.json({
        ...tokens(),
        refresh_token: "refresh-" + sub,
        id_token: idToken(sub),
        scope: "openid offline_access vehicle_device_data",
      });
    throw Error("unexpected upstream " + url);
  });
  vi.stubGlobal("fetch", upstream);
  return upstream;
}
const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
async function invite(label = "Friend") {
  const r = await req("/admin/invites", json({ label }));
  expect(r.status).toBe(200);
  return new URL(((await r.json()) as any).invite_url).searchParams.get(
    "invite",
  )!;
}
// Drive the browser side of Tesla sign-in and return the session cookie.
async function signIn(path: string) {
  const start = await req(path, {}, false);
  if (start.status !== 303) return { status: start.status, start };
  const state = new URL(start.headers.get("Location")!).searchParams.get(
    "state",
  );
  const browser = start.headers.get("Set-Cookie")!.split(";")[0];
  const callback = await req(
    `/auth/callback?state=${state}&code=fixture`,
    { headers: { Cookie: browser } },
    false,
  );
  const session = callback.headers
    .get("Set-Cookie")
    ?.match(/__Host-ev_session=[^;, ]+/)?.[0];
  return {
    status: callback.status,
    location: callback.headers.get("Location"),
    error:
      callback.status >= 400
        ? ((await callback.json()) as any).error.code
        : null,
    session,
  };
}
const as = (session: string, path: string, init: RequestInit = {}) =>
  req(
    path,
    {
      ...init,
      headers: { Cookie: session, Origin: origin, ...(init.headers ?? {}) },
    },
    false,
  );
const bearer = (token: string, path: string, init: RequestInit = {}) =>
  req(
    path,
    {
      ...init,
      headers: { Authorization: "Bearer " + token, ...(init.headers ?? {}) },
    },
    false,
  );
const reading = (id: string, battery: number) =>
  normalize(
    {
      charge_state: {
        battery_level: battery,
        battery_range: 200,
        charging_state: "Disconnected",
        timestamp: Date.now(),
      },
      vehicle_state: { locked: true, timestamp: Date.now() },
    },
    id,
    "Car",
    false,
  );
async function accountOf(session: string) {
  const status = (await (await as(session, "/auth/status")).json()) as any;
  expect(status.role).toBe("user");
  const row = await e.DB.prepare(
    "SELECT account FROM sessions ORDER BY expires DESC LIMIT 1",
  ).first<{ account: string }>();
  return row!.account;
}

describe("invite-only accounts", () => {
  it("creates an account from an invite through Tesla sign-in, once", async () => {
    const code = await invite();
    teslaAs("driver-1");
    const joined = await signIn("/auth/signup?invite=" + code);
    expect(joined).toMatchObject({
      status: 303,
      location: "/?oauth=connected",
    });
    const account = await accountOf(joined.session!);
    expect(account).toMatch(/^[a-f0-9]{24}$/);
    const owner = new Store(e, undefined, account);
    expect((await owner.get<any>("owner_tokens")).refresh_token).toBe(
      "refresh-driver-1",
    );
    // The ID token is used for identity only and never stored.
    expect(JSON.stringify(await owner.get("owner_tokens"))).not.toContain(
      "sig",
    );
    // The invite is spent: a different Tesla account cannot reuse it.
    teslaAs("driver-2");
    expect(await signIn("/auth/signup?invite=" + code)).toMatchObject({
      status: 403,
    });
    // The same driver signs in again without an invite.
    teslaAs("driver-1");
    const again = await signIn("/auth/signin");
    expect(again.status).toBe(303);
    expect(await accountOf(again.session!)).toBe(account);
    const invites = (await (await req("/admin/invites")).json()) as any;
    expect(invites.invites[0]).toMatchObject({ status: "used", account });
  });
  it("refuses Tesla sign-in without an account or invite and stores nothing", async () => {
    teslaAs("stranger");
    const result = await signIn("/auth/signin");
    expect(result).toMatchObject({ status: 403, error: "invite_required" });
    expect(result.session).toBeUndefined();
    const { results } = await e.DB.prepare("SELECT id FROM accounts").all();
    expect(results).toEqual([{ id: "" }]);
    expect(
      (await e.DB.prepare("SELECT COUNT(*) AS n FROM records").first<any>()).n,
    ).toBe(0);
    expect(
      (await req("/auth/signup?invite=" + "0".repeat(40), {}, false)).status,
    ).toBe(403);
  });
  it("isolates each driver's data, MCP credentials and admin access", async () => {
    teslaAs("driver-a");
    const a = await signIn("/auth/signup?invite=" + (await invite("A")));
    teslaAs("driver-b");
    const b = await signIn("/auth/signup?invite=" + (await invite("B")));
    const accountA = (
      await e.DB.prepare(
        "SELECT a.id FROM accounts a JOIN invites i ON i.account=a.id WHERE i.label='A'",
      ).first<any>()
    ).id;
    const accountB = (
      await e.DB.prepare(
        "SELECT a.id FROM accounts a JOIN invites i ON i.account=a.id WHERE i.label='B'",
      ).first<any>()
    ).id;
    const id = "c".repeat(24);
    await new Store(e, undefined, accountA).putMany({
      selected: { id, vin },
      summary: reading(id, 61),
    });
    await store.putMany({ selected: { id, vin }, summary: reading(id, 90) });
    vi.stubGlobal("fetch", vi.fn());
    const battery = async (r: Response) =>
      ((await r.json()) as any).battery?.percentage;
    expect(await battery(await as(a.session!, "/api/vehicle/battery"))).toBe(
      61,
    );
    expect(await battery(await req("/api/vehicle/battery"))).toBe(90);
    expect(
      ((await (await as(b.session!, "/api/vehicle/battery")).json()) as any)
        .error.code,
    ).toBe("select_vehicle_first");
    // A driver's MCP credential reaches only that driver's account.
    const created = (await (
      await as(a.session!, "/account/mcp-tokens", json({ label: "Poke" }))
    ).json()) as any;
    expect(created.token).toMatch(/^tbm_/);
    expect(
      await battery(await bearer(created.token, "/api/vehicle/battery")),
    ).toBe(61);
    expect((await bearer(created.token, "/account/mcp-tokens")).status).toBe(
      403,
    );
    expect(
      (await bearer(created.token, "/api/vehicle/select", json({ id }))).status,
    ).toBe(403);
    const remote = new Client({ name: "driver-a", version: "1.0.0" });
    await remote.connect(
      new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
        fetch: async (input, init) => app.fetch(new Request(input, init), e),
        requestInit: { headers: { Authorization: "Bearer " + created.token } },
      }),
    );
    const snapshot = await remote.callTool({
      name: "tesla_get_snapshot",
      arguments: { sections: ["battery"] },
    });
    expect((snapshot.structuredContent as any).battery.percentage).toBe(61);
    await remote.close();
    // Drivers cannot use operator routes.
    for (const path of [
      "/admin/invites",
      "/admin/accounts",
      "/admin/partner/register",
    ])
      expect(
        ((await (await as(a.session!, path, json({}))).json()) as any).error
          .code,
      ).toMatch(/operator_required|invalid_invite/);
    expect((await as(a.session!, "/admin/accounts")).status).toBe(403);
    // Revoking the credential ends access.
    const listed = (await (
      await as(a.session!, "/account/mcp-tokens")
    ).json()) as any;
    await as(
      a.session!,
      "/account/mcp-tokens/revoke",
      json({ id: listed.tokens[0].id }),
    );
    expect((await bearer(created.token, "/api/vehicle/battery")).status).toBe(
      401,
    );
    // Disabling an account ends its sessions; deleting it removes only its data.
    await store.put("partner_status", { verified: true });
    await req(
      "/admin/accounts/disable",
      json({ id: accountB, disabled: true }),
    );
    expect((await as(b.session!, "/auth/status")).status).toBe(401);
    expect(
      (await req("/admin/accounts/delete", json({ id: accountA }))).status,
    ).toBe(200);
    expect((await as(a.session!, "/auth/status")).status).toBe(401);
    expect(await new Store(e, undefined, accountA).get("summary")).toBeNull();
    expect(await store.get("summary")).not.toBeNull();
    expect(await store.get("partner_status")).toEqual({ verified: true });
    const accounts = (await (await req("/admin/accounts")).json()) as any;
    expect(accounts.accounts.map((x: any) => [x.id, x.disabled])).toEqual([
      ["", false],
      [accountB, true],
    ]);
    expect((await req("/admin/accounts/delete", json({ id: "" }))).status).toBe(
      400,
    );
  });
  it("binds each record to its account so ciphertext cannot be moved between accounts", async () => {
    const a = new Store(e, undefined, "a".repeat(24)),
      b = new Store(e, undefined, "b".repeat(24));
    await a.put("owner_tokens", tokens());
    const row = await e.DB.prepare("SELECT value FROM records WHERE key=?")
      .bind(a.key("owner_tokens"))
      .first<{ value: string }>();
    await e.DB.prepare("INSERT INTO records(key,value) VALUES(?,?)")
      .bind(b.key("owner_tokens"), row!.value)
      .run();
    await expect(b.get("owner_tokens")).rejects.toThrow();
  });
  it("gives each account its own daily request budget", async () => {
    const limit = e.MAX_REQUESTS_PER_DAY;
    e.MAX_REQUESTS_PER_DAY = "1";
    try {
      const a = new Store(e, undefined, "a".repeat(24)),
        b = new Store(e, undefined, "b".repeat(24));
      for (const s of [a, b]) await s.put("owner_tokens", tokens());
      const ok = vi.fn(async () => Response.json({ response: [] }));
      await new TeslaClient(a, ok).vehicles();
      await expect(new TeslaClient(a, ok).vehicles()).rejects.toMatchObject({
        code: "local_usage_limit",
      });
      await expect(new TeslaClient(b, ok).vehicles()).resolves.toEqual([]);
    } finally {
      e.MAX_REQUESTS_PER_DAY = limit;
    }
  });
  it("runs alerts per account so one failing destination does not affect another", async () => {
    const settings = (url: string) => ({
      enabled: true,
      time_zone: "UTC",
      notify: { format: "json", url },
      plug_in: { enabled: true, local_hour: 0, below_percentage: 50 },
      briefings: {
        enabled: false,
        lead_minutes: 45,
        reserve_percentage: 20,
        only_when_tight: true,
      },
    });
    const ids = ["a".repeat(24), "b".repeat(24)];
    for (const [i, account] of ids.entries()) {
      await e.DB.prepare("INSERT INTO accounts(id,label,created) VALUES(?,?,?)")
        .bind(account, "x", Date.now())
        .run();
      const s = new Store(e, undefined, account);
      await s.putMany({
        selected: { id: "c".repeat(24), vin },
        summary: reading("c".repeat(24), 20),
        alert_settings: settings(`https://hooks.example.com/${i}`),
      });
    }
    vi.stubGlobal("fetch", vi.fn());
    const send = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith("/0")
        ? new Response("down", { status: 500 })
        : new Response("ok"),
    );
    const results = await runScheduled(e, undefined, Date.now(), send);
    expect(results.map((r) => [r.account, r.sent])).toEqual([
      [ids[0], []],
      [ids[1], ["plug_in_reminder"]],
    ]);
  });
});
