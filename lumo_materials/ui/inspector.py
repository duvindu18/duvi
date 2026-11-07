"""Right panel: the selected material in 3D, its maps, preview controls, details and actions."""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QSize, Qt, Signal
from PySide6.QtGui import QFontMetrics, QImage, QPixmap
from PySide6.QtWidgets import QFrame, QGridLayout, QHBoxLayout, QLabel, QMenu, QScrollArea, QVBoxLayout, QWidget

from ..engine.imageio import fit_within, to_uint8
from ..library.store import Material
from . import icons, meshes, theme
from .hub import Hub
from .library_page import ago
from .viewer import BACKGROUNDS, DISPLAY, LIGHTS, SHAPES, MaterialView
from .widgets import ChoiceRow, FillSlider, Segmented, button, clear_layout, label


def gray_or_rgb_pixmap(a: np.ndarray, size: int) -> QPixmap:
    u = to_uint8(fit_within(a, size))
    if u.ndim == 2:
        u = np.repeat(u[..., None], 3, axis=2)
    u = np.ascontiguousarray(u)
    img = QImage(u.tobytes(), u.shape[1], u.shape[0], u.shape[1] * 3, QImage.Format.Format_RGB888).copy()
    return QPixmap.fromImage(img)


def maps_signature(m: Material) -> tuple:
    try:
        stamp = (m.folder / "albedo.png").stat().st_mtime_ns
    except OSError:
        stamp = 0
    return str(m.folder), stamp, m.width, m.height


class ClickLabel(QLabel):
    clicked = Signal()

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self.clicked.emit()


class MapStrip(QWidget):
    """Six small map thumbnails; clicking one shows only that map in the viewer (click again: lit)."""
    chosen = Signal(str)

    NAMES = [("albedo", "Albedo"), ("normal", "Normal"), ("roughness", "Rough"), ("metallic", "Metal"),
             ("height", "Height"), ("ao", "AO")]

    def __init__(self, parent=None):
        super().__init__(parent)
        lay = QGridLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setHorizontalSpacing(6)
        lay.setVerticalSpacing(4)
        self.thumbs: dict[str, QLabel] = {}
        self.active = "lit"
        for i, (key, text) in enumerate(self.NAMES):
            t = ClickLabel()
            t.setFixedSize(46, 46)
            t.setScaledContents(True)
            t.setCursor(Qt.CursorShape.PointingHandCursor)
            t.setToolTip(f"Show only the {text.lower()} map")
            t.clicked.connect(lambda k=key: self._click(k))
            self.thumbs[key] = t
            lay.addWidget(t, 0, i, Qt.AlignmentFlag.AlignHCenter)
            lb = label(text)
            lb.setStyleSheet(f"font-size: 10px; color: {theme.MUTED};")
            lb.setAlignment(Qt.AlignmentFlag.AlignCenter)
            lay.addWidget(lb, 1, i)
        self._style()

    def _click(self, key: str):
        self.active = "lit" if self.active == key else key
        self._style()
        self.chosen.emit(self.active)

    def set_active(self, key: str) -> None:
        self.active = key
        self._style()

    def _style(self):
        for k, t in self.thumbs.items():
            col = "#d8d8db" if k == self.active else theme.LINE
            t.setStyleSheet(f"border: 1px solid {col}; border-radius: 6px; background: #111112;")

    def set_maps(self, maps: dict[str, np.ndarray] | None) -> None:
        for k, t in self.thumbs.items():
            if maps and k in maps:
                t.setPixmap(gray_or_rgb_pixmap(maps[k], 92))
            else:
                t.clear()


