"""Per-map adjustments. Always absolute and always applied to the untouched maps, so nothing degrades."""
from __future__ import annotations

import copy
from typing import Any

import numpy as np

from .fftops import blur_wrap
from .imageio import luminance, resize

# map -> control -> (label, min, max, neutral, step, decimals | "bool")
CONTROLS: dict[str, dict[str, tuple]] = {
    "albedo": {
        "exposure":   ("Exposure", -3.0, 3.0, 0.0, 0.05, 2),
        "contrast":   ("Contrast", -1.0, 1.0, 0.0, 0.01, 2),
        "saturation": ("Saturation", -1.0, 1.0, 0.0, 0.01, 2),
        "hue":        ("Hue shift", -180.0, 180.0, 0.0, 1.0, 0),
    },
    "normal": {
        "strength":  ("Strength", 0.0, 4.0, 1.0, 0.01, 2),
        "smoothing": ("Smoothing", 0.0, 1.0, 0.0, 0.01, 2),
        "flip_x":    ("Flip X", 0, 1, False, 1, "bool"),
        "flip_y":    ("Flip Y", 0, 1, False, 1, "bool"),
    },
    "roughness": {
        "shift":    ("Shift", -1.0, 1.0, 0.0, 0.01, 2),
        "contrast": ("Contrast", -1.0, 1.0, 0.0, 0.01, 2),
        "invert":   ("Invert", 0, 1, False, 1, "bool"),
    },
    "metallic": {
        "scale": ("Scale", 0.0, 2.0, 1.0, 0.01, 2),
        "shift": ("Shift", -1.0, 1.0, 0.0, 0.01, 2),
    },
    "height": {
        "contrast":  ("Contrast", -1.0, 1.0, 0.0, 0.01, 2),
        "shift":     ("Shift", -1.0, 1.0, 0.0, 0.01, 2),
        "smoothing": ("Smoothing", 0.0, 1.0, 0.0, 0.01, 2),
        "invert":    ("Invert", 0, 1, False, 1, "bool"),
    },
    "ao": {
        "strength": ("Strength", 0.0, 2.0, 1.0, 0.01, 2),
    },
}
OUTPUT_SIZES = ("keep", "2048", "1024", "512")


def neutral() -> dict[str, Any]:
    d: dict[str, Any] = {m: {k: spec[3] for k, spec in ctrls.items()} for m, ctrls in CONTROLS.items()}
    d["output_size"] = "keep"
    return d


def normalize(params: dict[str, Any] | None) -> dict[str, Any]:
    """Fills gaps with neutral values and clamps everything into range."""
    out = neutral()
    for m, ctrls in CONTROLS.items():
        src = (params or {}).get(m) or {}
        for k, spec in ctrls.items():
            if k not in src:
                continue
            if spec[5] == "bool":
                out[m][k] = bool(src[k])
            else:
                out[m][k] = float(np.clip(float(src[k]), spec[1], spec[2]))
    size = str((params or {}).get("output_size", "keep"))
    out["output_size"] = size if size in OUTPUT_SIZES else "keep"
    return out


def is_neutral(params: dict[str, Any] | None) -> bool:
    return normalize(params) == neutral()


def changed_maps(old: dict[str, Any] | None, new: dict[str, Any] | None) -> list[str]:
    a, b = normalize(old), normalize(new)
    if a["output_size"] != b["output_size"]:
        return list(CONTROLS)
    return [m for m in CONTROLS if a[m] != b[m]]


def _contrast(x: np.ndarray, c: float) -> np.ndarray:
    k = 1.0 + c if c <= 0 else 1.0 / max(1e-3, 1.0 - c * 0.95)
    return (x - 0.5) * k + 0.5


def _hue_rotate(rgb: np.ndarray, degrees: float) -> np.ndarray:
    # rotation around the grey axis in YIQ space
    t = np.deg2rad(degrees)
    c, s = np.cos(t), np.sin(t)
    to_yiq = np.array([[0.299, 0.587, 0.114], [0.596, -0.274, -0.322], [0.211, -0.523, 0.312]], np.float32)
    rot = np.array([[1, 0, 0], [0, c, -s], [0, s, c]], np.float32)
    m = np.linalg.inv(to_yiq) @ rot @ to_yiq
    return rgb @ m.T.astype(np.float32)


