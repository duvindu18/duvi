"""Minimal web interface for the ArchViz SEO agent (standard library only).

    python -m seo_agent.web            # http://127.0.0.1:8000
    python -m seo_agent.web --port 8080 --host 0.0.0.0

Endpoints
    GET  /                 the single-page UI
    POST /api/run          {"session", "task", "niche", "about", "text", "platform"} -> NDJSON stream
    POST /api/chat         {"session", "message"} -> NDJSON stream (follow-up in the same session)
    POST /api/reset        {"session"}
Each streamed line is a JSON event: text | tool | notice | error | done.
"""

from __future__ import annotations

import argparse
import json
import threading
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import anthropic

from . import core

STATIC = Path(__file__).resolve().parent / "static"
MAX_BODY = 200_000

_sessions: dict[str, list] = {}
_locks: dict[str, threading.Lock] = {}
_client: anthropic.Anthropic | None = None
# Swappable for tests: a callable (client, history) -> iterator of events.
turn_runner = core.run_turn


def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic()
    return _client


class Handler(BaseHTTPRequestHandler):
    server_version = "ArchVizSEO/1.0"

    def log_message(self, fmt: str, *args) -> None:  # quieter console
        if "/api/" in (args[0] if args else ""):
            super().log_message(fmt, *args)

    def do_GET(self) -> None:
        if self.path in ("/", "/index.html"):
            body = (STATIC / "index.html").read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/api/tasks":
            self._json({"tasks": core.TASKS})
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            self.send_error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self.send_error(HTTPStatus.BAD_REQUEST, "invalid JSON")
            return
        session = str(data.get("session") or uuid.uuid4())

        if self.path == "/api/reset":
            _sessions.pop(session, None)
            self._json({"ok": True})
            return
        if self.path == "/api/run":
            task = data.get("task", "full")
            if task not in core.TASKS:
                self.send_error(HTTPStatus.BAD_REQUEST, "unknown task")
                return
            prompt = core.build_task_prompt(task, data.get("niche", ""), data.get("about", ""),
                                            data.get("text", ""), data.get("platform", "fiverr"))
            _sessions[session] = []
        elif self.path == "/api/chat":
            prompt = str(data.get("message", "")).strip()
            if not prompt:
                self.send_error(HTTPStatus.BAD_REQUEST, "empty message")
                return
            _sessions.setdefault(session, [])
        else:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        self._stream(session, prompt)

    def _json(self, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _emit(self, ev: dict) -> None:
        self.wfile.write((json.dumps(ev) + "\n").encode())
        self.wfile.flush()

    def _stream(self, session: str, prompt: str) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        lock = _locks.setdefault(session, threading.Lock())
        if not lock.acquire(blocking=False):
            self._emit({"type": "error", "text": "This session is already running a request."})
            return
        history = _sessions[session]
        mark = len(history)
        history.append({"role": "user", "content": prompt})
        try:
            for ev in turn_runner(_get_client(), history):
                self._emit(ev)
            self._emit({"type": "done", "session": session,
                        "markdown": core.final_markdown(history, mark)})
        except (BrokenPipeError, ConnectionResetError):
            del history[mark:]
        except anthropic.AuthenticationError:
            del history[mark:]
            self._safe_emit({"type": "error", "text": "No valid API key. Set ANTHROPIC_API_KEY and restart."})
        except anthropic.APIStatusError as e:
            del history[mark:]
            self._safe_emit({"type": "error", "text": f"API error {e.status_code}: {e.message}"})
        except anthropic.APIConnectionError:
            del history[mark:]
            self._safe_emit({"type": "error", "text": "Network error reaching the Claude API."})
        except Exception as e:  # surface anything else to the UI instead of a dead stream
            del history[mark:]
            self._safe_emit({"type": "error", "text": f"{type(e).__name__}: {e}"})
        finally:
            lock.release()

    def _safe_emit(self, ev: dict) -> None:
        try:
            self._emit(ev)
        except (BrokenPipeError, ConnectionResetError):
            pass


def serve(host: str = "127.0.0.1", port: int = 8000) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), Handler)


def main() -> None:
    parser = argparse.ArgumentParser(description="ArchViz SEO agent web UI")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    httpd = serve(args.host, args.port)
    print(f"ArchViz SEO Agent running at http://{args.host}:{args.port}  (Ctrl+C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
