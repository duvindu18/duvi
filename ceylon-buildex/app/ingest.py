"""Builds and refreshes the single dataset.

    python -m app.ingest init                 create the database and load the verified seed extracts
    python -m app.ingest update               download every registered source + scan listing pages for new ones
    python -m app.ingest add-url URL          register one more document and ingest it
    python -m app.ingest add-file PATH        ingest a local file (PDF / DOCX / image) - OCR is automatic
    python -m app.ingest add-listing URL      register a listing page to scan on every update
    python -m app.ingest export               write data/dataset.jsonl and data/documents.json
    python -m app.ingest stats | search "q"

Put files into data/raw/inbox/ and `update` will pick them up too (useful when a site blocks downloads).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import threading
import time
import traceback
from pathlib import Path

from . import config, db, downloader, extract


# ------------------------------------------------------------------ registry
def load_registry() -> dict:
    reg = json.loads(config.SOURCES_JSON.read_text()) if config.SOURCES_JSON.exists() else {"sources": [], "discovery": []}
    known = {s["id"] for s in reg["sources"]}
    known_d = {d["id"] for d in reg["discovery"]}
    with db.db() as con:
        for r in con.execute("SELECT spec FROM source_state WHERE spec IS NOT NULL"):
            try:
                spec = json.loads(r["spec"])
            except Exception:
                continue
            if spec.get("kind") == "listing" and spec["id"] not in known_d:
                reg["discovery"].append(spec)
            elif spec.get("kind") in ("user", "discovered") and spec["id"] not in known:
                reg["sources"].append(spec)
    return reg


def _save_spec(spec: dict) -> None:
    with db.db() as con:
        con.execute("INSERT INTO source_state(source_id, spec) VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET spec=excluded.spec",
                    (spec["id"], json.dumps(spec)))


def _record(source_id: str, result: str, error: str | None = None) -> None:
    with db.db() as con:
        con.execute("INSERT INTO source_state(source_id,last_checked,last_result,last_error) VALUES(?,?,?,?) "
                    "ON CONFLICT(source_id) DO UPDATE SET last_checked=excluded.last_checked,last_result=excluded.last_result,last_error=excluded.last_error",
                    (source_id, db.now(), result, error))


def source_status() -> list[dict]:
    """Registry joined with what the dataset knows - used by the portal's Update tab."""
    reg = load_registry()
    out = []
    with db.db() as con:
        st = {r["source_id"]: dict(r) for r in con.execute("SELECT source_id,last_checked,last_result,last_error FROM source_state")}
        docs = {r["id"]: dict(r) for r in con.execute("SELECT id,origin,pages,n_chunks,fetched_at,sha256 FROM documents")}
    for s in reg["sources"]:
        d = docs.get(s["id"])
        state = st.get(s["id"], {})
        out.append({"id": s["id"], "title": s["title"], "category": s.get("category"), "status": s.get("status"),
                    "verified": s.get("verified"), "enabled": s.get("enabled", True), "url": (s.get("urls") or [""])[0],
                    "in_dataset": bool(d), "origin": d["origin"] if d else None, "pages": d["pages"] if d else 0,
                    "last_checked": state.get("last_checked"), "last_result": state.get("last_result"), "last_error": state.get("last_error")})
    return out


# ------------------------------------------------------------------ metadata helpers
def guess_category(text: str, default: str = "other") -> str:
    t = text.lower()
    if re.search(r"bidding|sbd|tender|procurement|bid document", t):
        return "procurement-sbd" if re.search(r"bidding document|sbd", t) else "procurement-policy"
    if re.search(r"planning and (?:development|building)|building regulation|floor area|zoning|development plan|urban development authority", t):
        return "building-regulations"
    if re.search(r"\bact\b.*\bno\.\s*\d+|law, no\.", t):
        return "legislation"
    return default


def gazette_from_url(url: str) -> tuple[str, str, str]:
    """(gazette_no, date 'YYYY-MM', language) from documents.gov.lk style URLs."""
    m = re.search(r"/(\d{4})/(\d{1,2})/(\d{4})-(\d{1,3})_([EST])\.pdf", url)
    if m:
        y, mo, a, b, lang = m.groups()
        return f"{a}/{int(b):02d}", f"{y}-{int(mo):02d}", {"E": "en", "S": "si", "T": "ta"}[lang]
    m = re.search(r"(\d{4})-(\d{1,3})_([EST])\.pdf", url)
    if m:
        a, b, lang = m.groups()
        return f"{a}/{int(b):02d}", "", {"E": "en", "S": "si", "T": "ta"}[lang]
    return "", "", "en"


