"""ByteTrack multi-object tracker specialised for faces.

Implements the two-stage association from *ByteTrack: Multi-Object Tracking by
Associating Every Detection Box* (Zhang et al., ECCV 2022):

1. High-confidence detections are matched to all tracked + lost tracks by IoU.
2. Remaining *tracked* tracks are matched to low-confidence detections, which
   recovers faces that are partially occluded, blurred by motion or turned away
   - exactly the moments when a naive tracker would drop a face and leave it
   un-anonymized.
3. Unconfirmed tracks are matched to leftover high detections; new tracks are
   spawned from what is still unmatched.

Track IDs are stable for the lifetime of a track and are what the recognition
layer attaches identities to.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from enum import IntEnum

import numpy as np
from scipy.optimize import linear_sum_assignment

from app.core.config import TrackerConfig
from app.core.engine import Detection


class TrackState(IntEnum):
    NEW = 0
    TRACKED = 1
    LOST = 2
    REMOVED = 3


class KalmanFilter:
    """Constant-velocity Kalman filter over (cx, cy, aspect, h)."""

    _std_pos = 1.0 / 20
    _std_vel = 1.0 / 160

    def __init__(self) -> None:
        ndim, dt = 4, 1.0
        self._motion = np.eye(2 * ndim)
        for i in range(ndim):
            self._motion[i, ndim + i] = dt
        self._update = np.eye(ndim, 2 * ndim)

    def initiate(self, measurement: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        mean = np.r_[measurement, np.zeros_like(measurement)]
        h = measurement[3]
        std = [
            2 * self._std_pos * h, 2 * self._std_pos * h, 1e-2, 2 * self._std_pos * h,
            10 * self._std_vel * h, 10 * self._std_vel * h, 1e-5, 10 * self._std_vel * h,
        ]
        return mean, np.diag(np.square(std))

    def predict(self, mean: np.ndarray, cov: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        h = mean[3]
        std = [
            self._std_pos * h, self._std_pos * h, 1e-2, self._std_pos * h,
            self._std_vel * h, self._std_vel * h, 1e-5, self._std_vel * h,
        ]
        mean = self._motion @ mean
        cov = self._motion @ cov @ self._motion.T + np.diag(np.square(std))
        return mean, cov

    def update(self, mean: np.ndarray, cov: np.ndarray, measurement: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        h = mean[3]
        std = [self._std_pos * h, self._std_pos * h, 1e-1, self._std_pos * h]
        proj_mean = self._update @ mean
        proj_cov = self._update @ cov @ self._update.T + np.diag(np.square(std))
        chol = np.linalg.cholesky(proj_cov)
        gain = np.linalg.solve(chol.T, np.linalg.solve(chol, (cov @ self._update.T).T)).T
        mean = mean + gain @ (measurement - proj_mean)
        cov = cov - gain @ proj_cov @ gain.T
        return mean, cov


def _tlbr_to_xyah(b: np.ndarray) -> np.ndarray:
    w, h = b[2] - b[0], b[3] - b[1]
    return np.array([b[0] + w / 2, b[1] + h / 2, w / max(h, 1e-6), h], dtype=np.float64)


def _xyah_to_tlbr(m: np.ndarray) -> np.ndarray:
    w = m[2] * m[3]
    h = m[3]
    return np.array([m[0] - w / 2, m[1] - h / 2, m[0] + w / 2, m[1] + h / 2], dtype=np.float32)


def iou_matrix(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Pairwise IoU between (N,4) and (M,4) tlbr boxes."""
    if len(a) == 0 or len(b) == 0:
        return np.zeros((len(a), len(b)), dtype=np.float32)
    a = a[:, None, :]
    b = b[None, :, :]
    iw = np.clip(np.minimum(a[..., 2], b[..., 2]) - np.maximum(a[..., 0], b[..., 0]), 0, None)
    ih = np.clip(np.minimum(a[..., 3], b[..., 3]) - np.maximum(a[..., 1], b[..., 1]), 0, None)
    inter = iw * ih
    area_a = (a[..., 2] - a[..., 0]) * (a[..., 3] - a[..., 1])
    area_b = (b[..., 2] - b[..., 0]) * (b[..., 3] - b[..., 1])
    return (inter / np.maximum(area_a + area_b - inter, 1e-6)).astype(np.float32)


