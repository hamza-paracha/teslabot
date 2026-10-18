# OAuth operations

1. Deploy and verify the public key, complete Tesla registration, enter credentials through the local hidden-input setup script, upload secrets after approval.
2. Register the partner using `npm run partner`, with EVINTELLIGENCE_URL and EVINTELLIGENCE_ADMIN_TOKEN securely provided in the local environment. The script calls the protected Worker; credentials/token generation remain server-side.
3. Open https://tesla.example.com and authenticate using the local administrator credential. Click Connect Tesla Account. Sign into the VEHICLE account in Tesla's official page, which may differ from the developer account. Do not share the Tesla password with this application.
4. Approve requested read-only scopes. The callback must match exactly. A denial, missing code, expired/replayed state or wrong browser fails closed. Start again from the dashboard if the transaction expires.
5. Click Load vehicles, inspect the display names/states and explicitly select the correct vehicle. No automatic selection occurs, even if there is one vehicle. Click Refresh Vehicle Data only when desired. An asleep vehicle is not woken; wait until naturally awake or use the official Tesla app yourself.
6. Disconnect deletes local owner tokens, selection, caches, OAuth transactions and sessions. Also revoke EVIntelligence in Tesla account third-party app management to invalidate the grant at Tesla. Local deletion alone does not invalidate previously issued Tesla tokens.

Tokens rotate server-side and remain encrypted; no access/refresh token is returned to a browser or MCP client. If scope, password or consent changes invalidate authorization, disconnect and reconnect. D1 persists across deployments with the same binding; never casually replace its encryption secret.
