"""Start-up splash: the bold lumo wordmark with the line element (a light sweeping along a hairline)."""
from __future__ import annotations

import math
import time

from PySide6.QtCore import QEasingCurve, QPointF, QPropertyAnimation, QRectF, Qt, QTimer
from PySide6.QtGui import QColor, QFont, QFontDatabase, QFontMetricsF, QLinearGradient, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import QApplication, QWidget

from .. import __version__
from . import theme


def _wordmark_font(px: int) -> QFont:
    """Poppins Bold (the earlier lumo wordmark) when bundled, else the boldest Inter."""
    fams = set(QFontDatabase.families())
    for family, weight in (("Poppins", QFont.Weight.Bold), (theme.FONT_FAMILY, QFont.Weight.Bold),
                           ("Segoe UI", QFont.Weight.Bold)):
        if family in fams:
            f = QFont(family)
            f.setWeight(weight)
            f.setPixelSize(px)
            f.setLetterSpacing(QFont.SpacingType.PercentageSpacing, 98)
            return f
    f = QFont()
    f.setBold(True)
    f.setPixelSize(px)
    return f


class Splash(QWidget):
    W, H = 520, 300

    def __init__(self):
        super().__init__(None, Qt.WindowType.SplashScreen | Qt.WindowType.FramelessWindowHint |
                         Qt.WindowType.WindowStaysOnTopHint)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setFixedSize(self.W, self.H)
        self.status = "Starting…"
        self._t0 = time.perf_counter()
        self._timer = QTimer(self, interval=16)
        self._timer.timeout.connect(self.update)
        self._fade = None
        scr = QApplication.primaryScreen()
        if scr:
            g = scr.availableGeometry()
            self.move(g.center().x() - self.W // 2, g.center().y() - self.H // 2)

    def start(self) -> None:
        self.show()
        self._timer.start()
        QApplication.processEvents()

    def set_status(self, text: str) -> None:
        self.status = text
        self.repaint()
        QApplication.processEvents()

    def finish(self, window: QWidget | None = None) -> None:
        """Fades out; never longer than the start-up itself (no artificial waiting)."""
        self._fade = QPropertyAnimation(self, b"windowOpacity", self)
        self._fade.setDuration(220)
        self._fade.setStartValue(1.0)
        self._fade.setEndValue(0.0)
        self._fade.setEasingCurve(QEasingCurve.Type.OutCubic)
        self._fade.finished.connect(self._done)
        self._fade.start()

    def _done(self) -> None:
        self._timer.stop()
        self.close()
        self.deleteLater()

    def paintEvent(self, e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setRenderHint(QPainter.RenderHint.TextAntialiasing)
        r = QRectF(self.rect()).adjusted(0.5, 0.5, -0.5, -0.5)
        path = QPainterPath()
        path.addRoundedRect(r, 14, 14)
        p.fillPath(path, QColor(theme.WIN))
        p.setPen(QPen(QColor(theme.LINE_2), 1))
        p.drawPath(path)

        # wordmark
        font = _wordmark_font(72)
        fm = QFontMetricsF(font)
        word = "lumo"
        ww = fm.horizontalAdvance(word)
        base_y = self.H * 0.50
        x0 = (self.W - ww) / 2
        p.setFont(font)
        p.setPen(QColor(theme.TEXT))
        p.drawText(QPointF(x0, base_y), word)

        # the line element: a hairline as wide as the wordmark, a light travelling along it
        ly = base_y + 22
        lx0, lx1 = x0, x0 + ww
        p.setPen(QPen(QColor("#2c2c30"), 1.0))
        p.drawLine(QPointF(lx0, ly), QPointF(lx1, ly))
        t = (time.perf_counter() - self._t0) / 1.4 % 1.0
        ease = 0.5 - 0.5 * math.cos(t * math.pi * 2)    # back and forth, soft at the ends
        cx = lx0 + (lx1 - lx0) * ease
        seg = (lx1 - lx0) * 0.28
        g = QLinearGradient(cx - seg, 0, cx + seg, 0)
        g.setColorAt(0.0, QColor(236, 236, 238, 0))
        g.setColorAt(0.5, QColor(236, 236, 238, 255))
        g.setColorAt(1.0, QColor(236, 236, 238, 0))
        p.setPen(QPen(g, 1.6))
        p.drawLine(QPointF(max(lx0, cx - seg), ly), QPointF(min(lx1, cx + seg), ly))

        # caption + status
        small = QFont(theme.FONT_FAMILY)
        small.setPixelSize(12)
        small.setLetterSpacing(QFont.SpacingType.AbsoluteSpacing, 2.4)
        p.setFont(small)
        p.setPen(QColor(theme.MUTED))
        p.drawText(QRectF(0, ly + 12, self.W, 18), Qt.AlignmentFlag.AlignHCenter, "MATERIALS")
        small.setLetterSpacing(QFont.SpacingType.AbsoluteSpacing, 0)
        small.setPixelSize(11)
        p.setFont(small)
        p.setPen(QColor(theme.FAINT))
        p.drawText(QRectF(20, self.H - 34, self.W - 40, 16), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                   self.status)
        p.drawText(QRectF(20, self.H - 34, self.W - 40, 16), Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter,
                   f"v{__version__}")
        p.end()
