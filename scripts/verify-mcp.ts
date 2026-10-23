import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { resolve } from "node:path";

const bundled = process.argv.includes("--plugin");
const refresh = process.argv.includes("--refresh");
const tool =
  process.argv
    .slice(2)
    .find((arg) => arg !== "--plugin" && arg !== "--refresh") ??
  "tesla_get_vehicles";
if (
  ![
    "tesla_get_vehicles",
    "tesla_get_battery",
    "tesla_get_vehicle_context",
    "tesla_plan_departures",
  ].includes(tool)
)
  throw Error(
    "Choose tesla_get_vehicles, tesla_get_battery, tesla_get_vehicle_context or tesla_plan_departures",
  );
if (refresh && tool !== "tesla_get_vehicles")
  throw Error("--refresh is supported only for vehicle-list metadata");
if (!process.env.TESLABOT_CONFIG)
  throw Error("Set TESLABOT_CONFIG to your private MCP configuration file");
const client = new Client({ name: "teslabot-live-verifier", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: bundled
    ? [resolve("dist/teslabot/server/index.mjs")]
    : [resolve("node_modules/tsx/dist/cli.mjs"), resolve("mcp/src/index.ts")],
  env: { TESLABOT_CONFIG: resolve(process.env.TESLABOT_CONFIG) },
  stderr: "pipe",
});
try {
  await client.connect(transport);
  const listed = await client.listTools();
  const result = await client.callTool({
    name: tool,
    arguments:
      tool === "tesla_plan_departures"
        ? { events: [] }
        : refresh
          ? { refresh: true }
          : {},
  });
  const data = result.structuredContent as Record<string, any> | undefined;
  const observation = data?.observation ?? data;
  console.log(
    JSON.stringify(
      {
        transport: "local_stdio",
        backend: "deployed_https",
        tool_count: listed.tools.length,
        tool,
        is_error: !!result.isError,
        error_code: data?.error?.code ?? null,
        guidance: data?.guidance ?? data?.error ?? null,
        vehicle_access_status: data?.status ?? null,
        vehicle_selected:
          data && "selected_id" in data
            ? !!data.selected_id
            : observation?.vehicle?.id
              ? true
              : null,
        vehicle_count: Array.isArray(data?.vehicles)
          ? data.vehicles.length
          : undefined,
        observed_at: observation?.data?.observed_at ?? null,
        is_stale: observation?.data?.is_stale ?? null,
        cache_hit: observation?.data?.cache_hit ?? null,
        source: observation?.data?.source ?? null,
        planning_count: Array.isArray(data?.plans)
          ? data.plans.length
          : undefined,
        actions_executed: data?.actions_executed,
        vehicle_data_error: data?.vehicle_data_error,
        battery_percentage:
          data?.battery?.percentage ??
          data?.observation?.battery?.percentage ??
          null,
      },
      null,
      2,
    ),
  );
  if (result.isError) process.exitCode = 1;
} finally {
  await client.close();
}
