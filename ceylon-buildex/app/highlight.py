"""Key-fact markers for answers.

The page highlights the facts a reader must not miss (a limit, a value, a date, a condition). Those facts are marked in the answer text with
double equals signs: ``the ==maximum FAR is 5.0== here``. A language model is asked to place the markers itself; when it does not (or when
no model is used) the facts are found by pattern: values with units, percentages, money, ratios and dates. Only text that is already in
the answer is marked - nothing is added, reworded or invented.
"""
from __future__ import annotations

import re

_NUM = r"\d[\d,]*(?:\.\d+)?"
_UNIT = (r"(?:%|per ?cent|percent|m2|m²|sq\.? ?m|sq\.? ?ft|sqft|ft|feet|foot|metres?|meters?|km|m|perch(?:es)?|storeys?|stories|floors?|"
         r"rooms?|days?|weeks?|months?|years?|hectares?|acres?|million|billion|lakhs?|mn|bn)")
_MONTH = r"(?:January|February|March|April|May|June|July|August|September|October|November|December)"
_PATTERNS = [
    rf"(?:Rs\.?|LKR|USD|US\$)\s?{_NUM}(?:\s?(?:million|billion|lakhs?|mn|bn))?",
    rf"(?:permissible |maximum |max\.? |minimum |min\.? )?FAR(?: of| is| =|:)?\s?{_NUM}",
    rf"\b\d{{1,2}}(?:st|nd|rd|th)? {_MONTH} \d{{4}}\b",
    rf"\b{_NUM} (?:[a-z]+ ){{0,2}}per {_NUM} [a-z]+",
    rf"(?:\b(?:up to|at least|at most|not more than|not less than|under|over|more than|less than) )?\b{_NUM}(?:\s?(?:-|–|to under|and under|to)\s?{_NUM})?\s?{_UNIT}(?![A-Za-z0-9²])",
]
_FACT = re.compile("|".join(f"(?:{p})" for p in _PATTERNS), re.I)
_CITE = re.compile(r"(\[S\d+\])")
_SKIP_PARA = re.compile(r"^\s*(?:check before relying|regime:|note:|#{1,3}\s)", re.I)
_MARKED = re.compile(r"==([^=\n]{1,120}?)==")

MAX_TOTAL = 6
MAX_PER_PARAGRAPH = 3


def strip(text: str) -> str:
    """Remove the markers, keeping the words."""
    return _MARKED.sub(r"\1", text or "")


def _sanitize(text: str) -> str:
    """Keep well-formed markers from a model; drop anything stray (unbalanced, empty, or swallowing a citation tag)."""
    def keep(m):
        inner = m.group(1).strip()
        return f"=={inner}==" if inner and "[S" not in inner else m.group(1)
    return _drop_stray(_MARKED.sub(keep, text))


def _drop_stray(text: str) -> str:
    res, i = [], 0
    for m in _MARKED.finditer(text):
        res.append(text[i:m.start()].replace("==", ""))
        res.append(m.group(0))
        i = m.end()
    res.append(text[i:].replace("==", ""))
    return "".join(res)


def _spans(paragraph: str, room: int) -> list[tuple[int, int]]:
    found: list[tuple[int, int]] = []
    pos = 0
    for part in _CITE.split(paragraph):
        if not _CITE.fullmatch(part):
            for m in _FACT.finditer(part):
                s, e = pos + m.start(), pos + m.end()
                if e - s >= 2:
                    found.append((s, e))
        pos += len(part)
    merged: list[list[int]] = []
    for s, e in found:
        if merged and re.fullmatch(r"[ \-/]?", paragraph[merged[-1][1]:s]):
            merged[-1][1] = e
        else:
            merged.append([s, e])
    return [(s, e) for s, e in merged][:min(room, MAX_PER_PARAGRAPH)]


def mark_facts(text: str) -> str:
    """Wrap the key facts found by pattern in ==..== (at most MAX_TOTAL for the whole answer)."""
    budget = MAX_TOTAL
    out: list[str] = []
    for para in re.split(r"(\n{2,})", text or ""):
        if budget <= 0 or not para.strip() or para.startswith("\n") or _SKIP_PARA.match(para):
            out.append(para)
            continue
        spans = _spans(para, budget)
        budget -= len(spans)
        res, last = [], 0
        for s, e in spans:
            res.append(para[last:s])
            res.append(f"=={para[s:e].strip()}==")
            last = e
        res.append(para[last:])
        out.append("".join(res))
    return "".join(out)


def prepare(text: str) -> str:
    """The text the page receives: the model's own markers if it placed any, otherwise pattern-found ones."""
    text = text or ""
    if "==" in text:
        text = _sanitize(text)
        if _MARKED.search(text):
            return text
    return mark_facts(text)
