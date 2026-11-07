"""Shared application state: settings, the open library, drafts, the background runner and notifications."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Callable

from PySide6.QtCore import QObject, QUrl, Signal
from PySide6.QtGui import QDesktopServices

from ..library.drafts import DraftStore
from ..library.settings import Settings
from ..library.store import Library, LibraryError, prepare_folder
from .workers import Runner


def app_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[2]


class Hub(QObject):
    libraryOpened = Signal()
    changed = Signal()                 # materials, categories or trash changed
    materialSaved = Signal(str)        # id of a created / replaced material
    draftsChanged = Signal()
    navigate = Signal(str)             # page name

    def __init__(self, settings: Settings | None = None):
        super().__init__()
        self.settings = settings or Settings()
        self.library: Library | None = None
        self.drafts = DraftStore(self.settings.drafts_dir)
        self.runner = Runner(self)
        self._notify: Callable[..., None] = lambda *a, **k: None
        self.gpu_note = ""

    # ------------------------------------------------------------------ library
    def open_library(self, folder: str | os.PathLike, remember: bool = True) -> Library:
        lib = prepare_folder(folder, app_dir())
        self.library = lib
        if remember and not self.settings.library_pinned:
            self.settings.set("library_dir", str(lib.root))
        self.libraryOpened.emit()
        self.changed.emit()
        return lib

    def try_open_saved(self) -> bool:
        p = self.settings.get("library_dir")
        if not p:
            return False
        try:
            self.open_library(p, remember=False)
            return True
        except (LibraryError, OSError):
            return False

    def rescan(self) -> int:
        if not self.library:
            return 0
        n = self.library.rescan()
        self.changed.emit()
        return n

    # ------------------------------------------------------------------ messages
    def set_notifier(self, fn: Callable[..., None]) -> None:
        self._notify = fn

    def notify(self, text: str, kind: str = "info", action: str | None = None, on_action: Callable | None = None):
        self._notify(text, kind, action, on_action)

    def error(self, text: str) -> None:
        self.notify(text, "error")


def reveal(path: str | os.PathLike) -> None:
    """Shows a file or folder in Explorer (selected), or opens the folder elsewhere."""
    p = Path(path)
    if sys.platform == "win32":
        if p.is_file():
            subprocess.Popen(["explorer", "/select,", str(p)])
        else:
            os.startfile(str(p))  # type: ignore[attr-defined]
    else:
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(p if p.is_dir() else p.parent)))
