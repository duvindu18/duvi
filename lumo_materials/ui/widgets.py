"""Reusable widgets in the flat dark style."""
from __future__ import annotations

import math
from typing import Callable, Sequence

from PySide6.QtCore import (QEasingCurve, QPointF, QPropertyAnimation, QRectF, QSize, Qt, QTimer, QVariantAnimation,
                            Signal)
from PySide6.QtGui import QColor, QFont, QFontMetrics, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import (QAbstractButton, QButtonGroup, QComboBox, QFrame, QGraphicsOpacityEffect, QHBoxLayout,
                               QLabel, QLayout, QLineEdit, QMenu, QPushButton, QSizePolicy, QVBoxLayout, QWidget)

from . import icons, theme
from ..viewmodel import page_window


# ------------------------------------------------------------------ small helpers
def label(text: str = "", role: str | None = None, wrap: bool = False) -> QLabel:
    lb = QLabel(text)
    if role:
        lb.setProperty("role", role)
    lb.setWordWrap(wrap)
    return lb


class ElidedLabel(QLabel):
    """Single-line label that shortens its text with '…' to fit, full text in the tooltip."""

    def __init__(self, text: str = "", mode: Qt.TextElideMode = Qt.TextElideMode.ElideMiddle, parent=None):
        super().__init__(parent)
        self._full = text
        self._mode = mode
        self.setToolTip(text)
        self.setMinimumWidth(40)

    def setText(self, text: str) -> None:  # noqa: N802 (Qt naming)
        self._full = text
        self.setToolTip(text)
        self._refit()

    def full_text(self) -> str:
        return self._full

    def _refit(self) -> None:
        super().setText(self.fontMetrics().elidedText(self._full, self._mode, max(0, self.width() - 2)))

    def resizeEvent(self, e) -> None:  # noqa: N802
        super().resizeEvent(e)
        self._refit()

    def minimumSizeHint(self) -> QSize:  # noqa: N802
        return QSize(40, super().minimumSizeHint().height())

    def sizeHint(self) -> QSize:  # noqa: N802
        return QSize(self.fontMetrics().horizontalAdvance(self._full) + 4, super().sizeHint().height())


def hline() -> QFrame:
    f = QFrame()
    f.setObjectName("HLine")
    f.setFixedHeight(1)
    return f


def vline() -> QFrame:
    f = QFrame()
    f.setObjectName("VLine")
    f.setFixedWidth(1)
    return f


def button(text: str = "", icon: str | None = None, kind: str | None = None, tip: str = "",
           on_click: Callable | None = None, checkable: bool = False) -> QPushButton:
    b = QPushButton(text)
    if kind:
        b.setProperty("kind", kind)
    if icon:
        dark = kind == "primary"
        b.setIcon(icons.icon(icon, "#111113" if dark else theme.TEXT_2, "#111113" if dark else theme.TEXT))
        b.setIconSize(icons.ICON_SIZE)
    if tip:
        b.setToolTip(tip)
    b.setCheckable(checkable)
    b.setCursor(Qt.CursorShape.PointingHandCursor)
    if on_click:
        b.clicked.connect(on_click)
    return b


def hbox(*items, spacing: int = 8, margins=(0, 0, 0, 0)) -> QHBoxLayout:
    lay = QHBoxLayout()
    lay.setSpacing(spacing)
    lay.setContentsMargins(*margins)
    for it in items:
        if it is None:
            lay.addStretch(1)
        elif isinstance(it, int):
            lay.addSpacing(it)
        elif isinstance(it, QWidget):
            lay.addWidget(it)
        else:
            lay.addLayout(it)
    return lay


def vbox(*items, spacing: int = 8, margins=(0, 0, 0, 0)) -> QVBoxLayout:
    lay = QVBoxLayout()
    lay.setSpacing(spacing)
    lay.setContentsMargins(*margins)
    for it in items:
        if it is None:
            lay.addStretch(1)
        elif isinstance(it, int):
            lay.addSpacing(it)
        elif isinstance(it, QWidget):
            lay.addWidget(it)
        else:
            lay.addLayout(it)
    return lay


def clear_layout(lay) -> None:
    """Removes every item of a layout. Widgets are hidden and detached at once (deleteLater alone would leave
    them painted until the event loop runs), then deleted."""
    while lay.count():
        it = lay.takeAt(0)
        w = it.widget()
        if w is not None:
            w.hide()
            w.setParent(None)
            w.deleteLater()
        elif it.layout() is not None:
            clear_layout(it.layout())