def _ext_for(url: str, default: str = ".pdf") -> str:
    p = re.sub(r"[?#].*", "", url).lower()
    for e in (".pdf", ".docx", ".doc", ".xlsx"):
        if p.endswith(e):
            return e
    return default


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:60] or "doc"


# ------------------------------------------------------------------ ingest one file
def ingest_file(path: Path, meta: dict, origin: str = "full-text", force_ocr: bool = False, fast: bool = True,
                progress=print) -> dict:
    t0 = time.time()
    path = Path(path)
    prog = (lambda d, n: progress(f"    OCR {d}/{n} pages")) if progress else None
    pages = extract.extract_any(path, force_ocr=force_ocr, fast=fast, progress=prog)
    chunks = extract.chunk_pages(pages)
    n_ocr = sum(1 for p in pages if p.method == "ocr")
    first = next((p.text for p in pages if p.text.strip()), "")
    doc = {
        "id": meta["id"], "title": meta.get("title") or path.name, "category": meta.get("category") or guess_category(meta.get("title", "") + " " + first[:800]),
        "authority": meta.get("authority"), "gazette_no": meta.get("gazette_no"), "doc_date": meta.get("date") or meta.get("doc_date"),
        "language": meta.get("language") or "en", "url": meta.get("url"), "local_path": str(path), "sha256": meta.get("sha256"),
        "etag": meta.get("etag"), "last_modified": meta.get("last_modified"), "fetched_at": db.now(), "pages": len(pages),
        "n_chunks": len(chunks), "ocr_pages": n_ocr, "origin": origin, "status": meta.get("status"), "notes": meta.get("notes"),
        "supersedes": meta.get("supersedes"),
    }
    with db.db() as con:
        db.upsert_document(con, doc)
        db.replace_chunks(con, doc["id"], doc["title"], chunks)
    return {"id": doc["id"], "pages": len(pages), "ocr_pages": n_ocr, "chunks": len(chunks), "seconds": round(time.time() - t0, 1)}


# ------------------------------------------------------------------ seeds
def init_seeds(progress=print) -> int:
    seed_file = config.SEED / "seed_documents.json"
    if not seed_file.exists():
        return 0
    n = 0
    seeds = json.loads(seed_file.read_text())
    with db.db() as con:
        for s in seeds:
            row = con.execute("SELECT origin FROM documents WHERE id=?", (s["id"],)).fetchone()
            if row and row["origin"] != "seed-extract":
                continue                                      # a full-text copy already replaced the seed
            pages = [extract.PageText(p["page"], p["text"], "text") for p in s["pages"]]
            chunks = extract.chunk_pages(pages, target=1300, overlap=0)
            first_line = {pg.page: pg.text.strip().split("\n", 1)[0][:140] for pg in pages}
            for ch in chunks:                                  # the first line of a seed page is its descriptive title
                if not ch.get("heading"):
                    ch["heading"] = first_line.get(ch["page"], "")
            doc = {"id": s["id"], "title": s["title"], "category": s.get("category"), "authority": s.get("authority"),
                   "gazette_no": s.get("gazette_no"), "doc_date": s.get("date"), "language": s.get("language", "en"), "url": s.get("url"),
                   "local_path": None, "sha256": None, "etag": None, "last_modified": None, "fetched_at": s.get("read_on"),
                   "pages": len(pages), "n_chunks": len(chunks), "ocr_pages": 0, "origin": "seed-extract", "status": s.get("status"),
                   "notes": s.get("notes"), "supersedes": None}
            db.upsert_document(con, doc)
            db.replace_chunks(con, s["id"], s["title"], chunks)
            n += 1
    if progress:
        progress(f"seed extracts loaded: {n}")
    return n


