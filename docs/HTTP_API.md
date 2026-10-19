# HTTP API reference

All data routes require admin session/bearer or the distinct read-only MCP bearer. Administrative routes require admin authentication. Browser mutation requests additionally require matching Origin. No permissive CORS is enabled.

| Method | Route                                                | Access / behavior                                                   |
| ------ | ---------------------------------------------------- | ------------------------------------------------------------------- |
| GET    | /                                                    | Public static shell; no vehicle information                         |
| GET    | /health                                              | Public service liveness, not proof of Tesla connectivity            |
| GET    | /.well-known/appspecific/com.tesla.3p.public-key.pem | Public P-256 key                                                    |
| POST   | /admin/session                                       | Admin bearer + same origin; creates secure session                  |
| POST   | /admin/partner/register                              | Admin; public key check, partner registration/verification          |
| GET    | /auth/login                                          | Admin; begins owner-account consent                                 |
| GET    | /auth/callback                                       | Public callback protected by browser-bound one-use state            |
| GET    | /auth/status                                         | Admin; sanitized configuration/usage status                         |
| POST   | /auth/disconnect                                     | Admin; deletes local owner credentials/data/sessions                |
| GET    | /api/vehicles                                        | Protected; opaque authorized identifiers, cached 5 minutes          |
| POST   | /api/vehicle/select                                  | Admin; body {"id":"opaque identifier"}                              |
| GET    | /api/vehicle                                         | Protected selected vehicle observation                              |
| GET    | /api/vehicle/battery                                 | Protected battery percentage/range                                  |
| GET    | /api/vehicle/charging                                | Protected charging state/power/limit                                |
| GET    | /api/vehicle/climate                                 | Protected cabin/outside temperature                                 |
| GET    | /api/vehicle/location                                | Protected, disabled unless location explicitly enabled              |
| GET    | /api/vehicle/summary                                 | Protected normalized observation                                    |
| GET    | /api/vehicle/changes                                 | Protected comparison of last two stored observations; no Tesla call |

Additional protected endpoints:

- `GET /api/vehicle/context`: grounded narrative, meaningful changes and limitations; shares the normal observation cache.
- `GET /api/vehicle/history`: optional stored observations; no Tesla requests.
- `GET /api/vehicle/trip?distance_km=100&reserve_percentage=20`: an estimate using the caller's total distance and Tesla's reported range. It does not plan a route or guarantee reachability.
- `GET/POST /admin/preferences`: administrator-only opt-in history and change thresholds. Disabling history deletes its stored samples.

Responses include retrieved/observed timestamps, stale status, awake information and potential API charges. API failures contain stable codes without upstream sensitive details. Vehicle metadata/cache records are encrypted; VINs are used only server-side. Always inspect stale flags before answering “right now.”

## Additional vehicle reads

- `GET /api/vehicle/cached`: the stored selected-vehicle observation only; makes no Tesla request.
- `GET /api/vehicle/readiness`: reported lock, closure and tire warning checks.
- `GET /api/vehicle/tires`: reported pressure and warning flags, where available.
- `GET /api/vehicle/closures`: reported door, window and trunk states.

These routes require the administrator session/bearer or distinct read-only MCP bearer, as do all other vehicle-data routes. Readiness, tires and closures share the ordinary observation cache. Missing sensor data remains unknown.
