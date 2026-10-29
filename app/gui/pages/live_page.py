"""Live preview: source picker, video stage with transport controls and the
inspector panel (anonymization, recognition, overlay and performance)."""

from __future__ import annotations

import getpass
import time
from pathlib import Path

import cv2
from PySide6.QtCore import QSize, Qt, Signal
from PySide6.QtGui import QColor, QKeySequence, QShortcut
from PySide6.QtWidgets import (
    QComboBox,
    QFileDialog,
    QGridLayout,
    QHBoxLayout,
    QInputDialog,
    QLineEdit,
    QScrollArea,
    QSizePolicy,
    QStackedWidget,
    QVBoxLayout,
    QWidget,
)

from app.core.config import Policy, Shape, Style
from app.core.pipeline import PipelineStats
from app.core.sources import SourceInfo, SourceKind, SourceSpec, VIDEO_EXTENSIONS, probe_webcams
from app.core import mediamtx
from app.gui.bridge import PipelineController, RunState
from app.gui.pages.phone import PhoneDialog, PhoneReceiver
from app.gui.pages.phone import describe as phone_describe
from app.gui.context import AppContext
from app.gui.icons import make_icon
from app.gui.tasks import run_task
from app.gui.theme import P
from app.gui.widgets import (
    Chip,
    PlayerBar,
    fmt_time,
    CircleButton,
    GlassCard,
    GlassSlider,
    PillGroup,
    StatTile,
    ToggleRow,
    VideoView,
    button,
    label,
    soft_shadow,
    two_tone,
)
from app.utils.imageio import imwrite
from app.utils.paths import default_export_dir

POLICY_TEXT = {
    Policy.ALL: "Hiding everyone",
    Policy.UNKNOWN: "Hiding strangers",
    Policy.TARGETS: "Hiding targets",
    Policy.ALL_EXCEPT_WHITELIST: "Whitelist visible",
    Policy.NONE: "Anonymization off",
}
NARROW_WIDTH = 1180
PHONE = "phone"  # source-picker value for the built-in phone receiver


def _user_name() -> str:
    try:
        name = getpass.getuser()
    except Exception:
        return "there"
    return name.split(".")[0].capitalize() or "there"


class VideoStage(QWidget):
    """Video surface with floating chips, caption and the media controls bar."""

    MARGIN = 20

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.view = VideoView(self)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)

        self.top_left = QWidget(self)
        tl = QHBoxLayout(self.top_left)
        tl.setContentsMargins(0, 0, 0, 0)
        tl.setSpacing(8)
        self.state_chip = Chip("Ready", dot=P.text_faint)
        self.engine_chip = Chip("Engine idle")
        tl.addWidget(self.state_chip)
        tl.addWidget(self.engine_chip)

        self.caption = QWidget(self)
        cap = QVBoxLayout(self.caption)
        cap.setContentsMargins(0, 0, 0, 0)
        cap.setSpacing(4)
        self.policy_chip = Chip("Hiding everyone")
        cap.addWidget(self.policy_chip, 0, Qt.AlignmentFlag.AlignLeft)
        self.title = label("No source", "title")
        cap.addWidget(self.title)
        self.metrics = label("–", "dim")
        cap.addWidget(self.metrics)

        self.bar = PlayerBar(self)
        b = self.bar
        self.snapshot_btn, self.record_btn, self.enroll_btn = b.snapshot_btn, b.record_btn, b.enroll_btn
        self.play_btn, self.stop_btn = b.play_btn, b.stop_btn

    def resizeEvent(self, e) -> None:  # noqa: N802
        super().resizeEvent(e)
        self.relayout()

    def relayout(self) -> None:
        """Position the floating overlays (also after chip / caption changes)."""
        w, h, m = self.width(), self.height(), self.MARGIN
        self.view.setGeometry(0, 0, w, h)
        self.top_left.adjustSize()
        self.top_left.move(m, m)
        bar_h = self.bar.sizeHint().height()
        self.bar.setGeometry(m, h - bar_h - m, w - 2 * m, bar_h)
        self.caption.setFixedWidth(max(200, min(620, w - 2 * m)))
        self.caption.adjustSize()
        cap_y = h - bar_h - m - self.caption.height() - 12
        # Hide the caption rather than letting it collide with the chips.
        self.caption.setVisible(cap_y > self.top_left.geometry().bottom() + 16)
        self.caption.move(m + 4, cap_y)


