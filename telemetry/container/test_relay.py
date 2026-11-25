"""Tests for relay.py: python3 -m unittest telemetry/container/test_relay.py
Requires pyzmq and openssl (both are in the container image)."""

import json
import os
import ssl
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
import relay  # noqa: E402


class Capture(BaseHTTPRequestHandler):
    responses = []
    received = []

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        type(self).received.append((self.path, dict(self.headers), json.loads(body)))
        status = type(self).responses.pop(0) if type(self).responses else 200
        payload = json.dumps({"response": {"updated_vehicles": 1}}).encode()
        self.send_response(status)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_):
        pass


def serve(handler, context=None):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    if context:
        server.socket = context.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def wait_for(condition, timeout=8):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if condition():
            return True
        time.sleep(0.05)
    return False


class ForwarderTest(unittest.TestCase):
    def setUp(self):
        Capture.received, Capture.responses = [], []
        self.ingest = serve(type("Ingest", (Capture,), {"received": [], "responses": []}))
        self.handler = self.ingest.RequestHandlerClass
        self.url = f"http://127.0.0.1:{self.ingest.server_address[1]}/telemetry/ingest"
        self.stop = threading.Event()

    def tearDown(self):
        self.stop.set()
        self.ingest.shutdown()
        self.ingest.server_close()

    def test_zmq_records_reach_ingest_in_a_batch(self):
        import zmq

        publisher = zmq.Context.instance().socket(zmq.PUB)
        port = publisher.bind_to_random_port("tcp://127.0.0.1")
        forwarder = relay.Forwarder(self.url, "ingest-secret")
        threading.Thread(target=forwarder.run, args=(self.stop,), daemon=True).start()
        threading.Thread(
            target=relay.subscribe,
            args=(forwarder, self.stop, f"tcp://127.0.0.1:{port}"),
            daemon=True,
        ).start()
        record = {"vin": "5YJ3E1EA7KF000001", "data": [{"key": "BatteryLevel", "value": {"doubleValue": 70}}]}
        # A PUB socket drops messages until the subscriber has connected.
        self.assertTrue(
            wait_for(
                lambda: publisher.send_multipart([b"tesla_V", json.dumps(record).encode()]) is None
                and len(self.handler.received) > 0
            )
        )
        path, headers, body = self.handler.received[0]
        self.assertEqual(path, "/telemetry/ingest")
        self.assertEqual(headers["Authorization"], "Bearer ingest-secret")
        self.assertEqual(body["records"][0], {"topic": "tesla_V", "payload": record})
        publisher.close(0)

    def test_retries_server_errors_and_drops_rejected_batches(self):
        self.handler.responses = [503, 200, 400]
        forwarder = relay.Forwarder(self.url, "t")
        relay_delay = []
        original_wait = self.stop.wait
        self.stop.wait = lambda seconds: relay_delay.append(seconds) or original_wait(0.01)
        threading.Thread(target=forwarder.run, args=(self.stop,), daemon=True).start()
        forwarder.add("tesla_V", b'{"vin": "A"}')
        self.assertTrue(wait_for(lambda: len(self.handler.received) == 2))
        self.assertEqual(relay_delay[:1], [1.0])
        first_id = self.handler.received[0][1]["Idempotency-Key"]
        self.assertEqual(uuid.UUID(first_id).version, 4)
        self.assertEqual(self.handler.received[1][1]["Idempotency-Key"], first_id)
        self.assertEqual(self.handler.received[0][2], self.handler.received[1][2])
        forwarder.add("tesla_V", b'{"vin": "B"}')
        self.assertTrue(wait_for(lambda: len(self.handler.received) == 3))
        self.assertTrue(wait_for(lambda: forwarder.dropped == 1))
        self.assertNotEqual(self.handler.received[2][1]["Idempotency-Key"], first_id)
        time.sleep(0.2)
        self.assertEqual(len(self.handler.received), 3)

    def test_retries_network_failures_and_rate_limits_with_capped_backoff(self):
        attempts, delays = [], []

        def opener(request, timeout):
            attempts.append(request)
            if len(attempts) == 1:
                raise urllib.error.HTTPError(self.url, 429, "rate limited", {}, None)
            raise urllib.error.URLError("connection failed")

        def wait(seconds):
            delays.append(seconds)
            if len(delays) == 8:
                self.stop.set()

        forwarder = relay.Forwarder(self.url, "t", opener=opener)
        forwarder.add("tesla_V", b'{"vin": "A"}')
        self.stop.wait = wait
        with patch.object(relay, "BATCH_SIZE", 1):
            forwarder.run(self.stop)
        self.assertEqual(delays, [1, 2, 4, 8, 16, 32, 60, 60])
        self.assertEqual(len({request.get_header("Idempotency-key") for request in attempts}), 1)
        self.assertEqual(len({request.data for request in attempts}), 1)
        self.assertEqual(forwarder.dropped, 0)

    def test_ignores_malformed_records_and_drops_oldest_when_full(self):
        forwarder = relay.Forwarder(self.url, "t")
        forwarder.add("tesla_V", b"not json")
        forwarder.add("tesla_V", b"[1, 2]")
        self.assertEqual(forwarder.records.qsize(), 0)
        original = relay.QUEUE_LIMIT
        forwarder.records = relay.queue.Queue(maxsize=2)
        for vin in ("A", "B", "C"):
            forwarder.add("tesla_V", json.dumps({"vin": vin}).encode())
        self.assertEqual(forwarder.dropped, 1)
        self.assertEqual(forwarder.records.get_nowait()["payload"]["vin"], "B")
        relay.QUEUE_LIMIT = original


class ConfigureTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp()
        env = {"TLS_CERT": "cert", "TLS_KEY": "key", "FLEET_PRIVATE_KEY": "fleet"}
        self.paths = relay.prepare(self.directory, env)
        proxy_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        proxy_context.load_cert_chain(self.paths["proxy_cert"], self.paths["proxy_key"])
        self.proxy = serve(type("Proxy", (Capture,), {"received": [], "responses": []}), proxy_context)
        client_context = ssl.create_default_context(cafile=self.paths["proxy_cert"])
        self.server = serve(
            relay.relay_handler(
                "relay-secret",
                f"https://127.0.0.1:{self.proxy.server_address[1]}",
                client_context,
            )
        )
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        for server in (self.server, self.proxy):
            server.shutdown()
            server.server_close()

    def post(self, path, body, token="relay-secret", tesla="Bearer tesla-token"):
        request = urllib.request.Request(
            self.base + path,
            data=json.dumps(body).encode(),
            headers={"Authorization": "Bearer " + token, "X-Tesla-Authorization": tesla, "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def test_writes_private_files_and_a_valid_server_config(self):
        for name in ("server_cert", "server_key", "fleet_key", "proxy_key", "telemetry_config"):
            self.assertEqual(os.stat(self.paths[name]).st_mode & 0o077, 0, name)
        config = json.load(open(self.paths["telemetry_config"]))
        self.assertTrue(config["transmit_decoded_records"])
        self.assertEqual(config["records"]["V"], ["zmq"])
        self.assertEqual(config["port"], relay.TELEMETRY_PORT)

    def test_forwards_only_the_config_call_with_the_driver_token(self):
        body = {"vins": ["5YJ3E1EA7KF000001"], "config": {"hostname": "t.example.com"}}
        self.assertEqual(self.post("/configure", body), (200, {"response": {"updated_vehicles": 1}}))
        path, headers, forwarded = self.proxy.RequestHandlerClass.received[0]
        self.assertEqual(path, "/api/1/vehicles/fleet_telemetry_config")
        self.assertEqual(headers["Authorization"], "Bearer tesla-token")
        self.assertEqual(forwarded, body)
        self.assertEqual(self.post("/configure", body, token="wrong")[0], 401)
        self.assertEqual(self.post("/command/unlock", body)[0], 404)
        self.assertEqual(self.post("/configure", {"vins": "x"})[0], 400)
        self.assertEqual(self.post("/configure", body, tesla="")[0], 400)
        self.assertEqual(len(self.proxy.RequestHandlerClass.received), 1)


if __name__ == "__main__":
    unittest.main()
