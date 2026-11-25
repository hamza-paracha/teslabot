import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hash } from "../../src/security/crypto";
import { runScheduled } from "../../src/scheduled";
import { createHarness } from "./harness";

// Replays a synthetic drive through the relay-to-Worker ingest path
// (/telemetry/ingest), the per-account vehicle cache and the cron alert runner,
// then checks the result against the fixture's expectations.

export const FIXTURE = new URL(
  "../../tests/fixtures/telemetry-drive.json",
  import.meta.url,
);

type Value = number | boolean | string | Record<string, unknown>;
interface FixtureRecord {
  car: string;
  topic: "V" | "connectivity";
  // Seconds relative to the replay start; null omits createdAt.
  at: number | null;
  status?: "CONNECTED" | "DISCONNECTED";
  data?: Record<string, Value>;
}
interface FixtureStep {
  id?: string;
  name: string;
  batch?: FixtureRecord[];
  repeat?: string;
  lost?: FixtureRecord[];
  cron?: boolean;
  expect?: Record<string, unknown>;
}
export interface Fixture {
  description: string;
  accounts: Record<
    string,
    { account: string; vin: string; vehicle_id: string; notify_url: string }
  >;
  steps: FixtureStep[];
  expect: Record<string, unknown>;
}
export interface StepResult {
  name: string;
  kind: "batch" | "repeat" | "lost" | "cron";
  records: number;
  ingest?: Record<string, number>;
  failures: string[];
  snapshot: Record<string, unknown>;
}

export const loadFixture = (): Fixture =>
  JSON.parse(readFileSync(FIXTURE, "utf8"));

// fleet-telemetry's typed JSON for one datum.
const typed = (value: Value) =>
  typeof value === "number"
    ? { doubleValue: value }
    : typeof value === "boolean"
      ? { booleanValue: value }
      : typeof value === "string"
        ? { stringValue: value }
        : value;

const get = (value: unknown, path: string[]) =>
  path.reduce<unknown>(
    (node, key) =>
      node && typeof node === "object"
        ? (node as Record<string, unknown>)[key]
        : undefined,
    value,
  );

