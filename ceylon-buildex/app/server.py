"""Web portal backend:  python -m app.server   ->  http://127.0.0.1:8080

Every question goes through the same path: look in the dataset first, run the FAR rules engine when the question is a
FAR question, then let the LLM (or the extractive fallback) write the reply from what was found - with citations.
"""
from __future__ import annotations

import ipaddress
import json
import os
import socket
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

from flask import Flask, Response, jsonify, request, send_file, send_from_directory, stream_with_context
from werkzeug.utils import secure_filename

from . import config, db, extract, far, highlight, ingest, llm, ocr, ollama_boot, retrieval, settings

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = config.MAX_UPLOAD_MB * 1024 * 1024
app.json.sort_keys = False

try:
    VERSION = (config.ROOT / "VERSION").read_text().strip() or "dev"
except OSError:
    VERSION = "dev"
# Set by the desktop launcher (LRP_HEARTBEAT=1): the open window pings every few seconds, so the program can close itself when the window is gone.
HEARTBEAT = {"on": os.environ.get("LRP_HEARTBEAT") == "1", "last": 0.0, "bye": 0.0, "n": 0}
_started = time.time()


# ------------------------------------------------------------------ helpers
def _err(msg: str, code: int = 400):
    return jsonify({"error": msg}), code


def _safe_url(url: str) -> str | None:
    """Reject non-http(s) URLs and anything that resolves to a private / loopback address."""
    try:
        u = urlparse(url)
        if u.scheme not in ("http", "https") or not u.hostname:
            return "Only http(s) URLs are accepted."
        for info in socket.getaddrinfo(u.hostname, None):
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                return "That address is not allowed."
    except socket.gaierror:
        return None          # let the downloader report DNS problems itself
    except Exception:
        return "Invalid URL."
    return None


