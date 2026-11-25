import { describe, it, expect, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { syntheticTesla } from "../scripts/lib/harness";
import { applyTelemetry, emptyClock } from "../src/telemetry/mapping";
import { normalize } from "../src/tesla/normalization";
import { hash } from "../src/security/crypto";
import { Store } from "../src/storage/database";
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

describe("telemetry ordering", () => {
  const read = (minutesAgo: number) =>
    normalize(
      {
        charge_state: {
          battery_level: 50,
          battery_range: 150,
          timestamp: Date.now() - minutesAgo * 60000,
        },
        climate_state: { timestamp: Date.now() - minutesAgo * 60000 },
        vehicle_state: {
          locked: true,
          timestamp: Date.now() - minutesAgo * 60000,
        },
      },
      id,
      "Car",
      false,
    );
  const record = (
    secondsAgo: number,
    data: Record<string, Record<string, unknown>>,
  ) => ({
    vin,
    createdAt: at(-secondsAgo * 1000),
    data: Object.entries(data).map(([key, value]) => ({ key, value })),
  });
  it("never lets a record older than the Fleet API read underneath overwrite it", () => {
    const clock = emptyClock();
    const base = read(2);
    const late = applyTelemetry(
      base,
      record(180, { BatteryLevel: { doubleValue: 70 } }),
      id,
      false,
      Date.now(),
      clock,
    );
    expect(late).toBe(base);
    const newer = applyTelemetry(
      base,
      record(60, { BatteryLevel: { doubleValue: 49 } }),
      id,
      false,
      Date.now(),
      clock,
    );
    expect(newer.battery.percentage).toBe(49);
    expect(newer.data.sections.battery.observed_at).toBe(
      clock.signals.BatteryLevel,
    );
  });
  it("orders each signal on its own and never moves a section back in time", () => {
    const clock = emptyClock();
    const first = applyTelemetry(
      read(10),
      record(30, { BatteryLevel: { doubleValue: 40 } }),
      id,
      false,
      Date.now(),
      clock,
    );
    // Older than the battery level, but the first range reading since the read.
    const range = record(90, {
      BatteryLevel: { doubleValue: 45 },
      RatedRange: { doubleValue: 120 },
    });
    const second = applyTelemetry(first, range, id, false, Date.now(), clock);
    expect(second.battery.percentage).toBe(40);
    expect(second.battery.range_km).toBeCloseTo(120 * 1.609344);
    expect(second.data.sections.battery.observed_at).toBe(
      first.data.sections.battery.observed_at,
    );
    // The same record again changes nothing.
    expect(applyTelemetry(second, range, id, false, Date.now(), clock)).toBe(
      second,
    );
  });
});

describe("telemetry ordering of shared and undated values", () => {
  const payload = (
    createdAt: string | undefined,
    data: Record<string, Record<string, unknown>>,
  ) => ({
    vin,
    ...(createdAt ? { createdAt } : {}),
    data: Object.entries(data).map(([key, value]) => ({ key, value })),
  });
  const apply = (
    current: ReturnType<typeof applyTelemetry> | null,
    record: ReturnType<typeof payload>,
    clock: ReturnType<typeof emptyClock>,
  ) => applyTelemetry(current, record, id, false, Date.now(), clock);
  it("orders rated and estimated range as one stored value", () => {
    const clock = emptyClock();
    const rated = apply(
      null,
      payload(at(-30000), { RatedRange: { doubleValue: 200 } }),
      clock,
    );
    expect(rated.battery.range_km).toBeCloseTo(321.9, 1);
    const older = apply(
      rated,
      payload(at(-90000), { EstBatteryRange: { doubleValue: 60 } }),
      clock,
    );
    expect(older).toBe(rated);
    expect(older.battery.range_km).toBeCloseTo(321.9, 1);
    expect(older.data.sections.battery.observed_at).toBe(
      rated.data.sections.battery.observed_at,
    );
    // Estimated range still works on its own, and when it is newer.
    expect(
      apply(
        null,
        payload(at(), { EstBatteryRange: { doubleValue: 60 } }),
        emptyClock(),
      ).battery.range_km,
    ).toBeCloseTo(96.6, 1);
    expect(
      apply(
        rated,
        payload(at(-10000), { EstBatteryRange: { doubleValue: 150 } }),
        clock,
      ).battery.range_km,
    ).toBeCloseTo(241.4, 1);
  });
  it("applies AC and DC charging power from the same record", () => {
    const result = apply(
      null,
      payload(at(), {
        ACChargingPower: { doubleValue: 0 },
        DCChargingPower: { doubleValue: 150 },
      }),
      emptyClock(),
    );
    expect(result.charging.power_kw).toBe(150);
    expect(
      apply(
        null,
        payload(at(), {
          DCChargingPower: { doubleValue: 150 },
          ACChargingPower: { doubleValue: 0 },
        }),
        emptyClock(),
      ).charging.power_kw,
    ).toBe(150);
  });
  it.each(["forward", "reverse"])(
    "keeps AC power when an idle DC record arrives in %s order",
    (order) => {
      const clock = emptyClock();
      const ac = payload(at(-30000), { ACChargingPower: { doubleValue: 7.4 } });
      const idleDc = payload(at(-20000), {
        DCChargingPower: { doubleValue: 0 },
      });
      const [first, second] = order === "forward" ? [ac, idleDc] : [idleDc, ac];
      const result = apply(apply(null, first, clock), second, clock);
      expect(result.charging.power_kw).toBe(7.4);
      const activeDc = apply(
        result,
        payload(at(-10000), { DCChargingPower: { doubleValue: 100 } }),
        clock,
      );
      expect(activeDc.charging.power_kw).toBe(100);
      expect(
        apply(
          activeDc,
          payload(at(), { DCChargingPower: { doubleValue: 0 } }),
          clock,
        ).charging.power_kw,
      ).toBe(7.4);
    },
  );
  it("uses undated charging power only until there is a dated reading", () => {
    const undated = payload(undefined, {
      DCChargingPower: { doubleValue: 150 },
    });
    const dated = payload(at(-5000), { ACChargingPower: { doubleValue: 7.4 } });

    const undatedFirst = emptyClock();
    const provisional = apply(null, undated, undatedFirst);
    expect(provisional.charging.power_kw).toBe(150);
    expect(provisional.data.sections.charging.observed_at).toBeNull();
    expect(apply(provisional, dated, undatedFirst).charging.power_kw).toBe(7.4);

    const datedFirst = emptyClock();
    const known = apply(null, dated, datedFirst);
    expect(apply(known, undated, datedFirst)).toBe(known);
    expect(known.charging.power_kw).toBe(7.4);
  });
  it("never lets a retried undated record replace a timestamped reading", () => {
    const clock = emptyClock();
    const undated = payload(undefined, { BatteryLevel: { doubleValue: 30 } });
    const first = apply(null, undated, clock);
    expect(first.battery.percentage).toBe(30);
    // No source time: the value is kept but does not count as fresh.
    expect(first.data.sections.battery.observed_at).toBeNull();
    const createdAt = at(-5000);
    const dated = apply(
      first,
      payload(createdAt, { BatteryLevel: { doubleValue: 70 } }),
      clock,
    );
    expect(dated.battery.percentage).toBe(70);
    const observed = dated.data.sections.battery.observed_at;
    expect(observed).toBe(createdAt);
    const retried = apply(dated, undated, clock);
    expect(retried).toBe(dated);
    expect(retried.battery.percentage).toBe(70);
    expect(retried.data.sections.battery.observed_at).toBe(observed);
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
      ignored: 0,
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
  it.each(["replay first", "disconnect first"])(
    "keeps a fresh Fleet API reading online after a buffered disconnect (%s)",
    async (order) => {
      configure();
      await store.putMany({
        selected: { id, vin },
        owner_tokens: tokens(),
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
      const replayed = {
        topic: "tesla_V",
        payload: {
          vin,
          createdAt: at(-360000),
          data: [{ key: "BatteryLevel", value: { doubleValue: 60 } }],
        },
      };
      const disconnect = (createdAt: string) => ({
        topic: "tesla_connectivity",
        payload: { vin, createdAt, status: "DISCONNECTED" },
      });
      const deliver = async (record: unknown) => {
        const request = json({ records: [record] }, ingestToken);
        const response = await req(
          "/telemetry/ingest",
          {
            ...request,
            headers: { ...request.headers, "Idempotency-Key": randomUUID() },
          },
          false,
        );
        expect(response.status).toBe(200);
        return response.json();
      };
      expect(await deliver(replayed)).toMatchObject({ applied: 1 });

      const tesla = syntheticTesla();
      const refreshedAt = Date.now() - 10000;
      tesla.car.observed_at = () => refreshedAt;
      vi.stubGlobal("fetch", tesla.fetch);
      const refresh = await req("/api/vehicle/summary");
      expect(refresh.status).toBe(200);
      expect(await refresh.json()).toMatchObject({
        battery: { percentage: 71 },
        data: { source: "tesla_fleet_api" },
      });
      expect(tesla.count("vehicle_data")).toBe(1);

      const buffered = disconnect(at(-400000));
      if (order === "disconnect first") await deliver(buffered);
      expect(await deliver(replayed)).toMatchObject({ applied: 0, ignored: 1 });
      if (order === "replay first") await deliver(buffered);
      expect(await store.get("summary")).toMatchObject({
        battery: { percentage: 71 },
        vehicle: { online: true },
        data: { observed_at: new Date(refreshedAt).toISOString() },
      });
      await deliver(disconnect(at()));
      expect(await store.get("summary")).toMatchObject({
        vehicle: { online: false },
      });
    },
  );
  it("acknowledges only committed writes and skips healthy accounts on retry", async () => {
    configure();
    const driver = store.forAccount("driver");
    const driverVin = "5YJ3E1EA7KF000002";
    const driverId = "b".repeat(24);
    await e.DB.prepare("INSERT INTO accounts(id, label, created) VALUES(?,?,?)")
      .bind(driver.account, "driver", Date.now())
      .run();
    const telemetryState = {
      enabled_at: at(),
      expires_at: at(86400000),
      connected: null,
      last_record_at: null,
      rotated_at: null,
    };
    for (const [account, carVin, carId] of [
      [store, vin, id],
      [driver, driverVin, driverId],
    ] as const) {
      await account.putMany({
        selected: { id: carId, vin: carVin },
        telemetry_state: telemetryState,
        preferences: { history_enabled: true },
      });
      await e.DB.prepare(
        "INSERT INTO telemetry_vehicles(vin_hash,account,vehicle_id,created) VALUES(?,?,?,?)",
      )
        .bind(await hash("vin:" + carVin), account.account, carId, Date.now())
        .run();
    }
    const observed = at();
    const batch = {
      records: [vin, driverVin].map((carVin, index) => ({
        topic: "tesla_V",
        payload: {
          vin: carVin,
          createdAt: observed,
          data: [{ key: "BatteryLevel", value: { doubleValue: 64 - index } }],
        },
      })),
    };
    const request = json(batch, ingestToken);
    const send = (batchId: string) =>
      req(
        "/telemetry/ingest",
        {
          ...request,
          headers: { ...request.headers, "Idempotency-Key": batchId },
        },
        false,
      );
    const batchId = "3baef76f-2ae1-493f-a27a-7f790636dc7d";
    const putMany = Store.prototype.putMany;
    const writes = vi
      .spyOn(Store.prototype, "putMany")
      .mockImplementation(function (this: Store, ...args) {
        if (this.account === driver.account)
          return Promise.reject(Error("injected storage failure"));
        return putMany.apply(this, args);
      });
    try {
      const first = await send(batchId);
      expect(first.status).toBe(503);
      expect(await first.json()).toEqual({
        received: 2,
        applied: 1,
        ignored: 0,
        unknown_vehicles: 0,
        failed_accounts: 1,
      });
      expect(await store.get("summary")).toMatchObject({
        battery: { percentage: 64 },
      });
      expect(await driver.get("summary")).toBeNull();
    } finally {
      writes.mockRestore();
    }
    const keys = [
      "summary",
      "telemetry_state",
      "previous_summary",
      "observation_history",
    ] as const;
    const firstState = await store.getMany(keys);
    const later = Date.now() + 31 * 60000;
    const now = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      const retry = await send(batchId);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({
        applied: 1,
        ignored: 1,
        failed_accounts: 0,
      });
      expect(await driver.get("summary")).toMatchObject({
        battery: { percentage: 63 },
      });
      expect(await store.getMany(keys)).toEqual(firstState);

      const duplicate = await send("c39a8f1a-6b17-4dd3-bb9b-c41e789763ce");
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toMatchObject({ applied: 0, ignored: 2 });
      expect(await store.getMany(keys)).toEqual({
        ...firstState,
        telemetry_state: {
          ...firstState.telemetry_state,
          last_batch_id: "c39a8f1a-6b17-4dd3-bb9b-c41e789763ce",
        },
      });
    } finally {
      now.mockRestore();
    }
  });
  it("rejects malformed signal batches instead of retrying them", async () => {
    configure();
    const response = await req(
      "/telemetry/ingest",
      json(
        { records: [{ topic: "tesla_V", payload: { vin, data: [null] } }] },
        ingestToken,
      ),
      false,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_telemetry_batch" },
    });
  });
  it("removes the configuration from the car on disable without a mapping", async () => {
    // An enable that lost its lease after Tesla accepted the configuration
    // leaves the car configured with no telemetry_vehicles row.
    configure();
    await store.putMany({ selected: { id, vin }, owner_tokens: tokens() });
    const upstream = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ response: { updated_vehicles: 1 } }),
    );
    vi.stubGlobal("fetch", upstream);
    const response = await req("/api/telemetry/disable", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ removed: false });
    expect(String(upstream.mock.calls[0][0])).toBe(
      `https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/vehicles/${vin}/fleet_telemetry_config`,
    );
    expect(upstream.mock.calls[0][1]?.method).toBe("DELETE");
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
