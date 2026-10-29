"""Test helpers: build an image-only ("scanned") PDF from real regulation text, so OCR is exercised on a page with no text layer."""
from __future__ import annotations

import random
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"

# Verbatim wording of the Colombo Development Plan 2008 provisions used by the FAR engine (extract prepared from the printed plan).
SAMPLE = """CITY OF COLOMBO DEVELOPMENT PLAN - AMENDMENT 2008
Form C1 - Floor Area Ratio for sites in all zones other than Concentrated Development
Where the land extent is 500 square metres or more but less than 1000 square metres and the site abuts a public street
of 12.2 metres or more between building lines, the permissible floor area ratio shall be 5.0.
Parking floors shall not be counted in the floor area ratio. Open space of not less than 2 percent of the site
shall be provided in developments exceeding the prescribed floor area."""


def make_scanned_pdf(path: Path, text: str = SAMPLE, pages: int = 1, rotate: float = 0.6, noise: bool = True, dpi: int = 200) -> Path:
    """Render `text` as black-on-grey page images (slight skew + noise + blur), then save as a PDF containing only images."""
    random.seed(7)
    w, h = int(8.27 * dpi), int(11.69 * dpi)
    font = ImageFont.truetype(FONT, int(dpi * 0.115))
    imgs = []
    for pg in range(pages):
        im = Image.new("L", (w, h), 244)
        d = ImageDraw.Draw(im)
        y = int(dpi * 0.9)
        body = text if pages == 1 else f"{text}\nPage {pg + 1} of {pages}"
        for para in body.split("\n"):
            for line in textwrap.wrap(para, 62) or [""]:
                d.text((int(dpi * 0.8), y), line, font=font, fill=25)
                y += int(dpi * 0.19)
        if noise:
            px = im.load()
            for _ in range(w * h // 150):
                x, yy = random.randrange(w), random.randrange(h)
                px[x, yy] = max(0, min(255, px[x, yy] + random.randint(-70, 40)))
        im = im.rotate(rotate, resample=Image.BICUBIC, fillcolor=244).filter(ImageFilter.GaussianBlur(0.6))
        imgs.append(im.convert("RGB"))
    imgs[0].save(path, "PDF", resolution=dpi, save_all=True, append_images=imgs[1:])
    return Path(path)


# ---------------------------------------------------------------------------------------------------- text PDFs / DOCX / local web server
def make_text_pdf(path: Path, pages: list[str]) -> Path:
    """A normal PDF with a real text layer (one string of text per page)."""
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
    c = canvas.Canvas(str(path), pagesize=A4)
    for txt in pages:
        y = 800
        for para in txt.split("\n"):
            for line in textwrap.wrap(para, 90) or [""]:
                c.setFont("Helvetica", 10)
                c.drawString(50, y, line)
                y -= 14
        c.showPage()
    c.save()
    return Path(path)


def make_docx(path: Path, paragraphs: list[str]) -> Path:
    import docx
    d = docx.Document()
    for p in paragraphs:
        d.add_paragraph(p)
    d.save(str(path))
    return Path(path)


import json  # noqa: E402
import hashlib  # noqa: E402
import threading  # noqa: E402
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402


class LocalSite:
    """Tiny web server standing in for a government site: static files with ETag / 304, a listing page, a 403 path and an HTML-instead-of-PDF path."""

    def __init__(self):
        self.files: dict[str, bytes] = {}
        self.pages: dict[str, str] = {}
        self.hits: list[tuple[str, int]] = []
        site = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                path = self.path.split("?")[0]
                if path == "/forbidden.pdf":
                    site.hits.append((path, 403)); self.send_response(403); self.end_headers(); return
                if path == "/fake.pdf":                                       # many portals answer a missing file with an HTML error page + 200
                    body = b"<!doctype html><html><body>Page not found</body></html>"
                    site.hits.append((path, 200)); self.send_response(200); self.send_header("Content-Type", "text/html"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body); return
                if path in site.pages:
                    body = site.pages[path].encode()
                    site.hits.append((path, 200)); self.send_response(200); self.send_header("Content-Type", "text/html"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body); return
                if path in site.files:
                    body = site.files[path]
                    etag = '"' + hashlib.md5(body).hexdigest() + '"'
                    if self.headers.get("If-None-Match") == etag:
                        site.hits.append((path, 304)); self.send_response(304); self.end_headers(); return
                    site.hits.append((path, 200))
                    self.send_response(200); self.send_header("Content-Type", "application/pdf" if path.endswith(".pdf") else "application/octet-stream")
                    self.send_header("ETag", etag); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body); return
                site.hits.append((path, 404)); self.send_response(404); self.end_headers()

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()


class MockLLM:
    """OpenAI-compatible chat endpoint for browser tests: answers every request with a fixed sentence that cites [S1]."""

    def __init__(self):
        outer = self
        self.delay = 0.0   # seconds to wait before answering; lets a browser test watch the real "writing" stage
        self.calls = 0

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                import json as _j
                import time as _t
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                outer.calls += 1
                if outer.delay:
                    _t.sleep(outer.delay)
                raw = _j.dumps({"choices": [{"message": {"content": "Mock written answer: the requirement is ==set out in the cited passage== [S1]."}}]}).encode()
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}/v1"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()


class GatedProxy:
    """Same-origin reverse proxy in front of the real server. Everything is forwarded unchanged except POST /api/ask/stream,
    which the test feeds one event at a time (`proxy.send({...})`, `proxy.end()`), so a browser test can prove that what the
    page shows at each moment matches the events it has actually received."""

    def __init__(self, upstream: str):
        import queue
        import urllib.error
        import urllib.request
        self.upstream = upstream.rstrip("/")
        self.q: "queue.Queue" = queue.Queue()
        self.requests = 0
        outer = self
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def log_message(self, *a):
                pass

            def _forward(self):
                n = int(self.headers.get("Content-Length", 0) or 0)
                body = self.rfile.read(n) if n else None
                hdrs = {k: v for k, v in self.headers.items() if k.lower() not in ("host", "connection", "accept-encoding", "content-length")}
                req = urllib.request.Request(outer.upstream + self.path, data=body, method=self.command, headers=hdrs)
                try:
                    r = opener.open(req, timeout=60)
                except urllib.error.HTTPError as e:
                    r = e
                data = r.read()
                self.send_response(r.status)
                for k, v in r.headers.items():
                    if k.lower() not in ("transfer-encoding", "connection", "content-length", "server", "date"):
                        self.send_header(k, v)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                self._forward()

            def do_POST(self):
                if self.path.split("?")[0] != "/api/ask/stream":
                    return self._forward()
                self.rfile.read(int(self.headers.get("Content-Length", 0) or 0))
                outer.requests += 1
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                try:
                    while True:
                        item = outer.q.get()
                        if item is None:
                            break
                        self.wfile.write((json.dumps(item) + "\n").encode())
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def send(self, ev: dict):
        self.q.put(ev)

    def end(self):
        self.q.put(None)

    def close(self):
        self.q.put(None)
        self.httpd.shutdown()

