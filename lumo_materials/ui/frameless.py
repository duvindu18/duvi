"""Borderless top-level window that still behaves like a Windows window.

Windows: the native caption/frame styles stay on (so Aero Snap, Win+Arrow, minimise/maximise animations, the
system menu and the drop shadow keep working), WM_NCCALCSIZE makes the whole window client area, and
WM_NCHITTEST tells Windows where the resize edges and the drag regions are. Windows 11 gets rounded corners.
Other systems: Qt's startSystemMove / startSystemResize.

Mark any widget as a drag region with  widget.setProperty("dragArea", True).  Buttons, inputs and lists inside
a drag region stay clickable.
"""
from __future__ import annotations

import ctypes
import sys

from PySide6.QtCore import QEvent, QPoint, Qt
from PySide6.QtGui import QCursor, QMouseEvent
from PySide6.QtWidgets import (QAbstractButton, QAbstractItemView, QAbstractSlider, QAbstractSpinBox, QApplication,
                               QComboBox, QLineEdit, QPlainTextEdit, QTextEdit, QWidget)

IS_WIN = sys.platform == "win32"
BORDER = 6  # logical px of the invisible resize edge

if IS_WIN:
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    dwmapi = ctypes.windll.dwmapi

    GWL_STYLE = -16
    WS_CAPTION = 0x00C00000
    WS_THICKFRAME = 0x00040000
    WS_MINIMIZEBOX = 0x00020000
    WS_MAXIMIZEBOX = 0x00010000
    WS_SYSMENU = 0x00080000
    WM_NCCALCSIZE = 0x0083
    WM_NCHITTEST = 0x0084
    SM_CXSIZEFRAME, SM_CYSIZEFRAME, SM_CXPADDEDBORDER = 32, 33, 92
    HTCLIENT, HTCAPTION = 1, 2
    HTLEFT, HTRIGHT, HTTOP, HTTOPLEFT, HTTOPRIGHT, HTBOTTOM, HTBOTTOMLEFT, HTBOTTOMRIGHT = 10, 11, 12, 13, 14, 15, 16, 17
    SWP_FRAMECHANGED, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_NOOWNERZORDER = 0x20, 0x2, 0x1, 0x4, 0x200

    class MARGINS(ctypes.Structure):
        _fields_ = [("cxLeftWidth", ctypes.c_int), ("cxRightWidth", ctypes.c_int),
                    ("cyTopHeight", ctypes.c_int), ("cyBottomHeight", ctypes.c_int)]

    class NCCALCSIZE_PARAMS(ctypes.Structure):
        _fields_ = [("rgrc", wintypes.RECT * 3), ("lppos", ctypes.c_void_p)]

    _GetWindowLong = getattr(user32, "GetWindowLongPtrW", user32.GetWindowLongW)
    _SetWindowLong = getattr(user32, "SetWindowLongPtrW", user32.SetWindowLongW)
    _GetWindowLong.restype = ctypes.c_ssize_t
    _GetWindowLong.argtypes = [wintypes.HWND, ctypes.c_int]
    _SetWindowLong.restype = ctypes.c_ssize_t
    _SetWindowLong.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_ssize_t]


_INTERACTIVE = (QAbstractButton, QLineEdit, QComboBox, QAbstractSlider, QAbstractSpinBox, QAbstractItemView,
                QTextEdit, QPlainTextEdit)


def _is_interactive(w: QWidget) -> bool:
    return isinstance(w, _INTERACTIVE) or bool(w.property("interactive"))


