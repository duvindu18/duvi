"""Generating a full PBR map set from one photo."""
from __future__ import annotations

import numpy as np

from .fftops import blur_wrap, grad_wrap, normalize_robust
from .imageio import luminance
from .presets import GenParams
from .seamless import make_seamless, seam_score


def delight(rgb: np.ndarray, strength: float, radius: float) -> np.ndarray:
    """Divides out large-scale brightness changes (baked-in light and shadow gradients)."""
    if strength <= 0:
        return rgb.astype(np.float32, copy=True)
    h, w = rgb.shape[:2]
    lum = luminance(rgb)
    low = blur_wrap(lum, max(1.0, radius * min(h, w)))
    ratio = float(np.mean(lum)) / np.maximum(low, 1e-3)
    gain = 1.0 + float(strength) * (ratio - 1.0)
    return np.clip(rgb * gain[..., None], 0, 1).astype(np.float32)


def height_from(albedo: np.ndarray, p: GenParams) -> np.ndarray:
    h, w = albedo.shape[:2]
    m = min(h, w)
    lum = luminance(albedo)
    large = (0.02 + 0.28 * float(np.clip(p.height_detail, 0, 1))) * m
    hp = lum - blur_wrap(lum, large)
    if p.height_smooth > 0:
        hp = blur_wrap(hp, float(p.height_smooth) * 0.006 * m)
    hgt = normalize_robust(hp)
    hgt = (hgt - 0.5) * float(p.height_contrast) + 0.5
    if p.invert_height:
        hgt = 1.0 - hgt
    return np.clip(hgt, 0, 1).astype(np.float32)


def normal_from(height: np.ndarray, strength: float) -> np.ndarray:
    """Tangent-space normal map, OpenGL convention (+Y up), encoded 0..1."""
    m = min(height.shape)
    k = float(strength) * m / 256.0
    gx, gy = grad_wrap(height)
    n = np.stack([-gx * k, gy * k, np.ones_like(height)], axis=2)  # y flipped: image rows point down
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    return (n * 0.5 + 0.5).astype(np.float32)


def roughness_from(albedo: np.ndarray, height: np.ndarray, p: GenParams) -> np.ndarray:
    m = min(albedo.shape[:2])
    lum = luminance(albedo)
    detail = normalize_robust(lum - blur_wrap(lum, 0.03 * m))
    cavity = 1.0 - height
    v = 0.6 * (0.5 - detail) + 0.4 * (cavity - 0.5)
    return np.clip(float(p.roughness) + float(p.roughness_variation) * v, 0, 1).astype(np.float32)


def ao_from(height: np.ndarray, strength: float, radius: float) -> np.ndarray:
    if strength <= 0:
        return np.ones_like(height, dtype=np.float32)
    m = min(height.shape)
    r = 0.004 + 0.03 * float(np.clip(radius, 0, 1))
    acc = np.zeros_like(height, dtype=np.float32)
    for f in (0.5, 1.0, 2.0):
        acc += np.clip((blur_wrap(height, r * f * m) - height) * 4.0, 0, 1)
    acc /= 3.0
    return np.clip(1.0 - float(strength) * acc, 0, 1).astype(np.float32)


def prepare_albedo(src: np.ndarray, p: GenParams) -> np.ndarray:
    a = make_seamless(src, p.seamless, p.blend_width)
    return delight(a, p.delight, p.delight_radius)


def generate(src: np.ndarray, p: GenParams) -> dict[str, np.ndarray]:
    """src: (H, W, 3) float photo. Returns all six maps at the size of src."""
    tiled = make_seamless(src, p.seamless, p.blend_width)
    albedo = delight(tiled, p.delight, p.delight_radius)
    # Baked-in light is never relief: height always uses a fully de-lit copy, whatever the albedo setting.
    height = height_from(delight(tiled, 1.0, p.delight_radius), p)
    return {
        "albedo": albedo,
        "normal": normal_from(height, p.normal_strength),
        "roughness": roughness_from(albedo, height, p),
        "metallic": np.full(height.shape, float(np.clip(p.metallic, 0, 1)), dtype=np.float32),
        "height": height,
        "ao": ao_from(height, p.ao_strength, p.ao_radius),
    }


def score(maps: dict[str, np.ndarray]) -> float:
    return seam_score(maps["albedo"])
