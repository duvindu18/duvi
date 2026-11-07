"""Preview meshes as interleaved float32 triangle lists (no Qt; unit-tested).

Vertex layout: position (3), normal (3), uv (2), tangent xyz + handedness (4) = 12 floats.
Texture v runs down the image (row 0 at v = 0); tangent = +u, bitangent = up in the image (-v), which is the
OpenGL (+Y up) normal-map convention used by the engine.
"""
from __future__ import annotations

import numpy as np

STRIDE = 12


def _triangles(grid: np.ndarray, rows: int, cols: int) -> np.ndarray:
    """grid: (rows+1, cols+1, 12) vertices -> (rows*cols*6, 12) triangle list, counter-clockwise from outside."""
    a = grid[:-1, :-1]
    b = grid[1:, :-1]
    c = grid[1:, 1:]
    d = grid[:-1, 1:]
    tri = np.stack([a, b, c, a, c, d], axis=2)          # (rows, cols, 6, 12)
    return np.ascontiguousarray(tri.reshape(-1, STRIDE), dtype=np.float32)


def sphere(rows: int = 64, cols: int = 128, u_repeat: float = 2.0) -> np.ndarray:
    th = np.linspace(0, np.pi, rows + 1, dtype=np.float32)[:, None]          # from the top
    ph = np.linspace(0, 2 * np.pi, cols + 1, dtype=np.float32)[None, :]
    st, ct, sp, cp = np.sin(th), np.cos(th), np.sin(ph), np.cos(ph)
    pos = np.stack(np.broadcast_arrays(st * sp, ct, st * cp), axis=-1)
    nrm = pos.copy()
    u = np.broadcast_to(ph / (2 * np.pi) * u_repeat, (rows + 1, cols + 1))
    v = np.broadcast_to(th / np.pi, (rows + 1, cols + 1))
    tan = np.stack(np.broadcast_arrays(cp, np.zeros_like(ph), -sp, np.ones_like(ph)), axis=-1)
    tan = np.broadcast_to(tan, (rows + 1, cols + 1, 4))
    grid = np.concatenate([pos, nrm, np.stack([u, v], -1), tan], axis=-1).astype(np.float32)
    return _triangles(grid, rows, cols)


def plane(segments: int = 128, size: float = 1.6) -> np.ndarray:
    t = np.linspace(-1, 1, segments + 1, dtype=np.float32)
    y = t[::-1][:, None] * np.ones((1, segments + 1), np.float32)   # row 0 at the top (v = 0)
    x = np.ones((segments + 1, 1), np.float32) * t[None, :]
    pos = np.stack([x * size, y * size, np.zeros_like(x)], -1)
    nrm = np.broadcast_to(np.array([0, 0, 1], np.float32), pos.shape)
    uv = np.stack([(x + 1) / 2, (1 - y) / 2], -1)
    tan = np.broadcast_to(np.array([1, 0, 0, 1], np.float32), (segments + 1, segments + 1, 4))
    grid = np.concatenate([pos, nrm, uv, tan], axis=-1).astype(np.float32)
    return _triangles(grid, segments, segments)


def maps_to_u8(maps: dict[str, np.ndarray], max_edge: int = 1024) -> dict[str, np.ndarray]:
    """Preview-sized uint8 copies for the GPU (RGBA for colour maps, single channel for the rest)."""
    from ..engine.imageio import fit_within, to_uint8
    out = {}
    for k, v in maps.items():
        a = to_uint8(fit_within(v, max_edge))
        if a.ndim == 3:
            a = np.concatenate([a, np.full(a.shape[:2] + (1,), 255, np.uint8)], axis=2)
        out[k] = np.ascontiguousarray(a)
    return out
