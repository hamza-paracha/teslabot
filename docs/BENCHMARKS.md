# Benchmarks

`npm run bench` measures how vehicle reads behave under concurrency: how many Tesla requests a burst of parallel reads causes, and how long callers wait. The command needs no credentials and makes no network requests.

```sh
npm run bench
npm run bench -- --rounds 50 --concurrency 1,10,50 --upstream-ms 250
npm run bench -- --json --out bench.json
```

## What runs

Each burst fires _c_ parallel section reads (`/api/vehicle/battery`, `climate`, `charging`, `tires`, `closures`) through the real routes, vehicle cache, D1 leases and request budget. Reads go in-process, as hosted `/mcp` tool calls do, so the per-minute HTTP rate limit is not part of the measurement. Storage is a local Miniflare D1. Tesla is a synthetic upstream that adds a fixed latency to every request (100 ms by default).

| Workload | Before each burst                                        |
| -------- | -------------------------------------------------------- |
| cold     | Cache empty; the car is online                           |
| warm     | Cache holds a fresh reading                              |
| mixed    | Cold for 1 burst in 5, warm otherwise                    |
| asleep   | The car is asleep; the cache holds a reading an hour old |

Every workload runs three unmeasured bursts first, then 20 measured bursts. Latency is from the start of a burst to each response. The report also includes the command, commit, Node.js, OS, CPU and Miniflare versions.

The command exits non-zero if any of these fail:

- every read returns 200;
- each cold burst makes exactly one `vehicle_data` request;
- warm bursts make no Tesla requests;
- each sleeping-car burst makes exactly one vehicle-state request and no `vehicle_data`, wake or command requests;
- parallel callers against a small daily budget get exactly that many Tesla requests, and the rest get `local_usage_limit`.

## Example run

**Synthetic.** Local D1 and a synthetic Tesla with 100 ms of latency, on an Apple M4 (10 cores), macOS, Node.js 22.22.0, Miniflare 5.20261012.1-beta. These are not production measurements. Cloudflare D1, Tesla's real latency and isolate placement will all differ.

| Concurrency | Workload | Reads | Tesla requests | vehicle_data | p50 ms | p95 ms |
| ----------: | -------- | ----: | -------------: | -----------: | -----: | -----: |
|           1 | cold     |    20 |             40 |           20 |  254.4 |  259.8 |
|           1 | warm     |    20 |              0 |            0 |    2.2 |    2.9 |
|           1 | asleep   |    20 |             20 |            0 |  130.8 |  137.4 |
|          10 | cold     |   200 |             40 |           20 |  406.2 |  420.1 |
|          10 | warm     |   200 |              0 |            0 |   12.1 |   15.9 |
|          10 | mixed    |   200 |              8 |            4 |   14.5 |  395.2 |
|          10 | asleep   |   200 |             20 |            0 |  408.6 |  423.4 |
|          25 | cold     |   500 |             40 |           20 |  483.1 |  525.8 |
|          25 | warm     |   500 |              0 |            0 |   28.0 |   47.9 |
|          25 | asleep   |   500 |             20 |            0 |  500.6 |  542.6 |

A cold burst costs two Tesla requests (vehicle state, then `vehicle_data`) however many callers share it. A sleeping car costs one vehicle-state request per burst and is never woken. Parallel waiters return 100 to 200 ms after the refresh itself (about 255 ms here), because they re-check the cache on a 100, 200, 400 ms polling schedule. Budget check: 8 parallel callers with a daily budget of 3 got 3 successes, 5 `local_usage_limit` rejections and 3 Tesla requests.

## What the benchmark found

The first runs found two problems in the shared-refresh path, now fixed and covered by `tests/performance.test.ts`:

- Waiters behind a cold refresh had to acquire the vehicle lease one at a time just to read the result, with backoff growing to one second. At concurrency 10, cold p95 was 7,833 ms.
- A refresh that failed because the car was asleep stored nothing, so each waiter then made its own Tesla request in turn. At concurrency 10, ten bursts made 100 Tesla requests, with p95 7,949 ms. At concurrency 25 the run did not finish.

`npm run bench -- --rounds 10 --concurrency 5,10` on the same machine, before and after the fix. A 10-round run is noisy: the sleeping-car p95 at concurrency 10 was 423 ms in the 20-round run above.

| Concurrency | Workload | Tesla requests (before → after) | p95 ms (before → after) |
| ----------: | -------- | ------------------------------: | ----------------------: |
|           5 | cold     |                         20 → 20 |             2,656 → 396 |
|           5 | asleep   |                         50 → 10 |             2,777 → 406 |
|          10 | cold     |                         20 → 20 |             7,833 → 472 |
|          10 | asleep   |                        100 → 10 |             7,949 → 740 |
