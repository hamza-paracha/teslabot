# Design principles

- Use Tesla's official Fleet API and OAuth.
- Keep account credentials, vehicle identifiers and location data private.
- Keep tokens and keys out of the model and MCP client.
- Use limited permissions and read-only vehicle access.
- Preserve observation timestamps and distinguish fresh data from cached data.
- Explain assumptions, unavailable fields and potential API charges.
- Never fabricate vehicle data or present fixtures as live readings.
- Let the host manage authorized calendar, weather, route and notification services.
- Keep each connection explicit and revocable.
