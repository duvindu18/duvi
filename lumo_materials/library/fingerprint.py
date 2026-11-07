"""Fingerprints of source images, to spot a photo or map that is already in the library.

Two checks:
- sha256 of the file bytes: the very same file, under any name.
- dHash (64-bit difference hash of a 9 x 8 greyscale): the same picture re-saved, resized or re-compressed.
  Two pictures count as the same when at most SIMILAR_BITS of the 64 bits differ.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np
from PIL import Image

SIMILAR_BITS = 5          # out of 64; re-encoded JPEGs and resized copies stay well below this
_CHUNK = 1 << 20


def file_sha256(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(_CHUNK)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def _dhash_gray(g: np.ndarray) -> str:
    """g: 8 x 9 float greyscale. Bit = left pixel brighter than its right neighbour."""
    bits = (g[:, :-1] > g[:, 1:]).flatten()
    v = 0
    for b in bits:
        v = (v << 1) | int(b)
    return f"{v:016x}"


def dhash_image(im: Image.Image) -> str:
    if im.mode not in ("L", "RGB", "RGBA", "I;16", "I", "F"):
        im = im.convert("RGB")
    if im.mode in ("I;16", "I", "F"):
        a = np.asarray(im, dtype=np.float32)
        a = (a - a.min()) / max(1e-6, float(a.max() - a.min())) * 255.0
        im = Image.fromarray(a.astype(np.uint8), "L")
    g = im.convert("L")
    # reduce in steps first: Image.reduce is a fast box filter and keeps the result stable across sizes
    while min(g.size) >= 64:
        g = g.reduce(2)
    g = np.asarray(g.resize((9, 8), Image.BILINEAR), dtype=np.float32)
    if float(g.std()) < 2.0:
        return ""                          # a flat picture (plain colour, blank AO) says nothing about identity
    return _dhash_gray(g)


def dhash_file(path: str | Path) -> str:
    with Image.open(path) as im:
        if im.format == "JPEG":
            im.draft("RGB", (256, 256))       # decode a small version only (fast for big photos)
        im.load()
        return dhash_image(im)


def hamming(a: str, b: str) -> int:
    try:
        return bin(int(a, 16) ^ int(b, 16)).count("1")
    except (TypeError, ValueError):
        return 64


def fingerprint(path: str | Path) -> dict:
    """{'name', 'bytes', 'sha256', 'dhash'} of one image file. dhash is '' if the file cannot be decoded."""
    p = Path(path)
    out = {"name": p.name, "bytes": p.stat().st_size, "sha256": file_sha256(p), "dhash": ""}
    try:
        out["dhash"] = dhash_file(p)
    except Exception:
        pass
    return out


def match(fp: dict, known: dict) -> str | None:
    """'identical' (same bytes), 'similar' (same picture), or None."""
    if fp.get("sha256") and fp.get("sha256") == known.get("sha256"):
        return "identical"
    a, b = fp.get("dhash"), known.get("dhash")
    if a and b and hamming(a, b) <= SIMILAR_BITS:
        return "similar"
    return None
