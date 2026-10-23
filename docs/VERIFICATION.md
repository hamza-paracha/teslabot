# Verification

Last local validation: October 23, 2026. These checks do not require an owner sign-in. The reconnection update is local code; it has not been deployed or verified with a live owner account.

## Repeatable checks

```sh
npm ci
# For a fresh checkout without operator configuration:
cp wrangler.example.jsonc wrangler.jsonc
npm run check
npm run plugin:build
```

The check command runs formatting, TypeScript, Vitest and a Worker dry-run build. It makes no live Tesla requests. All 132 tests pass across nine test files. Keep an existing operator Wrangler configuration instead of overwriting it with the example.

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

The additional recovery workflow starts with a successful empty vehicle list and an MCP battery error, reconnects through the actual OAuth handlers with mocked Tesla, discovers a vehicle and requires browser-admin selection before the MCP battery fixture can be read. `tests/access.test.ts` verifies protected reconnection, one-use browser-bound replacement transactions, preservation on failed/denied sign-in, old session/data cleanup on success, pending transaction invalidation on disconnect, actionable empty-list errors, forced metadata reload, missing versus unknown scope, selection invalidation and rejection of stale cache fallback after authorization failures. Live observations explicitly include `cache_hit:false`; cache reuse is marked `true`.

The mocked flow does not emulate Safari cookies, Tesla's login UI, real account consent or a real ChatGPT conversation. It cannot certify those external behaviors.

## Safe deployed checks

For an operator with the deployed public key available locally:

```sh
TESLABOT_URL=https://YOUR_DEPLOYED_HOST npm run smoke
```

This verifies health, exact public-key matching, blocked unauthenticated sensitive routes and absence of a private-key endpoint. It makes no Tesla API calls.

With the private MCP configuration supplied securely, `npm run plugin:verify` launches the built stdio MCP server and lists authorized vehicles through the real backend. That can contact Tesla. It does not wake or control the vehicle. Never run it as part of uncredentialed CI, and never commit the configuration.

## Remaining live acceptance checks

| Check                                                      | Status                                                      |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| Worker HTTPS, public key and unauthorized-route protection | Verified by production smoke test                           |
| Partner registration and owner OAuth                       | Previously verified; owner reconnection currently pending   |
| Authorized vehicle discovery                               | Last successful live request returned zero vehicles         |
| Selected vehicle battery/charging/climate readings         | Blocked until owner sign-in, permission and selection       |
| MCP client talking to the deployed backend                 | Verified locally; no real battery value available           |
| Private ChatGPT plugin saved and tunnel ready              | Verified through plugin source read-back and runtime status |
| Tool invocation inside ChatGPT                             | Unverified                                                  |
| Combined real calendar, routes, weather and Tesla workflow | Unverified                                                  |
| Scheduled notification delivery                            | Not configured; requires host support and user opt-in       |
| Commands and virtual-key pairing                           | Disabled; outside the current phase                         |

Before using this update, apply pending D1 migrations, including `0002_oauth_purpose.sql`, to the existing bound database, deploy the Worker and rebuild/restart the local MCP/plugin runtime. See [deployment details](CLOUDFLARE_SETUP.md). No production mutation was performed during local verification.

When owner access is available:

1. Open an admin dashboard session and use Connect / Reconnect Tesla Account. Sign into the account that shows the car in the official app; approve Vehicle Information and access to that car. A denial or failed exchange must preserve any previous connection.
2. On returning to the dashboard, inspect discovery. If Tesla returns zero vehicles, follow the account/consent guidance and use Reload vehicles after fixing access. Tesla notes permissions can take a couple of hours to sync. With MCP, `tesla_get_vehicles({"refresh":true})` also bypasses the five-minute metadata cache. No vehicle may be selected automatically.
3. Choose the intended display name/state and click Select vehicle. A vehicle being asleep should not prevent selection; a battery request must report asleep or explicitly stale cached data without waking it.
4. Once naturally online, request battery data and compare its percentage and observation timestamp with the official app. Run `TESLABOT_CONFIG=/private/path/mcp.json npm run plugin:verify -- tesla_get_battery` for the real stdio MCP path. Inspect `source=tesla_fleet_api`, `is_stale=false`, observation time and the actual value. `cache_hit=true` means reuse of an earlier read; do not describe it as a new live request. Zero vehicles, null battery or any setup error remains a failed vehicle-data acceptance check.
5. Verify one read-only tool invocation inside ChatGPT. Test a calendar briefing on demand with actual host-supplied calendar, driving route and weather inputs before opting into a schedule. Missing inputs must remain missing. No command, virtual key or automatic wake is needed.
