"""Shared application state handed to every page."""

from __future__ import annotations

import logging
from pathlib import Path

from PySide6.QtCore import QObject, QTimer, Signal

from app.core.config import AppConfig
from app.core.face_db import FaceDatabase

log = logging.getLogger(__name__)


class AppContext(QObject):
    """Owns the live configuration and the face database.

    ``configChanged`` fires after every edit so running pipelines can hot-apply
    settings; ``notify`` routes user-facing messages to the window banner.
    """

    configChanged = Signal()
    facesChanged = Signal()
    notify = Signal(str, str)  # message, level (info | warn | error)

    def __init__(self, cfg: AppConfig) -> None:
        super().__init__()
        self.cfg = cfg
        self.face_db = FaceDatabase(cfg.recognition.faces_dir)
        # Slider drags produce dozens of edits per second; persist them lazily.
        self._save_timer = QTimer(self)
        self._save_timer.setSingleShot(True)
        self._save_timer.setInterval(600)
        self._save_timer.timeout.connect(self.save_now)

    def commit(self) -> None:
        """Publish an edit immediately and schedule a debounced save."""
        self.configChanged.emit()
        self._save_timer.start()

    def save_now(self) -> None:
        self._save_timer.stop()
        try:
            self.cfg.save()
        except OSError as exc:
            log.warning("Could not save config: %s", exc)
            self.notify.emit(f"Settings could not be saved: {exc}", "warn")

    def set_faces_dir(self, path: str) -> None:
        if Path(path) == self.face_db.root:
            return
        self.cfg.recognition.faces_dir = path
        self.face_db = FaceDatabase(path)
        self.commit()
        self.facesChanged.emit()
