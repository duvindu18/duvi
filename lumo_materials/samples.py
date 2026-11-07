"""Procedural sample photos and map sets (no Qt): used by the UI smoke test and for demos."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

from .engine.fftops import blur_wrap
from .engine.imageio import to_uint8

SAMPLES = [  # name, category, preset, base colour, accent colour, pattern
    ("Red Brick", "Walls", "brick", (0.55, 0.22, 0.14), (0.72, 0.68, 0.62), "brick"),
    ("Oak Planks", "Floors", "wood", (0.48, 0.31, 0.17), (0.75, 0.54, 0.33), "wood"),
    ("Slate Stone", "Stone", "stone", (0.20, 0.23, 0.26), (0.37, 0.40, 0.44), "noise"),
    ("Brushed Steel", "Metal", "metal", (0.55, 0.57, 0.60), (0.79, 0.81, 0.83), "brushed"),
    ("Terracotta Tile", "Tiles", "tile", (0.65, 0.31, 0.18), (0.85, 0.82, 0.77), "tile"),
    ("Natural Linen", "Fabric", "fabric", (0.62, 0.56, 0.47), (0.84, 0.80, 0.71), "weave"),
    ("Forest Ground", "Ground", "ground", (0.23, 0.18, 0.12), (0.30, 0.42, 0.15), "noise"),
    ("Polished Concrete", "Floors", "concrete", (0.55, 0.55, 0.53), (0.72, 0.71, 0.69), "noise"),
]


def _noise(rng, n, sigma):
    a = blur_wrap(rng.random((n, n)).astype(np.float32), sigma)
    return (a - a.min()) / (a.max() - a.min() + 1e-9)


def photo(pattern: str, base, accent, n: int = 512, seed: int = 0) -> np.ndarray:
    """A lit, non-tileable 'photo' of a material (float RGB 0..1)."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32) / n
    t = 0.6 * _noise(rng, n, 2) + 0.4 * _noise(rng, n, 10)
    if pattern == "brick":
        row = np.floor(yy * 8)
        bx = ((xx + (row % 2) * 0.125) * 4) % 1
        mortar = ((bx < 0.05) | ((yy * 8) % 1 < 0.1)).astype(np.float32)
        t = t * (1 - mortar) + mortar
    elif pattern == "tile":
        grout = (((xx * 4) % 1 < 0.05) | ((yy * 4) % 1 < 0.05)).astype(np.float32)
        t = t * 0.6 * (1 - grout) + grout
    elif pattern == "wood":
        t = 0.5 + 0.5 * np.sin((xx * 40 + _noise(rng, n, 30) * 8) * np.pi) * 0.7 + 0.3 * (t - 0.5)
    elif pattern == "brushed":
        t = 0.7 * blur_wrap(np.repeat(rng.random((n, 1)), n, 1).astype(np.float32), 0.8) + 0.3 * t
    elif pattern == "weave":
        t = 0.5 + 0.25 * np.sin(xx * n * 0.4) * np.sin(yy * n * 0.4) + 0.25 * t
    t = np.clip(t, 0, 1)[..., None]
    rgb = np.array(base, np.float32) * (1 - t) + np.array(accent, np.float32) * t
    light = 0.75 + 0.35 * xx - 0.15 * yy        # baked-in light gradient, like a real photo
    return np.clip(rgb * light[..., None], 0, 1).astype(np.float32)


def write_photo(path: str | Path, pattern="brick", base=(0.55, 0.22, 0.14), accent=(0.72, 0.68, 0.62),
                n: int = 512, seed: int = 0) -> Path:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(to_uint8(photo(pattern, base, accent, n, seed))).save(p, quality=92)
    return p


def write_map_set(folder: str | Path, name: str = "Rock", n: int = 256, seed: int = 1) -> list[Path]:
    """A small set of map files with engine-style names (colour, normal DX, roughness, height)."""
    from .engine import maps as gen
    from .engine.presets import for_preset
    d = Path(folder)
    d.mkdir(parents=True, exist_ok=True)
    m = gen.generate(photo("noise", (0.35, 0.33, 0.30), (0.62, 0.60, 0.56), n, seed), for_preset("stone"))
    dx = m["normal"].copy()
    dx[..., 1] = 1 - dx[..., 1]
    files = {f"{name}_Color.png": m["albedo"], f"{name}_NormalDX.png": dx,
             f"{name}_Roughness.png": m["roughness"], f"{name}_Displacement.png": m["height"]}
    out = []
    for fname, arr in files.items():
        u = to_uint8(arr)
        Image.fromarray(u, "L" if u.ndim == 2 else "RGB").save(d / fname)
        out.append(d / fname)
    return out


def fill_library(lib, size: int = 256, progress=None) -> list[str]:
    """Adds the sample materials to a library. Returns their ids."""
    from .engine import maps as gen
    from .engine.presets import for_preset
    ids = []
    for i, (name, cat, preset, base, accent, pattern) in enumerate(SAMPLES):
        src = photo(pattern, base, accent, size, seed=i)
        m = lib.create(gen.generate(src, for_preset(preset)), name, cat, tags=[preset, "sample"],
                       generation=for_preset(preset).to_dict(), favourite=i in (0, 3))
        ids.append(m.id)
        if progress:
            progress((i + 1) / len(SAMPLES), name)
    return ids
