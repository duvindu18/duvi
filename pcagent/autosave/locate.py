"""Work out which file on disk a window is editing.

Sources, best first:
1. a full path in the window title,
2. files the process has open (Office and AutoCAD keep their documents open),
3. a search of the configured project folders by name.
"""
from __future__ import annotations

import os
import re
from pathlib import Path, PureWindowsPath
from typing import Iterable

# Window-title decorations that are not part of the document name.
_DECORATIONS = re.compile(
    r"\s*[\[(](?:compatibility mode|read-only|protected view|autorecovered|"
    r"shared|group|repaired|recovered|saved|saving\W*)[\])]",
    re.IGNORECASE,
)
_STATUS_SUFFIX = re.compile(
    r"\s*[-\u2013\u2022]\s*(?:saved(?: to this pc| to onedrive)?|saving\W*|"
    r"compatibility mode|read-only|autosave (?:on|off))\s*$",
    re.IGNORECASE,
)
_BAD_CHARS = r'\[\]\\/:*?"<>|'   # not allowed in a bare file name
_PATH_CHARS = r'[^\[\]*?"<>|]'     # allowed in a full path


def doc_name_from_title(title: str, extensions: Iterable[str]) -> str | None:
    """Best guess of the document name ("plan.dwg", "Budget") from a window title."""
    title = title.strip().lstrip("*").strip()
    if not title:
        return None
    exts = [e.lstrip(".") for e in extensions]
    if exts:
        ext_alt = "|".join(re.escape(e) for e in exts)
        # full path in the title, e.g. "AutoCAD - [C:\Work\plan.dwg]"
        m = re.findall(rf"([A-Za-z]:\\{_PATH_CHARS}*?\.(?:{ext_alt}))(?![A-Za-z0-9])", title, re.IGNORECASE)
        if m:
            return m[-1].strip()
        # bare file name with extension, e.g. "Autodesk AutoCAD 2025 - [plan.dwg]"
        m = re.findall(rf"([^{_BAD_CHARS}]+?\.(?:{ext_alt}))(?![A-Za-z0-9])", title, re.IGNORECASE)
        if m:
            name = m[-1].strip()
            name = re.split(r"\s+-\s+", name)[-1].strip()
            return name.strip("* ")
    # "Budget - Excel", "Report  -  Compatibility Mode - Word"
    t = _DECORATIONS.sub("", title)
    parts = [p.strip() for p in re.split(r"\s+[-\u2013]\s+", t) if p.strip()]
    if not parts:
        return None
    name = parts[0]
    while True:
        stripped = _STATUS_SUFFIX.sub("", name)
        if stripped == name:
            break
        name = stripped
    return name.strip("* ") or None


def _norm(s: str) -> str:
    return s.strip().lower()


def name_matches(doc: str, path: str | os.PathLike, extensions: Iterable[str]) -> bool:
    """True if `path` looks like the file for document name `doc`."""
    p = PureWindowsPath(str(path))
    doc_p = PureWindowsPath(doc)
    exts = {e.lower() for e in extensions}
    if p.suffix.lower() not in exts:
        return False
    if doc_p.suffix.lower() in exts:
        if len(doc_p.parts) > 1:  # full path given
            return _norm(str(doc_p)) == _norm(str(p))
        return _norm(doc_p.name) == _norm(p.name)
    return _norm(doc) == _norm(p.stem)


def candidates_from_open_files(doc: str | None, open_files: Iterable[str],
                               extensions: Iterable[str]) -> list[str]:
    exts = [e.lower() for e in extensions]
    docs = [f for f in open_files
            if PureWindowsPath(f).suffix.lower() in exts
            and not PureWindowsPath(f).name.startswith("~$")]
    if doc:
        hits = [f for f in docs if name_matches(doc, f, exts)]
        if hits:
            return _unique(hits)
    if doc is None and docs:  # title gave nothing; the app's open documents are all we know
        return _unique(docs)
    return []


def search_dirs(doc: str, dirs: Iterable[Path], extensions: Iterable[str],
                max_depth: int = 4, limit: int = 5) -> list[str]:
    """Find files named like `doc` under `dirs`, newest first."""
    exts = [e.lower() for e in extensions]
    found: list[tuple[float, str]] = []
    for root in dirs:
        for path in _walk(Path(root), max_depth):
            if name_matches(doc, path, exts):
                try:
                    found.append((path.stat().st_mtime, str(path)))
                except OSError:
                    pass
    found.sort(reverse=True)
    return [p for _, p in found[:limit]]


def recently_modified(dirs: Iterable[Path], extensions: Iterable[str], since: float,
                      max_depth: int = 4) -> list[str]:
    """Files of these types modified at/after `since` (epoch seconds)."""
    exts = {e.lower() for e in extensions}
    out = []
    for root in dirs:
        for path in _walk(Path(root), max_depth):
            if path.suffix.lower() in exts:
                try:
                    if path.stat().st_mtime >= since:
                        out.append(str(path))
                except OSError:
                    pass
    return out


def _walk(root: Path, max_depth: int):
    if not root.is_dir():
        return
    stack = [(root, 0)]
    while stack:
        d, depth = stack.pop()
        try:
            with os.scandir(d) as it:
                for e in it:
                    if e.name.startswith((".", "$", "~$")):
                        continue
                    try:
                        if e.is_dir(follow_symlinks=False):
                            if depth < max_depth:
                                stack.append((Path(e.path), depth + 1))
                        elif e.is_file():
                            yield Path(e.path)
                    except OSError:
                        continue
        except OSError:
            continue


def _unique(items: list[str]) -> list[str]:
    seen, out = set(), []
    for i in items:
        k = _norm(i)
        if k not in seen:
            seen.add(k)
            out.append(i)
    return out
