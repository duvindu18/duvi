"""Interactive correction of the automatic blur, drawn over the video stage.

* drag on empty video  -> add a blur box that keeps tracking the face
* click a blur         -> remove it (click a removed one to bring it back)
* drag a blur          -> move it; drag a corner -> resize it
* right-click          -> remove / restore

Boxes are reported in source-frame pixels; the page turns them into
:class:`~app.core.edits.FaceEdit` entries.
"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QFont, QPainter, QPen
from PySide6.QtWidgets import QHBoxLayout, QWidget

from app.gui.theme import P, app_font, qcolor
from app.gui.widgets import CircleButton, label

HANDLE = 7.0  # corner handle half-size (px)
MIN_BOX = 14.0  # smallest box you can draw (px on screen)


class _Face:
    __slots__ = ("box", "kind")

    def __init__(self, box: np.ndarray, kind: str) -> None:
        self.box = box  # x1, y1, x2, y2 in frame pixels
        self.kind = kind  # auto | manual | off


class BlurEditor(QWidget):
    addBox = Signal(object)  # np.ndarray box
    removeBox = Signal(object)
    restoreBox = Signal(object)
    adjustBox = Signal(object, object)  # old, new

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMouseTracking(True)
        self.setCursor(Qt.CursorShape.CrossCursor)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self._faces: list[_Face] = []
        self._fw = self._fh = 0
        self._hover: _Face | None = None
        self._mode = ""  # draw | move | resize
        self._corner = -1
        self._press = QPointF()
        self._rect: QRectF | None = None  # live rectangle while dragging (screen)
        self._target: _Face | None = None

    # ---- data ----------------------------------------------------------------
    def set_frame(self, frame_w: int, frame_h: int, faces) -> None:
        """faces: TrackView list of the frame on screen."""
        if self._mode:
            return  # keep the gesture stable while dragging
        self._fw, self._fh = frame_w, frame_h
        out = []
        for f in faces:
            if f.suppressed:
                kind = "off"
            elif not f.anonymized:
                continue
            else:
                kind = "manual" if f.manual else "auto"
            out.append(_Face(np.asarray(f.bbox, np.float32).copy(), kind))
        self._faces = out
        self._hover = self._face_at(self.mapFromGlobal(self.cursor().pos()).toPointF()) if self.underMouse() else None
        self.update()

    # ---- geometry ------------------------------------------------------------------
    def _image_rect(self) -> QRectF:
        if not self._fw or not self._fh:
            return QRectF()
        s = min(self.width() / self._fw, self.height() / self._fh)
        w, h = self._fw * s, self._fh * s
        return QRectF((self.width() - w) / 2, (self.height() - h) / 2, w, h)

    def _to_screen(self, box: np.ndarray) -> QRectF:
        r = self._image_rect()
        s = r.width() / max(1, self._fw)
        return QRectF(r.left() + box[0] * s, r.top() + box[1] * s, (box[2] - box[0]) * s, (box[3] - box[1]) * s)

    def _to_frame(self, rect: QRectF) -> np.ndarray:
        r = self._image_rect()
        s = r.width() / max(1, self._fw)
        rect = rect.normalized().intersected(r)
        return np.array(
            [(rect.left() - r.left()) / s, (rect.top() - r.top()) / s,
             (rect.right() - r.left()) / s, (rect.bottom() - r.top()) / s], np.float32,
        )

    def _face_at(self, pos: QPointF) -> _Face | None:
        hits = [f for f in self._faces if self._to_screen(f.box).adjusted(-HANDLE, -HANDLE, HANDLE, HANDLE).contains(pos)]
        return min(hits, key=lambda f: (f.box[2] - f.box[0]) * (f.box[3] - f.box[1]), default=None)

    def _corner_at(self, face: _Face, pos: QPointF) -> int:
        r = self._to_screen(face.box)
        for i, c in enumerate((r.topLeft(), r.topRight(), r.bottomRight(), r.bottomLeft())):
            if abs(c.x() - pos.x()) <= HANDLE * 1.6 and abs(c.y() - pos.y()) <= HANDLE * 1.6:
                return i
        return -1

    # ---- mouse ---------------------------------------------------------------------
    def mousePressEvent(self, e) -> None:  # noqa: N802
        pos = e.position()
        face = self._face_at(pos)
        if e.button() == Qt.MouseButton.RightButton:
            if face is not None:
                (self.restoreBox if face.kind == "off" else self.removeBox).emit(face.box.copy())
            return
        if e.button() != Qt.MouseButton.LeftButton or not self._image_rect().contains(pos):
            return
        self._press = pos
        if face is not None:
            self._target = face
            self._corner = self._corner_at(face, pos)
            self._mode = "resize" if self._corner >= 0 and face.kind != "off" else "move"
            self._rect = self._to_screen(face.box)
        else:
            self._mode = "draw"
            self._rect = QRectF(pos, pos)
        self.update()

    def mouseMoveEvent(self, e) -> None:  # noqa: N802
        pos = e.position()
        if not self._mode:
            face = self._face_at(pos)
            if face is not self._hover:
                self._hover = face
                self.update()
            if face is None:
                self.setCursor(Qt.CursorShape.CrossCursor)
            elif self._corner_at(face, pos) in (0, 2) and face.kind != "off":
                self.setCursor(Qt.CursorShape.SizeFDiagCursor)
            elif self._corner_at(face, pos) in (1, 3) and face.kind != "off":
                self.setCursor(Qt.CursorShape.SizeBDiagCursor)
            else:
                self.setCursor(Qt.CursorShape.SizeAllCursor if face.kind != "off" else Qt.CursorShape.PointingHandCursor)
            return
        bounds = self._image_rect()
        pos = QPointF(min(max(pos.x(), bounds.left()), bounds.right()), min(max(pos.y(), bounds.top()), bounds.bottom()))
        if self._mode == "draw":
            self._rect = QRectF(self._press, pos)
        elif self._mode == "move" and self._target is not None and self._target.kind != "off":
            r = self._to_screen(self._target.box)
            self._rect = r.translated(pos - self._press)
        elif self._mode == "resize" and self._target is not None:
            r = self._to_screen(self._target.box)
            pts = [r.topLeft(), r.topRight(), r.bottomRight(), r.bottomLeft()]
            pts[self._corner] = pos
            opposite = pts[(self._corner + 2) % 4]
            self._rect = QRectF(opposite, pos).normalized()
        self.update()

    def mouseReleaseEvent(self, e) -> None:  # noqa: N802
        if e.button() != Qt.MouseButton.LeftButton or not self._mode:
            return
        mode, target, rect = self._mode, self._target, self._rect
        moved = (e.position() - self._press).manhattanLength() > 4
        self._mode, self._target, self._rect, self._corner = "", None, None, -1
        if mode == "draw":
            if rect is not None and abs(rect.width()) >= MIN_BOX and abs(rect.height()) >= MIN_BOX:
                self.addBox.emit(self._to_frame(rect))
        elif target is not None:
            if not moved:
                (self.restoreBox if target.kind == "off" else self.removeBox).emit(target.box.copy())
            elif rect is not None and target.kind != "off":
                self.adjustBox.emit(target.box.copy(), self._to_frame(rect))
        self.update()

    def leaveEvent(self, _e) -> None:  # noqa: N802
        if not self._mode:
            self._hover = None
            self.update()

    # ---- paint -----------------------------------------------------------------------
    def paintEvent(self, _e) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        lime = qcolor(P.accent)
        if not self._mode:
            for f in self._faces:
                r = self._to_screen(f.box)
                hovered = f is self._hover
                if f.kind == "off":
                    pen = QPen(QColor(255, 255, 255, 200 if hovered else 110), 1.5, Qt.PenStyle.DashLine)
                else:
                    pen = QPen(lime if hovered else QColor(228, 241, 122, 120), 2 if hovered else 1.2)
                p.setPen(pen)
                p.setBrush(Qt.BrushStyle.NoBrush)
                p.drawRoundedRect(r, 6, 6)
                if hovered:
                    if f.kind != "off":
                        p.setPen(Qt.PenStyle.NoPen)
                        p.setBrush(lime)
                        for c in (r.topLeft(), r.topRight(), r.bottomRight(), r.bottomLeft()):
                            p.drawRoundedRect(QRectF(c.x() - HANDLE / 1.4, c.y() - HANDLE / 1.4, HANDLE * 1.4, HANDLE * 1.4), 3, 3)
                    hint = "Click to blur again" if f.kind == "off" else "Click to remove  ·  drag to move  ·  corners resize"
                    self._tag(p, QPointF(r.left(), r.top() - 8), hint)
        elif self._rect is not None:
            r = self._rect.normalized()
            fill = QColor(lime)
            fill.setAlpha(36)
            p.setBrush(fill)
            p.setPen(QPen(lime, 2, Qt.PenStyle.DashLine if self._mode == "draw" else Qt.PenStyle.SolidLine))
            p.drawRoundedRect(r, 6, 6)

    def _tag(self, p: QPainter, at: QPointF, text: str) -> None:
        font: QFont = app_font(8.5, QFont.Weight.DemiBold)
        p.setFont(font)
        w = p.fontMetrics().horizontalAdvance(text) + 20
        h = 24
        x = max(4.0, min(self.width() - w - 4.0, at.x()))
        y = at.y() - h if at.y() - h > 4 else at.y() + 12
        box = QRectF(x, y, w, h)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(qcolor(P.accent))
        p.drawRoundedRect(box, h / 2, h / 2)
        p.setPen(qcolor(P.text_on_light))
        p.drawText(box, Qt.AlignmentFlag.AlignCenter, text)


class EditToolbar(QWidget):
    """Floating bar shown while editing: what to do, undo, clear, done."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(18, 6, 6, 6)
        lay.setSpacing(8)
        self.text = label("Drag to add a blur  ·  click a blur to remove it", "dim")
        lay.addWidget(self.text)
        self.count = label("", "faint")
        lay.addWidget(self.count)
        self.undo_btn = CircleButton("undo", 34, tooltip="Undo last fix (Ctrl+Z)")
        self.clear_btn = CircleButton("trash", 34, tooltip="Remove all manual fixes for this video")
        self.done_btn = CircleButton("close", 34, tooltip="Finish editing (E)")
        for b in (self.undo_btn, self.clear_btn, self.done_btn):
            lay.addWidget(b)

    def set_count(self, n: int) -> None:
        self.count.setText(f"{n} fix{'es' if n != 1 else ''}" if n else "")
        self.undo_btn.setEnabled(n > 0)
        self.clear_btn.setEnabled(n > 0)
        self.adjustSize()

    def paintEvent(self, _e) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(qcolor(P.surface3))
        p.drawRoundedRect(QRectF(self.rect()), self.height() / 2, self.height() / 2)
