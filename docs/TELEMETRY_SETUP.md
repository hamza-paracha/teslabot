# Live data with Fleet Telemetry

Instead of teslabot polling `vehicle_data`, each car streams changes to a server you host. Answers stay current while the car is awake. A sleeping car is never woken. Tesla bills streamed signals at a fraction of the cost of data requests.

## How it fits together

```text
Car --mTLS WebSocket--> Spectrum (TCP passthrough) --> telemetry Worker connect()
    --> Durable Object --> Container: Tesla fleet-telemetry --ZMQ--> relay --HTTPS--> main Worker /telemetry/ingest
Main Worker --service binding--> telemetry Worker /configure --> relay --> Tesla vehicle-command proxy (signs) --> Fleet API
```

- TLS, including the car's client certificate, terminates inside the container in Tesla's own `fleet-telemetry` server. Cloudflare passes the bytes through without inspecting them.
- The relay forwards decoded records, in batches, to the main Worker. The main Worker maps each VIN to the account that turned telemetry on and updates that account's cached reading. Records for unknown cars are dropped.
- The Worker replies with HTTP 503 if an account's write fails; `applied` counts only committed vehicle-data records. The relay sends one batch at a time and retries the same batch ID after a network error, 429 or a server error, backing off from 1 to 60 seconds. Each account remembers its latest batch ID in the same write as its updates, so on retry the Worker skips accounts that already committed. Other 4xx responses are logged and counted as dropped records.
- Records can arrive late, out of order or twice: the car buffers readings while it has no connection. The main Worker remembers the source time (`createdAt`) of every stored value it has applied, and of the Fleet API read underneath, and keeps only newer values. If two records conflict at the same time, the first value already stored wins; another field at that time can still apply. Signals that write the same value share one clock: rated and estimated range both set the range, and AC and DC power both set charging power. Within one record, positive DC power takes precedence over AC, and idle DC does not mask AC. Across records, a newer zero-power reading still counts. The most recent connectivity event sets the relay's connection state. The cached vehicle reads as online after a connection or a reading newer than the last disconnect; a disconnect beats a reading at the same instant.
- Records without a usable `createdAt` (missing, or more than a minute in the future) cannot be ordered, and arrival time is not used in place of it because a retry would then look new. Such a record only fills a value nothing has set yet. It never replaces a known value, and it does not make its section count as fresh. A repeated undated record is ignored. The car normally sends `createdAt` on every record.
- Delivery is not guaranteed. The relay keeps queued records in memory, drops the oldest when 5,000 are queued, and `fleet-telemetry` runs with `reliable_ack` off, so records queued when the container restarts are lost. Lost values stay at their last reading, with its timestamp, until the car sends them again; a stale section still falls back to a normal Fleet API read.
- Vehicle configurations must be signed with the partner application's private key. Tesla's `tesla-http-proxy` does this inside the container. The relay exposes exactly one call, `fleet_telemetry_config` create, and only to the Durable Object with `RELAY_TOKEN`.

Code: `telemetry/src/index.ts` (Worker and Durable Object), `telemetry/container/` (Dockerfile and `relay.py`), `src/routes/telemetry.ts` and `src/telemetry/mapping.ts` (main Worker).

## Requirements

- A Cloudflare zone with **Spectrum** applications that can use a Worker as the origin (inbound TCP to Workers is in beta; Pro and Business plans have limited application counts).
- **Docker** on the machine that deploys, to build the container image.
- Partner registration done, and the public key hosted (`npm run keys`, `npm run partner`). Each driver must add the virtual key to their car in the Tesla app; the dashboard links to `https://tesla.com/_ak/<your domain>`.
- Firmware 2024.26 or later.

## Setup

1. **Hostname and certificates.** Choose a hostname such as `telemetry.your-domain.tld`, then run:

   ```sh
   scripts/generate-telemetry-certs.sh telemetry.your-domain.tld
   ```

   This creates a private CA and a server certificate in `secrets/telemetry/`. Keep `ca.key` offline.

2. **Credentials.** Generate two random tokens of at least 32 characters, for example with `openssl rand -hex 32`: an ingest token (relay to main Worker) and a relay token (main Worker to telemetry Worker).

