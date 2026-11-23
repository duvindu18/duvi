"""Small custom widgets: line icons, toggle switch, segmented control, toast."""
from __future__ import annotations

import math

from PySide6.QtCore import (Property, QEasingCurve, QPointF, QPropertyAnimation, QRectF, QSize,
                            Qt, QTimer, Signal)
from PySide6.QtGui import QColor, QIcon, QPainter, QPainterPath, QPen, QPixmap
from PySide6.QtWidgets import (QAbstractButton, QButtonGroup, QFrame, QGraphicsOpacityEffect,
                               QHBoxLayout, QLabel, QPushButton, QSizePolicy, QWidget)


# --------------------------------------------------------------------------- #
# Line icons (24x24 grid, drawn like lucide icons)
# --------------------------------------------------------------------------- #
def _icon_path(name: str) -> QPainterPath:
    p = QPainterPath()

    def rect(x, y, w, h, r=2.0):
        p.addRoundedRect(QRectF(x, y, w, h), r, r)

    def line(*pts):
        p.moveTo(*pts[0])
        for q in pts[1:]:
            p.lineTo(*q)

    if name == "home":
        line((3, 11), (12, 4), (21, 11))
        line((5, 9.5), (5, 20), (19, 20), (19, 9.5))
        line((10, 20), (10, 14), (14, 14), (14, 20))
    elif name == "folder":
        line((3, 7), (3, 19), (21, 19), (21, 8), (11, 8), (9, 5), (3, 5), (3, 7))
    elif name == "box":
        line((12, 3), (20, 7.5), (20, 16.5), (12, 21), (4, 16.5), (4, 7.5), (12, 3))
        line((4, 7.5), (12, 12), (20, 7.5))
        line((12, 12), (12, 21))
    elif name == "layers":
        line((12, 3), (21, 8), (12, 13), (3, 8), (12, 3))
        line((3, 12.5), (12, 17.5), (21, 12.5))
        line((3, 16.5), (12, 21.5), (21, 16.5))
    elif name == "tree":
        p.addEllipse(QRectF(5, 3, 14, 12))
        line((12, 15), (12, 21))
        line((12, 12), (9, 9))
        line((12, 13), (15, 10))
    elif name == "image":
        rect(3, 4, 18, 16)
        p.addEllipse(QRectF(7, 8, 3, 3))
        line((3, 17), (9, 12), (14, 16), (17, 13), (21, 17))
    elif name == "export":
        line((12, 3), (12, 15))
        line((7, 8), (12, 3), (17, 8))
        line((4, 14), (4, 20), (20, 20), (20, 14))
    elif name == "settings":
        p.addEllipse(QRectF(9, 9, 6, 6))
        for k in range(8):
            a = k * math.pi / 4
            line((12 + 6.2 * math.cos(a), 12 + 6.2 * math.sin(a)), (12 + 8.8 * math.cos(a), 12 + 8.8 * math.sin(a)))
        p.addEllipse(QRectF(5.8, 5.8, 12.4, 12.4))
    elif name == "help":
        p.addEllipse(QRectF(3, 3, 18, 18))
        p.moveTo(9.3, 9.5)
        p.cubicTo(9.3, 6.5, 14.7, 6.5, 14.7, 9.5)
        p.cubicTo(14.7, 11.5, 12, 11.5, 12, 14)
        line((12, 17), (12, 17.2))
    elif name == "sun":
        p.addEllipse(QRectF(8, 8, 8, 8))
        for k in range(8):
            a = k * math.pi / 4
            line((12 + 6 * math.cos(a), 12 + 6 * math.sin(a)), (12 + 9 * math.cos(a), 12 + 9 * math.sin(a)))
    elif name == "moon":
        p.moveTo(20, 14.5)
        p.cubicTo(15, 17, 8, 13, 10, 4)
        p.cubicTo(4, 6, 3, 15, 9, 19)
        p.cubicTo(13, 21.5, 18.5, 19, 20, 14.5)
    elif name == "search":
        p.addEllipse(QRectF(4, 4, 13, 13))
        line((15, 15), (20, 20))
    elif name == "target":
        p.addEllipse(QRectF(4, 4, 16, 16))
        line((12, 1.5), (12, 6))
        line((12, 18), (12, 22.5))
        line((1.5, 12), (6, 12))
        line((18, 12), (22.5, 12))
    elif name == "grid":
        rect(4, 4, 6.5, 6.5, 1.5)
        rect(13.5, 4, 6.5, 6.5, 1.5)
        rect(4, 13.5, 6.5, 6.5, 1.5)
        rect(13.5, 13.5, 6.5, 6.5, 1.5)
    elif name == "eye":
        p.moveTo(2, 12)
        p.cubicTo(6, 4, 18, 4, 22, 12)
        p.cubicTo(18, 20, 6, 20, 2, 12)
        p.addEllipse(QRectF(9, 9, 6, 6))
    elif name == "cpu":
        rect(6, 6, 12, 12)
        rect(9.5, 9.5, 5, 5, 1)
        for x in (9, 12, 15):
            line((x, 3), (x, 6))
            line((x, 18), (x, 21))
            line((3, x), (6, x))
            line((18, x), (21, x))
    elif name == "bell":
        p.moveTo(6, 16)
        p.lineTo(6, 10.5)
        p.cubicTo(6, 3.5, 18, 3.5, 18, 10.5)
        p.lineTo(18, 16)
        p.lineTo(20, 18)
        p.lineTo(4, 18)
        p.lineTo(6, 16)
        p.moveTo(10, 20.5)
        p.cubicTo(10.5, 22, 13.5, 22, 14, 20.5)
    elif name == "plus":
        line((12, 5), (12, 19))
        line((5, 12), (19, 12))
    elif name == "refresh":
        p.arcMoveTo(QRectF(4, 4, 16, 16), 40)
        p.arcTo(QRectF(4, 4, 16, 16), 40, 290)
        line((18.5, 4), (18.3, 8.3), (14, 8))
    elif name == "check":
        line((5, 12.5), (10, 17), (19, 7))
    elif name == "spark":
        line((12, 3), (13.5, 10.5), (21, 12), (13.5, 13.5), (12, 21), (10.5, 13.5), (3, 12), (10.5, 10.5), (12, 3))
    elif name == "clay":
        p.addEllipse(QRectF(4, 4, 16, 16))
        p.moveTo(7, 9)
        p.cubicTo(9, 6.5, 12, 6.5, 13, 7)
    elif name == "wire":
        line((12, 3), (21, 19), (3, 19), (12, 3))
        line((7.5, 11), (16.5, 11))
        line((12, 19), (7.5, 11))
        line((12, 19), (16.5, 11))
    else:
        p.addEllipse(QRectF(6, 6, 12, 12))
    return p


