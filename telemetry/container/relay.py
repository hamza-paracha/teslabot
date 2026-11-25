"""teslabot telemetry relay.

Runs Tesla's fleet-telemetry server and vehicle-command proxy, then:
  * forwards decoded records from fleet-telemetry's ZMQ publisher to the main
    Worker's /telemetry/ingest endpoint in small batches, and
  * serves POST /configure on port 8080 for the Durable Object, passing exactly
    one call (fleet_telemetry_config create) to the local signing proxy.
Secrets arrive as environment variables and are written only to a private
temporary directory.
"""

import json
import os
import queue
import signal
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ZMQ_ADDR = os.environ.get("ZMQ_ADDR", "tcp://127.0.0.1:5284")
TELEMETRY_PORT = int(os.environ.get("TELEMETRY_PORT", "4443"))
PROXY_PORT = int(os.environ.get("PROXY_PORT", "4444"))
RELAY_PORT = int(os.environ.get("RELAY_PORT", "8080"))
BATCH_SIZE = 100
BATCH_SECONDS = 2.0
QUEUE_LIMIT = 5000
CONFIG_PATH = "/api/1/vehicles/fleet_telemetry_config"
MAX_BODY = 65536


def log(event, **fields):
    print(json.dumps({"event": event, **fields}), flush=True)


def private_file(directory, name, content):
    path = os.path.join(directory, name)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(content)
    return path


def prepare(directory, env=os.environ):
    """Write certificates and configs; return paths for the child processes."""
    paths = {
        "server_cert": private_file(directory, "server.pem", env["TLS_CERT"]),
        "server_key": private_file(directory, "server.key", env["TLS_KEY"]),
        "fleet_key": private_file(directory, "fleet-key.pem", env["FLEET_PRIVATE_KEY"]),
        "proxy_cert": os.path.join(directory, "proxy.pem"),
        "proxy_key": os.path.join(directory, "proxy.key"),
    }
    # The proxy only accepts TLS; it gets a throwaway certificate for 127.0.0.1
    # that the relay pins when calling it.
    subprocess.run(
        [
            "openssl", "req", "-x509", "-nodes", "-newkey", "ec",
            "-pkeyopt", "ec_paramgen_curve:prime256v1",
            "-keyout", paths["proxy_key"], "-out", paths["proxy_cert"],
            "-days", "3650", "-subj", "/CN=127.0.0.1",
            "-addext", "subjectAltName=IP:127.0.0.1",
        ],
        check=True,
        capture_output=True,
    )
    os.chmod(paths["proxy_key"], 0o600)
    config = {
        "host": "0.0.0.0",
        "port": TELEMETRY_PORT,
        "log_level": "info",
        "json_log_enable": True,
        "namespace": "tesla",
        "reliable_ack": False,
        "transmit_decoded_records": True,
        "zmq": {"addr": ZMQ_ADDR},
        "records": {
            "V": ["zmq"],
            "connectivity": ["zmq"],
            "alerts": ["logger"],
            "errors": ["logger"],
        },
        "tls": {"server_cert": paths["server_cert"], "server_key": paths["server_key"]},
    }
    paths["telemetry_config"] = private_file(directory, "config.json", json.dumps(config))
    return paths


def children(paths):
    return [
        subprocess.Popen(
            [os.environ.get("FLEET_TELEMETRY_BIN", "fleet-telemetry"),
             "-config", paths["telemetry_config"]]
        ),
        subprocess.Popen(
            [os.environ.get("PROXY_BIN", "tesla-http-proxy"),
             "-tls-key", paths["proxy_key"], "-cert", paths["proxy_cert"],
             "-key-file", paths["fleet_key"], "-host", "127.0.0.1",
             "-port", str(PROXY_PORT)]
        ),
    ]


class Forwarder:
    """Batches records and posts them to the main Worker, retrying with backoff."""

    def __init__(self, url, token, opener=urllib.request.urlopen):
        self.url, self.token, self.opener = url, token, opener
        self.records = queue.Queue(maxsize=QUEUE_LIMIT)
        self.dropped = 0

    def add(self, topic, payload):
        try:
            record = {"topic": topic, "payload": json.loads(payload)}
        except (ValueError, UnicodeDecodeError):
            return
        if not isinstance(record["payload"], dict):
            return
        while True:
            try:
                self.records.put_nowait(record)
                return
            except queue.Full:
                # Prefer fresh data: discard the oldest record when backed up.
                try:
                    self.records.get_nowait()
                    self.dropped += 1
                except queue.Empty:
                    pass

    def post(self, batch, batch_id):
        request = urllib.request.Request(
            self.url,
            data=json.dumps({"records": batch}).encode(),
            headers={
                "Authorization": "Bearer " + self.token,
                "Content-Type": "application/json",
                "Idempotency-Key": batch_id,
            },
            method="POST",
        )
        with self.opener(request, timeout=15) as response:
            return response.status

    def run(self, stop):
        while not stop.is_set():
            batch, deadline = [], time.monotonic() + BATCH_SECONDS
            while len(batch) < BATCH_SIZE:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    batch.append(self.records.get(timeout=remaining))
                except queue.Empty:
                    break
            if not batch:
                continue
            batch_id = str(uuid.uuid4())
            delay = 1.0
            while not stop.is_set():
                try:
                    self.post(batch, batch_id)
                    break
                except urllib.error.HTTPError as error:
                    # A rejected batch will not succeed on retry; drop it.
                    if 400 <= error.code < 500 and error.code != 429:
                        self.dropped += len(batch)
                        log("ingest_rejected", status=error.code, records=len(batch))
                        break
                    log("ingest_retry", status=error.code)
                except (urllib.error.URLError, OSError) as error:
                    log("ingest_retry", error=type(error).__name__)
                stop.wait(delay)
                delay = min(delay * 2, 60)


