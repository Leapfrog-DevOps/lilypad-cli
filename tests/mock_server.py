"""Tiny stand-in for the platform: records each request as one JSON line, answers 200 {"ok":true}.
A key of `lpk_bad` gets 401. Usage: mock_server.py <port-file> <log-file>"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode()
        key = self.headers.get("X-Lilypad-Key", "")
        with open(sys.argv[2], "a") as f:
            f.write(json.dumps({"key": key, "body": json.loads(body)}) + "\n")
        code = 401 if key == "lpk_bad" else 200
        out = json.dumps({"ok": code == 200}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


s = HTTPServer(("127.0.0.1", 0), H)
open(sys.argv[1], "w").write(str(s.server_port))
s.serve_forever()
