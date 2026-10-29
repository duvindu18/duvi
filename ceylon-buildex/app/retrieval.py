"""Passage retrieval over the single dataset: SQLite FTS5 (BM25, porter stemming) + light re-ranking."""
from __future__ import annotations

import re

from . import db

STOP = set("""a an and are as at be but by can do does for from has have how i if in into is it its me my of on or our so than that the their
them then there these they this to us was we were what when where which who whom why will with would you your should could may might shall
about any all also been being both each few more most other some such only own same too very just tell please give many much need needed required require""".split())

# query expansion: short Sri Lankan planning / procurement vocabulary -> phrases the documents actually use
SYN = {
    "far": ["floor area ratio", "FAR"], "plot ratio": ["floor area ratio"], "fsi": ["floor area ratio"],
    "cmc": ["Colombo Municipal Council", "City of Colombo"], "uda": ["Urban Development Authority"],
    "sbd": ["standard bidding document", "bidding document"], "npa": ["National Procurement Agency"],
    "npc": ["National Procurement Commission"], "ncb": ["national competitive bidding"], "icb": ["international competitive bidding"],
    "cida": ["Construction Industry Development Authority"], "ictad": ["Construction Industry Development Authority"],
    "setback": ["building line", "open space", "rear space", "side space"], "setbacks": ["building line", "open space", "rear space"],
    "coverage": ["plot coverage"], "height": ["number of floors", "building height"], "storey": ["floors"], "storeys": ["floors"],
    "perch": ["perches"], "tender": ["bid", "bidding"], "gazette": ["gazette"], "parking": ["parking"],
    "zoning": ["zone", "zones"], "bid": ["bidding"], "guidelines": ["procurement guidelines"],
}
STATUS_W = {"current": 1.0, "reference": 0.95, "verify": 0.95, "check-current": 0.9, "user-supplied": 0.95, "unverified": 0.8, "superseded": 0.6}


def tokens(q: str) -> list[str]:
    return [t for t in re.findall(r"[A-Za-z0-9][A-Za-z0-9./-]*", q.lower()) if t not in STOP and len(t) > 1]


def _quote(t: str) -> str:
    return '"' + t.replace('"', "") + '"'


def build_fts(q: str) -> tuple[str, list[str]]:
    toks = tokens(q)
    parts: list[str] = []
    seen = set()
    for t in toks:
        t2 = t.strip(".-/")
        if not t2 or t2 in seen:
            continue
        seen.add(t2)
        parts.append(_quote(t2))
        for ex in SYN.get(t2, []):
            parts.append(_quote(ex))
    # bigram phrases help ranking ("floor area", "bid security")
    for a, b in zip(toks, toks[1:]):
        parts.append(f'"{a} {b}"')
    for k, exs in SYN.items():
        if " " in k and k in q.lower():
            parts.extend(_quote(e) for e in exs)
    return " OR ".join(dict.fromkeys(parts)), toks


def _rows(con, fts: str, limit: int, category: str | None, only_current: bool):
    sql = ("SELECT c.id AS chunk_id, c.doc_id, c.page, c.heading, c.text, c.method, d.title, d.category, d.authority, d.gazette_no, "
           "d.doc_date, d.status, d.origin, d.url, d.language, bm25(chunks_fts, 1.0, 2.5, 2.0) AS bm "
           "FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN documents d ON d.id = c.doc_id "
           "WHERE chunks_fts MATCH ?")
    args: list = [fts]
    if category and category != "all":
        if category == "gazette":
            sql += " AND d.gazette_no IS NOT NULL AND d.gazette_no != ''"
        else:
            sql += " AND d.category = ?"
            args.append(category)
    if only_current:
        sql += " AND COALESCE(d.status,'') != 'superseded'"
    sql += " ORDER BY bm LIMIT ?"
    args.append(limit)
    return con.execute(sql, args).fetchall()


def search(query: str, limit: int = 8, category: str | None = None, only_current: bool = False, boost: str = "") -> list[dict]:
    fts, toks = build_fts(query + " " + boost if boost else query)
    if not fts:
        return []
    qtoks = set(tokens(query))
    with db.db() as con:
        try:
            rows = _rows(con, fts, 60, category, only_current)
        except Exception:
            return []
    out = []
    low_q = query.lower()
    nums = re.findall(r"\d+(?:[./]\d+)?", low_q)
    for r in rows:
        txt = r["text"]
        low = txt.lower()
        matched = sum(1 for t in qtoks if t in low or t.rstrip("s") in low)
        phrase = sum(1 for a, b in zip(tokens(query), tokens(query)[1:]) if f"{a} {b}" in low)
        numhit = sum(1 for n in nums if n in low)
        base = -float(r["bm"])
        coverage = matched / max(1, len(qtoks))
        score = base * STATUS_W.get(r["status"] or "", 0.9) + 0.6 * phrase + 0.4 * numhit + 3.0 * coverage
        if r["origin"] == "seed-extract":
            score *= 0.97
        out.append({**{k: r[k] for k in r.keys() if k != "bm"}, "score": round(score, 3), "matched_terms": matched,
                    "n_query_terms": len(qtoks)})
    out.sort(key=lambda x: x["score"], reverse=True)
    # drop near-duplicates (same doc+page+heading prefix)
    res, seen = [], set()
    for r in out:
        key = (r["doc_id"], r["page"], r["text"][:80])
        if key in seen:
            continue
        seen.add(key)
        res.append(r)
        if len(res) >= limit:
            break
    return res


def relevant(passages: list[dict]) -> list[dict]:
    """Keep passages that match enough of the query to be worth answering from."""
    keep = []
    for p in passages:
        need = 1 if p["n_query_terms"] <= 2 else 2
        if p["matched_terms"] >= need:
            keep.append(p)
    return keep


def list_documents(category: str | None = None, q: str | None = None, status: str | None = None) -> list[dict]:
    sql = "SELECT id,title,category,authority,gazette_no,doc_date,language,url,pages,n_chunks,ocr_pages,origin,status,notes,fetched_at FROM documents WHERE 1=1"
    args: list = []
    if category and category != "all":
        if category == "gazette":
            sql += " AND gazette_no IS NOT NULL AND gazette_no != ''"
        else:
            sql += " AND category = ?"
            args.append(category)
    if status:
        sql += " AND status = ?"
        args.append(status)
    if q:
        sql += " AND (title LIKE ? OR gazette_no LIKE ? OR authority LIKE ?)"
        args += [f"%{q}%"] * 3
    sql += " ORDER BY CASE status WHEN 'current' THEN 0 WHEN 'verify' THEN 1 ELSE 2 END, doc_date DESC, title"
    with db.db() as con:
        return [dict(r) for r in con.execute(sql, args)]


def get_document(doc_id: str) -> dict | None:
    with db.db() as con:
        r = con.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
        return dict(r) if r else None


def document_chunks(doc_id: str, q: str | None = None, limit: int = 200) -> list[dict]:
    with db.db() as con:
        if q:
            fts, _ = build_fts(q)
            rows = con.execute("SELECT c.id,c.page,c.heading,c.text,c.method FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid "
                               "WHERE chunks_fts MATCH ? AND c.doc_id=? ORDER BY bm25(chunks_fts) LIMIT ?", (fts, doc_id, limit)).fetchall()
        else:
            rows = con.execute("SELECT id,page,heading,text,method FROM chunks WHERE doc_id=? ORDER BY ord LIMIT ?", (doc_id, limit)).fetchall()
        return [dict(r) for r in rows]
