"""Shared result types (kept separate to avoid import cycles)."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class Detection:
    bbox: np.ndarray  # (4,) float32 x1, y1, x2, y2 in frame pixels
    score: float
    kps: np.ndarray | None = None  # (5, 2) eyes, nose, mouth corners

    @property
    def width(self) -> float:
        return float(self.bbox[2] - self.bbox[0])

    @property
    def height(self) -> float:
        return float(self.bbox[3] - self.bbox[1])