def _assign(cost: np.ndarray, max_cost: float) -> tuple[list[tuple[int, int]], list[int], list[int]]:
    if cost.size == 0:
        return [], list(range(cost.shape[0])), list(range(cost.shape[1]))
    rows, cols = linear_sum_assignment(cost)
    matches = [(r, c) for r, c in zip(rows, cols) if cost[r, c] <= max_cost]
    matched_r = {r for r, _ in matches}
    matched_c = {c for _, c in matches}
    return (
        matches,
        [r for r in range(cost.shape[0]) if r not in matched_r],
        [c for c in range(cost.shape[1]) if c not in matched_c],
    )


@dataclass(eq=False)
class FaceTrack:
    track_id: int
    mean: np.ndarray
    cov: np.ndarray
    score: float
    start_frame: int
    frame_id: int
    state: TrackState = TrackState.NEW
    hits: int = 1
    score_ema: float = 0.0  # smoothed confidence; ranks faces in 1/2-face mode
    peak_ema: float = 0.0  # best smoothed confidence ever reached
    activated: bool = False
    detection: Detection | None = None  # detection matched in the current frame
    last_bbox: np.ndarray = field(default_factory=lambda: np.zeros(4, np.float32))
    last_geom: np.ndarray = field(default_factory=lambda: np.zeros(5, np.float32))
    # Identity bookkeeping, owned by the recognition layer.
    identity: str | None = None  # None = unknown (or not yet recognised)
    identity_sim: float = 0.0
    recognized: bool = False  # at least one recognition attempt has completed
    votes: deque = field(default_factory=lambda: deque(maxlen=7))
    last_rec_frame: int = -(10**9)

    @property
    def bbox(self) -> np.ndarray:
        """Matched detection box, else the last observed box moved by the predicted motion."""
        if self.detection is not None:
            return self.detection.bbox
        dx, dy = self._drift()
        return self.last_bbox + np.array([dx, dy, dx, dy], np.float32)

    @property
    def geom(self) -> np.ndarray:
        """Oriented face geometry; held tracks keep their last size and tilt and
        only move with the motion model (they never grow)."""
        if self.detection is not None:
            return self.detection.oriented
        dx, dy = self._drift()
        g = self.last_geom.copy()
        g[0] += dx
        g[1] += dy
        return g

    def _drift(self) -> tuple[float, float]:
        pred = _xyah_to_tlbr(self.mean)
        last = self.last_bbox
        return (
            float((pred[0] + pred[2] - last[0] - last[2]) / 2),
            float((pred[1] + pred[3] - last[1] - last[3]) / 2),
        )


