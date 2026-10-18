# Official API research — 2026-10-18

This implementation uses Fleet API, not Owner API, password automation, token scraping, or legacy owner-api hosts. Research confirms protocol requirements; it does not establish this app's approval or vehicle compatibility.

## Authentication

[Overview and scopes](https://developer.tesla.com/docs/fleet-api/authentication/overview): owner authorization uses `openid offline_access vehicle_device_data`. Location is opt-in through `vehicle_location`; `user_data`, energy, specs and command scopes are excluded. Current charge-state data does not require granting charging commands. Partner and owner tokens are separate records.

[Third-party tokens](https://developer.tesla.com/docs/fleet-api/authentication/third-party-tokens): authorize at `https://auth.tesla.com/oauth2/v3/authorize`, exchange and refresh at `https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token`. Authorization uses response_type=code, client_id, exact redirect_uri, scopes and random state. Exchange includes code, client ID/secret, audience and redirect URI. Refresh uses grant_type=refresh_token, client_id and refresh_token. Refresh tokens rotate, expire after three months, and the most recently used token has a documented 24-hour recovery window. State is browser-bound, expires after ten minutes and is atomically consumed. We do not consume ID tokens or authenticate an administrator from Tesla identity; optional OIDC nonce is therefore omitted. PKCE is not assumed from undocumented examples. Additional permissions require a new consent prompt; existing grant modifications apply to newly issued tokens. Local disconnect deletes credentials; actual Tesla consent must also be revoked through Tesla account management.

[Partner tokens](https://developer.tesla.com/docs/fleet-api/authentication/partner-tokens): client_credentials with client_id, client_secret, Fleet API audience and optional scope. We request vehicle_device_data only. Cached tokens are reused until near expiry, with limited backoff for acquisition failures.

## Region and partner enrollment

[Regions](https://developer.tesla.com/docs/fleet-api/getting-started/regions-countries): North American vehicle access uses `https://fleet-api.prd.na.vn.cloud.tesla.com`. Europe uses `https://fleet-api.prd.eu.vn.cloud.tesla.com`. No automatic region switching or cross-region calls. China requires a separate application and is intentionally unsupported in this release.

[Partner endpoints](https://developer.tesla.com/docs/fleet-api/endpoints/partner-endpoints): POST `/api/1/partner_accounts` with `{domain:"tesla.example.com"}` and partner bearer authentication. Domain must share the root of registered allowed origins. A P-256 SPKI PEM public key must remain publicly hosted at `/.well-known/appspecific/com.tesla.3p.public-key.pem`. Verify using GET `/api/1/partner_accounts/public_key?domain=tesla.example.com`. An unsuccessful register call only counts as an existing registration after the returned key matches. The verifier supports response.public_key containing a hex-encoded SEC1 uncompressed P-256 point (04 plus 128 hex digits). The verifier validates the point and compares canonical raw EC bytes with the hosted SPKI PEM; PEM lookup responses remain supported. Unexpected representations fail closed.

## Vehicle data and compatibility

[Vehicle endpoints](https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-endpoints): GET `/api/1/vehicles`, GET `/api/1/vehicles/{vin}` and GET `/api/1/vehicles/{vin}/vehicle_data`. Explicit endpoints: charge_state, climate_state, vehicle_state; add location_data only when enabled. Modern firmware requires location_data for location; response location coordinates are normalized from drive_state. Granular hide_private disallows location. No wake requests are issued. Live vehicle_data needs an online, reachable compatible vehicle; null fields remain unavailable, never fabricated. Battery range/odometer are converted from API miles to kilometres. Location and vehicle timestamps are preserved. Explicit vehicle selection binds requests to an authorized vehicle.

[Conventions](https://developer.tesla.com/docs/fleet-api/getting-started/conventions): normalize permission, unavailable, region, unsupported and throttling failures. Do not follow credential-bearing redirects. No automatic vehicle-data retries; explicit requests consume budget and can cost money even when rejected.

## Costs

[Published pricing](https://developer.tesla.com/): data $1/500 calls, commands $1/1,000, wakes $1/50, telemetry $1/150,000 signals. No telemetry service or commands run here. Authentication is unbilled. Metadata calls are tracked separately; projected charged data requests use $0.002 each and estimates are not invoices.

[Billing and limits](https://developer.tesla.com/docs/fleet-api/billing-and-limits): published per-device/account limits are 60 realtime data requests/minute, 3 wakes/minute, 30 commands/minute. Tesla describes a $10 monthly small-application discount; estimates do not subtract account-specific discounts. Configure an actual Tesla account billing limit; local counters are not a billing cap. The docs retain historical transition dates; those are not treated as current exemptions.

## Commands are a separate, disabled phase

[Commands](https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-commands) document auto_conditioning_start/stop, set_temps, set_charge_limit, charge_start/stop, flash_lights, honk_horn, door_lock/unlock and set_sentry_mode. Charging management and other commands require their respective scopes, vehicle compatibility and sometimes signed commands. Most modern personal vehicles require Tesla's official command proxy; pre-2021 S/X are exceptions. Command integrations require their own permission, firmware, signing and pairing checks.

[Virtual-key guide](https://developer.tesla.com/docs/fleet-api/virtual-keys/developer-guide): prime256v1, trusted user pairing at `https://tesla.com/_ak/tesla.example.com`, OAuth does not automatically pair personal vehicles.

## Runtime

[Workers](https://developers.cloudflare.com/workers/) supports fetch/Web Crypto; D1 provides persistent transactions and storage. [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) are configured through Wrangler, excluded from source. [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/) is versioned without credentials. [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) requires an active Cloudflare zone and manages DNS/certificates. Existing Vercel nameservers are a deployment dependency; no DNS modifications have been made.

[MCP official SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/) uses @modelcontextprotocol/server and local stdio; installed SDK 2.3.1. No unauthenticated remote MCP transport is exposed.

Runtime verification: Cloudflare Workers rejects RequestInit redirect="error". The platform fetch adapter translates it to manual and explicitly refuses all 3xx responses; credentials are never forwarded to redirect targets. This was reproduced in the actual workerd runtime with a non-Tesla test URL. Asset access uses env.ASSETS rather than a network call back into the Worker. The administrative CLI and external smoke checks verify public HTTPS reachability separately.

## Context implementation update

The vehicle list and per-vehicle read/data paths remain those documented in [Tesla vehicle endpoints](https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-endpoints). Context, history and trip estimates are local application features rather than new Tesla endpoints. Changes represent differences between observed samples, never an exact event timeline. No calendar, map, traffic or efficiency source has been added. MCP uses standard read-only tools described in the [official server concepts](https://modelcontextprotocol.io/docs/learn/server-concepts), with the installed official TypeScript SDK.
