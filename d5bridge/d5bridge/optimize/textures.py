"""Texture collection and lossless optimisation.

Default ("lossless") mode never changes a pixel value or the resolution.
File size is saved by:

* writing each distinct image once (content hash), even when MaxTree reuses
  the same bark map under several names
* storing lossless sources (TIFF, TGA, BMP, PSD, PNG) as maximally
  compressed PNG, keeping the original when it is already smaller
* dropping an alpha channel that is fully opaque
* storing grey-scale data kept in RGB (roughness, opacity, AO...) as 1 channel
* reducing 16-bit images to 8-bit only when every value is an exact multiple
  of 257 (i.e. the 16-bit file holds 8-bit data)
* replacing single-colour textures with the equivalent material constant
* copying JPEG files byte-for-byte (re-encoding a JPEG is always lossy)

Required conversions for D5 are also lossless (exact, reversible pixel maps):
gloss -> roughness (255 - x), OpenGL -> DirectX normals (green flipped) and
packing an opacity mask into the base-colour alpha.

"visually_lossless" mode additionally re-encodes colour maps without alpha as
JPEG quality 95, 4:4:4 chroma. It is optional and off by default.
"""
from __future__ import annotations

import hashlib
import io
import os
import re
import shutil
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None   # 16K atlases are legitimate here

D5_SUFFIX = {
    "base_color": "BaseColor", "opacity": "Opacity", "normal": "Normal", "bump": "Bump",
    "roughness": "Roughness", "metallic": "Metallic", "ao": "AO",
    "translucency": "Translucency", "emissive": "Emissive",
    "displacement": "Displacement", "specular": "Specular",
}
COLOR_CHANNELS = {"base_color", "emissive", "translucency", "specular"}
PASSTHROUGH_EXTS = {".exr", ".hdr", ".dds"}
PIL_LOSSLESS_EXTS = {".png", ".tif", ".tiff", ".tga", ".bmp", ".psd", ".webp", ".gif"}


@dataclass
class TextureOptions:
    mode: str = "lossless"               # "lossless" | "visually_lossless" | "copy"
    collapse_constant: bool = True
    pack_opacity_in_base_alpha: bool = True
    convert_gloss_to_roughness: bool = True
    normal_target: str = "directx"       # D5 expects DirectX normals
    max_size: int = 0                    # 0 = keep full resolution (default)
    workers: int = max(2, (os.cpu_count() or 4) - 1)


@dataclass
class TextureJob:
    """One output texture to produce."""
    channel: str
    source: str
    out_stem: str                         # without extension
    invert: bool = False
    flip_green: bool = False
    extract: str = ""                     # "R"/"G"/"B"/"A" for packed maps
    alpha_from: str = ""                  # opacity source packed into alpha
    alpha_extract: str = ""
    alpha_invert: bool = False

    def key(self) -> tuple:
        return (self.channel in COLOR_CHANNELS, _file_id(self.source), self.invert,
                self.flip_green, self.extract, _file_id(self.alpha_from) if self.alpha_from else "",
                self.alpha_extract, self.alpha_invert)


@dataclass
class TextureResult:
    job: TextureJob
    output: str = ""
    bytes_in: int = 0
    bytes_out: int = 0
    width: int = 0
    height: int = 0
    constant: tuple[float, ...] | None = None    # set when collapsed to a value
    shared_with: str = ""                         # output reused from another job
    pixel_hash: str = ""                          # hash of the final decoded pixels
    notes: list[str] = field(default_factory=list)
    error: str = ""


_ID_CACHE: dict[str, str] = {}


def _file_id(path: str) -> str:
    """Content hash of a source file (cached by path+mtime+size)."""
    try:
        st = os.stat(path)
    except OSError:
        return "missing:" + path
    k = f"{path}|{st.st_mtime_ns}|{st.st_size}"
    if k not in _ID_CACHE:
        h = hashlib.blake2b(digest_size=16)
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        _ID_CACHE[k] = h.hexdigest()
    return _ID_CACHE[k]


