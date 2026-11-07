"""Editor page: New from photo, Regenerate from photo, Import map set, Adjust maps.

Live preview at preview resolution in a worker thread (latest change wins); saving renders full size.
Unsaved work can be kept as a draft.
"""
from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Any

import numpy as np  # noqa: F401  (type hints)
from PySide6.QtCore import QSize, Qt, Signal
from PySide6.QtGui import QImageReader, QPixmap
from PySide6.QtWidgets import (QComboBox, QFileDialog, QGridLayout, QHBoxLayout, QLabel, QLineEdit, QProgressBar,
                               QScrollArea, QVBoxLayout, QWidget)

from ..engine import adjust as adj
from ..engine import importer as imp
from ..engine.presets import PRESETS, RANGES, GenParams, for_preset
from ..engine.seamless import MODES
from ..library.drafts import Draft
from ..library.store import UNCATEGORIZED
from . import theme
from .dialogs import ask
from .hub import Hub
from .inspector import MapStrip, ViewerCard
from .widgets import (CategoryPicker, ChoiceRow, ElidedLabel, FillSlider, Segmented, TagInput, ToggleRow, button,
                      clear_layout, label)
from .workers import Debouncer
from ..jobs import (job_adjust_preview, job_assemble_preview, job_load_base, job_load_source,
                    job_photo_preview, job_save_adjust, job_save_import, job_save_photo)

ROLE_SHORT = {"albedo": "Albedo", "normal": "Normal", "roughness": "Roughness", "gloss": "Gloss",
              "metallic": "Metallic", "height": "Height", "ao": "AO", "orm": "ORM (packed)", "ignore": "Ignore"}
SEAMLESS_LABELS = {"periodic": "Periodic (keeps detail)", "blend": "Blend", "mirror": "Mirror", "off": "Off"}
OUTPUT_SIZES = [("512", "512 px"), ("1024", "1024 px"), ("2048", "2048 px"), ("4096", "4096 px")]
ADJUST_TITLES = {"albedo": "ALBEDO", "normal": "NORMAL", "roughness": "ROUGHNESS", "metallic": "METALLIC",
                 "height": "HEIGHT", "ao": "AMBIENT OCCLUSION"}
_PRESET_WORDS = [("brick", "brick"), ("tile", "tile"), ("tiles", "tile"), ("wood", "wood"), ("oak", "wood"),
                 ("plank", "wood"), ("metal", "metal"), ("steel", "metal"), ("iron", "metal"), ("copper", "metal"),
                 ("stucco", "stucco"), ("plaster", "stucco"), ("concrete", "concrete"), ("cement", "concrete"),
                 ("stone", "stone"), ("rock", "stone"), ("marble", "stone"), ("slate", "stone"), ("granite", "stone"),
                 ("fabric", "fabric"), ("cloth", "fabric"), ("linen", "fabric"), ("leather", "leather"),
                 ("ground", "ground"), ("soil", "ground"), ("dirt", "ground"), ("moss", "ground"), ("grass", "ground"),
                 ("gravel", "ground"), ("sand", "ground"), ("plastic", "plastic"), ("rubber", "plastic")]


def nice_name(path: str | Path) -> str:
    stem = Path(path).stem
    stem = re.sub(r"[_\-.]+", " ", stem)
    stem = re.sub(r"\b(\d+k|\d{3,4}px|img|dsc|photo|color|colour|albedo|basecolor|diffuse)\b", " ", stem, flags=re.I)
    stem = re.sub(r"\s+", " ", stem).strip()
    return stem.title() if stem else "New material"


def guess_preset(name: str) -> str:
    low = name.lower()
    for word, preset in _PRESET_WORDS:
        if re.search(rf"\b{word}", low):
            return preset
    return "generic"


