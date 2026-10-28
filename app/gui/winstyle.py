"""Windows 11 native touches: dark, ember-tinted title bar and taskbar identity.

Every call is guarded - on Windows 10 or other platforms these are no-ops.
"""

from __future__ import annotations

import ctypes
import logging
import sys

log = logging.getLogger(__name__)

DWMWA_USE_IMMERSIVE_DARK_MODE = 20
DWMWA_WINDOW_CORNER_PREFERENCE = 33
DWMWA_BORDER_COLOR = 34
DWMWA_CAPTION_COLOR = 35
DWMWA_TEXT_COLOR = 36
DWMWCP_ROUND = 2


def _colorref(hex_rgb: str) -> int:
    hex_rgb = hex_rgb.lstrip("#")
    r, g, b = int(hex_rgb[0:2], 16), int(hex_rgb[2:4], 16), int(hex_rgb[4:6], 16)
    return r | (g << 8) | (b << 16)


def set_app_user_model_id(app_id: str = "Veil.FaceAnonymizer.1") -> None:
    """Separate taskbar grouping/icon from python.exe."""
    if sys.platform != "win32":
        return
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(app_id)  # type: ignore[attr-defined]
    except Exception as exc:  # pragma: no cover - Windows only
        log.debug("AppUserModelID not set: %s", exc)


def style_window(win_id: int, caption: str = "#5A170A", text: str = "#FFFFFF") -> None:
    if sys.platform != "win32":
        return
    try:
        dwm = ctypes.windll.dwmapi  # type: ignore[attr-defined]
        hwnd = ctypes.c_void_p(int(win_id))

        def set_attr(attr: int, value: int) -> None:
            v = ctypes.c_int(value)
            dwm.DwmSetWindowAttribute(hwnd, ctypes.c_uint(attr), ctypes.byref(v), ctypes.sizeof(v))

        set_attr(DWMWA_USE_IMMERSIVE_DARK_MODE, 1)
        set_attr(DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND)
        set_attr(DWMWA_CAPTION_COLOR, _colorref(caption))  # Windows 11 22000+
        set_attr(DWMWA_BORDER_COLOR, _colorref(caption))
        set_attr(DWMWA_TEXT_COLOR, _colorref(text))
    except Exception as exc:  # pragma: no cover - Windows only
        log.debug("DWM styling unavailable: %s", exc)
