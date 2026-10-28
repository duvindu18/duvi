"""Reusable "Ember" widgets: gradient backdrop, glass cards, pills, circular
buttons, the frosted value slider and the video surface."""

from __future__ import annotations

from typing import Callable, Iterable

from PySide6.QtCore import (
    Property,
    QEasingCurve,
    QPoint,
    QPointF,
    QPropertyAnimation,
    QRect,
    QRectF,
    QSize,
    Qt,
    QTimer,
    Signal,
)
from PySide6.QtGui import (
    QBrush,
    QColor,
    QFont,
    QFontMetricsF,
    QImage,
    QLinearGradient,
    QPainter,
    QPainterPath,
    QPen,
    QPixmap,
    QRadialGradient,
)
from PySide6.QtWidgets import (
    QAbstractButton,
    QButtonGroup,
    QFrame,
    QGraphicsDropShadowEffect,
    QHBoxLayout,
    QLabel,
    QLayout,
    QLayoutItem,
    QPushButton,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
    QWidgetItem,
)

from app.gui.icons import draw_icon, draw_logo
from app.gui.theme import P, RADIUS_CARD, app_font, qcolor


# --------------------------------------------------------------------------
# Layout helpers
# --------------------------------------------------------------------------
class FlowLayout(QLayout):
    """Wrapping layout: pill rows reflow on narrow windows instead of clipping."""

    def __init__(self, parent: QWidget | None = None, h_spacing: int = 8, v_spacing: int = 8) -> None:
        super().__init__(parent)
        self._items: list[QLayoutItem] = []
        self._h = h_spacing
        self._v = v_spacing
        self.setContentsMargins(0, 0, 0, 0)

    def addItem(self, item: QLayoutItem) -> None:  # noqa: N802 (Qt API)
        self._items.append(item)

    def addWidget(self, w: QWidget) -> None:  # noqa: N802
        self.addChildWidget(w)
        self.addItem(QWidgetItem(w))

    def count(self) -> int:
        return len(self._items)

    def itemAt(self, index: int) -> QLayoutItem | None:  # noqa: N802
        return self._items[index] if 0 <= index < len(self._items) else None

    def takeAt(self, index: int) -> QLayoutItem | None:  # noqa: N802
        return self._items.pop(index) if 0 <= index < len(self._items) else None

    def expandingDirections(self) -> Qt.Orientation:  # noqa: N802
        return Qt.Orientation(0)

    def hasHeightForWidth(self) -> bool:  # noqa: N802
        return True

    def heightForWidth(self, width: int) -> int:  # noqa: N802
        return self._do_layout(QRect(0, 0, width, 0), dry=True)

    def setGeometry(self, rect: QRect) -> None:  # noqa: N802
        super().setGeometry(rect)
        self._do_layout(rect, dry=False)

    def sizeHint(self) -> QSize:  # noqa: N802
        """Preferred size = everything on one row; wraps only when squeezed."""
        visible = [i for i in self._items if i.widget() is None or not i.widget().isHidden()]
        if not visible:
            return QSize(0, 0)
        w = sum(i.sizeHint().width() for i in visible) + self._h * (len(visible) - 1)
        h = max(i.sizeHint().height() for i in visible)
        m = self.contentsMargins()
        return QSize(w + m.left() + m.right(), h + m.top() + m.bottom())

    def minimumSize(self) -> QSize:  # noqa: N802
        size = QSize()
        for item in self._items:
            size = size.expandedTo(item.minimumSize())
        m = self.contentsMargins()
        return size + QSize(m.left() + m.right(), m.top() + m.bottom())

    def _do_layout(self, rect: QRect, dry: bool) -> int:
        m = self.contentsMargins()
        eff = rect.adjusted(m.left(), m.top(), -m.right(), -m.bottom())
        x, y, line_h = eff.x(), eff.y(), 0
        for item in self._items:
            # isHidden (explicitly hidden) rather than isVisible: widgets inside a
            # not-yet-shown container must still receive geometry.
            if item.widget() is not None and item.widget().isHidden():
                continue
            hint = item.sizeHint()
            if item.hasHeightForWidth():
                hint.setHeight(item.heightForWidth(hint.width()))
            next_x = x + hint.width() + self._h
            if next_x - self._h > eff.right() + 1 and line_h > 0:
                x = eff.x()
                y += line_h + self._v
                next_x = x + hint.width() + self._h
                line_h = 0
            if not dry:
                item.setGeometry(QRect(QPoint(x, y), hint))
            x = next_x
            line_h = max(line_h, hint.height())
        return y + line_h - rect.y() + m.bottom()


