# teslabot: Personal Context for Your Tesla

## Vision

Make teslabot feel like an agent that understands the car, not a dashboard that makes you hunt for a number. Start with a truthful answer from fresh Tesla data, then build toward useful context, change awareness, and carefully confirmed actions.

The bigger direction is a personal context layer across the things I use: Tesla, calendar, home, files, and more. I want to ask one agent questions that span those services, while keeping each connection's permissions clear and under my control.

## Proactive host-agent workflow

The host agent (for example Hermes or another compatible client) supplies whichever calendar, routing and weather tools the user already uses. teslabot must not force a particular calendar provider or maintain a duplicate calendar login.

With the user's opt-in host schedule, the agent checks upcoming events, determines whether a trip is intended, obtains an actual travel estimate and checks weather at the departure location. It can say, “You have an event tomorrow morning and the forecast near departure is cold. Would you like to review warming the cabin?”

The host owns scheduling, quiet hours, notification delivery, calendar permission and deduplication. The plugin supplies the workflow skill, a typed departure-planning tool and Tesla data. An MCP server alone is not a continuously running proactive agent. Vehicle command execution is a separate future capability requiring exact, authenticated confirmation and signing support.

## The first surprising experience

Ask naturally: **“How's the car?”**

The agent gives a concise, grounded snapshot, for example:

> Battery is at 64%. It stopped charging around 2 a.m. Cabin is 11°C, and the latest vehicle reading is 8 minutes old.

Every answer should make clear when the information was observed and whether it is fresh or stale. It should explain what it can and cannot know, and never invent missing vehicle or history data.

## Experiences to build toward

### 1. Ask naturally

Let me ask about battery, estimated range, charging, climate, location, and vehicle status in ordinary language. The agent should fetch authorized Tesla Fleet API data through teslabot's backend, return a useful answer, and show how recent that data is.

### 2. Answer questions that need context

For example: **“Can I make it to my meeting and back?”** The agent could compare current battery with trip distance and, if available and authorized, the car's recorded efficiency. It should state assumptions and uncertainty, then offer a useful next step such as checking nearby charging. It must not imply route, traffic, trip-history, or charger data is available unless a connected service actually provides it.

For a supplied destination, resolve the driving route through the host's authorized maps tool, then report estimated battery at arrival and after returning to the confirmed origin. Assess each against a reserve threshold. If only the outbound distance is available, explicitly label the return distance as an equal-distance assumption. Do not invent distances, claim reachability from stale readings, or assume charging at the destination.

### 3. Notice meaningful changes

Compare observations over time and point out changes the user may care about. For example: **“You usually charge overnight; charging didn't start last night.”** Start with simple, transparent comparisons. Let the user choose what counts as noteworthy, and avoid noisy or speculative alerts.

### 4. Take careful action

Eventually, the agent might offer: **“It's cold. Want me to warm the cabin to 21°C?”** Show the exact command and parameters and ask for explicit confirmation before sending it. Begin with low-risk supported actions only. Security-sensitive actions need stronger safeguards and a separate approval flow. Never let untrusted text alone trigger a vehicle command.

## Build roadmap

1. **Prove the data path.** Finish vehicle-owner OAuth, discover and explicitly select the correct vehicle, then verify a real battery reading from Tesla's official Fleet API through the protected backend and MCP tool.
2. **Make answers trustworthy.** Preserve observation timestamps, freshness, unavailable fields, errors, and whether a request may incur charges. Clearly distinguish cached data from a fresh reading.
3. **Add useful change awareness.** Store a small history of authorized observations, compare readings, and provide opt-in, explainable summaries without continuous polling or unnecessary vehicle wakes.
4. **Connect more personal context.** Add other services behind separate, limited permissions so an agent can answer cross-service questions. Keep credentials on the backend and expose only the data each tool needs.
5. **Consider confirmed actions.** First verify Tesla's current command support, scopes, signing requirements, compatibility, and cost. Keep commands off by default. Require a clear confirmation tied to the exact vehicle and action before execution.

## Product principles

- Use Tesla's official Fleet API and OAuth flow.
- Do not ask for or store a Tesla account password.
- Keep Tesla tokens and signing keys out of the model and MCP client.
- Use least-privilege scopes and keep vehicle data private.
- Read-only by default; no automatic wakeups or polling.
- Communicate data freshness, uncertainty, and possible API charges.
- Never fabricate data or claim a mocked response is live.
- Require explicit confirmation for vehicle actions, especially security-sensitive ones.
- Keep each connected service's permissions visible and revocable.
- Make the system portable across local and hosted MCP-compatible agents.

