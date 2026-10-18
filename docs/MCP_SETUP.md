# Local MCP integration

Uses the official MCP TypeScript SDK v2 over local stdio. No remote MCP server or client registration has been performed. Tests connect a real SDK client to the server in memory and invoke a tool against a mocked backend; they do not demonstrate live Tesla data.

```sh
cd /absolute/path/to/evintelligence
npm ci
# Set these locally through a trusted environment/secret manager:
export EVINTELLIGENCE_URL=https://tesla.example.com
# EVINTELLIGENCE_MCP_TOKEN must be the distinct backend MCP_TOKEN secret.
npm run mcp
```

Generic Claude Desktop / MCP-client configuration (placeholders are intentional; do not commit a real token):

```json
{
  "mcpServers": {
    "evintelligence": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/evintelligence/node_modules/tsx/dist/cli.mjs",
        "/absolute/path/to/evintelligence/mcp/src/index.ts"
      ],
      "env": {
        "EVINTELLIGENCE_URL": "https://tesla.example.com",
        "EVINTELLIGENCE_MCP_TOKEN": "<read-only backend credential>"
      }
    }
  }
}
```

For Codex, configure an equivalent stdio server under `mcp_servers.evintelligence` using the absolute command/args and an environment supplied securely by the launching process. Client-specific configuration has not been installed or verified; consult the installed client's current schema before editing it. Keep any client configuration containing the bearer credential permission-restricted. The MCP server never receives Tesla tokens or the vehicle private key.

Tools: tesla_get_vehicles, tesla_get_vehicle_status, tesla_get_battery, tesla_get_charging_status, tesla_get_climate, tesla_get_location and tesla_get_vehicle_summary. Tools cannot select a different vehicle or change Tesla authorization. Select through the admin dashboard first. Responses include opaque vehicle identifiers, observation/cache metadata and clear error codes. Already-awake is null when unknown, true only for a successful live read checked as online. API charges may apply; a cached response does not trigger a data request.

For a real verification after connection, invoke tesla_get_battery and verify source=tesla_fleet_api, the selected opaque vehicle ID, non-stale observation time and actual battery data. Do not call stale/mock output a live result. The broader agent must treat stale observations as historical and never fabricate a current percentage.