class Tasks:
    """Tiny in-memory background task registry (OCR jobs, add-by-URL jobs)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.items: dict[str, dict] = {}

    def start(self, kind: str, fn, *args) -> str:
        tid = uuid.uuid4().hex[:10]
        with self.lock:
            self.items[tid] = {"id": tid, "kind": kind, "status": "running", "progress": [0, 1], "result": None, "error": None, "started": time.time()}
            for old in [k for k, v in self.items.items() if time.time() - v["started"] > 3600]:
                self.items.pop(old, None)

        def prog(done, total):
            with self.lock:
                self.items[tid]["progress"] = [done, total]

        def run():
            try:
                res = fn(prog, *args)
                with self.lock:
                    self.items[tid].update(status="done", result=res)
            except Exception as e:
                with self.lock:
                    self.items[tid].update(status="error", error=f"{type(e).__name__}: {e}")

        threading.Thread(target=run, daemon=True).start()
        return tid

    def get(self, tid: str):
        with self.lock:
            v = self.items.get(tid)
            return json.loads(json.dumps(v)) if v else None


TASKS = Tasks()


# ------------------------------------------------------------------ the ask pipeline
def ask_events(question: str, category: str | None = None, history: list[dict] | None = None, k: int = 7):
    """The ask pipeline as a stream of events. Every event is emitted when that step really starts or ends, so a client can show
    the true state of the work: parse -> (far) -> search -> found -> write -> done."""
    t0 = time.time()
    yield {"stage": "parse"}
    parsed = far.parse_question(question)
    far_result, far_note, far_inputs, assumed = None, None, None, None
    boost = ""
    if parsed["looks_like_far"]:
        inputs = dict(parsed["inputs"])
        missing = list(parsed["missing"])
        if inputs.get("regime") == "cmc2008" and missing == ["CMC zone"]:
            inputs["zone"], assumed = "MD", "No zone was named, so Form C1 is shown (it applies to every Colombo zone except Concentrated Development, Public Open Spaces and the Development Guide Plan zones)."
            missing = []
        if not missing:
            yield {"stage": "far"}
            try:
                far_result = far.calculate(inputs)
                far_inputs = inputs
                if assumed:
                    far_result["warnings"].insert(0, assumed)
            except ValueError as e:
                far_note = f"The FAR engine could not compute this: {e}"
        else:
            far_note = ("This looks like a FAR question but the question does not give: " + ", ".join(missing) +
                        ". Answer from the sources and invite the reader to supply these or use the FAR calculator.")
        boost = "floor area ratio FAR Form " + ("C1 C2 Colombo" if inputs.get("regime") == "cmc2008" else "A zone factor")
    with db.db() as con:
        st = db.stats(con)
    yield {"stage": "search", "passages": st["chunks"], "documents": st["documents"]}
    found = retrieval.search(question, limit=k + 3, category=category, boost=boost)
    passages = retrieval.relevant(found)[:k]
    titles = list(dict.fromkeys(p["title"] for p in passages))          # the documents the passages come from, best match first
    yield {"stage": "found", "passages": len(passages), "documents": len(titles), "far": bool(far_result), "titles": titles[:6]}
    if not passages and not far_result:
        yield {"stage": "done", "result": {
            "answer": ("The dataset does not contain a passage that answers this question. Try different wording, widen the filter, "
                       "run **Update** to fetch more documents, or add a document on the Scan page."),
            "mode": "none", "model": None, "citations": [], "far": None, "far_note": far_note, "took_ms": int((time.time() - t0) * 1000)}}
        return
    prov = llm.resolve_provider()
    yield {"stage": "write", "mode": "llm" if prov["provider"] != "none" else "compose", "model": prov.get("model")}
    res = llm.answer(question, passages, far=far_result, far_note=far_note, history=history)
    res["answer"] = highlight.prepare(res.get("answer"))
    cites = [{"n": i, "chunk_id": p["chunk_id"], "doc_id": p["doc_id"], "title": p["title"], "page": p["page"], "heading": p.get("heading") or "",
              "url": p.get("url"), "status": p.get("status"), "origin": p.get("origin"), "gazette_no": p.get("gazette_no"),
              "category": p.get("category"), "score": p["score"], "text": p["text"]} for i, p in enumerate(passages, start=1)]
    yield {"stage": "done", "result": {**res, "citations": cites, "far": far_result, "far_inputs": far_inputs, "far_note": far_note,
                                       "took_ms": int((time.time() - t0) * 1000)}}


def run_ask(question: str, category: str | None = None, history: list[dict] | None = None, k: int = 7) -> dict:
    result = None
    for ev in ask_events(question, category, history, k):
        if ev["stage"] == "done":
            result = ev["result"]
    return result


# ------------------------------------------------------------------ routes: static
@app.get("/")
def home():
    return send_from_directory(config.WEB, "index.html")


@app.get("/static/<path:p>")
def static_files(p):
    return send_from_directory(config.WEB, p)


# ------------------------------------------------------------------ routes: API
@app.get("/api/status")
def api_status():
    with db.db() as con:
        st = db.stats(con)
    return jsonify({"version": VERSION, "dataset": st, "llm": llm.resolve_provider(), "ollama_boot": ollama_boot.status(), "heartbeat": HEARTBEAT["on"],
                    "ocr": {"available": ocr.tesseract_available(), "languages": ocr.installed_langs(), "workers": config.OCR_WORKERS},
                    "update": {"running": ingest.JOB.snapshot()["running"], "auto_hours": config.AUTO_UPDATE_HOURS},
                    "uptime_s": int(time.time() - _started)})


def _same_origin_only():
    """The window's own page only: another web page must not be able to make this program quit."""
    host = (urlparse("//" + (request.host or "")).hostname or "").lower()
    if host not in ({"127.0.0.1", "localhost", "::1"} | config.ALLOWED_HOSTS):
        return _err("Not allowed.", 403)
    origin = request.headers.get("Origin")
    if origin and urlparse(origin).netloc.lower() != (request.host or "").lower():
        return _err("Not allowed.", 403)
    return None


@app.post("/api/ping")
def api_ping():
    bad = _same_origin_only()
    if bad:
        return bad
    HEARTBEAT.update(last=time.time(), n=HEARTBEAT["n"] + 1)
    return ("", 204)


