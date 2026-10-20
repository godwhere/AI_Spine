import importlib.util
import json
import socket
import threading
import unittest
from pathlib import Path


source = Path(__file__).resolve().parents[1] / "scripts/sub2api-gemini-egress.py"
spec = importlib.util.spec_from_file_location("gemini_egress", source)
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)


class GoogleRelayTests(unittest.TestCase):
    def start(self, connector, limit=8):
        class AuditLog(list):
            recorded = threading.Event()

            def append(self, event):
                super().append(event)
                self.recorded.set()

        events = AuditLog()
        server = relay.GoogleRelay(0, connector=connector, limit=limit, logger=events.append)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server.server_address, events

    def connect(self, address, target, method="CONNECT"):
        client = socket.create_connection(address, timeout=3)
        self.addCleanup(client.close)
        client.sendall(f"{method} {target} HTTP/1.1\r\nHost: localhost\r\n\r\n".encode())
        response = b""
        while b"\r\n\r\n" not in response:
            response += client.recv(4096)
        return client, int(response.split(b" ", 2)[1])

    def test_rejects_arbitrary_hosts_ports_and_plain_http_before_connecting(self):
        calls = []
        address, _ = self.start(lambda *a, **k: calls.append(a))
        for target in ["example.com:443", "127.0.0.1:22", "oauth2.googleapis.com:80",
                       "oauth2.googleapis.com.evil.test:443", "user@oauth2.googleapis.com:443",
                       "oauth2.googleapis.com:443/path", "[::1]:443"]:
            with self.subTest(target=target):
                _, code = self.connect(address, target)
                self.assertGreaterEqual(code, 400)
        _, code = self.connect(address, "https://oauth2.googleapis.com/token", method="GET")
        self.assertEqual(code, 405)
        self.assertEqual(calls, [])

    def test_relays_binary_bytes_without_logging_payload_or_credentials(self):
        calls = []
        def connector(target, timeout):
            calls.append(target)
            local, remote = socket.socketpair()
            def echo():
                with remote:
                    data = remote.recv(4096)
                    remote.sendall(data)
            threading.Thread(target=echo, daemon=True).start()
            return local
        address, events = self.start(connector)
        client, code = self.connect(address, "daily-cloudcode-pa.googleapis.com:443")
        self.assertEqual(code, 200)
        payload = b"\x16\x03\x01\x00Authorization: secret-marker\x00\xff"
        client.sendall(payload)
        self.assertEqual(client.recv(4096), payload)
        client.close()
        self.assertEqual(calls, [("daily-cloudcode-pa.googleapis.com", 443)])
        self.assertTrue(events.recorded.wait(2))
        self.assertEqual(events[0]["host"], "daily-cloudcode-pa.googleapis.com")
        self.assertNotIn("secret-marker", json.dumps(events))

    def test_connection_failure_returns_bad_gateway(self):
        def fail(*args, **kwargs):
            raise OSError("connection unavailable")
        address, _ = self.start(fail)
        _, code = self.connect(address, "oauth2.googleapis.com:443")
        self.assertEqual(code, 502)

    def test_inflight_limit_rejects_an_additional_tunnel(self):
        peers = []
        def connector(*args, **kwargs):
            local, remote = socket.socketpair()
            peers.append(remote)
            self.addCleanup(remote.close)
            return local
        address, _ = self.start(connector, limit=1)
        first, code = self.connect(address, "cloudcode-pa.googleapis.com:443")
        self.assertEqual(code, 200)
        _, code = self.connect(address, "cloudcode-pa.googleapis.com:443")
        self.assertEqual(code, 503)
        self.assertEqual(len(peers), 1)
        first.close()


if __name__ == "__main__":
    unittest.main()
