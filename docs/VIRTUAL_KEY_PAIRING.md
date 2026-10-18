# Virtual-key pairing — future phase, NOT authorized or performed

Read-only Fleet API calls do not install a vehicle key. No pairing link is automatically opened by this service, and commands remain disabled.

Before pairing, obtain explicit user approval for Phase G. Confirm partner registration, hosted key continuity, Tesla app version, vehicle model/firmware and trusted-user vehicle access. Request only the scopes needed for the proposed feature; Tesla's guide permits the pairing flow with vehicle_device_data, vehicle_cmds or vehicle_location. Adding vehicle commands requires deliberate scope consent separately.

The official deep link for this domain is https://tesla.com/_ak/tesla.example.com . Open on the phone with the official Tesla app installed and the intended vehicle selected. Review the displayed domain and follow Tesla's trusted-user prompts. An optional VIN query is supported, but this service does not publish a VIN-bearing link. OAuth approval alone does not establish pairing.

Verify with the documented fleet_status endpoint and the current returned key/compatibility information before sending any future signed command. This release displays pairing as unverified rather than inferring success from OAuth. Troubleshoot incorrect domain, missing partner registration, unavailable/mismatched PEM, app/firmware compatibility, account access and the 20-key maximum. Do not regenerate keys to troubleshoot without a rotation plan.

Revoke through the vehicle Locks screen by deleting the app key, and revoke app authorization in the Tesla account as appropriate. Back up secrets/private-key.pem encrypted offline and restrict access; losing it means pairing a replacement key through trusted-user approval. Rotation requires coordinated key hosting, partner registration, vehicle removal/re-pairing and rollback planning.

Sources: [virtual keys](https://developer.tesla.com/docs/fleet-api/virtual-keys/developer-guide), [vehicle endpoints](https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-endpoints), [commands](https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-commands).
