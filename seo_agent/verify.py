"""Verify panel: real marketplace data the user checks by hand, stored locally.

The app never scrapes Fiverr or Upwork (both forbid it). It builds the search links,
the user opens them in their own browser and types in what they see. From those
numbers it ranks keywords and diagnoses gig performance.

Stored as JSON in the per-user data folder (see paths.data_dir()).
"""

from __future__ import annotations

import json
import math
import threading
import time
import urllib.parse
import uuid
from datetime import date

from .paths import data_dir

_lock = threading.Lock()


def _file():
    return data_dir() / "verify.json"


def load() -> dict:
    try:
        data = json.loads(_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    data.setdefault("keywords", {})
    data.setdefault("stats", [])
    return data


def _save(data: dict) -> None:
    tmp = _file().with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(_file())


# --------------------------------------------------------------------------- links

def search_links(keyword: str) -> dict:
    q = urllib.parse.quote_plus(keyword)
    return {
        "fiverr": f"https://www.fiverr.com/search/gigs?query={q}",
        "upwork_jobs": f"https://www.upwork.com/nx/search/jobs/?q={q}",
        "upwork_talent": f"https://www.upwork.com/nx/search/talent/?q={q}",
    }


# --------------------------------------------------------------------------- scoring

def _num(v) -> int | None:
    if v in (None, ""):
        return None
    try:
        n = int(float(str(v).replace(",", "").strip()))
    except ValueError:
        return None
    return max(n, 0)


def _clamp(x: float) -> float:
    return max(0.0, min(1.0, x))


def score_keyword(entry: dict) -> dict:
    """Opportunity score 0-100 from the numbers the user entered.

    Fiverr: demand = the phrase shows up in Fiverr's search suggestions; competition =
    number of gig results (fewer is better, log scale: 10 -> wide open, 100,000 -> saturated).
    Upwork: demand = open jobs (more is better); competition = freelancers found.
    Missing numbers are left out of the average instead of guessed.
    """
    parts: list[float] = []
    fr, sug = _num(entry.get("fiverr_results")), entry.get("fiverr_suggested")
    if fr is not None or sug is not None:
        demand = 40 if sug else (25 if sug is None else 8)
        comp = 60 * (1 - _clamp((math.log10(fr + 1) - 1) / 4)) if fr is not None else 30
        parts.append(demand + comp)
    jobs, talent = _num(entry.get("upwork_jobs")), _num(entry.get("upwork_talent"))
    if jobs is not None or talent is not None:
        demand = 50 * min(1.0, math.log10(jobs + 1) / 3) if jobs is not None else 25
        comp = 50 * (1 - _clamp((math.log10(talent + 1) - 1) / 5)) if talent is not None else 25
        parts.append(demand + comp)
    if not parts:
        return {"score": None, "advice": "Not checked yet", "checked": False}
    s = round(sum(parts) / len(parts))
    if sug is False and (fr or 0) > 20000:
        advice = "Drop - no search suggestion and very crowded"
    elif s >= 70:
        advice = "Strong - use in title or first tag"
    elif s >= 55:
        advice = "Good - use as a tag"
    elif s >= 40:
        advice = "OK - use in description / FAQs"
    else:
        advice = "Weak - only if very relevant"
    return {"score": s, "advice": advice, "checked": True}


def ranked_keywords(data: dict | None = None) -> list[dict]:
    data = data or load()
    rows = []
    for kw, entry in data["keywords"].items():
        rows.append({"keyword": kw, **entry, **score_keyword(entry), "links": search_links(kw)})
    rows.sort(key=lambda r: (r["score"] is None, -(r["score"] or 0), r["keyword"]))
    return rows


def verified_scores() -> dict[str, int]:
    """keyword -> score, only for keywords the user has actually checked."""
    return {r["keyword"]: r["score"] for r in ranked_keywords() if r["score"] is not None}


# --------------------------------------------------------------------------- keyword edits

def upsert_keyword(keyword: str, fields: dict) -> dict:
    kw = " ".join(keyword.lower().split())[:60]
    if not kw:
        raise ValueError("empty keyword")
    with _lock:
        data = load()
        entry = data["keywords"].setdefault(kw, {})
        for key in ("fiverr_results", "upwork_jobs", "upwork_talent"):
            if key in fields:
                entry[key] = _num(fields[key])
        if "fiverr_suggested" in fields:
            v = fields["fiverr_suggested"]
            entry["fiverr_suggested"] = None if v in (None, "") else bool(v)
        if any(k in fields for k in ("fiverr_results", "upwork_jobs", "upwork_talent", "fiverr_suggested")):
            entry["checked_on"] = date.today().isoformat()
        _save(data)
    return data


def add_keywords(keywords: list[str]) -> dict:
    with _lock:
        data = load()
        for k in keywords:
            kw = " ".join(str(k).lower().split())[:60]
            if kw:
                data["keywords"].setdefault(kw, {})
        _save(data)
    return data


def delete_keyword(keyword: str) -> dict:
    with _lock:
        data = load()
        data["keywords"].pop(" ".join(keyword.lower().split()), None)
        _save(data)
    return data


# --------------------------------------------------------------------------- gig stats

def add_stat(fields: dict) -> dict:
    entry = {
        "id": uuid.uuid4().hex[:10],
        "date": str(fields.get("date") or date.today().isoformat())[:10],
        "gig": (str(fields.get("gig") or "My gig").strip() or "My gig")[:80],
        "impressions": _num(fields.get("impressions")) or 0,
        "clicks": _num(fields.get("clicks")) or 0,
        "orders": _num(fields.get("orders")) or 0,
        "note": str(fields.get("note") or "").strip()[:200],
        "created": time.time(),
    }
    with _lock:
        data = load()
        data["stats"].append(entry)
        _save(data)
    return data


def delete_stat(stat_id: str) -> dict:
    with _lock:
        data = load()
        data["stats"] = [s for s in data["stats"] if s.get("id") != stat_id]
        _save(data)
    return data


def _diagnose(imp: int, clicks: int, orders: int) -> str:
    # Rules of thumb for marketplace gigs - a starting point, not platform-published numbers.
    if imp < 100:
        return "Few impressions: buyers aren't seeing the gig. Change tags/title to better-scoring keywords."
    ctr = clicks / imp if imp else 0
    if ctr < 0.01:
        return "Seen but rarely clicked (CTR under 1%): improve the thumbnail, title wording and starting price."
    if clicks >= 20 and orders / clicks < 0.02:
        return "Clicked but few orders (under 2%): tighten description, packages, FAQs and add portfolio images."
    return "Healthy. Keep response time fast, ask happy buyers for reviews, test one change at a time."


def stat_rows(data: dict | None = None) -> list[dict]:
    data = data or load()
    rows = sorted(data["stats"], key=lambda s: (s["gig"].lower(), s["date"], s.get("created", 0)))
    prev: dict[str, dict] = {}
    out = []
    for s in rows:
        imp, clicks, orders = s["impressions"], s["clicks"], s["orders"]
        row = dict(s)
        row["ctr"] = round(100 * clicks / imp, 2) if imp else None
        row["conversion"] = round(100 * orders / clicks, 2) if clicks else None
        row["diagnosis"] = _diagnose(imp, clicks, orders)
        p = prev.get(s["gig"].lower())
        if p:
            row["change"] = {
                "impressions": imp - p["impressions"],
                "ctr": None if row["ctr"] is None or p["ctr"] is None else round(row["ctr"] - p["ctr"], 2),
                "orders": orders - p["orders"],
                "after_change": p.get("note") or "",
            }
        prev[s["gig"].lower()] = row
        out.append(row)
    out.sort(key=lambda r: (r["date"], r.get("created", 0)), reverse=True)
    return out


def snapshot() -> dict:
    data = load()
    return {"keywords": ranked_keywords(data), "stats": stat_rows(data)}
