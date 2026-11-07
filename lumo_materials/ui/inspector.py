"""Right panel: the selected material in 3D, its maps, preview controls, details and actions."""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QRectF, QSize, Qt, Signal
from PySide6.QtGui import QColor, QFontMetrics, QImage, QImageReader, QPainter, QPainterPath, QPen, QPixmap
from PySide6.QtWidgets import QFrame, QGridLayout, QHBoxLayout, QLabel, QMenu, QScrollArea, QVBoxLayout, QWidget

from ..engine.imageio import fit_within, to_uint8
from ..library.store import Material
from . import icons, theme
from .hub import Hub
from .library_page import ago
from .viewer import BACKGROUNDS, DISPLAY, LIGHTS, SHAPES, MaterialView
from .widgets import (ChoiceRow, FillSlider, PreviewPlaceholder, Segmented, ShimmerClock, button, clear_layout,
                      label, shimmer_brush)


def gray_or_rgb_pixmap(a: np.ndarray, size: int) -> QPixmap:
    """Small pixmap of a map; accepts float maps (0..1) and uint8 preview maps (L / RGB / RGBA)."""
    if a.dtype != np.uint8:
        a = to_uint8(fit_within(a, size))
    if a.ndim == 3 and a.shape[2] == 4:
        a = a[..., :3]
    if a.ndim == 2:
        a = np.repeat(a[..., None], 3, axis=2)
    a = np.ascontiguousarray(a)
    img = QImage(a.tobytes(), a.shape[1], a.shape[0], a.shape[1] * 3, QImage.Format.Format_RGB888).copy()
    if max(img.width(), img.height()) > size:
        img = img.scaled(size, size, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
    return QPixmap.fromImage(img)


def maps_signature(m: Material) -> tuple:
    try:
        stamp = (m.folder / "albedo.png").stat().st_mtime_ns
    except OSError:
        stamp = 0
    return m.id, str(m.folder), stamp, m.width, m.height


def thumbnail_pixmap(m: Material, size: int = 320) -> QPixmap | None:
    """The saved sphere preview, decoded small (shown at once while the 3D maps load)."""
    p = m.preview_path("sphere")
    if p is None:
        return None
    r = QImageReader(str(p))
    sz = r.size()
    if sz.isValid() and max(sz.width(), sz.height()) > size:
        k = size / max(sz.width(), sz.height())
        r.setScaledSize(QSize(max(1, round(sz.width() * k)), max(1, round(sz.height() * k))))
    img = r.read()
    return QPixmap.fromImage(img) if not img.isNull() else None


class MapTile(QLabel):
    """One map thumbnail; shimmers while its material loads."""
    clicked = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.loading = False
        self.active = False

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self.clicked.emit()

    def set_loading(self, on: bool) -> None:
        self.loading = on
        if on:
            self.clear()
            ShimmerClock.get().add(self)
        else:
            ShimmerClock.get().discard(self)
        self.update()

    def paintEvent(self, e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        r = QRectF(self.rect()).adjusted(0.5, 0.5, -0.5, -0.5)
        path = QPainterPath()
        path.addRoundedRect(r, 6, 6)
        if self.loading or self.pixmap() is None or self.pixmap().isNull():
            p.fillPath(path, shimmer_brush(r, ShimmerClock.get().phase()) if self.loading else QColor("#151517"))
        else:
            p.setClipPath(path)
            p.drawPixmap(self.rect(), self.pixmap())
            p.setClipping(False)
        p.setPen(QPen(QColor("#d8d8db" if self.active else theme.LINE), 1.5 if self.active else 1))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawRoundedRect(r, 6, 6)
        p.end()


class MapStrip(QWidget):
    """Six small map thumbnails; clicking one shows only that map in the viewer (click again: lit)."""
    chosen = Signal(str)

    NAMES = [("albedo", "Albedo"), ("normal", "Normal"), ("roughness", "Rough"), ("metallic", "Metal"),
             ("height", "Height"), ("ao", "AO")]

    def __init__(self, parent=None, tile: int = 44):
        super().__init__(parent)
        lay = QGridLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setHorizontalSpacing(8)
        lay.setVerticalSpacing(5)
        self.thumbs: dict[str, MapTile] = {}
        self.active = "lit"
        for i, (key, text) in enumerate(self.NAMES):
            t = MapTile()
            t.setFixedSize(tile, tile)
            t.setCursor(Qt.CursorShape.PointingHandCursor)
            t.setToolTip(f"Show only the {text.lower()} map (click again for the lit view)")
            t.clicked.connect(lambda k=key: self._click(k))
            self.thumbs[key] = t
            lay.addWidget(t, 0, i, Qt.AlignmentFlag.AlignHCenter)
            lb = label(text)
            lb.setStyleSheet(f"font-size: 10px; color: {theme.MUTED};")
            lb.setAlignment(Qt.AlignmentFlag.AlignCenter)
            lay.addWidget(lb, 1, i)
            lay.setColumnStretch(i, 1)
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
            t.active = k == self.active
            t.update()

    def set_loading(self) -> None:
        for t in self.thumbs.values():
            t.set_loading(True)

    def set_maps(self, maps: dict[str, np.ndarray] | None) -> None:
        for k, t in self.thumbs.items():
            t.set_loading(False)
            if maps and k in maps:
                t.setPixmap(gray_or_rgb_pixmap(maps[k], 96))
            else:
                t.clear()


class ViewerCard(QFrame):
    """The 3D view with its own toolbar row (shape, display mode, spin): nothing sits on top of the material."""

    TILINGS = [0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 8.0]

    def __init__(self, parent=None, height: int = 300, tiling: float | None = None):
        super().__init__(parent)
        self.setObjectName("ViewerCard")
        self.setStyleSheet(f"QFrame#ViewerCard {{ border: 1px solid {theme.LINE}; border-radius: 10px; background: #121214; }}"
                           f"QWidget#ViewerBar {{ border-bottom: 1px solid {theme.LINE}; background: transparent; }}")
        lay = QVBoxLayout(self)
        lay.setContentsMargins(1, 1, 1, 1)
        lay.setSpacing(0)
        bar = QWidget()
        bar.setObjectName("ViewerBar")
        bar.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        bar.setFixedHeight(42)
        bl = QHBoxLayout(bar)
        bl.setContentsMargins(8, 0, 8, 0)
        bl.setSpacing(6)
        self.shape = Segmented(SHAPES, "sphere")
        self.shape.changed.connect(lambda k: self.view.set_option("shape", k))
        bl.addWidget(self.shape)
        bl.addStretch(1)
        self.tile_button = None
        if tiling is not None:                 # the editor: how often the texture repeats on the preview
            self.tile_button = button(self._tile_text(tiling), "tiles", "ghost", "Tile size: how often the material "
                                      "repeats on the preview (does not change the saved maps)")
            self.tile_button.setFixedHeight(28)
            self.tile_button.setStyleSheet("QPushButton { min-height: 26px; padding: 0 8px; font-size: 12px; "
                                           "font-weight: 400; }")
            self.tile_button.clicked.connect(self._tile_menu)
            bl.addWidget(self.tile_button)
        self.mode = button("Lit", "caret", "ghost", "What the view shows: the lit material or one map")
        self.mode.setLayoutDirection(Qt.LayoutDirection.RightToLeft)
        self.mode.setFixedHeight(28)
        self.mode.setStyleSheet("QPushButton { min-height: 26px; padding: 0 8px; font-size: 12px; font-weight: 400; }")
        self.mode.clicked.connect(self._mode_menu)
        bl.addWidget(self.mode)
        self.spin = button("", "regen", "ghost", "Spin the preview", checkable=True)
        self.spin.setFixedSize(28, 28)
        self.spin.setStyleSheet("QPushButton { min-height: 26px; padding: 0; }")
        bl.addWidget(self.spin)
        lay.addWidget(bar)
        self.view_host = QWidget()
        vh = QVBoxLayout(self.view_host)
        vh.setContentsMargins(0, 0, 0, 0)
        self.view = MaterialView()
        vh.addWidget(self.view)
        self.placeholder = PreviewPlaceholder(self.view_host)
        lay.addWidget(self.view_host, 1)
        if height:
            self.view_host.setMinimumHeight(height)
        self.spin.toggled.connect(lambda on: self.view.set_option("spin", on))
        self.view.usingFallback.connect(lambda _r: self.spin.setEnabled(self.view.gpu is not None))

    # loading state -------------------------------------------------------------
    def loading(self, pixmap: QPixmap | None = None) -> None:
        self.view.clear()
        self.placeholder.setGeometry(self.view_host.rect())
        self.placeholder.start(pixmap)

    def loaded(self) -> None:
        self.placeholder.stop()

    def resizeEvent(self, e):
        super().resizeEvent(e)
        self.placeholder.setGeometry(self.view_host.rect())

    @staticmethod
    def _tile_text(v: float) -> str:
        return f"{v:g}×"

    def _tile_menu(self):
        m = QMenu(self)
        cur = float(self.view.state.tiling)
        for v in self.TILINGS:
            a = m.addAction(f"{v:g} × {v:g}" if v >= 1 else "½ (zoomed in)")
            a.setCheckable(True)
            a.setChecked(abs(v - cur) < 1e-6)
            a.triggered.connect(lambda _=False, x=v: self.set_tiling(x))
        m.exec(self.tile_button.mapToGlobal(self.tile_button.rect().bottomLeft()))

    def set_tiling(self, v: float) -> None:
        self.view.set_option("tiling", float(v))
        if self.tile_button is not None:
            self.tile_button.setText(self._tile_text(v))
        self.tilingChanged(float(v))

    def tilingChanged(self, v: float) -> None:   # overridden by owners that remember it
        pass

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

        # the window's caption buttons own the top strip (same height as the page headers, so the lines meet);
        # the panel itself starts below it
        self.caption_strip = QWidget()
        self.caption_strip.setObjectName("Header")
        self.caption_strip.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.caption_strip.setProperty("dragArea", True)
        self.caption_strip.setFixedHeight(52)
        root.addWidget(self.caption_strip)

        self.header = QWidget()
        self.header.setFixedHeight(52)
        hl = QHBoxLayout(self.header)
        hl.setContentsMargins(16, 0, 10, 0)
        hl.setSpacing(8)
        self.title = label("", "h2")
        hl.addWidget(self.title, 1)
        self.b_more = button("", "more", "ghost", "More actions")
        self.b_more.setFixedSize(30, 30)
        self.b_more.clicked.connect(self._more_menu)
        hl.addWidget(self.b_more)
        root.addWidget(self.header)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        # the scroll bar's room is always reserved: content never jumps sideways when a material with a longer
        # description makes the panel scroll (the bar is invisible when there is nothing to scroll)
        scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOn)
        host = QWidget()
        self.body = QVBoxLayout(host)
        self.body.setContentsMargins(16, 0, 6, 16)
        self.body.setSpacing(0)
        scroll.setWidget(host)
        root.addWidget(scroll, 1)

        self.card = ViewerCard(height=300)
        self.card.modeChanged = lambda k: self.strip.set_active(k)
        self.body.addWidget(self.card)
        self.body.addSpacing(12)
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
        self.card.shape.changed.connect(lambda k: self.hub.settings.set("preview_shape", k))
        self.card.shape.setValue(s.get("preview_shape") or "sphere")
        self.card.view.set_option("shape", s.get("preview_shape") or "sphere")
        if s.get("preview_spin"):
            self.card.spin.setChecked(True)

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
        lb.setContentsMargins(0, 20, 0, 8)
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
            kl.setFixedHeight(30)
            kl.setStyleSheet(f"color: {theme.MUTED}; font-size: 12px; border-bottom: 1px solid {theme.LINE};")
            vl = label(v)
            vl.setFixedHeight(30)
            vl.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
            vl.setStyleSheet(f"color: {colour or theme.TEXT_2}; font-size: 12px; border-bottom: 1px solid {theme.LINE};")
            vl.setToolTip(v)
            fm = QFontMetrics(vl.font())
            vl.setText(fm.elidedText(v, Qt.TextElideMode.ElideMiddle, 200))
            self.details.addWidget(kl, i, 0)
            self.details.addWidget(vl, i, 1)
            kl.show()      # visible at once, not only after Qt's queued show
            vl.show()

    def show_material(self, m: Material | None, reload: bool = True) -> None:
        self.material = m
        has = m is not None
        for w in (self.b_adjust, self.b_export, self.b_more):
            w.setEnabled(has)
        if not has:
            self.loaded_sig = None
            self.title.setText("Nothing selected")
            self.title.setStyleSheet(f"color: {theme.MUTED};")
            self.card.loaded()
            self.card.view.clear()
            self.strip.set_maps(None)
            lib = self.hub.library
            self._set_details([("Library", str(lib.root) if lib else "not chosen", None),
                               ("Materials", str(lib.count()) if lib else "0", None)])
            return
        self.title.setStyleSheet("")
        fm = QFontMetrics(self.title.font())
        self.title.setText(fm.elidedText(m.name, Qt.TextElideMode.ElideRight, 260))
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
        sig = maps_signature(m)
        if not reload and self.loaded_sig == sig:
            return
        self.loaded_sig = sig
        cached = self.hub.previews.get(sig)
        if cached is not None:                      # seen recently: no loading at all
            self._show_maps(sig, cached)
            return
        # at once: drop the previous material, show this one's saved thumbnail with a shimmer
        self.card.loading(thumbnail_pixmap(m))
        self.strip.set_loading()
        lib, cache = self.hub.library, self.hub.previews

        def load():
            maps = lib.load_preview_u8(m.id, 1024)
            cache.put(sig, maps)                    # kept even if the user has moved on meanwhile
            return maps

        self.hub.runner.run("inspector", load, on_done=lambda r: self._show_maps(sig, r),
                            on_error=lambda msg: (self.card.loaded(), self.hub.error(f"Could not load {m.name}: {msg}")))

    def _show_maps(self, sig: tuple, maps: dict) -> None:
        if self.loaded_sig != sig:
            return
        self.card.view.set_u8(maps)
        self.strip.set_maps(maps)
        self.card.loaded()

    def prefetch(self, materials: list[Material]) -> None:
        """Loads the neighbours of the current card in the background, so the next click shows at once."""
        lib, cache = self.hub.library, self.hub.previews
        todo = [(maps_signature(m), m.id) for m in materials]
        todo = [(sig, mid) for sig, mid in todo if sig not in cache]
        if not lib or not todo:
            return

        def work():
            for sig, mid in todo:
                if sig not in cache:
                    try:
                        cache.put(sig, lib.load_preview_u8(mid, 1024))
                    except Exception:
                        pass
            return None

        self.hub.runner.run("prefetch", work)

    def apply_settings(self, key: str) -> None:
        s = self.hub.settings
        if key == "preview_shape":
            self.card.shape.setValue(s.get("preview_shape"))
            self.card.view.set_option("shape", s.get("preview_shape"))
        elif key == "preview_spin":
            self.card.spin.setChecked(bool(s.get("preview_spin")))
        elif key in ("light", "background"):
            row = self.r_light if key == "light" else self.r_bg
            row.setValue(s.get(key))
            self.card.view.set_option(key, s.get(key))

    def sizeHint(self):
        return QSize(340, 600)

