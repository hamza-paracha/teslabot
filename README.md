# teslabot

Connect your Tesla to your personal AI agent. Ask about your car, plan a trip, or let your agent help you prepare before you leave.

teslabot uses Tesla’s official Fleet API and works through MCP, the standard that lets AI agents use tools.

## What can I ask?

| Ask your agent                            | What teslabot helps with                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| “How’s my car?”                           | Battery, range, charging, temperature and what changed since the last check.                           |
| “Can I drive to this place and back?”     | Estimated battery when you arrive and after the round trip, using a driving route from your agent.     |
| “How long and how much to charge to 80%?” | Estimated charging time, energy and cost, using the battery capacity and electricity rate you provide. |
| “Did I leave anything open?”              | Available door, window, trunk and lock readings.                                                       |
| “Anything I should check before leaving?” | Reported tire warnings and other items that need attention.                                            |

Answers include how recent the car’s data is. Missing information stays unknown, and trip estimates include their assumptions.

## What can it do proactively?

Once you enable a schedule in your agent and connect its calendar, maps and weather tools, it can:

- **Look ahead at your calendar.** Notice an upcoming event with a location and work out when you might need to leave.
- **Check the battery for the trip.** Estimate what you would have left at the destination and after returning, and flag when charging may be needed.
- **Notice cold departures.** Use the forecast near departure time to suggest planning cabin preconditioning.
- **Surface things to check.** Include last-known open windows, unlocked state or tire warnings before a trip.

It uses whichever calendar and weather services your agent already supports. Your agent handles the schedule, quiet hours and notifications.

**Remote heating and other vehicle commands are not available yet.** The current plugin provides information and suggestions.

## How it works

Your agent brings the calendar, weather and driving directions. teslabot adds authorized Tesla data and planning tools.

A small Cloudflare Worker handles Tesla sign-in and API requests. Sensitive stored data is encrypted, and Tesla credentials stay in the backend. A local MCP plugin connects that backend to a compatible agent.

You sign in directly with Tesla. teslabot never asks for your Tesla password. It also avoids waking the car or continuously polling it.

## Get started

You need a Tesla account with access to the car, a Tesla developer application, a domain, a Cloudflare account and a compatible local agent.

1. [Set up Cloudflare](docs/CLOUDFLARE_SETUP.md) and [register the Tesla app](docs/TESLA_REGISTRATION.md).
2. [Connect your Tesla account](docs/OAUTH_SETUP.md) and select your vehicle.
3. [Connect ChatGPT](docs/CHATGPT_SETUP.md), or [another agent through MCP](docs/MCP_SETUP.md).
4. [Set up the proactive plugin](docs/PROACTIVE_PLUGIN.md) if you want scheduled checks and suggestions.

Tesla API calls may incur charges. teslabot caches readings and includes local usage limits.

## Current status

The backend and local plugin are implemented. Tesla sign-in, partner registration and the MCP connection have been verified, but the connected account currently returns no vehicles, so real battery readings still need verification.

The private ChatGPT plugin and tunnel are connected, with proactive workflow instructions included. A tool call inside ChatGPT still needs verification. The local tunnel requires this Mac to stay online.

No notification schedule has been configured. Proactive delivery requires your opt-in and host setup; installing MCP tools alone does not start a background agent. The planner can respect supplied quiet hours and suppress previously delivered suggestions.

## For developers

```sh
npm ci
npm run check
npm run plugin:build
```

The plugin build is saved to `dist/teslabot`. Development requires Node.js 22+, Python 3 and OpenSSL. Follow the setup guides above for configuration and credentials.

[Project goals](goal.md) · [Architecture](docs/ARCHITECTURE.md) · [HTTP API](docs/HTTP_API.md) · [Security](docs/SECURITY.md) · [Open-source research](docs/OPEN_SOURCE_RESEARCH.md)
