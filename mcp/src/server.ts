import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
const endpoints = {
  tesla_get_vehicles: "/api/vehicles",
  tesla_get_vehicle_status: "/api/vehicle",
  tesla_get_battery: "/api/vehicle/battery",
  tesla_get_charging_status: "/api/vehicle/charging",
  tesla_get_climate: "/api/vehicle/climate",
  tesla_get_location: "/api/vehicle/location",
  tesla_get_vehicle_summary: "/api/vehicle/summary",
};
export function createServer(
  origin: string,
  token: string,
  fetcher: typeof fetch = fetch,
) {
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw Error("Backend must be a fixed HTTPS origin");
  if (token.length < 32) throw Error("Missing secure MCP credential");
  const server = new McpServer({ name: "teslabot", version: "1.0.0" });
  for (const [name, path] of Object.entries(endpoints))
    server.registerTool(
      name,
      {
        description:
          "Read authorized Tesla data. May incur API charges. Never wakes the car. Inspect observation timestamps and stale flags.",
        inputSchema: z.object({}).strict(),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
      async () => {
        try {
          const response = await fetcher(url.origin + path, {
            headers: { Authorization: "Bearer " + token },
            redirect: "error",
            signal: AbortSignal.timeout(25000),
          });
          const data = (await response.json()) as Record<string, unknown>;
          return {
            content: [{ type: "text" as const, text: JSON.stringify(data) }],
            structuredContent: data,
            isError: !response.ok,
          };
        } catch {
          return {
            content: [{ type: "text" as const, text: "Backend unavailable" }],
            structuredContent: { error: { code: "backend_unavailable" } },
            isError: true,
          };
        }
      },
    );
  return server;
}
