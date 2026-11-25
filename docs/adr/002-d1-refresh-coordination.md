# 002 — Coordinate vehicle refresh and request budgets in D1

## Context

An assistant can send several requests for different sections of the same car at once. If each cold read calls Tesla, it adds latency and spends the request budget on redundant work.

## Decision

Serve fresh cache hits without a lock. For refreshes, use an account-scoped D1 lease. Waiters recheck the cache and can share a refresh failure recorded after their read began. Separately, reserve each outgoing Fleet API request in one conditional D1 statement against the per-account daily count and installation-wide monthly estimated spend.

## Alternatives rejected

An in-memory mutex does not coordinate separate Worker isolates. A per-account Durable Object could serialize refreshes, but adds another service boundary while the shared spending guard still needs coordination. Fenced writes would protect against an expired holder, but the current design relies on the lease window rather than implementing that stronger guarantee.

## Consequences

The lease expires after 120 seconds. Vehicle refresh waits up to a 30-second retry budget for acquisition; neither timer cancels an old holder. The owner check protects release, not writes: if the old holder runs beyond expiry, a new holder can acquire the lease and the old holder could still write. Budget reservations are kept on failure and cap local attempts and estimated spend, not the Tesla invoice.

## Evidence

- [Parallel cold reads test](https://github.com/hamza-paracha/teslabot/blob/e00598b10c793e2151cca985eb2ecd71bc6efdd9/tests/performance.test.ts#L31) checks that the burst uses one `vehicle_data` request.
- [Concurrent budget test](https://github.com/hamza-paracha/teslabot/blob/e00598b10c793e2151cca985eb2ecd71bc6efdd9/tests/performance.test.ts#L126) gives four parallel requests a daily budget of two and checks that two are rejected. These tests do not prove safety after lease expiry.

## Revisit when

Refreshes approach the lease lifetime, a stale holder is observed writing after expiry, or lock waits make the read latency unacceptable.
