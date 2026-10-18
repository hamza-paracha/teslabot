# teslabot

A personal Tesla Fleet API backend for AI agents. Runs on Cloudflare Workers with encrypted D1 persistence, a small administrator dashboard, and thirteen read-only MCP tools.

Ask an MCP-compatible agent for battery, charging, climate or vehicle status. Tesla credentials stay in the backend. The agent uses a separate read-only credential.

**Status:** backend, dashboard and local stdio MCP implemented. The original deployment has verified Tesla partner registration. Vehicle-owner OAuth is connected in the original deployment, but its authorized account returned no vehicles. Live battery readings still require the correct account, explicit vehicle selection and end-to-end verification. No remote MCP transport is included. Commands, vehicle wakes and scheduled polling are disabled.

See [goal.md](goal.md) for the product vision, implemented capabilities and remaining work.

## Proactive agent plugin

The host agent uses its existing authorized calendar, routing and weather tools, then calls `tesla_plan_departures`. For a destination question, `tesla_assess_destination` estimates battery at arrival and after the round trip using host-supplied driving routes. teslabot proposes preparation based on upcoming trips, forecast temperature and cached car data. The host supplies opt-in scheduling, quiet hours and notification delivery. This version can suggest cabin preconditioning but cannot execute it.

Run `npm run plugin:build` to create a portable local plugin at `dist/teslabot`, containing manifests, a workflow skill and a bundled Node runtime. See [proactive plugin setup](docs/PROACTIVE_PLUGIN.md). The plugin has not been installed in Hermes or hosted ChatGPT.

## Project layout

```text
src/
  index.ts             Worker entry point, OAuth and administrator routes
  routes/              Vehicle endpoints and HTTP utilities
  context/             Grounded summaries, change thresholds and trip estimates
  security/            Encryption, sessions and authorization
  storage/             D1 persistence, locking and usage controls
  tesla/               Typed Fleet API client, authentication and normalization
mcp/src/               Local MCP adapter using the official TypeScript SDK
public/                Dashboard HTML, CSS and JavaScript
migrations/            D1 schema migrations
scripts/               Key generation, credential setup and safe smoke checks
tests/                 Mocked API, security and MCP integration tests
docs/                  Architecture, setup and security guidance
```

## Quick start

Requires Node.js 22+, npm, Python 3 and OpenSSL. Cloudflare and Tesla accounts are required for deployment and real data.

```sh
git clone https://github.com/hamza-paracha/teslabot.git
cd teslabot
npm ci
cp wrangler.example.jsonc wrangler.jsonc
npm run check
```

The configuration template uses an example hostname and an empty database ID. Replace them before deploying. Actual deployment configuration, generated keys, local credentials and operational DNS records are ignored by Git.

## Configure and deploy

1. Follow [Cloudflare setup](docs/CLOUDFLARE_SETUP.md) to create a dedicated Worker, D1 database and HTTPS subdomain.
2. Generate a P-256 key pair with `npm run keys`. Back up the private key securely; the script refuses to replace an existing key.
3. Run `python3 scripts/configure-secrets.py --local` for isolated local credentials, or set `TESLABOT_URL` to your real HTTPS origin before generating production credentials. Existing secret values are preserved. Use separate credentials and databases for each environment.
4. Deploy the registration-ready service and verify the public key URL using `TESLABOT_URL=https://tesla.your-domain.tld npm run smoke`.
5. Register your Tesla application using [these field values](docs/TESLA_REGISTRATION.md), replacing the example domain with your real one. Collect credentials using the hidden prompts in `python3 scripts/configure-secrets.py --tesla`, then upload with its `--upload` option.
6. Follow [OAuth setup](docs/OAUTH_SETUP.md) to register the partner and connect the account that owns or is authorized to access the vehicle. Select a vehicle explicitly in the dashboard.
7. Follow [MCP setup](docs/MCP_SETUP.md) to connect your agent. The MCP adapter uses `MCP_TOKEN`, never the administrator credential or Tesla tokens.

For local development, apply migrations with `npx wrangler d1 migrations apply teslabot-production --local`, then run `npm run dev`. Local tests use an isolated temporary database and mocked Tesla responses.

## Development

```sh
npm run format       # Format source, tests and documentation
npm run check        # Formatting, TypeScript, tests and Worker dry-run build
npm run mcp          # Local stdio server; requires backend URL and MCP credential
```

GitHub Actions runs the same checks on pull requests and pushes. CI never receives production secrets or calls Tesla.

## HTTP API

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

## Usage and costs

No automatic polling, wakes or commands. Data is cached for five minutes. Defaults limit Fleet requests to 50/day and locally estimated monthly spending to $5. Local estimates do not cap Tesla billing. API reads may incur charges; see [API research](docs/API_RESEARCH.md) and verify the current Tesla pricing and your account's billing settings before connecting.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Cloudflare setup](docs/CLOUDFLARE_SETUP.md)
- [Tesla registration](docs/TESLA_REGISTRATION.md)
- [OAuth setup](docs/OAUTH_SETUP.md)
- [MCP integration](docs/MCP_SETUP.md)
- [Security and threat model](docs/SECURITY.md)
- [API research](docs/API_RESEARCH.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Virtual-key pairing — deferred](docs/VIRTUAL_KEY_PAIRING.md)

Passing mocked tests is not proof of a live Tesla connection. A fresh clone requires its own cloud configuration, credentials, keys and vehicle-owner consent.
