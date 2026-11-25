# teslabot

TeslaBot gives an AI assistant read-only Tesla data and trip estimates through MCP. It won't wake or control the car, and it won't estimate a trip from stale battery data.

## See it fail safely and recover

After `npm ci` (Node.js 22+), run:

```sh
npm run demo
```

**Proof:** [Telemetry replay](docs/VERIFICATION.md#without-a-tesla) · [Benchmarks](docs/BENCHMARKS.md) · [Demo tests](tests/demo.test.ts)

Terminal excerpt from a **synthetic** run: one saved trip through the real MCP tool and local D1. No Tesla, credentials, or real location required.

```text
  Phase: Healthy
     upstream   2 Tesla request(s): 1 vehicle_data, 1 vehicle state, 0 wake/command
     answer     within_reserve: leave with 71% → Office 51.2% → Return to Home 31.4%
  Phase: Asleep
     reading    observed 2026-11-24T23:49:15.603Z (3 h old) · cache_hit=true · stale=true · refresh_error=vehicle_asleep
     upstream   1 Tesla request(s): 0 vehicle_data, 1 vehicle state, 0 wake/command
     answer     withheld (insufficient_fresh_data)
  Phase: Recovered
     upstream   2 Tesla request(s): 1 vehicle_data, 1 vehicle state, 0 wake/command
     answer     within_reserve: leave with 69% → Office 49.8% → Return to Home 30.5%
```

The injected telemetry write-failure and retry proof lands separately with the relay acknowledgment PR.

## What you can ask

“Can I make the round trip and get home with 30%?” · “Did I leave a window open?” · “What changed since I last checked?”

There are 8 tools, and none of them can control the car. One `tesla_get_snapshot` call covers battery, charging, climate, doors/windows, tires, location, attention items and changes between readings. `tesla_plan_trip` keeps a trip across follow-up questions: add a stop, change the reserve, ask how long you'd need to plug in. It works backward to the lowest charge you can leave with. The others cover vehicle selection, history, recording how a planned trip actually went, scheduling departure briefings, charging cost and departure planning. The [full tool list and setup](docs/MCP_SETUP.md) are in the docs.

## The proactive part

With authorized calendar, weather and route context, an agent can check a drive and help prepare for departure.

For example: tomorrow morning is cold, I have somewhere to be, and the car might need charging before the round trip. I'd rather my agent bring that up ahead of time than have to remember to check everything myself.

The planner covers departure times, battery reserve checks and cold-weather suggestions. It also handles quiet hours and repeated suggestions. The calendar, weather and directions come from whichever tools the agent already uses.

teslabot can also message you itself, even when no assistant is running. A cron trigger sends an evening plug-in reminder when the car is low and unplugged. It also sends a heads-up before drives your assistant has handed over with `tesla_schedule_briefings`. A moved appointment moves its check; a cancelled one drops it. Notifications go to an ntfy topic or a JSON webhook you set in the dashboard; alerts are off until you enable them. Vehicle access stays read-only.

## Invite-only, live data

teslabot is invite-only. The operator sends single-use invite links, and each driver signs in with Tesla and gets their own car, data, alerts and assistant credentials ([invites](docs/INVITES.md)). With Fleet Telemetry on Cloudflare Containers, cars stream changes as they happen instead of being polled ([live data](docs/TELEMETRY_SETUP.md)).

## Architecture

```text
Agent → MCP server → Cloudflare Worker → Tesla Fleet API
```

- **TypeScript** for the backend, planning logic and MCP tools.
- **Cloudflare Workers + D1** for the API and encrypted token storage.
- **Tesla OAuth** to connect the account without handling a Tesla password, and as the sign-in for invited drivers.
- **Cloudflare Containers + Spectrum** for the optional Fleet Telemetry server.
- **MCP** to keep it usable across different agents: a hosted Streamable HTTP endpoint at `/mcp` on the Worker, plus a local stdio server for compatible clients.

The agent supplies calendar, weather and route context. teslabot supplies the car data. Readings are cached to avoid unnecessary requests, and it doesn't automatically wake the car. Tesla API usage can cost money.

See the [10-minute code walkthrough](docs/WALKTHROUGH.md) and [architecture decision records](docs/adr/README.md).

## Running it

You'll need Node.js 22+. The full setup also uses Python 3 and OpenSSL.

```sh
npm ci
npm run check
npm run plugin:build
```

That checks the code and builds the plugin into `dist/teslabot`.

To connect a real car, you'll also need your own Tesla developer app, Cloudflare setup and credentials. Start with the [setup docs](docs/README.md).
