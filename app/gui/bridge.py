"""Qt bridge between the thread-based :class:`Pipeline` and the widgets.

* Worker callbacks are re-emitted as Qt signals (queued onto the GUI thread).
* Frames use a *latest-wins* mailbox: the render thread overwrites the slot and
  only emits ``frameReady`` when the GUI has consumed the previous frame, so a
  slow paint can never build a backlog of signals or images.
* The render thread pre-scales frames to the view's device-pixel size and paints
  overlays with QPainter (safe on QImage outside the GUI thread), keeping the
  GUI thread's work per frame to a single blit.
"""

from __future__ import annotations

import logging
import threading
from enum import Enum

import cv2
import numpy as np
from PySide6.QtCore import QObject, QPointF, QRectF, QSize, Qt, Signal
from PySide6.QtGui import QColor, QFont, QFontMetricsF, QImage, QPainter, QPainterPath, QPen

from app.core.config import AppConfig
from app.core.face_db import FaceDatabase
from app.core.pipeline import Pipeline, PipelineCallbacks, PipelineStats, ProcessedFrame, Snapshot
from app.core.sources import SourceInfo, SourceSpec
from app.gui.theme import ROLE_COLORS, app_font

log = logging.getLogger(__name__)


class RunState(str, Enum):
    IDLE = "idle"
    RUNNING = "running"
    STOPPING = "stopping"


def bgr_to_qimage(frame: np.ndarray) -> QImage:
    frame = np.ascontiguousarray(frame)
    h, w = frame.shape[:2]
    return QImage(frame.data, w, h, frame.strides[0], QImage.Format.Format_BGR888).copy()


class OverlayPainter:
    """Draws tracking boxes and identity labels in the Ember style."""

    def __init__(self) -> None:
        self.show_boxes = True
        self.show_labels = True

    def paint(self, img: QImage, pkt: ProcessedFrame, scale: float, dpr: float) -> None:
        if not (self.show_boxes or self.show_labels) or not pkt.faces:
            return
        p = QPainter(img)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setRenderHint(QPainter.RenderHint.TextAntialiasing)
        font: QFont = app_font(8.5 * dpr, QFont.Weight.DemiBold)
        font.setPixelSize(max(10, int(12 * dpr)))
        p.setFont(font)
        fm = QFontMetricsF(font)
        for face in pkt.faces:
            x1, y1, x2, y2 = (float(v) * scale for v in face.bbox)
            color = QColor(ROLE_COLORS.get(face.role, "#FFFFFF"))
            rect = QRectF(x1, y1, x2 - x1, y2 - y1)
            if self.show_boxes:
                pen = QPen(color, max(1.5, 2.0 * dpr))
                pen.setCapStyle(Qt.PenCapStyle.RoundCap)
                if face.lost or face.role == "pending":
                    pen.setStyle(Qt.PenStyle.DashLine)
                p.setPen(pen)
                p.setBrush(Qt.BrushStyle.NoBrush)
                if face.geom is not None:
                    # Brackets follow the face's tilt.
                    cx, cy, w, h, ang = (float(v) for v in face.geom[:5])
                    p.save()
                    p.translate(cx * scale, cy * scale)
                    p.rotate(ang)
                    face_rect = QRectF(-w * scale / 2, -h * scale / 2, w * scale, h * scale)
                    self._corners(p, face_rect, min(face_rect.width(), face_rect.height()) * 0.22)
                    p.restore()
                else:
                    self._corners(p, rect, min(rect.width(), rect.height()) * 0.22)
            if self.show_labels:
                name = face.identity or ("Identifying…" if face.role == "pending" else "Unknown")
                parts = [name]
                if face.identity:
                    parts.append(f"{face.similarity * 100:.0f}%")
                parts.append(f"#{face.track_id}")
                if face.anonymized:
                    parts.append("hidden")
                text = "  ·  ".join(parts)
                pad = 7 * dpr
                tw = fm.horizontalAdvance(text) + pad * 2
                th = fm.height() + pad
                ty = rect.top() - th - 4 * dpr
                if ty < 0:
                    ty = rect.bottom() + 4 * dpr
                pill = QRectF(rect.left(), ty, tw, th)
                path = QPainterPath()
                path.addRoundedRect(pill, th / 2, th / 2)
                fill = QColor(color)
                fill.setAlpha(235)
                p.setPen(Qt.PenStyle.NoPen)
                p.setBrush(fill)
                p.drawPath(path)
                p.setPen(QColor("#2A0D07"))
                p.drawText(pill, Qt.AlignmentFlag.AlignCenter, text)
        p.end()

    @staticmethod
    def _corners(p: QPainter, r: QRectF, k: float) -> None:
        for (cx, cy), (dx, dy) in (
            ((r.left(), r.top()), (1, 1)),
            ((r.right(), r.top()), (-1, 1)),
            ((r.left(), r.bottom()), (1, -1)),
            ((r.right(), r.bottom()), (-1, -1)),
        ):
            p.drawLine(QPointF(cx, cy), QPointF(cx + dx * k, cy))
            p.drawLine(QPointF(cx, cy), QPointF(cx, cy + dy * k))


