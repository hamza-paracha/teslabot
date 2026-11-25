// Repeatable concurrency benchmark for vehicle reads.
//
//   npm run bench
//   npm run bench -- --rounds 50 --concurrency 1,10,50 --upstream-ms 250
//   npm run bench -- --json --out bench.json
//
// Fires bursts of parallel vehicle-section reads through the real routes,
// vehicle cache, D1 leases and request budget, against a local Miniflare D1
// and a synthetic Tesla upstream with a fixed added latency. Workloads: cold
// (cache empty), warm (cache fresh), mixed (1 in 5 bursts cold) and asleep
// (car asleep, cached reading an hour old). Exits non-zero if a read fails, a
// cold burst makes anything other than one vehicle_data request, a warm burst
// reaches Tesla, a sleeping-car burst makes more than one state check or any
// vehicle_data, wake or command request,
// or parallel callers exceed the request budget.
// All timings are synthetic; they are not production measurements.
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { TeslaClient } from "../src/tesla/client";
import { normalize } from "../src/tesla/normalization";
import {
  createHarness,
  SYNTHETIC_VEHICLE_ID,
  type Harness,
} from "./lib/harness";

const { values } = parseArgs({
  options: {
    rounds: { type: "string", default: "20" },
    concurrency: { type: "string", default: "1,5,10,25" },
    "upstream-ms": { type: "string", default: "100" },
    "budget-callers": { type: "string", default: "8" },
    budget: { type: "string", default: "3" },
    json: { type: "boolean", default: false },
    out: { type: "string" },
  },
});
const rounds = Number(values.rounds);
const levels = values.concurrency.split(",").map(Number);
const upstreamMs = Number(values["upstream-ms"]);
const budgetCallers = Number(values["budget-callers"]);
const budget = Number(values.budget);
if (
  ![rounds, upstreamMs, budgetCallers, budget, ...levels].every(
    (n) => Number.isInteger(n) && n >= 0,
  ) ||
  !rounds ||
  levels.some((n) => n < 1)
) {
  console.error("rounds, concurrency, upstream-ms and budget must be integers");
  process.exit(2);
}

const sections = ["battery", "climate", "charging", "tires", "closures"];
// Every fifth burst of the mixed workload arrives after the cache expired.
const MIXED_COLD_EVERY = 5;
type Mode = "cold" | "warm" | "mixed" | "asleep";

// The car is asleep and the cache holds a reading from an hour ago.
async function sleepingCar(h: Harness) {
  const then = Date.now() - 3600000;
  const reading = normalize(
    {
      charge_state: { battery_level: 60, battery_range: 180, timestamp: then },
      climate_state: { inside_temp: 18, timestamp: then },
      vehicle_state: { locked: true, timestamp: then },
    },
    SYNTHETIC_VEHICLE_ID,
    "Synthetic Model 3",
    false,
  );
  reading.data.retrieved_at = new Date(then).toISOString();
  await h.store.put("summary", reading);
  h.tesla.car.state = "asleep";
}

async function burst(
  h: Harness,
  concurrency: number,
  cold: boolean,
  asleep = false,
) {
  h.tesla.car.state = "online";
  if (asleep) await sleepingCar(h);
  else if (cold)
    await h.store.deleteKeys(["summary", "previous_summary"]).run();
  h.tesla.reset();
  const started = performance.now();
  const results = await Promise.all(
    Array.from({ length: concurrency }, async (_, i) => {
      const response = await h.call("/api/vehicle/" + sections[i % 5]);
      const ms = performance.now() - started;
      const body = (await response.json()) as any;
      return {
        status: response.status,
        ms,
        cache_hit: body.data?.cache_hit === true,
      };
    }),
  );
  return {
    cold,
    results,
    upstream: h.tesla.count(),
    vehicle_data: h.tesla.count("vehicle_data"),
    wake: h.tesla.count("wake"),
  };
}

const percentile = (sorted: number[], p: number) =>
  sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
const ms = (value: number) => Math.round(value * 10) / 10;

async function workload(h: Harness, concurrency: number, mode: Mode) {
  // Prime the cache and let the isolate warm up; not measured.
  const asleep = mode === "asleep";
  for (let i = 0; i < 3; i++) await burst(h, concurrency, i === 0, asleep);
  const bursts = [];
  for (let i = 0; i < rounds; i++)
    bursts.push(
      await burst(
        h,
        concurrency,
        mode === "cold" ||
          asleep ||
          (mode === "mixed" && i % MIXED_COLD_EVERY === 0),
        asleep,
      ),
    );
  const latencies = bursts
    .flatMap((b) => b.results.map((r) => r.ms))
    .sort((a, b) => a - b);
  const coldBursts = bursts.filter((b) => b.cold);
  const violations = [
    ...bursts
      .filter((b) => b.results.some((r) => r.status !== 200))
      .map(() => "a read failed"),
    ...coldBursts
      .filter((b) => b.vehicle_data !== (asleep ? 0 : 1))
      .map((b) => `cold burst made ${b.vehicle_data} vehicle_data requests`),
    ...(asleep ? bursts : [])
      .filter((b) => b.upstream !== 1)
      .map((b) => `sleeping-car burst made ${b.upstream} Tesla requests`),
    ...bursts
      .filter((b) => b.wake)
      .map(() => "a wake or command request was sent"),
    ...bursts
      .filter((b) => !b.cold && b.upstream !== 0)
      .map((b) => `warm burst made ${b.upstream} Tesla requests`),
  ];
  return {
    concurrency,
    mode,
    cold_bursts: coldBursts.length,
    warm_bursts: bursts.length - coldBursts.length,
    requests: latencies.length,
    tesla_requests: bursts.reduce((n, b) => n + b.upstream, 0),
    vehicle_data_requests: bursts.reduce((n, b) => n + b.vehicle_data, 0),
    cache_hit_responses: bursts.reduce(
      (n, b) => n + b.results.filter((r) => r.cache_hit).length,
      0,
    ),
    p50_ms: ms(percentile(latencies, 50)),
    p95_ms: ms(percentile(latencies, 95)),
    max_ms: ms(latencies.at(-1)!),
    violations: [...new Set(violations)],
  };
}