# --------------------------------------------------------------------------- #
def load_array(path: str) -> tuple[np.ndarray, int]:
    """Load an image as (H, W, C) uint8/uint16 array. Returns (array, bit depth)."""
    im = Image.open(path)
    im.load()
    if im.mode in ("I;16", "I;16B", "I;16L", "I"):
        a = np.asarray(im, dtype=np.uint32 if im.mode == "I" else np.uint16)
        if im.mode == "I":
            a = np.clip(a, 0, 65535).astype(np.uint16)
        return a[..., None], 16
    if im.mode == "F":
        raise ValueError("32-bit float image: kept as original file")
    if im.mode in ("P", "PA"):
        im = im.convert("RGBA" if ("transparency" in im.info or im.mode == "PA") else "RGB")
    elif im.mode == "CMYK" or im.mode == "YCbCr":
        im = im.convert("RGB")
    elif im.mode == "1":
        im = im.convert("L")
    elif im.mode == "LA":
        pass
    elif im.mode not in ("L", "RGB", "RGBA"):
        im = im.convert("RGBA")
    a = np.asarray(im)
    if a.ndim == 2:
        a = a[..., None]
    if a.dtype == np.uint16:
        return a, 16
    return a.astype(np.uint8, copy=False), 8


def _max_val(a: np.ndarray) -> int:
    return 65535 if a.dtype == np.uint16 else 255


def _channel(a: np.ndarray, which: str) -> np.ndarray:
    idx = "RGBA".index(which)
    if a.shape[2] == 1:
        return a[..., :1]
    if a.shape[2] == 2:   # LA
        return a[..., :1] if idx < 3 else a[..., 1:2]
    if idx >= a.shape[2]:
        return np.full(a.shape[:2] + (1,), _max_val(a), a.dtype)
    return a[..., idx:idx + 1]


def _to_luma_if_grey(a: np.ndarray) -> np.ndarray:
    """RGB(A) whose colour channels are identical -> L(A). Exact."""
    if a.shape[2] >= 3 and np.array_equal(a[..., 0], a[..., 1]) and np.array_equal(a[..., 0], a[..., 2]):
        return a[..., [0, 3]] if a.shape[2] == 4 else a[..., :1]
    return a


def _drop_opaque_alpha(a: np.ndarray) -> np.ndarray:
    if a.shape[2] in (2, 4) and np.all(a[..., -1] == _max_val(a)):
        return a[..., :-1]
    return a


