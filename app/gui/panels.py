"""Control panels shared by the Live and Export pages.

Both pages edit the same configuration, so a change on one shows on the other
and applies to whatever is running (preview or export) right away.
"""

from __future__ import annotations

from pathlib import Path

from PySide6.QtWidgets import QFileDialog, QHBoxLayout, QWidget

from app.core.config import AnonymizeConfig, Policy, Shape, Style
from app.gui.context import AppContext
from app.gui.widgets import GlassCard, GlassSlider, PillGroup, ToggleRow, button, label

FACES_TEXT = {1: "1 face", 2: "Up to 2 faces", 0: "Any number of faces"}
FACES_HINT = {
    1: "Only the single most certain face is hidden. Anything weaker is ignored, so no stray blur.",
    2: "Only the two most certain faces are hidden. Weak or brief detections never get blurred.",
}


def policy_text(a: AnonymizeConfig) -> str:
    """Short caption for the current anonymization settings."""
    if a.policy == Policy.NONE:
        return "Anonymization off"
    return f"{FACES_TEXT.get(a.max_faces, f'Up to {a.max_faces} faces')} · {a.style.value.replace('_', ' ').capitalize()}"


class AnonymizationCard(GlassCard):
    def __init__(self, ctx: AppContext, parent: QWidget | None = None) -> None:
        super().__init__("Anonymization", "Blur every face in the frame", parent)
        self.ctx = ctx
        b = self.body
        self.enabled = ToggleRow("Anonymize faces", True)
        b.addWidget(self.enabled)
        b.addWidget(label("Faces in video", "caption"))
        self.faces_pills = PillGroup(
            [(1, "1"), (2, "2"), (0, "Any")],
            tooltips={
                1: "Only the single most certain face is hidden",
                2: "At most the two most certain faces are hidden (recommended for interviews)",
                0: "Hide every face found, crowds included",
            },
        )
        b.addWidget(self.faces_pills)
        self.faces_hint = label("", "faint", wrap=True)
        b.addWidget(self.faces_hint)
        b.addWidget(label("Style", "caption"))
        self.style_pills = PillGroup(
            [(Style.GAUSSIAN, "Gaussian"), (Style.PIXELATE, "Pixelate"), (Style.BLACK_BOX, "Black box"), (Style.MASK, "Mask")]
        )
        b.addWidget(self.style_pills)
        b.addWidget(label("Shape", "caption"))
        self.shape_pills = PillGroup([(Shape.ELLIPSE, "Ellipse"), (Shape.RECTANGLE, "Rectangle")])
        b.addWidget(self.shape_pills)
        self.mask_row = QWidget()
        mr = QHBoxLayout(self.mask_row)
        mr.setContentsMargins(0, 0, 0, 0)
        self.mask_label = label("Built-in mask", "dim")
        mr.addWidget(self.mask_label, 1)
        mr.addWidget(button("Choose PNG", on_click=self._choose_mask))
        mr.addWidget(button("Reset", on_click=lambda: self._edit("mask_path", "")))
        b.addWidget(self.mask_row)
        self.intensity = GlassSlider("Intensity", 1, 100, 70)
        b.addWidget(self.intensity)
        self.coverage = GlassSlider("Coverage", 0, 80, 25, fmt=lambda v: f"+{v:.0f}%")
        b.addWidget(self.coverage)
        self.persist = GlassSlider("Hold after loss", 0, 30, 8, fmt=lambda v: f"{v:.0f} fr")
        b.addWidget(self.persist)
        self.feather = ToggleRow("Soft edges", True)
        b.addWidget(self.feather)

        self.enabled.toggled.connect(lambda v: self._edit("policy", Policy.ALL if v else Policy.NONE))
        self.faces_pills.changed.connect(lambda v: self._edit("max_faces", int(v)))
        self.style_pills.changed.connect(lambda v: self._edit("style", v))
        self.shape_pills.changed.connect(lambda v: self._edit("shape", v))
        self.intensity.valueChanged.connect(lambda v: self._edit("intensity", int(v)))
        self.coverage.valueChanged.connect(lambda v: self._edit("padding", v / 100.0))
        self.persist.valueChanged.connect(lambda v: self._edit("persist_lost_frames", int(v)))
        self.feather.toggled.connect(lambda v: self._edit("feather", v))
        ctx.configChanged.connect(self.load)
        self.load()

    def load(self) -> None:
        a = self.ctx.cfg.anonymize
        self.enabled.setChecked(a.policy != Policy.NONE)
        self.faces_pills.set_value(a.max_faces if a.max_faces in (0, 1, 2) else 0)
        self.style_pills.set_value(a.style)
        self.shape_pills.set_value(a.shape)
        if not self.intensity.hasFocus():
            self.intensity.setValue(a.intensity)
        if not self.coverage.hasFocus():
            self.coverage.setValue(a.padding * 100)
        if not self.persist.hasFocus():
            self.persist.setValue(a.persist_lost_frames)
        self.feather.setChecked(a.feather)
        self.mask_row.setVisible(a.style == Style.MASK)
        self.mask_label.setText(Path(a.mask_path).name if a.mask_path else "Built-in mask")
        self.faces_hint.setText(FACES_HINT.get(a.max_faces, "Every detection is hidden, including small background faces."))
        on = a.policy != Policy.NONE
        for w in (self.faces_pills, self.style_pills, self.shape_pills, self.intensity, self.coverage, self.persist, self.feather):
            w.setEnabled(on)

    def _edit(self, key: str, value) -> None:
        setattr(self.ctx.cfg.anonymize, key, value)
        self.ctx.commit()

    def _choose_mask(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "Choose mask image", "", "Images (*.png *.webp *.jpg *.jpeg)")
        if path:
            self._edit("mask_path", path)