class ViewerCard(QFrame):
    """MaterialView with the shape switch and spin button on top."""

    def __init__(self, parent=None, height: int = 250):
        super().__init__(parent)
        self.setStyleSheet(f"ViewerCard {{ border: 1px solid {theme.LINE}; border-radius: 10px; background: #121214; }}")
        self.view = MaterialView()
        lay = QVBoxLayout(self)
        lay.setContentsMargins(1, 1, 1, 1)
        lay.addWidget(self.view)
        if height:
            self.setMinimumHeight(height)
        self.shape = Segmented(SHAPES, "sphere", self)
        self.shape.setStyleSheet(self.shape.styleSheet() + "Segmented { background: #121214; }")
        self.shape.changed.connect(lambda k: self.view.set_option("shape", k))
        self.shape.adjustSize()          # positioned by hand (not in a layout), so it must size itself
        self.shape.move(10, 10)
        self.spin = button("", "regen", "ghost", "Spin", checkable=True)
        self.spin.setParent(self)
        self.spin.setFixedSize(28, 28)
        self.spin.toggled.connect(lambda on: self.view.set_option("spin", on))
        self.mode = button("Lit", None, "ghost")
        self.mode.setParent(self)
        self.mode.setStyleSheet("font-size: 11px; min-height: 26px; padding: 0 8px; font-weight: 400;")
        self.mode.clicked.connect(self._mode_menu)
        self.view.usingFallback.connect(lambda _r: self.spin.setEnabled(False))

    def _mode_menu(self):
        m = QMenu(self)
        for key, text in DISPLAY:
            a = m.addAction(text)
            a.setCheckable(True)
            a.setChecked(self.view.state.mode == key)
            a.triggered.connect(lambda _=False, k=key: self.set_mode(k))
        m.exec(self.mode.mapToGlobal(self.mode.rect().bottomLeft()))

    def set_mode(self, key: str) -> None:
        self.view.set_option("mode", key)
        self.mode.setText(dict(DISPLAY).get(key, "Lit"))
        self.modeChanged(key)

    def modeChanged(self, key: str) -> None:   # overridden by owners that mirror the mode elsewhere
        pass

    def resizeEvent(self, e):
        super().resizeEvent(e)
        self.spin.move(self.width() - 38, 10)
        self.mode.adjustSize()
        self.mode.move(self.width() - 46 - self.mode.width(), 11)
        self.shape.raise_()
        self.spin.raise_()
        self.mode.raise_()


