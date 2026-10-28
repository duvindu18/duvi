"""Vector icons drawn with QPainter (no image assets, crisp at any DPI)."""

from __future__ import annotations

import math

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QIcon, QPainter, QPainterPath, QPen, QPixmap


def _pen(color: QColor, w: float) -> QPen:
    pen = QPen(color, w)
    pen.setCapStyle(Qt.PenCapStyle.RoundCap)
    pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
    return pen


def draw_logo(p: QPainter, r: QRectF, color: QColor) -> None:
    """Three-petal lotus mark, echoing the reference brand."""
    p.save()
    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(color)
    cx, base = r.center().x(), r.bottom() - r.height() * 0.12
    s = r.width()
    for angle, scale in ((-38, 0.78), (38, 0.78), (0, 1.0)):
        path = QPainterPath()
        h = s * 0.62 * scale
        w = s * 0.24 * scale
        path.moveTo(0, 0)
        path.cubicTo(-w, -h * 0.35, -w * 0.8, -h * 0.85, 0, -h)
        path.cubicTo(w * 0.8, -h * 0.85, w, -h * 0.35, 0, 0)
        p.save()
        p.translate(cx, base)
        p.rotate(angle)
        p.drawPath(path)
        p.restore()
    p.restore()


def draw_icon(p: QPainter, name: str, r: QRectF, color: QColor) -> None:
    s = min(r.width(), r.height())
    c = r.center()
    lw = max(1.4, s * 0.085)
    p.save()
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    p.setPen(_pen(color, lw))
    p.setBrush(Qt.BrushStyle.NoBrush)
    u = s / 24.0  # 24-unit design grid

    def pt(x: float, y: float) -> QPointF:
        return QPointF(c.x() + (x - 12) * u, c.y() + (y - 12) * u)

    if name == "play":
        path = QPainterPath(pt(8.5, 6))
        path.lineTo(pt(18, 12))
        path.lineTo(pt(8.5, 18))
        path.closeSubpath()
        p.setBrush(color)
        p.drawPath(path)
    elif name == "pause":
        p.setBrush(color)
        p.setPen(Qt.PenStyle.NoPen)
        p.drawRoundedRect(QRectF(pt(7, 6), pt(10.5, 18)), u, u)
        p.drawRoundedRect(QRectF(pt(13.5, 6), pt(17, 18)), u, u)
    elif name == "stop":
        p.setBrush(color)
        p.setPen(Qt.PenStyle.NoPen)
        p.drawRoundedRect(QRectF(pt(7, 7), pt(17, 17)), 2 * u, 2 * u)
    elif name == "record":
        p.setBrush(color)
        p.setPen(Qt.PenStyle.NoPen)
        p.drawEllipse(c, 5.5 * u, 5.5 * u)
    elif name == "snapshot":
        p.drawRoundedRect(QRectF(pt(3.5, 7), pt(20.5, 19)), 3 * u, 3 * u)
        p.drawEllipse(pt(12, 13), 3.4 * u, 3.4 * u)
        p.drawLine(pt(9, 7), pt(10.5, 4.8))
        p.drawLine(pt(10.5, 4.8), pt(13.5, 4.8))
        p.drawLine(pt(13.5, 4.8), pt(15, 7))
    elif name == "camera":
        p.drawRoundedRect(QRectF(pt(3, 7), pt(16, 17)), 2.5 * u, 2.5 * u)
        path = QPainterPath(pt(16, 10.5))
        path.lineTo(pt(21, 8))
        path.lineTo(pt(21, 16))
        path.lineTo(pt(16, 13.5))
        p.drawPath(path)
    elif name == "stream":
        p.drawEllipse(pt(12, 12), 1.6 * u, 1.6 * u)
        for rad in (5.0, 8.5):
            rect = QRectF(pt(12 - rad, 12 - rad), pt(12 + rad, 12 + rad))
            p.drawArc(rect, 35 * 16, 110 * 16)
            p.drawArc(rect, 215 * 16, 110 * 16)
    elif name == "file":
        path = QPainterPath(pt(6, 3.5))
        path.lineTo(pt(14, 3.5))
        path.lineTo(pt(18.5, 8))
        path.lineTo(pt(18.5, 20.5))
        path.lineTo(pt(6, 20.5))
        path.closeSubpath()
        p.drawPath(path)
        tri = QPainterPath(pt(10.5, 10.5))
        tri.lineTo(pt(15, 13.5))
        tri.lineTo(pt(10.5, 16.5))
        tri.closeSubpath()
        p.setBrush(color)
        p.drawPath(tri)
    elif name in ("user", "faces"):
        p.drawEllipse(pt(12, 8.5), 3.8 * u, 3.8 * u)
        path = QPainterPath(pt(4.5, 20))
        path.cubicTo(pt(5.5, 14.5), pt(18.5, 14.5), pt(19.5, 20))
        p.drawPath(path)
    elif name == "shield":
        path = QPainterPath(pt(12, 3))
        path.cubicTo(pt(15, 5), pt(17.5, 5.5), pt(19.5, 5.5))
        path.cubicTo(pt(19.5, 13), pt(17, 18), pt(12, 21))
        path.cubicTo(pt(7, 18), pt(4.5, 13), pt(4.5, 5.5))
        path.cubicTo(pt(6.5, 5.5), pt(9, 5), pt(12, 3))
        p.drawPath(path)
        p.drawEllipse(pt(12, 11), 2.4 * u, 2.4 * u)
    elif name == "export":
        p.drawLine(pt(12, 4), pt(12, 15))
        p.drawLine(pt(7.5, 8.5), pt(12, 4))
        p.drawLine(pt(16.5, 8.5), pt(12, 4))
        path = QPainterPath(pt(4.5, 14))
        path.lineTo(pt(4.5, 19.5))
        path.lineTo(pt(19.5, 19.5))
        path.lineTo(pt(19.5, 14))
        p.drawPath(path)
    elif name == "settings":
        p.drawEllipse(pt(12, 12), 3 * u, 3 * u)
        for i in range(8):
            a = i * math.pi / 4
            p.drawLine(
                QPointF(c.x() + math.cos(a) * 6.2 * u, c.y() + math.sin(a) * 6.2 * u),
                QPointF(c.x() + math.cos(a) * 8.8 * u, c.y() + math.sin(a) * 8.8 * u),
            )
        p.drawEllipse(pt(12, 12), 6.2 * u, 6.2 * u)
    elif name == "more":
        p.setBrush(color)
        p.setPen(Qt.PenStyle.NoPen)
        for x in (6, 12, 18):
            p.drawEllipse(pt(x, 12), 1.5 * u, 1.5 * u)
    elif name == "back":
        p.drawLine(pt(14.5, 6), pt(8.5, 12))
        p.drawLine(pt(8.5, 12), pt(14.5, 18))
    elif name == "plus":
        p.drawLine(pt(12, 5), pt(12, 19))
        p.drawLine(pt(5, 12), pt(19, 12))
    elif name == "folder":
        path = QPainterPath(pt(3.5, 6.5))
        path.lineTo(pt(9.5, 6.5))
        path.lineTo(pt(11.5, 8.5))
        path.lineTo(pt(20.5, 8.5))
        path.lineTo(pt(20.5, 18.5))
        path.lineTo(pt(3.5, 18.5))
        path.closeSubpath()
        p.drawPath(path)
    elif name == "refresh":
        rect = QRectF(pt(5, 5), pt(19, 19))
        p.drawArc(rect, 40 * 16, 280 * 16)
        p.drawLine(pt(17.6, 4.2), pt(17.8, 8.6))
        p.drawLine(pt(17.8, 8.6), pt(13.5, 8.4))
    elif name == "trash":
        p.drawLine(pt(4.5, 7), pt(19.5, 7))
        p.drawLine(pt(9.5, 7), pt(10, 4.5))
        p.drawLine(pt(10, 4.5), pt(14, 4.5))
        p.drawLine(pt(14, 4.5), pt(14.5, 7))
        path = QPainterPath(pt(6.5, 7))
        path.lineTo(pt(7.5, 20))
        path.lineTo(pt(16.5, 20))
        path.lineTo(pt(17.5, 7))
        p.drawPath(path)
    elif name == "enroll":
        p.drawEllipse(pt(10, 8.5), 3.6 * u, 3.6 * u)
        path = QPainterPath(pt(3, 20))
        path.cubicTo(pt(4, 14.5), pt(14, 14), pt(15.5, 16.5))
        p.drawPath(path)
        p.drawLine(pt(18.5, 13), pt(18.5, 20))
        p.drawLine(pt(15, 16.5), pt(22, 16.5))
    elif name == "eye":
        path = QPainterPath(pt(2.5, 12))
        path.cubicTo(pt(6, 5.5), pt(18, 5.5), pt(21.5, 12))
        path.cubicTo(pt(18, 18.5), pt(6, 18.5), pt(2.5, 12))
        p.drawPath(path)
        p.drawEllipse(pt(12, 12), 3 * u, 3 * u)
    elif name == "eye-off":
        draw_icon(p, "eye", r, color)
        p.drawLine(pt(4, 4), pt(20, 20))
    elif name == "close":
        p.drawLine(pt(6, 6), pt(18, 18))
        p.drawLine(pt(18, 6), pt(6, 18))
    elif name in ("skip-back", "skip-fwd"):
        # Circular arrow with "10".
        rect = QRectF(pt(4, 4), pt(20, 20))
        if name == "skip-back":
            p.drawArc(rect, 100 * 16, 280 * 16)
            p.drawLine(pt(10.5, 2.5), pt(13, 4.2))
            p.drawLine(pt(10.5, 6), pt(13, 4.2))
        else:
            p.drawArc(rect, 80 * 16, -280 * 16)
            p.drawLine(pt(13.5, 2.5), pt(11, 4.2))
            p.drawLine(pt(13.5, 6), pt(11, 4.2))
        f = p.font()
        f.setPixelSize(max(6, int(7.5 * u)))
        f.setBold(True)
        p.setFont(f)
        p.drawText(QRectF(pt(4, 6), pt(20, 19)), Qt.AlignmentFlag.AlignCenter, "10")
    elif name in ("step-back", "step-fwd"):
        p.setBrush(color)
        tri = QPainterPath()
        if name == "step-fwd":
            tri.moveTo(pt(6, 6))
            tri.lineTo(pt(15, 12))
            tri.lineTo(pt(6, 18))
            p.drawPath(tri)
            p.drawLine(pt(18, 6), pt(18, 18))
        else:
            tri.moveTo(pt(18, 6))
            tri.lineTo(pt(9, 12))
            tri.lineTo(pt(18, 18))
            p.drawPath(tri)
            p.drawLine(pt(6, 6), pt(6, 18))
    elif name in ("volume", "mute"):
        body = QPainterPath(pt(3.5, 9.5))
        body.lineTo(pt(7.5, 9.5))
        body.lineTo(pt(12.5, 5))
        body.lineTo(pt(12.5, 19))
        body.lineTo(pt(7.5, 14.5))
        body.lineTo(pt(3.5, 14.5))
        body.closeSubpath()
        p.drawPath(body)
        if name == "volume":
            p.drawArc(QRectF(pt(10, 8.5), pt(17, 15.5)), -50 * 16, 100 * 16)
            p.drawArc(QRectF(pt(9, 5), pt(21, 19)), -50 * 16, 100 * 16)
        else:
            p.drawLine(pt(15.5, 9), pt(21, 15))
            p.drawLine(pt(21, 9), pt(15.5, 15))
    elif name == "loop":
        p.drawArc(QRectF(pt(4, 6), pt(20, 18)), 30 * 16, 300 * 16)
        p.drawLine(pt(19.3, 7.2), pt(19.6, 11))
        p.drawLine(pt(19.6, 11), pt(16, 10))
    elif name == "phone":
        p.drawRoundedRect(QRectF(pt(7, 2.5), pt(17, 21.5)), 2.5 * u, 2.5 * u)
        p.drawLine(pt(10.5, 18.5), pt(13.5, 18.5))
    elif name == "edit":
        p.drawLine(pt(5, 19), pt(5.8, 15.2))
        p.drawLine(pt(5.8, 15.2), pt(16, 5))
        p.drawLine(pt(16, 5), pt(19, 8))
        p.drawLine(pt(19, 8), pt(8.8, 18.2))
        p.drawLine(pt(8.8, 18.2), pt(5, 19))
    elif name == "chip":
        p.drawRoundedRect(QRectF(pt(6, 6), pt(18, 18)), 2 * u, 2 * u)
        for v in (9, 12, 15):
            p.drawLine(pt(v, 3), pt(v, 6))
            p.drawLine(pt(v, 18), pt(v, 21))
            p.drawLine(pt(3, v), pt(6, v))
            p.drawLine(pt(18, v), pt(21, v))
    p.restore()


