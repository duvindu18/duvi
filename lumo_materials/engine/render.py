"""CPU preview renderer for thumbnails (sphere with transparent background, and a flat tile).

Deterministic and GPU-free, so thumbnails look the same on every PC and can be made headless.
"""
from __future__ import annotations

import numpy as np

from .imageio import resize

_LIGHTS = (  # direction (x right, y up, z to viewer), colour, intensity
    ((-0.55, 0.65, 0.55), (1.0, 0.97, 0.92), 2.2),
    ((0.80, 0.10, 0.40), (0.75, 0.85, 1.0), 0.45),
    ((0.10, -0.60, 0.30), (1.0, 0.95, 0.90), 0.18),
)


def _sample(tex: np.ndarray, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    h, w = tex.shape[:2]
    x = np.mod(u * w, w)
    y = np.mod(v * h, h)
    x0 = np.floor(x).astype(np.int32) % w
    y0 = np.floor(y).astype(np.int32) % h
    x1 = (x0 + 1) % w
    y1 = (y0 + 1) % h
    fx = (x - np.floor(x)).astype(np.float32)
    fy = (y - np.floor(y)).astype(np.float32)
    if tex.ndim == 3:
        fx = fx[..., None]
        fy = fy[..., None]
    a = tex[y0, x0] * (1 - fx) + tex[y0, x1] * fx
    b = tex[y1, x0] * (1 - fx) + tex[y1, x1] * fx
    return a * (1 - fy) + b * fy


def _aces(c: np.ndarray) -> np.ndarray:
    return np.clip((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), 0, 1)


def _shade(N, V, A, R, M, AO):
    """Blinn-Phong energy-normalised approximation of a GGX look; inputs linear."""
    col = np.zeros(A.shape, np.float32)
    rough = np.clip(R, 0.04, 1.0)
    shin = np.minimum(2.0 / np.maximum(rough ** 4, 1e-3) - 2.0, 2000.0)
    f0 = 0.04 * (1 - M[..., None]) + A * M[..., None]
    diff = A * (1 - M[..., None])
    for d, c, inten in _LIGHTS:
        L = np.array(d, np.float32)
        L /= np.linalg.norm(L)
        ndl = np.clip(np.einsum("...k,k->...", N, L), 0, 1)
        H = L + V
        H /= np.linalg.norm(H)
        ndh = np.clip(np.einsum("...k,k->...", N, H), 0, 1)
        spec = (ndh ** shin) * (shin + 8) / (8 * np.pi)
        col += (diff * ndl[..., None] + f0 * (spec * ndl)[..., None] * 0.9) * np.array(c, np.float32) * inten
    up = N[..., 1] * 0.5 + 0.5
    env = (np.array([0.45, 0.43, 0.42], np.float32) * (1 - up[..., None]) +
           np.array([0.85, 0.88, 0.95], np.float32) * up[..., None])
    col += diff * env * 0.32 * AO[..., None]
    refl_y = 2 * N[..., 2] * N[..., 1]
    band = np.exp(-((refl_y - 0.15) / 0.18) ** 2) * 0.9 + np.clip(refl_y, 0, 1) * 0.6
    col += f0 * env * (0.25 + 0.6 * (1 - rough[..., None])) * (0.4 + band[..., None] * M[..., None]) * AO[..., None]
    return col


def _prep(maps: dict[str, np.ndarray], max_tex: int = 1024) -> dict[str, np.ndarray]:
    out = {}
    for k, v in maps.items():
        h, w = v.shape[:2]
        s = min(1.0, max_tex / max(h, w))
        out[k] = resize(v, max(2, round(w * s)), max(2, round(h * s))) if s < 1 else v.astype(np.float32)
    return out


def sphere(maps: dict[str, np.ndarray], size: int = 384, tiles: float = 1.5, supersample: int = 2) -> np.ndarray:
    """RGBA float image of the material on a lit sphere."""
    m = _prep(maps)
    S = size * supersample
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
    r = 0.94
    x = ((xx + 0.5) / S * 2 - 1) / r
    y = (1 - (yy + 0.5) / S * 2) / r
    rr = x * x + y * y
    inside = rr <= 1
    z = np.sqrt(np.clip(1 - rr, 0, 1))
    phi = np.arctan2(x, z) + 0.6
    theta = np.arccos(np.clip(y, -1, 1))
    u = (phi / (2 * np.pi) + 0.5) * tiles * 2
    v = theta / np.pi * tiles

    A = np.power(np.clip(_sample(m["albedo"], u, v), 0, 1), 2.2)
    tn = _sample(m["normal"], u, v) * 2 - 1
    R = _sample(m["roughness"], u, v)
    M = _sample(m["metallic"], u, v)
    AO = _sample(m["ao"], u, v)

    Ng = np.stack([x, y, z], -1)
    T = np.stack([np.cos(phi - 0.6), np.zeros_like(x), -np.sin(phi - 0.6)], -1)
    B = np.cross(Ng, T)
    N = T * tn[..., 0:1] + B * tn[..., 1:2] + Ng * np.maximum(tn[..., 2:3], 0.05)
    N /= np.maximum(np.linalg.norm(N, axis=-1, keepdims=True), 1e-6)
    V = np.array([0, 0, 1.0], np.float32)

    col = _shade(N, V, A, R, M, AO)
    col += ((1 - z) ** 3)[..., None] * 0.06 * (1 - R[..., None])
    rgb = np.power(_aces(col * 0.9), 1 / 2.2)
    alpha = np.clip((1 - np.sqrt(rr)) * S * r / 1.5, 0, 1) * inside
    img = np.dstack([rgb, alpha]).astype(np.float32)
    if supersample > 1:
        img = img.reshape(size, supersample, size, supersample, 4).mean(axis=(1, 3))
    return img


def plane(maps: dict[str, np.ndarray], size: int = 384, tiles: int = 2) -> np.ndarray:
    """RGB float image of the material as a flat, lit tile."""
    m = _prep(maps, max_tex=max(size, 512))
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    u = (xx + 0.5) / size * tiles
    v = (yy + 0.5) / size * tiles
    A = np.power(np.clip(_sample(m["albedo"], u, v), 0, 1), 2.2)
    tn = _sample(m["normal"], u, v) * 2 - 1
    N = np.stack([tn[..., 0], tn[..., 1], np.maximum(tn[..., 2], 0.05)], -1)
    N /= np.maximum(np.linalg.norm(N, axis=-1, keepdims=True), 1e-6)
    # plane faces the viewer: tangent x = right, y = up, z = out of the screen
    col = _shade(N, np.array([0, 0, 1.0], np.float32), A, _sample(m["roughness"], u, v),
                 _sample(m["metallic"], u, v), _sample(m["ao"], u, v))
    return np.power(_aces(col * 0.85), 1 / 2.2).astype(np.float32)


def composite(rgba: np.ndarray, background=(0.086, 0.086, 0.094)) -> np.ndarray:
    a = rgba[..., 3:4]
    return rgba[..., :3] * a + np.array(background, np.float32) * (1 - a)
