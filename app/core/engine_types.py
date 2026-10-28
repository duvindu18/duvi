"""Shared result types (kept separate to avoid import cycles)."""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np


DEFAULT_MARGIN = 1.12


def geom_from_bbox(bbox: np.ndarray) -> np.ndarray:
    """Oriented face geometry ``[cx, cy, w, h, angle_deg, margin]`` for an upright box."""
    x1, y1, x2, y2 = (float(v) for v in bbox[:4])
    return np.array([(x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1, 0.0, DEFAULT_MARGIN], np.float32)


def geom_aabb(geom: np.ndarray) -> np.ndarray:
    """Axis-aligned bounding box of an oriented face rectangle."""
    cx, cy, w, h, ang = (float(v) for v in geom[:5])
    c, s = abs(math.cos(math.radians(ang))), abs(math.sin(math.radians(ang)))
    hx, hy = (w * c + h * s) / 2, (w * s + h * c) / 2
    return np.array([cx - hx, cy - hy, cx + hx, cy + hy], np.float32)


@dataclass
class Detection:
    bbox: np.ndarray  # (4,) float32 x1, y1, x2, y2 axis-aligned, in frame pixels (used for tracking)
    score: float
    kps: np.ndarray | None = None  # (5, 2) eyes, nose, mouth corners
    # Oriented face box [cx, cy, w, h, angle_deg, margin]: the detector box in the
    # frame of the pass that found the face (angle = that frame's rotation,
    # cv2.ellipse convention). ``margin`` scales the inscribed ellipse so it
    # covers the face even when the face is tilted inside that box.
    # None means upright, i.e. identical to ``bbox``.
    geom: np.ndarray | None = None

    @property
    def width(self) -> float:
        return float(self.bbox[2] - self.bbox[0])

    @property
    def height(self) -> float:
        return float(self.bbox[3] - self.bbox[1])

    @property
    def oriented(self) -> np.ndarray:
        return self.geom if self.geom is not None else geom_from_bbox(self.bbox)