class Inspector(QWidget):
    action = Signal(str, str)      # (adjust | regenerate | export | details | duplicate | trash | reveal, id)

    def __init__(self, hub: Hub, parent=None):
        super().__init__(parent)
        self.hub = hub
        self.setObjectName("Inspector")
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setFixedWidth(340)
        self.material: Material | None = None
        self.loaded_sig: tuple | None = None
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        self.header = QWidget()
        self.header.setObjectName("Header")
        self.header.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.header.setProperty("dragArea", True)
        self.header.setFixedHeight(52)
        hl = QHBoxLayout(self.header)
        hl.setContentsMargins(16, 0, 0, 0)
        self.title = label("", "h2")
        hl.addWidget(self.title, 1)
        self.b_more = button("", "more", "ghost", "More actions")
        self.b_more.setFixedSize(30, 30)
        self.b_more.clicked.connect(self._more_menu)
        hl.addWidget(self.b_more)
        hl.addSpacing(146)          # caption buttons sit here
        root.addWidget(self.header)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        host = QWidget()
        self.body = QVBoxLayout(host)
        self.body.setContentsMargins(16, 16, 16, 16)
        self.body.setSpacing(0)
        scroll.setWidget(host)
        root.addWidget(scroll, 1)

        self.card = ViewerCard()
        self.card.modeChanged = lambda k: self.strip.set_active(k)
        self.body.addWidget(self.card)
        self.body.addSpacing(10)
        self.strip = MapStrip()
        self.strip.chosen.connect(self.card.set_mode)
        self.body.addWidget(self.strip)

        s = hub.settings
        self.body.addWidget(self._section("PREVIEW"))
        self.r_tiling = FillSlider("Tiling", 0.5, 8.0, float(s.get("tiling") or 2.0), 0.5, 1, 2.0, "×")
        self.r_disp = FillSlider("Displacement", 0.0, 1.0, float(s.get("displacement") or 0.35), 0.01, 2, 0.35, ticks=5)
        self.r_light = ChoiceRow("Light", [(k, v[0]) for k, v in LIGHTS.items()], s.get("light") or "studio")
        self.r_bg = ChoiceRow("Background", [(k, v[0]) for k, v in BACKGROUNDS.items()], s.get("background") or "auto")
        for w in (self.r_tiling, self.r_disp, self.r_light, self.r_bg):
            self.body.addWidget(w)
            self.body.addSpacing(6)
        self.r_tiling.valueChanged.connect(lambda v: self._opt("tiling", v))
        self.r_disp.valueChanged.connect(lambda v: self._opt("displacement", v))
        self.r_light.changed.connect(lambda v: self._opt("light", v))
        self.r_bg.changed.connect(lambda v: self._opt("background", v))
        for k in ("tiling", "displacement", "light", "background"):
            self.card.view.set_option(k, s.get(k) if s.get(k) is not None else self.card.view.state.__dict__[k])

        self.body.addWidget(self._section("DETAILS"))
        self.details = QGridLayout()
        self.details.setHorizontalSpacing(8)
        self.details.setVerticalSpacing(0)
        self.body.addLayout(self.details)
        self.body.addStretch(1)

        foot = QWidget()
        foot.setStyleSheet(f"QWidget#Foot {{ border-top: 1px solid {theme.LINE}; }}")
        foot.setObjectName("Foot")
        foot.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        fl = QHBoxLayout(foot)
        fl.setContentsMargins(16, 12, 16, 12)
        self.b_adjust = button("Adjust maps", "sliders", on_click=lambda: self._emit("adjust"))
        self.b_export = button("Export", "export", "primary", on_click=lambda: self._emit("export"))
        fl.addWidget(self.b_adjust, 1)
        fl.addWidget(self.b_export, 1)
        root.addWidget(foot)

        self.show_material(None)

    def _section(self, text: str) -> QLabel:
        lb = label(text, "section")
        lb.setContentsMargins(0, 18, 0, 8)
        return lb

    def _opt(self, key: str, value) -> None:
        self.card.view.set_option(key, value)
        self.hub.settings.set(key, value)

    def _emit(self, what: str) -> None:
        if self.material:
            self.action.emit(what, self.material.id)

    def _more_menu(self):
        if not self.material:
            return
        m = QMenu(self)
        m.addAction(icons.icon("edit"), "Edit details…", lambda: self._emit("details"))
        if self.material.source_path is not None:
            m.addAction(icons.icon("regen"), "Regenerate from photo…", lambda: self._emit("regenerate"))
        m.addAction(icons.icon("copy"), "Duplicate", lambda: self._emit("duplicate"))
        m.addAction(icons.icon("reveal"), "Show in Explorer", lambda: self._emit("reveal"))
        m.addSeparator()
        m.addAction(icons.icon("trash"), "Move to trash", lambda: self._emit("trash"))
        m.exec(self.b_more.mapToGlobal(self.b_more.rect().bottomLeft()))

    def _set_details(self, rows: list[tuple[str, str, str | None]]) -> None:
        clear_layout(self.details)
        for i, (k, v, colour) in enumerate(rows):
            kl = label(k)
            kl.setStyleSheet(f"color: {theme.MUTED}; font-size: 12px; padding: 6px 0; border-bottom: 1px solid {theme.LINE};")
            vl = label(v)
            vl.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
            vl.setStyleSheet(f"color: {colour or theme.TEXT_2}; font-size: 12px; padding: 6px 0;"
                             f" border-bottom: 1px solid {theme.LINE};")
            vl.setToolTip(v)
            fm = QFontMetrics(vl.font())
            vl.setText(fm.elidedText(v, Qt.TextElideMode.ElideMiddle, 200))
            self.details.addWidget(kl, i, 0)
            self.details.addWidget(vl, i, 1)

    def show_material(self, m: Material | None, reload: bool = True) -> None:
        self.material = m
        has = m is not None
        for w in (self.b_adjust, self.b_export, self.b_more):
            w.setEnabled(has)
        if not has:
            self.loaded_sig = None
            self.title.setText("")
            self.card.view.set_maps(None)
            self.strip.set_maps(None)
            lib = self.hub.library
            self._set_details([("Library", str(lib.root) if lib else "not chosen", None),
                               ("Materials", str(lib.count()) if lib else "0", None)])
            return
        fm = QFontMetrics(self.title.font())
        self.title.setText(fm.elidedText(m.name, Qt.TextElideMode.ElideRight, 140))
        self.title.setToolTip(m.name)
        seam = f"{m.seam_score:.2f}×" if m.seam_score is not None else "?"
        rows = [("Category", m.category, None), ("Resolution", f"{m.width} × {m.height}", None),
                ("Seam score", seam, theme.STAR if (m.seam_score or 0) > 1.5 else None),
                ("Made from", "Photo" if m.origin == "photo" else "Imported maps", None),
                ("Adjusted", "Yes (originals kept)" if m.adjustments else "No", None),
                ("Tags", " · ".join(m.tags) if m.tags else "none", None),
                ("Added", ago(m.created), None)]
        if m.description:
            rows.append(("Description", m.description, None))
        self._set_details(rows)
        if not reload and self.loaded_sig == maps_signature(m):
            return
        self.loaded_sig = maps_signature(m)
        lib = self.hub.library
        mid = m.id

        def load():
            maps = lib.load_maps(mid, max_edge=1024)
            return maps, meshes.maps_to_u8(maps)

        self.hub.runner.run("inspector", load, on_done=lambda r: self._maps_loaded(mid, r),
                            on_error=lambda msg: self.hub.error(f"Could not load {m.name}: {msg}"))

    def _maps_loaded(self, mid: str, result) -> None:
        if not self.material or self.material.id != mid:
            return
        maps, u8 = result
        self.card.view.set_maps(maps, u8)
        self.strip.set_maps(maps)

    def sizeHint(self):
        return QSize(340, 600)

