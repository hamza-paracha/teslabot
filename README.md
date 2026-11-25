# teslabot

Connect a Tesla to a personal AI agent.

teslabot connects Tesla's Fleet API to an AI agent through a Cloudflare Workers backend and an MCP plugin.

## The idea

Ask questions about the car alongside other personal context.

For this project, that means questions like:

- “What's my battery at?”
- “Can I make it to this location, and how much battery would I have left?”
- “What about the round trip?”
- “Did I leave a window open?”
- “What changed since I last checked the car?”
- “How long would it take to charge to 80%?”

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

## Running it

You'll need Node.js 22+. The full setup also uses Python 3 and OpenSSL.

```sh
npm ci
npm run check
npm run plugin:build
```

That checks the code and builds the plugin into `dist/teslabot`.

### Try it without a Tesla

```sh
npm run demo
```

This asks "Can I make the round trip?" through the real MCP tool, cache and trip planner, with a synthetic car and a local database. It needs no credentials, car or location. With a fresh reading you get an estimate. With a sleeping car you get no estimate, and the demo shows the reading's age, which Tesla requests were made (no wake) and why the planner withheld the answer. `npm run bench` and `npm run telemetry:replay` measure parallel reads and replay a synthetic telemetry drive the same way. See [verification](docs/VERIFICATION.md#without-a-tesla) and [benchmarks](docs/BENCHMARKS.md). To connect a car, you'll also need your own Tesla developer app, Cloudflare setup and credentials. Start with the [setup docs](docs/README.md).
