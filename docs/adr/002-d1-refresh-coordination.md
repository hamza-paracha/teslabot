# 002 — Coordinate vehicle refresh and request budgets in D1

## Context

An assistant can send several requests for different sections of the same car at once. If each cold read calls Tesla, it adds latency and spends the request budget on redundant work.

## Decision

Serve fresh cache hits without a lock. For refreshes, use an account-scoped D1 lease. Waiters recheck the cache and can share a refresh failure recorded after their read began. `Store.putMany` checks ownership of every lease held by that Store in the same D1 batch as the writes, including any extra statements. Separately, reserve each outgoing Fleet API request in one conditional D1 statement against the per-account daily count and installation-wide monthly estimated spend.

## Alternatives rejected

An in-memory mutex does not coordinate separate Worker isolates. A per-account Durable Object could serialize refreshes, but adds another service boundary while the shared spending guard still needs coordination. Checking ownership only at release would leave an old holder free to overwrite the new holder's data.

## Consequences

After 120 seconds another caller can take over the lease; the old caller can still write if it remains the owner. When any lease held by that Store is lost, a fenced write rolls back with `lease_lost` (HTTP 409), even if the next holder has already released it. Release also checks ownership. Vehicle refresh has a 30-second acquisition retry budget; neither timer cancels work already started or prevents overlapping Tesla requests after takeover. A rotated Tesla refresh token is saved with a separate Store holding only the account lease, so losing the vehicle lease does not discard it. Budget reservations are kept on failure and cap local attempts and estimated spend, not the Tesla invoice.

## Evidence

- [Parallel cold reads test](https://github.com/hamza-paracha/teslabot/blob/2835d00ecfd08df826068da9a23baa13e9447314/tests/performance.test.ts#L31) checks that the burst uses one `vehicle_data` request.
- [Concurrent budget test](https://github.com/hamza-paracha/teslabot/blob/2835d00ecfd08df826068da9a23baa13e9447314/tests/performance.test.ts#L126) gives four parallel requests a daily budget of two and checks that two are rejected.
- The lease tests cover [takeover and owner-checked release](https://github.com/hamza-paracha/teslabot/blob/2835d00ecfd08df826068da9a23baa13e9447314/tests/lease.test.ts#L19), [writes after the successor releases](https://github.com/hamza-paracha/teslabot/blob/2835d00ecfd08df826068da9a23baa13e9447314/tests/lease.test.ts#L50), [loss of the outer lease under nested locks](https://github.com/hamza-paracha/teslabot/blob/2835d00ecfd08df826068da9a23baa13e9447314/tests/lease.test.ts#L64), [rotated token persistence](https://github.com/hamza-paracha/teslabot/blob/2835d00ecfd08df826068da9a23baa13e9447314/tests/lease.test.ts#L84), and [expiry without takeover](https://github.com/hamza-paracha/teslabot/blob/2835d00ecfd08df826068da9a23baa13e9447314/tests/lease.test.ts#L113).

## Revisit when

Refreshes often run past the lease lifetime, takeovers waste too many upstream calls, or lock waits make read latency unacceptable.
