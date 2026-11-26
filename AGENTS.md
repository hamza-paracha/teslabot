# Agent notes

## Verify

- `npm run check`: prettier check, typecheck, vitest (Miniflare D1, mocked Tesla), `wrangler deploy --dry-run`.
- `npm run plugin:build` builds the stdio plugin into `dist/teslabot`.
- `npm run demo`, `npm run bench` and `npm run telemetry:replay` run locally with a synthetic Tesla (`scripts/lib/harness.ts`). `npm test` covers the demo and replay scenarios. `npm run bench` takes about 80 s and exits non-zero if a cache or budget invariant fails; run it after touching `currentSummary` or `Store.locked`.
- Run a real workerd check before shipping changes to `/mcp` or the cron runner. Node tests can miss runtime differences. `npm run sandbox` (about 5 s) runs the deploy bundle in workerd against the mock Tesla in `scripts/lib/mock-tesla.ts` and exits non-zero if any check fails; add `--location` for the location configuration. For a manual check, use `wrangler dev --local-protocol https --test-scheduled` with a throwaway config and `.dev.vars` outside the repo (otherwise wrangler loads the repo's `.dev.vars`). `APP_ORIGIN` must be `https://localhost:8787` because `createServer` requires an https origin. Trigger the cron with `GET /__scheduled`.
- Miniflare fails at startup with `Uncaught Error: internal error` when the script lives outside the working directory unless `modulesRoot` is set to the script's directory (`scripts/lib/sandbox.ts`).

## Gotchas

- workerd rejects `redirect: "error"` in `new Request(...)`. Outbound fetches go through `src/tesla/fetch.ts` (`platformFetch`), and in-process requests use `redirect: "manual"`.
- Vehicle reads use the vehicle lock only when refreshing from Tesla. Cache hits must stay lock-free so parallel tool calls don't fail (`tests/performance.test.ts`). Waiters re-check the cache and `refresh_failure` while polling, so a burst shares one Tesla attempt, including when the car is asleep.
- Telemetry ingest keeps only newer values per stored value (`SignalClock` in `src/telemetry/mapping.ts`, persisted in `telemetry_state.clock`). Signals that write the same field share a clock (`STORED_AS`). Undated records never use arrival time for ordering. Replay fixture: `tests/fixtures/telemetry-drive.json`.
- The MCP token may POST only to `/api/trips`, `/api/trips/outcome` and `/api/briefings` (`readerWritable` in `src/index.ts`).
- `route()` throws `AppError`; only `fetch()` turns errors into JSON. Anything calling `route()` in-process (hosted `/mcp`) must convert them with `errorResponse`, or tools lose the error code and next steps.
- The owner account (`""`) signs in with Tesla as the operator once its Tesla identity is linked (`accounts.tesla_sub_hash`). An unlinked owner is linked only when the signing-in subject matches the stored grant (`linkOwner` in `src/routes/auth.ts`).
- Disconnect, reconnect and account deletion remove the car's telemetry configuration through `removeTelemetry`, before the account's token is dropped.

## Accounts and telemetry

- Records are namespaced per account through `Store` (`acct:<id>:` prefix; the original owner is account `""` with unprefixed keys). Never write raw `DELETE FROM records` SQL; use `store.deleteKeys` / `store.deleteAll`.
- Migrations run in tests with newlines stripped, so migration SQL must not contain `--` comments.
- Relay tests: `python3 -m venv /tmp/relay-venv && /tmp/relay-venv/bin/pip install pyzmq==27.3.0 && (cd telemetry/container && /tmp/relay-venv/bin/python -m unittest test_relay.py)`.
- The telemetry Worker bundles with `wrangler deploy --dry-run --containers-rollout=none --config telemetry/wrangler.example.jsonc`; building the image needs Docker.
