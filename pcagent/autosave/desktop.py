"""Real Windows desktop for the Saver (win32 + psutil)."""
from __future__ import annotations

import psutil

from . import winapi


class WindowsDesktop:
    list_windows = staticmethod(winapi.list_windows)
    exists = staticmethod(winapi.exists)
    is_hung = staticmethod(winapi.is_hung)
    is_minimized = staticmethod(winapi.is_minimized)
    foreground = staticmethod(winapi.foreground)
    focus = staticmethod(winapi.focus)
    minimize = staticmethod(winapi.minimize)
    release_modifiers = staticmethod(winapi.release_modifiers)
    press = staticmethod(winapi.press)
    close = staticmethod(winapi.close)
    idle_seconds = staticmethod(winapi.idle_seconds)

    @staticmethod
    def exe_name(pid: int) -> str | None:
        try:
            return psutil.Process(pid).name()
        except (psutil.Error, OSError):
            return None

    @staticmethod
    def open_files(pid: int) -> list[str]:
        try:
            return [f.path for f in psutil.Process(pid).open_files()]
        except (psutil.Error, OSError):
            return []
