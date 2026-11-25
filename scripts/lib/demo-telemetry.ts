import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { hash } from "../../src/security/crypto";
import type { Observation } from "../../src/context/observations";
import { createHarness, SYNTHETIC_VEHICLE_ID, SYNTHETIC_VIN } from "./harness";

interface IngestCounts {
  applied: number;
  ignored: number;
  failed_accounts: number;
}

export async function runTelemetryRetry() {
  const token = randomBytes(32).toString("hex");
  const h = await createHarness({ TELEMETRY_INGEST_TOKEN: token });
  try {
    const driver = h.store.forAccount("demo-driver");
    const now = Date.now();
    const observed = new Date(now).toISOString();
    const cars = [
      {
        store: h.store,
        vin: SYNTHETIC_VIN,
        id: SYNTHETIC_VEHICLE_ID,
        battery: 64,
      },
      {
        store: driver,
        vin: "5YJ3E1EA7KF000002",
        id: "b".repeat(24),
        battery: 63,
      },
    ];
    await h.e.DB.prepare(
      "INSERT INTO accounts(id, label, created) VALUES(?,?,?)",
    )
      .bind(driver.account, "Synthetic driver", now)
      .run();
    for (const car of cars)
      await car.store.putMany(
        {
          selected: { id: car.id, vin: car.vin },
          telemetry_state: {
            enabled_at: observed,
            expires_at: new Date(now + 86400000).toISOString(),
            connected: null,
            last_record_at: null,
            rotated_at: null,
          },
        },
        [
          h.e.DB.prepare(
            "INSERT INTO telemetry_vehicles(vin_hash, account, vehicle_id, created) VALUES(?,?,?,?)",
          ).bind(await hash("vin:" + car.vin), car.store.account, car.id, now),
        ],
      );

    const request = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({
        records: cars.map(({ vin, battery }) => ({
          topic: "tesla_V",
          payload: {
            vin,
            createdAt: observed,
            data: [{ key: "BatteryLevel", value: { doubleValue: battery } }],
          },
        })),
      }),
    };
    const send = async () => {
      const response = await h.request("/telemetry/ingest", request, token);
      return {
        status: response.status,
        counts: (await response.json()) as IngestCounts,
      };
    };
    const snapshot = () =>
      h.store.getMany([
        "summary",
        "telemetry_state",
        "previous_summary",
        "observation_history",
      ]);
    const driverBattery = async () =>
      (await driver.get<Observation>("summary"))?.battery.percentage ?? null;

    await h.e.DB.prepare(
      "CREATE TRIGGER demo_write_failure BEFORE INSERT ON records WHEN NEW.key = 'acct:demo-driver:summary' BEGIN SELECT RAISE(ABORT, 'injected demo write failure'); END",
    ).run();
    const first = await send();
    const healthy = await snapshot();
    const batteryAfterFailure = await driverBattery();
    await h.e.DB.prepare("DROP TRIGGER demo_write_failure").run();

    const retry = await send();
    return {
      first: { ...first, driverBattery: batteryAfterFailure },
      retry: { ...retry, driverBattery: await driverBattery() },
      healthyBattery:
        (healthy.summary as Observation | null)?.battery.percentage ?? null,
      healthyUnchanged: isDeepStrictEqual(healthy, await snapshot()),
      teslaRequests: h.tesla.count(),
    };
  } finally {
    await h.close();
  }
}
