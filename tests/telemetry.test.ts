import { describe, it, expect, vi, afterEach } from "vitest";
import { applyTelemetry } from "../src/telemetry/mapping";
import { normalize } from "../src/tesla/normalization";
import { hash } from "../src/security/crypto";
import { e, store, vin, tokens, req } from "./helpers/app";

const id = "a".repeat(24);
const at = (offset = 0) => new Date(Date.now() + offset).toISOString();
const ingestToken = "t".repeat(48);
const relayToken = "r".repeat(48);
const json = (body: unknown, token?: string) => ({
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(token ? { Authorization: "Bearer " + token } : {}),
  },
  body: JSON.stringify(body),
});
function configure(
  relay = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ response: { updated_vehicles: 1, skipped_vehicles: {} } }),
  ),
) {
  Object.assign(e, {
    TELEMETRY_INGEST_TOKEN: ingestToken,
    TELEMETRY_RELAY_TOKEN: relayToken,
    TELEMETRY_HOSTNAME: "telemetry.example.com",
    TELEMETRY_PORT: "443",
    TELEMETRY_CA:
      "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----",
    TELEMETRY: { fetch: relay } as unknown as Fetcher,
  });
  return relay;
}
afterEach(() => {
  for (const key of [
    "TELEMETRY_INGEST_TOKEN",
    "TELEMETRY_RELAY_TOKEN",
    "TELEMETRY_HOSTNAME",
    "TELEMETRY_PORT",
    "TELEMETRY_CA",
    "TELEMETRY",
  ])
    delete (e as any)[key];
});

describe("telemetry mapping", () => {
  it("maps typed and legacy string values into the observation", () => {
    const old = normalize(
      {
        charge_state: {
          battery_level: 80,
          battery_range: 250,
          timestamp: Date.now() - 3600000,
        },
        climate_state: { inside_temp: 15, timestamp: Date.now() - 3600000 },
        vehicle_state: { locked: true, timestamp: Date.now() - 3600000 },
      },
      id,
      "Car",
      false,
    );
    const result = applyTelemetry(
      old,
      {
        vin,
        createdAt: at(),
        data: [
          { key: "BatteryLevel", value: { doubleValue: 71.6 } },
          { key: "RatedRange", value: { stringValue: "200" } },
          {
            key: "DetailedChargeState",
            value: { detailedChargeStateValue: "DetailedChargeStateCharging" },
          },
          { key: "ACChargingPower", value: { doubleValue: 7.4 } },
          { key: "Locked", value: { booleanValue: false } },
          {
            key: "DoorState",
            value: { doorValue: { DriverFront: true, TrunkRear: true } },
          },
          {
            key: "FdWindow",
            value: { windowStateValue: "WindowStatePartiallyOpen" },
          },
          { key: "RpWindow", value: { stringValue: "Closed" } },
          { key: "TpmsPressureFl", value: { doubleValue: 2.9 } },
          {
            key: "TpmsSoftWarnings",
            value: { tireLocationValue: { frontLeft: true } },
          },
          {
            key: "SentryMode",
            value: { sentryModeStateValue: "SentryModeStateArmed" },
          },
          { key: "InsideTemp", value: { invalid: true } },
          {
            key: "Location",
            value: { locationValue: { latitude: 1, longitude: 2 } },
          },
        ],
      },
      id,
      false,
    );
    expect(result.battery).toMatchObject({
      percentage: 72,
      range_km: 321.8688,
    });
    expect(result.charging).toMatchObject({
      state: "Charging",
      charging: true,
      connected: true,
      power_kw: 7.4,
    });
    expect(result.vehicle).toMatchObject({ locked: false, sentry_mode: true });
    expect(result.closures.doors.driver_front).toBe(true);
    expect(result.closures.rear_trunk_open).toBe(true);
    expect(result.closures.windows).toMatchObject({
      driver_front: true,
      passenger_rear: false,
    });
    expect(result.tires.front_left).toMatchObject({
      pressure_bar: 2.9,
      pressure_psi: 42.1,
      soft_warning: true,
    });
    // Location is ignored unless enabled; an invalid value is never stored.
    expect(result).not.toHaveProperty("location");
    expect(result.climate.interior_c).toBe(15);
    // The untouched climate section is still an hour old, so the whole snapshot
    // is stale and a normal read can refresh it.
    expect(result.data.sections.battery.is_stale).toBe(false);
    expect(result.data.sections.climate.is_stale).toBe(true);
    expect(result.data).toMatchObject({
      is_stale: true,
      source: "tesla_fleet_telemetry",
    });
    expect(old.battery.percentage).toBe(80);
  });
});

