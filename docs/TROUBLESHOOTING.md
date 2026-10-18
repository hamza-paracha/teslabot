# Troubleshooting

- service_not_configured: check D1 binding, APP_ORIGIN and generated secret names; never log their values.
- unauthorized: open administrator session or provide the appropriate bearer credential.
- read_only_token: MCP token cannot administer accounts or select vehicles.
- tesla_credentials_missing: Tesla registration/secret upload is pending.
- partner_registration_required: verify HTTPS PEM, correct origin/domain and complete partner registration in NA.
- unexpected_partner_key_response: inspect the authenticated live response shape locally without logging tokens; adapt schema only after verifying official response. Registration is not marked done.
- expired_or_replayed_state / invalid_oauth_state: start again in the same browser; the callback is intentionally single-use and expires in ten minutes.
- reauthorization_required: consent/password/token lifetime may have changed. Disconnect locally and authorize the correct vehicle-owning account again.
- permission_denied: inspect Tesla consent; location additionally requires vehicle_location and may be hidden for shared drivers.
- select_vehicle_first / vehicle_not_authorized: load vehicles and explicitly choose an authorized opaque identifier in the dashboard.
- vehicle_asleep / vehicle_offline / vehicle_unavailable: no wake is attempted. Wait until naturally online or use the official Tesla app yourself. Cached results are stale, not current readings.
- wrong_region: verify the account/vehicle region; do not probe other regions automatically.
- tesla_rate_limited: respect Retry-After; no automatic retries for vehicle data.
- local_usage_limit: inspect daily counts and estimated monthly spend; increasing them can cost money. Check Tesla account billing caps independently.
- operation_in_progress: another serialized refresh/selection/registration is running. Wait before requesting again.
- null fields: unavailable or omitted by Tesla. Do not interpret null as false/zero or infer support.

For local checks: npm run typecheck; npm test; npm run build. For deployed safe checks: TESLABOT_URL=https://tesla.example.com npm run smoke. The smoke command checks only this service's health, PEM and route protection, never live vehicle data.
