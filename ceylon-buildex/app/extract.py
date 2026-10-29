"""Text extraction: PDF text layer first, OCR only for pages that need it; DOCX, HTML, TXT, images; chunking."""
from __future__ import annotations

import html
import re
import subprocess
import zipfile
from dataclasses import dataclass
from pathlib import Path

from . import config, ocr


@dataclass
class PageText:
    page: int
    text: str
    method: str            # text | ocr
    conf: float | None = None


_HEADING = re.compile(
    r"^(?:PART|Part|SECTION|Section|CHAPTER|Chapter|SCHEDULE|Schedule|FORM|Form|REGULATION|Regulation|ANNEXURE|Annexure|"
    r"Instructions to Bidders|Bidding Data|Conditions of Contract|Evaluation and Qualification)\b.{0,110}$|"
    r"^\d{1,3}(?:\.\d{1,3}){0,3}[.)]?\s+[A-Z][^\n]{3,100}$")


def clean(text: str) -> str:
    text = text.replace("\r", "").replace("\x0c", "\n")
    text = re.sub(r"-\n(?=[a-z])", "", text)                 # de-hyphenate line wraps
    text = "\n".join(re.sub(r"[ \t]{3,}", "  ", ln).rstrip() for ln in text.split("\n"))
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def looks_garbled(text: str) -> bool:
    """Legacy-font Sinhala/Tamil text layers decode to ASCII noise; detect it so those pages get OCR'd instead."""
    t = re.sub(r"\s", "", text)
    if len(t) < 40:
        return False
    odd = sum(1 for c in t if c in ";%§Ü{}|\\<>^~@#")
    alpha = sum(1 for c in t if c.isalpha())
    return odd / len(t) > 0.04 or alpha / len(t) < 0.45


# ------------------------------------------------------------------ PDF
def pdf_text_layer(path: Path) -> list[str]:
    r = subprocess.run(["pdftotext", "-layout", str(path), "-"], capture_output=True, timeout=600)
    txt = r.stdout.decode("utf-8", "replace")
    pages = txt.split("\x0c")
    if pages and not pages[-1].strip():
        pages = pages[:-1]
    return pages


def extract_pdf(path: Path, force_ocr: bool = False, fast: bool = True, lang: str | None = None, progress=None,
                check_garbled: bool = True) -> list[PageText]:
    layer = pdf_text_layer(path)
    out: dict[int, PageText] = {}
    need: list[int] = []
    for i, t in enumerate(layer, start=1):
        c = clean(t)
        bad = len(re.sub(r"\s", "", c)) < config.MIN_TEXT_CHARS_PER_PAGE or (check_garbled and looks_garbled(c))
        if force_ocr or bad:
            need.append(i)
        else:
            out[i] = PageText(i, c, "text")
    if need and ocr.tesseract_available():
        res = ocr.ocr_pdf_pages(path, need, lang=lang, fast=fast, progress=progress)
        for pg, r in res.items():
            txt = clean(r.get("text", ""))
            # keep the text layer if OCR found less than the layer already had
            prev = clean(layer[pg - 1]) if pg - 1 < len(layer) else ""
            if len(txt) < len(prev) * 0.5 and prev and not looks_garbled(prev):
                out[pg] = PageText(pg, prev, "text")
            else:
                out[pg] = PageText(pg, txt, "ocr", r.get("conf"))
    else:
        for pg in need:
            out[pg] = PageText(pg, clean(layer[pg - 1]) if pg - 1 < len(layer) else "", "text")
    return [out[k] for k in sorted(out)]


# ------------------------------------------------------------------ other formats
def extract_docx(path: Path) -> list[PageText]:
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8", "replace")
    xml = re.sub(r"</w:p>", "\n", xml)
    xml = re.sub(r"</w:tc>", "\t", xml)
    xml = re.sub(r"</w:tr>", "\n", xml)
    xml = re.sub(r"<w:br[^>]*/>", "\n", xml)
    txt = html.unescape(re.sub(r"<[^>]+>", "", xml))
    return [PageText(1, clean(txt), "text")]


def extract_html(path: Path) -> list[PageText]:
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(path.read_bytes(), "html.parser")
    for t in soup(["script", "style", "nav", "footer", "header"]):
        t.decompose()
    return [PageText(1, clean(soup.get_text("\n")), "text")]


def extract_image(path: Path, fast: bool = True, lang: str | None = None) -> list[PageText]:
    r = ocr.ocr_image(path, lang=lang, fast=fast)
    return [PageText(1, clean(r["text"]), "ocr", r.get("conf"))]


def extract_any(path: str | Path, force_ocr: bool = False, fast: bool = True, lang: str | None = None, progress=None) -> list[PageText]:
    path = Path(path)
    ext = path.suffix.lower()
    if ext == ".pdf":
        return extract_pdf(path, force_ocr=force_ocr, fast=fast, lang=lang, progress=progress)
    if ext == ".docx":
        return extract_docx(path)
    if ext in (".html", ".htm"):
        return extract_html(path)
    if ext in (".txt", ".md", ".csv"):
        return [PageText(1, clean(path.read_text(errors="replace")), "text")]
    if ext in (".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp", ".gif"):
        return extract_image(path, fast=fast, lang=lang)
    raise ValueError(f"unsupported file type: {ext}")


# ------------------------------------------------------------------ chunking
def chunk_pages(pages: list[PageText], target: int = 1100, overlap: int = 150) -> list[dict]:
    """Split pages into retrieval chunks of ~target characters, never crossing a page, tracking the last heading seen."""
    chunks: list[dict] = []
    heading = ""
    for pg in pages:
        blocks = [b for b in re.split(r"\n\s*\n", pg.text) if b.strip()]
        buf: list[str] = []
        size = 0
        fresh = False                          # does buf hold new text (not only the overlap carried from the previous chunk)?
        start_heading = heading

        def flush():
            nonlocal buf, size, start_heading, fresh
            tail = ""
            if buf and fresh:
                txt = "\n\n".join(buf).strip()
                if len(txt) > 20:
                    chunks.append({"page": pg.page, "heading": start_heading, "text": txt, "method": pg.method})
                tail = txt[-overlap:] if overlap and len(txt) > target else ""
            buf, size, fresh = ([tail] if tail else []), len(tail), False
            start_heading = heading

        for b in blocks:
            first = b.strip().split("\n", 1)[0].strip()
            if _HEADING.match(first):
                heading = first[:120]
                if size > target * 0.5:
                    flush()
                    start_heading = heading
                elif not buf:
                    start_heading = heading
            # hard-split very long blocks (dense tables / OCR'd paragraphs)
            while len(b) > target * 1.3:
                cut = b.rfind("\n", 0, target)
                cut = cut if cut > target * 0.4 else b.rfind(" ", 0, target)
                cut = cut if cut > 0 else target
                if size + cut > target * 1.3:
                    flush()
                buf.append(b[:cut].strip())
                size += cut
                fresh = True
                flush()
                b = b[cut:]
            if size + len(b) > target * 1.3:
                flush()
            buf.append(b.strip())
            size += len(b)
            fresh = True
        flush()
    return chunks
