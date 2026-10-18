# Local MCP integration

Uses the official MCP TypeScript SDK v2 over local stdio. No remote MCP server or client registration has been performed. Tests connect a real SDK client to the server in memory and invoke a tool against a mocked backend; they do not demonstrate live Tesla data.

```sh
cd /absolute/path/to/teslabot
npm ci
# Set these locally through a trusted environment/secret manager:
export TESLABOT_URL=https://tesla.example.com
# TESLABOT_MCP_TOKEN must be the distinct backend MCP_TOKEN secret.
npm run mcp
```

Generic Claude Desktop / MCP-client configuration (placeholders are intentional; do not commit a real token):

```json
{
  "mcpServers": {
    "teslabot": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/teslabot/node_modules/tsx/dist/cli.mjs",
        "/absolute/path/to/teslabot/mcp/src/index.ts"
      ],
      "env": {
        "TESLABOT_URL": "https://tesla.example.com",
        "TESLABOT_MCP_TOKEN": "<read-only backend credential>"
      }
    }
  }
}
```

For Codex, configure an equivalent stdio server under `mcp_servers.teslabot` using the absolute command/args and an environment supplied securely by the launching process. Client-specific configuration has not been installed or verified; consult the installed client's current schema before editing it. Keep any client configuration containing the bearer credential permission-restricted. The MCP server never receives Tesla tokens or the vehicle private key.

Tools: tesla_get_vehicles, tesla_get_vehicle_status, tesla_get_battery, tesla_get_charging_status, tesla_get_climate, tesla_get_location, tesla_get_vehicle_summary, tesla_get_vehicle_context, tesla_get_vehicle_changes, tesla_get_vehicle_history, tesla_estimate_trip and tesla_plan_departures. Tools cannot select a different vehicle or change Tesla authorization. Select through the admin dashboard first. Responses include opaque vehicle identifiers, observation/cache metadata and clear error codes. Already-awake is null when unknown, true only for a successful live read checked as online. API charges may apply; a cached response does not trigger a data request.

For a real verification after connection, invoke tesla_get_battery and verify source=tesla_fleet_api, the selected opaque vehicle ID, non-stale observation time and actual battery data. Do not call stale/mock output a live result. The broader agent must treat stale observations as historical and never fabricate a current percentage.

## Private configuration and verification

To keep a bearer credential out of client configuration, create an ignored mode-0600 file:

```sh
python3 scripts/configure-mcp.py --url https://tesla.your-domain.tld
TESLABOT_CONFIG=/absolute/path/to/teslabot/secrets/mcp.json npm run mcp:verify
```

The file contains only the backend HTTPS origin and MCP_TOKEN, never Tesla credentials or the administrator token. Point a local client at the same Node/tsx command shown above and set `TESLABOT_CONFIG` instead of embedding a token. This works with any client that supports standard local stdio MCP; Hermes and hosted ChatGPT configuration have not been installed or verified.

`npm run mcp:verify -- tesla_get_battery` invokes a real SDK client and child-process server against the configured backend. It prints sanitized verification metadata. A successful empty vehicle list proves transport and account access only; it is not proof of live vehicle data.

For “How's the car?”, use `tesla_get_vehicle_context`. Report stale data as last known, respect section timestamps and nulls, and never infer a routine or exact charging transition time. `tesla_estimate_trip` requires total distance including every leg and optionally a reserve percentage (default 20). Its output is a limited range estimate, not navigation guidance or a reachability guarantee. Calendar, maps, weather and charger data need separately authorized integrations.

`tesla_plan_departures` accepts bounded event and forecast inputs from the host's existing tools and uses `GET /api/vehicle/cached` only. It performs no live Tesla reads and never stores calendar inputs in the backend. See [proactive plugin setup](PROACTIVE_PLUGIN.md).
