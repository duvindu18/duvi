"""The single dataset: one SQLite file (documents + chunks + FTS5 index + OCR cache + source registry state)."""
from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone

from . import config

_lock = threading.RLock()
_ready: set[str] = set()          # database files whose schema and journal mode are already set up in this process

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents(
  id TEXT PRIMARY KEY, title TEXT, category TEXT, authority TEXT, gazette_no TEXT, doc_date TEXT, language TEXT,
  url TEXT, local_path TEXT, sha256 TEXT, etag TEXT, last_modified TEXT, fetched_at TEXT,
  pages INTEGER DEFAULT 0, n_chunks INTEGER DEFAULT 0, ocr_pages INTEGER DEFAULT 0,
  origin TEXT, status TEXT, notes TEXT, supersedes TEXT
);
CREATE TABLE IF NOT EXISTS chunks(
  id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL, page INTEGER, ord INTEGER, heading TEXT, text TEXT, method TEXT
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, heading, title, tokenize='porter unicode61');
CREATE TABLE IF NOT EXISTS ocr_cache(key TEXT PRIMARY KEY, text TEXT, conf REAL, created TEXT);
CREATE TABLE IF NOT EXISTS source_state(
  source_id TEXT PRIMARY KEY, spec TEXT, last_checked TEXT, last_result TEXT, last_error TEXT
);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    key = str(config.DB_PATH)
    if key in _ready and not config.DB_PATH.exists():  # the file was removed: set it up again
        _ready.discard(key)
    con = sqlite3.connect(config.DB_PATH, timeout=60, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA synchronous=NORMAL")
    if key not in _ready:
        con.execute("PRAGMA journal_mode=WAL")       # stored in the file: once is enough
        con.executescript(SCHEMA)
        _ready.add(key)
    return con


@contextmanager
def db():
    with _lock:
        con = connect()
        try:
            yield con
            con.commit()
        finally:
            con.close()


def set_meta(con, k: str, v) -> None:
    con.execute("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, json.dumps(v)))


def get_meta(con, k: str, default=None):
    r = con.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
    return json.loads(r["v"]) if r else default


def delete_document(con, doc_id: str) -> None:
    con.execute("DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE doc_id=?)", (doc_id,))
    con.execute("DELETE FROM chunks WHERE doc_id=?", (doc_id,))
    con.execute("DELETE FROM documents WHERE id=?", (doc_id,))


def upsert_document(con, doc: dict) -> None:
    cols = ["id", "title", "category", "authority", "gazette_no", "doc_date", "language", "url", "local_path", "sha256", "etag",
            "last_modified", "fetched_at", "pages", "n_chunks", "ocr_pages", "origin", "status", "notes", "supersedes"]
    vals = [doc.get(c) for c in cols]
    con.execute(
        f"INSERT INTO documents({','.join(cols)}) VALUES({','.join('?' * len(cols))}) "
        f"ON CONFLICT(id) DO UPDATE SET " + ",".join(f"{c}=excluded.{c}" for c in cols if c != "id"), vals)


def replace_chunks(con, doc_id: str, title: str, chunks: list[dict]) -> int:
    con.execute("DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE doc_id=?)", (doc_id,))
    con.execute("DELETE FROM chunks WHERE doc_id=?", (doc_id,))
    for i, c in enumerate(chunks):
        cur = con.execute("INSERT INTO chunks(doc_id,page,ord,heading,text,method) VALUES(?,?,?,?,?,?)",
                          (doc_id, c.get("page"), i, c.get("heading") or "", c["text"], c.get("method") or "text"))
        con.execute("INSERT INTO chunks_fts(rowid,text,heading,title) VALUES(?,?,?,?)",
                    (cur.lastrowid, c["text"], c.get("heading") or "", title or ""))
    con.execute("UPDATE documents SET n_chunks=? WHERE id=?", (len(chunks), doc_id))
    return len(chunks)


def stats(con) -> dict:
    d = con.execute("SELECT COUNT(*) n, COALESCE(SUM(pages),0) p, COALESCE(SUM(ocr_pages),0) o FROM documents").fetchone()
    c = con.execute("SELECT COUNT(*) n FROM chunks").fetchone()
    by_cat = {r["category"] or "other": r["n"] for r in con.execute("SELECT category, COUNT(*) n FROM documents GROUP BY category")}
    by_origin = {r["origin"] or "?": r["n"] for r in con.execute("SELECT origin, COUNT(*) n FROM documents GROUP BY origin")}
    return {"documents": d["n"], "pages": d["p"], "ocr_pages": d["o"], "chunks": c["n"], "by_category": by_cat,
            "by_origin": by_origin, "last_update": get_meta(con, "last_update"), "last_update_summary": get_meta(con, "last_update_summary")}