def adjust_albedo(a: np.ndarray, p: dict[str, Any]) -> np.ndarray:
    x = a.astype(np.float32)
    if p["exposure"]:
        x = np.power(np.clip(x, 0, 1), 2.2) * (2.0 ** p["exposure"])
        x = np.power(np.clip(x, 0, 1), 1 / 2.2)
    if p["contrast"]:
        x = _contrast(x, p["contrast"])
    if p["saturation"]:
        lum = luminance(np.clip(x, 0, 1))[..., None]
        x = lum + (x - lum) * (1.0 + p["saturation"])
    if p["hue"]:
        x = _hue_rotate(x, p["hue"])
    return np.clip(x, 0, 1).astype(np.float32)


def adjust_normal(n: np.ndarray, p: dict[str, Any]) -> np.ndarray:
    v = n.astype(np.float32) * 2.0 - 1.0
    xy = v[..., :2]
    if p["smoothing"] > 0:
        xy = blur_wrap(xy, p["smoothing"] * 0.01 * min(n.shape[:2]))
    xy = xy * p["strength"]
    if p["flip_x"]:
        xy = xy * np.array([-1.0, 1.0], np.float32)
    if p["flip_y"]:
        xy = xy * np.array([1.0, -1.0], np.float32)
    z = np.maximum(v[..., 2:3], 1e-3)
    out = np.concatenate([xy, z], axis=2)
    out /= np.linalg.norm(out, axis=2, keepdims=True)
    return (out * 0.5 + 0.5).astype(np.float32)


def adjust_roughness(r: np.ndarray, p: dict[str, Any]) -> np.ndarray:
    x = r.astype(np.float32)
    if p["invert"]:
        x = 1.0 - x
    if p["contrast"]:
        x = _contrast(x, p["contrast"])
    return np.clip(x + p["shift"], 0, 1).astype(np.float32)


def adjust_metallic(m: np.ndarray, p: dict[str, Any]) -> np.ndarray:
    return np.clip(m.astype(np.float32) * p["scale"] + p["shift"], 0, 1).astype(np.float32)


def adjust_height(h: np.ndarray, p: dict[str, Any]) -> np.ndarray:
    x = h.astype(np.float32)
    if p["smoothing"] > 0:
        x = blur_wrap(x, p["smoothing"] * 0.01 * min(h.shape))
    if p["invert"]:
        x = 1.0 - x
    if p["contrast"]:
        x = _contrast(x, p["contrast"])
    return np.clip(x + p["shift"], 0, 1).astype(np.float32)


def adjust_ao(a: np.ndarray, p: dict[str, Any]) -> np.ndarray:
    return np.clip(1.0 - (1.0 - a.astype(np.float32)) * p["strength"], 0, 1).astype(np.float32)


_FUNCS = {"albedo": adjust_albedo, "normal": adjust_normal, "roughness": adjust_roughness,
          "metallic": adjust_metallic, "height": adjust_height, "ao": adjust_ao}


def target_size(shape: tuple[int, ...], output_size: str) -> tuple[int, int]:
    h, w = shape[:2]
    if output_size == "keep":
        return w, h
    edge = int(output_size)
    m = max(h, w)
    if m <= edge:
        return w, h
    s = edge / m
    return max(1, round(w * s)), max(1, round(h * s))


def apply(originals: dict[str, np.ndarray], params: dict[str, Any] | None,
          only: list[str] | None = None) -> dict[str, np.ndarray]:
    """Returns adjusted copies of the maps (all, or only those named)."""
    p = normalize(params)
    out: dict[str, np.ndarray] = {}
    for name, arr in originals.items():
        if only is not None and name not in only:
            continue
        x = arr
        tw, th = target_size(arr.shape, p["output_size"])
        if (tw, th) != (arr.shape[1], arr.shape[0]):
            x = resize(arr, tw, th)
            if name == "normal":  # re-normalise after filtering
                v = x * 2 - 1
                v /= np.maximum(np.linalg.norm(v, axis=2, keepdims=True), 1e-6)
                x = v * 0.5 + 0.5
        fn = _FUNCS.get(name)
        out[name] = fn(x, p[name]) if fn else x.astype(np.float32, copy=True)
    return out


def clone(params: dict[str, Any] | None) -> dict[str, Any]:
    return copy.deepcopy(normalize(params))
