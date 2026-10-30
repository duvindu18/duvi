"""Reusable "Noir" widgets: flat backdrop, cards, pills, circular
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
    QColor,
    QFont,
    QFontMetricsF,
    QImage,
    QLinearGradient,
    QPainter,
    QPainterPath,
)
from PySide6.QtWidgets import (
    QAbstractButton,
    QButtonGroup,
    QFrame,
    QGraphicsDropShadowEffect,
    QGraphicsOpacityEffect,
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
    lbl = QLabel(text.upper() if role == "caption" else text)
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
    """Window backdrop: flat near-black (name kept for compatibility)."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setObjectName("Root")
        self.setAttribute(Qt.WidgetAttribute.WA_OpaquePaintEvent)

    def paintEvent(self, _e) -> None:  # noqa: N802
        QPainter(self).fillRect(self.rect(), qcolor(P.bg))


class GlassCard(QFrame):
    """Frosted panel with hairline border; optional header with title/subtitle."""

    def __init__(
        self,
        title: str | None = None,
        subtitle: str | None = None,
        parent: QWidget | None = None,
        radius: int = RADIUS_CARD,
        tint: str = P.surface,
        padding: int = 22,
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
            head.addWidget(label(title, "caption"))
            if subtitle:
                head.addWidget(label(subtitle, "faint", wrap=True))
            self.body.addLayout(head)

    def set_tint(self, css: str) -> None:
        self._tint = qcolor(css)
        self.update()

    def paintEvent(self, _e) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(self._tint)
        p.drawRoundedRect(QRectF(self.rect()), self._radius, self._radius)


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
        h = self._hover
        p.setPen(Qt.PenStyle.NoPen)
        if self._solid:
            fill = QColor(P.accent) if self.isDown() else _mix(qcolor(P.text), QColor("white"), h)
            if not enabled:
                fill = qcolor(P.surface3)
            icon_color = qcolor(P.text_on_light) if enabled else qcolor(P.text_faint)
        elif checked:
            fill = QColor(self.accent) if self.accent is not None else qcolor(P.text)
            icon_color = qcolor(P.text_on_light) if fill.lightness() > 140 else QColor("white")
        else:
            fill = _mix(qcolor(P.surface2), qcolor(P.surface3), h)
            if self.isDown():
                fill = qcolor(P.glass_pressed)
            icon_color = _mix(qcolor(P.text_dim), qcolor(P.text), h) if enabled else qcolor(P.text_faint)
        p.setBrush(fill)
        p.drawEllipse(r)
        name = self._checked_icon if (checked and self._checked_icon) else self._icon
        inset = r.width() * 0.29
        draw_icon(p, name, r.adjusted(inset, inset, -inset, -inset), icon_color)


def _mix(a: QColor, b: QColor, t: float) -> QColor:
    t = max(0.0, min(1.0, t))
    return QColor(
        int(a.red() + (b.red() - a.red()) * t),
        int(a.green() + (b.green() - a.green()) * t),
        int(a.blue() + (b.blue() - a.blue()) * t),
        int(a.alpha() + (b.alpha() - a.alpha()) * t),
    )


class NavButton(CircleButton):
    """Rail button: transparent until hovered, white when it is the current page."""

    def __init__(self, icon: str, text: str, parent: QWidget | None = None) -> None:
        super().__init__(icon, 52, checkable=True, tooltip=text, parent=parent)

    def paintEvent(self, _e) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = QRectF(self.rect()).adjusted(1, 1, -1, -1)
        p.setPen(Qt.PenStyle.NoPen)
        if self.isChecked():
            p.setBrush(qcolor(P.text))
            icon_color = qcolor(P.text_on_light)
        else:
            bg = qcolor(P.surface2)
            bg.setAlphaF(self._hover)
            p.setBrush(bg)
            icon_color = _mix(qcolor(P.text_faint), qcolor(P.text), self._hover)
        p.drawEllipse(r)
        inset = r.width() * 0.31
        draw_icon(p, self._icon, r.adjusted(inset, inset, -inset, -inset), icon_color)


class PillGroup(QWidget):
    """Exclusive set of pill toggles, wrapping on narrow widths."""

    changed = Signal(object)

    def __init__(
        self,
        options: Iterable[tuple[object, str]],
        parent: QWidget | None = None,
        tooltips: dict | None = None,
        large: bool = False,
    ) -> None:
        super().__init__(parent)
        self._flow = FlowLayout(self, 6, 6)
        self._group = QButtonGroup(self)
        self._group.setExclusive(True)
        self._values: dict[int, object] = {}
        for i, (value, text) in enumerate(options):
            btn = QPushButton(text)
            btn.setProperty("variant", "pill")
            if large:
                btn.setProperty("scale", "large")
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
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(_mix(qcolor(P.surface3), qcolor(P.accent), self._pos))
        p.drawRoundedRect(r, r.height() / 2, r.height() / 2)
        d = r.height() - 6
        x = r.left() + 3 + (r.width() - d - 6) * self._pos
        p.setBrush(_mix(qcolor(P.text_dim), qcolor(P.text_on_light), self._pos))
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
        self.setMinimumHeight(44)
        self.setMaximumHeight(44)
        self.setMinimumWidth(180)
        self.setFocusPolicy(Qt.FocusPolicy.ClickFocus)
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
        # Only a slider the user clicked reacts to the wheel; otherwise scrolling
        # the page over it would silently change settings.
        if not self.hasFocus():
            e.ignore()
            return
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
        clip = QPainterPath()
        clip.addRoundedRect(r, rad, rad)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(qcolor(P.surface3) if self.hasFocus() else qcolor(P.surface2))
        p.drawPath(clip)

        # Filled portion (left of the thumb) is a lighter tone, as in the reference.
        t = self._track()
        x = t.left() + t.width() * self._frac()
        fill = QPainterPath()
        fill.addRect(QRectF(r.left(), r.top(), x - r.left(), r.height()))
        p.setBrush(QColor(255, 255, 255, 22))
        p.drawPath(fill.intersected(clip))

        p.setPen(qcolor(P.text_dim))
        p.setFont(app_font(9.5))
        p.drawText(r.adjusted(rad, 0, 0, 0), Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft, self._text)
        p.setPen(qcolor(P.text))
        p.setFont(app_font(9.5, QFont.Weight.DemiBold))
        p.drawText(r.adjusted(0, 0, -rad, 0), Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignRight, self._fmt(self._value))

        # Tick dots
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(255, 255, 255, 46))
        n = 14
        for i in range(n + 1):
            tx = t.left() + t.width() * i / n
            if abs(tx - x) > 5:
                p.drawEllipse(QPointF(tx, r.center().y()), 1.3, 1.3)
        # Thumb: thin white bar
        p.setBrush(QColor("white"))
        p.drawRoundedRect(QRectF(x - 1, r.center().y() - 10, 2, 20), 1, 1)


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

    def __init__(self, text: str = "", parent: QWidget | None = None, dot: str | None = None, height: int = 28) -> None:
        super().__init__(text, parent)
        self._dot = qcolor(dot) if dot else None
        self.setFont(app_font(8.5 if height < 36 else 9.5, QFont.Weight.Medium))
        self.setFixedHeight(height)
        self.overlay_alpha = 1.0  # < 1 for chips floating over video
        self._apply_margins()

    def _apply_margins(self) -> None:
        pad = max(13, self.height() // 2)
        self.setContentsMargins(pad + 14 if self._dot is not None else pad, 0, pad, 0)

    def set_dot(self, css: str | None) -> None:
        self._dot = qcolor(css) if css else None
        self._apply_margins()
        self.update()

    def paintEvent(self, _e) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = QRectF(self.rect())
        p.setPen(Qt.PenStyle.NoPen)
        bg = qcolor(P.surface2)
        bg.setAlphaF(self.overlay_alpha)
        p.setBrush(bg)
        p.drawRoundedRect(r, r.height() / 2, r.height() / 2)
        if self._dot is not None:
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(self._dot)
            p.drawEllipse(QPointF(max(13, self.height() // 2) + 2, r.center().y()), 4, 4)
        p.setPen(QColor("white"))
        p.setFont(self.font())
        p.drawText(self.contentsRect(), Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft, self.text())


class Banner(QFrame):
    """Transient notification that fades in at the top of the window."""

    def __init__(self, parent: QWidget) -> None:
        super().__init__(parent)
        self.setVisible(False)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(18, 8, 8, 8)
        self._dot = QLabel()
        self._dot.setFixedSize(8, 8)
        lay.addWidget(self._dot, 0, Qt.AlignmentFlag.AlignVCenter)
        self._text = label("", wrap=True)
        lay.addWidget(self._text, 1)
        close = CircleButton("close", 28, tooltip="Dismiss")
        close.clicked.connect(self.dismiss)
        lay.addWidget(close)
        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.timeout.connect(self.dismiss)
        self._fx = QGraphicsOpacityEffect(self)
        self._fx.setOpacity(0.0)
        self.setGraphicsEffect(self._fx)
        self._fade = QPropertyAnimation(self._fx, b"opacity", self)
        self._fade.setDuration(220)
        self._fade.setEasingCurve(QEasingCurve.Type.OutCubic)
        self._fade.finished.connect(self._fade_done)

    def show_message(self, text: str, level: str = "info", timeout_ms: int = 6000) -> None:
        dot = {"info": P.accent, "warn": P.warn, "error": P.danger}[level]
        self.setStyleSheet(f"Banner {{ background: {P.surface3}; border: none; border-radius: 22px; }}")
        self._dot.setStyleSheet(f"background: {dot}; border-radius: 4px;")
        self._text.setText(text)
        self.reposition()
        self.show()
        self.raise_()
        self._fade.stop()
        self._fade.setStartValue(self._fx.opacity())
        self._fade.setEndValue(1.0)
        self._fade.start()
        if timeout_ms > 0:
            self._timer.start(timeout_ms)
        else:
            self._timer.stop()

    def dismiss(self) -> None:
        self._timer.stop()
        self._fade.stop()
        self._fade.setStartValue(self._fx.opacity())
        self._fade.setEndValue(0.0)
        self._fade.start()

    def _fade_done(self) -> None:
        if self._fx.opacity() < 0.01:
            self.hide()

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
        clip.addRoundedRect(r, RADIUS_CARD, RADIUS_CARD)
        p.setClipPath(clip)
        p.fillRect(r, qcolor(P.stage))

        if self._image is not None and not self._image.isNull():
            img = self._image
            dpr = self.devicePixelRatioF()
            iw, ih = img.width() / dpr, img.height() / dpr
            scale = min(r.width() / iw, r.height() / ih)
            dw, dh = iw * scale, ih * scale
            target = QRectF(r.center().x() - dw / 2, r.center().y() - dh / 2, dw, dh)
            p.drawImage(target, img)
            # Bottom fade so the transport controls stay legible.
            fade = QLinearGradient(0, r.bottom() - 140, 0, r.bottom())
            fade.setColorAt(0, QColor(0, 0, 0, 0))
            fade.setColorAt(1, QColor(0, 0, 0, 170))
            p.fillRect(QRectF(r.left(), r.bottom() - 140, r.width(), 140), fade)
        else:
            self._paint_placeholder(p, r)

    def _paint_placeholder(self, p: QPainter, r: QRectF) -> None:
        size = min(r.width(), r.height()) * 0.16
        logo = QRectF(r.center().x() - size / 2, r.center().y() - size * 1.1, size, size)
        draw_logo(p, logo, QColor(255, 255, 255, 34))
        p.setPen(qcolor(P.text))
        p.setFont(app_font(max(14.0, min(26.0, r.width() / 34)), QFont.Weight.Light))
        p.drawText(QRectF(r.left(), logo.bottom() + 10, r.width(), 50), Qt.AlignmentFlag.AlignHCenter, self.headline)
        p.setPen(qcolor(P.text_faint))
        p.setFont(app_font(9.5))
        p.drawText(QRectF(r.left(), logo.bottom() + 58, r.width(), 30), Qt.AlignmentFlag.AlignHCenter, self.subline.upper())


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
    hoverAt = Signal(float)  # cursor fraction while hovering/dragging, -1 on leave

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
        self.hoverAt.emit(self._value if self.dragging else self._frac_at(self._hover_x))
        self.update()

    def x_for(self, frac: float) -> float:
        t = self._track()
        return t.left() + t.width() * frac

    def mouseReleaseEvent(self, e) -> None:  # noqa: N802
        if self.dragging:
            self.dragging = False
            self._value = self._frac_at(e.position().x())
            self.released.emit(self._value)
            if not self._hover:
                self.hoverAt.emit(-1.0)
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
        if not self.dragging:
            self.hoverAt.emit(-1.0)
        self.update()

    def paintEvent(self, _e) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        t = self._track()
        active = self._hover or self.dragging
        if active:
            t = t.adjusted(0, -1, 0, 1)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(255, 255, 255, 40))
        p.drawRoundedRect(t, t.height() / 2, t.height() / 2)
        if self._hover and not self.dragging:
            hx = max(t.left(), min(t.right(), self._hover_x))
            p.setBrush(QColor(255, 255, 255, 50))
            p.drawRoundedRect(QRectF(t.left(), t.top(), hx - t.left(), t.height()), t.height() / 2, t.height() / 2)
        lime = qcolor(P.accent)
        done = QRectF(t.left(), t.top(), t.width() * self._value, t.height())
        p.setBrush(lime if self.show_bubble else qcolor(P.text))
        p.drawRoundedRect(done, t.height() / 2, t.height() / 2)
        x = t.left() + t.width() * self._value
        if self.show_bubble:
            # Editor-style playhead: a thin lime bar that is always visible.
            p.drawRoundedRect(QRectF(x - 1.5, 2, 3, self.height() - 4), 1.5, 1.5)
        elif active:
            p.setBrush(qcolor(P.text))
            p.drawEllipse(QPointF(x, t.center().y()), 6, 6)


class TimeBubble(QWidget):
    """Lime time label that follows the timeline cursor while scrubbing."""

    def __init__(self, parent: QWidget) -> None:
        super().__init__(parent)
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        self.text = ""
        self.setFixedHeight(24)
        self.hide()

    def show_at(self, x_center: float, y_bottom: int, text: str) -> None:
        self.text = text
        fm = QFontMetricsF(app_font(8.5, QFont.Weight.DemiBold))
        w = int(fm.horizontalAdvance(text) + 20)
        self.setFixedWidth(w)
        parent = self.parentWidget()
        x = int(max(0, min((parent.width() if parent else w) - w, x_center - w / 2)))
        self.move(x, y_bottom - self.height())
        self.show()
        self.raise_()
        self.update()

    def paintEvent(self, _e) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(qcolor(P.accent))
        p.drawRoundedRect(QRectF(self.rect()), 12, 12)
        p.setPen(qcolor(P.text_on_light))
        p.setFont(app_font(8.5, QFont.Weight.DemiBold))
        p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, self.text)


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
        self.timeline.hoverAt.connect(self._bubble)
        self._time_bubble: TimeBubble | None = None
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
        for b in (self.snapshot_btn, self.record_btn):
            ll.addWidget(b)
        ll.addStretch(1)

        self.center = QWidget()
        cl = QHBoxLayout(self.center)
        cl.setContentsMargins(0, 0, 0, 0)
        cl.setSpacing(12)
        self.back10_btn = CircleButton("skip-back", 42, tooltip="Back 10 seconds (J)")
        self.step_back_btn = CircleButton("step-back", 42, tooltip="Previous frame (,)")
        self.play_btn = CircleButton("play", 60, solid=True, tooltip="Play / pause (Space)")
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

    def _bubble(self, frac: float) -> None:
        host = self.parentWidget() or self
        if self._time_bubble is None or self._time_bubble.parentWidget() is not host:
            self._time_bubble = TimeBubble(host)
        if frac < 0 or self.timeline.duration_ms <= 0:
            self._time_bubble.hide()
            return
        pos = self.timeline.mapTo(host, QPointF(self.timeline.x_for(frac), 0).toPoint())
        self._time_bubble.show_at(pos.x(), pos.y() - 6, fmt_time(frac * self.timeline.duration_ms))

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


class MasonryLayout(QLayout):
    """Fixed-width cards packed into columns, each card going to the shortest
    column, so short cards never leave an empty gap under them."""

    def __init__(self, parent: QWidget | None = None, column_width: int = 420, spacing: int = 18) -> None:
        super().__init__(parent)
        self._items: list[QLayoutItem] = []
        self._cw = column_width
        self._sp = spacing
        self.setContentsMargins(0, 0, 0, 0)

    def addItem(self, item: QLayoutItem) -> None:  # noqa: N802
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
        return QSize(self._cw, self.heightForWidth(self._cw))

    def minimumSize(self) -> QSize:  # noqa: N802
        return QSize(self._cw, 0)

    def _item_height(self, item: QLayoutItem) -> int:
        if item.hasHeightForWidth():
            return item.heightForWidth(self._cw)
        return item.sizeHint().height()

    def _do_layout(self, rect: QRect, dry: bool) -> int:
        cols = max(1, (rect.width() + self._sp) // (self._cw + self._sp))
        heights = [0] * cols
        for item in self._items:
            if item.widget() is not None and item.widget().isHidden():
                continue
            col = heights.index(min(heights))
            h = self._item_height(item)
            if not dry:
                item.setGeometry(QRect(rect.x() + col * (self._cw + self._sp), rect.y() + heights[col], self._cw, h))
            heights[col] += h + self._sp
        return max(heights) - self._sp if any(heights) else 0


class ProgressPill(QAbstractButton):
    """Header pill that fills with lime as an export progresses; clickable."""

    def __init__(self, height: int = 44, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._progress = 0.0
        self._busy = False
        self.setFixedHeight(height)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setFont(app_font(9.5, QFont.Weight.Medium))
        self._anim = QPropertyAnimation(self, b"progress", self)
        self._anim.setDuration(380)
        self._anim.setEasingCurve(QEasingCurve.Type.OutCubic)

    def _get_progress(self) -> float:
        return self._progress

    def _set_progress(self, v: float) -> None:
        self._progress = v
        self.update()

    progress = Property(float, _get_progress, _set_progress)

    def set_state(self, text: str, frac: float, busy: bool) -> None:
        self.setText(text)
        self._busy = busy
        frac = max(0.0, min(1.0, frac))
        if frac < self._progress:
            self._anim.stop()
            self._set_progress(frac)
        elif frac > self._progress:
            self._anim.stop()
            self._anim.setStartValue(self._progress)
            self._anim.setEndValue(frac)
            self._anim.start()
        fm = QFontMetricsF(self.font())
        self.setFixedWidth(int(fm.horizontalAdvance(text) + 2 * self.height() * 0.5 + 8))
        self.update()

    def sizeHint(self) -> QSize:  # noqa: N802
        return QSize(self.width(), self.height())

    def paintEvent(self, _e) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = QRectF(self.rect())
        rad = r.height() / 2
        clip = QPainterPath()
        clip.addRoundedRect(r, rad, rad)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(qcolor(P.surface2))
        p.drawPath(clip)
        fill = QPainterPath()
        fill.addRect(QRectF(0, 0, r.width() * self._progress, r.height()))
        p.setBrush(qcolor(P.accent) if not self._busy else qcolor(P.accent_dim))
        p.drawPath(fill.intersected(clip))
        if self._busy:
            # Bright leading edge so progress reads even at low percentages.
            p.setBrush(qcolor(P.accent))
            x = r.width() * self._progress
            edge = QPainterPath()
            edge.addRect(QRectF(max(0.0, x - 3), 0, 3, r.height()))
            p.drawPath(edge.intersected(clip))
        done = not self._busy and self._progress >= 0.999
        p.setPen(qcolor(P.text_on_light) if done else qcolor(P.text))
        p.setFont(self.font())
        p.drawText(r, Qt.AlignmentFlag.AlignCenter, self.text())
