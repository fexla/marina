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
  argv[5] list_mode   - optional. Controls GET /opening-files so the CLI's
                        `list` formatting (incl. the zombie `(deleted)` marker)
                        can be tested without a real filesystem. Default 'empty'.
                          empty   {"files": [], "activePath": None}
                          mixed   two files: a.md (live) + gone.md (missing=True).
                        The /close-files response is echoed back with a `closed`
                        list built from the recorded mode/pattern so the CLI's
                        batch output can be asserted too.
"""
import http.server
import json
import sys
from urllib.parse import urlparse

PORT = int(sys.argv[1])
LOG = sys.argv[2]
TOKEN = sys.argv[3]
HEALTH_MODE = sys.argv[4] if len(sys.argv) > 4 else "marina"
LIST_MODE = sys.argv[5] if len(sys.argv) > 5 else "empty"


# Fixed fixture for GET /opening-files when LIST_MODE != "empty". Paths are
# deliberately fake (no real file needed) -- the CLI only formats the JSON.
FIXTURE_FILES = [
    {"path": "C:/fake/a.md", "name": "a.md", "kind": "markdown", "size": 3, "mtimeMs": 1.0},
    {"path": "C:/fake/gone.md", "name": "gone.md", "kind": "markdown", "size": 4, "mtimeMs": 2.0, "missing": True},
]


def opening_files_response():
    if LIST_MODE == "mixed":
        return {"files": FIXTURE_FILES, "activePath": "C:/fake/a.md"}
    return {"files": [], "activePath": None}


# Minimal in-memory state for /close-files so the batch response's `closed`
# list reflects the mode/pattern. Starts from the same fixture as `mixed` so
# close --all / --stale / --glob have something to act on when the test seeds
# it via LIST_MODE=mixed. Mutated in place on each /close-files call.
STATE_FILES = list(FIXTURE_FILES) if LIST_MODE == "mixed" else []


def close_files_response(body):
    # body: {"terminal": ..., "mode": "all"|"stale"|"glob", "pattern": "..."}
    mode = body.get("mode")
    pattern = body.get("pattern", "")
    closed = []
    kept = []
    for f in STATE_FILES:
        if mode == "all":
            close = True
        elif mode == "stale":
            close = bool(f.get("missing"))
        elif mode == "glob":
            close = _glob_match(pattern, f.get("name", ""))
        else:
            close = False
        if close:
            closed.append(f["path"])
        else:
            kept.append(f)
    STATE_FILES[:] = kept
    return {"files": list(kept), "activePath": None, "closed": closed}


def _glob_match(pattern, name):
    # mirror the service's matchFileGlob: only * and ?, case-insensitive on name.
    import re
    p = pattern.lower()
    n = name.lower()
    if "*" not in p and "?" not in p:
        return p == n
    # escape regex metacharacters EXCEPT the glob chars * and ?, then turn the
    # glob chars into regex. Order matters: escape first, then map.
    escaped = re.sub(r"[.+^${}()|[\]\\]", lambda m: "\\" + m.group(0), p)
    rx = escaped.replace("*", ".*").replace("?", ".")
    return re.match("^" + rx + "$", n) is not None


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

    def _send_bytes(self, code, content_type, data):
        # v0.3.3 T12: binary response for /screenshot (image/png).
        self.send_response(code)
        self.send_header("content-type", content_type)
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
            self._send(200, opening_files_response())
            return
        if p == "/screenshot":
            # v0.3.3 T12: return a fixed 1x1 PNG so CLI `screenshot` can save & compare.
            png = bytes.fromhex(
                "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
                "0000000d49444154789c63000100000005000100"
            )
            self._send_bytes(200, "image/png", png)
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
        try:
            parsed = json.loads(body.decode("utf-8")) if body else {}
        except Exception:
            parsed = {}
        if p in ("/open-file", "/close-file"):
            self._send(200, {"files": list(STATE_FILES), "activePath": None})
            return
        if p == "/close-files":
            self._send(200, close_files_response(parsed))
            return
        self._send(404, {"error": "not found"})

    def log_message(self, *args):
        pass


srv = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
print("listening %d" % srv.server_address[1], flush=True)
srv.serve_forever()
