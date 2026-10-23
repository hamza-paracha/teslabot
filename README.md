# teslabot

A side project to connect my Tesla to a personal AI agent.

I wanted to be able to ask my agent about my car in the same place I ask it about everything else. So I took Tesla's Fleet API, put a small backend on Cloudflare Workers, and built an MCP plugin around it.

## The idea

Personal agents are getting more useful, but most of our stuff still lives in separate apps. I think having access to those things in one place is where it gets interesting.

For this project, that means questions like:

- “What's my battery at?”
- “Can I make it to this location, and how much battery would I have left?”
- “What about the round trip?”
- “Did I leave a window open?”
- “What changed since I last checked the car?”
- “How long would it take to charge to 80%?”

There are 17 read-only tools covering battery, charging, climate, vehicle status, location, changes between readings and trip planning. The [full tool list and setup](docs/MCP_SETUP.md) are in the docs.

## The proactive part

This is the part I want to take further. If my agent already has my calendar, it should be able to notice an appointment with a location, check the drive, and help me prepare.

For example: tomorrow morning is cold, I have somewhere to be, and the car might need charging before the round trip. I'd rather my agent bring that up ahead of time than have to remember to check everything myself.

I've built the planning logic for departure times, battery reserve checks and cold-weather suggestions. It also handles quiet hours and repeated suggestions. The calendar, weather and directions come from whichever tools the agent already uses.

Scheduling and notifications still need to be set up in the agent. Heating and other car controls aren't implemented yet—right now it can suggest things, but it can't act on the car.

## How I built it

```text
Agent → MCP server → Cloudflare Worker → Tesla Fleet API
```

- **TypeScript** for the backend, planning logic and MCP tools.
- **Cloudflare Workers + D1** for the API and encrypted token storage.
- **Tesla OAuth** to connect the account without handling a Tesla password.
- **MCP** to keep it usable across different agents. I've set up a private ChatGPT tunnel; other compatible clients can run the MCP server locally.

The agent supplies calendar, weather and route context. teslabot supplies the car data. Readings are cached to avoid unnecessary requests, and it doesn't automatically wake the car. Tesla API usage can cost money.

## Where it's at

Still a work in progress. The existing backend is deployed, and 132 tests pass locally, including full connection-to-agent and empty-account recovery flows with mocked Tesla responses. The latest reconnection/discovery update still needs migration, deployment and owner verification.

I haven't verified a real battery reading yet—the last connected account returned no vehicles. A tool call inside ChatGPT and a scheduled proactive notification also still need a live test. The local ChatGPT tunnel needs my Mac to stay online.

The [verification notes](docs/VERIFICATION.md) cover what's tested, and [goal.md](goal.md) has the ideas I want to work on next.

## Running it

You'll need Node.js 22+. The full setup also uses Python 3 and OpenSSL.

```sh
npm ci
# On a fresh checkout; keep any existing operator configuration:
cp wrangler.example.jsonc wrangler.jsonc
npm run check
npm run plugin:build
```

That checks the code and builds the plugin into `dist/teslabot`. To connect a car, you'll also need your own Tesla developer app, Cloudflare setup and credentials. Start with the [setup docs](docs/README.md).