// Parallel callers against a small daily budget, through the same atomic
// reservation every Tesla request uses.
async function budgetCheck() {
  const h = await createHarness({ MAX_REQUESTS_PER_DAY: String(budget) });
  try {
    h.tesla.car.latency_ms = upstreamMs;
    const client = new TeslaClient(h.store);
    const settled = await Promise.allSettled(
      Array.from({ length: budgetCallers }, () => client.vehicles()),
    );
    const succeeded = settled.filter((r) => r.status === "fulfilled").length;
    const limited = settled.filter(
      (r) => r.status === "rejected" && r.reason?.code === "local_usage_limit",
    ).length;
    const upstream = h.tesla.count();
    return {
      callers: budgetCallers,
      daily_budget: budget,
      succeeded,
      rejected_local_usage_limit: limited,
      tesla_requests: upstream,
      violations:
        succeeded === Math.min(budget, budgetCallers) &&
        upstream === succeeded &&
        succeeded + limited === budgetCallers
          ? []
          : ["budget was not enforced exactly"],
    };
  } finally {
    await h.close();
  }
}

function environment() {
  const git = (...args: string[]) => {
    try {
      return execFileSync("git", args, { encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };
  const version = (name: string) =>
    JSON.parse(
      readFileSync(
        new URL(`../node_modules/${name}/package.json`, import.meta.url),
        "utf8",
      ),
    ).version;
  return {
    command: ["npm run bench --", ...process.argv.slice(2)].join(" "),
    date: new Date().toISOString(),
    commit: git("rev-parse", "--short", "HEAD"),
    uncommitted_changes: !!git("status", "--porcelain"),
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: `${os.cpus()[0]?.model ?? "unknown"} × ${os.cpus().length}`,
    miniflare: version("miniflare"),
    storage: "Miniflare D1 (local workerd subprocess)",
    upstream: `synthetic Tesla, ${upstreamMs} ms added latency per request`,
    cache_ttl_seconds: 300,
    rounds_per_workload: rounds,
    mixed_workload: `1 in ${MIXED_COLD_EVERY} bursts cold`,
  };
}

const h = await createHarness();
h.tesla.car.latency_ms = upstreamMs;
const reads = [];
try {
  for (const concurrency of levels)
    for (const mode of ["cold", "warm", "mixed", "asleep"] as const) {
      if (!values.json) console.error(`  running ${mode} c=${concurrency}`);
      reads.push(await workload(h, concurrency, mode));
    }
} finally {
  await h.close();
}
const report = {
  label:
    "SYNTHETIC: local D1 and a synthetic Tesla upstream. Not production measurements.",
  environment: environment(),
  reads,
  budget: await budgetCheck(),
};
const violations = [
  ...reads.flatMap((r) =>
    r.violations.map((v) => `${r.mode} c=${r.concurrency}: ${v}`),
  ),
  ...report.budget.violations,
];
if (values.out)
  writeFileSync(values.out, JSON.stringify(report, null, 2) + "\n");
if (values.json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`\n${report.label}\n`);
  for (const [key, value] of Object.entries(report.environment))
    console.log(`  ${key.padEnd(20)} ${value}`);
  console.log(
    "\n| Concurrency | Workload | Bursts (cold/warm) | Reads | Tesla requests | vehicle_data | Cache-hit responses | p50 ms | p95 ms | max ms |",
  );
  console.log("|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of reads)
    console.log(
      `| ${r.concurrency} | ${r.mode} | ${r.cold_bursts}/${r.warm_bursts} | ${r.requests} | ${r.tesla_requests} | ${r.vehicle_data_requests} | ${r.cache_hit_responses} | ${r.p50_ms} | ${r.p95_ms} | ${r.max_ms} |`,
    );
  const b = report.budget;
  console.log(
    `\nBudget: ${b.callers} parallel callers, daily budget ${b.daily_budget}: ${b.succeeded} succeeded, ${b.rejected_local_usage_limit} rejected with local_usage_limit, ${b.tesla_requests} Tesla requests.`,
  );
  console.log(
    violations.length
      ? `\nFAILED:\n  ${violations.join("\n  ")}`
      : "\nAll invariants held.",
  );
}
process.exit(violations.length ? 1 : 0);