# ------------------------------------------------------------------ one source
def process_source(src: dict, progress=print, fast: bool = True, force: bool = False) -> dict:
    sid = src["id"]
    with db.db() as con:
        prev = con.execute("SELECT etag,last_modified,sha256,origin,local_path FROM documents WHERE id=?", (sid,)).fetchone()
    prev = dict(prev) if prev else {}
    full_text_here = prev.get("origin") in ("full-text", "upload")
    last_err = "no URL"
    for url in src.get("urls", []):
        ext = _ext_for(url)
        dest = config.RAW / sid / f"{sid}{ext}"
        if progress:
            progress(f"  {sid}: GET {url}")
        r = downloader.fetch(url, dest, etag=prev.get("etag") if full_text_here else None,
                             last_modified=prev.get("last_modified") if full_text_here else None,
                             prev_sha=prev.get("sha256") if full_text_here else None, expect_pdf=(ext == ".pdf"))
        if r["status"] == "error":
            last_err = f"{url}: {r.get('error')}"
            continue
        if r["status"] == "unchanged" and full_text_here and not force:
            _record(sid, "unchanged")
            return {"id": sid, "result": "unchanged"}
        path = Path(r["path"]) if r.get("path") else dest
        g_no, g_date, g_lang = gazette_from_url(url)
        meta = dict(src, url=url, sha256=r.get("sha256"), etag=r.get("etag"), last_modified=r.get("last_modified"))
        meta.setdefault("gazette_no", g_no)
        if not meta.get("gazette_no"):
            meta["gazette_no"] = g_no
        if not meta.get("date"):
            meta["date"] = g_date
        info = ingest_file(path, meta, fast=fast, progress=progress)
        _record(sid, r["status"])
        info["result"] = r["status"]
        if progress:
            progress(f"    {r['status']}: {info['pages']} pages ({info['ocr_pages']} OCR), {info['chunks']} chunks, {info['seconds']}s")
        return info
    _record(sid, "error", last_err)
    if progress:
        progress(f"  {sid}: FAILED - {last_err}")
    return {"id": sid, "result": "error", "error": last_err}


def process_listing(spec: dict, progress=print, fast: bool = True) -> dict:
    if progress:
        progress(f"scan: {spec['page_url']}")
    res = downloader.discover_links(spec["page_url"], spec.get("link_regex") or None, spec.get("text_regex") or None,
                                    all_languages=spec.get("all_languages", False), max_links=spec.get("max_links", 50))
    if res["error"]:
        _record(spec["id"], "error", res["error"])
        if progress:
            progress(f"  listing failed: {res['error']}")
        return {"id": spec["id"], "result": "error", "error": res["error"], "found": 0, "added": 0}
    with db.db() as con:
        known_urls = {r["url"] for r in con.execute("SELECT url FROM documents WHERE url IS NOT NULL")}
        for r in con.execute("SELECT spec FROM source_state WHERE spec IS NOT NULL"):
            try:
                known_urls.update(json.loads(r["spec"]).get("urls", []))
            except Exception:
                pass
    reg_urls = {u for s in load_registry()["sources"] for u in s.get("urls", [])}
    added = 0
    for link in res["links"]:
        if link["url"] in known_urls or link["url"] in reg_urls:
            continue
        g_no, g_date, g_lang = gazette_from_url(link["url"])
        sid = "disc-" + hashlib.sha1(link["url"].encode()).hexdigest()[:10]
        src = {"id": sid, "kind": "discovered", "title": link["text"] or sid, "category": spec.get("category") or guess_category(link["text"]),
               "authority": spec.get("authority"), "gazette_no": g_no, "date": g_date, "language": g_lang, "urls": [link["url"]],
               "status": "unverified", "verified": False, "notes": f"Discovered on {spec['page_url']}"}
        _save_spec(src)
        r = process_source(src, progress=progress, fast=fast)
        if r.get("result") in ("new", "updated"):
            added += 1
    _record(spec["id"], f"found {len(res['links'])}, added {added}")
    return {"id": spec["id"], "result": "ok", "found": len(res["links"]), "added": added}


def process_inbox(progress=print, fast: bool = True) -> int:
    n = 0
    for p in sorted(config.INBOX.glob("*")):
        if not p.is_file() or p.suffix.lower() not in (".pdf", ".docx", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".txt", ".html"):
            continue
        sha = hashlib.sha256(p.read_bytes()).hexdigest()
        did = "inbox-" + sha[:10]
        with db.db() as con:
            if con.execute("SELECT 1 FROM documents WHERE id=?", (did,)).fetchone():
                continue
        if progress:
            progress(f"inbox: {p.name}")
        meta = {"id": did, "title": p.stem.replace("_", " ").replace("-", " "), "sha256": sha, "status": "user-supplied", "notes": "Added from data/raw/inbox"}
        g_no, _, g_lang = gazette_from_url(p.name)
        if g_no:
            meta.update(gazette_no=g_no, language=g_lang)
        info = ingest_file(p, meta, origin="upload", fast=fast, progress=progress)
        n += 1
        if progress:
            progress(f"    {info['pages']} pages, {info['chunks']} chunks")
    return n


