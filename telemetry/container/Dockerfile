# Tesla's fleet-telemetry server, Tesla's vehicle-command proxy (only to sign
# fleet_telemetry_config) and teslabot's relay, in one container.
FROM tesla/fleet-telemetry:v0.10.0 AS telemetry

FROM golang:1.25-bookworm AS proxy
RUN CGO_ENABLED=0 go install github.com/teslamotors/vehicle-command/cmd/tesla-http-proxy@v0.4.1

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-zmq openssl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --home-dir /nonexistent teslabot
COPY --from=telemetry /fleet-telemetry /usr/local/bin/fleet-telemetry
COPY --from=proxy /go/bin/tesla-http-proxy /usr/local/bin/tesla-http-proxy
COPY relay.py /app/relay.py
USER teslabot
# 4443: vehicles (mutual TLS, via Spectrum and the Worker). 8080: the Durable
# Object's /configure calls. The proxy and ZMQ stay on 127.0.0.1.
EXPOSE 4443 8080
ENTRYPOINT ["/usr/bin/tini", "--", "python3", "/app/relay.py"]