def human_bytes(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit in ("B", "KB") else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


# ------------------------------------------------------------------ caption buttons
class CaptionButton(QAbstractButton):
    def __init__(self, kind: str, parent=None):
        super().__init__(parent)
        self.kind = kind            # min | max | close
        self.maximized = False
        self.setFixedSize(46, 40)
        self.setCursor(Qt.CursorShape.ArrowCursor)
        self.setToolTip({"min": "Minimise", "max": "Maximise", "close": "Close"}[kind])
        self._hover = False

    def enterEvent(self, e):
        self._hover = True
        self.update()

    def leaveEvent(self, e):
        self._hover = False
        self.update()

    def paintEvent(self, e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        if self._hover or self.isDown():
            bg = QColor(theme.CLOSE_HOVER) if self.kind == "close" else QColor("#232326")
            if self.isDown():
                bg = bg.darker(115)
            p.fillRect(self.rect(), bg)
        col = QColor("#ffffff" if (self.kind == "close" and self._hover) else theme.TEXT_2)
        pen = QPen(col, 1.0)
        pen.setCosmetic(True)
        p.setPen(pen)
        cx, cy = self.width() / 2, self.height() / 2
        s = 5.0
        if self.kind == "min":
            p.drawLine(QPointF(cx - s, cy), QPointF(cx + s, cy))
        elif self.kind == "max":
            if self.maximized:
                p.drawRoundedRect(QRectF(cx - s, cy - s + 2, 2 * s - 2, 2 * s - 2), 1.5, 1.5)
                path = QPainterPath()
                path.moveTo(cx - s + 2, cy - s)
                path.lineTo(cx + s - 1, cy - s)
                path.quadTo(cx + s, cy - s, cx + s, cy - s + 1)
                path.lineTo(cx + s, cy + s - 2)
                p.drawPath(path)
            else:
                p.drawRoundedRect(QRectF(cx - s, cy - s, 2 * s, 2 * s), 1.5, 1.5)
        else:
            p.drawLine(QPointF(cx - s, cy - s), QPointF(cx + s, cy + s))
            p.drawLine(QPointF(cx + s, cy - s), QPointF(cx - s, cy + s))
        p.end()


class CaptionButtons(QWidget):
    def __init__(self, window: QWidget, parent=None):
        super().__init__(parent)
        self.win = window
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(0)
        self.bmin, self.bmax, self.bclose = CaptionButton("min"), CaptionButton("max"), CaptionButton("close")
        for b in (self.bmin, self.bmax, self.bclose):
            lay.addWidget(b)
        self.bmin.clicked.connect(window.showMinimized)
        self.bmax.clicked.connect(lambda: window.toggle_maximized())
        self.bclose.clicked.connect(window.close)

    def sync(self) -> None:
        self.bmax.maximized = self.win.isMaximized()
        self.bmax.setToolTip("Restore" if self.bmax.maximized else "Maximise")
        self.bmax.update()


# ------------------------------------------------------------------ fill-bar slider row
class FillSlider(QWidget):
    """A row whose filled part is the value: drag anywhere, wheel, arrow keys; double-click resets."""
    valueChanged = Signal(float)        # while dragging
    valueCommitted = Signal(float)      # mouse released / key / wheel settled

    def __init__(self, text: str, minimum: float, maximum: float, value: float, step: float = 0.01,
                 decimals: int = 2, default: float | None = None, suffix: str = "", ticks: int = 0, parent=None):
        super().__init__(parent)
        self.text, self.minimum, self.maximum = text, float(minimum), float(maximum)
        self.step, self.decimals, self.suffix, self.ticks = float(step), int(decimals), suffix, int(ticks)
        self.default = float(value if default is None else default)
        self._value = self._clamp(value)
        self._drag = False
        self.setFixedHeight(38)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setCursor(Qt.CursorShape.SizeHorCursor)
        self.setProperty("interactive", True)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self._commit_timer = QTimer(self, singleShot=True, interval=250)
        self._commit_timer.timeout.connect(lambda: self.valueCommitted.emit(self._value))
        self.setToolTip(f"{text}: drag, click or use the arrow keys. Double-click resets to "
                        f"{self._fmt(self.default)}.")

    def _clamp(self, v: float) -> float:
        v = min(self.maximum, max(self.minimum, float(v)))
        if self.step > 0:
            v = round((v - self.minimum) / self.step) * self.step + self.minimum
        return round(min(self.maximum, max(self.minimum, v)), 6)

    def _fmt(self, v: float) -> str:
        return (f"{v:.{self.decimals}f}" if self.decimals > 0 else f"{int(round(v))}") + self.suffix

    def value(self) -> float:
        return self._value

    def setValue(self, v: float, emit: bool = False) -> None:
        nv = self._clamp(v)
        if nv != self._value:
            self._value = nv
            self.update()
            if emit:
                self.valueChanged.emit(nv)
                self._commit_timer.start()

    def _frac(self) -> float:
        span = self.maximum - self.minimum
        return 0.0 if span <= 0 else (self._value - self.minimum) / span

    def _set_from_x(self, x: float) -> None:
        f = min(1.0, max(0.0, (x - 2) / max(1.0, self.width() - 4)))
        self.setValue(self.minimum + f * (self.maximum - self.minimum), emit=True)

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._drag = True
            self._set_from_x(e.position().x())

    def mouseMoveEvent(self, e):
        if self._drag:
            self._set_from_x(e.position().x())

    def mouseReleaseEvent(self, e):
        if self._drag:
            self._drag = False
            self._commit_timer.stop()
            self.valueCommitted.emit(self._value)

    def mouseDoubleClickEvent(self, e):
        self.setValue(self.default, emit=True)

    def wheelEvent(self, e):
        e.ignore()          # scrolling the panel must never change a value: drag, click or use the arrow keys

    def keyPressEvent(self, e):
        k = e.key()
        mult = 10 if e.modifiers() & Qt.KeyboardModifier.ShiftModifier else 1
        if k in (Qt.Key.Key_Right, Qt.Key.Key_Up):
            self.setValue(self._value + self.step * mult, emit=True)
        elif k in (Qt.Key.Key_Left, Qt.Key.Key_Down):
            self.setValue(self._value - self.step * mult, emit=True)
        elif k == Qt.Key.Key_Home:
            self.setValue(self.minimum, emit=True)
        elif k == Qt.Key.Key_End:
            self.setValue(self.maximum, emit=True)
        elif k in (Qt.Key.Key_Delete, Qt.Key.Key_Backspace):
            self.setValue(self.default, emit=True)
        else:
            super().keyPressEvent(e)

    def paintEvent(self, e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = QRectF(self.rect()).adjusted(0.5, 0.5, -0.5, -0.5)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(theme.ROW))
        p.drawRoundedRect(r, 9, 9)
        fm = QFontMetrics(self.font())
        label_w = fm.horizontalAdvance(self.text) + 14 + 22
        fw = max(label_w if self._frac() > 0 else 0, r.width() * self._frac())
        fw = min(r.width(), fw) if self._frac() > 0 else 0
        if fw > 0:
            p.setBrush(QColor(theme.FILL if not self.hasFocus() else "#303034"))
            p.drawRoundedRect(QRectF(r.left(), r.top(), fw, r.height()), 9, 9)
            p.setBrush(QColor("#d8d8db"))
            p.drawRoundedRect(QRectF(r.left() + fw - 11, r.top() + 11, 2, r.height() - 22), 1, 1)
        if self.ticks > 1:
            p.setBrush(QColor("#3a3a3e"))
            x0 = r.left() + max(fw, label_w) + 16
            x1 = r.right() - fm.horizontalAdvance("0000.00") - 18
            if x1 > x0:
                for i in range(self.ticks):
                    x = x0 + (x1 - x0) * i / (self.ticks - 1)
                    p.drawEllipse(QPointF(x, r.center().y()), 1.5, 1.5)
        p.setPen(QColor(theme.TEXT_2))
        p.drawText(r.adjusted(14, 0, -14, 0), Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft, self.text)
        p.setPen(QColor(theme.TEXT))
        p.drawText(r.adjusted(14, 0, -14, 0), Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignRight,
                   self._fmt(self._value))
        p.end()

    def sizeHint(self):
        return QSize(240, 38)


class ChoiceRow(QWidget):
    """A row like FillSlider for a set of options: click opens a menu, wheel cycles."""
    changed = Signal(str)

    def __init__(self, text: str, options: Sequence[tuple[str, str]], value: str, parent=None):
        super().__init__(parent)
        self.text = text
        self.options = list(options)      # (key, label)
        self._value = value if any(k == value for k, _ in self.options) else self.options[0][0]
        self.setFixedHeight(38)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setProperty("interactive", True)

    def value(self) -> str:
        return self._value

    def setValue(self, v: str, emit: bool = False) -> None:
        if v != self._value and any(k == v for k, _ in self.options):
            self._value = v
            self.update()
            if emit:
                self.changed.emit(v)

    def _label(self) -> str:
        return next((lb for k, lb in self.options if k == self._value), self._value)

    def _cycle(self, d: int) -> None:
        keys = [k for k, _ in self.options]
        i = (keys.index(self._value) + d) % len(keys)
        self.setValue(keys[i], emit=True)

    def mousePressEvent(self, e):
        if e.button() != Qt.MouseButton.LeftButton:
            return
        m = QMenu(self)
        for k, lb in self.options:
            a = m.addAction(lb)
            a.setCheckable(True)
            a.setChecked(k == self._value)
            a.triggered.connect(lambda _=False, key=k: self.setValue(key, emit=True))
        m.exec(self.mapToGlobal(self.rect().bottomRight()) - QPointF(m.sizeHint().width(), 0).toPoint())

    def wheelEvent(self, e):
        e.ignore()          # scrolling the panel must never change a value

    def keyPressEvent(self, e):
        if e.key() in (Qt.Key.Key_Right, Qt.Key.Key_Down, Qt.Key.Key_Space):
            self._cycle(1)
        elif e.key() in (Qt.Key.Key_Left, Qt.Key.Key_Up):
            self._cycle(-1)
        else:
            super().keyPressEvent(e)

    def paintEvent(self, e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = QRectF(self.rect()).adjusted(0.5, 0.5, -0.5, -0.5)
        p.setPen(QPen(QColor("#4a4a50"), 1) if self.hasFocus() else Qt.PenStyle.NoPen)
        p.setBrush(QColor(theme.ROW))
        p.drawRoundedRect(r, 9, 9)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor("#4a4a4f"))
        p.drawRoundedRect(QRectF(r.left() + 14, r.top() + 11, 2, r.height() - 22), 1, 1)
        p.setPen(QColor(theme.TEXT_2))
        p.drawText(r.adjusted(26, 0, -14, 0), Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft, self.text)
        p.setPen(QColor(theme.TEXT))
        p.drawText(r.adjusted(26, 0, -14, 0), Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignRight, self._label())
        p.end()


class ToggleRow(ChoiceRow):
    """On / off row."""
    toggled = Signal(bool)

    def __init__(self, text: str, value: bool, parent=None):
        super().__init__(text, [("off", "Off"), ("on", "On")], "on" if value else "off", parent)
        self.changed.connect(lambda v: self.toggled.emit(v == "on"))

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._cycle(1)

    def checked(self) -> bool:
        return self.value() == "on"

    def setChecked(self, v: bool) -> None:
        self.setValue("on" if v else "off")


# ------------------------------------------------------------------ segmented switch
class Segmented(QFrame):
    """Exclusive options in one frame; the chosen one sits on a rounded pill that slides to the new choice."""
    changed = Signal(str)

    def __init__(self, options: Sequence[tuple[str, str]], value: str, parent=None, icon_only: bool = False,
                 height: int = 28):
        super().__init__(parent)
        self.setObjectName("Segmented")
        inner = height - 6
        self.setStyleSheet(
            f"QFrame#Segmented {{ border: 1px solid {theme.LINE_2}; border-radius: 7px; background: transparent; }}"
            f"QFrame#Segmented QPushButton {{ border: none; border-radius: 5px; background: transparent; padding: 0px 10px;"
            f" min-height: {inner}px; max-height: {inner}px; color: {theme.MUTED}; font-size: 12px; font-weight: 400; }}"
            f"QFrame#Segmented QPushButton:hover {{ color: {theme.TEXT_2}; }}"
            f"QFrame#Segmented QPushButton:checked {{ background: transparent; color: {theme.TEXT}; }}")
        self.setFixedHeight(height)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(2, 2, 2, 2)
        lay.setSpacing(2)
        self.group = QButtonGroup(self)
        self.group.setExclusive(True)
        self.buttons: dict[str, QPushButton] = {}
        for key, text in options:
            if icon_only:
                b = button("", icon=text, checkable=True)
                b.setFixedWidth(inner + 6)
                b.setStyleSheet("padding: 0px;")
            else:
                b = button(text, checkable=True)
            self.group.addButton(b)
            self.buttons[key] = b
            lay.addWidget(b)
            b.clicked.connect(lambda _=False, k=key: self._clicked(k))
        self._pill: QRectF | None = None
        self._anim = QVariantAnimation(self)
        self._anim.setDuration(180)
        self._anim.setEasingCurve(QEasingCurve.Type.OutCubic)
        self._anim.valueChanged.connect(self._pill_moved)
        self.setValue(value)

    def _clicked(self, key: str) -> None:
        self._slide_to(key)
        self.changed.emit(key)

    def _target(self, key: str) -> QRectF | None:
        b = self.buttons.get(key)
        return QRectF(b.geometry()) if b is not None else None

    def _slide_to(self, key: str) -> None:
        target = self._target(key)
        if target is None:
            return
        if self._pill is None or not theme.ANIMATIONS or not self.isVisible():
            self._anim.stop()
            self._pill = target
            self.update()
            return
        self._anim.stop()
        self._anim.setStartValue(self._pill)
        self._anim.setEndValue(target)
        self._anim.start()

    def _pill_moved(self, r) -> None:
        self._pill = QRectF(r)
        self.update()

    def resizeEvent(self, e):
        super().resizeEvent(e)
        self._anim.stop()
        self._pill = self._target(self.value())
        self.update()

    def showEvent(self, e):
        super().showEvent(e)
        self._pill = self._target(self.value())

    def paintEvent(self, e):
        super().paintEvent(e)
        if self._pill is None or not self.value():
            return
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor("#2a2a2e"))
        p.drawRoundedRect(self._pill, 5, 5)
        p.end()

    def setValue(self, key: str) -> None:
        if key in self.buttons:
            self.buttons[key].setChecked(True)
            self._slide_to(key)

    def value(self) -> str:
        for k, b in self.buttons.items():
            if b.isChecked():
                return k
        return ""


# ------------------------------------------------------------------ pager
class Pager(QFrame):
    pageChanged = Signal(int)
    pageSizeChanged = Signal(int)

    SIZES = (12, 24, 48, 96)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("Panel")
        self.setFixedHeight(48)
        self.page, self.pages, self.total, self.per_page = 0, 1, 0, 24
        lay = QHBoxLayout(self)
        lay.setContentsMargins(14, 0, 10, 0)
        lay.setSpacing(4)
        self.info = label("", "muted")
        self.info.setStyleSheet("font-size: 12px;")
        lay.addWidget(self.info)
        lay.addStretch(1)
        self.bfirst = button("", "first", "square", "First page", lambda: self.go(0))
        self.bprev = button("", "prev", "square", "Previous page", lambda: self.go(self.page - 1))
        self.nums = QHBoxLayout()
        self.nums.setSpacing(2)
        self.bnext = button("", "next", "square", "Next page", lambda: self.go(self.page + 1))
        self.blast = button("", "last", "square", "Last page", lambda: self.go(self.pages - 1))
        for w in (self.bfirst, self.bprev):
            lay.addWidget(w)
        lay.addLayout(self.nums)
        for w in (self.bnext, self.blast):
            lay.addWidget(w)
        lay.addStretch(1)
        per = label("Per page", "muted")
        per.setStyleSheet("font-size: 12px;")
        lay.addWidget(per)
        self.bsize = button("24", None, "ghost")
        self.bsize.setStyleSheet(f"min-height: 26px; padding: 0 8px; border: 1px solid {theme.LINE_2}; border-radius: 6px;"
                                 " font-size: 12px; font-weight: 400;")
        self.bsize.setIcon(icons.icon("caret"))
        self.bsize.setLayoutDirection(Qt.LayoutDirection.RightToLeft)
        self.bsize.clicked.connect(self._size_menu)
        lay.addWidget(self.bsize)

    def _size_menu(self):
        m = QMenu(self)
        for s in self.SIZES:
            a = m.addAction(str(s))
            a.setCheckable(True)
            a.setChecked(s == self.per_page)
            a.triggered.connect(lambda _=False, v=s: self.pageSizeChanged.emit(v))
        m.exec(self.bsize.mapToGlobal(self.bsize.rect().bottomLeft()))

    def go(self, page: int) -> None:
        page = max(0, min(self.pages - 1, page))
        if page != self.page:
            self.pageChanged.emit(page)

    def set_state(self, page: int, size: int, total: int) -> None:
        self.per_page, self.total = size, total
        self.pages = max(1, math.ceil(total / size))
        self.page = max(0, min(self.pages - 1, page))
        self.bsize.setText(str(size))
        a = self.page * size + 1 if total else 0
        b = min(total, (self.page + 1) * size)
        self.info.setText(f"Showing {a}–{b} of {total}" if total else "Nothing to show")
        clear_layout(self.nums)
        for item in page_window(self.page, self.pages):
            if item is None:
                lb = label("…", "muted")
                lb.setFixedWidth(20)
                lb.setAlignment(Qt.AlignmentFlag.AlignCenter)
                self.nums.addWidget(lb)
            else:
                b = button(str(item + 1), None, "page", checkable=True)
                b.setChecked(item == self.page)
                b.clicked.connect(lambda _=False, p=item: self.go(p))
                self.nums.addWidget(b)
        for w, ok in ((self.bfirst, self.page > 0), (self.bprev, self.page > 0),
                      (self.bnext, self.page < self.pages - 1), (self.blast, self.page < self.pages - 1)):
            w.setEnabled(ok)


# ------------------------------------------------------------------ search field
class SearchField(QFrame):
    textChanged = Signal(str)

    def __init__(self, placeholder: str = "Search", parent=None):
        super().__init__(parent)
        self.setStyleSheet(f"SearchField {{ border: 1px solid {theme.LINE_2}; border-radius: 7px; background: #111112; }}")
        self.setFixedHeight(32)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(10, 0, 8, 0)
        lay.setSpacing(8)
        ic = QLabel()
        ic.setPixmap(icons.pixmap("search", theme.MUTED))
        lay.addWidget(ic)
        self.edit = QLineEdit()
        self.edit.setProperty("role", "search")
        self.edit.setPlaceholderText(placeholder)
        self.edit.setClearButtonEnabled(True)
        lay.addWidget(self.edit, 1)
        self._t = QTimer(self, singleShot=True, interval=180)
        self._t.timeout.connect(lambda: self.textChanged.emit(self.edit.text()))
        self.edit.textChanged.connect(lambda _: self._t.start())

    def text(self) -> str:
        return self.edit.text()

    def focus(self) -> None:
        self.edit.setFocus()
        self.edit.selectAll()


# ------------------------------------------------------------------ toast
TOAST_BOTTOM = 84   # above the pager and the footer buttons


class Toast(QFrame):
    def __init__(self, parent: QWidget):
        super().__init__(parent)
        self.setObjectName("Toast")
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, False)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(14, 10, 10, 10)
        lay.setSpacing(10)
        self.icon = QLabel()
        self.text = label("")
        self.text.setWordWrap(True)
        self.action = button("", None, "ghost")
        self.action.hide()
        lay.addWidget(self.icon)
        lay.addWidget(self.text, 1)
        lay.addWidget(self.action)
        self.eff = QGraphicsOpacityEffect(self)
        self.setGraphicsEffect(self.eff)
        self.anim = QPropertyAnimation(self.eff, b"opacity", self)
        self.anim.setDuration(180)
        self.anim.setEasingCurve(QEasingCurve.Type.OutCubic)
        self.slide = QPropertyAnimation(self, b"pos", self)
        self.slide.setDuration(220)
        self.slide.setEasingCurve(QEasingCurve.Type.OutCubic)
        self.timer = QTimer(self, singleShot=True)
        self.timer.timeout.connect(self._fade)
        self.hide()
        self._cb: Callable | None = None
        self.action.clicked.connect(self._act)

    def _act(self):
        cb, self._cb = self._cb, None
        self.hide()
        if cb:
            cb()

    def show_message(self, text: str, kind: str = "info", action: str | None = None,
                     on_action: Callable | None = None, ms: int = 4200) -> None:
        col = {"info": theme.TEXT_2, "ok": theme.OK, "error": theme.DANGER, "warn": theme.STAR}.get(kind, theme.TEXT_2)
        self.icon.setPixmap(icons.pixmap("warning" if kind in ("error", "warn") else
                                         "check" if kind == "ok" else "info", col))
        self.text.setText(text)
        self._cb = on_action
        self.action.setVisible(bool(action))
        self.action.setText(action or "")
        self.adjustSize()
        w = min(520, max(280, self.sizeHint().width()))
        self.resize(w, self.sizeHint().height())
        par = self.parentWidget()
        end = QPointF((par.width() - self.width()) // 2, par.height() - self.height() - TOAST_BOTTOM).toPoint()
        was_visible = self.isVisible() and self.eff.opacity() > 0.5
        self.raise_()
        self.show()
        self.anim.stop()
        self.slide.stop()
        if theme.ANIMATIONS and not was_visible:      # rises a little while it fades in
            self.move(end.x(), end.y() + 14)
            self.slide.setStartValue(self.pos())
            self.slide.setEndValue(end)
            self.slide.start()
        else:
            self.move(end)
        self.anim.setDuration(180 if theme.ANIMATIONS else 1)
        self.anim.setStartValue(self.eff.opacity() if was_visible else 0.0)
        self.anim.setEndValue(1.0)
        self.anim.start()
        self.timer.start(ms if not action else max(ms, 7000))

    def _fade(self):
        self.anim.stop()
        self.anim.setStartValue(1.0)
        self.anim.setEndValue(0.0)
        self.anim.finished.connect(self._after_fade)
        self.anim.start()

    def _after_fade(self):
        try:
            self.anim.finished.disconnect(self._after_fade)
        except (RuntimeError, TypeError):
            pass
        if self.eff.opacity() < 0.05:
            self.hide()


class TagEdit(QLineEdit):
    """Comma-separated tags, lower-cased."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setPlaceholderText("tags, separated by commas")

    def tags(self) -> list[str]:
        return [t.strip().lower() for t in self.text().split(",") if t.strip()]

    def setTags(self, tags: Sequence[str]) -> None:
        self.setText(", ".join(tags))


def bold(font: QFont, weight: QFont.Weight = QFont.Weight.Medium) -> QFont:
    f = QFont(font)
    f.setWeight(weight)
    return f


# ------------------------------------------------------------------ skeletons (loading placeholders)
SKELETON_BASE = "#1a1a1d"
SKELETON_SHINE = "#26262a"


def shimmer_brush(rect: QRectF, phase: float):
    """A soft highlight band sweeping left to right; phase 0..1."""
    from PySide6.QtGui import QLinearGradient
    w = max(1.0, rect.width())
    x = rect.left() - w * 0.6 + phase * w * 2.2
    g = QLinearGradient(x, 0, x + w * 0.6, 0)
    g.setColorAt(0.0, QColor(SKELETON_BASE))
    g.setColorAt(0.5, QColor(SKELETON_SHINE))
    g.setColorAt(1.0, QColor(SKELETON_BASE))
    return g


class ShimmerClock(QTimer):
    """One shared animation clock for every skeleton (30 fps, runs only while something listens)."""
    _instance = None

    def __init__(self):
        super().__init__()
        self.setInterval(33)
        self.listeners: set = set()
        self.timeout.connect(self._tick)
        import time as _t
        self._t0 = _t.perf_counter()

    @classmethod
    def get(cls) -> "ShimmerClock":
        if cls._instance is None:
            cls._instance = ShimmerClock()
        return cls._instance

    def phase(self) -> float:
        import time as _t
        return ((_t.perf_counter() - self._t0) / 1.3) % 1.0

    def add(self, w) -> None:
        self.listeners.add(w)
        if not self.isActive():
            self.start()

    def discard(self, w) -> None:
        self.listeners.discard(w)
        if not self.listeners:
            self.stop()

    def _tick(self):
        for w in list(self.listeners):
            try:
                w.update()
            except RuntimeError:          # deleted widget
                self.listeners.discard(w)


class PreviewPlaceholder(QWidget):
    """Shown over the 3D view while a material loads: its saved thumbnail if there is one, with a shimmer;
    otherwise a skeleton sphere."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.pixmap = None
        self.opacity = 1.0
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)
        self._fade = QVariantAnimation(self)
        self._fade.setDuration(200)
        self._fade.setEasingCurve(QEasingCurve.Type.OutCubic)
        self._fade.setStartValue(1.0)
        self._fade.setEndValue(0.0)
        self._fade.valueChanged.connect(self._faded)
        self._fade.finished.connect(self._gone)
        self.hide()

    def start(self, pixmap=None) -> None:
        self._fade.stop()
        self.opacity = 1.0
        self.pixmap = pixmap if (pixmap is not None and not pixmap.isNull()) else None
        self.show()
        self.raise_()
        ShimmerClock.get().add(self)

    def stop(self) -> None:
        """The material is there: the placeholder dissolves into it."""
        if self.isHidden():
            return
        if theme.ANIMATIONS and self.isVisible():
            self._fade.stop()
            self._fade.start()
        else:                       # not on screen (e.g. its page is not shown yet): just go
            self._fade.stop()
            self._gone()

    def _faded(self, v) -> None:
        self.opacity = float(v)
        self.update()

    def _gone(self) -> None:
        self.hide()
        self.pixmap = None
        self.opacity = 1.0
        ShimmerClock.get().discard(self)

    def paintEvent(self, e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        p.setOpacity(self.opacity)
        p.fillRect(self.rect(), QColor("#121214"))
        side = min(self.width(), self.height()) * 0.72
        r = QRectF((self.width() - side) / 2, (self.height() - side) / 2, side, side)
        phase = ShimmerClock.get().phase()
        if self.pixmap is not None:
            p.drawPixmap(r.toRect(), self.pixmap)
            # a light sweep over the thumbnail says "still loading"
            g = shimmer_brush(r, phase)
            p.setOpacity(0.28 * self.opacity)
            path = QPainterPath()
            path.addEllipse(r)
            p.fillPath(path, g)
            p.setOpacity(self.opacity)
        else:
            path = QPainterPath()
            path.addEllipse(r)
            p.fillPath(path, shimmer_brush(r, phase))
        p.end()


class SkeletonBox(QWidget):
    """A rounded shimmering block (for map thumbnails and text lines while loading)."""

    def __init__(self, w: int, h: int, radius: float = 6, parent=None):
        super().__init__(parent)
        self.setFixedSize(w, h)
        self.radius = radius

    def showEvent(self, e):
        ShimmerClock.get().add(self)

    def hideEvent(self, e):
        ShimmerClock.get().discard(self)

    def paintEvent(self, e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = QRectF(self.rect())
        path = QPainterPath()
        path.addRoundedRect(r, self.radius, self.radius)
        p.fillPath(path, shimmer_brush(r, ShimmerClock.get().phase()))
        p.end()


class SizeSlider(QWidget):
    """Compact slider for the card size: small and large grid icons at the ends. Drag or click; no wheel."""
    valueChanged = Signal(int)

    def __init__(self, minimum: int, maximum: int, value: int, parent=None):
        super().__init__(parent)
        self.minimum, self.maximum = minimum, maximum
        self._value = max(minimum, min(maximum, int(value)))
        self.setFixedSize(150, 32)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setProperty("interactive", True)
        self.setToolTip("Card size (Ctrl + mouse wheel over the grid)")
        self._drag = False

    def value(self) -> int:
        return self._value

    def setValue(self, v: int, emit: bool = False) -> None:
        v = max(self.minimum, min(self.maximum, int(v)))
        if v != self._value:
            self._value = v
            self.update()
            if emit:
                self.valueChanged.emit(v)

    def _track(self) -> tuple[float, float]:
        return 30.0, self.width() - 33.0      # the knob stops clear of the icons at both ends

    def _from_x(self, x: float) -> None:
        a, b = self._track()
        f = min(1.0, max(0.0, (x - a) / (b - a)))
        self.setValue(round(self.minimum + f * (self.maximum - self.minimum)), emit=True)

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._drag = True
            self._from_x(e.position().x())

    def mouseMoveEvent(self, e):
        if self._drag:
            self._from_x(e.position().x())

    def mouseReleaseEvent(self, e):
        self._drag = False

    def wheelEvent(self, e):
        e.ignore()                       # never change by scrolling past it

    def paintEvent(self, e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = QRectF(self.rect()).adjusted(0.5, 0.5, -0.5, -0.5)
        p.setPen(QPen(QColor(theme.LINE_2), 1))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawRoundedRect(r, 7, 7)
        cy = self.height() / 2
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(theme.MUTED))
        for dx, dy in ((0, 0), (5, 0), (0, 5), (5, 5)):          # small grid icon
            p.drawRoundedRect(QRectF(10 + dx, cy - 4.5 + dy, 3.5, 3.5), 0.8, 0.8)
        p.drawRoundedRect(QRectF(self.width() - 21, cy - 5.5, 11, 11), 2, 2)   # large tile icon
        a, b = self._track()
        p.setBrush(QColor("#2c2c30"))
        p.drawRoundedRect(QRectF(a, cy - 1.5, b - a, 3), 1.5, 1.5)
        f = (self._value - self.minimum) / max(1, self.maximum - self.minimum)
        x = a + f * (b - a)
        p.setBrush(QColor("#5a5a60"))
        p.drawRoundedRect(QRectF(a, cy - 1.5, x - a, 3), 1.5, 1.5)
        p.setBrush(QColor(theme.TEXT))
        p.drawEllipse(QPointF(x, cy), 5.5, 5.5)
        p.end()


# ------------------------------------------------------------------ tags as chips
class FlowLayout(QLayout):
    """Lays widgets out left to right and wraps to the next line (Qt's classic flow layout)."""

    def __init__(self, parent=None, spacing: int = 6):
        super().__init__(parent)
        self._items = []
        self._spacing = spacing
        self.setContentsMargins(0, 0, 0, 0)

    def addItem(self, item):
        self._items.append(item)

    def count(self):
        return len(self._items)

    def itemAt(self, i):
        return self._items[i] if 0 <= i < len(self._items) else None

    def takeAt(self, i):
        return self._items.pop(i) if 0 <= i < len(self._items) else None

    def expandingDirections(self):
        return Qt.Orientation(0)

    def hasHeightForWidth(self):
        return True

    def heightForWidth(self, width):
        return self._do_layout(QRectF(0, 0, width, 0).toRect(), test=True)

    def setGeometry(self, rect):
        super().setGeometry(rect)
        self._do_layout(rect, test=False)

    def sizeHint(self):
        return self.minimumSize()

    def minimumSize(self):
        size = QSize()
        for it in self._items:
            size = size.expandedTo(it.minimumSize())
        m = self.contentsMargins()
        return size + QSize(m.left() + m.right(), m.top() + m.bottom())

    def _do_layout(self, rect, test: bool) -> int:
        m = self.contentsMargins()
        x, y = rect.x() + m.left(), rect.y() + m.top()
        right = rect.right() - m.right()
        line_h = 0
        for it in self._items:
            hint = it.sizeHint()
            if x + hint.width() > right and line_h > 0:
                x = rect.x() + m.left()
                y += line_h + self._spacing
                line_h = 0
            if not test:
                from PySide6.QtCore import QPoint, QRect
                it.setGeometry(QRect(QPoint(x, y), hint))
            x += hint.width() + self._spacing
            line_h = max(line_h, hint.height())
        return y + line_h - rect.y() + m.bottom()


class TagChip(QFrame):
    removed = Signal(str)

    def __init__(self, tag: str, parent=None):
        super().__init__(parent)
        self.tag = tag
        self.setObjectName("TagChip")
        self.setStyleSheet(f"QFrame#TagChip {{ background: #232326; border: 1px solid {theme.LINE_2}; border-radius: 6px; }}")
        lay = QHBoxLayout(self)
        lay.setContentsMargins(8, 0, 2, 0)
        lay.setSpacing(2)
        t = label(tag)
        t.setStyleSheet(f"font-size: 12px; color: {theme.TEXT};")
        lay.addWidget(t)
        x = QPushButton()
        x.setIcon(icons.icon("close", theme.MUTED, theme.TEXT, 12))
        x.setIconSize(QSize(10, 10))
        x.setFixedSize(18, 18)
        x.setCursor(Qt.CursorShape.PointingHandCursor)
        x.setToolTip(f"Remove {tag}")
        x.setStyleSheet("QPushButton { border: none; background: transparent; min-height: 0px; padding: 0px; border-radius: 4px; }"
                        "QPushButton:hover { background: #3a3a3e; }")
        x.clicked.connect(lambda: self.removed.emit(self.tag))
        lay.addWidget(x)
        self.setFixedHeight(24)


class TagInput(QFrame):
    """Tags as chips. Type and press Enter, comma or Tab to add; Backspace in the empty field removes the last;
    the × on a chip removes it. Suggestions come from the tags already in the library."""
    changed = Signal()

    def __init__(self, suggestions: Sequence[str] = (), parent=None):
        super().__init__(parent)
        self.setObjectName("TagInput")
        self.setStyleSheet(f"QFrame#TagInput {{ background: #111112; border: 1px solid {theme.LINE_2}; border-radius: 7px; }}"
                           f"QFrame#TagInput[focus=\"true\"] {{ border-color: #4a4a50; }}")
        self.setMinimumHeight(34)
        self._tags: list[str] = []
        self.flow = FlowLayout(self, spacing=5)
        self.flow.setContentsMargins(5, 4, 5, 4)
        self.edit = QLineEdit()
        self.edit.setProperty("role", "search")
        self.edit.setPlaceholderText("Add a tag…")
        self.edit.setMinimumWidth(90)
        self.edit.setFixedHeight(24)
        self.edit.installEventFilter(self)
        self.edit.returnPressed.connect(self._commit)
        self.edit.textEdited.connect(self._typed)
        self.flow.addWidget(self.edit)
        self.set_suggestions(suggestions)

    def set_suggestions(self, words: Sequence[str]) -> None:
        from PySide6.QtWidgets import QCompleter
        c = QCompleter(sorted(set(words)), self)
        c.setCaseSensitivity(Qt.CaseSensitivity.CaseInsensitive)
        c.setFilterMode(Qt.MatchFlag.MatchContains)
        c.activated.connect(lambda t: (self.edit.setText(t), self._commit()))
        self.edit.setCompleter(c)

    def tags(self) -> list[str]:
        pending = self._clean(self.edit.text())
        return self._tags + ([pending] if pending and pending not in self._tags else [])

    def setTags(self, tags: Sequence[str]) -> None:
        self._tags = []
        self._rebuild()
        for t in tags:
            self._add(t, notify=False)
        self.edit.clear()

    @staticmethod
    def _clean(t: str) -> str:
        return " ".join(t.replace(",", " ").lower().split())[:40]

    def _typed(self, text: str) -> None:
        if "," in text:
            for part in text.split(",")[:-1]:
                self._add(part)
            self.edit.setText(text.split(",")[-1].lstrip())

    def _commit(self) -> None:
        if self.edit.text().strip():
            self._add(self.edit.text())
            self.edit.clear()

    def _add(self, t: str, notify: bool = True) -> None:
        t = self._clean(t)
        if not t or t in self._tags or len(self._tags) >= 24:
            return
        self._tags.append(t)
        self._rebuild()
        if notify:
            self.changed.emit()

    def _remove(self, t: str) -> None:
        if t in self._tags:
            self._tags.remove(t)
            self._rebuild()
            self.changed.emit()

    def _rebuild(self) -> None:
        # chips first, the text field last (kept, so focus and typing survive)
        while self.flow.count():
            it = self.flow.takeAt(0)
            w = it.widget()
            if w is not None and w is not self.edit:
                w.hide()
                w.setParent(None)
                w.deleteLater()
        for t in self._tags:
            chip = TagChip(t)
            chip.removed.connect(self._remove)
            self.flow.addWidget(chip)
            chip.show()
        self.flow.addWidget(self.edit)
        self.updateGeometry()

    def eventFilter(self, obj, e):
        if obj is self.edit:
            if e.type() == e.Type.KeyPress:
                if e.key() == Qt.Key.Key_Backspace and not self.edit.text() and self._tags:
                    self._remove(self._tags[-1])
                    return True
                if e.key() == Qt.Key.Key_Tab and self.edit.text().strip():
                    self._commit()
                    return True
            elif e.type() == e.Type.FocusIn:
                self.setProperty("focus", True)
                theme.restyle(self)
            elif e.type() == e.Type.FocusOut:
                self.setProperty("focus", False)
                theme.restyle(self)
                self._commit()
        return False

    def mousePressEvent(self, e):
        self.edit.setFocus()


class CategoryPicker(QComboBox):
    """The library's categories, plus 'New category…' at the end (asks for a name and selects it)."""
    picked = Signal(str)
    NEW = "\u0000new"

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(32)
        self._last = ""
        self.activated.connect(self._activated)

    def set_categories(self, names: Sequence[str], current: str = "") -> None:
        self.blockSignals(True)
        self.clear()
        for n in names:
            self.addItem(n, n)
        if current and self.findData(current) < 0:
            self.addItem(current, current)
        self.insertSeparator(self.count())
        self.addItem(icons.icon("plus-folder"), "New category…", self.NEW)
        self.setValue(current or (names[0] if names else ""))
        self.blockSignals(False)

    def value(self) -> str:
        v = self.currentData()
        return "" if v == self.NEW else (v or "")

    def setValue(self, name: str) -> None:
        i = self.findData(name)
        if i < 0 and name:
            self.insertItem(max(0, self.count() - 2), name, name)
            i = self.findData(name)
        if i >= 0:
            self.setCurrentIndex(i)
            self._last = name

    def _activated(self, index: int) -> None:
        if self.itemData(index) != self.NEW:
            self._last = self.value()
            self.picked.emit(self._last)
            return
        from .dialogs import prompt
        name = prompt(self.window(), "New category", "A category is a folder inside Materials.", "", "Create")
        if name:
            from ..library.paths import safe_name
            name = safe_name(name, "")
        if name:
            self.setValue(name)
            self._last = name
            self.picked.emit(name)
        else:
            self.setValue(self._last)


# ------------------------------------------------------------------ colour swatches (folder colours)
FOLDER_COLOURS = ["#3b6fd8", "#5a7bd0", "#3aa6a6", "#5f9a45", "#7d8b3a", "#d9c24a",
                  "#d96b3b", "#b07a45", "#c4566e", "#8e5cd9", "#9aa3ad", "#6b6b70"]


class SwatchPicker(QWidget):
    """A grid of colour swatches with 'Custom…' and 'Default'. picked(colour) — '' means the default colour."""
    picked = Signal(str)

    COLS = 6
    SIZE = 22
    GAP = 8

    def __init__(self, current: str | None = None, parent=None):
        super().__init__(parent)
        self.current = (current or "").lower()
        self.hover = -1
        self.setMouseTracking(True)
        rows = -(-len(FOLDER_COLOURS) // self.COLS)
        w = self.COLS * self.SIZE + (self.COLS - 1) * self.GAP + 24
        self.grid_h = rows * self.SIZE + (rows - 1) * self.GAP
        lay = QVBoxLayout(self)
        lay.setContentsMargins(12, 12 + self.grid_h + 12, 12, 8)
        lay.setSpacing(6)
        row = QHBoxLayout()
        row.setSpacing(6)
        self.b_custom = button("Custom…", "palette", "ghost")
        self.b_custom.setFixedHeight(28)
        self.b_custom.setStyleSheet("QPushButton { min-height: 26px; padding: 0 8px; font-size: 12px; font-weight: 400; }")
        self.b_custom.clicked.connect(self._custom)
        self.b_default = button("Default", "restore", "ghost")
        self.b_default.setFixedHeight(28)
        self.b_default.setStyleSheet(self.b_custom.styleSheet())
        self.b_default.clicked.connect(lambda: self.picked.emit(""))
        row.addWidget(self.b_custom)
        row.addStretch(1)
        row.addWidget(self.b_default)
        lay.addLayout(row)
        self.setFixedWidth(w)

    def _rect(self, i: int) -> QRectF:
        r, c = divmod(i, self.COLS)
        return QRectF(12 + c * (self.SIZE + self.GAP), 12 + r * (self.SIZE + self.GAP), self.SIZE, self.SIZE)

    def _at(self, pos) -> int:
        for i in range(len(FOLDER_COLOURS)):
            if self._rect(i).adjusted(-3, -3, 3, 3).contains(pos):
                return i
        return -1

    def mouseMoveEvent(self, e):
        i = self._at(e.position())
        if i != self.hover:
            self.hover = i
            self.setCursor(Qt.CursorShape.PointingHandCursor if i >= 0 else Qt.CursorShape.ArrowCursor)
            self.update()

    def leaveEvent(self, e):
        self.hover = -1
        self.update()

    def mouseReleaseEvent(self, e):
        i = self._at(e.position())
        if i >= 0 and e.button() == Qt.MouseButton.LeftButton:
            self.picked.emit(FOLDER_COLOURS[i])

    def _custom(self):
        from PySide6.QtWidgets import QColorDialog
        c = QColorDialog.getColor(QColor(self.current or FOLDER_COLOURS[0]), self.window(), "Folder colour")
        if c.isValid():
            self.picked.emit(c.name())

    def paintEvent(self, e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        for i, col in enumerate(FOLDER_COLOURS):
            r = self._rect(i)
            if col.lower() == self.current or i == self.hover:
                p.setPen(QPen(QColor(theme.TEXT if col.lower() == self.current else "#6a6a70"), 1.5))
                p.setBrush(Qt.BrushStyle.NoBrush)
                p.drawRoundedRect(r.adjusted(-3, -3, 3, 3), 8, 8)
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(QColor(col))
            p.drawRoundedRect(r, 6, 6)
        p.end()
