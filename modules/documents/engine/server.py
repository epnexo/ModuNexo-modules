#!/usr/bin/env python3
"""
The PDF engine as a small HTTP service, so a platform that cannot carry WeasyPrint (it needs system libraries) can call it.

  POST /render   body: the HTML (UTF-8)        header: Authorization: Bearer <ENGINE_TOKEN>
                 200 {"pages": N, "fields": [...], "pdf": "<base64>"}   the same document render.py prints, plus the PDF
                 401 bad or missing token, 413 HTML too large, 503 WeasyPrint missing, 504 time limit, 500 any other failure
  GET  /health   200 {"ok": true}   (no token; it says nothing about documents)

It never renders in this process: every request runs the vendored render.py in a child, exactly as the platform does with
a local interpreter, so the fetcher that refuses network and file access is the same code. Errors carry only a fixed code,
never text from the document.

Environment: ENGINE_TOKEN (required), ENGINE_PORT (default 8080), ENGINE_ASSETS (optional folder for fonts and images),
ENGINE_TIMEOUT (seconds, default 60), ENGINE_PARALLEL (renders at once, default 2).
"""
import base64
import hmac
import json
import os
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
RENDER = os.path.join(HERE, "render.py") if os.path.exists(os.path.join(HERE, "render.py")) else os.path.join(HERE, "..", "render", "render.py")
MAX_HTML_BYTES = 8 * 1024 * 1024
TOKEN = os.environ.get("ENGINE_TOKEN", "")
ASSETS = os.environ.get("ENGINE_ASSETS") or None
TIMEOUT = float(os.environ.get("ENGINE_TIMEOUT", "60"))
SLOTS = threading.BoundedSemaphore(int(os.environ.get("ENGINE_PARALLEL", "2")))


def render(html):
    """(status, body) for one document."""
    with tempfile.TemporaryDirectory(prefix="engine-") as folder:
        pdf_path = os.path.join(folder, "out.pdf")
        args = [sys.executable, RENDER, "--pdf", pdf_path] + (["--assets", ASSETS] if ASSETS else [])
        env = {name: os.environ[name] for name in ("PATH", "HOME", "LANG", "LC_ALL", "FONTCONFIG_FILE", "FONTCONFIG_PATH", "XDG_CACHE_HOME") if name in os.environ}
        try:
            done = subprocess.run(args, input=html, capture_output=True, timeout=TIMEOUT, env=env, shell=False)
        except subprocess.TimeoutExpired:
            return 504, {"error": "timeout"}
        if done.returncode == 3:
            return 503, {"error": "weasyprint-missing"}
        if done.returncode != 0:
            return 500, {"error": "render-error"}
        try:
            report = json.loads(done.stdout)
            with open(pdf_path, "rb") as handle:
                pdf = handle.read()
        except (ValueError, OSError):
            return 500, {"error": "render-error"}
        return 200, {"pages": report["pages"], "fields": report["fields"], "pdf": base64.b64encode(pdf).decode("ascii")}


class Handler(BaseHTTPRequestHandler):
    server_version = "documents-engine"

    def log_message(self, *_):  # the default line carries the client address; the platform logs what it needs
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.reply(200, {"ok": True}) if self.path == "/health" else self.reply(404, {"error": "not-found"})

    def do_POST(self):
        if self.path != "/render":
            return self.reply(404, {"error": "not-found"})
        given = self.headers.get("Authorization", "")
        if not hmac.compare_digest(given.encode("utf-8"), ("Bearer " + TOKEN).encode("utf-8")):
            return self.reply(401, {"error": "unauthorized"})
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self.reply(411, {"error": "length-required"})
        if length < 1 or length > MAX_HTML_BYTES:
            return self.reply(413, {"error": "too-large"})
        html = self.rfile.read(length)
        if not SLOTS.acquire(timeout=TIMEOUT):
            return self.reply(503, {"error": "busy"})
        try:
            status, body = render(html)
        finally:
            SLOTS.release()
        self.reply(status, body)


if __name__ == "__main__":
    if not TOKEN:
        sys.stderr.write("ENGINE_TOKEN is not set.\n")
        sys.exit(2)
    port = int(os.environ.get("ENGINE_PORT", "8080"))
    sys.stderr.write("documents engine listening on port %d\n" % port)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
