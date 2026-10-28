"""Identity manager: people in the faces folder, their photos and their role
(always visible / neutral / always hidden)."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import cv2
from PySide6.QtCore import QRectF, QSize, Qt, Signal
from PySide6.QtGui import QColor, QImage, QPainter, QPainterPath, QPen, QPixmap
from PySide6.QtWidgets import (
    QFileDialog,
    QHBoxLayout,
    QInputDialog,
    QMessageBox,
    QProgressBar,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from app.core.engine import FaceEngine
from app.core.face_db import PersonInfo
from app.gui.bridge import PipelineController, RunState
from app.gui.context import AppContext
from app.gui.icons import make_icon
from app.gui.tasks import run_task
from app.gui.theme import P
from app.gui.widgets import CircleButton, FlowLayout, GlassCard, PillGroup, button, label, two_tone
from app.utils.imageio import IMAGE_EXTENSIONS, imread, is_image

ROLE_VISIBLE, ROLE_NEUTRAL, ROLE_HIDE = "visible", "neutral", "hide"


def _thumbnail(path: Path | None, size: int) -> QPixmap | None:
    if path is None:
        return None
    img = imread(path)
    if img is None:
        return None
    h, w = img.shape[:2]
    side = min(h, w)
    y0, x0 = (h - side) // 4, (w - side) // 2  # bias upwards: faces sit in the upper half
    img = cv2.resize(img[y0 : y0 + side, x0 : x0 + side], (size, size), interpolation=cv2.INTER_AREA)
    qimg = QImage(img.data, size, size, img.strides[0], QImage.Format.Format_BGR888).copy()
    return QPixmap.fromImage(qimg)


class Avatar(QWidget):
    def __init__(self, pixmap: QPixmap | None, name: str, size: int = 96) -> None:
        super().__init__()
        self._pm = pixmap
        self._initial = (name[:1] or "?").upper()
        self.setFixedSize(size, size)

    def paintEvent(self, _e) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        r = QRectF(self.rect()).adjusted(2, 2, -2, -2)
        path = QPainterPath()
        path.addEllipse(r)
        if self._pm is not None:
            p.setClipPath(path)
            p.drawPixmap(r.toRect(), self._pm)
            p.setClipping(False)
        else:
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(QColor(255, 255, 255, 40))
            p.drawEllipse(r)
            p.setPen(QColor("white"))
            f = p.font()
            f.setPointSizeF(self.height() / 4)
            p.setFont(f)
            p.drawText(r, Qt.AlignmentFlag.AlignCenter, self._initial)
        p.setPen(QPen(QColor(255, 255, 255, 120), 2))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawEllipse(r)


class PersonCard(GlassCard):
    roleChanged = Signal(str, str)
    addPhotos = Signal(str)
    openFolder = Signal(str)
    deleteRequested = Signal(str)
    renameRequested = Signal(str)

    def __init__(self, person: PersonInfo, role: str) -> None:
        super().__init__(padding=18)
        self.setFixedWidth(256)
        self.body.setAlignment(Qt.AlignmentFlag.AlignHCenter)
        self.body.addWidget(Avatar(_thumbnail(person.thumbnail, 192), person.name), 0, Qt.AlignmentFlag.AlignHCenter)
        name = label(person.name, "h2")
        name.setAlignment(Qt.AlignmentFlag.AlignHCenter)
        self.body.addWidget(name)
        ok = person.indexed_count
        stats = label(
            f"{person.image_count} photo{'s' if person.image_count != 1 else ''}  ·  {ok} indexed", "faint"
        )
        stats.setAlignment(Qt.AlignmentFlag.AlignHCenter)
        if person.image_count and ok < person.image_count:
            stats.setToolTip("Some photos have no detectable face or have not been indexed yet. Use Re-index.")
        self.body.addWidget(stats)
        roles = PillGroup(
            [(ROLE_VISIBLE, "Visible"), (ROLE_NEUTRAL, "Neutral"), (ROLE_HIDE, "Hide")],
            tooltips={
                ROLE_VISIBLE: "Whitelist: never anonymized under 'All but whitelist'",
                ROLE_NEUTRAL: "Treated as a known person",
                ROLE_HIDE: "Target: anonymized under 'Targets only'",
            },
        )
        roles.set_value(role)
        roles.changed.connect(lambda r: self.roleChanged.emit(person.name, r))
        self.body.addWidget(roles)
        actions = QHBoxLayout()
        actions.setSpacing(8)
        actions.addStretch(1)
        for icon, tip, sig in (
            ("plus", "Add photos", self.addPhotos),
            ("folder", "Open folder", self.openFolder),
            ("user", "Rename", self.renameRequested),
            ("trash", "Delete identity", self.deleteRequested),
        ):
            b = CircleButton(icon, 34, tooltip=tip)
            b.clicked.connect(lambda _=False, s=sig: s.emit(person.name))
            actions.addWidget(b)
        actions.addStretch(1)
        self.body.addLayout(actions)


class IdentitiesPage(QWidget):
    def __init__(self, ctx: AppContext, live: PipelineController, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.ctx = ctx
        self.live = live
        self._indexing = False

        root = QVBoxLayout(self)
        root.setContentsMargins(28, 22, 28, 24)
        root.setSpacing(14)
        root.addWidget(label(two_tone("Who should stay", "visible?"), "display", wrap=True))
        self.subtitle = label("", "dim", wrap=True)
        root.addWidget(self.subtitle)

        bar = QHBoxLayout()
        bar.setSpacing(10)
        bar.addWidget(button("Add person", "primary", make_icon("plus", 16, P.text_on_light), self._add_person))
        bar.addWidget(button("Import folder", icon=make_icon("folder", 16), on_click=self._import_folder))
        self.reindex_btn = button("Re-index", icon=make_icon("refresh", 16), on_click=self.reindex)
        bar.addWidget(self.reindex_btn)
        bar.addWidget(button("Open faces folder", on_click=lambda: _open_path(self.ctx.face_db.root)))
        bar.addStretch(1)
        self.progress = QProgressBar()
        self.progress.setFixedWidth(260)
        self.progress.setVisible(False)
        bar.addWidget(self.progress)
        root.addLayout(bar)

        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        root.addWidget(self.scroll, 1)

        self.ctx.facesChanged.connect(self.refresh)
        self.refresh()

    # ------------------------------------------------------------------
    def _role_of(self, name: str) -> str:
        rec = self.ctx.cfg.recognition
        if name in rec.whitelist:
            return ROLE_VISIBLE
        if name in rec.targets:
            return ROLE_HIDE
        return ROLE_NEUTRAL

    def refresh(self) -> None:
        db = self.ctx.face_db
        self.subtitle.setText(
            f"Each sub-folder of <b>{db.root}</b> is one person. Add 3–10 clear, front-facing photos per person "
            "for reliable recognition. Roles decide who is hidden in the Live and Export views."
        )
        container = QWidget()
        flow = FlowLayout(container, 16, 16)
        persons = db.persons()
        for person in persons:
            card = PersonCard(person, self._role_of(person.name))
            card.roleChanged.connect(self._set_role)
            card.addPhotos.connect(self._add_photos)
            card.openFolder.connect(lambda n: _open_path(self.ctx.face_db.root / n))
            card.deleteRequested.connect(self._delete)
            card.renameRequested.connect(self._rename)
            flow.addWidget(card)
        if not persons:
            empty = GlassCard("No identities yet", "Click “Add person” and choose a few photos, or enroll a face from the Live view.")
            empty.setFixedWidth(420)
            flow.addWidget(empty)
        self.scroll.setWidget(container)

    def _set_role(self, name: str, role: str) -> None:
        rec = self.ctx.cfg.recognition
        rec.whitelist = [n for n in rec.whitelist if n != name]
        rec.targets = [n for n in rec.targets if n != name]
        if role == ROLE_VISIBLE:
            rec.whitelist.append(name)
        elif role == ROLE_HIDE:
            rec.targets.append(name)
        self.ctx.commit()

    def _pick_images(self) -> list[Path]:
        exts = " ".join(f"*{e}" for e in sorted(IMAGE_EXTENSIONS))
        files, _ = QFileDialog.getOpenFileNames(self, "Choose photos", "", f"Images ({exts})")
        return [Path(f) for f in files]

    def _add_person(self) -> None:
        name, ok = QInputDialog.getText(self, "Add person", "Name:")
        if not ok or not name.strip():
            return
        files = self._pick_images()
        if not files:
            return
        try:
            n = self.ctx.face_db.add_images(name.strip(), files)
        except (OSError, ValueError) as exc:
            self.ctx.notify.emit(f"Could not add photos: {exc}", "error")
            return
        self.ctx.notify.emit(f"Added {n} photo(s) for {name.strip()}.", "info")
        self.refresh()
        self.reindex()

    def _add_photos(self, name: str) -> None:
        files = self._pick_images()
        if files:
            self.ctx.face_db.add_images(name, files)
            self.refresh()
            self.reindex()

    def _import_folder(self) -> None:
        folder = QFileDialog.getExistingDirectory(self, "Import folder (one sub-folder per person, or one person's photos)")
        if not folder:
            return
        src = Path(folder)
        subdirs = [d for d in src.iterdir() if d.is_dir() and any(is_image(f) for f in d.iterdir())]
        total = 0
        try:
            if subdirs:
                for d in subdirs:
                    total += self.ctx.face_db.add_images(d.name, [f for f in d.iterdir() if is_image(f)])
            else:
                name, ok = QInputDialog.getText(self, "Import folder", "Whose photos are these?", text=src.name)
                if not ok or not name.strip():
                    return
                total = self.ctx.face_db.add_images(name.strip(), [f for f in src.iterdir() if is_image(f)])
        except (OSError, ValueError) as exc:
            self.ctx.notify.emit(f"Import failed: {exc}", "error")
            return
        self.ctx.notify.emit(f"Imported {total} photo(s).", "info")
        self.refresh()
        self.reindex()

    def _delete(self, name: str) -> None:
        answer = QMessageBox.question(
            self, "Delete identity", f"Delete “{name}” and all of their photos from the faces folder?"
        )
        if answer != QMessageBox.StandardButton.Yes:
            return
        try:
            self.ctx.face_db.remove_person(name)
        except (OSError, ValueError) as exc:
            self.ctx.notify.emit(f"Could not delete {name}: {exc}", "error")
            return
        self._set_role(name, ROLE_NEUTRAL)
        self.refresh()
        self.reindex()

    def _rename(self, name: str) -> None:
        new, ok = QInputDialog.getText(self, "Rename identity", "New name:", text=name)
        if not ok or not new.strip() or new.strip() == name:
            return
        try:
            self.ctx.face_db.rename_person(name, new.strip())
        except (OSError, ValueError) as exc:
            self.ctx.notify.emit(f"Rename failed: {exc}", "error")
            return
        rec = self.ctx.cfg.recognition
        rec.whitelist = [new.strip() if n == name else n for n in rec.whitelist]
        rec.targets = [new.strip() if n == name else n for n in rec.targets]
        self.ctx.commit()
        self.refresh()
        self.reindex()

    # ------------------------------------------------------------------
    def reindex(self) -> None:
        """Embed new photos. Re-uses the live engine when a preview is running."""
        if self.live.state == RunState.RUNNING and self.live.reload_face_db():
            self.ctx.notify.emit("Re-indexing with the running engine…", "info")
            return
        if self._indexing:
            return
        self._indexing = True
        self.reindex_btn.setEnabled(False)
        self.progress.setVisible(True)
        self.progress.setRange(0, 0)
        db = self.ctx.face_db
        engine_cfg = self.ctx.cfg.snapshot().engine

        def work(progress) -> int:
            engine = FaceEngine(engine_cfg)
            return db.sync(engine, progress=lambda d, t, k: progress(d, t, k))

        def on_progress(done: int, total: int, _text: str) -> None:
            self.progress.setRange(0, max(1, total))
            self.progress.setValue(done)
            self.progress.setFormat(f"Indexing {done}/{total}")

        def finish() -> None:
            self._indexing = False
            self.reindex_btn.setEnabled(True)
            self.progress.setVisible(False)

        def done(n: int) -> None:
            finish()
            self.ctx.notify.emit(f"Index ready: {n} identit{'y' if n == 1 else 'ies'}.", "info")
            self.ctx.facesChanged.emit()  # refreshes this page and the Live header

        def failed(msg: str) -> None:
            finish()
            self.ctx.notify.emit(f"Indexing failed: {msg}", "error")

        run_task(work, on_done=done, on_error=failed, on_progress=on_progress)

    def sizeHint(self) -> QSize:  # noqa: N802
        return QSize(1100, 760)


def _open_path(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        os.startfile(str(path))  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])
