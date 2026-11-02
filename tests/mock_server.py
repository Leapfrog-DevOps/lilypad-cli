"""Tiny stand-in for the platform: records each request as one JSON line, answers 200 {"ok":true}.
A key of `lpk_bad` gets 401. The demo `faildemo` is FAILED: its status carries lastFailure. Sends CORS headers so web/lilypad.html can be pointed at it.
Usage: mock_server.py <port-file> <log-file>"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


class H(BaseHTTPRequestHandler):
    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST")
        self.send_header("Access-Control-Allow-Headers", "content-type, x-lilypad-key")

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode()
        key = self.headers.get("X-Lilypad-Key", "")
        with open(sys.argv[2], "a") as f:
            f.write(json.dumps({"key": key, "body": json.loads(body)}) + "\n")
        code = 401 if key == "lpk_bad" else 200
        reply = {"ok": code == 200}
        req = json.loads(body)
        if code == 200 and req.get("name") == "faildemo" and req.get("action") == "status":
            cause = "Deployment failed | container: Task failed ELB health checks; app: exit code 1"
            reply.update(message="faildemo: FAILED\nLast failure: " + cause,
                         data={"name": "faildemo", "status": "FAILED", "lastFailure": cause})
        elif code == 200 and req.get("name") == "busydemo" and req.get("action") == "metrics":
            reply.update(message="*busydemo*: requests\n1h: 12  24h: 340  7d: 2,104  Total: 5,412 (since 2026-10-01)",
                         data={"name": "busydemo", "since": "2026-10-01T00:00:00Z", "asOf": "2026-10-28T12:00:00Z",
                               "requests": {"1h": 12, "24h": 340, "7d": 2104, "total": 5412},
                               "codes": {"2xx": 5180, "4xx": 201, "5xx": 31},
                               "latencyMs": {"p50": 42, "p95": 310}, "lastRequestAt": "2026-10-28T09:00:00Z"})
        elif code == 200 and req.get("action") == "list":
            # Demos across two clients and none, for the web dashboard's sort and grouping.
            row = lambda name, client, status, days: {
                "name": name, "client": client, "status": status, "owner": "you@example.com",
                "url": "https://" + name + ("-" + client if client else "") + ".demo.example.com",
                "expiresAt": "2026-12-%02dT00:00:00Z" % days, "monthlyCost": 9.12 if status == "RUNNING" else None}
            reply.update(data=[row("busydemo", "acme", "RUNNING", 20), row("shop", "globex", "RUNNING", 3),
                               row("alpha", "acme", "BUILDING", 25), row("faildemo", "", "FAILED", 10),
                               row("zeta", "", "RUNNING", 28)])
        elif code == 200 and req.get("name") == "faildemo" and req.get("action") == "redeploy":
            reply.update(message="Redeploy started for faildemo (from FAILED: builds and creates it again).")
        out = json.dumps(reply).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.cors()
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


s = HTTPServer(("127.0.0.1", 0), H)
open(sys.argv[1], "w").write(str(s.server_port))
s.serve_forever()
