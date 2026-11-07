"""Reading and writing images as float32 arrays."""
from __future__ import annotations

import os
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

# Large photos are fine; this only stops decompression bombs (about 400 megapixels).
Image.MAX_IMAGE_PIXELS = 400_000_000

PHOTO_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".tga")
MAX_UPLOAD_BYTES = 120 * 1024 * 1024


class ImageError(ValueError):
    """The file is missing, too big, or not a readable image."""


def _to_float(im: Image.Image) -> np.ndarray:
    mode = im.mode
    if mode in ("I;16", "I;16B", "I;16L"):
        a = np.asarray(im, dtype=np.uint16).astype(np.float32) / 65535.0
    elif mode == "I":
        a = np.asarray(im, dtype=np.int32).astype(np.float32)
        a = a / 65535.0 if a.max() > 255 else a / 255.0
    elif mode == "F":
        a = np.asarray(im, dtype=np.float32)
        mx = float(a.max()) if a.size else 1.0
        if mx > 1.0:
            a = a / mx
    else:
        if mode not in ("L", "RGB"):
            im = im.convert("RGBA" if "A" in mode or mode == "P" else "RGB")
            if im.mode == "RGBA":
                im = im.convert("RGB")
        a = np.asarray(im, dtype=np.uint8).astype(np.float32) / 255.0
    return np.clip(a, 0.0, 1.0)


def open_image(path: str | os.PathLike) -> Image.Image:
    p = Path(path)
    if not p.is_file():
        raise ImageError(f"File not found: {p}")
    if p.stat().st_size > MAX_UPLOAD_BYTES:
        raise ImageError(f"{p.name} is larger than 120 MB.")
    try:
        im = Image.open(p)
        im.load()
    except Exception as e:  # Pillow raises many types
        raise ImageError(f"{p.name} is not a readable image ({e}).") from e
    try:
        im = ImageOps.exif_transpose(im)
    except Exception:
        pass
    return im


def load_rgb(path: str | os.PathLike) -> np.ndarray:
    """Any supported image as (H, W, 3) float32 0..1."""
    a = _to_float(open_image(path))
    if a.ndim == 2:
        a = np.repeat(a[..., None], 3, axis=2)
    return np.ascontiguousarray(a[..., :3], dtype=np.float32)


def load_gray(path: str | os.PathLike) -> np.ndarray:
    """Any supported image as (H, W) float32 0..1 (colour images use their luminance)."""
    a = _to_float(open_image(path))
    if a.ndim == 3:
        a = luminance(a[..., :3])
    return np.ascontiguousarray(a, dtype=np.float32)


def luminance(rgb: np.ndarray) -> np.ndarray:
    return (rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722).astype(np.float32)


def resize(a: np.ndarray, width: int, height: int) -> np.ndarray:
    """High-quality resize of a float image (2-D or 3-D)."""
    if a.shape[1] == width and a.shape[0] == height:
        return a.astype(np.float32, copy=True)
    method = Image.LANCZOS if (width < a.shape[1] or height < a.shape[0]) else Image.BICUBIC
    if a.ndim == 2:
        return np.clip(np.asarray(Image.fromarray(a.astype(np.float32), "F").resize((width, height), method)), 0, 1)
    chans = [np.asarray(Image.fromarray(a[..., c].astype(np.float32), "F").resize((width, height), method))
             for c in range(a.shape[2])]
    return np.clip(np.stack(chans, axis=2), 0, 1).astype(np.float32)


def fit_within(a: np.ndarray, max_edge: int) -> np.ndarray:
    h, w = a.shape[:2]
    m = max(h, w)
    if m <= max_edge:
        return a
    s = max_edge / m
    return resize(a, max(1, round(w * s)), max(1, round(h * s)))


def square_crop(a: np.ndarray) -> np.ndarray:
    h, w = a.shape[:2]
    s = min(h, w)
    y, x = (h - s) // 2, (w - s) // 2
    return a[y:y + s, x:x + s]


def to_uint8(a: np.ndarray) -> np.ndarray:
    return (np.clip(a, 0, 1) * 255.0 + 0.5).astype(np.uint8)


def to_uint16(a: np.ndarray) -> np.ndarray:
    return (np.clip(a, 0, 1) * 65535.0 + 0.5).astype(np.uint16)


def _atomic_save(im: Image.Image, path: Path, **kw) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    im.save(tmp, format=kw.pop("format"), **kw)
    os.replace(tmp, path)


def save_png8(a: np.ndarray, path: str | os.PathLike) -> None:
    u = to_uint8(a)
    _atomic_save(Image.fromarray(u, "L" if u.ndim == 2 else "RGB"), Path(path), format="PNG", compress_level=6)


def save_png16(gray: np.ndarray, path: str | os.PathLike) -> None:
    if gray.ndim != 2:
        raise ValueError("16-bit PNG export is for single-channel maps")
    u = to_uint16(gray)
    im = Image.frombytes("I;16", (u.shape[1], u.shape[0]), u.astype("<u2").tobytes())
    _atomic_save(im, Path(path), format="PNG", compress_level=6)


def save_jpg(a: np.ndarray, path: str | os.PathLike, quality: int = 90) -> None:
    u = to_uint8(a)
    _atomic_save(Image.fromarray(u, "L" if u.ndim == 2 else "RGB"), Path(path), format="JPEG", quality=quality)


def save_rgba_png(rgba: np.ndarray, path: str | os.PathLike) -> None:
    _atomic_save(Image.fromarray(to_uint8(rgba), "RGBA"), Path(path), format="PNG", compress_level=6)
