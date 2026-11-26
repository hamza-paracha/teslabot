# HTTP API reference

## Credential scopes

The operator bearer (`ADMIN_TOKEN`) and operator session act on the installation owner's account. A driver session and that driver's `tbm_…` MCP tokens act only on that driver's account. The installation `MCP_TOKEN` acts on the operator's account.

| Access                                                                                             | Operator bearer     | Operator session | Driver session | MCP bearer | Telemetry bearer |
| -------------------------------------------------------------------------------------------------- | ------------------- | ---------------- | -------------- | ---------- | ---------------- |
| Vehicle and planner reads (`GET /api/…`)                                                           | Yes                 | Yes              | Yes            | Yes        | No               |
| Planner writes (the three POSTs below)                                                             | Yes                 | Yes              | Yes            | Yes        | No               |
| Tesla connection, selection, telemetry configuration, preferences, alerts and MCP token management | Yes                 | Yes              | Yes            | No         | No               |
| Invite and account administration; partner registration                                            | Yes                 | Yes              | No             | No         | No               |
| Delete own driver account                                                                          | No                  | No               | Yes            | No         | No               |
| Create operator session (`POST /admin/session`)                                                    | Yes                 | No               | No             | No         | No               |
| Hosted MCP (`/mcp`)                                                                                | Yes, with MCP scope | No               | No             | Yes        | No               |
| Ingest telemetry (`POST /telemetry/ingest`)                                                        | No                  | No               | No             | No         | Yes              |

The MCP scope allows exactly three POSTs outside the MCP transport: `/api/trips`, `/api/trips/outcome` and `/api/briefings`. They save plans, outcomes and briefing schedules in teslabot; they do not control the car or change account settings. Vehicle commands are unavailable to all credentials.

Browser mutations, including creating an operator session, require a matching `Origin`. If a request sends an invalid `Authorization` header, it is rejected rather than falling back to a session cookie. No permissive CORS is enabled.

## Routes

| Method | Route                                                | Access / behavior                                                                       |
| ------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| GET    | /                                                    | Public static shell; no vehicle information                                             |
| GET    | /health                                              | Public service liveness, not proof of Tesla connectivity                                |
| GET    | /.well-known/appspecific/com.tesla.3p.public-key.pem | Public P-256 key                                                                        |
| POST   | /admin/session                                       | Admin bearer + same origin; creates secure session                                      |
| POST   | /admin/partner/register                              | Operator only; public key check, partner registration/verification                      |
| GET    | /auth/login                                          | Operator or driver; begins consent for their account                                    |
| POST   | /auth/reconnect                                      | Operator or driver; returns authorization_url, keeps connection until callback succeeds |
| GET    | /auth/callback                                       | Public callback protected by browser-bound one-use state                                |
| GET    | /auth/status                                         | Operator or driver; sanitized configuration/usage status                                |
| POST   | /auth/disconnect                                     | Operator or driver; deletes their local credentials/data/sessions                       |
| GET    | /api/vehicles                                        | Protected; opaque authorized identifiers, cached 5 minutes                              |
| POST   | /api/vehicle/select                                  | Operator or driver; body {"id":"opaque identifier"}                                     |
| GET    | /api/vehicle                                         | Protected selected vehicle observation                                                  |
| GET    | /api/vehicle/battery                                 | Protected battery percentage/range                                                      |
| GET    | /api/vehicle/charging                                | Protected charging state/power/limit                                                    |
| GET    | /api/vehicle/climate                                 | Protected cabin/outside temperature                                                     |
| GET    | /api/vehicle/location                                | Protected, disabled unless location explicitly enabled                                  |
| GET    | /api/vehicle/summary                                 | Protected normalized observation                                                        |
| GET    | /api/vehicle/changes                                 | Protected comparison of last two stored observations; no Tesla call                     |

Additional protected endpoints:

