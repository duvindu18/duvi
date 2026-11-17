"""Thin ctypes wrappers over the Win32 calls the saver needs (Windows only)."""
from __future__ import annotations

import ctypes
import time
from ctypes import wintypes
from dataclasses import dataclass

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

HWND = wintypes.HWND
_ENUM_PROC = ctypes.WINFUNCTYPE(wintypes.BOOL, HWND, wintypes.LPARAM)

for name, args, res in [
    ("EnumWindows", [_ENUM_PROC, wintypes.LPARAM], wintypes.BOOL),
    ("IsWindowVisible", [HWND], wintypes.BOOL),
    ("IsWindowEnabled", [HWND], wintypes.BOOL),
    ("IsWindow", [HWND], wintypes.BOOL),
    ("IsIconic", [HWND], wintypes.BOOL),
    ("IsHungAppWindow", [HWND], wintypes.BOOL),
    ("GetWindowTextLengthW", [HWND], ctypes.c_int),
    ("GetWindowTextW", [HWND, wintypes.LPWSTR, ctypes.c_int], ctypes.c_int),
    ("GetClassNameW", [HWND, wintypes.LPWSTR, ctypes.c_int], ctypes.c_int),
    ("GetWindowThreadProcessId", [HWND, ctypes.POINTER(wintypes.DWORD)], wintypes.DWORD),
    ("GetWindow", [HWND, wintypes.UINT], HWND),
    ("GetForegroundWindow", [], HWND),
    ("SetForegroundWindow", [HWND], wintypes.BOOL),
    ("BringWindowToTop", [HWND], wintypes.BOOL),
    ("ShowWindow", [HWND, ctypes.c_int], wintypes.BOOL),
    ("AttachThreadInput", [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL], wintypes.BOOL),
    ("PostMessageW", [HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM], wintypes.BOOL),
    ("keybd_event", [ctypes.c_ubyte, ctypes.c_ubyte, wintypes.DWORD, ctypes.c_size_t], None),
    ("GetAsyncKeyState", [ctypes.c_int], ctypes.c_short),
    ("GetLastInputInfo", [ctypes.c_void_p], wintypes.BOOL),
]:
    fn = getattr(user32, name)
    fn.argtypes, fn.restype = args, res

GW_OWNER = 4
SW_RESTORE, SW_MINIMIZE = 9, 6
KEYEVENTF_KEYUP = 0x0002
WM_CLOSE = 0x0010


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]


@dataclass(frozen=True)
class Window:
    hwnd: int
    title: str
    cls: str
    pid: int
    owned: bool     # has an owner window -> dialog/tool window, not a document
    enabled: bool   # disabled = a modal dialog is open on top of it


def list_windows() -> list[Window]:
    out: list[Window] = []

    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        cls = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls, 256)
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        out.append(Window(int(hwnd), buf.value, cls.value, pid.value,
                          bool(user32.GetWindow(hwnd, GW_OWNER)),
                          bool(user32.IsWindowEnabled(hwnd))))
        return True

    user32.EnumWindows(_ENUM_PROC(cb), 0)
    return out


def exists(hwnd: int) -> bool:
    return bool(user32.IsWindow(hwnd)) and bool(user32.IsWindowVisible(hwnd))


def is_hung(hwnd: int) -> bool:
    return bool(user32.IsHungAppWindow(hwnd))


def is_minimized(hwnd: int) -> bool:
    return bool(user32.IsIconic(hwnd))


def foreground() -> int:
    return int(user32.GetForegroundWindow() or 0)


def focus(hwnd: int, timeout: float = 2.0) -> bool:
    """Bring `hwnd` to the foreground, working around Windows' focus-steal guard."""
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, SW_RESTORE)
    fg = user32.GetForegroundWindow()
    fg_thread = user32.GetWindowThreadProcessId(fg, None) if fg else 0
    me = kernel32.GetCurrentThreadId()
    attached = bool(fg_thread and fg_thread != me and user32.AttachThreadInput(me, fg_thread, True))
    try:
        user32.BringWindowToTop(hwnd)
        ok = user32.SetForegroundWindow(hwnd)
        if not ok:  # a synthetic (no-op) key event lifts the foreground lock
            user32.keybd_event(0, 0, 0, 0)
            user32.keybd_event(0, 0, KEYEVENTF_KEYUP, 0)
            user32.SetForegroundWindow(hwnd)
    finally:
        if attached:
            user32.AttachThreadInput(me, fg_thread, False)
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if foreground() == hwnd:
            return True
        time.sleep(0.05)
    return False


def minimize(hwnd: int) -> None:
    user32.ShowWindow(hwnd, SW_MINIMIZE)


def release_modifiers() -> None:
    """Make sure no modifier is logically held before we type."""
    for vk in (0x10, 0x11, 0x12, 0x5B):
        if user32.GetAsyncKeyState(vk) & 0x8000:
            user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)


def press(codes: list[int], hold: float = 0.03) -> None:
    """Press a combo: all keys down in order, then up in reverse."""
    for vk in codes:
        user32.keybd_event(vk, 0, 0, 0)
        time.sleep(hold)
    for vk in reversed(codes):
        user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)
        time.sleep(hold)


def close(hwnd: int) -> None:
    user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)


def idle_seconds() -> float:
    info = LASTINPUTINFO(ctypes.sizeof(LASTINPUTINFO), 0)
    if not user32.GetLastInputInfo(ctypes.byref(info)):
        return 0.0
    return ((kernel32.GetTickCount() - info.dwTime) & 0xFFFFFFFF) / 1000.0