def make_icon(name: str, color: str, size: int = 18) -> QIcon:
    pm = QPixmap(size * 2, size * 2)
    pm.fill(Qt.transparent)
    pm.setDevicePixelRatio(2.0)
    painter = QPainter(pm)
    painter.setRenderHint(QPainter.Antialiasing)
    painter.scale(size / 24.0, size / 24.0)
    pen = QPen(QColor(color), 1.75)
    pen.setCapStyle(Qt.RoundCap)
    pen.setJoinStyle(Qt.RoundJoin)
    painter.setPen(pen)
    painter.setBrush(Qt.NoBrush)
    painter.drawPath(_icon_path(name))
    painter.end()
    return QIcon(pm)


# --------------------------------------------------------------------------- #
class Toggle(QAbstractButton):
    """White pill switch."""

    def __init__(self, checked: bool = False, parent=None) -> None:
        super().__init__(parent)
        self._pos = 1.0 if checked else 0.0
        self._anim = QPropertyAnimation(self, b"knob", self)
        self._anim.setDuration(140)
        self._anim.setEasingCurve(QEasingCurve.OutCubic)
        self.setCheckable(True)
        self.setChecked(checked)
        self.setCursor(Qt.PointingHandCursor)
        self.toggled.connect(self._animate)
        self.colors = ("#f5f5f6", "#2c2c31", "#0a0a0b")

    def sizeHint(self) -> QSize:
        return QSize(36, 20)

    def checkStateSet(self) -> None:
        super().checkStateSet()
        # programmatic setChecked (signals blocked): jump to the final position
        if self._anim.state() != QPropertyAnimation.Running:
            self._pos = 1.0 if self.isChecked() else 0.0
            self.update()

    def _animate(self, on: bool) -> None:
        self._anim.stop()
        self._anim.setStartValue(self._pos)
        self._anim.setEndValue(1.0 if on else 0.0)
        self._anim.start()

    def _get(self) -> float:
        return self._pos

    def _set(self, v: float) -> None:
        self._pos = v
        self.update()

    knob = Property(float, _get, _set)

    def paintEvent(self, _e) -> None:
        on_col, off_col, knob_on = self.colors
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        r = QRectF(0, 0, 36, 20).adjusted(0.5, 0.5, -0.5, -0.5)
        track = QColor(on_col) if self.isChecked() else QColor(off_col)
        if not self.isEnabled():
            track.setAlpha(90)
        p.setPen(Qt.NoPen)
        p.setBrush(track)
        p.drawRoundedRect(r, 10, 10)
        x = 2 + self._pos * 16
        p.setBrush(QColor(knob_on) if self.isChecked() else QColor("#9a9aa1"))
        p.drawEllipse(QRectF(x, 2, 16, 16))
        p.end()


