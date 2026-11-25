# Verification

These development checks do not require an owner sign-in.

## Repeatable checks

```sh
npm ci
npm run check
npm run plugin:build
```

The check command runs formatting, TypeScript, Vitest and a Worker dry-run build. It makes no live Tesla requests.

GitHub Actions also runs `npm run smoke:workerd` against a local Worker with fresh D1 storage. It checks health, hosted MCP authorization and a tool call, and a cron event without Tesla credentials. A separate CI job runs the Python telemetry relay suite.

The integrated `account-to-agent workflow` test in `tests/workflow.test.ts` uses real application route handlers, a local Cloudflare D1 database, application encryption and an official MCP client/server transport. Shared fixtures and database lifecycle live in `tests/helpers/app.ts`; endpoint tests remain in `tests/integration.test.ts`. Only Tesla's network responses are mocked. The workflow checks:

1. Authorization URL requests a fresh login; state and a browser-bound cookie come from the real login route.
2. The callback exchanges a fixture authorization code and establishes an admin session.
3. Discovery returns an opaque identifier without the VIN; a sole vehicle still requires explicit selection.
4. The MCP client requests battery data through the actual Worker routes and normalizes a fixture vehicle response.
5. Repeated reads use the cache. Trip and calendar/weather planning reuse the same observation without additional Tesla calls.
6. A near departure with cold forecast and insufficient estimated reserve produces review suggestions, never vehicle commands or actual notifications.
7. Responses exclude fixture Tesla tokens, backend credentials and VIN; persisted records do not contain the plaintext refresh token.
8. Expired tokens refresh and persist the rotated refresh token.
9. Disconnect removes the owner credentials and invalidates the browser session; subsequent battery reads fail.

Other tests cover state expiry/replay and wrong-browser rejection, denied consent, partner registration, permissions, sleeping/offline vehicles, timeouts, rate limits, budgets, stale data, route assumptions, sensor availability, quiet hours across DST, cancellation/recurring instances and delivery deduplication.

## Without a Tesla

These commands use a local D1 database, freshly generated credentials and a synthetic Tesla upstream. They make no network requests. `npm test` runs the same scenarios.

- `npm run demo` asks "Can I make the round trip?" through the real `tesla_plan_trip` MCP tool, Worker routes, cache and trip planner. It follows the same saved trip with the car online, then asleep with a three-hour-old reading, then back online with a new reading. For each question it prints the reading's timestamp and age, whether it was a cache hit, every Tesla request made, and the answer, or why the planner withheld one. Use `--scenario fresh|asleep` for the standalone scenarios and `--json` for the raw tool responses.
- `npm run bench` measures parallel cold, warm, mixed and sleeping-car reads. It reports Tesla requests and p50/p95 latency along with the command and environment, and exits non-zero if the cache, shared refresh or request budget invariants fail. See [benchmarks](BENCHMARKS.md).
- `npm run telemetry:replay` replays a synthetic drive through the telemetry ingest path and alert runner. It checks the final per-account reading and reminder count against [the fixture](../tests/fixtures/telemetry-drive.json); see [live data](TELEMETRY_SETUP.md#testing).

## Safe deployed checks

For an operator with the deployed public key available locally:

```sh
TESLABOT_URL=https://YOUR_DEPLOYED_HOST npm run smoke
```

This verifies health, exact public-key matching, blocked unauthenticated sensitive routes and absence of a private-key endpoint. It makes no Tesla API calls.

With the private MCP configuration supplied securely, `npm run plugin:verify` launches the built stdio MCP server and lists authorized vehicles through the real backend. That can contact Tesla. It does not wake or control the vehicle. Never run it as part of uncredentialed CI, and never commit the configuration.

## Deployment acceptance checklist

For each installation:

1. Run the production smoke check for HTTPS, public-key matching and route protection.
2. Complete Tesla OAuth and explicitly select an authorized vehicle.
3. Compare a timestamped battery reading with the Tesla app.
4. Invoke a read-only tool from the intended MCP host.
5. Test a calendar briefing on demand with the host's route and weather tools.
6. Configure scheduling and notification delivery in the host, using the user's opt-in preferences.

Vehicle commands and automatic wake requests are outside the read-only integration.