def subscribe(forwarder, stop, address=ZMQ_ADDR):
    import zmq

    context = zmq.Context.instance()
    socket = context.socket(zmq.SUB)
    socket.setsockopt(zmq.SUBSCRIBE, b"")
    socket.setsockopt(zmq.RCVTIMEO, 1000)
    socket.connect(address)
    while not stop.is_set():
        try:
            frames = socket.recv_multipart()
        except zmq.Again:
            continue
        if len(frames) >= 2:
            forwarder.add(frames[0].decode(errors="replace"), frames[1])
    socket.close(0)


def relay_handler(relay_token, proxy_url, proxy_context):
    class Handler(BaseHTTPRequestHandler):
        def reply(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                self.reply(200, {"status": "ok"})
            else:
                self.reply(404, {"error": {"code": "not_found"}})

        def do_POST(self):
            supplied = self.headers.get("Authorization", "")
            tesla = self.headers.get("X-Tesla-Authorization", "")
            if not relay_token or not secrets_equal(supplied, "Bearer " + relay_token):
                return self.reply(401, {"error": {"code": "unauthorized"}})
            if self.path != "/configure":
                return self.reply(404, {"error": {"code": "not_found"}})
            length = int(self.headers.get("Content-Length") or 0)
            if not tesla.startswith("Bearer ") or length <= 0 or length > MAX_BODY:
                return self.reply(400, {"error": {"code": "invalid_request"}})
            body = self.rfile.read(length)
            try:
                parsed = json.loads(body)
                assert isinstance(parsed.get("vins"), list) and isinstance(parsed.get("config"), dict)
            except Exception:
                return self.reply(400, {"error": {"code": "invalid_request"}})
            request = urllib.request.Request(
                proxy_url + CONFIG_PATH,
                data=body,
                headers={"Authorization": tesla, "Content-Type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=30, context=proxy_context) as response:
                    self.reply(response.status, json.loads(response.read() or b"{}"))
            except urllib.error.HTTPError as error:
                try:
                    detail = json.loads(error.read() or b"{}")
                except ValueError:
                    detail = {}
                self.reply(error.code, {"error": {"code": "tesla_rejected"}, "response": detail.get("response")})
            except (urllib.error.URLError, OSError, ValueError):
                self.reply(502, {"error": {"code": "proxy_unavailable"}})

        def log_message(self, *_):
            pass

    return Handler


def secrets_equal(a, b):
    import hmac

    return hmac.compare_digest(a.encode(), b.encode())


def main():
    for name in ("TLS_CERT", "TLS_KEY", "FLEET_PRIVATE_KEY", "INGEST_URL", "INGEST_TOKEN", "RELAY_TOKEN"):
        if not os.environ.get(name):
            log("missing_configuration", name=name)
            sys.exit(2)
    directory = tempfile.mkdtemp(prefix="teslabot-")
    paths = prepare(directory)
    processes = children(paths)
    stop = threading.Event()
    forwarder = Forwarder(os.environ["INGEST_URL"], os.environ["INGEST_TOKEN"])
    threading.Thread(target=forwarder.run, args=(stop,), daemon=True).start()
    threading.Thread(target=subscribe, args=(forwarder, stop), daemon=True).start()
    context = ssl.create_default_context(cafile=paths["proxy_cert"])
    server = ThreadingHTTPServer(
        ("0.0.0.0", RELAY_PORT),
        relay_handler(os.environ["RELAY_TOKEN"], f"https://127.0.0.1:{PROXY_PORT}", context),
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    log("relay_started")
    # If either Tesla process exits, stop the container; the Durable Object
    # starts a fresh one on the next connection.
    while not stop.is_set():
        if any(process.poll() is not None for process in processes):
            log("child_exited", codes=[process.poll() for process in processes])
            break
        stop.wait(1)
    stop.set()
    server.shutdown()
    for process in processes:
        if process.poll() is None:
            process.terminate()
    sys.exit(1)


if __name__ == "__main__":
    main()