- `GET /api/vehicle/context`: grounded narrative, meaningful changes and limitations; shares the normal observation cache.
- `GET /api/vehicle/history`: optional stored observations; no Tesla requests.
- `GET /api/vehicle/trip?distance_km=100&reserve_percentage=20`: an estimate using the caller's total distance and Tesla's reported range. It does not plan a route or guarantee reachability.
- `GET/POST /admin/preferences`: the operator's or driver's own opt-in history and change thresholds. Disabling history deletes its stored samples.
- `POST /api/trips`: create or update a trip plan (`trip_id` for follow-ups); returns the leg-by-leg assessment. `GET /api/trips` lists saved trips and outcomes for the selected vehicle.
- `POST /api/trips/outcome`: record actual battery use for a saved trip and return accuracy and calibration.
- `GET/POST /api/briefings`: list or upsert upcoming departure briefings (moved events reschedule, `cancelled` removes).
- `GET/POST /admin/alerts`: the operator's or driver's own alert settings (time zone, ntfy/JSON destination, plug-in reminder, briefing lead time and reserve). The destination URL is stored encrypted and only its host is returned. `POST /admin/alerts/test` sends a test notification.
- `POST/GET /mcp`: hosted Streamable HTTP MCP endpoint; MCP or operator bearer required.

Accounts and live data:

- `GET /auth/signin`, `GET /auth/signup?invite=CODE`: public; start Tesla sign-in for the owner, an existing driver or an invite. The owner's linked Tesla account gets an operator session. Unknown Tesla accounts are refused at the callback.
- `POST/GET /admin/invites`, `POST /admin/invites/revoke`, `GET /admin/accounts`, `POST /admin/accounts/disable`, `POST /admin/accounts/delete`: operator only.
- `GET/POST /account/mcp-tokens`, `POST /account/mcp-tokens/revoke`: the operator's or driver's own MCP credentials. `POST /account/delete`: a driver may delete their own account; the operator account cannot be deleted.
- `GET /api/telemetry` (`?check=true` asks Tesla), `POST /api/telemetry/enable`, `POST /api/telemetry/disable`: live data for the selected car.
- `POST /telemetry/ingest`: the telemetry relay only (`TELEMETRY_INGEST_TOKEN`). The relay sends a UUID in `Idempotency-Key` and reuses it when retrying the same batch. Returns `received`, `applied` and `ignored` (vehicle-data records committed by this attempt and those skipped), `unknown_vehicles` and `failed_accounts`. HTTP 503 means some accounts failed; other accounts may already have committed.

Responses include retrieved/observed timestamps, stale status, awake information and potential API charges. API failures contain stable codes without upstream sensitive details. Vehicle metadata/cache records are encrypted; VINs are used only server-side. Always inspect stale flags before answering “right now.”

`GET /api/vehicles?refresh=true` explicitly bypasses the metadata cache. A successful list response includes `status` (`no_authorized_vehicles`, `selection_required` or `ready`), `selected_id`, `vehicles` and `data.cache_hit`. Unselected/empty responses include `guidance` with recovery steps and the dashboard URL. A fresh list that no longer contains the selected vehicle invalidates selection and its cached observations. No other vehicle is selected automatically. Selection always rechecks Tesla's authorized list.

`GET /auth/status` adds `vehicle_access` from stored metadata (it can also be `not_checked`), and `authorization.vehicle_information` (`granted`, `missing` or `unknown` based on the returned scope). This status route makes no Tesla call. It does not identify the Tesla user or guarantee that stored authorization is still valid.

Common connection/selection errors include `error.message`, `error.next_steps` and `error.dashboard_url` alongside the stable `error.code`. A missing account, an unchecked/unselected account and a recently confirmed empty list are distinguished. No battery value accompanies these errors. API OAuth errors remain JSON; HTML navigations to login/callback return to `/?oauth_error=CODE` for dashboard recovery. Reconnection is a protected POST; the existing grant is replaced only after a valid browser-bound callback and token exchange. Apply database migration `0002_oauth_purpose.sql` before using these routes.

## Additional vehicle reads

- `GET /api/vehicle/cached`: the stored selected-vehicle observation only; makes no Tesla request.
- `GET /api/vehicle/readiness`: reported lock, closure and tire warning checks.
- `GET /api/vehicle/tires`: reported pressure and warning flags, where available.
- `GET /api/vehicle/closures`: reported door, window and trunk states.

These routes use the vehicle-read permissions above. Readiness, tires and closures share the ordinary observation cache. Missing sensor data remains unknown.
