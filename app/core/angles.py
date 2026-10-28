"""Rotation-invariant face detection.

Face detectors such as SCRFD and YuNet are trained on roughly upright faces
and lose most detections beyond about ±35° of in-plane tilt (head on a
shoulder, lying down, camera mounted sideways or upside down). This module
runs the detector on rotated copies of the frame, maps every hit back to the
original frame and merges them with the upright pass.

Hits from a rotated pass keep their *orientation*: they are reported as a
tilted face rectangle (``Detection.geom``), so the anonymizer can draw a
tight, tilted ellipse instead of an inflated axis-aligned box.

Re-running every angle on every frame would multiply the cost, so a scheduler
spreads the rotated passes over consecutive frames (round robin). Any angle
that just produced a confident face becomes *hot* and is re-run on every frame
while it keeps finding faces. Every angle runs on the first frame.

Performance: all rotated passes work on one shared, downscaled copy of the
frame (rotating a 4K frame costs tens of milliseconds per pass) and use one
fixed detector input size, so TensorRT never rebuilds its engine for a new
input shape.
"""

from __future__ import annotations

import math
from typing import Callable

import cv2
import numpy as np

from app.core.engine_types import DEFAULT_MARGIN, Detection, geom_aabb

# Presets: extra angles (degrees, counter-clockwise) beyond the upright pass.
COVERAGE_PRESETS: dict[str, list[int]] = {
    "off": [],
    "tilt": [40, -40],  # heads tilted up to about ±75°
    "full": [40, -40, 90, -90, 135, -135, 180],  # any in-plane rotation
}
HOT_FRAMES = 12  # frames an angle stays scheduled after its last hit
ROTATED_INPUT_SCALE = 1.4  # rotated canvases are larger; fixed detector input = base x 1.4


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


def map_detection(det: Detection, inv: np.ndarray, shape: tuple[int, int], scale: float = 1.0) -> Detection | None:
    """Map a detection from a rotated (and ``scale``-downscaled) frame back to
    the original frame, keeping the face's true orientation and size."""
    h, w = shape
    x1, y1, x2, y2 = (float(v) for v in det.bbox)
    center = inv @ np.array([(x1 + x2) / 2, (y1 + y2) / 2, 1.0])
    axis_x = inv[:, :2] @ np.array([1.0, 0.0])  # rotated-frame x axis in original coordinates
    angle = math.degrees(math.atan2(axis_x[1], axis_x[0]))
    geom = np.array(
        [center[0] / scale, center[1] / scale, (x2 - x1) / scale, (y2 - y1) / scale, angle, DEFAULT_MARGIN],
        np.float32,
    )
    box = geom_aabb(geom)
    box = np.array([max(0.0, box[0]), max(0.0, box[1]), min(w, box[2]), min(h, box[3])], np.float32)
    if box[2] - box[0] < 2 or box[3] - box[1] < 2:
        return None
    kps = None
    if det.kps is not None:
        k = np.hstack([det.kps.astype(np.float64), np.ones((len(det.kps), 1))])
        kps = ((k @ inv.T) / scale).astype(np.float32)  # alignment handles any rotation
    return Detection(bbox=box, score=det.score, kps=kps, geom=geom)


def landmark_roll(kps: np.ndarray) -> float | None:
    """In-plane roll of a face (degrees, cv2.ellipse convention) from its five
    landmarks: the eye line and the eyes-to-mouth axis, combined as vectors so
    either one alone (e.g. a profile with a hidden eye) still contributes."""
    if kps is None or len(kps) < 5:
        return None
    le, re_, nose, ml, mr = (kps[i].astype(np.float64) for i in range(5))
    eye_vec = re_ - le
    axis = (ml + mr) / 2 - (le + re_) / 2  # points "down" the face
    down_as_x = np.array([axis[1], -axis[0]])  # rotate -90° so it points along the eye line
    v = eye_vec / (np.linalg.norm(eye_vec) + 1e-6) + down_as_x / (np.linalg.norm(down_as_x) + 1e-6)
    if np.linalg.norm(v) < 1e-3:
        return None
    return math.degrees(math.atan2(v[1], v[0]))


def refine_geometry(det: Detection) -> Detection:
    """Set the face's coverage margin from how tilted it is inside its box.

    A face tilted by a residual angle inside the detector box (the box is
    upright in the frame of the pass that found it) reaches beyond the ellipse
    inscribed in that box. The margin needed to cover the face oval grows with
    the residual: about 1.07 at 10°, 1.15 at 25° for typical face proportions.
    The residual comes from the landmarks; 3/4 and profile views bias that
    estimate by up to ~10°, which the formula includes. A face lying sideways
    in the box (residual near ±90°) gets the box turned by a quarter.
    """
    roll = landmark_roll(det.kps)
    if roll is None:
        return det
    geom = det.oriented.copy()
    base = float(geom[4])
    residual = (roll - base + 180.0) % 360.0 - 180.0
    quarter = round(residual / 90.0)
    if quarter:
        geom[4] = base + 90.0 * quarter
        residual -= 90.0 * quarter
        if quarter % 2:
            geom[2], geom[3] = geom[3], geom[2]
    geom[5] = float(np.clip(1.08 + 0.0035 * (abs(residual) + 10.0), 1.10, 1.26))
    return Detection(det.bbox, det.score, det.kps, geom)