3. **Telemetry Worker.** Copy `telemetry/wrangler.example.jsonc` to `telemetry/wrangler.jsonc` and set `INGEST_URL` to `https://<main domain>/telemetry/ingest`. Then set its secrets:

   ```sh
   cd telemetry
   npx wrangler secret put TLS_CERT --config wrangler.jsonc          # secrets/telemetry/server-chain.pem
   npx wrangler secret put TLS_KEY --config wrangler.jsonc           # secrets/telemetry/server.key
   npx wrangler secret put FLEET_PRIVATE_KEY --config wrangler.jsonc # secrets/private-key.pem
   npx wrangler secret put INGEST_TOKEN --config wrangler.jsonc
   npx wrangler secret put RELAY_TOKEN --config wrangler.jsonc
   npx wrangler deploy --config wrangler.jsonc
   ```

4. **Spectrum.** Create a Spectrum TCP application for the telemetry hostname on port 443. Choose the telemetry Worker as the origin and turn Edge TLS Termination **off**, which is passthrough. If Cloudflare terminated TLS, the car's certificate check would fail.

5. **Main Worker.** In `wrangler.jsonc`, add the service binding and variables shown, commented out, in `wrangler.example.jsonc`. Then set its secrets: `TELEMETRY_INGEST_TOKEN` (the ingest token), `TELEMETRY_RELAY_TOKEN` (the relay token) and `TELEMETRY_CA` (the contents of `secrets/telemetry/ca.pem`). Deploy.

6. **Turn it on per car.** In the dashboard, each driver opens **Live data**, adds the virtual key, then clicks **Turn on live data**. The car adopts the configuration the next time it connects. **Check with Tesla** shows whether it has synced and lists any reported errors. **Turn off** removes the configuration from the car.

Configurations expire after 90 days; turn live data on again to renew. One VIN can stream to only one teslabot account.

## What is streamed

`src/telemetry/mapping.ts` lists the signals. Most are sent at most once a minute and only when they change:

- battery and range, charge state, charging power, charge limit and time to full;
- lock, doors, trunks and windows, sentry mode;
- cabin and outside temperature;
- odometer, tire pressures and warnings, software version and name.

Location is included only when `ENABLE_LOCATION` is on.

Values arrive only on change. A section that has not changed recently can therefore be older than five minutes, and then a normal read refreshes it if the car is awake. Each response's `data.source` says whether it came from `tesla_fleet_telemetry` or `tesla_fleet_api`.

## Running the container elsewhere

The image in `telemetry/container/` also runs on any host with a public IP:

```sh
docker build -t teslabot-telemetry telemetry/container
docker run -p 443:4443 -p 127.0.0.1:8080:8080 \
  -e TLS_CERT -e TLS_KEY -e FLEET_PRIVATE_KEY -e INGEST_URL -e INGEST_TOKEN -e RELAY_TOKEN \
  teslabot-telemetry
```

The main Worker's `/configure` calls then need a route to port 8080 that only the Worker can reach, for example a Cloudflare Tunnel protected by Access.

## Testing

- `npm test` covers the field mapping, ingest ordering, enable/disable and the telemetry Worker's authentication.
- `npm run telemetry:replay` replays a synthetic drive ([fixture](../tests/fixtures/telemetry-drive.json)) through `/telemetry/ingest` and the cron alert runner for two accounts. It distinguishes a queued record that never arrives from a response lost after the Worker commits. The relay retry reuses the same batch ID. The fixture also redelivers that batch after newer data to check that source-time ordering still prevents a rollback or a second reminder. `npm test` delivers the same records forward, in reverse and interleaved, in different batch sizes with duplicates, and checks the cached readings, source times, connectivity, reminders and zero Tesla requests. Separate tests cover equal-time conflicts and disconnects.
- `python3 -m unittest telemetry/container/test_relay.py` needs `pyzmq` and `openssl`. It covers ZMQ-to-ingest forwarding, retries and the pinned-TLS proxy call.
- The container image itself is built only at deploy time, with Docker.
