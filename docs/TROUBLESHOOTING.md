# Troubleshooting

- service_not_configured: check D1 binding, APP_ORIGIN and generated secret names; never log their values.
- unauthorized: open an administrator session or provide the appropriate bearer credential. Disconnect invalidates dashboard sessions; reopen the dashboard and enter the administrator credential again before reconnecting.
- disconnect_before_reconnecting: use Reconnect Tesla Account in the dashboard. The current connection remains until the new sign-in succeeds; disconnecting first is unnecessary.
- read_only_token: MCP token cannot administer accounts or select vehicles.
- tesla_credentials_missing: Tesla registration/secret upload is pending.
- partner_registration_required: verify HTTPS PEM, correct origin/domain and complete partner registration in NA.
- unexpected_partner_key_response: inspect the authenticated live response shape locally without logging tokens; adapt schema only after verifying official response. Registration is not marked done.
- expired_or_replayed_state / invalid_oauth_state: start again in the same browser; the callback is intentionally single-use and expires in ten minutes.
- reauthorization_required: consent/password/token lifetime may have changed. Use Reconnect Tesla Account and authorize the correct vehicle account again. Authorization failures are returned as errors, without falling back to a stale battery reading.
- missing_vehicle_data_scope: Tesla explicitly returned a grant without `vehicle_device_data`. Reconnect and approve Vehicle Information and the intended vehicle. An omitted scope is unknown and does not trigger this diagnosis.
- permission_denied: inspect Tesla consent; location additionally requires vehicle_location and may be hidden for shared drivers.
- no_authorized_vehicles: Tesla's successful list response was empty. No battery value is available. Check that the Tesla sign-in account shows the car in the official app, then review teslabot's Vehicle Information and vehicle permissions under Tesla Account Settings > Security > Third Party Apps. Permission changes can take a couple of hours to sync. Reconnect from the dashboard if needed and click Reload vehicles. An empty list alone does not prove the wrong account, missing permission or wrong region; the operator should verify the configured region if access remains absent.
- select_vehicle_first: load vehicles, choose the intended car and click Select vehicle. Even a single authorized vehicle requires explicit selection. HTTP/MCP errors include `message`, `next_steps` and `dashboard_url` for this flow.
- vehicle_not_authorized: reload vehicles and choose an authorized opaque identifier in the dashboard. Fresh discovery clears selection and stored observations when the selected car is no longer authorized; it never selects another car automatically.
- vehicle_asleep / vehicle_offline / vehicle_unavailable: no wake is attempted. Wait until naturally online or use the official Tesla app yourself. Cached results are stale, not current readings.
- wrong_region: verify the account/vehicle region; do not probe other regions automatically.
- tesla_rate_limited: respect Retry-After; no automatic retries for vehicle data.
- local_usage_limit: inspect daily counts and estimated monthly spend; increasing them can cost money. Check Tesla account billing caps independently.
- operation_in_progress: another serialized refresh/selection/registration is running. Wait before requesting again.
- null fields: unavailable or omitted by Tesla. Do not interpret null as false/zero or infer support.

For local checks: npm run typecheck; npm test; npm run build. For deployed safe checks: TESLABOT_URL=https://tesla.example.com npm run smoke. The smoke command checks only this service's health, PEM and route protection, never live vehicle data.

The default vehicle list may be cached for five minutes. Dashboard Load/Reload vehicles bypasses that cache. MCP callers can explicitly invoke `tesla_get_vehicles` with `{"refresh":true}`; this reads account metadata, never wakes the car or requests battery data. Inspect `status`, `selected_id`, `guidance` and `data.cache_hit`. Do not repeatedly retry; local budgets and Tesla rate limits still apply.
