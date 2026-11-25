// Replay a synthetic drive through the telemetry ingestion path and check the
// per-account result against tests/fixtures/telemetry-drive.json.
//
//   npm run telemetry:replay
//   npm run telemetry:replay -- --json
//
// Covers a late (older) record, a repeated batch, a relay restart that loses
// queued records, and a second account, with the cron alert runner in between.
// Uses a local D1 database and synthetic records; nothing reaches the network.
import { parseArgs } from "node:util";
import { replay, type StepResult } from "./lib/telemetry-replay";

const { values } = parseArgs({
  options: { json: { type: "boolean", default: false } },
});
const owner = (s: Record<string, any>) => s.owner;
function print(step: StepResult) {
  const o = owner(step.snapshot) ?? {};
  const ingest = step.ingest
    ? `applied ${step.ingest.applied}, ignored ${step.ingest.ignored ?? "n/a"}`
    : step.kind === "lost"
      ? "not delivered"
      : "";
  const reminders = step.snapshot.reminders as Record<string, number>;
  console.log(
    `${step.failures.length ? "FAIL" : " ok "}  ${step.name}\n` +
      `      ${step.kind.padEnd(6)} ${String(step.records).padStart(2)} record(s)  ${ingest.padEnd(22)}` +
      ` owner: ${o.battery?.percentage ?? "-"}% (battery observed ${o.data?.sections?.battery?.observed_at ?? "-"}), online=${o.vehicle?.online ?? "-"}` +
      `  reminders ${JSON.stringify(reminders)}  Tesla requests ${step.snapshot.tesla_requests}`,
  );
  for (const failure of step.failures) console.log(`      ✗ ${failure}`);
}

const result = await replay(undefined, values.json ? undefined : print);
if (values.json) console.log(JSON.stringify(result, null, 2));
else {
  const sent = result.final.messages as string[];
  if (sent.length) console.log(`\nNotifications sent:\n  ${sent.join("\n  ")}`);
  console.log(
    result.failures.length
      ? `\nFAILED (${result.failures.length}):\n  ${result.failures.join("\n  ")}`
      : "\nAll expectations held. Synthetic records only; no network access.",
  );
}
process.exit(result.failures.length ? 1 : 0);
