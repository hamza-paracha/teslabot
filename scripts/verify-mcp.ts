import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { resolve } from "node:path";

const tool = process.argv[2] ?? "tesla_get_vehicles";
if (
  ![
    "tesla_get_vehicles",
    "tesla_get_battery",
    "tesla_get_vehicle_context",
  ].includes(tool)
)
  throw Error(
    "Choose tesla_get_vehicles, tesla_get_battery or tesla_get_vehicle_context",
  );
if (!process.env.TESLABOT_CONFIG)
  throw Error("Set TESLABOT_CONFIG to your private MCP configuration file");
const client = new Client({ name: "teslabot-live-verifier", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("node_modules/tsx/dist/cli.mjs"), resolve("mcp/src/index.ts")],
  env: { TESLABOT_CONFIG: resolve(process.env.TESLABOT_CONFIG) },
  stderr: "pipe",
});
try {
  await client.connect(transport);
  const listed = await client.listTools();
  const result = await client.callTool({ name: tool, arguments: {} });
  const data = result.structuredContent as Record<string, any> | undefined;
  console.log(
    JSON.stringify(
      {
        transport: "local_stdio",
        backend: "deployed_https",
        tool_count: listed.tools.length,
        tool,
        is_error: !!result.isError,
        error_code: data?.error?.code ?? null,
        vehicle_count: Array.isArray(data?.vehicles)
          ? data.vehicles.length
          : undefined,
        observed_at: data?.data?.observed_at ?? null,
        is_stale: data?.data?.is_stale ?? null,
        source: data?.data?.source ?? null,
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
