"""Periodic (wrap-around) filters. Wrapping keeps tiles seamless after filtering."""
from __future__ import annotations

import numpy as np


def _gauss_transfer(h: int, w: int, sigma: float) -> np.ndarray:
    fy = np.fft.fftfreq(h).astype(np.float32)[:, None]
    fx = np.fft.rfftfreq(w).astype(np.float32)[None, :]
    return np.exp(-2.0 * (np.pi ** 2) * (sigma ** 2) * (fx * fx + fy * fy)).astype(np.float32)


def blur_wrap(a: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian blur with periodic boundaries, any sigma, O(N log N). Works on (H, W) or (H, W, C)."""
    if sigma <= 0.05:
        return a.astype(np.float32, copy=True)
    h, w = a.shape[:2]
    t = _gauss_transfer(h, w, sigma)
    if a.ndim == 2:
        return np.fft.irfft2(np.fft.rfft2(a) * t, s=(h, w)).astype(np.float32)
    out = np.empty(a.shape, dtype=np.float32)
    for c in range(a.shape[2]):
        out[..., c] = np.fft.irfft2(np.fft.rfft2(a[..., c]) * t, s=(h, w))
    return out


def grad_wrap(a: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Central differences with wrap: returns (d/dx, d/dy) with y pointing down (image rows)."""
    gx = (np.roll(a, -1, axis=1) - np.roll(a, 1, axis=1)) * 0.5
    gy = (np.roll(a, -1, axis=0) - np.roll(a, 1, axis=0)) * 0.5
    return gx.astype(np.float32), gy.astype(np.float32)


def normalize_robust(a: np.ndarray, lo_pct: float = 0.5, hi_pct: float = 99.5) -> np.ndarray:
    lo, hi = np.percentile(a, [lo_pct, hi_pct])
    if hi - lo < 1e-8:
        return np.full_like(a, 0.5, dtype=np.float32)
    return np.clip((a - lo) / (hi - lo), 0, 1).astype(np.float32)