# ------------------------------------------------------------------ export
def export_dataset() -> dict:
    with db.db() as con:
        docs = [dict(r) for r in con.execute("SELECT * FROM documents ORDER BY category,id")]
        by_id = {d["id"]: d for d in docs}
        n = 0
        with open(config.JSONL_PATH, "w", encoding="utf-8") as f:
            for r in con.execute("SELECT id,doc_id,page,heading,text,method FROM chunks ORDER BY doc_id,ord"):
                d = by_id.get(r["doc_id"], {})
                f.write(json.dumps({"chunk_id": r["id"], "doc_id": r["doc_id"], "title": d.get("title"), "category": d.get("category"),
                                    "authority": d.get("authority"), "gazette_no": d.get("gazette_no"), "date": d.get("doc_date"),
                                    "status": d.get("status"), "origin": d.get("origin"), "url": d.get("url"), "page": r["page"],
                                    "heading": r["heading"], "method": r["method"], "text": r["text"]}, ensure_ascii=False) + "\n")
                n += 1
    config.DOCS_JSON.write_text(json.dumps(docs, indent=1, ensure_ascii=False))
    return {"chunks": n, "documents": len(docs), "jsonl": str(config.JSONL_PATH)}


# ------------------------------------------------------------------ update
def update(progress=print, discover: bool = True, only: list[str] | None = None, fast: bool = True, force: bool = False) -> dict:
    summary = {"sources": 0, "new": 0, "updated": 0, "unchanged": 0, "errors": [], "discovered_added": 0, "inbox": 0,
               "started": db.now()}
    init_seeds(progress)
    reg = load_registry()
    for src in reg["sources"]:
        if not src.get("enabled", True) or (only and src["id"] not in only):
            continue
        summary["sources"] += 1
        try:
            r = process_source(src, progress=progress, fast=fast, force=force)
        except Exception as e:                                      # one bad file must not stop the run
            r = {"id": src["id"], "result": "error", "error": f"{type(e).__name__}: {e}"}
            _record(src["id"], "error", r["error"])
            if progress:
                progress(f"  {src['id']}: ERROR {r['error']}")
            traceback.print_exc(file=sys.stderr)
        if r["result"] in ("new", "updated", "unchanged"):
            summary[r["result"]] += 1
        else:
            summary["errors"].append({"id": src["id"], "error": r.get("error")})
    if discover and not only:
        for spec in reg["discovery"]:
            if not spec.get("enabled", True):
                continue
            try:
                r = process_listing(spec, progress=progress, fast=fast)
                summary["discovered_added"] += r.get("added", 0)
                if r["result"] == "error":
                    summary["errors"].append({"id": spec["id"], "error": r.get("error")})
            except Exception as e:
                summary["errors"].append({"id": spec["id"], "error": f"{type(e).__name__}: {e}"})
    summary["inbox"] = process_inbox(progress, fast=fast)
    exp = export_dataset()
    summary["finished"] = db.now()
    summary["export"] = exp
    with db.db() as con:
        db.set_meta(con, "last_update", summary["finished"])
        db.set_meta(con, "last_update_summary", {k: summary[k] for k in ("sources", "new", "updated", "unchanged", "discovered_added", "inbox")} | {"errors": len(summary["errors"])})
    if progress:
        progress(f"done: {summary['new']} new, {summary['updated']} updated, {summary['unchanged']} unchanged, "
                 f"{len(summary['errors'])} errors, {summary['discovered_added']} discovered, {summary['inbox']} from inbox")
    return summary


# background job used by the web portal
class Job:
    def __init__(self):
        self.lock = threading.Lock()
        self.state = {"running": False, "log": [], "summary": None, "started": None, "finished": None}

    def start(self, **kw) -> bool:
        with self.lock:
            if self.state["running"]:
                return False
            self.state.update(running=True, log=[], summary=None, started=db.now(), finished=None)

        def log(m):
            with self.lock:
                self.state["log"].append(m)
                self.state["log"] = self.state["log"][-400:]

        def run():
            try:
                s = update(progress=log, **kw)
                with self.lock:
                    self.state["summary"] = s
            except Exception as e:
                log(f"FATAL {type(e).__name__}: {e}")
            finally:
                with self.lock:
                    self.state.update(running=False, finished=db.now())

        threading.Thread(target=run, daemon=True).start()
        return True

    def snapshot(self) -> dict:
        with self.lock:
            return json.loads(json.dumps(self.state))


