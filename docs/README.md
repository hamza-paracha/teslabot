# Documentation

Start with the [project README](../README.md) for use cases and the tool list.

## Setup

1. [Cloudflare setup](CLOUDFLARE_SETUP.md) — Worker, domain, storage and secrets.
2. [Tesla registration](TESLA_REGISTRATION.md) — application fields and scopes.
3. [Account connection](OAUTH_SETUP.md) — sign in, select a car and reconnect safely.
4. [ChatGPT](CHATGPT_SETUP.md) or [local MCP clients](MCP_SETUP.md) — connect your agent.
5. [Proactive workflow](PROACTIVE_PLUGIN.md) — calendar context, quiet hours and opt-in delivery.

## Development and operation

- [Architecture](ARCHITECTURE.md) — source layout, storage and request flow.
- [HTTP API](HTTP_API.md) — protected routes and response behavior.
- [Verification](VERIFICATION.md) — tests, smoke checks and remaining live acceptance checks.
- [Troubleshooting](TROUBLESHOOTING.md) — error codes and recovery steps.
- [Security](SECURITY.md) — threat model, credentials and operational boundaries.

## Research and future work

- [API research](API_RESEARCH.md) — official Tesla and Cloudflare references.
- [Open-source research](OPEN_SOURCE_RESEARCH.md) — compared projects and independently implemented ideas.
- [Project goals](../goal.md) — roadmap and current progress.
- [Virtual-key pairing](VIRTUAL_KEY_PAIRING.md) — future command phase; not enabled by setup.
