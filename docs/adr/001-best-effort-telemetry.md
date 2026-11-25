# 001 — Keep telemetry delivery best effort

## Context

Live telemetry keeps the cached vehicle reading current without polling Tesla for every question. The product needs a recent reading, not a complete log of every signal.

## Decision

Keep up to 5,000 waiting records in memory, plus one in-flight batch of up to 100. When the queue fills, drop its oldest waiting record to admit the newest. The Worker applies records by source time to each account's cached observation. [PR #3](https://github.com/hamza-paracha/teslabot/pull/3) added batch-ID redelivery: the relay sends the same body and `Idempotency-Key` on retry, and the Worker saves the last batch ID with each account's updates and skips accounts whose saved ID matches.

## Alternatives rejected

A durable queue or disk spool would let the relay resume forwarding queued records after a restart. It would also require retention, replay, and access controls for sensitive raw telemetry, without recovering records lost before they reached the buffer.

## Consequences

If any account fails to commit, the Worker returns HTTP 503 and counts only committed records as applied. The relay retries the in-flight batch before draining the waiting queue, including on 5xx, network errors and 429, with backoff capped at 60 seconds. Other 4xx responses are logged and counted as drops. A slow or unavailable Worker can therefore cause queue overflow, and a restart can lose both waiting and in-flight records. A lost response can cause redelivery after a successful write. The last batch ID and source clocks limit duplicate effects; they are not an exactly-once guarantee.

## Evidence

- [Relay queue overflow test](https://github.com/hamza-paracha/teslabot/blob/2835d00ecfd08df826068da9a23baa13e9447314/telemetry/container/test_relay.py#L141) checks that the oldest record is dropped.
- [Relay HTTP retry test](https://github.com/hamza-paracha/teslabot/blob/2835d00ecfd08df826068da9a23baa13e9447314/telemetry/container/test_relay.py#L96) checks that the same ID and body are sent on retry and that rejected batches are dropped. The [backoff test](https://github.com/hamza-paracha/teslabot/blob/2835d00ecfd08df826068da9a23baa13e9447314/telemetry/container/test_relay.py#L117) covers network errors, 429 and the 60-second cap.
- [Partial-commit ingest test](https://github.com/hamza-paracha/teslabot/blob/2835d00ecfd08df826068da9a23baa13e9447314/tests/telemetry.test.ts#L567) checks that only the successful write is counted after a failure, that redelivery recovers the failed account, and that the healthy account's reading and history are unchanged.
- [Telemetry replay test](https://github.com/hamza-paracha/teslabot/blob/2835d00ecfd08df826068da9a23baa13e9447314/tests/telemetry-replay.test.ts#L11) checks the stored reading through late, repeated, and omitted records. It models loss; it does not restart the relay.

## Revisit when

An agreed freshness target cannot tolerate measured relay loss, or a feature needs an auditable, replayable record of every event.