class Inspector(QScrollArea):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWidgetResizable(True)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setFrameShape(QScrollArea.Shape.NoFrame)
        self.setFixedWidth(372)
        inner = QWidget()
        self.lay = QVBoxLayout(inner)
        self.lay.setContentsMargins(0, 0, 8, 0)
        self.lay.setSpacing(14)
        self.setWidget(inner)


class LivePage(QWidget):
    manageIdentities = Signal()

    def __init__(self, ctx: AppContext, controller: PipelineController, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.ctx = ctx
        self.ctrl = controller
        self._narrow = False
        self._inspector_open = True
        self._started_at = 0.0
        self._paused = False
        self._source: SourceSpec | None = None

        root = QVBoxLayout(self)
        root.setContentsMargins(28, 22, 28, 24)
        root.setSpacing(14)

        # ---- header ----------------------------------------------------------
        header = QHBoxLayout()
        self.greeting = label("", "title")
        self.greeting.setCursor(Qt.CursorShape.PointingHandCursor)
        self.greeting.setToolTip("Click to change your name")
        self.greeting.mousePressEvent = lambda _e: self.edit_name()
        self._refresh_greeting()
        header.addWidget(self.greeting)
        header.addStretch(1)
        self.db_chip = Chip("0 identities", dot=P.ok, height=44)  # same height as the round buttons
        header.addWidget(self.db_chip)
        self.inspector_btn = CircleButton("more", 44, tooltip="Show / hide controls panel")
        self.inspector_btn.clicked.connect(self._toggle_inspector)
        header.addWidget(self.inspector_btn)
        root.addLayout(header)

        self.headline = label(two_tone("Which source", "will you protect today?"), "display", wrap=True)
        root.addWidget(self.headline)

        # ---- source picker ---------------------------------------------------
        src_row = QHBoxLayout()
        src_row.setSpacing(12)
        self.source_pills = PillGroup(
            [
                (SourceKind.WEBCAM, "Webcam"),
                (PHONE, "Phone / Blackmagic"),
                (SourceKind.STREAM, "RTSP stream"),
                (SourceKind.FILE, "Video file"),
            ],
            large=True,
        )
        self.source_pills.setSizePolicy(QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Preferred)
        src_row.addWidget(self.source_pills)
        self.source_inputs = QStackedWidget()
        self.source_inputs.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.source_inputs.setFixedHeight(40)

        cam = QWidget()
        cl = QHBoxLayout(cam)
        cl.setContentsMargins(0, 0, 0, 0)
        self.cam_combo = QComboBox()
        self.cam_combo.setEditable(True)
        self.cam_combo.setToolTip("Webcam index (0 = default camera)")
        for i in range(4):
            self.cam_combo.addItem(f"{i}")
        cl.addWidget(self.cam_combo, 1)
        self.cam_refresh = CircleButton("refresh", 40, tooltip="Detect connected webcams")
        self.cam_refresh.clicked.connect(self._probe_cams)
        cl.addWidget(self.cam_refresh)
        self.source_inputs.addWidget(cam)

        self.url_edit = QLineEdit()
        self.url_edit.setPlaceholderText("rtsp://user:password@192.168.1.20:554/stream1")
        self.source_inputs.addWidget(self.url_edit)

        file_w = QWidget()
        fl = QHBoxLayout(file_w)
        fl.setContentsMargins(0, 0, 0, 0)
        self.file_edit = QLineEdit()
        self.file_edit.setPlaceholderText("Choose an MP4, AVI or MKV file…")
        fl.addWidget(self.file_edit, 1)
        fl.addWidget(button("Browse", icon=make_icon("folder", 16), on_click=self._browse_file))
        self.source_inputs.addWidget(file_w)

        phone_w = QWidget()
        pl = QHBoxLayout(phone_w)
        pl.setContentsMargins(0, 0, 0, 0)
        pl.setSpacing(10)
        self.phone_chip = Chip("Receiver off", dot=P.text_faint, height=40)
        pl.addWidget(self.phone_chip, 0, Qt.AlignmentFlag.AlignVCenter)
        pl.addStretch(1)
        pl.addWidget(button("Connect phone…", icon=make_icon("phone", 16), on_click=self.open_phone_dialog))
        self.source_inputs.addWidget(phone_w)
        self.phone = PhoneReceiver(self)
        self.phone.statusChanged.connect(self._on_phone_status)
        self.phone.started.connect(lambda: self._on_phone_status(self.phone.status))
        self.phone.failed.connect(lambda m: self.ctx.notify.emit(f"Phone receiver: {m}", "error"))
        src_row.addWidget(self.source_inputs, 1)
        root.addLayout(src_row)
        self.source_pills.changed.connect(self._on_source_kind)

        # ---- body: stage + inspector ------------------------------------------
        self.body = QHBoxLayout()
        self.body.setSpacing(18)
        self.stage = VideoStage()
        self.body.addWidget(self.stage, 1)
        self.inspector = Inspector()
        self._build_inspector()
        self.body.addWidget(self.inspector)
        root.addLayout(self.body, 1)
        self.drawer = GlassCard(parent=self, tint="rgba(40, 10, 8, 0.96)", padding=14)
        self.drawer.hide()
        soft_shadow(self.drawer, 60, 170, 10)

        # ---- wiring ------------------------------------------------------------
        st = self.stage
        st.play_btn.clicked.connect(self._on_play)
        st.stop_btn.clicked.connect(self.ctrl.stop)
        st.record_btn.toggled.connect(self._on_record)
        st.snapshot_btn.clicked.connect(self._on_snapshot)
        st.enroll_btn.clicked.connect(self._on_enroll)
        st.view.resized.connect(lambda size: self.ctrl.set_target_size(size, st.view.devicePixelRatioF()))
        bar = st.bar
        self._pos_ms = 0.0
        self._dur_ms = 0.0
        self._media_mode_set = False
        self._last_scrub = 0.0
        bar.timeline.moved.connect(self._scrub)
        bar.timeline.released.connect(lambda f: self.ctrl.seek(f * self._dur_ms))
        bar.back10_btn.clicked.connect(lambda: self.skip(-10_000))
        bar.fwd10_btn.clicked.connect(lambda: self.skip(10_000))
        bar.step_back_btn.clicked.connect(lambda: self.step(-1))
        bar.step_fwd_btn.clicked.connect(lambda: self.step(1))
        bar.loop_btn.toggled.connect(self._on_loop)
        bar.mute_btn.toggled.connect(self._on_mute)
        bar.volume.moved.connect(self._on_volume)
        bar.volume.released.connect(self._on_volume)
        bar.loop_btn.setChecked(self.ctx.cfg.loop)
        bar.mute_btn.setChecked(self.ctx.cfg.muted)
        bar.volume.set_value(self.ctx.cfg.volume)
        self.ctrl.position.connect(self._on_position)
        self.ctrl.ended.connect(self._on_ended)
        for keys, fn in (
            ("J", lambda: self.skip(-10_000)), ("L", lambda: self.skip(10_000)),
            ("Left", lambda: self.skip(-5_000)), ("Right", lambda: self.skip(5_000)),
            (",", lambda: self.step(-1)), (".", lambda: self.step(1)),
            ("M", lambda: bar.mute_btn.toggle()),
        ):
            QShortcut(QKeySequence(keys), self, activated=fn, context=Qt.ShortcutContext.WidgetWithChildrenShortcut)
        self.ctrl.frameReady.connect(self._on_frame)
        self.ctrl.stats.connect(self._on_stats)
        self.ctrl.status.connect(self._on_status)
        self.ctrl.stateChanged.connect(self._on_state)
        self.ctrl.sourceInfo.connect(self._on_source_info)
        self.ctrl.finished.connect(self._on_finished)
        self.ctx.facesChanged.connect(self._refresh_db_chip)
        self.ctx.configChanged.connect(self._refresh_greeting)
        self._restore_source()
        self._load_from_config()
        self._on_state(RunState.IDLE.value)
        self._refresh_db_chip()

    # ======================================================================
    # Inspector
    # ======================================================================
    def _build_inspector(self) -> None:
        lay = self.inspector.lay

        anon = GlassCard("Anonymization", "Who gets hidden, and how")
        anon.body.addWidget(label("Policy", "caption"))
        self.policy = PillGroup(
            [
                (Policy.ALL, "Everyone"),
                (Policy.UNKNOWN, "Strangers"),
                (Policy.TARGETS, "Targets only"),
                (Policy.ALL_EXCEPT_WHITELIST, "All but whitelist"),
                (Policy.NONE, "Off"),
            ],
            tooltips={
                Policy.ALL: "Hide every detected face",
                Policy.UNKNOWN: "Hide faces that are not in your identity database",
                Policy.TARGETS: "Hide only identities marked as 'Hide'",
                Policy.ALL_EXCEPT_WHITELIST: "Hide everyone except identities marked as 'Visible'",
                Policy.NONE: "Detect and recognise only",
            },
        )
        anon.body.addWidget(self.policy)
        anon.body.addWidget(label("Style", "caption"))
        self.style_pills = PillGroup(
            [(Style.GAUSSIAN, "Gaussian"), (Style.PIXELATE, "Pixelate"), (Style.BLACK_BOX, "Black box"), (Style.MASK, "Mask")]
        )
        anon.body.addWidget(self.style_pills)
        self.shape_pills = PillGroup([(Shape.ELLIPSE, "Ellipse"), (Shape.RECTANGLE, "Rectangle")])
        anon.body.addWidget(self.shape_pills)
        self.mask_row = QWidget()
        mr = QHBoxLayout(self.mask_row)
        mr.setContentsMargins(0, 0, 0, 0)
        self.mask_label = label("Built-in mask", "dim")
        mr.addWidget(self.mask_label, 1)
        mr.addWidget(button("Choose PNG", on_click=self._choose_mask))
        mr.addWidget(button("Reset", on_click=lambda: self._set_mask("")))
        anon.body.addWidget(self.mask_row)
        self.intensity = GlassSlider("Intensity", 1, 100, 70)
        anon.body.addWidget(self.intensity)
        self.coverage = GlassSlider("Coverage", 0, 80, 25, fmt=lambda v: f"+{v:.0f}%")
        anon.body.addWidget(self.coverage)
        self.persist = GlassSlider("Hold after loss", 0, 30, 8, fmt=lambda v: f"{v:.0f} fr")
        anon.body.addWidget(self.persist)
        self.fail_closed = ToggleRow("Privacy-safe start", True, "Hide new faces until they are identified")
        anon.body.addWidget(self.fail_closed)
        self.feather = ToggleRow("Soft edges", True)
        anon.body.addWidget(self.feather)
        lay.addWidget(anon)

        rec = GlassCard("Recognition", "Match faces against your identity folder")
        self.rec_enabled = ToggleRow("Recognise identities", True)
        rec.body.addWidget(self.rec_enabled)
        self.threshold = GlassSlider("Match threshold", 0.20, 0.80, 0.40, 0.01, fmt=lambda v: f"{v:.2f}")
        self.threshold.setToolTip("Cosine similarity. ArcFace (InsightFace) ≈ 0.40, SFace (YuNet) ≈ 0.36")
        rec.body.addWidget(self.threshold)
        manage = button("Manage identities", icon=make_icon("faces", 16), on_click=self.manageIdentities.emit)
        rec.body.addWidget(manage)
        lay.addWidget(rec)

        ov = GlassCard("Overlay", "Preview only, never written to exports")
        self.show_boxes = ToggleRow("Tracking boxes", True)
        self.show_labels = ToggleRow("Names and track IDs", True)
        ov.body.addWidget(self.show_boxes)
        ov.body.addWidget(self.show_labels)
        lay.addWidget(ov)

        perf = GlassCard("Performance")
        grid = QGridLayout()
        grid.setHorizontalSpacing(18)
        grid.setVerticalSpacing(12)
        self.tiles = {
            "capture": StatTile("capture fps"),
            "infer": StatTile("inference fps"),
            "latency": StatTile("latency ms"),
            "faces": StatTile("faces"),
            "hidden": StatTile("hidden"),
            "dropped": StatTile("dropped"),
        }
        for i, tile in enumerate(self.tiles.values()):
            grid.addWidget(tile, i // 3, i % 3)
        perf.body.addLayout(grid)
        self.device_label = label("Device: –", "faint", wrap=True)
        perf.body.addWidget(self.device_label)
        lay.addWidget(perf)
        lay.addStretch(1)

        # Changes
        self.policy.changed.connect(lambda v: self._edit("policy", v))
        self.style_pills.changed.connect(lambda v: self._edit("style", v))
        self.shape_pills.changed.connect(lambda v: self._edit("shape", v))
        self.intensity.valueChanged.connect(lambda v: self._edit("intensity", int(v)))
        self.coverage.valueChanged.connect(lambda v: self._edit("padding", v / 100.0))
        self.persist.valueChanged.connect(lambda v: self._edit("persist_lost_frames", int(v)))
        self.fail_closed.toggled.connect(lambda v: self._edit("fail_closed", v))
        self.feather.toggled.connect(lambda v: self._edit("feather", v))
        self.show_boxes.toggled.connect(lambda v: self._edit("show_boxes", v))
        self.show_labels.toggled.connect(lambda v: self._edit("show_labels", v))
        self.rec_enabled.toggled.connect(lambda v: self._edit_rec("enabled", v))
        self.threshold.valueChanged.connect(lambda v: self._edit_rec("match_threshold", round(v, 2)))

    def _load_from_config(self) -> None:
        a = self.ctx.cfg.anonymize
        r = self.ctx.cfg.recognition
        self.policy.set_value(a.policy)
        self.style_pills.set_value(a.style)
        self.shape_pills.set_value(a.shape)
        self.intensity.setValue(a.intensity)
        self.coverage.setValue(a.padding * 100)
        self.persist.setValue(a.persist_lost_frames)
        self.fail_closed.setChecked(a.fail_closed)
        self.feather.setChecked(a.feather)
        self.show_boxes.setChecked(a.show_boxes)
        self.show_labels.setChecked(a.show_labels)
        self.rec_enabled.setChecked(r.enabled)
        self.threshold.setValue(r.match_threshold)
        self._sync_dependent()

    def reload_config(self) -> None:
        self._load_from_config()

    def _sync_dependent(self) -> None:
        a = self.ctx.cfg.anonymize
        self.mask_row.setVisible(a.style == Style.MASK)
        self.mask_label.setText(Path(a.mask_path).name if a.mask_path else "Built-in mask")
        self.stage.policy_chip.setText(POLICY_TEXT[a.policy])
        self.stage.policy_chip.adjustSize()
        self.stage.relayout()

    def _edit(self, key: str, value) -> None:
        setattr(self.ctx.cfg.anonymize, key, value)
        self._sync_dependent()
        self.ctx.commit()

    def _edit_rec(self, key: str, value) -> None:
        setattr(self.ctx.cfg.recognition, key, value)
        self.ctx.commit()

    def _choose_mask(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "Choose mask image", "", "Images (*.png *.webp *.jpg *.jpeg)")
        if path:
            self._set_mask(path)

    def _set_mask(self, path: str) -> None:
        self._edit("mask_path", path)

    # ======================================================================
    # Responsive layout
    # ======================================================================
    def resizeEvent(self, e) -> None:  # noqa: N802
        super().resizeEvent(e)
        narrow = self.width() < NARROW_WIDTH
        if narrow != self._narrow:
            self._narrow = narrow
            self._apply_layout_mode()
        elif narrow:
            self._place_drawer()
        self.headline.setProperty("role", "title" if self.width() < 900 else "display")
        self.headline.style().unpolish(self.headline)
        self.headline.style().polish(self.headline)

    def _apply_layout_mode(self) -> None:
        if self._narrow:
            # Float the inspector in an opaque glass drawer over the video.
            self.body.removeWidget(self.inspector)
            self.drawer.body.addWidget(self.inspector)
            self._inspector_open = False
            self._place_drawer()
        else:
            self.drawer.body.removeWidget(self.inspector)
            self.body.addWidget(self.inspector)
            self._inspector_open = True
        self._show_inspector()

    def _show_inspector(self) -> None:
        if self._narrow:
            self.inspector.setVisible(True)
            self.drawer.setVisible(self._inspector_open)
            if self._inspector_open:
                self.drawer.raise_()
        else:
            self.drawer.setVisible(False)
            self.inspector.setVisible(self._inspector_open)

    def _place_drawer(self) -> None:
        top = self.headline.geometry().top()
        h = self.height() - top - 24
        width = self.inspector.width() + 28
        self.drawer.setGeometry(self.width() - width - 20, top, width, max(200, h))

    def _toggle_inspector(self) -> None:
        self._inspector_open = not self._inspector_open
        if self._narrow:
            self._place_drawer()
        self._show_inspector()

    # ======================================================================
    # Source handling
    # ======================================================================
    def _restore_source(self) -> None:
        saved = self.ctx.cfg.last_source_kind
        kind = PHONE if saved == PHONE else SourceKind(saved) if saved in [k.value for k in SourceKind] else SourceKind.WEBCAM
        value = self.ctx.cfg.last_source_value
        self.source_pills.set_value(kind)
        self._on_source_kind(kind)
        if kind == SourceKind.WEBCAM:
            self.cam_combo.setCurrentText(value)
        elif kind == SourceKind.STREAM:
            self.url_edit.setText(value)
        elif kind == SourceKind.FILE:
            self.file_edit.setText(value)

    def _on_source_kind(self, kind: SourceKind) -> None:
        self.source_inputs.setCurrentIndex([SourceKind.WEBCAM, SourceKind.STREAM, SourceKind.FILE, PHONE].index(kind))
        if kind == PHONE and hasattr(self, "phone"):
            if self.phone.available:
                self.phone.start()
            else:
                self._on_phone_status(None)

    def _browse_file(self) -> None:
        exts = " ".join(f"*{e}" for e in sorted(VIDEO_EXTENSIONS))
        path, _ = QFileDialog.getOpenFileName(self, "Open video", "", f"Videos ({exts});;All files (*)")
        if path:
            self.file_edit.setText(path)

    def _probe_cams(self) -> None:
        self.cam_refresh.setEnabled(False)
        self.ctx.notify.emit("Looking for webcams…", "info")

        def done(found: list[int]) -> None:
            self.cam_refresh.setEnabled(True)
            current = self.cam_combo.currentText()
            self.cam_combo.clear()
            for i in found:
                self.cam_combo.addItem(str(i))
            if not found:
                self.cam_combo.addItem("0")
                self.ctx.notify.emit("No webcams detected. Check the connection and Windows camera privacy settings.", "warn")
            else:
                self.ctx.notify.emit(f"Found {len(found)} webcam(s): {', '.join(map(str, found))}", "info")
            idx = self.cam_combo.findText(current)
            self.cam_combo.setCurrentIndex(max(0, idx))

        run_task(probe_webcams, on_done=done, on_error=lambda m: (self.cam_refresh.setEnabled(True), self.ctx.notify.emit(m, "error")))

    def _current_spec(self) -> SourceSpec | None:
        kind = self.source_pills.value()
        if kind == PHONE:
            if not self.phone.ready:
                self.open_phone_dialog()
                return None
            return SourceSpec(SourceKind.STREAM, mediamtx.read_url())
        if kind == SourceKind.WEBCAM:
            text = self.cam_combo.currentText().strip() or "0"
            if not text.isdigit():
                self.ctx.notify.emit("Webcam index must be a number (0, 1, 2…).", "warn")
                return None
            return SourceSpec(SourceKind.WEBCAM, text)
        if kind == SourceKind.STREAM:
            url = self.url_edit.text().strip()
            if not url:
                self.ctx.notify.emit("Enter an RTSP / HTTP stream URL first.", "warn")
                return None
            return SourceSpec(SourceKind.STREAM, url)
        path = self.file_edit.text().strip().strip('"')
        if not path or not Path(path).is_file():
            self.ctx.notify.emit("Choose an existing video file first.", "warn")
            return None
        return SourceSpec(SourceKind.FILE, path)

    # ======================================================================
    # Transport
    # ======================================================================
    def _on_play(self) -> None:
        state = self.ctrl.state
        if state == RunState.RUNNING:
            self._paused = not self._paused
            self.ctrl.set_paused(self._paused)
            self.stage.play_btn.set_icon("play" if self._paused else "pause")
            self._set_state_chip("Paused" if self._paused else "Live", P.warn if self._paused else P.ok)
            return
        if state != RunState.IDLE:
            return
        spec = self._current_spec()
        if spec is None:
            return
        self.ctx.cfg.last_source_kind = PHONE if self.source_pills.value() == PHONE else spec.kind.value
        self.ctx.cfg.last_source_value = spec.value
        self.ctx.commit()
        self._source = spec
        self._paused = False
        self._started_at = time.monotonic()
        self.stage.title.setText("Phone camera" if self.source_pills.value() == PHONE else spec.label())
        self.stage.view.headline = "Connecting…"
        self.stage.view.subline = spec.label()
        self.stage.view.clear()
        self.ctrl.face_db = self.ctx.face_db
        self.ctrl.set_target_size(self.stage.view.target_size(), self.stage.view.devicePixelRatioF())
        self.ctrl.start(self.ctx.cfg.snapshot(), spec, realtime=True)

    def toggle_play(self) -> None:
        self._on_play()

    def _on_record(self, on: bool) -> None:
        if on:
            if self.ctrl.state != RunState.RUNNING:
                self.stage.record_btn.setChecked(False)
                self.ctx.notify.emit("Start a source before recording.", "warn")
                return
            out_dir = Path(self.ctx.cfg.output.export_dir or default_export_dir())
            path = out_dir / f"veil_{time.strftime('%Y%m%d_%H%M%S')}.mp4"
            self.ctrl.start_recording(str(path))
            self.ctx.notify.emit(f"Recording anonymized video to {path}", "info")
        else:
            self.ctrl.stop_recording()

    def _on_snapshot(self) -> None:
        pkt = self.ctrl.last_processed()
        if pkt is None:
            self.ctx.notify.emit("Nothing to capture yet.", "warn")
            return
        out_dir = Path(self.ctx.cfg.output.export_dir or default_export_dir())
        path = out_dir / f"veil_snapshot_{time.strftime('%Y%m%d_%H%M%S')}.png"
        if imwrite(path, pkt.frame):
            self.ctx.notify.emit(f"Anonymized snapshot saved: {path}", "info")
        else:
            self.ctx.notify.emit(f"Could not write {path}", "error")

    def _on_enroll(self) -> None:
        snap = self.ctrl.snapshot()
        if snap is None or not snap.faces:
            self.ctx.notify.emit("No face visible to enroll. Start a source and face the camera.", "warn")
            return
        live = [f for f in snap.faces if not f.lost]
        if not live:
            self.ctx.notify.emit("No face visible to enroll.", "warn")
            return
        face = max(live, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
        names = self.ctx.face_db.person_names()
        name, ok = QInputDialog.getItem(
            self, "Enroll identity", f"Who is face #{face.track_id}?", names or [""], 0, True
        )
        name = name.strip()
        if not ok or not name:
            return
        h, w = snap.frame.shape[:2]
        x1, y1, x2, y2 = face.bbox
        mx, my = (x2 - x1) * 0.6, (y2 - y1) * 0.6
        crop = snap.frame[int(max(0, y1 - my)) : int(min(h, y2 + my)), int(max(0, x1 - mx)) : int(min(w, x2 + mx))]
        if crop.size == 0:
            return
        if max(crop.shape[:2]) > 800:
            s = 800 / max(crop.shape[:2])
            crop = cv2.resize(crop, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        try:
            self.ctx.face_db.save_crop(name, crop)
        except (OSError, ValueError) as exc:
            self.ctx.notify.emit(f"Could not save face: {exc}", "error")
            return
        self.ctrl.reload_face_db()
        self.ctx.facesChanged.emit()
        self.ctx.notify.emit(f"Enrolled a new photo of {name}.", "info")

    # ======================================================================
    # Controller signals
    # ======================================================================
    def _on_frame(self) -> None:
        img = self.ctrl.take_frame()
        if img is not None:
            self.stage.view.set_image(img)

    # ---- player ------------------------------------------------------------
    def skip(self, delta_ms: float) -> None:
        if self.ctrl.seekable:
            self.ctrl.seek(max(0.0, min(self._dur_ms, self._pos_ms + delta_ms)))

    def step(self, frames: int) -> None:
        if self.ctrl.seekable:
            self.ctrl.step(frames)
            self._paused = True
            self.stage.play_btn.set_icon("play")
            self._set_state_chip("Paused", P.warn)

    def _scrub(self, frac: float) -> None:
        # Live preview while dragging, at most ~7 seeks per second.
        now = time.monotonic()
        self.stage.bar.time_cur.setText(fmt_time(frac * self._dur_ms))
        if now - self._last_scrub > 0.15:
            self._last_scrub = now
            self.ctrl.seek(frac * self._dur_ms)

    def _on_position(self, pos_ms: float, dur_ms: float) -> None:
        if not self._media_mode_set:
            self._media_mode_set = True
            self.stage.bar.set_media_mode(self.ctrl.seekable, self.ctrl.has_audio)
            self.stage.relayout()
        self._pos_ms, self._dur_ms = pos_ms, dur_ms
        bar = self.stage.bar
        if not bar.timeline.dragging:
            bar.timeline.set_value(pos_ms / dur_ms if dur_ms else 0.0)
            bar.time_cur.setText(fmt_time(pos_ms))
        bar.time_total.setText(fmt_time(dur_ms))
        bar.timeline.duration_ms = dur_ms

    def _on_ended(self) -> None:
        self._paused = True
        self.stage.play_btn.set_icon("play")
        self._set_state_chip("Ended", P.text_faint)

    def _on_loop(self, on: bool) -> None:
        self.ctx.cfg.loop = on
        self.ctx.commit()

    def _on_mute(self, on: bool) -> None:
        self.ctx.cfg.muted = on
        self.ctrl.set_muted(on)
        self.ctx.commit()

    def _on_volume(self, v: float) -> None:
        self.ctx.cfg.volume = round(v, 3)
        self.ctrl.set_volume(v)
        if v > 0 and self.stage.bar.mute_btn.isChecked():
            self.stage.bar.mute_btn.setChecked(False)
        self.ctx.commit()

    def _on_stats(self, s: PipelineStats) -> None:
        self.tiles["capture"].set(f"{s.capture_fps:.1f}")
        self.tiles["infer"].set(f"{s.inference_fps:.1f}")
        self.tiles["latency"].set(f"{s.latency_ms:.0f}")
        self.tiles["faces"].set(str(s.faces))
        self.tiles["hidden"].set(str(s.anonymized))
        self.tiles["dropped"].set(str(s.dropped))
        self.device_label.setText(f"Device: {s.device}")
        if self.stage.engine_chip.text() != s.device:
            self.stage.engine_chip.setText(s.device)
            self.stage.engine_chip.adjustSize()
            self.stage.relayout()
        self.stage.metrics.setText(
            f"{s.inference_fps:.1f} fps  ·  {s.latency_ms:.0f} ms  ·  {s.faces} face{'s' if s.faces != 1 else ''}"
            + ("  ·  ● REC" if s.recording else "")
        )
        self.db_chip.setText(f"{s.identities} identit{'y' if s.identities == 1 else 'ies'}")

    def _on_status(self, text: str) -> None:
        self.stage.view.subline = text
        if not self.stage.view.has_image:
            self.stage.view.update()

    def _on_source_info(self, info: SourceInfo) -> None:
        self.stage.metrics.setText(f"{info.width}×{info.height}  ·  {info.fps:.0f} fps source")
        self.stage.view.headline = "Loading models…"

    def _set_state_chip(self, text: str, color: str) -> None:
        self.stage.state_chip.setText(text)
        self.stage.state_chip.set_dot(color)
        self.stage.state_chip.adjustSize()
        self.stage.relayout()

    def _on_state(self, state: str) -> None:
        st = self.stage
        if state == RunState.RUNNING.value:
            self._media_mode_set = False
            st.bar.set_media_mode(False)
            st.play_btn.set_icon("pause")
            st.play_btn.setEnabled(True)
            st.stop_btn.setEnabled(True)
            self._set_state_chip("Live", P.ok)
            self.source_pills.setEnabled(False)
            self.source_inputs.setEnabled(False)
        elif state == RunState.STOPPING.value:
            st.play_btn.setEnabled(False)
            st.stop_btn.setEnabled(False)
            self._set_state_chip("Stopping…", P.warn)
        else:
            st.play_btn.set_icon("play")
            st.play_btn.setEnabled(True)
            st.stop_btn.setEnabled(False)
            st.record_btn.blockSignals(True)
            st.record_btn.setChecked(False)
            st.record_btn.blockSignals(False)
            st.bar.set_media_mode(False)
            self._set_state_chip("Ready", P.text_faint)
            self.source_pills.setEnabled(True)
            self.source_inputs.setEnabled(True)
        live = state == RunState.RUNNING.value
        st.record_btn.setEnabled(live)
        st.snapshot_btn.setEnabled(live)
        st.enroll_btn.setEnabled(live)
        st.relayout()

    def _on_finished(self, reason: str) -> None:
        self._started_at = 0.0
        view = self.stage.view
        view.clear()
        if reason == "completed":
            view.headline = "That's a wrap."
            view.subline = "The video finished playing"
        elif reason == "error":
            view.headline = "Something went wrong."
            view.subline = "See the message above for details"
        else:
            view.headline = "Protect every face."
            view.subline = "Choose a source and press play"
        view.update()

    # ---- phone receiver -----------------------------------------------------
    def open_phone_dialog(self) -> None:
        if not self.phone.available:
            self.ctx.notify.emit(
                "The phone receiver (MediaMTX) is not installed. Run VeilSetup.exe again and select "
                "'Phone & Blackmagic Camera receiver'.", "warn", )
        dlg = PhoneDialog(self.phone, self)
        dlg.startPreview.connect(self._on_play)
        dlg.exec()

    def _on_phone_status(self, status) -> None:
        text, dot = phone_describe(status, self.phone.running)
        if not self.phone.available:
            text, dot = "Receiver not installed", P.danger
        self.phone_chip.setText(text)
        self.phone_chip.set_dot(dot)
        self.phone_chip.adjustSize()

    def shutdown(self) -> None:
        self.phone.stop()

    def _refresh_greeting(self) -> None:
        name = self.ctx.cfg.display_name.strip() or _user_name()
        self.greeting.setText(two_tone("Hi,", f"{name}!"))

    def edit_name(self) -> None:
        current = self.ctx.cfg.display_name.strip() or _user_name()
        name, ok = QInputDialog.getText(self, "Welcome message", "Your name:", text=current)
        if ok:
            self.ctx.cfg.display_name = name.strip()[:40]
            self.ctx.commit()

    def _refresh_db_chip(self) -> None:
        persons = self.ctx.face_db.persons()
        n = len(persons)
        self.db_chip.setText(f"{n} identit{'y' if n == 1 else 'ies'}")

    def sizeHint(self) -> QSize:  # noqa: N802
        return QSize(1280, 820)