# ---------------------------------------------------------------- the page
class EditorPage(QWidget):
    closed = Signal(object)      # saved material id, or None

    def __init__(self, hub: Hub, parent=None):
        super().__init__(parent)
        self.hub = hub
        self.setObjectName("Page")
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.mode = "photo"              # photo | regenerate | import | adjust
        self.draft: Draft | None = None
        self.material_id: str | None = None
        self.source: str | None = None
        self.source_label = ""
        self.params = GenParams()
        self.adjust: dict[str, Any] = adj.neutral()
        self.assignments: list[imp.Assignment] = []
        self.generate_missing = True
        self.src_small: np.ndarray | None = None
        self.full_size: tuple[int, int] | None = None
        self.base: dict[str, np.ndarray] | None = None
        self.last: dict[str, np.ndarray] | None = None
        self.last_adjust: dict | None = None
        self.dirty = False
        self.saving = False
        self._base_stale = True
        self.preview_px = int(hub.settings.get("preview_px") or 768)
        self._debounce = Debouncer(110, self._run_preview, self)

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)
        self.header = QWidget()
        self.header.setObjectName("Header")
        self.header.setProperty("dragArea", True)
        self.header.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.header.setFixedHeight(52)
        hl = QHBoxLayout(self.header)
        hl.setContentsMargins(12, 0, 8, 0)
        hl.setSpacing(8)
        self.b_back = button("Library", "prev", "ghost", "Back to the library (Esc)", self.leave)
        hl.addWidget(self.b_back)
        hl.addWidget(label("/", "faint"))
        self.h_title = label("New material", "crumbNow")
        hl.addWidget(self.h_title)
        hl.addStretch(1)
        hl.addSpacing(146)          # caption buttons
        root.addWidget(self.header)

        body = QHBoxLayout()
        body.setContentsMargins(20, 18, 0, 0)
        body.setSpacing(0)
        left = QVBoxLayout()
        left.setSpacing(10)
        self.card = ViewerCard(height=360)
        self.card.view.set_option("tiling", 2.0)
        self.card.view.set_option("displacement", float(hub.settings.get("displacement") or 0.35))
        self.card.view.set_option("light", hub.settings.get("light") or "studio")
        left.addWidget(self.card, 1)
        self.strip = MapStrip()
        self.strip.chosen.connect(self.card.set_mode)
        self.card.modeChanged = lambda k: self.strip.set_active(k)
        srow = QHBoxLayout()
        srow.addWidget(self.strip)
        srow.addStretch(1)
        self.status = label("", "muted")
        srow.addWidget(self.status)
        left.addLayout(srow)
        left.addSpacing(18)
        lw = QWidget()
        lw.setLayout(left)
        body.addWidget(lw, 1)
        body.addSpacing(20)

        panel = QWidget()
        panel.setObjectName("Inspector")
        panel.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        panel.setFixedWidth(380)
        pl = QVBoxLayout(panel)
        pl.setContentsMargins(0, 0, 0, 0)
        pl.setSpacing(0)
        self.controls_scroll = QScrollArea()
        self.controls_scroll.setWidgetResizable(True)
        self.controls_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        pl.addWidget(self.controls_scroll, 1)
        self.save_box = QWidget()
        self.save_box.setObjectName("Foot")
        self.save_box.setStyleSheet(f"QWidget#Foot {{ border-top: 1px solid {theme.LINE}; }}")
        self.save_box.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        sb = QVBoxLayout(self.save_box)
        sb.setContentsMargins(16, 12, 16, 14)
        sb.setSpacing(8)
        self.save_mode = Segmented([("replace", "Replace"), ("copy", "Save as copy")], "replace", height=32)
        self.save_mode.changed.connect(self._save_mode_changed)
        sb.addWidget(self.save_mode)
        self.e_name = QLineEdit()
        self.e_name.setPlaceholderText("Name")
        self.e_name.textEdited.connect(self._touch)
        self.e_name.setFixedHeight(32)
        self.e_cat = CategoryPicker()
        self.e_cat.picked.connect(self._touch)
        self.e_tags = TagInput()
        self.e_tags.changed.connect(self._touch)
        form = QGridLayout()
        form.setHorizontalSpacing(10)
        form.setVerticalSpacing(8)
        for row, (text, w) in enumerate((("Name", self.e_name), ("Category", self.e_cat), ("Tags", self.e_tags))):
            lb = label(text)
            lb.setStyleSheet(f"color: {theme.MUTED}; font-size: 12px;")
            lb.setFixedWidth(62)
            form.addWidget(lb, row, 0, Qt.AlignmentFlag.AlignLeft | (Qt.AlignmentFlag.AlignTop if w is self.e_tags
                                                                     else Qt.AlignmentFlag.AlignVCenter))
            form.addWidget(w, row, 1)
            if w is self.e_tags:
                lb.setContentsMargins(0, 9, 0, 0)
        sb.addLayout(form)
        self.r_size = ChoiceRow("Output size", OUTPUT_SIZES, str(hub.settings.get("default_output_px") or 2048))
        self.r_size.changed.connect(lambda v: (self.hub.settings.set("default_output_px", int(v)), self._update_status()))
        sb.addWidget(self.r_size)
        self.progress = QProgressBar()
        self.progress.setRange(0, 1000)
        self.progress.setTextVisible(False)
        self.progress.hide()
        self.p_text = label("", "muted")
        self.p_text.hide()
        sb.addWidget(self.progress)
        sb.addWidget(self.p_text)
        br = QHBoxLayout()
        self.b_discard = button("Discard", None, "ghost", on_click=self.discard)
        self.b_save = button("Save to library", "check", "primary", on_click=self.save)
        br.addWidget(self.b_discard)
        br.addStretch(1)
        br.addWidget(self.b_save)
        sb.addLayout(br)
        pl.addWidget(self.save_box)
        body.addWidget(panel)
        root.addLayout(body, 1)
        self.controls_host: QWidget | None = None

    # ================================================================ starting
    def _reset(self, mode: str) -> None:
        self.mode = mode
        self.draft = None
        self.material_id = None
        self.source = None
        self.source_label = ""
        self.params = GenParams()
        self.adjust = adj.neutral()
        self.assignments = []
        self.generate_missing = True
        self.src_small = self.base = self.last = self.last_adjust = None
        self.full_size = None
        self._base_stale = True
        self.dirty = False
        self.saving = False
        self._score = None
        self._ms = None
        self.card.view.set_maps(None)
        self.strip.set_maps(None)
        self.status.setText("")
        self.generated_text = ""
        self.generated_note = None
        self.draft_from_list = False
        self.progress.hide()
        self.p_text.hide()
        self.b_save.setEnabled(True)
        self.card.loading(None)              # skeleton until the first preview is ready

    def _set_meta(self, name: str, category: str, tags: list[str]) -> None:
        """Fills name, category and tags. Programmatic: never counts as a change (no 'Keep changes?' prompt)."""
        lib = self.hub.library
        self.e_name.setText(name)
        self.e_cat.set_categories([c for c, _ in lib.categories()] if lib else [], category or UNCATEGORIZED)
        self.e_tags.set_suggestions([t for t, _ in lib.tags()] if lib else [])
        self.e_tags.setTags(tags)

    def start_photo(self, path: str, category: str | None = None) -> None:
        self._reset("photo")
        name = nice_name(path)
        self.params = for_preset(guess_preset(name))
        self.draft = self.hub.drafts.new("photo", source=path, name=name, category=category or "",
                                         generation=self.params.to_dict())
        self.hub.draftsChanged.emit()
        self.source = str(self.draft.source)
        self.source_label = Path(path).name
        self._set_meta(name, category or UNCATEGORIZED, [])
        self.dirty = False
        self._enter()

    def start_regenerate(self, mid: str) -> None:
        lib = self.hub.library
        m = lib.get(mid)
        if m.source_path is None:
            self.hub.error(f"{m.name} has no source photo to regenerate from.")
            return
        self._reset("regenerate")
        self.material_id = mid
        self.source = str(m.source_path)
        self.params = GenParams.from_dict(m.generation)
        self._set_meta(m.name, m.category, m.tags)
        self._enter()

    def start_import(self, paths: list[str], category: str | None = None) -> None:
        self._reset("import")
        paths = [str(p) for p in paths][:imp.MAX_FILES]
        guessed = imp.guess_all(paths)
        self.draft = self.hub.drafts.new("import", files=paths,
                                         assignments=[{"file": a.path, "role": a.role, "convention": a.convention}
                                                      for a in guessed])
        self.hub.draftsChanged.emit()
        self.assignments = [imp.Assignment(str(self.hub.drafts.file_path(self.draft, d["file"])), d["role"],
                                           d.get("convention", "gl")) for d in self.draft.assignments]
        albedo = next((a for a in self.assignments if a.role == "albedo"), None)
        name = nice_name(albedo.path if albedo else paths[0])
        name = re.sub(r"\b(Normal|Rough(ness)?|Metal(lic|ness)?|Height|Displacement|Ao|Orm|Gl|Dx)\b", "", name).strip() or name
        self.params = for_preset(guess_preset(name))
        self._set_meta(name, category or UNCATEGORIZED, [])
        self.dirty = False
        self._enter()

    def start_adjust(self, mid: str) -> None:
        lib = self.hub.library
        m = lib.get(mid)
        self._reset("adjust")
        self.material_id = mid
        self.adjust = adj.normalize(m.adjustments)
        self._set_meta(m.name, m.category, m.tags)
        self._enter()

    def open_draft(self, d: Draft) -> None:
        lib = self.hub.library
        m = None
        if d.kind in ("adjust", "regenerate"):
            if not lib or d.material_id not in {x.id for x in lib.all()}:
                self.hub.error("The material of this draft is no longer in the library.")
                return
            m = lib.get(d.material_id)
        if d.kind == "adjust":
            self._reset("adjust")
            self.material_id = d.material_id
            self.adjust = adj.normalize(d.adjustments)
        elif d.kind == "regenerate":
            if m.source_path is None:
                self.hub.error(f"{m.name} has no source photo any more.")
                return
            self._reset("regenerate")
            self.material_id = d.material_id
            self.source = str(m.source_path)
            self.params = GenParams.from_dict(d.generation)
        elif d.kind == "import":
            self._reset("import")
            self.assignments = [imp.Assignment(str(self.hub.drafts.file_path(d, a["file"])), a["role"],
                                               a.get("convention", "gl")) for a in d.assignments]
            self.params = GenParams.from_dict(d.generation)
            self.adjust = adj.normalize(d.adjustments)
        else:
            if d.source is None:
                self.hub.error("This draft's photo is missing.")
                return
            self._reset("photo")
            self.source = str(d.source)
            self.params = GenParams.from_dict(d.generation)
        self.draft = d
        self._set_meta(d.name or (m.name if m else "New material"), d.category or (m.category if m else UNCATEGORIZED),
                       d.tags or (m.tags if m else []))
        self.dirty = False
        self.draft_from_list = True           # reopened from Drafts: leaving unchanged keeps it
        self._enter()

    def _enter(self) -> None:
        titles = {"photo": "New material from photo", "regenerate": "Regenerate from photo",
                  "import": "Import map set", "adjust": "Adjust maps"}
        t = titles[self.mode]
        if self.mode in ("regenerate", "adjust") and self.material_id:
            t += f" — {self.hub.library.get(self.material_id).name}"
        self.h_title.setText(t)
        self.save_mode.setVisible(self.mode == "adjust")
        self.save_mode.setValue("replace")
        self.r_size.setVisible(self.mode in ("photo", "regenerate"))
        self.b_save.setText({"photo": "Save to library", "import": "Save to library",
                             "regenerate": "Replace maps", "adjust": "Save"}[self.mode])
        self._save_mode_changed(self.save_mode.value())
        self._build_controls()
        self.status.setText("Loading…")
        if self.mode in ("photo", "regenerate"):
            self.hub.runner.run("editor-src", job_load_source, self.source, self.preview_px,
                                on_done=self._source_loaded, on_error=self._failed_load)
        elif self.mode == "adjust":
            self.hub.runner.run("editor-src", job_load_base, self.hub.library, self.material_id, self.preview_px,
                                on_done=self._base_loaded, on_error=self._failed_load)
        else:
            self._run_preview()

    def _failed_load(self, msg: str) -> None:
        self.status.setText("")
        self.hub.error(msg)

    def _source_loaded(self, result) -> None:
        self.src_small, self.full_size = result
        self._update_status()
        self._run_preview()

    def _base_loaded(self, result) -> None:
        self.base, self.full_size = result
        self._update_status()
        self._run_preview()

    # ================================================================ controls
    def _section(self, lay: QVBoxLayout, text: str) -> None:
        lb = label(text, "section")
        lb.setContentsMargins(0, 16, 0, 6)
        lay.addWidget(lb)

    def _build_controls(self) -> None:
        host = QWidget()
        lay = QVBoxLayout(host)
        lay.setContentsMargins(16, 6, 16, 16)
        lay.setSpacing(6)
        self.sliders: dict[str, FillSlider] = {}
        self.rows: dict[str, Any] = {}
        if self.mode in ("photo", "regenerate"):
            self._build_photo(lay)
        elif self.mode == "import":
            self._build_import(lay)
            self._build_adjust(lay)
        else:
            self._build_adjust(lay)
        lay.addStretch(1)
        self.controls_scroll.setWidget(host)
        self.controls_host = host

    def _slider(self, lay, key: str, target: str = "gen") -> FillSlider:
        text, lo, hi, step, dec = RANGES[key]
        default = getattr(for_preset(self.params.preset), key)
        s = FillSlider(text, lo, hi, getattr(self.params, key), step, dec, default)
        s.valueChanged.connect(lambda v, k=key: self._gen_changed(k, v))
        lay.addWidget(s)
        self.sliders[key] = s
        return s

    def _build_photo(self, lay: QVBoxLayout) -> None:
        src = QWidget()
        sl = QHBoxLayout(src)
        sl.setContentsMargins(0, 10, 0, 0)
        sl.setSpacing(10)
        self.src_thumb = QLabel()
        self.src_thumb.setFixedSize(56, 56)
        self.src_thumb.setScaledContents(True)
        self.src_thumb.setStyleSheet(f"border: 1px solid {theme.LINE_2}; border-radius: 6px;")
        sl.addWidget(self.src_thumb)
        col = QVBoxLayout()
        col.setSpacing(2)
        self.src_name = label(self.source_label or (Path(self.source).name if self.source else ""))
        self.src_dims = label("", "muted")
        col.addWidget(self.src_name)
        col.addWidget(self.src_dims)
        sl.addLayout(col, 1)
        if self.mode == "photo":
            sl.addWidget(button("Change…", "photo", on_click=self._change_photo))
        lay.addWidget(src)

        self._section(lay, "MATERIAL TYPE")
        self.rows["preset"] = ChoiceRow("Type", [(k, v[0]) for k, v in PRESETS.items()], self.params.preset)
        self.rows["preset"].changed.connect(self._preset_changed)
        lay.addWidget(self.rows["preset"])

        self._section(lay, "SEAMLESS")
        self.rows["seamless"] = ChoiceRow("Make seamless", [(m, SEAMLESS_LABELS[m]) for m in MODES], self.params.seamless)
        self.rows["seamless"].changed.connect(lambda v: self._gen_changed("seamless", v))
        lay.addWidget(self.rows["seamless"])
        self._slider(lay, "blend_width").setVisible(self.params.seamless == "blend")

        self._section(lay, "LIGHTING")
        self._slider(lay, "delight")
        self._slider(lay, "delight_radius")
        self._section(lay, "HEIGHT")
        self._slider(lay, "height_detail")
        self._slider(lay, "height_smooth")
        self._slider(lay, "height_contrast")
        self.rows["invert_height"] = ToggleRow("Invert height", self.params.invert_height)
        self.rows["invert_height"].toggled.connect(lambda v: self._gen_changed("invert_height", v))
        lay.addWidget(self.rows["invert_height"])
        self._section(lay, "NORMAL")
        self._slider(lay, "normal_strength")
        self._section(lay, "SURFACE")
        self._slider(lay, "roughness")
        self._slider(lay, "roughness_variation")
        self._slider(lay, "metallic")
        self._section(lay, "AMBIENT OCCLUSION")
        self._slider(lay, "ao_strength")
        self._slider(lay, "ao_radius")
        lay.addSpacing(10)
        lay.addWidget(button("Reset to type defaults", "restore", "ghost", on_click=lambda: self._preset_changed(self.params.preset)))
        if self.source:
            self._show_source_thumb()

    def _show_source_thumb(self) -> None:
        # decode a small version only: source photos can be 100 MB
        reader = QImageReader(self.source)
        reader.setAutoTransform(True)
        size = reader.size()
        if size.isValid() and size.width() > 0 and size.height() > 0:
            s = 112 / min(size.width(), size.height())
            reader.setScaledSize(QSize(max(1, round(size.width() * s)), max(1, round(size.height() * s))))
        img = reader.read()
        if not img.isNull():
            self.src_thumb.setPixmap(QPixmap.fromImage(img))

    def _build_import(self, lay: QVBoxLayout) -> None:
        self._section(lay, "FILES")
        self.file_rows = QVBoxLayout()
        self.file_rows.setSpacing(6)
        lay.addLayout(self.file_rows)
        self._fill_file_rows()
        self.generated_note = label("Reading the files…", "muted", wrap=True)
        self.generated_note.setStyleSheet(f"font-size: 12px; color: {theme.MUTED};")
        lay.addWidget(self.generated_note)
        row = QHBoxLayout()
        row.addWidget(button("Add files…", "import", on_click=self._add_files))
        row.addStretch(1)
        lay.addLayout(row)
        self.rows["missing"] = ToggleRow("Generate missing maps", self.generate_missing)
        self.rows["missing"].toggled.connect(self._missing_changed)
        lay.addWidget(self.rows["missing"])
        self.rows["preset"] = ChoiceRow("Type (for generated maps)", [(k, v[0]) for k, v in PRESETS.items()],
                                        self.params.preset)
        self.rows["preset"].changed.connect(self._import_preset)
        lay.addWidget(self.rows["preset"])

    def _fill_file_rows(self) -> None:
        clear_layout(self.file_rows)
        for i, a in enumerate(self.assignments):
            w = QWidget()
            hl = QHBoxLayout(w)
            hl.setContentsMargins(0, 0, 0, 0)
            hl.setSpacing(6)
            name = ElidedLabel(Path(a.path).name)
            name.setMinimumWidth(60)
            name.setStyleSheet(f"color: {theme.TEXT_2}; font-size: 12px;")
            hl.addWidget(name, 1)
            role = QComboBox()
            for r in imp.ROLES:
                role.addItem(ROLE_SHORT[r], r)
                role.setItemData(role.count() - 1, imp.ROLE_LABELS[r], Qt.ItemDataRole.ToolTipRole)
            role.setCurrentIndex(imp.ROLES.index(a.role))
            role.setFixedWidth(118)
            role.currentIndexChanged.connect(lambda _i, idx=i, box=role: self._role_changed(idx, box.currentData()))
            hl.addWidget(role)
            conv = QComboBox()
            conv.addItem("GL", "gl")
            conv.addItem("DX", "dx")
            conv.setCurrentIndex(0 if a.convention == "gl" else 1)
            conv.setFixedWidth(68)
            conv.setEnabled(a.role == "normal")
            conv.setToolTip("Normal map convention: OpenGL (+Y up) or DirectX (flipped on import)")
            conv.currentIndexChanged.connect(lambda _i, idx=i, box=conv: self._conv_changed(idx, box.currentData()))
            hl.addWidget(conv)
            self.file_rows.addWidget(w)

    def _build_adjust(self, lay: QVBoxLayout) -> None:
        self.adjust_widgets: dict[tuple[str, str], Any] = {}
        for mname, ctrls in adj.CONTROLS.items():
            self._section(lay, ADJUST_TITLES[mname])
            for key, spec in ctrls.items():
                text, lo, hi, neutral, step, dec = spec
                if dec == "bool":
                    w = ToggleRow(text, bool(self.adjust[mname][key]))
                    w.toggled.connect(lambda v, m=mname, k=key: self._adjust_changed(m, k, v))
                else:
                    w = FillSlider(text, lo, hi, float(self.adjust[mname][key]), step, dec, neutral,
                                   "°" if key == "hue" else "")
                    w.valueChanged.connect(lambda v, m=mname, k=key: self._adjust_changed(m, k, v))
                self.adjust_widgets[(mname, key)] = w
                lay.addWidget(w)
        self._section(lay, "OUTPUT")
        self.rows["out"] = ChoiceRow("Output size", [(s, "Keep" if s == "keep" else f"{s} px") for s in adj.OUTPUT_SIZES],
                                     self.adjust["output_size"])
        self.rows["out"].changed.connect(lambda v: self._adjust_changed(None, "output_size", v))
        lay.addWidget(self.rows["out"])
        lay.addSpacing(10)
        lay.addWidget(button("Reset adjustments", "restore", "ghost", on_click=self._reset_adjust))

    # ================================================================ changes
    def _touch(self, *_):
        self.dirty = True

    def _gen_changed(self, key: str, value) -> None:
        setattr(self.params, key, value)
        if key == "seamless" and "blend_width" in self.sliders:
            self.sliders["blend_width"].setVisible(value == "blend")
        self.dirty = True
        self._debounce()

    def _preset_changed(self, preset: str) -> None:
        keep = {k: getattr(self.params, k) for k in ("seamless", "blend_width")}
        self.params = for_preset(preset, **keep)
        for key, s in self.sliders.items():
            s.default = getattr(for_preset(preset), key)
            s.setValue(getattr(self.params, key))
        if "invert_height" in self.rows:
            self.rows["invert_height"].setChecked(self.params.invert_height)
        if "preset" in self.rows:
            self.rows["preset"].setValue(preset)
        self.dirty = True
        self._debounce()

    def _import_preset(self, preset: str) -> None:
        self.params = for_preset(preset)
        self._base_stale = True
        self.dirty = True
        self._debounce()

    def _missing_changed(self, on: bool) -> None:
        self.generate_missing = on
        self._base_stale = True
        self.dirty = True
        self._debounce()

    def _role_changed(self, idx: int, role: str) -> None:
        self.assignments[idx].role = role
        self._base_stale = True
        self.dirty = True
        self._fill_file_rows()
        self._debounce()

    def _conv_changed(self, idx: int, conv: str) -> None:
        self.assignments[idx].convention = conv
        self._base_stale = True
        self.dirty = True
        self._debounce()

    def _adjust_changed(self, mname: str | None, key: str, value) -> None:
        if mname is None:
            self.adjust[key] = value
        else:
            self.adjust[mname][key] = value
        self.dirty = True
        self._debounce()

    def _reset_adjust(self) -> None:
        self.adjust = adj.neutral()
        for (m, k), w in self.adjust_widgets.items():
            if isinstance(w, ToggleRow):
                w.setChecked(bool(self.adjust[m][k]))
            else:
                w.setValue(float(self.adjust[m][k]))
        self.rows["out"].setValue("keep")
        self.dirty = True
        self._debounce()

    def _change_photo(self) -> None:
        path = pick_photo(self, self.hub)
        if not path:
            return
        if self.draft:
            self.hub.drafts.discard(self.draft.id)
        self.draft = self.hub.drafts.new("photo", source=path, name=self.e_name.text(), generation=self.params.to_dict())
        self.source = str(self.draft.source)
        self.source_label = Path(path).name
        self.src_name.setText(self.source_label)
        self._show_source_thumb()
        self.status.setText("Loading…")
        self.hub.runner.run("editor-src", job_load_source, self.source, self.preview_px,
                            on_done=self._source_loaded, on_error=self._failed_load)

    def _add_files(self) -> None:
        paths = pick_maps(self, self.hub)
        if not paths:
            return
        room = imp.MAX_FILES - len(self.assignments)
        paths = paths[:max(0, room)]
        existing = {a.role for a in self.assignments if a.role != "ignore"}
        extra = self.hub.drafts.new("import", files=paths)   # keep stable copies next to the draft
        for p in paths:
            role, conv = imp.guess(p)
            if role in existing:
                role = "ignore"
            self.assignments.append(imp.Assignment(str(self.hub.drafts.file_path(extra, Path(p).name)), role, conv))
        self._extra_drafts = getattr(self, "_extra_drafts", []) + [extra.id]
        self._base_stale = True
        self.dirty = True
        self._fill_file_rows()
        self._debounce()

    # ================================================================ preview
    def _run_preview(self) -> None:
        if self.mode in ("photo", "regenerate"):
            if self.src_small is None:
                return
            self.status.setText("Updating…")
            self.hub.runner.run("editor-preview", job_photo_preview, self.src_small, GenParams(**self.params.to_dict()),
                                on_done=self._preview_done, on_error=self._preview_failed)
        elif self.mode == "import":
            if self._base_stale:
                self.status.setText("Reading maps…")
                self._base_stale = False
                self.hub.runner.run("editor-base", job_assemble_preview, [imp.Assignment(a.path, a.role, a.convention)
                                                                          for a in self.assignments],
                                    GenParams(**self.params.to_dict()), self.generate_missing, self.preview_px,
                                    on_done=self._import_base_done, on_error=self._preview_failed)
            elif self.base is not None:
                self._run_adjust_preview()
        elif self.base is not None:
            self._run_adjust_preview()

    def _run_adjust_preview(self) -> None:
        params = adj.clone(self.adjust)
        prev, prev_params = (self.last, self.last_adjust) if self.last is not None else (None, None)
        self.status.setText("Updating…")
        self.hub.runner.run("editor-preview", job_adjust_preview, self.base, params, prev, prev_params,
                            on_done=lambda r, p=params: self._adjust_done(r, p), on_error=self._preview_failed)

    def _import_base_done(self, result) -> None:
        self.base, generated, self.full_size = result
        self.last = self.last_adjust = None
        self.generated_text = ", ".join(generated)
        if getattr(self, "generated_note", None) is not None:
            self.generated_note.setText(f"Made from the albedo: {self.generated_text}." if generated else
                                        "Every map comes from your files.")
        self._run_adjust_preview()

    def _adjust_done(self, result, params) -> None:
        self.last_adjust = params
        self._preview_done(result)

    def _preview_done(self, result) -> None:
        maps, u8, score, ms = result
        self.last = maps
        self.card.view.set_maps(maps, u8)
        self.strip.set_maps(maps)
        self.card.loaded()
        self._score = score
        self._ms = ms
        self._update_status()

    def _preview_failed(self, msg: str) -> None:
        self.status.setText("")
        self.card.loaded()
        self.hub.error(msg)

    def _update_status(self) -> None:
        parts = []
        score = getattr(self, "_score", None)
        if score is not None and self.last is not None:
            verdict = "invisible" if score < 1.2 else ("faint" if score <= 1.5 else "visible")
            parts.append(f"Seam {score:.2f}× ({verdict})")
        if self.full_size:
            w, h = self.full_size
            if self.mode in ("photo", "regenerate"):
                edge = int(self.r_size.value())
                s = edge / max(w, h)
                parts.append(f"saves {round(w * s)} × {round(h * s)}" + (" (upscaled)" if s > 1.01 else ""))
            else:
                tw, th = adj.target_size((h, w), self.adjust.get("output_size", "keep"))
                parts.append(f"saves {tw} × {th}")
        if getattr(self, "_ms", None):
            parts.append(f"{self._ms:.0f} ms")
        self.status.setText("  ·  ".join(parts))
        if score is not None and score > 1.5:
            self.status.setStyleSheet(f"color: {theme.STAR};")
        else:
            self.status.setStyleSheet("")

    # ================================================================ save / leave
    def _save_mode_changed(self, mode: str) -> None:
        # name, category and tags stay editable in every mode; "Replace" applies them to the material itself
        if self.mode == "adjust" and self.material_id:
            base = self.hub.library.get(self.material_id).name
            if mode == "copy" and self.e_name.text() == base:
                self.e_name.setText(f"{base} adjusted")
            elif mode == "replace" and self.e_name.text() == f"{base} adjusted":
                self.e_name.setText(base)

    def save(self) -> None:
        lib = self.hub.library
        if self.saving or not lib:
            return
        name = self.e_name.text().strip() or "New material"
        cat = self.e_cat.value() or UNCATEGORIZED
        tags = self.e_tags.tags()
        if self.mode == "import" and not any(a.role != "ignore" for a in self.assignments):
            self.hub.error("Assign at least one file to a map.")
            return
        self.saving = True
        self.b_save.setEnabled(False)
        self.progress.setValue(0)
        self.progress.show()
        self.p_text.show()
        self.p_text.setText("Saving…")
        prog = lambda f, s: (self.progress.setValue(int(f * 1000)), self.p_text.setText(s))  # noqa: E731
        params = GenParams(**self.params.to_dict())
        if self.mode == "photo":
            self.hub.runner.run("save", job_save_photo, lib, self.source, params, int(self.r_size.value()), name, cat, tags,
                                on_done=self._saved, on_error=self._save_failed, on_progress=prog)
        elif self.mode == "regenerate":
            self.hub.runner.run("save", job_save_photo, lib, self.source, params, int(self.r_size.value()), name, cat, tags,
                                replace_id=self.material_id, on_done=self._saved, on_error=self._save_failed,
                                on_progress=prog)
        elif self.mode == "import":
            self.hub.runner.run("save", job_save_import, lib, [imp.Assignment(a.path, a.role, a.convention)
                                                               for a in self.assignments],
                                params, self.generate_missing, adj.clone(self.adjust), name, cat, tags,
                                on_done=self._saved, on_error=self._save_failed, on_progress=prog)
        else:
            self.hub.runner.run("save", job_save_adjust, lib, self.material_id, adj.clone(self.adjust),
                                self.save_mode.value(), name, cat, tags,
                                on_done=self._saved, on_error=self._save_failed, on_progress=prog)

    def _saved(self, mid: str) -> None:
        self.saving = False
        self.progress.hide()
        self.p_text.hide()
        self.b_save.setEnabled(True)
        self._drop_drafts()
        self.dirty = False
        self.hub.changed.emit()
        self.hub.materialSaved.emit(mid)
        self.hub.notify(f"Saved {self.hub.library.get(mid).name}", "ok")
        self.closed.emit(mid)

    def _save_failed(self, msg: str) -> None:
        self.saving = False
        self.b_save.setEnabled(True)
        self.progress.hide()
        self.p_text.setText(msg)
        self.p_text.setStyleSheet(f"color: {theme.DANGER};")
        self.hub.error(f"Saving failed: {msg}")

    def _drop_drafts(self) -> None:
        if self.draft:
            self.hub.drafts.discard(self.draft.id)
            self.draft = None
        for did in getattr(self, "_extra_drafts", []):
            self.hub.drafts.discard(did)
        self._extra_drafts = []
        self.hub.draftsChanged.emit()

    def _keep_draft(self) -> None:
        meta = dict(name=self.e_name.text().strip(), category=self.e_cat.value(),
                    tags=self.e_tags.tags(), generation=self.params.to_dict(), adjustments=adj.clone(self.adjust))
        if self.draft is None:
            self.draft = self.hub.drafts.new(self.mode, material_id=self.material_id, **meta)
        else:
            for k, v in meta.items():
                setattr(self.draft, k, v)
        if self.mode == "import":
            files_dir = self.draft.folder / "files"
            files_dir.mkdir(exist_ok=True)
            out = []
            for a in self.assignments:
                p = Path(a.path)
                if p.parent != files_dir and p.exists():
                    target = files_dir / p.name
                    if not target.exists():
                        shutil.copy2(p, target)
                    p = target
                out.append({"file": p.name, "role": a.role, "convention": a.convention})
            self.draft.assignments = out
            for did in getattr(self, "_extra_drafts", []):
                self.hub.drafts.discard(did)
            self._extra_drafts = []
        self.hub.drafts.save(self.draft)
        self.hub.draftsChanged.emit()

    def leave(self) -> bool:
        """Back to the library; asks what to do with unsaved work. Returns False if cancelled."""
        if self.saving:
            self.hub.notify("Saving is still running.", "warn")
            return False
        if self.dirty:
            choice = ask(self, "Keep your changes?",
                         "This material is not saved. Keep it as a draft to continue later, or discard it.",
                         [("cancel", "Cancel", "ghost"), ("discard", "Discard", "danger"), ("keep", "Keep as draft", "primary")],
                         "keep")
            if choice in ("", "cancel"):
                return False
            if choice == "keep":
                self._keep_draft()
                self.hub.notify("Kept as a draft. Find it under Drafts.", "info")
            else:
                self._drop_drafts()
        else:
            # nothing changed: no question. A brand-new, untouched photo / import is simply dropped;
            # a draft reopened from Drafts stays as it was.
            if self.mode in ("photo", "import") and not self.draft_from_list:
                self._drop_drafts()
        self.dirty = False
        self.card.view.set_option("spin", False)
        self.closed.emit(None)
        return True

    def discard(self) -> None:
        if self.dirty and ask(self, "Discard this material?", "Your settings for this material are lost.",
                              [("cancel", "Cancel", "ghost"), ("discard", "Discard", "danger")]) != "discard":
            return
        self._drop_drafts()
        self.dirty = False
        self.closed.emit(None)


# ---------------------------------------------------------------- file pickers
PHOTO_FILTER = "Images (*.jpg *.jpeg *.png *.webp *.bmp *.tif *.tiff *.tga)"


def pick_photo(parent, hub: Hub) -> str | None:
    start = hub.settings.get("last_folder") or str(Path.home())
    path, _ = QFileDialog.getOpenFileName(parent, "New material from photo", start, PHOTO_FILTER)
    if path:
        hub.settings.set("last_folder", str(Path(path).parent))
    return path or None


def pick_maps(parent, hub: Hub) -> list[str]:
    start = hub.settings.get("last_folder") or str(Path.home())
    paths, _ = QFileDialog.getOpenFileNames(parent, "Import map set (up to 24 files)", start, PHOTO_FILTER)
    if paths:
        hub.settings.set("last_folder", str(Path(paths[0]).parent))
    return paths[:imp.MAX_FILES]

