"""Engine, tracker, recognition and storage settings plus a hardware report."""

from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QComboBox,
    QFileDialog,
    QHBoxLayout,
    QLineEdit,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from app.core import hardware
from app.core.config import Backend, Device
from app.core.engine import InsightFaceBackend, YuNetBackend
from app.gui.context import AppContext
from app.gui.icons import make_icon
from app.gui.tasks import run_task
from app.gui.widgets import FlowLayout, GlassCard, GlassSlider, PillGroup, ToggleRow, button, label, two_tone

DEVICE_TEXT = {
    Device.AUTO: "Automatic (fastest available)",
    Device.TENSORRT: "NVIDIA TensorRT",
    Device.CUDA: "NVIDIA CUDA",
    Device.DIRECTML: "DirectML (any DX12 GPU)",
    Device.OPENVINO: "Intel OpenVINO",
    Device.CPU: "CPU",
}
_PROVIDER = {
    Device.TENSORRT: "TensorrtExecutionProvider",
    Device.CUDA: "CUDAExecutionProvider",
    Device.DIRECTML: "DmlExecutionProvider",
    Device.OPENVINO: "OpenVINOExecutionProvider",
    Device.CPU: "CPUExecutionProvider",
}


class SettingsPage(QWidget):
    def __init__(self, ctx: AppContext, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.ctx = ctx
        cfg = ctx.cfg
        outer = QVBoxLayout(self)
        outer.setContentsMargins(28, 22, 28, 24)
        outer.setSpacing(14)
        outer.addWidget(label(two_tone("Tune the", "engine"), "display"))
        self.restart_note = label("Engine changes apply the next time a source is started.", "dim")
        outer.addWidget(self.restart_note)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        inner = QWidget()
        flow = FlowLayout(inner, 18, 18)
        scroll.setWidget(inner)
        outer.addWidget(scroll, 1)

        def card(title: str, subtitle: str = "") -> GlassCard:
            c = GlassCard(title, subtitle)
            c.setFixedWidth(420)
            flow.addWidget(c)
            return c

        # ---- general ---------------------------------------------------------
        gen = card("General", "Welcome message and preview behaviour")
        gen.body.addWidget(label("Your name (welcome message)", "caption"))
        self.name_edit = QLineEdit(cfg.display_name)
        self.name_edit.setPlaceholderText("Leave empty to use your Windows user name")
        self.name_edit.setMaxLength(40)
        self.name_edit.editingFinished.connect(lambda: self._set(cfg, "display_name", self.name_edit.text().strip()))
        gen.body.addWidget(self.name_edit)
        ctx.configChanged.connect(
            lambda: None if self.name_edit.hasFocus() else self.name_edit.setText(ctx.cfg.display_name)
        )
        gen.body.addWidget(label("Preview mode", "caption"))
        self.preview_mode = PillGroup(
            [("smooth", "Smooth (recommended)"), ("exact", "Exact")],
            tooltips={
                "smooth": "Plays every frame at full frame rate; faces are tracked between detections",
                "exact": "Every displayed frame is detected; can stutter on slower GPUs",
            },
        )
        self.preview_mode.set_value(cfg.preview_mode)
        self.preview_mode.changed.connect(lambda v: self._set(cfg, "preview_mode", v))
        gen.body.addWidget(self.preview_mode)
        gen.body.addWidget(label("Exports always detect every frame, whatever this setting.", "faint", wrap=True))

        # ---- engine ----------------------------------------------------------
        eng = card("Face engine", "Detector, recognizer and hardware acceleration")
        eng.body.addWidget(label("Backend", "caption"))
        self.backend = PillGroup(
            [(Backend.INSIGHTFACE, "InsightFace (accurate)"), (Backend.YUNET, "YuNet + SFace (light)")]
        )
        self.backend.set_value(cfg.engine.backend)
        self.backend.changed.connect(self._backend_changed)
        eng.body.addWidget(self.backend)
        eng.body.addWidget(label("Model pack (InsightFace)", "caption"))
        self.pack = PillGroup([("buffalo_l", "buffalo_l · best"), ("buffalo_s", "buffalo_s · fast")])
        self.pack.set_value(cfg.engine.insightface_pack)
        self.pack.changed.connect(lambda v: self._set(cfg.engine, "insightface_pack", v))
        eng.body.addWidget(self.pack)
        eng.body.addWidget(label("Accelerator", "caption"))
        self.device = QComboBox()
        self.device.setToolTip("Auto tries TensorRT → CUDA → DirectML → OpenVINO → CPU")
        available = set(hardware.available_ort_providers())
        for d in Device:
            text = DEVICE_TEXT[d]
            if d not in (Device.AUTO, Device.CPU) and _PROVIDER[d] not in available:
                text += "  (not installed)"
            self.device.addItem(text, d)
        self.device.setCurrentIndex(self.device.findData(cfg.engine.device))
        self.device.currentIndexChanged.connect(lambda: self._set(cfg.engine, "device", self.device.currentData()))
        eng.body.addWidget(self.device)
        self.gpu_id = GlassSlider("GPU index", 0, 7, cfg.engine.gpu_id)
        self.gpu_id.valueChanged.connect(lambda v: self._set(cfg.engine, "gpu_id", int(v)))
        eng.body.addWidget(self.gpu_id)
        self.mem = GlassSlider(
            "VRAM limit", 0, 24576, cfg.engine.gpu_mem_limit_mb, 256,
            fmt=lambda v: "unlimited" if v == 0 else f"{v / 1024:.2f} GB",
        )
        self.mem.setToolTip("Cap ONNX Runtime's CUDA arena to leave VRAM for other apps")
        self.mem.valueChanged.connect(lambda v: self._set(cfg.engine, "gpu_mem_limit_mb", int(v)))
        eng.body.addWidget(self.mem)
        self.fp16 = ToggleRow("TensorRT FP16", cfg.engine.tensorrt_fp16, "~2× faster on RTX GPUs; first start builds an engine cache")
        self.fp16.toggled.connect(lambda v: self._set(cfg.engine, "tensorrt_fp16", v))
        eng.body.addWidget(self.fp16)
        self.threads = GlassSlider("CPU threads", 0, 32, cfg.engine.cpu_threads, fmt=lambda v: "auto" if v == 0 else f"{v:.0f}")
        self.threads.valueChanged.connect(lambda v: self._set(cfg.engine, "cpu_threads", int(v)))
        eng.body.addWidget(self.threads)

        # ---- detection -----------------------------------------------------------
        det = card("Detection", "Sensitivity versus speed")
        det.body.addWidget(label("Detector input size", "caption"))
        self.det_size = PillGroup(
            [(0, "Auto"), (320, "320 · fastest"), (640, "640 · balanced"), (960, "960 · small faces"), (1280, "1280 · crowds")],
            tooltips={0: "960 on GPU, 640 on CPU"},
        )
        self.det_size.set_value(cfg.engine.det_size)
        self.det_size.changed.connect(lambda v: self._set(cfg.engine, "det_size", v))
        det.body.addWidget(self.det_size)
        det.body.addWidget(label("Face angles", "caption"))
        self.rot = PillGroup(
            [("full", "Any angle"), ("tilt", "Tilted ±75°"), ("off", "Upright only")],
            tooltips={
                "full": "Also detects heads lying sideways or upside down (recommended)",
                "tilt": "Upright and tilted heads; cheaper",
                "off": "Fastest; misses faces tilted more than ~35°",
            },
        )
        self.rot.set_value(cfg.engine.rotation_coverage)
        self.rot.changed.connect(lambda v: self._set(cfg.engine, "rotation_coverage", v))
        det.body.addWidget(self.rot)
        self.rot_passes = GlassSlider(
            "Rotated passes / frame", 0, 6, cfg.engine.rotation_passes,
            fmt=lambda v: "auto" if v == 0 else f"{v:.0f}",
        )
        self.rot_passes.setToolTip("More passes find newly appearing tilted faces sooner (auto: 2 on GPU, 1 on CPU)")
        self.rot_passes.valueChanged.connect(lambda v: self._set(cfg.engine, "rotation_passes", int(v)))
        det.body.addWidget(self.rot_passes)
        self.det_thr = GlassSlider("Confidence", 0.2, 0.9, cfg.engine.det_threshold, 0.01, fmt=lambda v: f"{v:.2f}")
        self.det_thr.valueChanged.connect(self._det_thr_changed)
        det.body.addWidget(self.det_thr)
        self.det_low = GlassSlider("Low-score recovery", 0.05, 0.5, cfg.engine.det_low_threshold, 0.01, fmt=lambda v: f"{v:.2f}")
        self.det_low.setToolTip("ByteTrack second-stage threshold: keeps occluded / blurred faces tracked")
        self.det_low.valueChanged.connect(lambda v: self._set(cfg.engine, "det_low_threshold", round(v, 2)))
        det.body.addWidget(self.det_low)
        self.min_face = GlassSlider("Minimum face", 8, 120, cfg.engine.min_face_px, fmt=lambda v: f"{v:.0f} px")
        self.min_face.valueChanged.connect(lambda v: self._set(cfg.engine, "min_face_px", int(v)))
        det.body.addWidget(self.min_face)

        # ---- tracking -------------------------------------------------------------
        trk = card("Tracking", "ByteTrack association parameters")
        self.match_iou = GlassSlider("Match IoU", 0.1, 0.8, cfg.tracker.match_iou, 0.01, fmt=lambda v: f"{v:.2f}")
        self.match_iou.valueChanged.connect(lambda v: self._set(cfg.tracker, "match_iou", round(v, 2)))
        trk.body.addWidget(self.match_iou)
        self.new_thr = GlassSlider("New track score", 0.3, 0.95, cfg.tracker.new_track_threshold, 0.01, fmt=lambda v: f"{v:.2f}")
        self.new_thr.valueChanged.connect(lambda v: self._set(cfg.tracker, "new_track_threshold", round(v, 2)))
        trk.body.addWidget(self.new_thr)
        self.max_lost = GlassSlider("Keep lost tracks", 5, 150, cfg.tracker.max_lost_frames, fmt=lambda v: f"{v:.0f} fr")
        self.max_lost.valueChanged.connect(lambda v: self._set(cfg.tracker, "max_lost_frames", int(v)))
        trk.body.addWidget(self.max_lost)
        self.min_hits = GlassSlider("Confirm after", 1, 5, cfg.tracker.min_hits, fmt=lambda v: f"{v:.0f} hits")
        self.min_hits.valueChanged.connect(lambda v: self._set(cfg.tracker, "min_hits", int(v)))
        trk.body.addWidget(self.min_hits)

        # ---- recognition -----------------------------------------------------------
        rec = card("Recognition", "Scheduling keeps recognition cheap in crowded scenes")
        frow = QHBoxLayout()
        self.faces_dir = QLineEdit(cfg.recognition.faces_dir)
        self.faces_dir.editingFinished.connect(lambda: self.ctx.set_faces_dir(self.faces_dir.text().strip()))
        frow.addWidget(self.faces_dir, 1)
        frow.addWidget(button("Browse", icon=make_icon("folder", 16), on_click=self._browse_faces))
        rec.body.addWidget(label("Identity folder", "caption"))
        rec.body.addLayout(frow)
        self.rec_every = GlassSlider("Retry unknown every", 1, 30, cfg.recognition.recognize_every_n, fmt=lambda v: f"{v:.0f} fr")
        self.rec_every.valueChanged.connect(lambda v: self._set(cfg.recognition, "recognize_every_n", int(v)))
        rec.body.addWidget(self.rec_every)
        self.reverify = GlassSlider("Re-verify known every", 10, 300, cfg.recognition.reverify_every_n, fmt=lambda v: f"{v:.0f} fr")
        self.reverify.valueChanged.connect(lambda v: self._set(cfg.recognition, "reverify_every_n", int(v)))
        rec.body.addWidget(self.reverify)
        self.per_frame = GlassSlider("Max faces per frame", 1, 16, cfg.recognition.max_per_frame)
        self.per_frame.valueChanged.connect(lambda v: self._set(cfg.recognition, "max_per_frame", int(v)))
        rec.body.addWidget(self.per_frame)
        self.votes = GlassSlider("Vote window", 1, 15, cfg.recognition.vote_window, fmt=lambda v: f"{v:.0f} votes")
        self.votes.valueChanged.connect(lambda v: self._set(cfg.recognition, "vote_window", int(v)))
        rec.body.addWidget(self.votes)

        # ---- hardware ---------------------------------------------------------------
        hw = card("Hardware", "What this PC can accelerate")
        self.hw_text = label("Probing…", "dim", wrap=True)
        self.hw_text.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        hw.body.addWidget(self.hw_text)
        hw.body.addWidget(button("Refresh", icon=make_icon("refresh", 16), on_click=self.probe))
        self.probe()

    # ------------------------------------------------------------------
    def _set(self, section, key: str, value) -> None:
        setattr(section, key, value)
        self.ctx.commit()

    def _backend_changed(self, backend: Backend) -> None:
        self.ctx.cfg.engine.backend = backend
        # Each embedding space has its own calibrated cosine threshold.
        rec = InsightFaceBackend if backend == Backend.INSIGHTFACE else YuNetBackend
        self.ctx.cfg.recognition.match_threshold = rec.recommended_threshold
        self.ctx.commit()
        self.ctx.notify.emit(
            f"Match threshold reset to {rec.recommended_threshold:.2f} for {backend.value}. Re-index identities after switching.",
            "info",
        )

    def _det_thr_changed(self, v: float) -> None:
        self.ctx.cfg.engine.det_threshold = round(v, 2)
        self.ctx.cfg.tracker.high_threshold = round(v, 2)
        self.ctx.commit()

    def _browse_faces(self) -> None:
        folder = QFileDialog.getExistingDirectory(self, "Identity folder", self.faces_dir.text())
        if folder:
            self.faces_dir.setText(folder)
            self.ctx.set_faces_dir(folder)

    def probe(self) -> None:
        self.hw_text.setText("Probing…")
        run_task(
            hardware.probe,
            on_done=lambda rep: self.hw_text.setText("<br>".join(rep.lines())),
            on_error=lambda m: self.hw_text.setText(f"Probe failed: {m}"),
        )
