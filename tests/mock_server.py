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
