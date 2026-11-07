"""Minimal web interface for the ArchViz SEO agent (standard library + optional anthropic).

    python -m seo_agent.web            # http://127.0.0.1:8000
    python -m seo_agent.web --port 8080 --host 0.0.0.0

Engines
    builtin  free, offline rule-based generator (default, no key, no cost)
    ollama   free local AI on your PC via Ollama (optional)
    claude   Claude API agent (optional, paid, needs an API key)

Endpoints
    GET  /                 the single-page UI
    GET  /api/status       which engines are available
    POST /api/run          {"session","engine","model","task","niche","about","text","platform"} -> NDJSON
    POST /api/chat         {"session","message"} -> NDJSON (follow-up, Ollama/Claude sessions)
    POST /api/prompt       same fields as /api/run -> {"prompt"} to paste into a free chatbot
    POST /api/key          {"key"} save a Claude API key (optional)
    POST /api/reset        {"session"}
    GET  /api/verify       saved keyword checks (ranked) and gig stats
    POST /api/verify       {"action": add|load_niche|update|delete|add_stat|delete_stat, ...}
Each streamed line is a JSON event: text | delta | tool | notice | error | done.
"""

from __future__ import annotations

import argparse
import json
import os
import threading
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Iterator

from . import core, local_llm, offline, verify
from .paths import api_key, load_config, resource_dir, save_config

try:  # the Claude engine is optional; the free engines work without the SDK
    import anthropic
except ImportError:  # pragma: no cover
    anthropic = None  # type: ignore[assignment]

STATIC = resource_dir() / "static"
MAX_BODY = 200_000
ENGINES = ("builtin", "ollama", "claude")

_sessions: dict[str, dict] = {}
_locks: dict[str, threading.Lock] = {}
_client = None
# Swappable for tests: a callable (client, history) -> iterator of events.
turn_runner = core.run_turn


def _get_client():
    global _client
    if anthropic is None:
        raise RuntimeError("The Claude engine needs the 'anthropic' package.")
    if _client is None:
        key = api_key()
        _client = anthropic.Anthropic(api_key=key) if key else anthropic.Anthropic()
    return _client


def _set_key(key: str) -> None:
    global _client
    cfg = load_config()
    cfg["anthropic_api_key"] = key
    save_config(cfg)
    _client = None


def _claude_error(e: Exception) -> str | None:
    if anthropic is None:
        return None
    if isinstance(e, anthropic.AuthenticationError):
        return "Claude API key missing or invalid. Use the free Built-in engine, or add a key in Settings."
    if isinstance(e, anthropic.APIStatusError):
        return f"Claude API error {e.status_code}: {e.message}"
    if isinstance(e, anthropic.APIConnectionError):
        return "Network error reaching the Claude API."
    if isinstance(e, TypeError) and "auth" in str(e).lower():
        return "No Claude API key set. Use the free Built-in engine, or add a key in Settings."
    return None


