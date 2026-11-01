"""Shared application state handed to every page."""

from __future__ import annotations

import logging
from pathlib import Path

from PySide6.QtCore import QObject, QTimer, Signal

from app.core.config import AppConfig, Policy
from app.core.edits import EditStore, FaceEdit
from app.core.face_db import FaceDatabase
from app.gui.sounds import Sounds
from app.utils.paths import config_dir

log = logging.getLogger(__name__)


class AppContext(QObject):
    """Owns the live configuration and the face database.

    ``configChanged`` fires after every edit so running pipelines can hot-apply
    settings; ``notify`` routes user-facing messages to the window banner.
    """

    configChanged = Signal()
    facesChanged = Signal()
    notify = Signal(str, str)  # message, level (info | warn | error)
    editsChanged = Signal(str)  # source whose manual blur fixes changed

    def __init__(self, cfg: AppConfig) -> None:
        super().__init__()
        self.cfg = cfg
        # Identity-based policies were removed from the UI: every face is hidden
        # (or anonymization is off), so recognition is never needed.
        cfg.recognition.enabled = False
        if cfg.anonymize.policy != Policy.NONE:
            cfg.anonymize.policy = Policy.ALL
        self.face_db = FaceDatabase(cfg.recognition.faces_dir)
        self.sounds = Sounds(cfg.sounds, parent=self)
        self.edit_store = EditStore(config_dir() / "edits.json")
        self._session_edits: dict[str, list[FaceEdit]] = {}  # live sources: this session only
        # Slider drags produce dozens of edits per second; persist them lazily.
        self._save_timer = QTimer(self)
        self._save_timer.setSingleShot(True)
        self._save_timer.setInterval(600)
        self._save_timer.timeout.connect(self.save_now)

    def commit(self) -> None:
        """Publish an edit immediately and schedule a debounced save."""
        self.sounds.enabled = self.cfg.sounds
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

    # ---- manual blur fixes ------------------------------------------------------
    @staticmethod
    def _persistent(source: str) -> bool:
        return Path(source).is_file()

    def edits(self, source: str) -> list[FaceEdit]:
        if self._persistent(source):
            return self.edit_store.get(source)
        return list(self._session_edits.get(source, []))

    def _store(self, source: str, edits: list[FaceEdit]) -> None:
        if self._persistent(source):
            self.edit_store.set(source, edits)
        else:
            self._session_edits[source] = edits
        self.editsChanged.emit(source)

    def add_edits(self, source: str, new: list[FaceEdit]) -> None:
        current = self.edits(source)
        group = max((e.group for e in current), default=0) + 1  # one gesture = one undo step
        for e in new:
            e.group = group
        self._store(source, current + new)

    def undo_edit(self, source: str) -> bool:
        edits = self.edits(source)
        if not edits:
            return False
        last = edits[-1].group
        self._store(source, [e for e in edits if e.group != last])
        return True

    def clear_edits(self, source: str) -> int:
        n = len(self.edits(source))
        self._store(source, [])
        return n

    def fix_count(self, source: str) -> int:
        return len({e.group for e in self.edits(source)})
