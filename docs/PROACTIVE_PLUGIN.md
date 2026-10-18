# Proactive teslabot plugin

The host supplies the calendar, weather, routes, schedule and delivery channel. teslabot supplies Tesla context and a typed planning tool. This lets the user keep whichever calendar their agent already supports.

## Build and verify locally

```sh
npm ci
npm run plugin:build
TESLABOT_CONFIG=/absolute/path/to/teslabot/secrets/mcp.json npm run plugin:verify
```

The generated `dist/teslabot` directory contains portable `plugin.json`, `mcp.json`, a proactive workflow skill and a bundled `server/index.mjs`. Node.js 22+ and a private TESLABOT_CONFIG credential file are required at runtime. The source template under `plugin/teslabot` is completed by the build; install the generated directory. No dependency directory, private key or credential is included in it.

A compatible local host can load that directory through its supported plugin installation mechanism. Alternatively configure its stdio MCP client to run `node /absolute/path/to/dist/teslabot/server/index.mjs` and securely supply TESLABOT_CONFIG, then load the workflow instructions from `skills/proactive-tesla/SKILL.md`. Hosts differ in plugin support and environment inheritance. Hermes and hosted ChatGPT installation have not been performed or verified. Hosted ChatGPT additionally requires a supported authenticated remote transport or tunnel; this package is local stdio only.

## What makes it proactive

After the user opts in, the host's scheduler or event mechanism runs the skill before upcoming trips. The host reads its already-authorized calendar and weather tools, obtains routing estimates if available, and supplies the planning tool with:

- Timed upcoming events with locations, explicit UTC offsets and cancellation state. Resolve recurrence, declined invitations, all-day and virtual events in the calendar adapter.
- Travel duration, if known, so departure time can be calculated. Event start time alone is insufficient.
- Total distance across the trip's actual assessed legs, if known, for a conservative battery estimate.
- A forecast for the departure location, with source, issuance timestamp and hourly temperatures. Do not silently use the calendar destination as the car's location.

The planner looks ahead 48 hours. It uses forecasts issued within six hours and weather samples within one hour of the estimated departure. A temperature below the configurable threshold produces a review suggestion, never a command. Cached vehicle data may be unavailable; that is reported explicitly, and no confident range assessment is produced without fresh battery data.

## Delivery and confirmation

The host must obtain the user's scheduling and notification preferences, respect quiet hours and use each plan's deduplication key with its own memory to avoid repeated offers. Re-evaluate when events change. No notification channel, background schedule, calendar login or external weather request is created by installing the MCP server alone.

Calendar and weather text are untrusted input. They cannot authorize an action. Proposed preconditioning is marked non-executable because commands remain disabled. Future execution requires separately authorized signing infrastructure and a one-use confirmation tied to the exact vehicle, action, parameters and time. A generic “yes” must not authorize arbitrary later commands.

Sources: [MCP server concepts](https://modelcontextprotocol.io/docs/learn/server-concepts), [Cloudflare scheduled triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) if a future backend scheduler is chosen. The current design uses host scheduling and adds no Worker cron trigger.