JOB = Job()


# ------------------------------------------------------------------ CLI
def add_url(url: str, title: str | None = None, category: str | None = None, progress=print) -> dict:
    sid = "user-" + hashlib.sha1(url.encode()).hexdigest()[:10]
    g_no, g_date, g_lang = gazette_from_url(url)
    src = {"id": sid, "kind": "user", "title": title or Path(re.sub(r"[?#].*", "", url)).name or sid, "category": category,
           "authority": None, "gazette_no": g_no, "date": g_date, "language": g_lang, "urls": [url], "status": "user-supplied", "verified": False}
    if not category:
        src.pop("category")
    _save_spec(src)
    r = process_source(src, progress=progress)
    export_dataset()
    return r


def add_listing(url: str, link_regex: str = "", text_regex: str = "", category: str | None = None, max_links: int = 50, progress=print) -> dict:
    spec = {"id": "list-" + hashlib.sha1(url.encode()).hexdigest()[:10], "kind": "listing", "title": url, "page_url": url,
            "link_regex": link_regex, "text_regex": text_regex, "category": category, "max_links": max_links, "enabled": True}
    _save_spec(spec)
    r = process_listing(spec, progress=progress)
    export_dataset()
    return r


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m app.ingest", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init")
    u = sub.add_parser("update")
    u.add_argument("--no-discover", action="store_true")
    u.add_argument("--only", default="", help="comma separated source ids")
    u.add_argument("--accurate-ocr", action="store_true", help="300 dpi instead of the fast 170 dpi")
    u.add_argument("--force", action="store_true", help="re-ingest even when the file is unchanged")
    a = sub.add_parser("add-url")
    a.add_argument("url")
    a.add_argument("--title")
    a.add_argument("--category")
    f = sub.add_parser("add-file")
    f.add_argument("path")
    f.add_argument("--title")
    f.add_argument("--category")
    f.add_argument("--force-ocr", action="store_true")
    f.add_argument("--accurate-ocr", action="store_true")
    l = sub.add_parser("add-listing")
    l.add_argument("url")
    l.add_argument("--regex", default="")
    l.add_argument("--text", default="")
    l.add_argument("--category")
    l.add_argument("--max", type=int, default=50)
    sub.add_parser("export")
    sub.add_parser("stats")
    s = sub.add_parser("search")
    s.add_argument("query")
    args = ap.parse_args(argv)

    if args.cmd == "init":
        with db.db():
            pass
        init_seeds()
        print(json.dumps(export_dataset()))
    elif args.cmd == "update":
        update(discover=not args.no_discover, only=[x for x in args.only.split(",") if x] or None, fast=not args.accurate_ocr, force=args.force)
    elif args.cmd == "add-url":
        print(json.dumps(add_url(args.url, args.title, args.category), indent=1))
    elif args.cmd == "add-file":
        p = Path(args.path)
        sha = hashlib.sha256(p.read_bytes()).hexdigest()
        meta = {"id": "upload-" + sha[:10], "title": args.title or p.stem, "category": args.category, "sha256": sha, "status": "user-supplied"}
        print(json.dumps(ingest_file(p, meta, origin="upload", force_ocr=args.force_ocr, fast=not args.accurate_ocr), indent=1))
        export_dataset()
    elif args.cmd == "add-listing":
        print(json.dumps(add_listing(args.url, args.regex, args.text, args.category, args.max), indent=1))
    elif args.cmd == "export":
        print(json.dumps(export_dataset()))
    elif args.cmd == "stats":
        with db.db() as con:
            print(json.dumps(db.stats(con), indent=1))
    elif args.cmd == "search":
        from . import retrieval
        for r in retrieval.search(args.query, limit=8):
            print(f"[{r['score']:.2f}] {r['title']} p{r['page']} - {r['heading'][:60]}\n    {r['text'][:200].replace(chr(10), ' ')}")


if __name__ == "__main__":
    main()