class Segmented(QFrame):
    """Pill segmented control. ``changed`` emits the chosen key."""
    changed = Signal(str)

    def __init__(self, items: list[tuple[str, str]], current: str, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName("SegGroup")
        lay = QHBoxLayout(self)
        lay.setContentsMargins(3, 3, 3, 3)
        lay.setSpacing(2)
        self.group = QButtonGroup(self)
        self.buttons: dict[str, QPushButton] = {}
        for key, label in items:
            b = QPushButton(label)
            b.setObjectName("Seg")
            b.setCheckable(True)
            b.setCursor(Qt.PointingHandCursor)
            b.setChecked(key == current)
            b.clicked.connect(lambda _=False, k=key: self.changed.emit(k))
            self.group.addButton(b)
            lay.addWidget(b)
            self.buttons[key] = b
        self.setSizePolicy(QSizePolicy.Maximum, QSizePolicy.Fixed)

    def value(self) -> str:
        for k, b in self.buttons.items():
            if b.isChecked():
                return k
        return ""

    def set_value(self, key: str) -> None:
        if key in self.buttons:
            self.buttons[key].setChecked(True)


class Toast(QFrame):
    """Bottom-centre pill notification with an optional action link."""

    def __init__(self, parent: QWidget) -> None:
        super().__init__(parent)
        self.setObjectName("Toast")
        lay = QHBoxLayout(self)
        lay.setContentsMargins(16, 9, 14, 9)
        lay.setSpacing(12)
        self.label = QLabel("")
        self.action = QPushButton("")
        self.action.setCursor(Qt.PointingHandCursor)
        lay.addWidget(self.label)
        lay.addWidget(self.action)
        self.effect = QGraphicsOpacityEffect(self)
        self.setGraphicsEffect(self.effect)
        self.anim = QPropertyAnimation(self.effect, b"opacity", self)
        self.anim.setDuration(180)
        self.timer = QTimer(self)
        self.timer.setSingleShot(True)
        self.timer.timeout.connect(self.fade_out)
        self._cb = None
        self.action.clicked.connect(self._clicked)
        self.hide()

    def show_message(self, text: str, action: str = "", callback=None, ms: int = 4500) -> None:
        self.label.setText(text)
        self.action.setText(action)
        self.action.setVisible(bool(action))
        self._cb = callback
        self.adjustSize()
        self.reposition()
        self.show()
        self.raise_()
        self.anim.stop()
        self.anim.setStartValue(0.0)
        self.anim.setEndValue(1.0)
        self.anim.start()
        self.timer.start(ms)

    def reposition(self) -> None:
        par = self.parentWidget()
        if par is not None:
            self.move((par.width() - self.width()) // 2, par.height() - self.height() - 22)

    def fade_out(self) -> None:
        self.anim.stop()
        self.anim.setStartValue(1.0)
        self.anim.setEndValue(0.0)
        self.anim.finished.connect(self._hide_once)
        self.anim.start()

    def _hide_once(self) -> None:
        try:
            self.anim.finished.disconnect(self._hide_once)
        except (RuntimeError, TypeError):
            pass
        if self.effect.opacity() < 0.05:
            self.hide()

    def _clicked(self) -> None:
        if self._cb:
            self._cb()
        self.fade_out()


def card(object_name: str = "Card") -> QFrame:
    f = QFrame()
    f.setObjectName(object_name)
    return f


def label(text: str, name: str = "", wrap: bool = False) -> QLabel:
    lb = QLabel(text)
    if name:
        lb.setObjectName(name)
    lb.setWordWrap(wrap)
    if wrap:
        lb.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.MinimumExpanding)
    return lb


def divider() -> QFrame:
    f = QFrame()
    f.setObjectName("Divider")
    return f


def badge(text: str, alert: bool = False) -> QLabel:
    b = QLabel(text)
    b.setObjectName("BadgeAlert" if alert else "Badge")
    b.setAlignment(Qt.AlignCenter)
    b.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Fixed)
    return b
