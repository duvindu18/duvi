"""Polite, resumable-by-hash downloader with conditional GET (ETag / Last-Modified) and link discovery."""
from __future__ import annotations

import hashlib
import re
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

from . import config

_last_hit: dict[str, float] = {}
_session: requests.Session | None = None

DOC_EXT = (".pdf", ".docx", ".doc", ".xlsx", ".xls")


def session() -> requests.Session:
    global _session
    if _session is None:
        s = requests.Session()
        s.headers.update({"User-Agent": config.USER_AGENT, "Accept": "application/pdf,application/octet-stream,text/html;q=0.8,*/*;q=0.5"})
        _session = s
    return _session


def _polite(url: str) -> None:
    host = urlparse(url).netloc
    wait = config.POLITE_DELAY - (time.time() - _last_hit.get(host, 0))
    if wait > 0:
        time.sleep(wait)
    _last_hit[host] = time.time()


def _explain(e: Exception) -> str:
    msg = str(e)
    if "403" in msg and ("CONNECT" in msg or "tunnel" in msg.lower() or "proxy" in msg.lower()):
        return "network policy blocked this host (HTTP 403 from the egress proxy)"
    if "Name or service not known" in msg or "NameResolution" in msg or "getaddrinfo" in msg:
        return "DNS lookup failed (offline or host unknown)"
    if "timed out" in msg.lower():
        return "request timed out"
    return msg[:200]


def fetch(url: str, dest: Path, etag: str | None = None, last_modified: str | None = None, prev_sha: str | None = None,
          expect_pdf: bool = True, retries: int = 3) -> dict:
    """Download `url` to `dest`. Returns {status: new|updated|unchanged|error, ...}."""
    headers = {}
    if etag:
        headers["If-None-Match"] = etag
    if last_modified:
        headers["If-Modified-Since"] = last_modified
    last_err = ""
    for attempt in range(retries):
        try:
            _polite(url)
            r = session().get(url, headers=headers, stream=True, timeout=config.HTTP_TIMEOUT, allow_redirects=True)
            if r.status_code == 304:
                return {"status": "unchanged", "http": 304, "path": str(dest) if dest.exists() else None, "sha256": prev_sha,
                        "etag": etag, "last_modified": last_modified}
            if r.status_code in (429, 500, 502, 503, 504):
                last_err = f"HTTP {r.status_code}"
                time.sleep(2 ** attempt * 2)
                continue
            if r.status_code != 200:
                return {"status": "error", "http": r.status_code, "error": f"HTTP {r.status_code}"}
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_suffix(dest.suffix + ".part")
            h = hashlib.sha256()
            total = 0
            limit = config.MAX_DOWNLOAD_MB * 1024 * 1024
            with open(tmp, "wb") as f:
                for chunk in r.iter_content(65536):
                    if not chunk:
                        continue
                    total += len(chunk)
                    if total > limit:
                        f.close()
                        tmp.unlink(missing_ok=True)
                        return {"status": "error", "error": f"file larger than {config.MAX_DOWNLOAD_MB} MB limit"}
                    f.write(chunk)
                    h.update(chunk)
            head = tmp.read_bytes()[:2048].lstrip()
            ctype = r.headers.get("Content-Type", "")
            if expect_pdf and not head.startswith(b"%PDF"):
                is_html = head[:15].lower().startswith((b"<!doctype html", b"<html")) or "html" in ctype.lower()
                if is_html or total < 1024:
                    tmp.unlink(missing_ok=True)
                    return {"status": "error", "error": "server returned a web page instead of a document"}
            sha = h.hexdigest()
            if prev_sha and sha == prev_sha and dest.exists():
                tmp.unlink(missing_ok=True)
                return {"status": "unchanged", "http": 200, "path": str(dest), "sha256": sha,
                        "etag": r.headers.get("ETag"), "last_modified": r.headers.get("Last-Modified")}
            tmp.replace(dest)
            return {"status": "updated" if prev_sha else "new", "http": 200, "path": str(dest), "sha256": sha, "bytes": total,
                    "etag": r.headers.get("ETag"), "last_modified": r.headers.get("Last-Modified"), "content_type": ctype}
        except requests.RequestException as e:
            last_err = _explain(e)
            if "blocked" in last_err or "DNS" in last_err:
                break
            time.sleep(2 ** attempt)
    return {"status": "error", "error": last_err or "download failed"}


def discover_links(page_url: str, link_regex: str | None = None, text_regex: str | None = None,
                   all_languages: bool = False, max_links: int = 200) -> dict:
    """Find document links on a listing page. Filters on the link URL/text *and* the surrounding table row."""
    try:
        _polite(page_url)
        r = session().get(page_url, timeout=config.HTTP_TIMEOUT)
        if r.status_code != 200:
            return {"links": [], "error": f"HTTP {r.status_code}"}
    except requests.RequestException as e:
        return {"links": [], "error": _explain(e)}
    soup = BeautifulSoup(r.content, "html.parser")
    lre = re.compile(link_regex, re.I) if link_regex else None
    tre = re.compile(text_regex, re.I) if text_regex else None
    seen, out = set(), []
    for a in soup.find_all("a", href=True):
        url = urljoin(page_url, a["href"].strip())
        path = urlparse(url).path.lower()
        is_doc = path.endswith(DOC_EXT) or "/api/file/" in path
        if not is_doc and not (lre and lre.search(url)):
            continue
        if not all_languages and re.search(r"_(?:S|T)\.pdf$", path, re.I):
            continue                                   # gazettes come as _E / _S / _T: keep English
        row = a.find_parent("tr")
        ctx = " ".join([a.get_text(" ", strip=True), a.get("title", ""), row.get_text(" ", strip=True) if row else "",
                        a.parent.get_text(" ", strip=True) if a.parent else ""])
        if lre and not lre.search(url) and not lre.search(ctx):
            continue
        if tre and not (tre.search(ctx) or tre.search(url)):
            continue
        if url in seen:
            continue
        seen.add(url)
        title = (a.get_text(" ", strip=True) or (row.get_text(" ", strip=True)[:140] if row else "") or Path(path).name)
        out.append({"url": url, "text": re.sub(r"\s+", " ", title)[:200], "context": re.sub(r"\s+", " ", ctx)[:300]})
        if len(out) >= max_links:
            break
    return {"links": out, "error": None}
