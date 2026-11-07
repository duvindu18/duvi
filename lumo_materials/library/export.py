"""Export of materials as a ZIP file or into a folder (never overwrites anything)."""
from __future__ import annotations

import io
import os
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

import numpy as np
from PIL import Image

from ..engine import imageio
from .paths import safe_name, unique_child
from .store import Library


@dataclass
class ExportOptions:
    normal: str = "gl"            # gl | dx
    naming: str = "plain"         # plain: albedo.png ...   engine: <Name>_BaseColor.png ...
    orm: bool = False             # also write a packed ORM map (R = AO, G = roughness, B = metallic)
    height_bits: int = 16         # 8 | 16
    include_previews: bool = False


ENGINE_NAMES = {"albedo": "BaseColor", "roughness": "Roughness", "metallic": "Metallic",
                "height": "Height", "ao": "AO", "orm": "ORM"}


def file_names(name: str, opts: ExportOptions) -> dict[str, str]:
    if opts.naming == "engine":
        base = safe_name(name).replace(" ", "_")
        out = {k: f"{base}_{v}.png" for k, v in ENGINE_NAMES.items()}
        out["normal"] = f"{base}_Normal_{'DX' if opts.normal == 'dx' else 'GL'}.png"
        return out
    out = {k: f"{k}.png" for k in ("albedo", "normal", "roughness", "metallic", "height", "ao", "orm")}
    return out


def _png_bytes(arr: np.ndarray, sixteen: bool = False) -> bytes:
    buf = io.BytesIO()
    if sixteen:
        u = imageio.to_uint16(arr)
        Image.frombytes("I;16", (u.shape[1], u.shape[0]), u.astype("<u2").tobytes()).save(buf, "PNG", compress_level=6)
    else:
        u = imageio.to_uint8(arr)
        Image.fromarray(u, "L" if u.ndim == 2 else "RGB").save(buf, "PNG", compress_level=6)
    return buf.getvalue()


def material_files(lib: Library, mid: str, opts: ExportOptions) -> list[tuple[str, bytes]]:
    m = lib.get(mid)
    maps = lib.load_maps(mid)
    names = file_names(m.name, opts)
    out: list[tuple[str, bytes]] = []
    for key in ("albedo", "normal", "roughness", "metallic", "height", "ao"):
        a = maps[key]
        if key == "normal" and opts.normal == "dx":
            a = a.copy()
            a[..., 1] = 1.0 - a[..., 1]
        out.append((names[key], _png_bytes(a, sixteen=(key == "height" and opts.height_bits == 16))))
    if opts.orm:
        orm = np.stack([maps["ao"], maps["roughness"], maps["metallic"]], axis=2)
        out.append((names["orm"], _png_bytes(orm)))
    if opts.include_previews:
        for f in ("preview_sphere.png", "preview_plane.png"):
            p = m.folder / f
            if p.exists():
                out.append((f, p.read_bytes()))
    return out


def export_zip(lib: Library, ids: Iterable[str], target: str | os.PathLike, opts: ExportOptions,
               progress: Callable[[float, str], None] | None = None) -> Path:
    """Writes one ZIP with a folder per material. If target exists, ' (2)' etc. is added."""
    ids = list(ids)
    report = progress or (lambda f, s: None)
    target = Path(target)
    if target.suffix.lower() != ".zip":
        target = target.with_suffix(".zip")
    target.parent.mkdir(parents=True, exist_ok=True)
    final, k = target, 2
    while final.exists():
        final = target.with_name(f"{target.stem} ({k}).zip")
        k += 1
    tmp = final.with_name(final.name + ".part")
    used: set[str] = set()
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for i, mid in enumerate(ids):
                m = lib.get(mid)
                report(i / max(1, len(ids)), m.name)
                folder = safe_name(m.name)
                k = 2
                while folder.lower() in used:
                    folder = f"{safe_name(m.name)} ({k})"
                    k += 1
                used.add(folder.lower())
                for name, data in material_files(lib, mid, opts):
                    z.writestr(f"{folder}/{name}", data)
        os.replace(tmp, final)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    report(1.0, "Done")
    return final


def export_folder(lib: Library, ids: Iterable[str], target_dir: str | os.PathLike, opts: ExportOptions,
                  progress: Callable[[float, str], None] | None = None) -> list[Path]:
    """Writes <target_dir>/<Material>/... ; an existing folder of the same name gets ' (2)' instead."""
    ids = list(ids)
    report = progress or (lambda f, s: None)
    root = Path(target_dir)
    root.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for i, mid in enumerate(ids):
        m = lib.get(mid)
        report(i / max(1, len(ids)), m.name)
        folder = unique_child(root, safe_name(m.name))
        folder.mkdir()
        for name, data in material_files(lib, mid, opts):
            (folder / name).write_bytes(data)
        written.append(folder)
    report(1.0, "Done")
    return written
