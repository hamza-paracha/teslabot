// "Can I make the round trip?" without a Tesla, an account or a location.
//
//   npm run demo                        both scenarios
//   npm run demo -- --scenario fresh    car online, reading taken now
//   npm run demo -- --scenario asleep   car asleep, last reading 3 hours old
//   npm run demo -- --json              raw tool responses
//
// Uses the real MCP tool, Worker routes, vehicle cache and trip planner with a
// local D1 database and a synthetic Tesla upstream. Distances are sample values.
import { parseArgs } from "node:util";
import { runScenario, scenarios, type Scenario, type Step } from "./lib/demo";

const { values } = parseArgs({
  options: {
    scenario: { type: "string", default: "both" },
    json: { type: "boolean", default: false },
  },
});
const names = Object.keys(scenarios) as Scenario[];
const selected =
  values.scenario === "both"
    ? names
    : names.filter((name) => name === values.scenario);
if (!selected.length) {
  console.error("--scenario must be fresh, asleep or both");
  process.exit(2);
}

const age = (seconds: number | null | undefined) =>
  seconds == null
    ? "unknown age"
    : seconds < 120
      ? `${seconds} s old`
      : seconds < 7200
        ? `${Math.round(seconds / 60)} min old`
        : `${Math.round(seconds / 360) / 10} h old`;

function print({
  question,
  arguments: args,
  plan,
  upstream,
  latency_ms,
}: Step) {
  const d = plan.data ?? {};
  console.log(`\n  Q: "${question}"`);
  console.log(`     tool       tesla_plan_trip ${JSON.stringify(args)}`);
  console.log(
    `     reading    observed ${d.observed_at ?? "never"} (${age(d.age_seconds)}) · cache_hit=${d.cache_hit} · stale=${d.is_stale}` +
      (d.refresh_error ? ` · refresh_error=${d.refresh_error}` : ""),
  );
  console.log(
    `     upstream   ${upstream.total} Tesla request(s): ${upstream.vehicle_data} vehicle_data, ${upstream.total - upstream.vehicle_data} vehicle state, ${upstream.wake_or_command} wake/command` +
      (upstream.calls.length
        ? `\n                ${upstream.calls.join("\n                ")}`
        : ""),
  );
  if (plan.start_percentage === null) {
    console.log(`     answer     withheld (${plan.assessment})`);
    for (const reason of plan.missing_context ?? [])
      console.log(`                ${reason}`);
  } else {
    const legs = plan.legs
      .map((leg: any) => `${leg.to} ${leg.estimated_arrival_percentage}%`)
      .join(" → ");
    console.log(
      `     answer     ${plan.assessment}: leave with ${plan.start_percentage}% → ${legs}`,
    );
    console.log(
      `                minimum departure charge for a ${plan.reserve_percentage}% reserve: ${plan.minimum_departure_percentage}% (shortfall ${plan.shortfall_percentage}%)`,
    );
  }
  console.log(`     latency    ${latency_ms} ms (local, synthetic upstream)`);
}

const output: Record<string, Step[]> = {};
for (const name of selected) {
  if (!values.json) console.log(`\nScenario: ${name}\n  ${scenarios[name]}`);
  output[name] = await runScenario(name, values.json ? undefined : print);
}
console.log(
  values.json
    ? JSON.stringify(output, null, 2)
    : "\nSynthetic data only: local D1, a synthetic Tesla upstream and sample distances. No credentials, vehicle or location were used.\n",
);
