#!/usr/bin/env python3
"""Loopback-only CONNECT relay for the authorized Sub2API Gemini account.

TLS stays end to end between Sub2API and Google. This process never receives
account tokens, decrypts traffic, or forwards arbitrary Internet destinations.
"""

import argparse
import json
import select
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


GOOGLE_HOSTS = frozenset({
    "cloudcode-pa.googleapis.com",
    "daily-cloudcode-pa.googleapis.com",
    "oauth2.googleapis.com",
    "www.googleapis.com",
})
MAX_HEADERS = 8192
MAX_TRANSFER = 64 * 1024 * 1024
MAX_DURATION = 600
IDLE_TIMEOUT = 120


def google_target(authority):
    fields = authority.split(":")
    if len(fields) != 2 or fields[0].lower() not in GOOGLE_HOSTS or fields[1] != "443":
        return None
    return fields[0].lower(), 443


class GoogleRelay(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port=18082, connector=socket.create_connection, limit=8, logger=None):
        self.connector = connector
        self.permits = threading.BoundedSemaphore(limit)
        self.audit = logger or (lambda event: print(json.dumps(event), flush=True))
        super().__init__(("127.0.0.1", port), ConnectHandler)

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(10)
        return connection, address

    def handle_error(self, request, client_address):
        # Do not include incoming request data or socket exception arguments.
        self.audit({"event": "connection_error"})


class ConnectHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def reject(self, code):
        self.close_connection = True
        self.send_response(code)
        self.send_header("Connection", "close")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self.reject(405)

    do_POST = do_GET
    do_PUT = do_GET
    do_DELETE = do_GET
    do_HEAD = do_GET
    do_OPTIONS = do_GET

    def do_CONNECT(self):
        target = google_target(self.path)
        if not target or sum(len(k) + len(v) for k, v in self.headers.items()) > MAX_HEADERS:
            self.reject(403)
            return
        if not self.server.permits.acquire(blocking=False):
            self.reject(503)
            return
        started = time.monotonic()
        transferred = 0
        status = 502
        established = False
        self.close_connection = True
        try:
            with self.server.connector(target, timeout=10) as upstream:
                self.send_response(200, "Connection Established")
                self.end_headers()
                self.wfile.flush()
                established = True
                status = 200
                self.connection.settimeout(30)
                upstream.settimeout(30)
                last_data = started
                peers = {self.connection: upstream, upstream: self.connection}
                while time.monotonic() - started < MAX_DURATION:
                    ready, _, _ = select.select(list(peers), [], [], 10)
                    if not ready and time.monotonic() - last_data > IDLE_TIMEOUT:
                        break
                    for source in ready:
                        data = source.recv(65536)
                        if not data:
                            return
                        transferred += len(data)
                        if transferred > MAX_TRANSFER:
                            raise OSError("transfer limit")
                        peers[source].sendall(data)
                        last_data = time.monotonic()
        except OSError:
            status = 502
            if not established:
                self.reject(502)
        finally:
            self.server.permits.release()
            self.server.audit({
                "event": "google_connect", "host": target[0], "status": status,
                "bytes": transferred, "elapsed_ms": round((time.monotonic() - started) * 1000),
            })


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18082)
    options = parser.parse_args()
    if not 1024 <= options.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    server = GoogleRelay(options.port)
    print(json.dumps({"event": "listening", "host": "127.0.0.1", "port": options.port}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
