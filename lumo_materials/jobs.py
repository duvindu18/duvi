"""Background jobs of the editor: previews and saving. No Qt, so they are unit-tested headless."""
from __future__ import annotations

import time

import numpy as np

from .engine import adjust as adj
from .engine import imageio
from .engine import importer as imp
from .engine import maps as gen
from .engine.presets import GenParams
from .engine.seamless import seam_score
from .library import fingerprint as fpr
from .ui import meshes

def _preview_result(maps: dict[str, np.ndarray], t0: float):
    return maps, meshes.maps_to_u8(maps), seam_score(maps["albedo"]), (time.perf_counter() - t0) * 1000


def job_load_source(path: str, preview_px: int):
    full = imageio.load_rgb(path)
    return imageio.fit_within(full, preview_px), (full.shape[1], full.shape[0])


def job_photo_preview(src: np.ndarray, params: GenParams):
    t0 = time.perf_counter()
    return _preview_result(gen.generate(src, params), t0)


def job_assemble_preview(assignments: list[imp.Assignment], params: GenParams, missing: bool, preview_px: int):
    maps, generated = imp.assemble(assignments, params, missing)
    full = maps["albedo"].shape[1], maps["albedo"].shape[0]
    return {k: imageio.fit_within(v, preview_px) for k, v in maps.items()}, generated, full


def job_adjust_preview(base: dict[str, np.ndarray], params: dict, prev: dict | None, prev_params: dict | None):
    t0 = time.perf_counter()
    only = adj.changed_maps(prev_params, params) if prev is not None else None
    out = dict(prev) if prev is not None else {}
    out.update(adj.apply(base, params, only=only))
    return _preview_result(out, t0)


def job_load_base(lib, mid: str, preview_px: int):
    m = lib.get(mid)
    maps = lib.load_maps(mid, max_edge=preview_px, originals=True)
    return maps, (m.width, m.height)


def _apply_meta(lib, mid: str, name: str, category: str, tags: list[str]) -> str:
    """Name, category and tags edited in the editor also apply when maps are replaced in place."""
    m = lib.get(mid)
    changes = {}
    if name and name != m.name:
        changes["name"] = name
    if category and category != m.category:
        changes["category"] = category
    if tags is not None and list(tags) != list(m.tags):
        changes["tags"] = tags
    if changes:
        lib.update(mid, **changes)
    return mid


def job_find_duplicates(lib, paths: list[str], exclude: list[str] | None = None):
    """Materials already made from any of these image files (same file, or the same picture re-saved)."""
    return lib.find_duplicates(paths, exclude or [])


def _resize_longest(a: np.ndarray, edge: int) -> np.ndarray:
    h, w = a.shape[:2]
    s = edge / max(h, w)
    return imageio.resize(a, max(1, round(w * s)), max(1, round(h * s)))


def job_save_photo(lib, source: str, params: GenParams, size: int, name: str, category: str, tags: list[str],
                   replace_id: str | None = None, progress=None):
    report = progress or (lambda f, s="": None)
    report(0.02, "Reading the photo")
    src = _resize_longest(imageio.load_rgb(source), size)
    report(0.15, f"Generating maps at {src.shape[1]} × {src.shape[0]}")
    maps = gen.generate(src, params)
    sub = lambda f, s="": report(0.5 + 0.5 * f, s)  # noqa: E731
    if replace_id:
        mid = lib.replace_maps(replace_id, maps, generation=params.to_dict(), source=source, progress=sub).id
        return _apply_meta(lib, mid, name, category, tags)
    return lib.create(maps, name, category, tags=tags, origin="photo", generation=params.to_dict(), source=source,
                      progress=sub).id


def job_save_import(lib, assignments, params: GenParams, missing: bool, adjust_params: dict, name: str,
                    category: str, tags: list[str], progress=None):
    report = progress or (lambda f, s="": None)
    report(0.05, "Reading the map files")
    originals, _ = imp.assemble(assignments, params, missing)
    report(0.35, "Applying adjustments")
    final = adj.apply(originals, adjust_params)
    sources = []
    for a in assignments:
        if a.role != "ignore":
            try:
                sources.append(dict(fpr.fingerprint(a.path), role=a.role))
            except OSError:
                pass
    sub = lambda f, s="": report(0.5 + 0.5 * f, s)  # noqa: E731
    return lib.create(final, name, category, tags=tags, origin="import", originals=originals,
                      adjustments=adjust_params, sources=sources, progress=sub).id


def job_save_adjust(lib, mid: str, adjust_params: dict, mode: str, name: str, category: str, tags: list[str],
                    progress=None):
    report = progress or (lambda f, s="": None)
    report(0.05, "Reading the untouched maps")
    m = lib.get(mid)
    originals = lib.load_maps(mid, originals=True)
    report(0.3, "Applying adjustments at full size")
    final = adj.apply(originals, adjust_params)
    sub = lambda f, s="": report(0.5 + 0.5 * f, s)  # noqa: E731
    if mode == "replace":
        lib.replace_maps(mid, final, originals=originals, adjustments=adjust_params, progress=sub)
        return _apply_meta(lib, mid, name, category, tags)
    return lib.create(final, name, category, tags=tags, description=m.description, origin=m.origin,
                      generation=m.generation, source=m.source_path, originals=originals,
                      adjustments=adjust_params, sources=m.sources, progress=sub).id