def _overlap(a: np.ndarray, b: np.ndarray) -> tuple[float, float]:
    """(IoU, intersection over the smaller box)."""
    iw = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    ih = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = iw * ih
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    return inter / max(1e-6, area_a + area_b - inter), inter / max(1e-6, min(area_a, area_b))


def merge_detections(groups: list[list[Detection]]) -> list[Detection]:
    """Merge the passes: overlapping hits are one face, represented by the most
    confident hit (whose geometry matches that face's orientation best)."""
    merged: list[Detection] = []
    for det in sorted((d for g in groups for d in g), key=lambda d: -(d.score + 0.3 * _orientation_agreement(d))):
        if not any(_same_face(m.bbox, det.bbox) for m in merged):
            merged.append(det)
    return merged


def _orientation_agreement(det: Detection) -> float:
    """1 when the pass that found the face matches its landmark roll, 0 when 90° off."""
    roll = landmark_roll(det.kps)
    if roll is None:
        return 0.5
    base = float(det.geom[4]) if det.geom is not None else 0.0
    diff = abs((roll - base + 180.0) % 360.0 - 180.0)
    return max(0.0, 1.0 - diff / 90.0)


def _same_face(a: np.ndarray, b: np.ndarray) -> bool:
    iou, ios = _overlap(a, b)
    return iou > 0.35 or ios > 0.6


class AngleScheduler:
    """Chooses which rotated passes run on the current frame."""

    def __init__(self, angles: list[int], per_frame: int) -> None:
        self.angles = list(angles)
        self.per_frame = max(0, per_frame)
        self._cursor = 0
        self._hot: dict[int, int] = {}

    def plan(self) -> list[int]:
        """Hot angles (up to the budget + 1) plus at least one round-robin angle,
        so a face that keeps one angle busy can never starve the other angles."""
        if not self.angles or self.per_frame == 0:
            return []
        # Each tilted face keeps its own best angle hot, so several faces at
        # different tilts are all re-detected every frame (bounded at 3 + budget).
        chosen = sorted(self._hot, key=lambda a: -self._hot[a])[: max(self.per_frame + 1, 3)]
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

    def reset(self) -> None:
        self._hot.clear()
        self._cursor = 0


class MultiAngleDetector:
    """Wraps an upright ``detect(frame, input_scale)`` callable with scheduled rotated passes."""

    def __init__(
        self,
        detect: Callable[[np.ndarray, float], list[Detection]],
        angles: list[int],
        per_frame: int,
        hot_threshold: float = 0.35,
        base_side: int = 960,
    ) -> None:
        self._detect = detect
        self.scheduler = AngleScheduler(angles, per_frame)
        self.hot_threshold = hot_threshold  # only confident faces keep an angle hot / are kept
        self.base_side = base_side  # detector input of the upright pass (pixels)
        self._frames = 0

    def reset(self) -> None:
        """New scene (seek / new source): sweep every angle on the next frame."""
        self._frames = 0
        self.scheduler.reset()

    def detect(self, frame: np.ndarray, exhaustive: bool = False) -> list[Detection]:
        """``exhaustive`` runs every angle (used when indexing still photos)."""
        groups = [self._detect(frame, 1.0)]
        first = self._frames == 0
        self._frames += 1
        plan = list(self.scheduler.angles) if (exhaustive or first) else self.scheduler.plan()
        self.scheduler.tick()
        if not plan:
            return [refine_geometry(d) for d in groups[0]]

        # One shared downscaled copy: no rotated canvas (at most the frame
        # diagonal) needs more pixels than the fixed rotated detector input.
        h, w = frame.shape[:2]
        target = self.base_side * ROTATED_INPUT_SCALE
        scale = min(1.0, target / math.hypot(w, h))
        small = frame if scale >= 0.999 else cv2.resize(
            frame, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA
        )
        origin: dict[int, int] = {}
        for angle in plan:
            rotated, inv = rotate_frame(small, angle)
            mapped = []
            for d in self._detect(rotated, ROTATED_INPUT_SCALE):
                if d.score < self.hot_threshold:
                    continue  # low-score hits only help upright tracking; rotated ones are noise
                m = map_detection(d, inv, (h, w), scale)
                if m is not None:
                    mapped.append(m)
                    origin[id(m)] = angle
            groups.append(mapped)
        merged = merge_detections(groups)
        # Keep hot exactly the pass that best sees each face (one angle per tilted face).
        for d in merged:
            if id(d) in origin and d.score >= self.hot_threshold:
                self.scheduler.report(origin[id(d)], 1)
        return [refine_geometry(d) for d in merged]
