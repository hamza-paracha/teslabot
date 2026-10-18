# Tesla application registration — exact proposed values

Replace every example hostname below with your actual deployed HTTPS hostname. These are reusable registration values, not credentials or an existing application registration.

| Field                   | Value                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application Name        | teslabot (Tesla may require a unique name)                                                                                                                        |
| Application Description | Personal, read-only Tesla vehicle dashboard and AI assistant integration using the official Tesla Fleet API.                                                      |
| Purpose of Usage        | Access my authorized personal Tesla's battery, charging, climate and vehicle status through a secure private service. No vehicle commands in the initial release. |
| OAuth Grant Type        | Authorization Code and Machine-to-Machine                                                                                                                         |
| Allowed Origin URL      | https://tesla.example.com                                                                                                                                         |
| Allowed Redirect URI    | https://tesla.example.com/auth/callback                                                                                                                           |
| Allowed Returned URLs   | Leave blank; this implementation does not use a returned-URL flow.                                                                                                |
| API access              | Fleet API                                                                                                                                                         |
| OAuth scopes            | openid offline_access vehicle_device_data                                                                                                                         |
| Optional location scope | vehicle_location — add only when enabling location                                                                                                                |

Tesla's authentication supports both authorization_code (vehicle-owning account) and client_credentials (partner registration) flows. Choose the registration type appropriate for your application and use accurate registration details.

Do not enable user_data, vehicle_cmds, vehicle_charging_cmds, energy, specs or pricing scopes for this read-only initial release. Current battery charging status comes from vehicle data; historical billing/charging sessions are outside scope.

Developer Account A owns credentials. Vehicle Account B signs into Tesla during `/auth/login`; these accounts may differ. No password is entered in this service.

After credentials are issued, use `python3 scripts/configure-secrets.py --tesla` locally. This prompts invisibly and stores them in ignored `.dev.vars` with mode 0600. Upload only after deployment approval using `python3 scripts/configure-secrets.py --upload`. Do not paste credentials into chat.

To add location later: grant scope in the developer portal, set ENABLE_LOCATION=true, deploy and use Reconnect Tesla Account in the dashboard. Tesla supports scope additions with prompt_missing_scopes=true; this service requests that flag. User denial preserves an existing connection. Command scopes require separate explicit Phase G approval.

Source: [Tesla onboarding](https://developer.tesla.com/docs/fleet-api/getting-started/what-is-fleet-api), [authentication](https://developer.tesla.com/docs/fleet-api/authentication/overview), [third-party tokens](https://developer.tesla.com/docs/fleet-api/authentication/third-party-tokens).

When adding origin and redirect URLs, keep only filled rows; extra empty rows can prevent continuing. If the portal resets the form after login, return to the authenticated developer dashboard and retry with a consistent locale.
