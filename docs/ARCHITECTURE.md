# Architecture

## Source layout

| Location                                    | Responsibility                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/index.ts`                              | Public routes, central authorization checks, dispatch and response security headers |
| `src/routes/auth.ts`                        | Browser-bound OAuth callback and protected connection/status/disconnect routes      |
| `src/routes/vehicle.ts`                     | Vehicle selection, readings, caches and observation preferences                     |
| `src/routes/trips.ts`                       | Saved trip plans, follow-up updates and trip outcomes                               |
| `src/routes/accounts.ts`                    | Invites, driver accounts, per-driver MCP credentials and account deletion           |
| `src/routes/telemetry.ts`, `src/telemetry/` | Live-data enable/disable/status, ingest and field mapping                           |
| `telemetry/`                                | Telemetry Worker, Durable Object and container (fleet-telemetry, proxy, relay)      |
| `src/routes/alerts.ts`                      | Alert settings (admin) and departure-briefing events (MCP)                          |
| `src/scheduled.ts`, `src/notify.ts`         | Cron alert runner and ntfy/JSON notification delivery                               |
| `src/tesla/`                                | Tesla authentication, partner registration, API requests and response normalization |
| `src/context/`                              | Pure trip, charging, readiness, history and proactive planning logic                |
| `src/security/`, `src/storage/`             | Session authorization, encryption and D1 persistence                                |
| `mcp/src/`                                  | Read-only agent tools and backend configuration                                     |
| `plugin/teslabot/`                          | Portable plugin manifest and proactive workflow skill                               |
| `public/`                                   | Static admin dashboard                                                              |
| `scripts/`                                  | Setup, key generation, tunnel management, builds and verification commands          |
| `tests/`                                    | Endpoint, planning and account-to-agent tests with local fixtures                   |

## Runtime behavior

Browser administrator -> Worker -> encrypted D1 records / Tesla Fleet API.
Local MCP client -> local stdio server -> HTTPS Worker with a separate read-only bearer credential.
Every request resolves to a principal (operator, driver, MCP reader or telemetry relay) and an account, and is served from that account's namespaced records.
Remote MCP client -> Worker `/mcp` (Streamable HTTP) -> the same routes in-process with the read-only credential.
Cron trigger (every 10 minutes) -> alert runner -> cached or fresh observation -> notification destination.

A static public shell contains no vehicle data. An administrator enters the random administrator credential through a password field; it becomes a one-hour opaque HttpOnly Secure SameSite=Strict session. The credential is not persisted in browser storage. Automation uses bearer headers. MCP_TOKEN cannot access authentication, administrative or mutating routes.

OAuth starts in the authenticated browser, with random transaction state hashed in D1 and bound to a separate SameSite=Lax HttpOnly browser cookie. Callback atomically deletes the matching unexpired transaction before exchanging the code. OAuth state lasts ten minutes. There is no arbitrary return URL or trust in incoming Host for Tesla endpoints. All exchanges use the configured origin and fixed regional URLs. Tesla identity does not authorize an administrator; only the administrator-initiated transaction can connect an account.

Tokens, selected VIN, metadata, partner status and observations are AES-256-GCM encrypted with per-record authenticated context and random IVs. The encryption key is a Cloudflare secret outside D1. Database leases serialize token rotation, account changes, vehicle selection and vehicle-data refresh. Fresh cached readings, cached observations, changes, history and a fresh vehicle list are served lock-free from a single multi-record D1 read, so an agent's parallel tool calls do not collide. A vehicle read that needs a Tesla refresh waits up to 30 seconds for a concurrent refresh, then rechecks the cache, so parallel callers share one Tesla request instead of duplicating it; other leased operations still return operation_in_progress immediately when busy. The imported encryption key is reused within an isolate, the owner token is read once per request, and audit rows are written after the response is sent. Lease lifetime is 120 seconds; external calls have 15-second timeouts, and reads are not automatically retried. A successful Tesla refresh followed by a storage outage requires recovery within Tesla's recovery window or reauthorization; there is no cross-provider atomic transaction.

Daily request reservations and monthly estimated-spend checks run as one atomic conditional D1 statement before requests. Reservations conservatively remain after errors. This limits local attempts rather than guaranteeing a Tesla invoice. There is no scheduled polling, wake route or remote command implementation. Cache TTL defaults to five minutes; stale observations are flagged and retained when Tesla is unavailable. Source timestamps remain distinct from backend retrieval time.

The read-only Worker does not require a vehicle private key.

Offline metadata from the previous observation is historical; refresh_error and stale flags must be respected.

The context module builds deterministic facts and threshold-based change descriptions from normalized observations. It distinguishes section timestamps and refuses trip estimates when battery timestamps are unavailable or stale. Trip inputs contain only a caller-supplied total distance and reserve; no additional external service is contacted. Optional history is a bounded encrypted record, committed atomically with the new and previous summaries.
