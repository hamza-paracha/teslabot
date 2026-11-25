# 001 — Keep telemetry delivery best effort

## Context

Live telemetry keeps the cached vehicle reading current without polling Tesla for every question. The product needs a recent reading, not a complete log of every signal.

## Decision

Use a bounded in-memory relay queue and send HTTP batches to the main Worker. At capacity, drop the oldest queued record to make room for the newest. The Worker applies records by source time to the account's cached observation. [PR #3](https://github.com/hamza-paracha/teslabot/pull/3) shipped batch-ID redelivery: the relay keeps the same ID on retry, and the Worker records it with each account's updates so accounts that already committed can be skipped.

## Alternatives rejected

A durable queue or disk spool would let the relay resume forwarding queued records after a restart. It would also require retention, replay, and access controls for sensitive raw telemetry, without recovering records lost before they reached the buffer.

## Consequences

Queued and in-flight records can disappear at restart. The Worker returns HTTP 503 after a partial write so the relay retries the batch. A lost response can also trigger redelivery after a successful write. Batch IDs and field clocks limit duplicate effects; they do not make delivery exactly once. A missing update leaves the earlier reading and its timestamp in place.

## Evidence

- [Relay queue overflow test](https://github.com/hamza-paracha/teslabot/blob/e00598b10c793e2151cca985eb2ecd71bc6efdd9/telemetry/container/test_relay.py#L141) checks that the oldest record is dropped.
- [Relay HTTP retry test](https://github.com/hamza-paracha/teslabot/blob/e00598b10c793e2151cca985eb2ecd71bc6efdd9/telemetry/container/test_relay.py#L96) checks that the same ID and body are sent on retry.
- [Partial-commit ingest test](https://github.com/hamza-paracha/teslabot/blob/e00598b10c793e2151cca985eb2ecd71bc6efdd9/tests/telemetry.test.ts#L438) checks that only the successful write is counted after a failure, that redelivery recovers the failed account, and that the healthy account's reading and history are unchanged.
- [Telemetry replay test](https://github.com/hamza-paracha/teslabot/blob/e00598b10c793e2151cca985eb2ecd71bc6efdd9/tests/telemetry-replay.test.ts#L5) checks the stored reading through late, repeated, and omitted records. It models loss; it does not restart the relay.

## Revisit when

An agreed freshness target cannot tolerate measured relay loss, or a feature needs an auditable, replayable record of every event.
