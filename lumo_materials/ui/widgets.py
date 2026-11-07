"""Reusable widgets in the flat dark style."""
from __future__ import annotations

import math
from typing import Callable, Sequence

from PySide6.QtCore import QEasingCurve, QPointF, QPropertyAnimation, QRectF, QSize, Qt, QTimer, Signal
from PySide6.QtGui import QColor, QFont, QFontMetrics, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import (QAbstractButton, QButtonGroup, QFrame, QGraphicsOpacityEffect, QHBoxLayout, QLabel,
                               QLineEdit, QMenu, QPushButton, QSizePolicy, QVBoxLayout, QWidget)

from . import icons, theme
from ..viewmodel import page_window


# ------------------------------------------------------------------ small helpers
def label(text: str = "", role: str | None = None, wrap: bool = False) -> QLabel:
    lb = QLabel(text)
    if role:
        lb.setProperty("role", role)
    lb.setWordWrap(wrap)
    return lb


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
        self.setToolTip(f"{text}: drag, scroll or use the arrow keys. Double-click resets to "
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
        steps = e.angleDelta().y() / 120.0
        if steps:
            mult = 10 if e.modifiers() & Qt.KeyboardModifier.ShiftModifier else 1
            self.setValue(self._value + steps * self.step * mult, emit=True)
        e.accept()

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
        self._cycle(-1 if e.angleDelta().y() > 0 else 1)
        e.accept()

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
    changed = Signal(str)

    def __init__(self, options: Sequence[tuple[str, str]], value: str, parent=None, icon_only: bool = False):
        super().__init__(parent)
        self.setStyleSheet(f"Segmented {{ border: 1px solid {theme.LINE_2}; border-radius: 6px; background: transparent; }}")
        lay = QHBoxLayout(self)
        lay.setContentsMargins(1, 1, 1, 1)
        lay.setSpacing(0)
        self.group = QButtonGroup(self)
        self.group.setExclusive(True)
        self.buttons: dict[str, QPushButton] = {}
        for key, text in options:
            if icon_only:
                b = button("", icon=text, kind="seg", checkable=True)
                b.setFixedWidth(30)
            else:
                b = button(text, kind="seg", checkable=True)
            self.group.addButton(b)
            self.buttons[key] = b
            lay.addWidget(b)
            b.clicked.connect(lambda _=False, k=key: self.changed.emit(k))
        self.setValue(value)

    def setValue(self, key: str) -> None:
        if key in self.buttons:
            self.buttons[key].setChecked(True)

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
        lay.setContentsMargins(10, 0, 6, 0)
        lay.setSpacing(8)
        ic = QLabel()
        ic.setPixmap(icons.pixmap("search", theme.MUTED))
        lay.addWidget(ic)
        self.edit = QLineEdit()
        self.edit.setProperty("role", "search")
        self.edit.setPlaceholderText(placeholder)
        self.edit.setClearButtonEnabled(True)
        lay.addWidget(self.edit, 1)
        self.kbd = label("/", "kbd")
        lay.addWidget(self.kbd)
        self._t = QTimer(self, singleShot=True, interval=180)
        self._t.timeout.connect(lambda: self.textChanged.emit(self.edit.text()))
        self.edit.textChanged.connect(lambda _: self._t.start())

    def text(self) -> str:
        return self.edit.text()

    def focus(self) -> None:
        self.edit.setFocus()
        self.edit.selectAll()


# ------------------------------------------------------------------ toast
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
        self.move((par.width() - self.width()) // 2, par.height() - self.height() - 24)
        self.raise_()
        self.show()
        self.anim.stop()
        self.anim.setStartValue(0.0)
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