class Handler(BaseHTTPRequestHandler):
    server_version = "ArchVizSEO/1.1"

    def log_message(self, fmt: str, *args) -> None:  # quieter console
        if "/api/" in str(args[0] if args else "") or "code" in fmt:
            super().log_message(fmt, *args)

    # ------------------------------------------------------------------ GET
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
        elif self.path == "/api/verify":
            self._json(verify.snapshot())
        elif self.path == "/api/status":
            self._json({"has_key": bool(api_key()), "model": core.MODEL,
                        "ollama": local_llm.ollama_models(),
                        "suggested_models": local_llm.SUGGESTED_MODELS})
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    # ------------------------------------------------------------------ POST
    def _same_origin(self) -> bool:
        # Block cross-site pages in the user's browser from driving this local server.
        origin = self.headers.get("Origin")
        return origin is None or origin == f"http://{self.headers.get('Host', '')}"

    def do_POST(self) -> None:
        if not self._same_origin():
            self.send_error(HTTPStatus.FORBIDDEN, "cross-origin request")
            return
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
        fields = (data.get("task", "full"), str(data.get("niche", "")), str(data.get("about", "")),
                  str(data.get("text", "")), str(data.get("platform", "fiverr")))

        if self.path == "/api/key":
            key = str(data.get("key", "")).strip()
            if not key.startswith("sk-ant-"):
                self._json({"ok": False, "error": "That doesn't look like an Anthropic API key (sk-ant-...)."})
                return
            _set_key(key)
            self._json({"ok": True})
        elif self.path == "/api/reset":
            _sessions.pop(session, None)
            self._json({"ok": True})
        elif self.path == "/api/prompt":
            if fields[0] not in core.TASKS:
                self.send_error(HTTPStatus.BAD_REQUEST, "unknown task")
                return
            self._json({"prompt": local_llm.chatbot_prompt(*fields)})
        elif self.path == "/api/verify":
            self._verify(data)
        elif self.path == "/api/run":
            self._run(session, data, fields)
        elif self.path == "/api/chat":
            self._chat(session, str(data.get("message", "")).strip())
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def _verify(self, data: dict) -> None:
        action = data.get("action")
        try:
            if action == "add":
                words = [w for w in str(data.get("keywords", "")).replace(";", ",").split(",")]
                verify.add_keywords(words)
            elif action == "load_niche":
                svc = offline.SERVICES[offline.detect_service(str(data.get("niche", "")))]
                verify.add_keywords([svc["primary"], *svc["secondary"], *svc["long_tail"]])
            elif action == "update":
                verify.upsert_keyword(str(data.get("keyword", "")), data.get("fields") or {})
            elif action == "delete":
                verify.delete_keyword(str(data.get("keyword", "")))
            elif action == "add_stat":
                verify.add_stat(data.get("fields") or {})
            elif action == "delete_stat":
                verify.delete_stat(str(data.get("id", "")))
            else:
                self.send_error(HTTPStatus.BAD_REQUEST, "unknown action")
                return
        except ValueError as e:
            self._json({"ok": False, "error": str(e), **verify.snapshot()})
            return
        self._json({"ok": True, **verify.snapshot()})

    def _run(self, session: str, data: dict, fields: tuple) -> None:
        task = fields[0]
        engine = data.get("engine", "builtin")
        if task not in core.TASKS or engine not in ENGINES:
            self.send_error(HTTPStatus.BAD_REQUEST, "unknown task or engine")
            return
        sess = {"engine": engine, "history": [], "model": str(data.get("model") or "")}
        _sessions[session] = sess
        if engine == "builtin":
            self._stream(session, lambda: offline.run(*fields), rollback=False)
        elif engine == "ollama":
            sess["history"].append({"role": "user", "content": local_llm.first_prompt(*fields)})
            self._stream(session, lambda: local_llm.run_ollama(self._ollama_model(sess), sess["history"]))
        else:
            sess["history"].append({"role": "user", "content": core.build_task_prompt(*fields)})
            self._stream(session, lambda: turn_runner(_get_client(), sess["history"]))

    def _chat(self, session: str, message: str) -> None:
        if not message:
            self.send_error(HTTPStatus.BAD_REQUEST, "empty message")
            return
        sess = _sessions.setdefault(session, {"engine": "builtin", "history": [], "model": ""})
        if sess["engine"] == "builtin":
            def notice() -> Iterator[dict]:
                yield {"type": "notice", "text": "The built-in engine doesn't do follow-up chat. Change the fields "
                       "and press Generate again for a new variation, or use Local AI (Ollama) - also free."}
            self._stream(session, notice, rollback=False)
            return
        sess["history"].append({"role": "user", "content": message})
        if sess["engine"] == "ollama":
            self._stream(session, lambda: local_llm.run_ollama(self._ollama_model(sess), sess["history"]))
        else:
            self._stream(session, lambda: turn_runner(_get_client(), sess["history"]))

    @staticmethod
    def _ollama_model(sess: dict) -> str:
        if sess.get("model"):
            return sess["model"]
        models = local_llm.ollama_models() or []
        if not models:
            raise RuntimeError("Ollama isn't running or has no models. Install one with:  ollama pull llama3.1:8b")
        sess["model"] = models[0]
        return sess["model"]

    # ------------------------------------------------------------------ output
    def _json(self, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _emit(self, ev: dict) -> None:
        self.wfile.write((json.dumps(ev) + "\n").encode())
        self.wfile.flush()

    def _safe_emit(self, ev: dict) -> None:
        try:
            self._emit(ev)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _stream(self, session: str, events: Callable[[], Iterator[dict]], rollback: bool = True) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        lock = _locks.setdefault(session, threading.Lock())
        if not lock.acquire(blocking=False):
            self._safe_emit({"type": "error", "text": "This session is already running a request."})
            return
        history = _sessions[session]["history"]
        # Roll back to just before the user message of this turn if it fails.
        mark = max(len(history) - 1, 0)
        texts: list[str] = []
        deltas: list[str] = []
        try:
            for ev in events():
                if ev["type"] == "text":
                    texts.append(ev["text"])
                elif ev["type"] == "delta":
                    deltas.append(ev["text"])
                self._emit(ev)
            markdown = "".join(deltas) if deltas else "\n\n".join(texts)
            self._emit({"type": "done", "session": session, "markdown": markdown})
        except (BrokenPipeError, ConnectionResetError):
            if rollback:
                del history[mark:]
        except Exception as e:  # surface every failure to the UI instead of a dead stream
            if rollback:
                del history[mark:]
            self._safe_emit({"type": "error", "text": _claude_error(e) or str(e) or type(e).__name__})
        finally:
            lock.release()


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR lets two processes share a port; keep ports exclusive there.
    allow_reuse_address = os.name != "nt"


def serve(host: str = "127.0.0.1", port: int = 8000) -> ThreadingHTTPServer:
    return _Server((host, port), Handler)


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