describe("telemetry routes", () => {
  it("configures the selected car through the telemetry Worker", async () => {
    await store.putMany({ selected: { id, vin }, owner_tokens: tokens() });
    vi.stubGlobal("fetch", vi.fn());
    expect(
      (await req("/api/telemetry/enable", { method: "POST" })).status,
    ).toBe(503);
    const relay = configure();
    const enabled = await req("/api/telemetry/enable", { method: "POST" });
    expect(enabled.status).toBe(200);
    const [url, init] = relay.mock.calls[0];
    expect(String(url)).toBe("https://telemetry.internal/configure");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer " + relayToken,
      "X-Tesla-Authorization": "Bearer tesla-access-secret",
    });
    const body = JSON.parse(String(init?.body));
    expect(body.vins).toEqual([vin]);
    expect(body.config).toMatchObject({
      hostname: "telemetry.example.com",
      port: 443,
      prefer_typed: true,
      alert_types: ["service"],
    });
    expect(body.config.fields.BatteryLevel).toEqual({ interval_seconds: 60 });
    expect(body.config.fields).not.toHaveProperty("Location");
    expect(
      await e.DB.prepare(
        "SELECT account, vehicle_id FROM telemetry_vehicles",
      ).first(),
    ).toEqual({ account: "", vehicle_id: id });
    const status = (await (await req("/api/telemetry")).json()) as any;
    expect(status).toMatchObject({
      available: true,
      enabled: true,
      pairing_url: "https://tesla.com/_ak/tesla.example.com",
    });
  });
  it("explains an unpaired virtual key", async () => {
    await store.putMany({ selected: { id, vin }, owner_tokens: tokens() });
    vi.stubGlobal("fetch", vi.fn());
    configure(
      vi.fn(async () =>
        Response.json({
          response: {
            updated_vehicles: 0,
            skipped_vehicles: { missing_key: [vin] },
          },
        }),
      ),
    );
    const r = await req("/api/telemetry/enable", { method: "POST" });
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error.code).toBe(
      "telemetry_key_not_paired",
    );
    expect(
      await e.DB.prepare("SELECT * FROM telemetry_vehicles").first(),
    ).toBeNull();
  });
  it("ingests relay records into the cache so reads need no Fleet API call", async () => {
    configure();
    await store.putMany({
      selected: { id, vin },
      telemetry_state: {
        enabled_at: at(),
        expires_at: at(86400000),
        connected: null,
        last_record_at: null,
        rotated_at: null,
      },
    });
    await e.DB.prepare(
      "INSERT INTO telemetry_vehicles(vin_hash,account,vehicle_id,created) VALUES(?,?,?,?)",
    )
      .bind(await hash("vin:" + vin), "", id, Date.now())
      .run();
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const fields = [
      ["BatteryLevel", { doubleValue: 64 }],
      ["RatedRange", { doubleValue: 180 }],
      [
        "DetailedChargeState",
        { detailedChargeStateValue: "DetailedChargeStateDisconnected" },
      ],
      ["InsideTemp", { doubleValue: 19 }],
      ["Locked", { booleanValue: true }],
    ].map(([key, value]) => ({ key, value }));
    const batch = {
      records: [
        { topic: "tesla_V", payload: { vin, createdAt: at(), data: fields } },
        { topic: "tesla_connectivity", payload: { vin, status: "CONNECTED" } },
        {
          topic: "tesla_V",
          payload: { vin: "5YJ3E1EA7KF000002", createdAt: at(), data: fields },
        },
      ],
    };
    for (const token of [e.MCP_TOKEN!, e.ADMIN_TOKEN!])
      expect(
        (await req("/telemetry/ingest", json(batch, token), false)).status,
      ).toBe(403);
    const ingested = await req(
      "/telemetry/ingest",
      json(batch, ingestToken),
      false,
    );
    expect(await ingested.json()).toEqual({
      received: 3,
      applied: 1,
      unknown_vehicles: 1,
      failed_accounts: 0,
    });
    const battery = (await (await req("/api/vehicle/battery")).json()) as any;
    expect(battery).toMatchObject({
      battery: { percentage: 64 },
      data: { cache_hit: true, source: "tesla_fleet_telemetry" },
    });
    expect((await store.get<any>("telemetry_state")).connected).toBe(true);
    expect(upstream).not.toHaveBeenCalled();
    // The ingest credential cannot read vehicle data.
    expect(
      (
        await req(
          "/api/vehicle/battery",
          { headers: { Authorization: "Bearer " + ingestToken } },
          false,
        )
      ).status,
    ).toBe(403);
  });
  it("removes the configuration from the car on disable", async () => {
    configure();
    await store.putMany({
      selected: { id, vin },
      owner_tokens: tokens(),
      telemetry_state: {},
    });
    await e.DB.prepare(
      "INSERT INTO telemetry_vehicles(vin_hash,account,vehicle_id,created) VALUES(?,?,?,?)",
    )
      .bind(await hash("vin:" + vin), "", id, Date.now())
      .run();
    const upstream = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ response: { updated_vehicles: 1 } }),
    );
    vi.stubGlobal("fetch", upstream);
    expect(
      (await req("/api/telemetry/disable", { method: "POST" })).status,
    ).toBe(200);
    expect(String(upstream.mock.calls[0][0])).toBe(
      `https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/vehicles/${vin}/fleet_telemetry_config`,
    );
    expect(upstream.mock.calls[0][1]?.method).toBe("DELETE");
    expect(
      await e.DB.prepare("SELECT * FROM telemetry_vehicles").first(),
    ).toBeNull();
    expect(await store.get("telemetry_state")).toBeNull();
  });
});