def _reduce_depth_if_exact(a: np.ndarray) -> np.ndarray:
    if a.dtype == np.uint16 and np.all(a % 257 == 0):
        return (a // 257).astype(np.uint8)
    return a


def _to_pil(a: np.ndarray) -> Image.Image:
    c = a.shape[2]
    if a.dtype == np.uint16:
        if c == 1:
            return Image.fromarray(np.ascontiguousarray(a[..., 0], dtype=np.uint16))
        # Pillow cannot write 16-bit RGB PNG directly; handled by _encode_png16
        raise ValueError("rgb16")
    mode = {1: "L", 2: "LA", 3: "RGB", 4: "RGBA"}[c]
    return Image.fromarray(a[..., 0] if c == 1 else a, mode)


def _encode_png16(a: np.ndarray) -> bytes:
    """Minimal 16-bit RGB/RGBA PNG encoder (Pillow lacks one)."""
    import struct
    import zlib
    h, w, c = a.shape
    color_type = {1: 0, 2: 4, 3: 2, 4: 6}[c]
    raw = a.astype(">u2").reshape(h, w * c)
    rows = b"".join(b"\x00" + raw[y].tobytes() for y in range(h))

    def chunk(t: bytes, d: bytes) -> bytes:
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", w, h, 16, color_type, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) +
            chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def encode_png(a: np.ndarray) -> bytes:
    if a.dtype == np.uint16 and a.shape[2] > 1:
        return _encode_png16(a)
    buf = io.BytesIO()
    _to_pil(a).save(buf, "PNG", optimize=True, compress_level=9)
    return buf.getvalue()


def encode_jpeg95(a: np.ndarray) -> bytes:
    buf = io.BytesIO()
    im = _to_pil(_reduce_depth_if_exact(a) if a.dtype == np.uint16 else a)
    if im.mode not in ("RGB", "L"):
        im = im.convert("RGB")
    im.save(buf, "JPEG", quality=95, subsampling=0, optimize=True)
    return buf.getvalue()


# --------------------------------------------------------------------------- #
def process_job(job: TextureJob, out_dir: Path, opts: TextureOptions) -> TextureResult:
    res = TextureResult(job)
    src = Path(job.source)
    if not src.is_file():
        res.error = f"missing texture: {job.source}"
        return res
    res.bytes_in = src.stat().st_size
    ext = src.suffix.lower()
    needs_pixels = job.invert or job.flip_green or job.extract or job.alpha_from
    out_dir.mkdir(parents=True, exist_ok=True)

    def copy_original(note: str = "") -> TextureResult:
        dst = out_dir / (job.out_stem + ext)
        shutil.copyfile(src, dst)
        res.output, res.bytes_out = str(dst), dst.stat().st_size
        if note:
            res.notes.append(note)
        return res

    if opts.mode == "copy" and not needs_pixels:
        return copy_original()
    if ext in PASSTHROUGH_EXTS and not needs_pixels:
        return copy_original(f"{ext} kept as original")

    try:
        a, _bits = load_array(str(src))
    except Exception as e:  # noqa: BLE001 - any decoder failure falls back to copy
        if needs_pixels:
            res.error = f"cannot convert {src.name}: {e}"
            return copy_original(res.error)
        return copy_original(f"kept original ({e})")
    res.height, res.width = a.shape[:2]

    # ---- exact pixel transforms --------------------------------------- #
    if job.extract:
        a = _channel(a, job.extract)
    if job.invert:
        a = (_max_val(a) - a).astype(a.dtype)
        if a.shape[2] in (2, 4):  # never invert alpha
            a[..., -1] = _max_val(a) - a[..., -1]
    if job.flip_green and a.shape[2] >= 3:
        a = a.copy()
        a[..., 1] = _max_val(a) - a[..., 1]
    if job.alpha_from:
        try:
            m, _ = load_array(job.alpha_from)
            m = _channel(m, job.alpha_extract or ("A" if m.shape[2] in (2, 4) else "R"))
            if m.shape[:2] != a.shape[:2]:
                # resizing a mask is not lossless for the mask; keep base exact
                pil = Image.fromarray(m[..., 0])
                m = np.asarray(pil.resize((a.shape[1], a.shape[0]), Image.LANCZOS))[..., None]
                res.notes.append("opacity mask resampled to base-colour resolution")
            if m.dtype != a.dtype:
                m = (m.astype(np.uint32) * 257).astype(np.uint16) if a.dtype == np.uint16 \
                    else (m.astype(np.uint32) // 257).astype(np.uint8)
            if job.alpha_invert:
                m = (_max_val(m) - m).astype(m.dtype)
            base = a[..., :3] if a.shape[2] >= 3 else np.repeat(a[..., :1], 3, axis=2)
            a = np.concatenate([base, m], axis=2)
        except Exception as e:  # noqa: BLE001
            res.notes.append(f"could not pack opacity into alpha: {e}")

    # ---- lossless reductions ----------------------------------------- #
    if opts.mode != "copy":
        a = _drop_opaque_alpha(a)
        a = _to_luma_if_grey(a) if job.channel not in ("normal",) else a
        a = _reduce_depth_if_exact(a)

    if opts.collapse_constant and a.size and np.all(a == a.reshape(-1, a.shape[2])[0]):
        px = a.reshape(-1, a.shape[2])[0].astype(np.float64) / _max_val(a)
        res.constant = tuple(float(x) for x in px)
        res.notes.append("single-colour texture replaced by a material value")
        return res

    if opts.max_size and max(a.shape[:2]) > opts.max_size:
        s = opts.max_size / max(a.shape[:2])
        size = (max(1, round(a.shape[1] * s)), max(1, round(a.shape[0] * s)))
        a = np.asarray(_to_pil(_reduce_depth_if_exact(a)).resize(size, Image.LANCZOS))
        if a.ndim == 2:
            a = a[..., None]
        res.notes.append(f"downscaled to {size[0]}x{size[1]} (max size option)")

    res.pixel_hash = hashlib.blake2b(np.ascontiguousarray(a).tobytes() + str(a.shape).encode()
                                     + a.dtype.str.encode(), digest_size=16).hexdigest()

    # ---- encode -------------------------------------------------------- #
    use_jpeg = (opts.mode == "visually_lossless" and job.channel in COLOR_CHANNELS
                and a.shape[2] in (1, 3))
    if ext in (".jpg", ".jpeg") and not needs_pixels and not use_jpeg and not opts.max_size:
        return copy_original("JPEG copied unchanged (re-encoding would lose quality)")

    data = encode_jpeg95(a) if use_jpeg else encode_png(a)
    out_ext = ".jpg" if use_jpeg else ".png"
    if (not needs_pixels and not opts.max_size and ext == out_ext
            and res.bytes_in <= len(data)):
        return copy_original()
    dst = out_dir / (job.out_stem + out_ext)
    dst.write_bytes(data)
    res.output, res.bytes_out = str(dst), len(data)
    return res


def run_jobs(jobs: list[TextureJob], out_dir: Path, opts: TextureOptions,
             progress=None) -> list[TextureResult]:
    """Process jobs in parallel; identical jobs are produced once and shared."""
    unique: dict[tuple, TextureJob] = {}
    for j in jobs:
        unique.setdefault(j.key(), j)
    results_by_key: dict[tuple, TextureResult] = {}
    todo = list(unique.items())
    done = 0
    with ThreadPoolExecutor(max_workers=opts.workers) as ex:
        futs = {ex.submit(process_job, j, out_dir, opts): k for k, j in todo}
        for fut in futs:
            k = futs[fut]
            try:
                results_by_key[k] = fut.result()
            except Exception as e:  # noqa: BLE001
                r = TextureResult(unique[k])
                r.error = str(e)
                results_by_key[k] = r
            done += 1
            if progress:
                progress(done, len(todo), unique[k].source)
    _merge_identical_pixels(list(results_by_key.values()))
    out = []
    for j in jobs:
        base = results_by_key[j.key()]
        if base.job is j:
            out.append(base)
        else:
            r = TextureResult(j, output=base.output, bytes_in=0, bytes_out=0,
                              width=base.width, height=base.height, constant=base.constant,
                              shared_with=base.job.out_stem, error=base.error)
            out.append(r)
    return out


def _merge_identical_pixels(results: list[TextureResult]) -> None:
    """Different source files with identical pixels -> keep one output file."""
    groups: dict[str, list[TextureResult]] = {}
    for r in results:
        if r.pixel_hash and r.output and not r.error:
            groups.setdefault(r.pixel_hash, []).append(r)
    for rs in groups.values():
        if len(rs) < 2:
            continue
        keep = min(rs, key=lambda r: (r.bytes_out, r.job.out_stem))
        for r in rs:
            if r is keep:
                continue
            if r.output != keep.output and os.path.isfile(r.output):
                os.remove(r.output)
            r.output = keep.output
            r.bytes_out = 0
            r.shared_with = keep.job.out_stem


def safe_stem(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9_\-]+", "_", name).strip("_")
    return s[:80] or "tex"
