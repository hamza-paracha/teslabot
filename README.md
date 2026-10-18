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

There are 17 read-only tools covering battery, charging, climate, vehicle status, location, changes between readings and trip planning. The [full tool list and setup](docs/MCP_SETUP.md) are in the docs.

## The proactive part

With authorized calendar, weather and route context, an agent can check a drive and help prepare for departure.

For example: tomorrow morning is cold, I have somewhere to be, and the car might need charging before the round trip. I'd rather my agent bring that up ahead of time than have to remember to check everything myself.

The planner covers departure times, battery reserve checks and cold-weather suggestions. It also handles quiet hours and repeated suggestions. The calendar, weather and directions come from whichever tools the agent already uses.

The host agent manages scheduling and notification delivery. The integration uses read-only vehicle access.

## Architecture

```text
Agent → MCP server → Cloudflare Worker → Tesla Fleet API
```

- **TypeScript** for the backend, planning logic and MCP tools.
- **Cloudflare Workers + D1** for the API and encrypted token storage.
- **Tesla OAuth** to connect the account without handling a Tesla password.
- **MCP** to keep it usable across different agents, with a ChatGPT tunnel option and a local MCP server for compatible clients.

The agent supplies calendar, weather and route context. teslabot supplies the car data. Readings are cached to avoid unnecessary requests, and it doesn't automatically wake the car. Tesla API usage can cost money.

## Running it

You'll need Node.js 22+. The full setup also uses Python 3 and OpenSSL.

```sh
npm ci
npm run check
npm run plugin:build
```

That checks the code and builds the plugin into `dist/teslabot`. To connect a car, you'll also need your own Tesla developer app, Cloudflare setup and credentials. Start with the [setup docs](docs/README.md).
