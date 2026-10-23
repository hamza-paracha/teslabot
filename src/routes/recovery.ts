// Only application-owned text is exposed; never forward Tesla error descriptions.
const guidance: Record<string, [string, string[]]> = {
  unauthorized: [
    "Your dashboard session has ended or the credential was not accepted.",
    ["Open the dashboard with your administrator credential, then try again."],
  ],
  tesla_not_connected: [
    "No Tesla owner account is connected. No vehicle reading is available.",
    [
      "Open the dashboard and connect the account that shows your car in the Tesla app.",
    ],
  ],
  no_authorized_vehicles: [
    "Tesla returned no authorized vehicles for this connection. No battery reading is available. This does not establish which account or permission is wrong.",
    [
      "Confirm that the Tesla sign-in account shows the car in the official Tesla app; it may differ from the developer account.",
      "In Tesla Account Settings > Security > Third Party Apps, manage teslabot and check Vehicle Information and vehicle access. Changes can take a couple of hours to sync.",
      "Use Reconnect Tesla Account in the dashboard for a fresh sign-in, then Reload vehicles and explicitly select the car. If access is still missing, have the operator check the configured region.",
    ],
  ],
  select_vehicle_first: [
    "A vehicle must be explicitly selected before a battery or other vehicle reading can be requested.",
    [
      "Open the dashboard, load authorized vehicles, choose the correct car and click Select vehicle. Even a single car requires selection.",
    ],
  ],
  vehicle_not_authorized: [
    "The chosen vehicle is no longer in Tesla's authorized vehicle list.",
    [
      "Reload vehicles in the dashboard and select an authorized car. If it is missing, check the Tesla account and third-party vehicle permissions.",
    ],
  ],
  missing_vehicle_data_scope: [
    "Tesla's returned grant is missing Vehicle Information permission.",
    [
      "Reconnect Tesla Account in the dashboard and approve Vehicle Information and access to the intended vehicle.",
    ],
  ],
  reauthorization_required: [
    "Tesla authorization is no longer valid. No new vehicle reading is available.",
    [
      "Use Reconnect Tesla Account in the dashboard and sign in to the vehicle account again.",
    ],
  ],
  permission_denied: [
    "Tesla denied permission for this read.",
    [
      "Review teslabot's permissions and vehicle access in Tesla third-party app management, then reconnect in the dashboard. Location requires separate permission.",
    ],
  ],
  disconnect_before_reconnecting: [
    "A Tesla account is already connected.",
    [
      "Use Reconnect Tesla Account in the dashboard to replace it after a successful sign-in.",
    ],
  ],
  invalid_oauth_state: [
    "The Tesla sign-in could not be matched to this browser.",
    [
      "Start the connection again from the dashboard in the same browser. If the wrong Tesla account persists, start the entire dashboard flow in a private window.",
    ],
  ],
  expired_or_replayed_state: [
    "This Tesla sign-in attempt expired or was already used.",
    [
      "Start again from the dashboard and complete sign-in in the same browser within ten minutes.",
    ],
  ],
  oauth_consent_denied: [
    "Tesla access was not approved. Any previous connection is unchanged.",
    [
      "Start again from the dashboard when ready and approve the requested read-only vehicle access.",
    ],
  ],
  missing_authorization_code: [
    "Tesla did not provide a sign-in authorization code.",
    ["Start a new sign-in from the dashboard."],
  ],
  tesla_token_exchange_failed: [
    "Tesla could not complete the authorization exchange. Any previous connection is unchanged.",
    [
      "Start a new sign-in from the dashboard. If it repeats, have the operator check the registered callback and Tesla credentials.",
    ],
  ],
  wrong_region: [
    "Tesla rejected the configured Fleet API region.",
    [
      "Have the operator verify the account's region and partner registration. No other region is probed automatically.",
    ],
  ],
  vehicle_asleep: [
    "The selected Tesla is asleep. No wake was attempted.",
    [
      "Wait until the car is naturally online or use the official Tesla app yourself, then request a reading.",
    ],
  ],
};

export function recovery(code: string, origin: string) {
  const entry = guidance[code];
  return entry
    ? { message: entry[0], next_steps: entry[1], dashboard_url: origin + "/" }
    : {};
}