class FramelessWindow(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowFlags(Qt.WindowType.Window | Qt.WindowType.FramelessWindowHint |
                            Qt.WindowType.WindowMinMaxButtonsHint | Qt.WindowType.WindowSystemMenuHint)
        self.setAttribute(Qt.WidgetAttribute.WA_DontCreateNativeAncestors)
        self.setMouseTracking(True)
        self._native_ready = False
        if not IS_WIN:
            QApplication.instance().installEventFilter(self)

    # ---------------------------------------------------------------- drag-region test
    def is_drag_area(self, local: QPoint) -> bool:
        w = self.childAt(local)
        if w is None:
            return False
        node = w
        while node is not None and node is not self:
            if _is_interactive(node):
                return False
            if node.property("dragArea"):
                return True
            node = node.parentWidget()
        return False

    def _edges(self, local: QPoint) -> Qt.Edge | None:
        if self.isMaximized() or self.isFullScreen():
            return None
        x, y, w, h = local.x(), local.y(), self.width(), self.height()
        e = Qt.Edge(0)
        if x < BORDER:
            e |= Qt.Edge.LeftEdge
        elif x >= w - BORDER:
            e |= Qt.Edge.RightEdge
        if y < BORDER:
            e |= Qt.Edge.TopEdge
        elif y >= h - BORDER:
            e |= Qt.Edge.BottomEdge
        return e if e != Qt.Edge(0) else None

    def toggle_maximized(self) -> None:
        if self.isMaximized():
            self.showNormal()
        else:
            self.showMaximized()

    # ---------------------------------------------------------------- Windows
    def showEvent(self, event):
        super().showEvent(event)
        if IS_WIN and not self._native_ready:
            self._native_ready = True
            self._setup_native()

    def _setup_native(self) -> None:
        hwnd = int(self.winId())
        style = _GetWindowLong(hwnd, GWL_STYLE)
        _SetWindowLong(hwnd, GWL_STYLE, style | WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU)
        try:
            dwmapi.DwmExtendFrameIntoClientArea(hwnd, ctypes.byref(MARGINS(1, 1, 1, 1)))   # drop shadow
            dark = ctypes.c_int(1)
            dwmapi.DwmSetWindowAttribute(hwnd, 20, ctypes.byref(dark), ctypes.sizeof(dark))   # dark system menu
            corner = ctypes.c_int(2)                                                          # DWMWCP_ROUND (Win 11)
            dwmapi.DwmSetWindowAttribute(hwnd, 33, ctypes.byref(corner), ctypes.sizeof(corner))
            border = ctypes.c_uint(0x00262424)                                                # DWMWA_BORDER_COLOR
            dwmapi.DwmSetWindowAttribute(hwnd, 34, ctypes.byref(border), ctypes.sizeof(border))
        except OSError:
            pass
        user32.SetWindowPos(hwnd, None, 0, 0, 0, 0,
                            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER)

    def nativeEvent(self, event_type, message):
        if not IS_WIN or bytes(event_type) != b"windows_generic_MSG":
            return super().nativeEvent(event_type, message)
        msg = wintypes.MSG.from_address(int(message))
        if msg.message == WM_NCCALCSIZE and msg.wParam:
            if user32.IsZoomed(msg.hWnd):
                # maximised windows overhang the screen by the frame size: pull the client area back in
                params = ctypes.cast(msg.lParam, ctypes.POINTER(NCCALCSIZE_PARAMS)).contents
                bx = user32.GetSystemMetrics(SM_CXSIZEFRAME) + user32.GetSystemMetrics(SM_CXPADDEDBORDER)
                by = user32.GetSystemMetrics(SM_CYSIZEFRAME) + user32.GetSystemMetrics(SM_CXPADDEDBORDER)
                r = params.rgrc[0]
                r.left += bx
                r.top += by
                r.right -= bx
                r.bottom -= by
            return True, 0
        if msg.message == WM_NCHITTEST:
            local = self.mapFromGlobal(QCursor.pos())
            e = self._edges(local)
            if e is not None:
                l, r = bool(e & Qt.Edge.LeftEdge), bool(e & Qt.Edge.RightEdge)
                t, b = bool(e & Qt.Edge.TopEdge), bool(e & Qt.Edge.BottomEdge)
                code = (HTTOPLEFT if t and l else HTTOPRIGHT if t and r else HTBOTTOMLEFT if b and l else
                        HTBOTTOMRIGHT if b and r else HTLEFT if l else HTRIGHT if r else HTTOP if t else HTBOTTOM)
                return True, code
            if self.is_drag_area(local):
                return True, HTCAPTION
            return True, HTCLIENT
        return super().nativeEvent(event_type, message)

    # ---------------------------------------------------------------- other systems
    def eventFilter(self, obj, event):
        if IS_WIN or not isinstance(obj, QWidget) or obj.window() is not self:
            return False
        et = event.type()
        if et == QEvent.Type.MouseMove and isinstance(event, QMouseEvent) and not event.buttons():
            e = self._edges(self.mapFromGlobal(event.globalPosition().toPoint()))
            if e is None:
                if self.testAttribute(Qt.WidgetAttribute.WA_SetCursor) and getattr(self, "_edge_cursor", False):
                    self.unsetCursor()
                    self._edge_cursor = False
            else:
                horiz = bool(e & (Qt.Edge.LeftEdge | Qt.Edge.RightEdge))
                vert = bool(e & (Qt.Edge.TopEdge | Qt.Edge.BottomEdge))
                diag_main = e in (Qt.Edge.LeftEdge | Qt.Edge.TopEdge, Qt.Edge.RightEdge | Qt.Edge.BottomEdge)
                shape = (Qt.CursorShape.SizeFDiagCursor if horiz and vert and diag_main else
                         Qt.CursorShape.SizeBDiagCursor if horiz and vert else
                         Qt.CursorShape.SizeHorCursor if horiz else Qt.CursorShape.SizeVerCursor)
                self.setCursor(shape)
                self._edge_cursor = True
        elif et == QEvent.Type.MouseButtonPress and isinstance(event, QMouseEvent) \
                and event.button() == Qt.MouseButton.LeftButton:
            local = self.mapFromGlobal(event.globalPosition().toPoint())
            e = self._edges(local)
            handle = self.windowHandle()
            if e is not None and handle:
                handle.startSystemResize(e)
                return True
            if self.is_drag_area(local) and handle:
                handle.startSystemMove()
                return True
        elif et == QEvent.Type.MouseButtonDblClick and isinstance(event, QMouseEvent):
            if self.is_drag_area(self.mapFromGlobal(event.globalPosition().toPoint())):
                self.toggle_maximized()
                return True
        return False