def label(text: str = "", role: str | None = None, wrap: bool = False) -> QLabel:
    lbl = QLabel(text)
    if role:
        lbl.setProperty("role", role)
    lbl.setWordWrap(wrap)
    return lbl


def two_tone(bright: str, dim: str) -> str:
    """Rich-text headline: 'Which source <dim>will you protect today?</dim>'."""
    return f"{bright} <span style='color:{P.text_dim}'>{dim}</span>"


def button(text: str, variant: str | None = None, icon=None, on_click: Callable | None = None) -> QPushButton:
    btn = QPushButton(text)
    if variant:
        btn.setProperty("variant", variant)
    if icon is not None:
        btn.setIcon(icon)
        btn.setIconSize(QSize(16, 16))
    btn.setCursor(Qt.CursorShape.PointingHandCursor)
    if on_click:
        btn.clicked.connect(on_click)
    return btn


def soft_shadow(widget: QWidget, blur: int = 40, alpha: int = 110, dy: int = 12) -> None:
    effect = QGraphicsDropShadowEffect(widget)
    effect.setBlurRadius(blur)
    effect.setOffset(0, dy)
    effect.setColor(QColor(20, 4, 2, alpha))
    widget.setGraphicsEffect(effect)


# --------------------------------------------------------------------------
# Surfaces
# --------------------------------------------------------------------------
class EmberBackground(QWidget):
    """Window backdrop: diagonal ember gradient with soft light blooms."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setObjectName("Root")
        self.setAttribute(Qt.WidgetAttribute.WA_OpaquePaintEvent)
        self._cache: QPixmap | None = None

    def resizeEvent(self, e) -> None:  # noqa: N802
        self._cache = None
        super().resizeEvent(e)

    def _render(self) -> QPixmap:
        dpr = self.devicePixelRatioF()
        pm = QPixmap(int(self.width() * dpr), int(self.height() * dpr))
        pm.setDevicePixelRatio(dpr)
        p = QPainter(pm)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        w, h = self.width(), self.height()
        base = QLinearGradient(0, 0, w * 0.8, h)
        base.setColorAt(0.0, qcolor(P.ember))
        base.setColorAt(0.45, qcolor(P.ember_lo))
        base.setColorAt(1.0, qcolor(P.ember_deep))
        p.fillRect(QRectF(0, 0, w, h), base)
        for cx, cy, rad, color, alpha in (
            (w * 0.92, h * 0.05, max(w, h) * 0.55, P.ember_hi, 0.75),
            (w * 0.05, h * 0.95, max(w, h) * 0.45, "#7A1A0C", 0.6),
            (w * 0.55, h * 0.55, max(w, h) * 0.35, P.accent, 0.12),
        ):
            g = QRadialGradient(QPointF(cx, cy), rad)
            c0 = qcolor(color)
            c0.setAlphaF(alpha)
            c1 = qcolor(color)
            c1.setAlphaF(0.0)
            g.setColorAt(0, c0)
            g.setColorAt(1, c1)
            p.fillRect(QRectF(0, 0, w, h), g)
        p.end()
        return pm

    def paintEvent(self, _e) -> None:  # noqa: N802
        if self._cache is None or self._cache.size() != self.size() * self.devicePixelRatioF():
            self._cache = self._render()
        p = QPainter(self)
        p.drawPixmap(0, 0, self._cache)


class GlassCard(QFrame):
    """Frosted panel with hairline border; optional header with title/subtitle."""

    def __init__(
        self,
        title: str | None = None,
        subtitle: str | None = None,
        parent: QWidget | None = None,
        radius: int = RADIUS_CARD,
        tint: str = P.glass,
        padding: int = 20,
    ) -> None:
        super().__init__(parent)
        self._radius = radius
        self._tint = qcolor(tint)
        self.body = QVBoxLayout(self)
        self.body.setContentsMargins(padding, padding, padding, padding)
        self.body.setSpacing(12)
        if title:
            head = QVBoxLayout()
            head.setSpacing(2)
            head.addWidget(label(title, "h2"))
            if subtitle:
                head.addWidget(label(subtitle, "faint", wrap=True))
            self.body.addLayout(head)

    def set_tint(self, css: str) -> None:
        self._tint = qcolor(css)
        self.update()

    def paintEvent(self, _e) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = QRectF(self.rect()).adjusted(0.5, 0.5, -0.5, -0.5)
        grad = QLinearGradient(r.topLeft(), r.bottomRight())
        top = QColor(self._tint)
        top.setAlphaF(min(1.0, self._tint.alphaF() * 1.5))
        grad.setColorAt(0, top)
        grad.setColorAt(1, self._tint)
        p.setBrush(grad)
        p.setPen(QPen(qcolor(P.glass_border), 1))
        p.drawRoundedRect(r, self._radius, self._radius)


# --------------------------------------------------------------------------
# Buttons
# --------------------------------------------------------------------------
class CircleButton(QAbstractButton):
    """Round icon button. ``solid`` = white primary (the reference 'play' button)."""

    def __init__(
        self,
        icon: str,
        size: int = 44,
        solid: bool = False,
        tooltip: str = "",
        checkable: bool = False,
        checked_icon: str | None = None,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._icon = icon
        self._checked_icon = checked_icon
        self._solid = solid
        self._hover = 0.0
        self._diameter = size
        self.setCheckable(checkable)
        self.setFixedSize(size, size)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setToolTip(tooltip)
        self.setAccessibleName(tooltip or icon)
        self._anim = QPropertyAnimation(self, b"hover", self)
        self._anim.setDuration(140)
        self._anim.setEasingCurve(QEasingCurve.Type.OutCubic)
        self.accent: QColor | None = None  # optional checked-state accent

    def set_icon(self, name: str) -> None:
        self._icon = name
        self.update()

    def _get_hover(self) -> float:
        return self._hover

    def _set_hover(self, v: float) -> None:
        self._hover = v
        self.update()

    hover = Property(float, _get_hover, _set_hover)

    def enterEvent(self, e) -> None:  # noqa: N802
        self._anim.stop()
        self._anim.setEndValue(1.0)
        self._anim.start()
        super().enterEvent(e)

    def leaveEvent(self, e) -> None:  # noqa: N802
        self._anim.stop()
        self._anim.setEndValue(0.0)
        self._anim.start()
        super().leaveEvent(e)

    def sizeHint(self) -> QSize:  # noqa: N802
        return QSize(self._diameter, self._diameter)

    def paintEvent(self, _e) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = QRectF(self.rect()).adjusted(1, 1, -1, -1)
        enabled = self.isEnabled()
        checked = self.isChecked()
        if self._solid or (checked and self.accent is None):
            fill = QColor(255, 255, 255, 255 if enabled else 110)
            if self.isDown():
                fill = QColor("#FFD9CC")
            elif self._hover:
                fill = QColor(255, 241, 236)
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(fill)
            icon_color = qcolor(P.text_on_light)
        else:
            alpha = 0.10 + 0.08 * self._hover + (0.08 if self.isDown() else 0)
            fill = QColor(self.accent) if (checked and self.accent is not None) else QColor(255, 255, 255)
            fill.setAlphaF(0.85 if (checked and self.accent is not None) else alpha)
            p.setBrush(fill)
            p.setPen(QPen(QColor(255, 255, 255, int(46 + 50 * self._hover)), 1))
            icon_color = QColor(255, 255, 255, 255 if enabled else 100)
        p.drawEllipse(r)
        name = self._checked_icon if (checked and self._checked_icon) else self._icon
        inset = r.width() * 0.29
        draw_icon(p, name, r.adjusted(inset, inset, -inset, -inset), icon_color)


class NavButton(CircleButton):
    """Rail button with an accessible text label below the circle."""

    def __init__(self, icon: str, text: str, parent: QWidget | None = None) -> None:
        super().__init__(icon, 52, checkable=True, tooltip=text, parent=parent)


class PillGroup(QWidget):
    """Exclusive set of pill toggles, wrapping on narrow widths."""

    changed = Signal(object)

    def __init__(self, options: Iterable[tuple[object, str]], parent: QWidget | None = None, tooltips: dict | None = None) -> None:
        super().__init__(parent)
        self._flow = FlowLayout(self, 6, 6)
        self._group = QButtonGroup(self)
        self._group.setExclusive(True)
        self._values: dict[int, object] = {}
        for i, (value, text) in enumerate(options):
            btn = QPushButton(text)
            btn.setProperty("variant", "pill")
            btn.setCheckable(True)
            btn.setCursor(Qt.CursorShape.PointingHandCursor)
            if tooltips and value in tooltips:
                btn.setToolTip(tooltips[value])
            self._group.addButton(btn, i)
            self._values[i] = value
            self._flow.addWidget(btn)
        self._group.idClicked.connect(lambda i: self.changed.emit(self._values[i]))
        self.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Preferred)

    def hasHeightForWidth(self) -> bool:  # noqa: N802
        return True

    def heightForWidth(self, w: int) -> int:  # noqa: N802
        return self._flow.heightForWidth(w)

    def value(self) -> object:
        i = self._group.checkedId()
        return self._values.get(i)

    def set_value(self, value: object) -> None:
        for i, v in self._values.items():
            if v == value:
                self._group.button(i).setChecked(True)
                return


class ToggleSwitch(QAbstractButton):
    def __init__(self, checked: bool = False, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setCheckable(True)
        self.setChecked(checked)
        self.setFixedSize(46, 26)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self._pos = 1.0 if checked else 0.0
        self._anim = QPropertyAnimation(self, b"knob", self)
        self._anim.setDuration(160)
        self._anim.setEasingCurve(QEasingCurve.Type.OutCubic)
        self.toggled.connect(self._animate)

    def _get_knob(self) -> float:
        return self._pos

    def _set_knob(self, v: float) -> None:
        self._pos = v
        self.update()

    knob = Property(float, _get_knob, _set_knob)

    def _animate(self, on: bool) -> None:
        self._anim.stop()
        self._anim.setEndValue(1.0 if on else 0.0)
        self._anim.start()

    def setChecked(self, on: bool) -> None:  # noqa: N802
        super().setChecked(on)
        self._pos = 1.0 if on else 0.0
        self.update()

    def sizeHint(self) -> QSize:  # noqa: N802
        return QSize(46, 26)

    def paintEvent(self, _e) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = QRectF(self.rect()).adjusted(1, 1, -1, -1)
        track = QColor(255, 255, 255, int(40 + 215 * self._pos))
        p.setPen(QPen(QColor(255, 255, 255, 60), 1))
        p.setBrush(track)
        p.drawRoundedRect(r, r.height() / 2, r.height() / 2)
        d = r.height() - 6
        x = r.left() + 3 + (r.width() - d - 6) * self._pos
        knob = QColor(qcolor(P.ember)) if self._pos > 0.5 else QColor(255, 255, 255)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(knob)
        p.drawEllipse(QRectF(x, r.top() + 3, d, d))


class ToggleRow(QWidget):
    toggled = Signal(bool)

    def __init__(self, text: str, checked: bool = False, hint: str = "", parent: QWidget | None = None) -> None:
        super().__init__(parent)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        col = QVBoxLayout()
        col.setSpacing(0)
        col.addWidget(label(text))
        if hint:
            col.addWidget(label(hint, "faint", wrap=True))
        lay.addLayout(col, 1)
        self.switch = ToggleSwitch(checked)
        self.switch.toggled.connect(self.toggled)
        lay.addWidget(self.switch, 0, Qt.AlignmentFlag.AlignVCenter)

    def isChecked(self) -> bool:  # noqa: N802
        return self.switch.isChecked()

    def setChecked(self, on: bool) -> None:  # noqa: N802
        self.switch.blockSignals(True)
        self.switch.setChecked(on)
        self.switch.blockSignals(False)


class GlassSlider(QWidget):
    """The reference 'Volume ··|·· 54' frosted pill slider.

    Supports drag, click-to-set, mouse wheel and arrow / PgUp / PgDn keys.
    """

    valueChanged = Signal(float)

    def __init__(
        self,
        text: str,
        minimum: float = 0,
        maximum: float = 100,
        value: float = 50,
        step: float = 1,
        fmt: Callable[[float], str] | None = None,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._text = text
        self._min, self._max, self._step = minimum, maximum, step
        self._value = value
        self._fmt = fmt or (lambda v: f"{v:.0f}")
        self._dragging = False
        self.setMinimumHeight(48)
        self.setMaximumHeight(48)
        self.setMinimumWidth(180)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.setAccessibleName(text)

    def value(self) -> float:
        return self._value

    def setValue(self, v: float, emit: bool = False) -> None:  # noqa: N802
        v = max(self._min, min(self._max, round(v / self._step) * self._step))
        if abs(v - self._value) < 1e-9:
            return
        self._value = v
        self.update()
        if emit:
            self.valueChanged.emit(v)

    def _frac(self) -> float:
        return (self._value - self._min) / max(1e-9, self._max - self._min)

    def _track(self) -> QRectF:
        r = QRectF(self.rect()).adjusted(1, 1, -1, -1)
        rad = r.height() * 0.5
        fm_text = QFontMetricsF(app_font(9.5))
        fm_val = QFontMetricsF(app_font(9.5, QFont.Weight.DemiBold))
        widest = max(fm_val.horizontalAdvance(self._fmt(v)) for v in (self._min, self._max, self._value))
        left = rad + fm_text.horizontalAdvance(self._text) + 18
        right = rad + widest + 18
        return r.adjusted(left, 0, -right, 0)

    def _set_from_x(self, x: float) -> None:
        t = self._track()
        frac = (x - t.left()) / max(1.0, t.width())
        self.setValue(self._min + max(0.0, min(1.0, frac)) * (self._max - self._min), emit=True)

    def mousePressEvent(self, e) -> None:  # noqa: N802
        if e.button() == Qt.MouseButton.LeftButton:
            self._dragging = True
            self._set_from_x(e.position().x())

    def mouseMoveEvent(self, e) -> None:  # noqa: N802
        if self._dragging:
            self._set_from_x(e.position().x())

    def mouseReleaseEvent(self, _e) -> None:  # noqa: N802
        self._dragging = False

    def wheelEvent(self, e) -> None:  # noqa: N802
        steps = e.angleDelta().y() / 120
        self.setValue(self._value + steps * self._step, emit=True)
        e.accept()

    def keyPressEvent(self, e) -> None:  # noqa: N802
        big = (self._max - self._min) / 10
        delta = {
            Qt.Key.Key_Left: -self._step, Qt.Key.Key_Down: -self._step,
            Qt.Key.Key_Right: self._step, Qt.Key.Key_Up: self._step,
            Qt.Key.Key_PageDown: -big, Qt.Key.Key_PageUp: big,
        }.get(Qt.Key(e.key()))
        if delta is None:
            super().keyPressEvent(e)
            return
        self.setValue(self._value + delta, emit=True)

    def paintEvent(self, _e) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = QRectF(self.rect()).adjusted(1, 1, -1, -1)
        rad = r.height() / 2
        border = QColor(255, 255, 255, 120 if self.hasFocus() else 46)
        p.setPen(QPen(border, 1))
        p.setBrush(QColor(255, 255, 255, 26))
        p.drawRoundedRect(r, rad, rad)

        # Filled portion (left of the thumb) is slightly brighter glass.
        t = self._track()
        x = t.left() + t.width() * self._frac()
        fill = QPainterPath()
        fill.addRoundedRect(QRectF(r.left(), r.top(), x - r.left(), r.height()), rad, rad)
        clip = QPainterPath()
        clip.addRoundedRect(r, rad, rad)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(255, 255, 255, 30))
        p.drawPath(fill.intersected(clip))

        p.setPen(QColor(255, 255, 255, 220))
        p.setFont(app_font(9.5))
        p.drawText(r.adjusted(rad, 0, 0, 0), Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft, self._text)
        p.setFont(app_font(9.5, QFont.Weight.DemiBold))
        p.drawText(r.adjusted(0, 0, -rad, 0), Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignRight, self._fmt(self._value))

        # Tick dots
        p.setBrush(QColor(255, 255, 255, 70))
        n = 14
        for i in range(n + 1):
            tx = t.left() + t.width() * i / n
            if abs(tx - x) > 5:
                p.drawEllipse(QPointF(tx, r.center().y()), 1.4, 1.4)
        # Thumb: bright vertical bar
        p.setBrush(QColor("white"))
        p.drawRoundedRect(QRectF(x - 1.5, r.center().y() - 9, 3, 18), 1.5, 1.5)


class StatTile(QWidget):
    def __init__(self, caption: str, value: str = "–", parent: QWidget | None = None) -> None:
        super().__init__(parent)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(0)
        self.value = label(value, "value")
        lay.addWidget(self.value)
        lay.addWidget(label(caption, "caption"))

    def set(self, text: str) -> None:
        self.value.setText(text)


class Chip(QLabel):
    """Small glass tag such as 'Stress Relief' / 'Recommended' in the reference.

    Painted manually: Qt style sheets silently drop a border-radius larger than
    half the widget height, which would turn the pill into a rectangle.
    """

    def __init__(self, text: str = "", parent: QWidget | None = None, dot: str | None = None) -> None:
        super().__init__(text, parent)
        self._dot = qcolor(dot) if dot else None
        self.setFont(app_font(8.5, QFont.Weight.Medium))
        self.setFixedHeight(28)
        self._apply_margins()

    def _apply_margins(self) -> None:
        self.setContentsMargins(28 if self._dot is not None else 13, 0, 13, 0)

    def set_dot(self, css: str | None) -> None:
        self._dot = qcolor(css) if css else None
        self._apply_margins()
        self.update()

    def paintEvent(self, _e) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = QRectF(self.rect()).adjusted(0.5, 0.5, -0.5, -0.5)
        p.setPen(QPen(qcolor(P.glass_border), 1))
        p.setBrush(QColor(255, 255, 255, 30))
        p.drawRoundedRect(r, r.height() / 2, r.height() / 2)
        if self._dot is not None:
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(self._dot)
            p.drawEllipse(QPointF(15, r.center().y()), 4, 4)
        p.setPen(QColor("white"))
        p.setFont(self.font())
        p.drawText(self.contentsRect(), Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft, self.text())


class Banner(QFrame):
    """Transient notification shown at the top of the window."""

    def __init__(self, parent: QWidget) -> None:
        super().__init__(parent)
        self.setVisible(False)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(16, 10, 10, 10)
        self._text = label("", wrap=True)
        lay.addWidget(self._text, 1)
        close = CircleButton("close", 28, tooltip="Dismiss")
        close.clicked.connect(self.hide)
        lay.addWidget(close)
        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.timeout.connect(self.hide)
        soft_shadow(self, 30, 140, 8)

    def show_message(self, text: str, level: str = "info", timeout_ms: int = 6000) -> None:
        color = {"info": "rgba(255,255,255,0.18)", "warn": "rgba(255,211,110,0.30)", "error": "rgba(255,77,77,0.42)"}[level]
        self.setStyleSheet(
            f"Banner {{ background: {color}; border: 1px solid rgba(255,255,255,0.35); border-radius: 18px; }}"
        )
        self._text.setText(text)
        self.reposition()
        self.show()
        self.raise_()
        if timeout_ms > 0:
            self._timer.start(timeout_ms)
        else:
            self._timer.stop()

    def reposition(self) -> None:
        parent = self.parentWidget()
        if parent is None:
            return
        w = min(640, parent.width() - 48)
        self.setFixedWidth(w)
        self.adjustSize()
        self.move((parent.width() - w) // 2, 18)


class VideoView(QWidget):
    """Rounded video surface. Frames arrive pre-scaled from the render thread."""

    resized = Signal(QSize)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._image: QImage | None = None
        self.headline = "Protect every face."
        self.subline = "Choose a source and press play"
        self.tag = "Ready"
        self.setMinimumSize(320, 200)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setAttribute(Qt.WidgetAttribute.WA_OpaquePaintEvent, False)

    def target_size(self) -> QSize:
        dpr = self.devicePixelRatioF()
        return QSize(int(self.width() * dpr), int(self.height() * dpr))

    @property
    def has_image(self) -> bool:
        return self._image is not None

    def set_image(self, image: QImage | None) -> None:
        self._image = image
        self.update()

    def clear(self) -> None:
        self._image = None
        self.update()

    def resizeEvent(self, e) -> None:  # noqa: N802
        super().resizeEvent(e)
        self.resized.emit(self.target_size())

    def paintEvent(self, _e) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        r = QRectF(self.rect())
        clip = QPainterPath()
        clip.addRoundedRect(r, 28, 28)
        p.setClipPath(clip)
        p.fillRect(r, QColor(20, 5, 3, 150))

        if self._image is not None and not self._image.isNull():
            img = self._image
            dpr = self.devicePixelRatioF()
            iw, ih = img.width() / dpr, img.height() / dpr
            scale = min(r.width() / iw, r.height() / ih)
            dw, dh = iw * scale, ih * scale
            target = QRectF(r.center().x() - dw / 2, r.center().y() - dh / 2, dw, dh)
            p.drawImage(target, img)
            # Bottom fade so the transport controls stay legible (as in the reference).
            fade = QLinearGradient(0, r.bottom() - 140, 0, r.bottom())
            fade.setColorAt(0, QColor(30, 6, 3, 0))
            fade.setColorAt(1, QColor(30, 6, 3, 150))
            p.fillRect(QRectF(r.left(), r.bottom() - 140, r.width(), 140), fade)
        else:
            self._paint_placeholder(p, r)
        p.setClipping(False)
        p.setPen(QPen(QColor(255, 255, 255, 40), 1))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawRoundedRect(r.adjusted(0.5, 0.5, -0.5, -0.5), 28, 28)

    def _paint_placeholder(self, p: QPainter, r: QRectF) -> None:
        g = QRadialGradient(QPointF(r.width() * 0.7, r.height() * 0.35), max(r.width(), r.height()) * 0.7)
        g.setColorAt(0, QColor(255, 120, 70, 120))
        g.setColorAt(0.5, QColor(185, 53, 27, 70))
        g.setColorAt(1, QColor(30, 6, 3, 0))
        p.fillRect(r, QBrush(g))
        size = min(r.width(), r.height()) * 0.22
        logo = QRectF(r.center().x() - size / 2, r.center().y() - size * 1.05, size, size)
        draw_logo(p, logo, QColor(255, 255, 255, 60))
        p.setPen(QColor("white"))
        p.setFont(app_font(max(14.0, min(28.0, r.width() / 32)), QFont.Weight.Light))
        p.drawText(QRectF(r.left(), logo.bottom() + 8, r.width(), 50), Qt.AlignmentFlag.AlignHCenter, self.headline)
        p.setPen(QColor(255, 255, 255, 150))
        p.setFont(app_font(10))
        p.drawText(QRectF(r.left(), logo.bottom() + 58, r.width(), 30), Qt.AlignmentFlag.AlignHCenter, self.subline)


def fmt_time(ms: float) -> str:
    s = max(0, int(ms // 1000))
    h, m, s = s // 3600, s % 3600 // 60, s % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


class TrackSlider(QWidget):
    """Slim media slider (timeline / volume): thin glass track that thickens on
    hover, white progress, a knob while hovering or dragging, and a time bubble
    for the timeline. Values are 0..1."""

    moved = Signal(float)  # while dragging (throttled by the caller if needed)
    released = Signal(float)  # drag finished / click

    def __init__(self, show_bubble: bool = False, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._value = 0.0
        self._hover = False
        self._hover_x = 0.0
        self.dragging = False
        self.show_bubble = show_bubble
        self.duration_ms = 0.0
        self.setMouseTracking(True)
        self.setFixedHeight(22)
        self.setMinimumWidth(60)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)

    def value(self) -> float:
        return self._value

    def set_value(self, v: float) -> None:
        if not self.dragging:
            self._value = max(0.0, min(1.0, v))
            self.update()

    def _track(self) -> QRectF:
        return QRectF(8, self.height() / 2 - 2, self.width() - 16, 4)

    def _frac_at(self, x: float) -> float:
        t = self._track()
        return max(0.0, min(1.0, (x - t.left()) / max(1.0, t.width())))

    def mousePressEvent(self, e) -> None:  # noqa: N802
        if e.button() == Qt.MouseButton.LeftButton:
            self.dragging = True
            self._value = self._frac_at(e.position().x())
            self.moved.emit(self._value)
            self.update()

    def mouseMoveEvent(self, e) -> None:  # noqa: N802
        self._hover_x = e.position().x()
        if self.dragging:
            self._value = self._frac_at(self._hover_x)
            self.moved.emit(self._value)
        self.update()

    def mouseReleaseEvent(self, e) -> None:  # noqa: N802
        if self.dragging:
            self.dragging = False
            self._value = self._frac_at(e.position().x())
            self.released.emit(self._value)
            self.update()

    def keyPressEvent(self, e) -> None:  # noqa: N802
        step = {Qt.Key.Key_Left: -0.02, Qt.Key.Key_Right: 0.02}.get(Qt.Key(e.key()))
        if step is None:
            super().keyPressEvent(e)
            return
        self._value = max(0.0, min(1.0, self._value + step))
        self.released.emit(self._value)
        self.update()

    def enterEvent(self, e) -> None:  # noqa: N802
        self._hover = True
        self.update()

    def leaveEvent(self, e) -> None:  # noqa: N802
        self._hover = False
        self.update()

    def paintEvent(self, _e) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        t = self._track()
        active = self._hover or self.dragging
        if active:
            t = t.adjusted(0, -1, 0, 1)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(255, 255, 255, 60))
        p.drawRoundedRect(t, t.height() / 2, t.height() / 2)
        done = QRectF(t.left(), t.top(), t.width() * self._value, t.height())
        p.setBrush(QColor("white"))
        p.drawRoundedRect(done, t.height() / 2, t.height() / 2)
        if active:
            if self._hover and not self.dragging:
                hx = max(t.left(), min(t.right(), self._hover_x))
                p.setBrush(QColor(255, 255, 255, 90))
                p.drawRoundedRect(QRectF(t.left(), t.top(), hx - t.left(), t.height()), t.height() / 2, t.height() / 2)
            x = t.left() + t.width() * self._value
            p.setBrush(QColor("white"))
            p.drawEllipse(QPointF(x, t.center().y()), 7, 7)


class PlayerBar(QWidget):
    """Media controls: timeline with times, transport centred exactly, tool and
    volume groups of equal width on either side so nothing shifts."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(8)

        self.timeline_row = QWidget()
        tl = QHBoxLayout(self.timeline_row)
        tl.setContentsMargins(4, 0, 4, 0)
        tl.setSpacing(12)
        self.time_cur = label("00:00", "dim")
        self.time_total = label("00:00", "dim")
        for lbl in (self.time_cur, self.time_total):
            lbl.setFont(app_font(9, QFont.Weight.Medium))
            lbl.setMinimumWidth(48)
        self.time_total.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        self.timeline = TrackSlider(show_bubble=True)
        tl.addWidget(self.time_cur)
        tl.addWidget(self.timeline, 1)
        tl.addWidget(self.time_total)
        lay.addWidget(self.timeline_row)

        row = QHBoxLayout()
        row.setContentsMargins(0, 0, 0, 0)
        row.setSpacing(0)
        self.left = QWidget()
        ll = QHBoxLayout(self.left)
        ll.setContentsMargins(0, 0, 0, 0)
        ll.setSpacing(10)
        self.snapshot_btn = CircleButton("snapshot", 42, tooltip="Save anonymized snapshot (Ctrl+S)")
        self.record_btn = CircleButton("record", 42, tooltip="Record anonymized video (Ctrl+R)", checkable=True)
        self.record_btn.accent = qcolor(P.danger)
        self.enroll_btn = CircleButton("enroll", 42, tooltip="Enroll the largest face as a known identity")
        for b in (self.snapshot_btn, self.record_btn, self.enroll_btn):
            ll.addWidget(b)
        ll.addStretch(1)

        self.center = QWidget()
        cl = QHBoxLayout(self.center)
        cl.setContentsMargins(0, 0, 0, 0)
        cl.setSpacing(12)
        self.back10_btn = CircleButton("skip-back", 42, tooltip="Back 10 seconds (J)")
        self.step_back_btn = CircleButton("step-back", 42, tooltip="Previous frame (,)")
        self.play_btn = CircleButton("play", 60, solid=True, tooltip="Play / pause (Space)")
        soft_shadow(self.play_btn, 30, 120, 8)
        self.step_fwd_btn = CircleButton("step-fwd", 42, tooltip="Next frame (.)")
        self.fwd10_btn = CircleButton("skip-fwd", 42, tooltip="Forward 10 seconds (L)")
        self.stop_btn = CircleButton("stop", 42, tooltip="Stop (Esc)")
        for b in (self.back10_btn, self.step_back_btn, self.play_btn, self.step_fwd_btn, self.fwd10_btn):
            cl.addWidget(b, 0, Qt.AlignmentFlag.AlignVCenter)

        self.right = QWidget()
        rl = QHBoxLayout(self.right)
        rl.setContentsMargins(0, 0, 0, 0)
        rl.setSpacing(10)
        rl.addStretch(1)
        self.loop_btn = CircleButton("loop", 42, tooltip="Loop playback", checkable=True)
        self.loop_btn.accent = qcolor(P.accent)
        self.mute_btn = CircleButton("volume", 42, tooltip="Mute / unmute (M)", checkable=True, checked_icon="mute")
        self.mute_btn.accent = qcolor(P.accent)
        self.volume = TrackSlider()
        self.volume.setFixedWidth(96)
        self.volume.setToolTip("Volume")
        rl.addWidget(self.stop_btn)
        rl.addWidget(self.loop_btn)
        rl.addWidget(self.mute_btn)
        rl.addWidget(self.volume)

        row.addWidget(self.left, 1)
        row.addWidget(self.center, 0)
        row.addWidget(self.right, 1)
        lay.addLayout(row)
        self.set_media_mode(False)

    def set_media_mode(self, seekable: bool, has_audio: bool = False) -> None:
        """Files get the timeline and transport; live sources only play/stop."""
        for w in (self.timeline_row, self.back10_btn, self.step_back_btn, self.step_fwd_btn, self.fwd10_btn, self.loop_btn):
            w.setVisible(seekable)
        for w in (self.mute_btn, self.volume):
            w.setVisible(seekable and has_audio)
        self._balance()

    def resizeEvent(self, e) -> None:  # noqa: N802
        super().resizeEvent(e)
        self._balance()

    def _balance(self) -> None:
        # Equal side widths keep the play button exactly centred.
        side = max(0, (self.width() - self.center.sizeHint().width()) // 2)
        self.left.setFixedWidth(side)
        self.right.setFixedWidth(side)
        compact = side < 300
        self.volume.setVisible(self.mute_btn.isVisible() and not compact)