class ByteTracker:
    def __init__(self, cfg: TrackerConfig, low_threshold: float) -> None:
        self.cfg = cfg
        self.low_threshold = low_threshold
        self.kf = KalmanFilter()
        self.frame_id = 0
        self._next_id = 1
        self.tracked: list[FaceTrack] = []
        self.lost: list[FaceTrack] = []

    def reset(self) -> None:
        self.frame_id = 0
        self._next_id = 1
        self.tracked.clear()
        self.lost.clear()

    # ------------------------------------------------------------------
    def _activate(self, det: Detection) -> FaceTrack:
        mean, cov = self.kf.initiate(_tlbr_to_xyah(det.bbox))
        track = FaceTrack(
            track_id=self._next_id, mean=mean, cov=cov, score=det.score,
            start_frame=self.frame_id, frame_id=self.frame_id, detection=det, last_bbox=det.bbox.copy(),
            last_geom=det.oriented.copy(),
        )
        self._next_id += 1
        track.score_ema = track.peak_ema = det.score
        track.state = TrackState.TRACKED
        track.activated = self.frame_id == 1 or self.cfg.min_hits <= 1
        return track

    def _update(self, track: FaceTrack, det: Detection) -> None:
        track.mean, track.cov = self.kf.update(track.mean, track.cov, _tlbr_to_xyah(det.bbox))
        track.detection = det
        track.last_bbox = det.bbox.copy()
        track.last_geom = det.oriented.copy()
        track.score = det.score
        track.score_ema = 0.8 * track.score_ema + 0.2 * det.score
        track.peak_ema = max(track.peak_ema, track.score_ema)
        track.frame_id = self.frame_id
        track.hits += 1
        track.state = TrackState.TRACKED
        if track.hits >= self.cfg.min_hits:
            track.activated = True

    @staticmethod
    def _boxes(tracks: list[FaceTrack]) -> np.ndarray:
        if not tracks:
            return np.zeros((0, 4), np.float32)
        return np.stack([_xyah_to_tlbr(t.mean) for t in tracks])

    @staticmethod
    def _det_boxes(dets: list[Detection]) -> np.ndarray:
        if not dets:
            return np.zeros((0, 4), np.float32)
        return np.stack([d.bbox for d in dets])

    def update(self, detections: list[Detection]) -> list[FaceTrack]:
        """Advance one frame. Returns confirmed tracks visible in this frame."""
        self.frame_id += 1
        high = [d for d in detections if d.score >= self.cfg.high_threshold]
        low = [d for d in detections if self.low_threshold <= d.score < self.cfg.high_threshold]

        for t in self.tracked + self.lost:
            t.detection = None
            t.mean, t.cov = self.kf.predict(t.mean, t.cov)

        confirmed = [t for t in self.tracked if t.activated]
        unconfirmed = [t for t in self.tracked if not t.activated]
        pool = confirmed + self.lost

        # Stage 1: high-score detections vs every confirmed / lost track.
        ious = iou_matrix(self._boxes(pool), self._det_boxes(high))
        scores = np.array([d.score for d in high], dtype=np.float32)
        cost = 1.0 - ious * scores[None, :] if len(high) else 1.0 - ious  # ByteTrack score fusion
        matches, u_pool, u_high = _assign(cost, 1.0 - self.cfg.match_iou)
        for ti, di in matches:
            self._update(pool[ti], high[di])

        # Stage 2: low-score detections vs still-unmatched *tracked* tracks.
        remain = [pool[i] for i in u_pool if pool[i].state == TrackState.TRACKED]
        ious = iou_matrix(self._boxes(remain), self._det_boxes(low))
        matches, u_remain, _ = _assign(1.0 - ious, 1.0 - self.cfg.low_match_iou)
        for ti, di in matches:
            self._update(remain[ti], low[di])
        for i in u_remain:
            remain[i].state = TrackState.LOST

        # Stage 3: unconfirmed tracks vs leftover high detections.
        left_high = [high[i] for i in u_high]
        ious = iou_matrix(self._boxes(unconfirmed), self._det_boxes(left_high))
        matches, u_unconf, u_new = _assign(1.0 - ious, 1.0 - self.cfg.match_iou)
        for ti, di in matches:
            self._update(unconfirmed[ti], left_high[di])
        for i in u_unconf:
            unconfirmed[i].state = TrackState.REMOVED

        # Stage 4: spawn new tracks.
        new_tracks = [
            self._activate(left_high[i]) for i in u_new if left_high[i].score >= self.cfg.new_track_threshold
        ]

        everyone = pool + unconfirmed + new_tracks
        for t in everyone:
            if t.state == TrackState.LOST and self.frame_id - t.frame_id > self.cfg.max_lost_frames:
                t.state = TrackState.REMOVED
        self.tracked = [t for t in everyone if t.state == TrackState.TRACKED]
        self.lost = [t for t in everyone if t.state == TrackState.LOST]
        self._dedupe()
        return [t for t in self.tracked if t.activated]

    def _dedupe(self) -> None:
        """Drop lost tracks that overlap a live track (same face re-acquired)."""
        if not self.tracked or not self.lost:
            return
        ious = iou_matrix(self._boxes(self.lost), self._boxes(self.tracked))
        keep = []
        for i, lt in enumerate(self.lost):
            j = int(np.argmax(ious[i]))
            if ious[i, j] > 0.85:
                live = self.tracked[j]
                if not live.recognized and lt.recognized:
                    live.identity, live.identity_sim, live.recognized = lt.identity, lt.identity_sim, True
                continue
            keep.append(lt)
        self.lost = keep

    def recently_lost(self, max_frames: int, min_hits: int = 2) -> list[FaceTrack]:
        """Established tracks that disappeared within ``max_frames`` (anti-flicker).
        One-frame detections (likely false positives) are not held."""
        return [
            t for t in self.lost
            if t.activated and t.hits >= min_hits and self.frame_id - t.frame_id <= max_frames
        ]
