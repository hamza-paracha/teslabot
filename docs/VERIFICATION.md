# Verification

Last local validation: October 22, 2026. These checks do not require an owner sign-in.

## Repeatable checks

```sh
npm ci
npm run check
npm run plugin:build
```

The check command runs formatting, TypeScript, Vitest and a Worker dry-run build. It makes no live Tesla requests. All 111 tests pass across eight test files.

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

When owner access is available, reconnect the account that shows the vehicle in Tesla's mobile app, select it explicitly, and compare a timestamped battery reading with the official app. Then verify one read-only tool invocation inside ChatGPT. Test a calendar briefing on demand before opting into a schedule. No command or automatic wake is needed for these acceptance checks.
