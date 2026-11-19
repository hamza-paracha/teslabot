# MCP integration

## Hosted endpoint

The Worker serves MCP over Streamable HTTP at `https://<your domain>/mcp`. Point any client that supports remote MCP servers at that URL with the header `Authorization: Bearer <MCP_TOKEN>`. No local process or tunnel is needed. The endpoint accepts only a bearer credential, never the dashboard cookie. Every tool call runs in-process with the read-only MCP credential, so the admin token is never used for tool calls even if a client presents it. Each `/mcp` request counts once toward the 60-requests-per-minute limit.

## Local stdio

The local server uses the official MCP TypeScript SDK v2 over stdio. For ChatGPT, configure a Secure MCP Tunnel; see [ChatGPT setup](CHATGPT_SETUP.md). Integration tests connect an MCP client through the Worker and D1 storage with mocked Tesla responses; see [verification](VERIFICATION.md).

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

For Codex, configure an equivalent stdio server under `mcp_servers.teslabot` using the absolute command/args and an environment supplied securely by the launching process. Consult the client's configuration schema before editing it. Keep any client configuration containing the bearer credential permission-restricted. The MCP server never receives Tesla tokens or the vehicle private key.

Tools: tesla_get_vehicles, tesla_get_snapshot, tesla_get_history, tesla_plan_trip, tesla_record_trip_outcome, tesla_schedule_briefings, tesla_plan_charging and tesla_plan_departures. The three planner tools (`tesla_plan_trip`, `tesla_record_trip_outcome`, `tesla_schedule_briefings`) save trip or briefing state in teslabot and are annotated as not read-only. None of the tools can control the car. `tesla_estimate_trip` and `tesla_assess_destination` were replaced by `tesla_plan_trip`. `tesla_get_snapshot` replaces the earlier per-field tools (status, battery, charging, climate, location, summary, context, changes, readiness, tires and closures): it makes one backend request and accepts optional `sections` (`battery`, `charging`, `climate`, `closures`, `tires`, `location`, `readiness`, `changes`; default all) so an agent answers a status question in a single call. A requested section the backend cannot provide, such as location when it is not enabled, is returned as null and listed in `unavailable_sections`. Tools cannot select a different vehicle or change Tesla authorization. Select through the admin dashboard first. Responses include opaque vehicle identifiers, observation/cache metadata and clear error codes. Already-awake is null when unknown, true only for a successful live read checked as online. API charges may apply; a cached response does not trigger a data request.

`tesla_get_vehicles` accepts optional `{"refresh":true}` to explicitly check Tesla again instead of using its five-minute metadata cache. Inspect `status`, `selected_id`, `data.cache_hit` and any `guidance`. Empty lists and missing selections include the dashboard URL and account/consent/selection recovery steps; they never include a battery value. Use the dashboard's Reconnect Tesla Account if needed, then explicitly select the intended car. The tool remains read-only and never wakes a vehicle.

For a real verification after connection, invoke tesla_get_snapshot and verify source=tesla_fleet_api, the selected opaque vehicle ID, non-stale observation time and actual battery data. Do not call stale/mock output a live result. The broader agent must treat stale observations as historical and never fabricate a current percentage.

## Private configuration and verification

To keep a bearer credential out of client configuration, create an ignored mode-0600 file:

```sh
python3 scripts/configure-mcp.py --url https://tesla.your-domain.tld
TESLABOT_CONFIG=/absolute/path/to/teslabot/secrets/mcp.json npm run mcp:verify
```

The file contains only the backend HTTPS origin and MCP_TOKEN, never Tesla credentials or the administrator token. Point a local client at the same Node/tsx command shown above and set `TESLABOT_CONFIG` instead of embedding a token. This works with clients that support standard local stdio MCP. For ChatGPT connection instructions, see [ChatGPT setup](CHATGPT_SETUP.md).

`npm run mcp:verify -- tesla_get_snapshot` invokes a real SDK client and child-process server against the configured backend. It prints sanitized verification metadata. A successful empty vehicle list proves transport and account access only; it is not proof of live vehicle data.

For an explicit metadata reload, use `npm run mcp:verify -- tesla_get_vehicles --refresh` (or `npm run plugin:verify -- tesla_get_vehicles --refresh` after rebuilding the plugin). The verifier prints discovery/selection guidance and cache status. The refresh flag is limited to the vehicle list; it does not bypass the battery cache or wake the car.

For “How's the car?”, use `tesla_get_snapshot`. Report stale data as last known, respect section timestamps and nulls, and never infer a routine or exact charging transition time. Range answers are limited estimates, not navigation guidance or a reachability guarantee. Calendar, maps, weather and charger data need separately authorized integrations.

`tesla_plan_departures` accepts bounded event and forecast inputs from the host's existing tools and uses `GET /api/vehicle/cached` only. It performs no live Tesla reads and never stores calendar inputs in the backend. See [proactive plugin setup](PROACTIVE_PLUGIN.md).

For “Can I make it there and back?”, resolve a confirmed origin and route with an authorized driving-route tool first. Then call `tesla_plan_trip` with ordered `legs` (one per stop) and optionally `return_distance_km`. It returns a `trip_id`; on follow-ups (“What if I stop in Mississauga?”, “I can leave with 20% to spare?”, “I have 30 minutes to plug in”) pass the `trip_id` plus only what changed. Omitted fields are kept, `legs` replaces the route, and `null` clears `return_distance_km` or `charging`. The response gives:

- arrival percentage after every leg and the final percentage;
- `minimum_departure_percentage` for the chosen reserve, and the shortfall;
- with `charging` (usable capacity, charger power, optional `available_minutes`): minutes needed, and what that window gets you, capped at the car's charge limit.

A plan without legs returns `route_required` without a Tesla request. Trips are stored encrypted, up to 20 per vehicle for 30 days.

After driving, `tesla_record_trip_outcome` compares predicted and actual battery use. It uses the percentage the user reports, or a fresh reading if they don't. Once three comparable trips exist, later plans apply the median ratio of actual to predicted use. It is applied only when it makes estimates more conservative (factor ≥ 1, capped at 2).

`tesla_schedule_briefings` hands opted-in upcoming drives (event id, title, departure time, distance) to the server-side alert runner described in [proactive setup](PROACTIVE_PLUGIN.md). Re-sending an event with a new time moves its check; `cancelled: true` removes it.

The snapshot's `readiness`, `tires` and `closures` sections reuse normal authorized vehicle-data caching. Sensor availability varies; unknown values do not imply closed doors or normal tires. `tesla_plan_charging` requires usable battery capacity supplied by the user or a verified source, and optionally a real tariff and charger input power. It estimates energy/time/cost without executing charging commands. These features were informed by [the open-source comparison](OPEN_SOURCE_RESEARCH.md).
