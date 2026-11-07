"""Periodic (wrap-around) filters. Wrapping keeps tiles seamless after filtering."""
from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor

import numpy as np

# numpy's FFT releases the GIL, so independent transforms run in parallel on all cores.
_POOL = ThreadPoolExecutor(max_workers=max(2, min(8, os.cpu_count() or 2)), thread_name_prefix="lumo-fft")


def parallel(fn, items):
    """map() on the shared thread pool (keeps order)."""
    items = list(items)
    if len(items) <= 1:
        return [fn(x) for x in items]
    return list(_POOL.map(fn, items))


def gauss_transfer(shape: tuple[int, int], sigma: float) -> np.ndarray:
    """Gaussian low-pass in the half spectrum of rfft2 (1 everywhere for a tiny sigma)."""
    h, w = shape
    if sigma <= 0.05:
        return np.ones((h, w // 2 + 1), np.float32)
    return _gauss_transfer(h, w, sigma)


class Spectrum:
    """rfft2 of an image, computed once; every filtered version costs a single inverse transform."""

    def __init__(self, a: np.ndarray):
        self.shape = a.shape[:2]
        self.F = np.fft.rfft2(a.astype(np.float32, copy=False))

    def apply(self, transfer: np.ndarray) -> np.ndarray:
        return np.fft.irfft2(self.F * transfer, s=self.shape).astype(np.float32)

    def blur(self, sigma: float) -> np.ndarray:
        return self.apply(gauss_transfer(self.shape, sigma))


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
