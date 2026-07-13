#!/usr/bin/env python3
"""Mock Marina file-panel HTTP server for marina-cli.test.ts.

@why a Python server instead of node's http.createServer
  On Windows, Defender silently drops inbound connects to a freshly-listened
  node.exe port (no error, just a hang until timeout). Python<->Python and
  PowerShell<->Python on 127.0.0.1 are stable. The CLI under test
  (marina.ps1, launched via marina.cmd) is a PowerShell Invoke-RestMethod
  client; the mock server is Python only to get a reliable test fixture.

  This does NOT affect production: real Marina (electron) is already
  firewall-allowed by the time the skill talks to it. The production skill
  is PowerShell-only and has NO Python dependency -- Python appears here
  solely as the test mock-server runtime.

@what it mirrors
  The routes the CLI hits: GET /health (auth-free), GET /opening-files,
  POST /open-file | /close-file (all Bearer-gated). Each request is appended
  as one JSON line to the log file so the TS test can assert on it.

@args
  argv[1] port        - 0 = pick a free port; prints "listening <port>".
  argv[2] logfile     - appended per-request JSON lines.
  argv[3] token       - required Bearer token for all non-/health routes.
  argv[4] health_mode - optional. Controls the /health response so tests can
                        exercise the CLI's strict marker check. Default
                        'marina'. One of:
                          marina        {"ok": true, "marina": true} 200
                          wrong_marker  {"ok": "true","marina": "true"} 200 (strings, not bools)
                          unrelated     {"status": "ok"} 200 (no marina key)
                          status_500    {"error": "internal"} 500
                        Any HTTP 200 that is not exactly the Marina marker
                        must be reported as offline by the CLI under test.
"""
import http.server
import json
import sys
from urllib.parse import urlparse

PORT = int(sys.argv[1])
LOG = sys.argv[2]
TOKEN = sys.argv[3]
HEALTH_MODE = sys.argv[4] if len(sys.argv) > 4 else "marina"


def health_response():
    if HEALTH_MODE == "wrong_marker":
        return 200, {"ok": "true", "marina": "true"}
    if HEALTH_MODE == "unrelated":
        return 200, {"status": "ok", "service": "other"}
    if HEALTH_MODE == "status_500":
        return 500, {"error": "internal server error"}
    # default: the exact Marina marker. CLI must accept this and ONLY this.
    return 200, {"ok": True, "marina": True}


class Handler(http.server.BaseHTTPRequestHandler):
    def _record(self, body=b""):
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(
                json.dumps(
                    {
                        "method": self.command,
                        "path": urlparse(self.path).path,
                        "auth": self.headers.get("Authorization"),
                        "body": body.decode("utf-8", "replace"),
                    }
                )
                + "\n"
            )

    def _send(self, code, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authed(self):
        return self.headers.get("Authorization") == "Bearer " + TOKEN

    def do_GET(self):
        self._record()
        p = urlparse(self.path).path
        if p == "/health":
            code, obj = health_response()
            self._send(code, obj)
            return
        if not self._authed():
            self._send(401, {"error": "unauthorized"})
            return
        if p == "/opening-files":
            self._send(200, {"files": [], "activePath": None})
            return
        self._send(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("content-length", "0") or "0")
        body = self.rfile.read(length) if length else b""
        self._record(body)
        p = urlparse(self.path).path
        if not self._authed():
            self._send(401, {"error": "unauthorized"})
            return
        if p in ("/open-file", "/close-file"):
            self._send(200, {"files": [], "activePath": None})
            return
        self._send(404, {"error": "not found"})

    def log_message(self, *args):
        pass


srv = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
print("listening %d" % srv.server_address[1], flush=True)
srv.serve_forever()