export async function replay(
  fixture: Fixture = loadFixture(),
  onStep: (step: StepResult) => void = () => {},
) {
  const ingestToken = randomBytes(32).toString("hex");
  const h = await createHarness({ TELEMETRY_INGEST_TOKEN: ingestToken });
  const t0 = Date.now();
  const iso = (offset: number) => new Date(t0 + offset * 1000).toISOString();
  const sent: Array<{ url: string; body: string }> = [];
  const notifier: typeof fetch = async (input, init) => {
    sent.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response("ok");
  };
  const cars = fixture.accounts;
  const storeFor = (car: string) => h.store.forAccount(cars[car].account);
  try {
    h.tesla.car.state = "asleep";
    for (const car of Object.values(cars)) {
      if (car.account)
        await h.e.DB.prepare(
          "INSERT INTO accounts(id,label,created) VALUES(?,?,?)",
        )
          .bind(car.account, "replay", t0)
          .run();
      await h.store.forAccount(car.account).putMany(
        {
          selected: { id: car.vehicle_id, vin: car.vin },
          telemetry_state: {
            enabled_at: iso(-3600),
            expires_at: iso(86400 * 90),
            connected: null,
            last_record_at: null,
            rotated_at: null,
          },
          alert_settings: {
            enabled: true,
            time_zone: "UTC",
            notify: { format: "ntfy", url: car.notify_url },
            plug_in: { enabled: true, local_hour: 0, below_percentage: 50 },
            briefings: {
              enabled: false,
              lead_minutes: 45,
              reserve_percentage: 20,
              only_when_tight: true,
            },
          },
        },
        [
          h.e.DB.prepare(
            "INSERT INTO telemetry_vehicles(vin_hash,account,vehicle_id,created) VALUES(?,?,?,?)",
          ).bind(await hash("vin:" + car.vin), car.account, car.vehicle_id, t0),
        ],
      );
    }
    const relayRecord = (record: FixtureRecord) => {
      const vin = cars[record.car].vin;
      return record.topic === "connectivity"
        ? {
            topic: "tesla_connectivity",
            payload: {
              vin,
              connectionId: "replay",
              status: record.status,
              ...(record.at === null ? {} : { createdAt: iso(record.at) }),
              networkInterface: "wifi",
            },
          }
        : {
            topic: "tesla_V",
            payload: {
              vin,
              ...(record.at === null ? {} : { createdAt: iso(record.at) }),
              data: Object.entries(record.data ?? {}).map(([key, value]) => ({
                key,
                value: typed(value),
              })),
            },
          };
    };
    const ingest = async (records: FixtureRecord[]) => {
      const response = await h.request(
        "/telemetry/ingest",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ records: records.map(relayRecord) }),
        },
        ingestToken,
      );
      if (!response.ok)
        throw Error(
          `ingest returned ${response.status}: ${await response.text()}`,
        );
      return (await response.json()) as Record<string, number>;
    };
    const snapshot = async () => {
      const state: Record<string, unknown> = {
        tesla_requests: h.tesla.count(),
        reminders: Object.fromEntries(
          Object.entries(cars).map(([car, { notify_url }]) => [
            car,
            sent.filter((item) => item.url === notify_url).length,
          ]),
        ),
        telemetry: {} as Record<string, unknown>,
        messages: sent.map((item) => item.body),
      };
      for (const car of Object.keys(cars)) {
        const stored = await storeFor(car).getMany([
          "summary",
          "telemetry_state",
        ]);
        state[car] = stored.summary;
        (state.telemetry as Record<string, unknown>)[car] =
          stored.telemetry_state;
      }
      return state;
    };
    const check = (
      expected: Record<string, unknown> = {},
      state: Record<string, unknown>,
      ingested?: Record<string, number>,
    ) =>
      Object.entries(expected).flatMap(([path, want]) => {
        const actual =
          ingested && (path === "applied" || path === "ignored")
            ? ingested[path]
            : get(state, path.split("."));
        const target =
          want && typeof want === "object" && "at" in want
            ? iso((want as { at: number }).at)
            : want;
        const ok =
          typeof target === "number" && typeof actual === "number"
            ? Math.abs(actual - target) < 0.05
            : actual === target;
        return ok
          ? []
          : [
              `${path}: expected ${JSON.stringify(target)}, got ${JSON.stringify(actual)}`,
            ];
      });
    const byId = new Map(
      fixture.steps.filter((s) => s.id).map((s) => [s.id!, s]),
    );
    const steps: StepResult[] = [];
    for (const step of fixture.steps) {
      let kind: StepResult["kind"], records: FixtureRecord[], ingested;
      if (step.cron) {
        kind = "cron";
        records = [];
        await runScheduled(h.e, undefined, Date.now(), notifier);
      } else if (step.lost) {
        // Never delivered: the relay's queue lives in memory and
        // fleet-telemetry runs with reliable_ack off, so nothing re-sends them.
        kind = "lost";
        records = step.lost;
      } else {
        kind = step.repeat ? "repeat" : "batch";
        records = step.repeat
          ? (byId.get(step.repeat)?.batch ?? [])
          : (step.batch ?? []);
        if (!records.length) throw Error(`Step "${step.name}" has no records`);
        ingested = await ingest(records);
      }
      const state = await snapshot();
      const result: StepResult = {
        name: step.name,
        kind,
        records: records.length,
        ingest: ingested,
        failures: check(step.expect, state, ingested),
        snapshot: state,
      };
      steps.push(result);
      onStep(result);
    }
    const final = await snapshot();
    return {
      steps,
      final,
      failures: [
        ...steps.flatMap((s) => s.failures.map((f) => `${s.name}: ${f}`)),
        ...check(fixture.expect, final).map((f) => `final: ${f}`),
      ],
    };
  } finally {
    await h.close();
  }
}
