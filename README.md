# teslabot

**Give your personal AI agent context about your Tesla.** Ask about the battery, check whether a trip fits your range, or prepare for tomorrow's drive using your agent's calendar and weather tools.

teslabot connects Tesla's official Fleet API to agents through **MCP**. It provides read-only tools and a proactive workflow skill. Compatible local MCP clients can run it directly; hosted ChatGPT can connect through a private OpenAI Secure MCP Tunnel.

## Why I built it

Personal agents are more useful when they can bring your tools together. Your calendar knows where you need to be, the weather forecast knows what tomorrow looks like, and your car knows its battery level. teslabot gives an agent a way to combine that context instead of making you check each app separately.

It uses whichever calendar, weather and routing tools your agent already supports. You don't need to move to a particular calendar service.

## Useful things to ask

| Ask                                           | What it does                                                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| “What's my battery percentage?”               | Returns the authorized vehicle's battery reading with its timestamp and freshness.                                      |
| “Can I get to the airport and back?”          | Uses a driving route from your agent to estimate battery at the destination and after returning, with a reserve margin. |
| “What should I know before leaving?”          | Reports available lock, door, window, trunk and tire-warning readings. Missing readings stay unknown.                   |
| “What's changed since the last check?”        | Compares stored observations when available. Optional history is encrypted and limited to 48 samples over seven days.   |
| “How long and how much to charge to 80%?”     | Estimates energy, duration and cost using the usable battery capacity, charger power and electricity rate you supply.   |
| “Help me prepare for tomorrow's appointment.” | Combines confirmed driving plans, travel time, departure weather and cached vehicle context to suggest what to review.  |

Trip estimates use Tesla's reported range, not a detailed energy model. Weather, speed, elevation and detours can change the result. Stale or missing battery data cannot support a confident arrival estimate.

## Proactive behavior

With your permission and a scheduler in your agent, the workflow can:

- **Look ahead 48 hours.** Use upcoming calendar events and actual routing estimates to work out departure times.
- **Flag charging needs.** Suggest reviewing charging when a planned drive would leave less than your chosen reserve, using fresh cached battery data.
- **Notice cold departures.** Offer a review of cabin preconditioning near departure time using a fresh forecast for the departure location.
- **Surface vehicle concerns.** Include last-known open windows, unlocked state and reported tire warnings.
- **Avoid repeated interruptions.** Apply supplied quiet hours, skip delivered suggestions, filter cancelled/declined/virtual/all-day events and require confirmed driving intent.

**Installing the plugin does not start a background agent.** Your host must provide calendar access, routes, weather, scheduling and a notification channel. Delivery is opt-in; the planner only reports which suggestions are due. Recheck changed events before sending.

**It cannot turn on heating, unlock the car, change charging settings or execute other vehicle commands.** Cold-weather preparation is a suggestion only. Commands and virtual-key pairing are a separate future phase.

## How it works

```text
Your agent → MCP tools → authenticated Cloudflare Worker → Tesla Fleet API
    │
    └── its existing calendar, weather and driving-route tools
```

The Worker handles Tesla OAuth, encrypted token storage in Cloudflare D1, vehicle selection, caching and usage limits. You sign in on Tesla's own website; teslabot never asks for your Tesla password. The vehicle account can differ from the developer account.

The MCP server uses a separate read-only backend credential. Tesla access tokens and refresh tokens stay in the backend. The plugin includes workflow instructions for combining the tools with your agent's existing connections.

There is no scheduled polling by default, and the application never wakes the car. Tesla API calls can cost money. Cache reuse and local request/spend thresholds reduce unnecessary calls; those thresholds are not a Tesla billing cap.

## Available tools

All 17 tools are read-only. Tools that need a live vehicle read may incur Tesla API charges; departure planning uses cached data only.

| Purpose                                          | MCP tools                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Vehicle discovery and status                     | `tesla_get_vehicles`, `tesla_get_vehicle_status`                                                                   |
| Battery, charging and temperature                | `tesla_get_battery`, `tesla_get_charging_status`, `tesla_get_climate`                                              |
| Summary and changes                              | `tesla_get_vehicle_summary`, `tesla_get_vehicle_context`, `tesla_get_vehicle_changes`, `tesla_get_vehicle_history` |
| Vehicle attention                                | `tesla_get_readiness`, `tesla_get_tires`, `tesla_get_closures`                                                     |
| Location, when separately enabled and authorized | `tesla_get_location`                                                                                               |
| Trip and departure planning                      | `tesla_estimate_trip`, `tesla_assess_destination`, `tesla_plan_departures`                                         |
| Charging estimates                               | `tesla_plan_charging`                                                                                              |

Feature availability depends on vehicle support, granted permissions and data freshness. No trip history, battery degradation or driving habits are inferred from missing data.

## Set it up

You need a Tesla account with vehicle access, a registered Tesla developer app, a domain and Cloudflare account, and a compatible agent. Each installation uses its own backend and credentials.

1. [Set up Cloudflare](docs/CLOUDFLARE_SETUP.md) and [register your Tesla application](docs/TESLA_REGISTRATION.md).
2. [Connect the vehicle-owning Tesla account](docs/OAUTH_SETUP.md), load vehicles and explicitly select your car.
3. [Connect ChatGPT through a private tunnel](docs/CHATGPT_SETUP.md), or [configure another MCP client](docs/MCP_SETUP.md).
4. Optionally [configure proactive checks](docs/PROACTIVE_PLUGIN.md) in your host. Choose its schedule, quiet hours and notification destination.

The current ChatGPT tunnel runs locally, so the Mac and runtime must stay online. This is not an always-on cloud agent. The public GitHub repository does not grant access to the private backend or ChatGPT plugin.

## What has been verified?

- **Automated:** 111 tests pass. An integrated test runs the real Worker handlers, D1 storage and MCP client through OAuth → vehicle discovery → explicit selection → battery read → planning → token rotation → disconnect, with Tesla responses mocked. Security, failure handling, freshness and notification rules have additional tests.
- **Deployed:** HTTPS, public-key matching and unauthenticated-route protection pass production smoke checks. A local MCP client has reached the deployed backend. The private ChatGPT plugin is saved and its tunnel runtime has reported healthy.
- **Still pending:** The last live vehicle-list result contained zero vehicles. The owner is currently unable to complete sign-in, so actual vehicle data and battery readings remain unverified. A tool invocation inside ChatGPT and scheduled calendar-driven notification delivery are also unverified.

Mocked test readings are not live Tesla readings. Passing tests cannot guarantee account permissions, Tesla availability or vehicle compatibility. See [verification details and remaining checks](docs/VERIFICATION.md).

## Development

Node.js 22+, Python 3 and OpenSSL are required for the full setup.

```sh
npm ci
npm run check
npm run plugin:build
```

`npm run check` runs formatting, TypeScript, mocked tests and a Worker deployment dry run. It does not sign into Tesla, deploy changes or call live Tesla endpoints. The portable plugin is built into `dist/teslabot`; supply its private configuration separately.

[Documentation](docs/README.md) · [Goals](goal.md) · [Architecture](docs/ARCHITECTURE.md) · [HTTP API](docs/HTTP_API.md) · [Security](docs/SECURITY.md) · [Open-source research](docs/OPEN_SOURCE_RESEARCH.md)