class PipelineController(QObject):
    frameReady = Signal()
    stats = Signal(object)
    status = Signal(str)
    warning = Signal(str)
    error = Signal(str)
    progress = Signal(int, int)
    sourceInfo = Signal(object)
    finished = Signal(str)
    position = Signal(float, float)  # current ms, duration ms
    ended = Signal()
    stateChanged = Signal(str)

    def __init__(self, face_db: FaceDatabase, display: bool = True, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self.face_db = face_db
        self.display = display
        self.overlay = OverlayPainter()
        self._pipeline: Pipeline | None = None
        self._state = RunState.IDLE
        self._frame_lock = threading.Lock()
        self._frame: QImage | None = None
        self._frame_pending = False
        self._last_pkt: ProcessedFrame | None = None
        self._target = QSize(1280, 720)
        self._dpr = 1.0
        self.finished.connect(self._on_finished)

    # ---- state -----------------------------------------------------------
    @property
    def state(self) -> RunState:
        return self._state

    def _set_state(self, s: RunState) -> None:
        self._state = s
        self.stateChanged.emit(s.value)

    @property
    def pipeline(self) -> Pipeline | None:
        return self._pipeline

    # ---- control -----------------------------------------------------------
    def start(self, cfg: AppConfig, spec: SourceSpec, realtime: bool = True, output_path: str | None = None) -> bool:
        if self._state != RunState.IDLE:
            return False
        self.overlay.show_boxes = cfg.anonymize.show_boxes
        self.overlay.show_labels = cfg.anonymize.show_labels
        cb = PipelineCallbacks(
            on_frame=self._on_frame,
            on_stats=self.stats.emit,
            on_status=self.status.emit,
            on_warning=self.warning.emit,
            on_error=self.error.emit,
            on_progress=self.progress.emit,
            on_source_info=self.sourceInfo.emit,
            on_finished=self.finished.emit,
            on_position=self.position.emit,
            on_ended=self.ended.emit,
        )
        self._pipeline = Pipeline(
            cfg,
            spec,
            cb,
            display=self.display,
            realtime=realtime,
            output_path=output_path,
            renderer=self._render if self.display else None,
            face_db=self.face_db,
        )
        self._set_state(RunState.RUNNING)
        self._pipeline.start()
        return True

    def stop(self) -> None:
        if self._pipeline is not None and self._state == RunState.RUNNING:
            self._set_state(RunState.STOPPING)
            self._pipeline.stop()

    def _on_finished(self, _reason: str) -> None:
        self._pipeline = None
        with self._frame_lock:
            self._last_pkt = None
        self._set_state(RunState.IDLE)

    def set_paused(self, paused: bool) -> None:
        if self._pipeline:
            self._pipeline.set_paused(paused)

    def update_config(self, cfg: AppConfig) -> None:
        self.overlay.show_boxes = cfg.anonymize.show_boxes
        self.overlay.show_labels = cfg.anonymize.show_labels
        if self._pipeline:
            self._pipeline.update_config(cfg)

    def start_recording(self, path: str) -> None:
        if self._pipeline:
            self._pipeline.start_recording(path)

    def stop_recording(self) -> None:
        if self._pipeline:
            self._pipeline.stop_recording()

    # ---- player controls (file preview) ------------------------------------
    @property
    def seekable(self) -> bool:
        return bool(self._pipeline and self._pipeline.seekable)

    @property
    def has_audio(self) -> bool:
        return bool(self._pipeline and self._pipeline.has_audio)

    @property
    def paused(self) -> bool:
        return bool(self._pipeline and self._pipeline.paused)

    def seek(self, ms: float) -> None:
        if self._pipeline:
            self._pipeline.seek(ms)

    def step(self, frames: int) -> None:
        if self._pipeline:
            self._pipeline.step(frames)

    def set_volume(self, volume: float) -> None:
        if self._pipeline:
            self._pipeline.set_volume(volume)

    def set_muted(self, muted: bool) -> None:
        if self._pipeline:
            self._pipeline.set_muted(muted)

    def reload_face_db(self) -> bool:
        if self._pipeline:
            self._pipeline.reload_face_db()
            return True
        return False

    def snapshot(self) -> Snapshot | None:
        return self._pipeline.snapshot() if self._pipeline else None

    # ---- frames ------------------------------------------------------------
    def set_target_size(self, size: QSize, dpr: float) -> None:
        self._target = size
        self._dpr = dpr

    def take_frame(self) -> QImage | None:
        with self._frame_lock:
            img, self._frame = self._frame, None
            self._frame_pending = False
            return img

    def _render(self, pkt: ProcessedFrame) -> QImage:
        frame = pkt.frame
        h, w = frame.shape[:2]
        tw, th = max(1, self._target.width()), max(1, self._target.height())
        scale = min(tw / w, th / h, 2.0)
        if abs(scale - 1.0) > 0.02:
            # INTER_AREA is slow on 4K sources; linear is visually equivalent at preview size.
            interp = cv2.INTER_AREA if 0.5 <= scale < 1 else cv2.INTER_LINEAR
            frame = cv2.resize(frame, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=interp)
        else:
            scale = 1.0
        img = bgr_to_qimage(frame)
        self.overlay.paint(img, pkt, scale, self._dpr)
        img.setDevicePixelRatio(self._dpr)
        return img

    def last_processed(self) -> ProcessedFrame | None:
        """Most recent anonymized full-resolution frame (for snapshots)."""
        with self._frame_lock:
            return self._last_pkt

    def _on_frame(self, img: QImage, pkt: ProcessedFrame) -> None:
        with self._frame_lock:
            self._frame = img
            self._last_pkt = pkt
            if self._frame_pending:
                return
            self._frame_pending = True
        self.frameReady.emit()


__all__ = ["PipelineController", "RunState", "PipelineStats", "SourceInfo", "bgr_to_qimage"]
