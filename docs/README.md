# Documentation

Start with the [project README](../README.md) for use cases and the tool list.

## Setup

1. [Cloudflare setup](CLOUDFLARE_SETUP.md) — Worker, domain, storage and secrets.
2. [Tesla registration](TESLA_REGISTRATION.md) — application fields and scopes.
3. [Account connection](OAUTH_SETUP.md) — sign in, select a car and reconnect safely.
4. [ChatGPT](CHATGPT_SETUP.md) or [local MCP clients](MCP_SETUP.md) — connect your agent.
5. [Proactive workflow](PROACTIVE_PLUGIN.md) — calendar context, quiet hours and opt-in delivery.
6. [Invite-only accounts](INVITES.md) — inviting drivers, assistant credentials and limits.
7. [Live data](TELEMETRY_SETUP.md) — Fleet Telemetry on Cloudflare Containers.

## Development and operation

- [Architecture](ARCHITECTURE.md) — source layout, storage and request flow.
- [Decision records](adr/README.md) — tradeoffs and when to revisit them.
- [10-minute code walkthrough](WALKTHROUGH.md) — trace one trip estimate and its telemetry input.
- [HTTP API](HTTP_API.md) — protected routes and response behavior.
- [Verification](VERIFICATION.md) — tests, the no-Tesla demo, smoke checks and deployment acceptance checklist.
- [Benchmarks](BENCHMARKS.md) — concurrency workload, method and an example synthetic run.
- [Troubleshooting](TROUBLESHOOTING.md) — error codes and recovery steps.
- [Security](SECURITY.md) — threat model, credentials and operational boundaries.

## References

- [API research](API_RESEARCH.md) — official Tesla and Cloudflare references.
- [Open-source research](OPEN_SOURCE_RESEARCH.md) — compared projects and independently implemented ideas.
- [Project goals](../goal.md) — design principles.
- [Virtual-key pairing](VIRTUAL_KEY_PAIRING.md) — key handling and authorization requirements.
