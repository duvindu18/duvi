"""Fast OCR: Tesseract LSTM, one process per page in parallel, results cached by image hash.

Speed levers (all on by default in `fast` mode):
  * the PDF text layer is used first (see extract.py) - only image-only pages reach this module
  * pages are rendered at ~170 dpi in greyscale instead of 300 dpi colour
  * one single-threaded tesseract process per CPU core (OMP_THREAD_LIMIT=1) beats one multi-threaded process
  * a content-hash cache means a page is never OCR'd twice (re-runs of `update` are instant)
  * low-confidence pages are retried once after OSD-based rotation detection
"""
from __future__ import annotations

import concurrent.futures as cf
import hashlib
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from PIL import Image, ImageOps

from . import config, db

_ENV = dict(os.environ, OMP_THREAD_LIMIT="1")


def tesseract_available() -> bool:
    return shutil.which("tesseract") is not None


def installed_langs() -> list[str]:
    if not tesseract_available():
        return []
    out = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True).stdout.splitlines()
    return [x.strip() for x in out[1:] if x.strip() and x.strip() != "osd"]


def effective_lang(lang: str | None = None) -> str:
    """Only request languages that are actually installed (falls back to eng)."""
    want = (lang or config.OCR_LANGS).split("+")
    have = set(installed_langs())
    ok = [l for l in want if l in have]
    return "+".join(ok) if ok else ("eng" if "eng" in have or not have else sorted(have)[0])


def _prep(src: Path, dst: Path, fast: bool) -> None:
    im = Image.open(src)
    im = ImageOps.exif_transpose(im)
    im = im.convert("L")
    w, h = im.size
    if max(w, h) < 1600:                       # small phone crops / thumbnails: upscale for legibility
        f = 2 if max(w, h) < 900 else 1.5
        im = im.resize((int(w * f), int(h * f)), Image.LANCZOS)
    elif max(w, h) > 4200:                     # huge scans: shrink, tesseract gains nothing above ~300 dpi
        f = 4200 / max(w, h)
        im = im.resize((int(w * f), int(h * f)), Image.LANCZOS)
    # stretch contrast from the background side only: on sparse pages (a short notice, a cover) the ink is well under 1% of the
    # pixels, so clipping the dark end would erase the text itself
    im = ImageOps.autocontrast(im, cutoff=(0, 1))
    im.save(dst, format="PNG", optimize=False, compress_level=1)


def _parse_tsv(tsv: str) -> tuple[str, float]:
    lines: dict[tuple, list[str]] = {}
    confs = []
    order = []
    for row in tsv.splitlines()[1:]:
        p = row.split("\t")
        if len(p) < 12 or p[0] != "5":
            continue
        word = p[11].strip()
        if not word:
            continue
        try:
            conf = float(p[10])
        except ValueError:
            conf = -1
        key = (p[2], p[3], p[4])
        if key not in lines:
            lines[key] = []
            order.append(key)
        lines[key].append(word)
        if conf >= 0:
            confs.append(conf)
    # blank line between paragraphs
    out, last_par = [], None
    for key in order:
        par = key[:2]
        if last_par is not None and par != last_par:
            out.append("")
        out.append(" ".join(lines[key]))
        last_par = par
    return "\n".join(out), (sum(confs) / len(confs) if confs else 0.0)


def _run_tesseract(img: Path, lang: str, psm: int, rotate: int = 0) -> tuple[str, float]:
    cmd = ["tesseract", str(img), "stdout", "-l", lang, "--oem", "1", "--psm", str(psm), "tsv"]
    r = subprocess.run(cmd, capture_output=True, text=True, env=_ENV, timeout=300)
    if r.returncode != 0 and not r.stdout:
        raise RuntimeError(f"tesseract failed: {r.stderr[:300]}")
    return _parse_tsv(r.stdout)


def _osd_angle(img: Path) -> int:
    r = subprocess.run(["tesseract", str(img), "stdout", "--psm", "0"], capture_output=True, text=True, env=_ENV, timeout=120)
    m = re.search(r"Rotate:\s*(\d+)", r.stdout or "")
    return int(m.group(1)) if m else 0


def _cache_get(key: str):
    try:
        with db.db() as con:
            r = con.execute("SELECT text, conf FROM ocr_cache WHERE key=?", (key,)).fetchone()
            return (r["text"], r["conf"]) if r else None
    except Exception:
        return None


def _cache_put(key: str, text: str, conf: float) -> None:
    try:
        with db.db() as con:
            con.execute("INSERT OR REPLACE INTO ocr_cache(key,text,conf,created) VALUES(?,?,?,?)", (key, text, conf, db.now()))
    except Exception:
        pass


def ocr_image(path: str | Path, lang: str | None = None, fast: bool = True, psm: int = 3, cache: bool = True,
              auto_rotate: bool = True) -> dict:
    """OCR one image file. Returns {text, conf, seconds, cached}."""
    t0 = time.time()
    lang = effective_lang(lang)
    path = Path(path)
    with tempfile.TemporaryDirectory() as td:
        prepped = Path(td) / "p.png"
        _prep(path, prepped, fast)
        key = hashlib.sha1(prepped.read_bytes() + f"|{lang}|{psm}".encode()).hexdigest()
        if cache:
            hit = _cache_get(key)
            if hit:
                return {"text": hit[0], "conf": round(hit[1], 1), "seconds": round(time.time() - t0, 2), "cached": True}
        text, conf = _run_tesseract(prepped, lang, psm)
        if auto_rotate and conf < 55:
            try:
                ang = _osd_angle(prepped)
            except Exception:
                ang = 0
            if ang in (90, 180, 270):
                rot = Path(td) / "r.png"
                Image.open(prepped).rotate(-ang, expand=True).save(rot)
                t2, c2 = _run_tesseract(rot, lang, psm)
                if c2 > conf:
                    text, conf = t2, c2
        if cache:
            _cache_put(key, text, conf)
    return {"text": text, "conf": round(conf, 1), "seconds": round(time.time() - t0, 2), "cached": False}


def render_pdf_page(pdf: Path, page: int, dpi: int, out_dir: Path) -> Path:
    prefix = out_dir / f"pg{page}"
    subprocess.run(["pdftoppm", "-f", str(page), "-l", str(page), "-r", str(dpi), "-gray", "-png", "-singlefile", str(pdf), str(prefix)],
                   check=True, capture_output=True, timeout=300)
    return prefix.with_suffix(".png")


def ocr_pdf_pages(pdf: str | Path, pages: list[int], lang: str | None = None, fast: bool = True, workers: int | None = None,
                  progress=None) -> dict[int, dict]:
    """OCR the given 1-based pages of a PDF in parallel."""
    pdf = Path(pdf)
    dpi = config.OCR_DPI_FAST if fast else config.OCR_DPI_ACCURATE
    workers = workers or config.OCR_WORKERS
    results: dict[int, dict] = {}
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)

        def one(pg: int):
            img = None
            try:
                img = render_pdf_page(pdf, pg, dpi, tdp)
                return pg, ocr_image(img, lang=lang, fast=fast)
            except Exception as e:  # a bad page must not kill the whole document
                return pg, {"text": "", "conf": 0.0, "seconds": 0, "cached": False, "error": str(e)[:200]}
            finally:
                if img is not None:
                    try:
                        img.unlink()
                    except OSError:
                        pass

        with cf.ThreadPoolExecutor(max_workers=workers) as ex:
            futs = [ex.submit(one, p) for p in pages]
            done = 0
            for f in cf.as_completed(futs):
                pg, r = f.result()
                results[pg] = r
                done += 1
                if progress:
                    progress(done, len(pages))
    return results
