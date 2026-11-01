"""Manual corrections to automatic face tracking.

The user can fix what the detector got wrong, on the paused preview:

* **remove** - a blur sits where there is no face. The track under the box is
  never anonymized again while it lives, and short-lived re-detections in the
  same spot (flickering false positives) are suppressed for a while too.
* **restore** - undo a removal for the track under the box.
* **add** - a face was missed or its box is misplaced. A *manual track* is
  started from the drawn box and follows the face: it locks onto an
  overlapping detection (keeping the user's offset and size) and falls back to
  template matching when the detector sees nothing. Moving or resizing an
  automatic box is a ``remove`` of the old box plus an ``add`` of the new one.

Edits are stored with the media time they were made at (``t_ms``) and a box
in normalized coordinates, so the same list drives the preview and the
frame-exact export of that file, where track ids differ.
"""

from __future__ import annotations

import itertools
import json
import logging
from dataclasses import asdict, dataclass, field
from pathlib import Path

import cv2
import numpy as np

log = logging.getLogger(__name__)

REMOVE, RESTORE, ADD = "remove", "restore", "add"
LOOKBACK_MS = 2000.0  # after a seek, edits made this recently still apply
ZONE_MS = 1500.0  # how long a removed spot stays suppressed after its track ends
MANUAL_HOLD_MS = 3000.0  # a manual track that loses its face keeps blurring this long
_ids = itertools.count(1)


@dataclass
class FaceEdit:
    kind: str  # remove | restore | add
    t_ms: float
    box: tuple[float, float, float, float]  # normalized x1, y1, x2, y2
    group: int = 0  # edits made by one gesture share a group (undone together)
    id: int = field(default_factory=lambda: next(_ids))

    def px(self, w: int, h: int) -> np.ndarray:
        x1, y1, x2, y2 = self.box
        return np.array([x1 * w, y1 * h, x2 * w, y2 * h], np.float32)

    def to_json(self) -> dict:
        d = asdict(self)
        d.pop("id")
        return d

    @classmethod
    def from_json(cls, d: dict) -> "FaceEdit":
        return cls(str(d["kind"]), float(d["t_ms"]), tuple(float(v) for v in d["box"]), int(d.get("group", 0)))


def normalize_box(box, w: int, h: int) -> tuple[float, float, float, float]:
    x1, y1, x2, y2 = (float(v) for v in box)
    x1, x2 = sorted((x1, x2))
    y1, y2 = sorted((y1, y2))
    return (max(0.0, x1 / w), max(0.0, y1 / h), min(1.0, x2 / w), min(1.0, y2 / h))


def iou(a: np.ndarray, b: np.ndarray) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return float(inter / union) if union > 0 else 0.0


def _center_inside(box: np.ndarray, target: np.ndarray) -> bool:
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    return bool(target[0] <= cx <= target[2] and target[1] <= cy <= target[3])


def match_score(edit_box: np.ndarray, box: np.ndarray) -> float:
    """How well a track's box matches the box the user acted on (0 = not at all)."""
    s = iou(edit_box, box)
    if s < 0.2 and (_center_inside(edit_box, box) or _center_inside(box, edit_box)):
        s = 0.2
    return s