def make_icon(name: str, size: int = 24, color: str | QColor = "#FFFFFF") -> QIcon:
    icon = QIcon()
    for scale in (1, 2):
        pm = QPixmap(size * scale, size * scale)
        pm.setDevicePixelRatio(scale)
        pm.fill(Qt.GlobalColor.transparent)
        painter = QPainter(pm)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        draw_icon(painter, name, QRectF(0, 0, size, size), QColor(color))
        painter.end()
        icon.addPixmap(pm)
    return icon


def app_icon() -> QIcon:
    from PySide6.QtGui import QLinearGradient

    icon = QIcon()
    for size in (16, 24, 32, 48, 64, 128, 256):
        pm = QPixmap(size, size)
        pm.fill(Qt.GlobalColor.transparent)
        p = QPainter(pm)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        grad = QLinearGradient(0, 0, size, size)
        grad.setColorAt(0, QColor("#FF7A4A"))
        grad.setColorAt(1, QColor("#8E2410"))
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(grad)
        p.drawRoundedRect(QRectF(0, 0, size, size), size * 0.26, size * 0.26)
        pad = size * 0.2
        draw_logo(p, QRectF(pad, pad, size - 2 * pad, size - 2 * pad), QColor("white"))
        p.end()
        icon.addPixmap(pm)
    return icon
