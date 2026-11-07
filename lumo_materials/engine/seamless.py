"""Making photos tile seamlessly, and measuring how well they tile."""
from __future__ import annotations

import numpy as np

from .fftops import parallel
from .imageio import resize

MODES = ("periodic", "blend", "mirror", "off")


def _periodic_channel(u: np.ndarray) -> np.ndarray:
    # Moisan, "Periodic plus smooth image decomposition" (2011): u = p + s, p periodic, s smooth.
    # Real-to-complex transforms (half spectrum): twice as fast as a complex FFT, same result.
    u = u.astype(np.float32, copy=False)
    h, w = u.shape
    v = np.zeros((h, w), np.float32)
    v[0, :] += u[-1, :] - u[0, :]
    v[-1, :] += u[0, :] - u[-1, :]
    v[:, 0] += u[:, -1] - u[:, 0]
    v[:, -1] += u[:, 0] - u[:, -1]
    q = np.arange(h, dtype=np.float64).reshape(h, 1)
    r = np.arange(w // 2 + 1, dtype=np.float64).reshape(1, -1)
    denom = 2.0 * np.cos(2.0 * np.pi * q / h) + 2.0 * np.cos(2.0 * np.pi * r / w) - 4.0
    denom[0, 0] = 1.0
    s_hat = np.fft.rfft2(v) / denom
    s_hat[0, 0] = 0.0
    return (u - np.fft.irfft2(s_hat, s=(h, w))).astype(np.float32)


def periodic(a: np.ndarray) -> np.ndarray:
    """Removes the edge discontinuity while keeping all detail (FFT based)."""
    if a.ndim == 2:
        return np.clip(_periodic_channel(a), 0, 1)
    chans = parallel(_periodic_channel, [a[..., c] for c in range(a.shape[2])])
    return np.clip(np.stack(chans, axis=2), 0, 1).astype(np.float32)


def _ramp(n: int, width: float) -> np.ndarray:
    """1 in the middle, 0 at both ends, smooth; width = fraction of each half used for the transition."""
    x = (np.arange(n, dtype=np.float32) + 0.5) / n
    tri = 1.0 - np.abs(2.0 * x - 1.0)                    # 0 at edges, 1 at centre
    width = float(np.clip(width, 0.05, 1.0))
    t = np.clip((tri - (1.0 - width) * 0.5) / width, 0, 1)  # centred transition band
    return (t * t * (3.0 - 2.0 * t)).astype(np.float32)


def blend(a: np.ndarray, width: float = 0.5) -> np.ndarray:
    """Cross-fades the image with copies shifted by half a tile (four sources, weights sum to 1)."""
    h, w = a.shape[:2]
    tx = _ramp(w, width)[None, :]
    ty = _ramp(h, width)[:, None]
    rx = np.roll(a, w // 2, axis=1)
    ry = np.roll(a, h // 2, axis=0)
    rxy = np.roll(rx, h // 2, axis=0)
    w_u, w_rx, w_ry, w_rxy = tx * ty, (1 - tx) * ty, tx * (1 - ty), (1 - tx) * (1 - ty)
    if a.ndim == 3:
        w_u, w_rx, w_ry, w_rxy = (x[..., None] for x in (w_u, w_rx, w_ry, w_rxy))
    return np.clip(a * w_u + rx * w_rx + ry * w_ry + rxy * w_rxy, 0, 1).astype(np.float32)


def mirror(a: np.ndarray) -> np.ndarray:
    """Mirrors the image 2 x 2 and scales back to the original size (always seamless, shows symmetry)."""
    h, w = a.shape[:2]
    top = np.concatenate([a, a[:, ::-1]], axis=1)
    full = np.concatenate([top, top[::-1]], axis=0)
    return resize(full, w, h)


def make_seamless(a: np.ndarray, mode: str = "periodic", blend_width: float = 0.5) -> np.ndarray:
    if mode == "periodic":
        return periodic(a)
    if mode == "blend":
        return blend(a, blend_width)
    if mode == "mirror":
        return mirror(a)
    if mode == "off":
        return a.astype(np.float32, copy=True)
    raise ValueError(f"unknown seamless mode {mode!r}")


def seam_score(a: np.ndarray) -> float:
    """Step across the repeat edge relative to the typical step between neighbouring pixels.
    About 1.0 means the seam is invisible; above 1.5 it is usually visible."""
    a = a.astype(np.float32)
    if a.shape[0] < 4 or a.shape[1] < 4:
        return 1.0
    edge = 0.5 * (np.mean(np.abs(a[:, 0] - a[:, -1])) + np.mean(np.abs(a[0] - a[-1])))
    inner = 0.5 * (np.mean(np.abs(np.diff(a, axis=1))) + np.mean(np.abs(np.diff(a, axis=0))))
    if inner < 1e-6:
        return 1.0 if edge < 1e-6 else 99.0
    return float(min(edge / inner, 99.0))