class ManualTrack:
    """A user-drawn face box that keeps following its face."""

    TEMPLATE = 48  # template side (px) after downscaling

    def __init__(self, track_id: int, box: np.ndarray, frame: np.ndarray, t_ms: float) -> None:
        self.track_id = track_id
        self.box = box.astype(np.float32)
        self.last_seen_ms = t_ms
        self.offset: np.ndarray | None = None  # box relative to the detection it follows
        self.velocity = (0.0, 0.0)
        self._template: np.ndarray | None = None
        self._grab_template(frame)

    @property
    def geom(self) -> np.ndarray:
        x1, y1, x2, y2 = self.box
        return np.array([(x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1, 0.0, 1.0], np.float32)  # margin 1: exactly the drawn box

    def _scale(self) -> float:
        w, h = self.box[2] - self.box[0], self.box[3] - self.box[1]
        return min(1.0, self.TEMPLATE / max(1.0, min(w, h)))

    @staticmethod
    def _gray(frame: np.ndarray) -> np.ndarray:
        return cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if frame.ndim == 3 else frame

    def _grab_template(self, frame: np.ndarray) -> None:
        h, w = frame.shape[:2]
        x1, y1, x2, y2 = (int(round(v)) for v in self.box)
        x1, y1, x2, y2 = max(0, x1), max(0, y1), min(w, x2), min(h, y2)
        if x2 - x1 < 4 or y2 - y1 < 4:
            return
        crop = self._gray(frame[y1:y2, x1:x2])
        s = self._scale()
        self._template = cv2.resize(crop, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s < 1 else crop.copy()

    def _move_to(self, box: np.ndarray, frames: int) -> None:
        old = self.geom
        self.box = box.astype(np.float32)
        new = self.geom
        n = max(1, frames)
        self.velocity = ((new[0] - old[0]) / n, (new[1] - old[1]) / n)

    def update(self, frame: np.ndarray, det_boxes: list[np.ndarray], t_ms: float, frames: int) -> None:
        # 1) Follow an overlapping detection, keeping the user's placement.
        best, best_s = None, 0.3
        for d in det_boxes:
            ref = self._predicted_det_box() if self.offset is not None else self.box
            s = iou(ref, d)
            if s > best_s:
                best, best_s = d, s
        if best is not None:
            dw, dh = max(1.0, best[2] - best[0]), max(1.0, best[3] - best[1])
            if self.offset is None:
                self.offset = np.array(
                    [(self.box[0] - best[0]) / dw, (self.box[1] - best[1]) / dh,
                     (self.box[2] - best[2]) / dw, (self.box[3] - best[3]) / dh], np.float32,
                )
            box = best + self.offset * np.array([dw, dh, dw, dh], np.float32)
            self._move_to(box, frames)
            self._det_box = best.copy()
            self.last_seen_ms = t_ms
            self._grab_template(frame)
            return
        # 2) No detection: template matching around the last position.
        if self._template is None:
            return
        s = self._scale()
        bw, bh = self.box[2] - self.box[0], self.box[3] - self.box[1]
        h, w = frame.shape[:2]
        sx1, sy1 = int(max(0, self.box[0] - bw)), int(max(0, self.box[1] - bh))
        sx2, sy2 = int(min(w, self.box[2] + bw)), int(min(h, self.box[3] + bh))
        region = self._gray(frame[sy1:sy2, sx1:sx2])
        if s < 1:
            region = cv2.resize(region, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        th, tw = self._template.shape[:2]
        if region.shape[0] < th or region.shape[1] < tw:
            return
        res = cv2.matchTemplate(region, self._template, cv2.TM_CCOEFF_NORMED)
        _, score, _, loc = cv2.minMaxLoc(res)
        if score < 0.55:
            return  # stay put (privacy first) until MANUAL_HOLD_MS runs out
        nx, ny = sx1 + loc[0] / s, sy1 + loc[1] / s
        self._move_to(np.array([nx, ny, nx + bw, ny + bh], np.float32), frames)
        self.last_seen_ms = t_ms
        if score > 0.8:
            self._grab_template(frame)

    def _predicted_det_box(self) -> np.ndarray:
        return getattr(self, "_det_box", self.box)


@dataclass
class _Zone:
    box: np.ndarray
    until_ms: float


class EditState:
    """Applies an edit list to the tracks of one tracker (one per pipeline thread)."""

    def __init__(self) -> None:
        self.edits: list[FaceEdit] = []
        self.version = -1
        self.reset()

    def reset(self) -> None:
        """Forget all effects (after a seek or when the edit list changed)."""
        self.applied: set[int] = set()
        self.suppressed: set[int] = set()
        self.zones: list[_Zone] = []
        self.manual: list[ManualTrack] = []
        self._next_manual = -1
        self._known: set[int] = set()
        self._last_index = -1

    def set_edits(self, edits: list[FaceEdit], version: int) -> None:
        if version != self.version:
            self.edits = list(edits)
            self.version = version
            self.reset()

    def process(
        self,
        frame: np.ndarray,
        index: int,
        pts_ms: float,
        frame_ms: float,
        tracks: list,
        lingering: list,
        det_boxes: list[np.ndarray],
    ) -> tuple[list, list]:
        """Apply due edits; returns (tracks, lingering) without suppressed ones.

        ``tracks``/``lingering`` are FaceTrack objects; manual tracks are kept
        in :attr:`manual` and updated here.
        """
        h, w = frame.shape[:2]
        frames = 1 if self._last_index < 0 else max(1, index - self._last_index)
        self._last_index = index
        for m in self.manual:
            m.update(frame, det_boxes, pts_ms, frames)
        self.manual = [m for m in self.manual if pts_ms - m.last_seen_ms <= MANUAL_HOLD_MS]

        everything = list(tracks) + list(lingering)
        for e in self.edits:
            if e.id in self.applied or e.t_ms > pts_ms + frame_ms / 2:
                continue
            self.applied.add(e.id)
            if pts_ms - e.t_ms > LOOKBACK_MS:
                continue
            box = e.px(w, h)
            if e.kind == ADD:
                m = ManualTrack(self._next_manual, box, frame, pts_ms)
                self._next_manual -= 1
                self.manual.append(m)
            elif e.kind == REMOVE:
                hit = max(self.manual, key=lambda m: match_score(box, m.box), default=None)
                if hit is not None and match_score(box, hit.box) > 0:
                    self.manual.remove(hit)
                    continue
                hit = max(everything, key=lambda t: match_score(box, t.bbox), default=None)
                if hit is not None and match_score(box, hit.bbox) > 0:
                    self.suppressed.add(hit.track_id)
                    box = hit.bbox.copy()
                self.zones.append(_Zone(box, pts_ms + ZONE_MS))
            elif e.kind == RESTORE:
                for t in everything:
                    if t.track_id in self.suppressed and match_score(box, t.bbox) > 0:
                        self.suppressed.discard(t.track_id)
                self.zones = [z for z in self.zones if match_score(box, z.box) == 0]

        # A suppressed track drags its zone along; brand-new tracks born inside
        # a live zone (the same false positive flickering back) are suppressed;
        # automatic boxes that duplicate a manual track yield to it.
        for t in everything:
            if t.track_id in self.suppressed:
                self.zones.append(_Zone(t.bbox.copy(), pts_ms + ZONE_MS))
            elif t.track_id not in self._known and any(
                z.until_ms >= pts_ms and iou(z.box, t.bbox) > 0.3 for z in self.zones
            ):
                self.suppressed.add(t.track_id)
            elif any(iou(m.box, t.bbox) > 0.3 for m in self.manual):
                self.suppressed.add(t.track_id)
            self._known.add(t.track_id)
        self.zones = [z for z in self.zones if z.until_ms >= pts_ms][-64:]

        keep = [t for t in tracks if t.track_id not in self.suppressed]
        keep_l = [t for t in lingering if t.track_id not in self.suppressed]
        return keep, keep_l

    def suppressed_of(self, tracks: list) -> list:
        return [t for t in tracks if t.track_id in self.suppressed]


# ---------------------------------------------------------------------------
# Persistence: one JSON file per user, keyed by video path
# ---------------------------------------------------------------------------
class EditStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._data: dict[str, list[FaceEdit]] = {}
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            self._data = {k: [FaceEdit.from_json(e) for e in v] for k, v in raw.items()}
        except FileNotFoundError:
            pass
        except Exception as exc:
            log.warning("Ignoring unreadable edit file %s: %s", path, exc)

    @staticmethod
    def key(source: str) -> str:
        try:
            return str(Path(source).resolve()).lower()
        except OSError:
            return source.lower()

    def get(self, source: str) -> list[FaceEdit]:
        return list(self._data.get(self.key(source), []))

    def set(self, source: str, edits: list[FaceEdit]) -> None:
        k = self.key(source)
        if edits:
            self._data[k] = list(edits)
        else:
            self._data.pop(k, None)
        self.save()

    def save(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            payload = {k: [e.to_json() for e in v] for k, v in self._data.items()}
            self.path.write_text(json.dumps(payload, indent=1), encoding="utf-8")
        except OSError as exc:
            log.warning("Could not save edits: %s", exc)
