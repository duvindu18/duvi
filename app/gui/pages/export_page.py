"""Headless batch export: anonymize video files in the background at full
speed (no frame dropping, no preview) with progress and ETA."""

from __future__ import annotations

import time
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QComboBox,
    QFileDialog,
    QGridLayout,
    QHBoxLayout,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QProgressBar,
    QVBoxLayout,
    QWidget,
)

from app.core.pipeline import PipelineStats
from app.core.sources import SourceInfo, SourceKind, SourceSpec, VIDEO_EXTENSIONS
from app.gui.bridge import PipelineController, RunState
from app.gui.context import AppContext
from app.gui.icons import make_icon
from app.gui.pages.identities_page import _open_path
from app.gui.pages.live_page import POLICY_TEXT
from app.gui.theme import P
from app.gui.widgets import CircleButton, GlassCard, PillGroup, StatTile, button, label, soft_shadow, two_tone
from app.utils.paths import default_export_dir

STATUS_QUEUED, STATUS_RUNNING, STATUS_DONE, STATUS_FAILED, STATUS_CANCELLED = (
    "Queued", "Processing", "Done", "Failed", "Cancelled",
)


def unique_output(folder: Path, src: Path, ext: str) -> Path:
    base = folder / f"{src.stem}_anonymized{ext}"
    n = 1
    while base.exists():
        base = folder / f"{src.stem}_anonymized_{n}{ext}"
        n += 1
    return base