@app.post("/api/bye")
def api_bye():
    """The window is closing (sent by the page as it unloads). The launcher waits a few seconds for a new ping (a reload) before it quits."""
    bad = _same_origin_only()
    if bad:
        return bad
    HEARTBEAT["bye"] = time.time()
    return ("", 204)


def _ask_args():
    body = request.get_json(silent=True) or {}
    q = (body.get("question") or "").strip()
    if len(q) < 3:
        return None, _err("Ask a question (at least 3 characters).")
    if len(q) > 1500:
        return None, _err("Question too long (limit 1,500 characters).")
    hist = [m for m in (body.get("history") or []) if isinstance(m, dict) and m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str)]
    return (q, body.get("category"), hist), None


@app.post("/api/ask")
def api_ask():
    args, bad = _ask_args()
    if bad:
        return bad
    return jsonify(run_ask(*args))


@app.post("/api/ask/stream")
def api_ask_stream():
    """Same answer as /api/ask, delivered as newline-delimited JSON events while the work happens."""
    args, bad = _ask_args()
    if bad:
        return bad

    def gen():
        try:
            for ev in ask_events(*args):
                yield json.dumps(ev, ensure_ascii=False, default=str) + "\n"
        except Exception as e:                                   # tell the client instead of silently cutting the stream
            yield json.dumps({"stage": "error", "message": f"{type(e).__name__}: {e}"}) + "\n"

    return Response(stream_with_context(gen()), mimetype="application/x-ndjson", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/search")
def api_search():
    q = (request.args.get("q") or "").strip()
    if not q:
        return _err("Missing q.")
    res = retrieval.search(q, limit=min(int(request.args.get("limit", 15)), 40), category=request.args.get("category"),
                           only_current=request.args.get("current") == "1")
    return jsonify({"query": q, "results": res})


@app.get("/api/docs")
def api_docs():
    return jsonify({"documents": retrieval.list_documents(request.args.get("category"), request.args.get("q"), request.args.get("status"))})


@app.get("/api/doc/<doc_id>")
def api_doc(doc_id):
    d = retrieval.get_document(doc_id)
    if not d:
        return _err("Not found.", 404)
    d.pop("local_path", None)
    return jsonify({"document": d, "chunks": retrieval.document_chunks(doc_id, request.args.get("q"))})


@app.get("/api/doc/<doc_id>/file")
def api_doc_file(doc_id):
    d = retrieval.get_document(doc_id)
    if not d or not d.get("local_path") or not Path(d["local_path"]).exists():
        return _err("The original file is not stored locally (this entry is a seed extract). Run an update to download it.", 404)
    return send_file(d["local_path"], as_attachment=False)


@app.get("/api/sources")
def api_sources():
    return jsonify({"sources": ingest.source_status(), "listings": [
        {k: v for k, v in d.items() if k in ("id", "title", "page_url", "enabled", "category")} for d in ingest.load_registry()["discovery"]]})


@app.post("/api/update")
def api_update():
    body = request.get_json(silent=True) or {}
    started = ingest.JOB.start(discover=body.get("discover", True), only=body.get("only") or None, fast=not body.get("accurate_ocr", False),
                               force=bool(body.get("force", False)))
    return jsonify({"started": started, "state": ingest.JOB.snapshot()}), (202 if started else 409)


@app.get("/api/update/status")
def api_update_status():
    return jsonify(ingest.JOB.snapshot())


@app.post("/api/sources/add-url")
def api_add_url():
    body = request.get_json(silent=True) or {}
    url = (body.get("url") or "").strip()
    bad = _safe_url(url)
    if bad:
        return _err(bad)

    def run(prog):
        return ingest.add_url(url, body.get("title") or None, body.get("category") or None, progress=None)
    return jsonify({"task": TASKS.start("add-url", run)}), 202


ALLOWED_UP = {".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp", ".docx", ".txt"}


@app.post("/api/ocr")
def api_ocr():
    f = request.files.get("file")
    if not f or not f.filename:
        return _err("Attach a file (PDF, PNG, JPG, TIFF or DOCX).")
    ext = Path(f.filename).suffix.lower()
    if ext not in ALLOWED_UP:
        return _err(f"Unsupported file type {ext}.")
    name = f"{uuid.uuid4().hex[:8]}_{secure_filename(f.filename) or 'upload' + ext}"
    path = config.UPLOADS / name
    f.save(path)
    mode = request.form.get("mode", "fast")                       # fast | accurate
    force = request.form.get("force_ocr") == "1"
    add = request.form.get("add") == "1"
    title = (request.form.get("title") or Path(f.filename).stem).strip()
    category = request.form.get("category") or None
    lang = request.form.get("lang") or None

    def run(prog):
        t0 = time.time()
        pages = extract.extract_any(path, force_ocr=force, fast=(mode != "accurate"), lang=lang, progress=prog)
        out = {"pages": [{"page": p.page, "text": p.text, "method": p.method, "conf": p.conf} for p in pages],
               "text": "\n\n".join(f"--- page {p.page} ---\n{p.text}" if len(pages) > 1 else p.text for p in pages),
               "seconds": round(time.time() - t0, 2), "ocr_pages": sum(1 for p in pages if p.method == "ocr"), "n_pages": len(pages),
               "confs": [p.conf for p in pages if p.conf is not None], "filename": f.filename}
        if add:
            import hashlib
            sha = hashlib.sha256(path.read_bytes()).hexdigest()
            meta = {"id": "upload-" + sha[:10], "title": title, "category": category, "sha256": sha, "status": "user-supplied", "notes": "Added through the Scan page"}
            info = ingest.ingest_file(path, meta, origin="upload", force_ocr=force, fast=(mode != "accurate"), progress=None)
            ingest.export_dataset()
            out["added"] = info
        return out
    return jsonify({"task": TASKS.start("ocr", run)}), 202


@app.get("/api/task/<tid>")
def api_task(tid):
    t = TASKS.get(tid)
    return jsonify(t) if t else _err("Unknown task.", 404)


@app.get("/api/far/options")
def api_far_options():
    return jsonify(far.options())


@app.post("/api/far/calc")
def api_far_calc():
    body = request.get_json(silent=True) or {}
    try:
        return jsonify(far.calculate(body))
    except ValueError as e:
        return _err(str(e))
    except (TypeError, KeyError) as e:
        return _err(f"Check the inputs: {e}")


@app.post("/api/far/parse")
def api_far_parse():
    body = request.get_json(silent=True) or {}
    return jsonify(far.parse_question(body.get("text", "")))


# ------------------------------------------------------------------ settings: which model writes the answers
def _guard_settings():
    """Settings can hold an API key, so only this computer's own page may change them (blocks other web pages and DNS rebinding)."""
    host = (urlparse("//" + (request.host or "")).hostname or "").lower()
    allowed = {"127.0.0.1", "localhost", "::1"} | config.ALLOWED_HOSTS
    if host not in allowed:
        return _err(f"Settings can only be changed from this computer (host '{host}'). Set LRP_ALLOWED_HOSTS to allow another name.", 403)
    origin = request.headers.get("Origin")
    if origin and urlparse(origin).netloc.lower() != (request.host or "").lower():
        return _err("Cross-site request refused.", 403)
    if request.method == "POST" and not request.is_json:
        return _err("Send JSON.", 415)
    return None


@app.get("/api/settings")
def api_settings_get():
    bad = _guard_settings()
    if bad:
        return bad
    o = llm.detect_ollama()
    return jsonify({"settings": settings.public(), "llm": llm.resolve_provider(), "ollama": o["model"] if o else None, "ollama_boot": ollama_boot.status(),
                    "defaults": {"anthropic_model": config.ANTHROPIC_MODEL, "openai_base": "https://api.openai.com/v1", "openai_model": config.OPENAI_MODEL,
                                 "ollama_base": config.OLLAMA_URL.rstrip("/") + "/v1"}})


@app.get("/api/ollama")
def api_ollama_get():
    """Where the start-up check for Ollama is (see ollama_boot.py)."""
    return jsonify(ollama_boot.status())


@app.post("/api/ollama/check")
def api_ollama_check():
    """Run the check again (Settings: 'Check Ollama'). Only this computer's own page may do it."""
    bad = _guard_settings()
    if bad:
        return bad
    return jsonify(ollama_boot.boot_async(force=True))


@app.post("/api/settings")
def api_settings_post():
    bad = _guard_settings()
    if bad:
        return bad
    b = request.get_json(silent=True) or {}
    prov = (b.get("provider") or "").lower()
    cur = settings.load()
    new = dict(cur)
    key_in = (b.get("api_key") or "").strip()
    model = (b.get("model") or "").strip()
    if prov == "auto":
        new = {}
    elif prov == "off":
        new["provider"] = "off"
    elif prov == "anthropic":
        key = key_in or cur.get("anthropic_key") or os.environ.get("ANTHROPIC_API_KEY") or ""
        if not key:
            return _err("Paste your Anthropic API key (it starts with sk-ant-).")
        new.update(provider="anthropic", anthropic_key=key_in or cur.get("anthropic_key"), anthropic_model=model or None)
    elif prov == "openai":
        base = (b.get("base_url") or "").strip().rstrip("/")
        if not base.startswith(("http://", "https://")):
            return _err("Enter the server address, e.g. https://api.openai.com/v1 or http://localhost:11434/v1 for Ollama.")
        if not model:
            return _err("Enter the model name (for Ollama, e.g. llama3.1).")
        same = base == (cur.get("openai_base") or "").rstrip("/")
        new.update(provider="openai", openai_base=base, openai_model=model, openai_key=key_in or (cur.get("openai_key") if same else None))
    else:
        return _err("Choose a provider: anthropic, openai, off or auto.")
    test = llm.test_connection(new) if prov in ("anthropic", "openai") else {"ok": True}
    if test.get("ok") or b.get("force"):
        settings.save(new)
        return jsonify({"saved": True, "test": test, "llm": llm.resolve_provider(), "settings": settings.public()})
    return jsonify({"saved": False, "test": test, "llm": llm.resolve_provider(), "settings": settings.public()})


@app.get("/api/export/dataset.jsonl")
def api_export():
    ingest.export_dataset()
    return send_file(config.JSONL_PATH, mimetype="application/x-ndjson", as_attachment=True, download_name="ceylon-buildex-dataset.jsonl")


@app.errorhandler(413)
def too_big(_):
    return _err(f"File too large (limit {config.MAX_UPLOAD_MB} MB).", 413)


# ------------------------------------------------------------------ background refresh
def _auto_update_loop():
    while True:
        time.sleep(config.AUTO_UPDATE_HOURS * 3600)
        ingest.JOB.start(discover=True)


def create_app():
    with db.db():
        pass
    ingest.init_seeds(progress=None, skip_unchanged=True)
    if config.AUTO_UPDATE_HOURS > 0:
        threading.Thread(target=_auto_update_loop, daemon=True).start()
    return app


def _update_on_start() -> None:
    marker = config.DATA / ".first_update_started"
    if config.UPDATE_ON_START == "always" or (config.UPDATE_ON_START in ("first", "1", "true") and not marker.exists()):
        marker.write_text(db.now())
        ingest.JOB.start(discover=True)
        print("First start: downloading all registered sources in the background (watch progress on the Update tab).")


def prepare():
    """Everything that has to happen before the first request (shared by `python -m app.server` and the desktop launcher)."""
    create_app()
    _update_on_start()
    ollama_boot.boot_async()          # in the background: find Ollama, start it if needed, then run: ollama run <model> "Say ready"


def main():
    prepare()
    print(f"Ceylon Buildex  ->  http://{config.HOST}:{config.PORT}   (LLM: {llm.resolve_provider()})")
    app.run(host=config.HOST, port=config.PORT, threaded=True)


if __name__ == "__main__":
    main()
