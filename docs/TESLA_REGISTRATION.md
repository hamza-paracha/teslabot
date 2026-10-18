# Tesla application registration — exact proposed values

Replace every example hostname below with your actual deployed HTTPS hostname. These are reusable registration values, not credentials or an existing application registration.

| Field                   | Value                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application Name        | EVIntelligence (Tesla may require a unique name)                                                                                                                  |
| Application Description | Personal, read-only Tesla vehicle dashboard and AI assistant integration using the official Tesla Fleet API.                                                      |
| Purpose of Usage        | Access my authorized personal Tesla's battery, charging, climate and vehicle status through a secure private service. No vehicle commands in the initial release. |
| OAuth Grant Type        | Authorization Code and Machine-to-Machine                                                                                                                         |
| Allowed Origin URL      | https://tesla.example.com                                                                                                                                         |
| Allowed Redirect URI    | https://tesla.example.com/auth/callback                                                                                                                           |
| Allowed Returned URLs   | Leave blank; this implementation does not use a returned-URL flow.                                                                                                |
| API access              | Fleet API                                                                                                                                                         |
| OAuth scopes            | openid offline_access vehicle_device_data                                                                                                                         |
| Optional location scope | vehicle_location — add only when enabling location                                                                                                                |

Tesla's official authentication docs confirm both authorization_code (vehicle-owning account) and client_credentials (partner registration) flows. The exact combined grant label above has now been confirmed in the current portal. The personal "Just for me" registration type is selected. No legal/business identity details were invented. Optional billing details remain blank; the form offers "Skip and Submit".

Do not enable user_data, vehicle_cmds, vehicle_charging_cmds, energy, specs or pricing scopes for this read-only initial release. Current battery charging status comes from vehicle data; historical billing/charging sessions are outside scope.

Developer Account A owns credentials. Vehicle Account B signs into Tesla during `/auth/login`; these accounts may differ. No password is entered in this service.

After credentials are issued, use `python3 scripts/configure-secrets.py --tesla` locally. This prompts invisibly and stores them in ignored `.dev.vars` with mode 0600. Upload only after deployment approval using `python3 scripts/configure-secrets.py --upload`. Do not paste credentials into chat.

To add location later: grant scope in the developer portal, set ENABLE_LOCATION=true, deploy, disconnect locally and reconnect through OAuth. Tesla supports scope additions with prompt_missing_scopes=true; this service requests that flag. User denial is handled without a connected session. Command scopes require separate explicit Phase G approval.

Source: [Tesla onboarding](https://developer.tesla.com/docs/fleet-api/getting-started/what-is-fleet-api), [authentication](https://developer.tesla.com/docs/fleet-api/authentication/overview), [third-party tokens](https://developer.tesla.com/docs/fleet-api/authentication/third-party-tokens).

Portal behavior verified in Safari: the + button adds a new URL row, rather than confirming the entered value. Empty additional origin/redirect rows disable Next. Keep only the filled origin and callback rows.

Registration troubleshooting observed: the first /en_CA submission redirected through the developer login callback and reset the form without creating an app. The dashboard confirmed No Applications Yet. A fresh attempt from the authenticated /en_US/dashboard completed and showed Fleet API Application Request Approved and Active. Locale/session consistency is the successful observed workaround; the underlying Tesla portal defect was not independently diagnosed.
