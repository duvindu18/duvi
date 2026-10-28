"""Rotation-invariant face detection.

Face detectors such as SCRFD and YuNet are trained on roughly upright faces
and lose most detections beyond about ±35° of in-plane tilt (head on a
shoulder, lying down, camera mounted sideways or upside down). This module
runs the detector on rotated copies of the frame, maps every hit back to the
original frame and merges them with the upright pass.

Re-running every angle on every frame would multiply the cost, so a scheduler
spreads the rotated passes over consecutive frames (round robin). Any angle
that just produced a face becomes *hot* and is re-run on every frame while it
keeps finding faces. A persistently tilted face is therefore detected on every
frame, and the tracker plus the "hold after loss" window bridge the few frames
before a new angle comes round again.
"""

from __future__ import annotations

from typing import Callable

import cv2
import numpy as np

from app.core.engine_types import Detection

# Presets: extra angles (degrees, counter-clockwise) beyond the upright pass.
COVERAGE_PRESETS: dict[str, list[int]] = {
    "off": [],
    "tilt": [40, -40],  # heads tilted up to about ±75°
    "full": [40, -40, 90, -90, 135, -135, 180],  # any in-plane rotation
}
HOT_FRAMES = 12  # frames an angle stays scheduled after its last hit


def rotate_frame(frame: np.ndarray, angle: float) -> tuple[np.ndarray, np.ndarray]:
    """Rotate on an expanded canvas (nothing is cropped); returns (image, inverse 2x3 affine)."""
    h, w = frame.shape[:2]
    a = angle % 360
    if a in (90, 180, 270):  # exact and much faster than warpAffine
        code = {90: cv2.ROTATE_90_COUNTERCLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_CLOCKWISE}[a]
        img = cv2.rotate(frame, code)
        m = cv2.getRotationMatrix2D((w / 2, h / 2), a, 1.0)
        nh, nw = img.shape[:2]
    else:
        m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
        cos, sin = abs(m[0, 0]), abs(m[0, 1])
        nw, nh = int(round(h * sin + w * cos)), int(round(h * cos + w * sin))
        img = None
    m[0, 2] += nw / 2 - w / 2
    m[1, 2] += nh / 2 - h / 2
    if img is None:
        img = cv2.warpAffine(frame, m, (nw, nh), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    return img, cv2.invertAffineTransform(m)


def map_detection(det: Detection, inv: np.ndarray, shape: tuple[int, int]) -> Detection | None:
    """Map a detection from a rotated frame back. The box becomes the axis-aligned
    bounding box of the rotated rectangle, so it always contains the whole face."""
    h, w = shape
    x1, y1, x2, y2 = (float(v) for v in det.bbox)
    corners = np.array([[x1, y1, 1], [x2, y1, 1], [x2, y2, 1], [x1, y2, 1]], np.float64)
    pts = corners @ inv.T
    bx1, by1 = pts.min(axis=0)
    bx2, by2 = pts.max(axis=0)
    box = np.array([max(0, bx1), max(0, by1), min(w, bx2), min(h, by2)], np.float32)
    if box[2] - box[0] < 2 or box[3] - box[1] < 2:
        return None
    kps = None
    if det.kps is not None:
        k = np.hstack([det.kps.astype(np.float64), np.ones((len(det.kps), 1))])
        kps = (k @ inv.T).astype(np.float32)  # alignment handles any rotation
    return Detection(bbox=box, score=det.score, kps=kps)


def _overlap(a: np.ndarray, b: np.ndarray) -> tuple[float, float]:
    """(IoU, intersection over the smaller box)."""
    iw = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    ih = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = iw * ih
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    return inter / max(1e-6, area_a + area_b - inter), inter / max(1e-6, min(area_a, area_b))


def merge_detections(groups: list[list[Detection]]) -> list[Detection]:
    """Merge the passes. Overlapping hits become one face whose box is the
    union (privacy: never shrink coverage) and whose landmarks come from the
    most confident pass."""
    merged: list[Detection] = []
    candidates = [d for g in groups for d in g]
    candidates.sort(key=lambda d: -d.score)
    for det in candidates:
        for m in merged:
            iou, ios = _overlap(m.bbox, det.bbox)
            if iou > 0.3 or ios > 0.7:
                m.bbox = np.array(
                    [min(m.bbox[0], det.bbox[0]), min(m.bbox[1], det.bbox[1]),
                     max(m.bbox[2], det.bbox[2]), max(m.bbox[3], det.bbox[3])], np.float32,
                )
                break
        else:
            merged.append(Detection(det.bbox.copy(), det.score, det.kps))
    return merged


class AngleScheduler:
    """Chooses which rotated passes run on the current frame."""

    def __init__(self, angles: list[int], per_frame: int) -> None:
        self.angles = list(angles)
        self.per_frame = max(0, per_frame)
        self._cursor = 0
        self._hot: dict[int, int] = {}

    def plan(self) -> list[int]:
        """Hot angles (up to the budget) plus at least one round-robin angle, so
        a face that keeps one angle busy can never starve the other angles."""
        if not self.angles or self.per_frame == 0:
            return []
        # Several tilted faces can each need their own angle: hot angles may use
        # one slot more than the budget, and the sweep always gets a slot too.
        chosen = sorted(self._hot, key=lambda a: -self._hot[a])[: self.per_frame + 1]
        sweep = max(1, self.per_frame - len(chosen))
        for _ in range(len(self.angles)):
            if sweep == 0:
                break
            a = self.angles[self._cursor % len(self.angles)]
            self._cursor += 1
            if a not in chosen:
                chosen.append(a)
                sweep -= 1
        return chosen

    def report(self, angle: int, hits: int) -> None:
        if hits:
            self._hot[angle] = HOT_FRAMES

    def tick(self) -> None:
        for a in list(self._hot):
            self._hot[a] -= 1
            if self._hot[a] <= 0:
                del self._hot[a]


class MultiAngleDetector:
    """Wraps an upright ``detect(frame)`` callable with scheduled rotated passes."""

    def __init__(
        self,
        detect: Callable[[np.ndarray, float], list[Detection]],
        angles: list[int],
        per_frame: int,
        hot_threshold: float = 0.35,
    ) -> None:
        self._detect = detect
        self.scheduler = AngleScheduler(angles, per_frame)
        self.hot_threshold = hot_threshold  # only confident faces keep an angle hot
        self._frames = 0

    def detect(self, frame: np.ndarray, exhaustive: bool = False) -> list[Detection]:
        """``exhaustive`` runs every angle (used when indexing still photos)."""
        groups = [self._detect(frame, 1.0)]
        # The first frame of a stream sweeps every angle, so faces that are
        # already in view at an unusual angle are found immediately.
        first = self._frames == 0
        self._frames += 1
        plan = list(self.scheduler.angles) if (exhaustive or first) else self.scheduler.plan()
        self.scheduler.tick()
        shape = frame.shape[:2]
        for angle in plan:
            rotated, inv = rotate_frame(frame, angle)
            # The rotated canvas is larger; enlarge the detector input to match
            # so faces keep the same pixel size as in the upright pass.
            grow = max(rotated.shape[:2]) / max(shape)
            mapped = [m for d in self._detect(rotated, grow) if (m := map_detection(d, inv, shape)) is not None]
            if not exhaustive or first:
                self.scheduler.report(angle, sum(d.score >= self.hot_threshold for d in mapped))
            groups.append(mapped)
        if len(groups) == 1:
            return groups[0]
        return merge_detections(groups)