class ExportPage(QWidget):
    def __init__(self, ctx: AppContext, controller: PipelineController, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.ctx = ctx
        self.ctrl = controller
        self._current: QListWidgetItem | None = None
        self._cancel_all = False
        self._t0 = 0.0
        self._last_error = ""

        root = QVBoxLayout(self)
        root.setContentsMargins(28, 22, 28, 24)
        root.setSpacing(14)
        root.addWidget(label(two_tone("Export an", "anonymized copy"), "display", wrap=True))
        root.addWidget(
            label("Files are processed in the background at full speed: every frame is analysed, none are dropped.", "dim", wrap=True)
        )

        grid = QGridLayout()
        grid.setHorizontalSpacing(18)
        grid.setVerticalSpacing(18)

        # ---- queue -------------------------------------------------------------
        queue_card = GlassCard("Queue", "Add MP4, AVI, MKV, MOV… files")
        self.list = QListWidget()
        self.list.setMinimumHeight(220)
        self.list.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.list.setTextElideMode(Qt.TextElideMode.ElideMiddle)
        self.list.setWordWrap(True)
        queue_card.body.addWidget(self.list, 1)
        self.empty_hint = label("Drop video files here, or click “Add videos”.", "dim")
        self.empty_hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        queue_card.body.addWidget(self.empty_hint, 1)
        self.setAcceptDrops(True)
        qb = QHBoxLayout()
        qb.addWidget(button("Add videos", "primary", make_icon("plus", 16, P.text_on_light), self._add_files))
        qb.addWidget(button("Remove", on_click=self._remove_selected))
        qb.addWidget(button("Clear finished", on_click=self._clear_finished))
        qb.addStretch(1)
        queue_card.body.addLayout(qb)
        grid.addWidget(queue_card, 0, 0, 2, 1)

        # ---- output -------------------------------------------------------------
        out_card = GlassCard("Output", "Where and how anonymized copies are written")
        row = QHBoxLayout()
        self.out_edit = QLineEdit(self.ctx.cfg.output.export_dir or str(default_export_dir()))
        row.addWidget(self.out_edit, 1)
        row.addWidget(button("Browse", icon=make_icon("folder", 16), on_click=self._browse_out))
        out_card.body.addLayout(row)
        out_card.body.addWidget(label("Container", "caption"))
        self.container = PillGroup([(".mp4", "MP4"), (".avi", "AVI"), (".mkv", "MKV")])
        self.container.set_value(".mp4")
        out_card.body.addWidget(self.container)
        out_card.body.addWidget(label("Codec", "caption"))
        self.codec = QComboBox()
        for code, text in (
            ("auto", "Automatic (best available)"),
            ("mp4v", "MPEG-4 Part 2 (mp4v)"),
            ("avc1", "H.264 (avc1, needs OpenH264)"),
            ("XVID", "Xvid"),
            ("MJPG", "Motion JPEG (large, lossless-ish)"),
        ):
            self.codec.addItem(text, code)
        self.codec.setCurrentIndex(max(0, self.codec.findData(self.ctx.cfg.output.codec)))
        self.codec.currentIndexChanged.connect(self._codec_changed)
        out_card.body.addWidget(self.codec)
        self.settings_note = label("", "faint", wrap=True)
        out_card.body.addWidget(self.settings_note)
        grid.addWidget(out_card, 0, 1)

        # ---- progress ------------------------------------------------------------
        prog = GlassCard("Progress")
        self.current_label = label("Idle", "h2")
        prog.body.addWidget(self.current_label)
        self.bar = QProgressBar()
        self.bar.setValue(0)
        prog.body.addWidget(self.bar)
        tiles = QHBoxLayout()
        self.t_fps = StatTile("frames / s")
        self.t_eta = StatTile("remaining")
        self.t_faces = StatTile("faces in frame")
        for t in (self.t_fps, self.t_eta, self.t_faces):
            tiles.addWidget(t)
        prog.body.addLayout(tiles)
        controls = QHBoxLayout()
        controls.addStretch(1)
        self.start_btn = CircleButton("play", 60, solid=True, tooltip="Start export")
        soft_shadow(self.start_btn, 30, 120, 8)
        self.cancel_btn = CircleButton("stop", 46, tooltip="Cancel")
        self.open_btn = CircleButton("folder", 46, tooltip="Open output folder")
        controls.addWidget(self.cancel_btn, 0, Qt.AlignmentFlag.AlignVCenter)
        controls.addWidget(self.start_btn, 0, Qt.AlignmentFlag.AlignVCenter)
        controls.addWidget(self.open_btn, 0, Qt.AlignmentFlag.AlignVCenter)
        controls.addStretch(1)
        prog.body.addLayout(controls)
        prog.body.addStretch(1)
        grid.addWidget(prog, 1, 1)
        grid.setColumnStretch(0, 3)
        grid.setColumnStretch(1, 2)
        root.addLayout(grid, 1)

        self.start_btn.clicked.connect(self._start)
        self.cancel_btn.clicked.connect(self._cancel)
        self.open_btn.clicked.connect(lambda: _open_path(Path(self.out_edit.text() or default_export_dir())))
        self.out_edit.editingFinished.connect(self._out_changed)
        self.ctrl.progress.connect(self._on_progress)
        self.ctrl.stats.connect(self._on_stats)
        self.ctrl.status.connect(lambda s: self.current_label.setText(s) if self._current is None else None)
        self.ctrl.error.connect(self._on_error)
        self.ctrl.finished.connect(self._on_finished)
        self.ctrl.sourceInfo.connect(self._on_source_info)
        self.ctrl.stateChanged.connect(lambda _s: self._update_buttons())
        self.ctx.configChanged.connect(self._refresh_note)
        self._refresh_note()
        self._update_buttons()

    # ---- queue management ------------------------------------------------
    def _add_files(self) -> None:
        exts = " ".join(f"*{e}" for e in sorted(VIDEO_EXTENSIONS))
        files, _ = QFileDialog.getOpenFileNames(self, "Add videos", "", f"Videos ({exts});;All files (*)")
        for f in files:
            self.add_job(Path(f))
        self._update_buttons()

    def add_job(self, path: Path) -> None:
        item = QListWidgetItem()
        item.setData(Qt.ItemDataRole.UserRole, {"path": str(path), "status": STATUS_QUEUED, "output": ""})
        item.setIcon(make_icon("file", 18))
        self._render_item(item)
        self.list.addItem(item)

    def _render_item(self, item: QListWidgetItem, extra: str = "") -> None:
        d = item.data(Qt.ItemDataRole.UserRole)
        text = f"{Path(d['path']).name}\n{d['status']}{('  ·  ' + extra) if extra else ''}"
        item.setText(text)
        item.setToolTip(d["output"] or d["path"])

    def _remove_selected(self) -> None:
        for item in self.list.selectedItems():
            if item is self._current:
                continue
            self.list.takeItem(self.list.row(item))
        self._update_buttons()

    def _clear_finished(self) -> None:
        for i in reversed(range(self.list.count())):
            d = self.list.item(i).data(Qt.ItemDataRole.UserRole)
            if d["status"] in (STATUS_DONE, STATUS_FAILED, STATUS_CANCELLED):
                self.list.takeItem(i)
        self._update_buttons()

    def _browse_out(self) -> None:
        folder = QFileDialog.getExistingDirectory(self, "Output folder", self.out_edit.text())
        if folder:
            self.out_edit.setText(folder)
            self._out_changed()

    def _out_changed(self) -> None:
        self.ctx.cfg.output.export_dir = self.out_edit.text().strip()
        self.ctx.commit()

    def _codec_changed(self) -> None:
        self.ctx.cfg.output.codec = self.codec.currentData()
        self.ctx.commit()

    def _refresh_note(self) -> None:
        a = self.ctx.cfg.anonymize
        self.settings_note.setText(
            f"Uses the current Live settings: {POLICY_TEXT[a.policy].lower()}, {a.style.value} style, "
            f"intensity {a.intensity}. Overlays are never burned into exports."
        )

    # ---- run -------------------------------------------------------------
    def _next_job(self) -> QListWidgetItem | None:
        for i in range(self.list.count()):
            item = self.list.item(i)
            if item.data(Qt.ItemDataRole.UserRole)["status"] == STATUS_QUEUED:
                return item
        return None

    def _start(self) -> None:
        if self.ctrl.state != RunState.IDLE:
            return
        self._cancel_all = False
        self._run_next()

    def _run_next(self) -> None:
        item = self._next_job()
        if item is None or self._cancel_all:
            self._current = None
            self.current_label.setText("All done" if item is None else "Cancelled")
            self._update_buttons()
            return
        d = dict(item.data(Qt.ItemDataRole.UserRole))
        src = Path(d["path"])
        out_dir = Path(self.out_edit.text().strip() or default_export_dir())
        try:
            out_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            self.ctx.notify.emit(f"Cannot create output folder: {exc}", "error")
            return
        out = unique_output(out_dir, src, self.container.value() or ".mp4")
        d.update(status=STATUS_RUNNING, output=str(out))
        item.setData(Qt.ItemDataRole.UserRole, d)
        self._render_item(item)
        self._current = item
        self._last_error = ""
        self._t0 = time.monotonic()
        self.bar.setValue(0)
        self.current_label.setText(src.name)
        self.ctrl.face_db = self.ctx.face_db
        self.ctrl.start(self.ctx.cfg.snapshot(), SourceSpec(SourceKind.FILE, str(src)), realtime=False, output_path=str(out))
        self._update_buttons()

    def _cancel(self) -> None:
        self._cancel_all = True
        self.ctrl.stop()

    def _on_source_info(self, info: SourceInfo) -> None:
        if self._current is not None:
            self._render_item(self._current, f"{info.width}×{info.height} · {info.fps:.0f} fps · {info.frame_count} frames")

    def _on_progress(self, done: int, total: int) -> None:
        if total <= 0:
            return
        pct = int(done * 100 / total)
        self.bar.setValue(pct)
        elapsed = time.monotonic() - self._t0
        if done > 0:
            remaining = elapsed * (total - done) / done
            m, s = divmod(int(remaining), 60)
            self.t_eta.set(f"{m}:{s:02d}")
        if self._current is not None:
            self._render_item(self._current, f"{pct}%  ·  {done}/{total}")

    def _on_stats(self, s: PipelineStats) -> None:
        self.t_fps.set(f"{s.inference_fps:.1f}")
        self.t_faces.set(str(s.faces))

    def _on_error(self, msg: str) -> None:
        self._last_error = msg

    def _on_finished(self, reason: str) -> None:
        item, self._current = self._current, None
        if item is not None:
            d = dict(item.data(Qt.ItemDataRole.UserRole))
            if reason == "completed":
                d["status"] = STATUS_DONE
                self._render_item_after(item, d, f"saved as {Path(d['output']).name}")
                self.bar.setValue(100)
            elif reason == "error":
                d["status"] = STATUS_FAILED
                self._render_item_after(item, d, self._last_error)
            else:
                d["status"] = STATUS_CANCELLED
                self._render_item_after(item, d, "partial file kept" if d["output"] else "")
        self.t_eta.set("–")
        self._run_next()

    def _render_item_after(self, item: QListWidgetItem, d: dict, extra: str) -> None:
        item.setData(Qt.ItemDataRole.UserRole, d)
        self._render_item(item, extra)

    # ---- drag & drop -------------------------------------------------------
    def dragEnterEvent(self, e) -> None:  # noqa: N802
        if e.mimeData().hasUrls():
            e.acceptProposedAction()

    def dropEvent(self, e) -> None:  # noqa: N802
        added = 0
        for url in e.mimeData().urls():
            path = Path(url.toLocalFile())
            if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS:
                self.add_job(path)
                added += 1
        if not added:
            self.ctx.notify.emit("Only video files (MP4, AVI, MKV, MOV…) can be queued.", "warn")
        self._update_buttons()

    def _update_buttons(self) -> None:
        empty = self.list.count() == 0
        self.list.setVisible(not empty)
        self.empty_hint.setVisible(empty)
        busy = self.ctrl.state != RunState.IDLE or self._current is not None
        self.start_btn.setEnabled(not busy and self._next_job() is not None)
        self.cancel_btn.setEnabled(busy)