## Implementation progress

### Implemented

- Official Tesla OAuth and protected backend, with tokens encrypted in D1.
- Typed battery, charging, climate, location and vehicle observations.
- Section-specific freshness and conservative handling of missing timestamps.
- A grounded "How's the car?" context endpoint with understandable change descriptions.
- User-configurable battery and cabin-temperature change thresholds.
- Optional encrypted history: up to 48 observations within a seven-day window, collected only on requested live reads. Expired samples are removed on the next history read or write; no background job is enabled. Cloud backups can retain older ciphertext.
- Trip estimation from a caller-supplied total distance, Tesla's reported range and a configurable battery reserve. Stale or incomplete battery data produces an insufficient-data result.
- Destination assessment with separate arrival and round-trip percentages, an explicit origin and host-supplied driving distances. It supports asymmetric return routes and labels equal-distance assumptions. Trips beyond reported range receive no fabricated arrival percentage.
- Seventeen read-only MCP tools, including context, changes, history and trip estimation.
- A provider-independent departure planner using calendar, travel and forecast inputs supplied by the host; it never polls Tesla or stores calendar inputs in the backend.
- A portable local plugin manifest, proactive workflow skill and bundled MCP runtime build. The built runtime has been started by a real stdio client, discovered 17 tools and invoked departure planning against the deployed backend with no calendar inputs; no vehicle observation was available. This is transport verification, not a live calendar-driven trip or notification.
- Optional tire pressures/warning flags, door/window/trunk states and a grounded vehicle-attention report inspired by Home Assistant.
- Charge energy, approximate duration and tariff-cost planning with caller-supplied usable capacity; no battery health or historical usage is inferred.
- A documented six-project open-source comparison with checked license files and independently implemented feature ideas.
- A private local MCP configuration file containing only the backend origin and read-only credential.
- A real stdio-client verification command, separate from mocked tests.
- Updated backend and dashboard deployed to the existing HTTPS subdomain.

### Verified against Tesla

- Partner registration and public-key matching.
- Vehicle-owner OAuth is connected.
- The authorized account's vehicle-list request succeeded but returned no vehicles. A real local stdio MCP client successfully invoked that tool against the deployed backend.
- A real MCP battery invocation reached the backend and returned `select_vehicle_first`. No battery value was available. The owner needs to confirm the correct account and vehicle permissions before a battery read can be verified.
- Deployed health, exact public-key matching, unauthorized-route protection, default history preferences, and MCP restrictions on admin routes have been checked.

### ChatGPT and proactive briefing update — October 22, 2026

- Connected the private ChatGPT teslabot plugin through an OpenAI Secure MCP Tunnel; the local managed runtime reports healthy and ready. Saved and read back plugin version 1.0.1 with the proactive workflow skill, preserving its existing App binding and private audience.
- Added explicit driving intent, filtering for declined/all-day/virtual events, recurring instance handling and last-revision cancellation handling.
- Added opt-in notification eligibility with IANA time zones, quiet hours, due times, expiry, bounded batches and host-supplied delivered-key history. The host still owns consent, scheduling and delivery; nothing sends automatically.
- Added charge-review suggestions grounded in fresh reported range and actual supplied trip distance. Cold-weather suggestions remain non-executable reviews.
- The tunnel key is restricted to Read/Use, stored in macOS Keychain and expires after 30 days. This Mac must stay online. No automatic startup or renewal is configured.
- In-ChatGPT invocation remains unverified because native browser control could not start during this update. Local MCP verification is separate from ChatGPT-host verification.

### Still pending

The account-to-agent workflow is now covered by an integrated test using real Worker handlers, local D1 encryption/storage and an MCP client, with only Tesla network responses mocked. It covers connection, explicit selection, battery reads, cache reuse, departure planning, refresh-token rotation and disconnect. All 111 tests pass. This does not substitute for owner sign-in or a live vehicle reading; see [verification details](docs/VERIFICATION.md).

- Explicit selection of an authorized vehicle and a verified live battery reading through MCP.
- Opt-in scheduling/notification setup and a verified ChatGPT tool invocation. Calendar, route and weather inputs have a typed planning interface, but a real combined calendar/weather/Tesla workflow has not been verified. Charger availability and recorded driving efficiency are still absent.
- Routine detection such as "charging usually starts overnight"; observations currently support comparisons only.
- Always-on hosting for the tunnel runtime, if needed; the current private authenticated tunnel runs locally.
- Any vehicle commands or virtual-key pairing. These remain disabled and require separate authorization and implementation.
