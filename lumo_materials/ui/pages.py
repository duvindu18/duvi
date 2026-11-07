"""Trash, Drafts and Settings pages."""
from __future__ import annotations

from PySide6.QtCore import QRectF, Qt, Signal
from PySide6.QtGui import QColor, QPainter, QPen, QPixmap
from PySide6.QtWidgets import QFrame, QHBoxLayout, QLabel, QScrollArea, QVBoxLayout, QWidget

from .. import APP_NAME, __version__
from ..engine.presets import PRESETS
from . import icons, theme
from .dialogs import LibraryChooser, confirm
from .hub import Hub, app_dir, reveal
from .library_page import ago
from .widgets import ChoiceRow, ToggleRow, button, clear_layout, label


class _Page(QWidget):
    def __init__(self, hub: Hub, title: str, icon: str, parent=None):
        super().__init__(parent)
        self.hub = hub
        self.setObjectName("Page")
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)
        self.header = QWidget()
        self.header.setObjectName("Header")
        self.header.setProperty("dragArea", True)
        self.header.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.header.setFixedHeight(52)
        hl = QHBoxLayout(self.header)
        hl.setContentsMargins(20, 0, 8, 0)
        hl.setSpacing(10)
        ic = QLabel()
        ic.setPixmap(icons.pixmap(icon, theme.TEXT_2))
        hl.addWidget(ic)
        hl.addWidget(label(title, "crumbNow"))
        hl.addStretch(1)
        self.header_tools = QHBoxLayout()
        self.header_tools.setSpacing(6)
        hl.addLayout(self.header_tools)
        hl.addSpacing(146)
        root.addWidget(self.header)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        host = QWidget()
        self.body = QVBoxLayout(host)
        self.body.setContentsMargins(20, 20, 20, 20)
        self.body.setSpacing(8)
        scroll.setWidget(host)
        self.body_host = host
        root.addWidget(scroll, 1)

    def clear_body(self) -> None:
        clear_layout(self.body)


def _row(parts: list[QWidget], thumb: str | None = None) -> QFrame:
    f = QFrame()
    f.setObjectName("Card")
    lay = QHBoxLayout(f)
    lay.setContentsMargins(12, 8, 10, 8)
    lay.setSpacing(10)
    if thumb:
        t = QLabel()
        t.setFixedSize(40, 40)
        pm = QPixmap(thumb)
        if not pm.isNull():
            t.setPixmap(pm.scaled(40, 40, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation))
        lay.addWidget(t)
    for p in parts:
        if p is None:
            lay.addStretch(1)
        else:
            lay.addWidget(p)
    return f


def _when(iso: str) -> str:
    return ago(iso) if iso else ""


class TrashPage(_Page):
    def __init__(self, hub: Hub, parent=None):
        super().__init__(hub, "Trash", "trash", parent)
        self.b_empty = button("Empty trash", "trash", "danger", on_click=self._empty)
        self.header_tools.addWidget(self.b_empty)
        hub.changed.connect(self.refresh)

    def refresh(self) -> None:
        self.clear_body()
        lib = self.hub.library
        items = lib.trash_items() if lib else []
        self.b_empty.setEnabled(bool(items))
        if not items:
            e = label("The trash is empty.", "muted")
            e.setAlignment(Qt.AlignmentFlag.AlignCenter)
            self.body.addStretch(1)
            self.body.addWidget(e)
            self.body.addStretch(2)
            return
        self.body.addWidget(label(f"{len(items)} item{'s' if len(items) != 1 else ''}. Deleted materials stay here "
                                  "until you empty the trash.", "muted"))
        self.body.addSpacing(6)
        for t in items:
            name = label(t.name)
            name.setStyleSheet("font-weight: 500;")
            info = label(f"{t.category} · deleted {_when(t.deleted)}", "muted")
            col = QWidget()
            cl = QVBoxLayout(col)
            cl.setContentsMargins(0, 0, 0, 0)
            cl.setSpacing(2)
            cl.addWidget(name)
            cl.addWidget(info)
            thumb = t.folder / "thumb.jpg"
            self.body.addWidget(_row([col, None,
                                      button("Restore", "restore", on_click=lambda _=False, i=t.id: self._restore(i)),
                                      button("Delete", "trash", "danger", on_click=lambda _=False, i=t.id, n=t.name:
                                             self._delete(i, n))],
                                     str(thumb) if thumb.exists() else None))
        self.body.addStretch(1)

    def _restore(self, tid: str) -> None:
        try:
            m = self.hub.library.restore(tid)
            self.hub.notify(f"Restored {m.name} to {m.category}", "ok")
        except Exception as e:
            self.hub.error(str(e))
        self.hub.changed.emit()

    def _delete(self, tid: str, name: str) -> None:
        if confirm(self, "Delete forever?", f"{name} is removed from disk. This cannot be undone.", "Delete", True):
            self.hub.library.delete_forever(tid)
            self.hub.changed.emit()

    def _empty(self) -> None:
        lib = self.hub.library
        n = len(lib.trash_items()) if lib else 0
        if n and confirm(self, "Empty the trash?", f"{n} material{'s are' if n != 1 else ' is'} removed from disk. "
                         "This cannot be undone.", "Empty trash", True):
            lib.empty_trash()
            self.hub.changed.emit()


class DraftsPage(_Page):
    openDraft = Signal(object)

    def __init__(self, hub: Hub, parent=None):
        super().__init__(hub, "Drafts", "file", parent)
        hub.draftsChanged.connect(self.refresh)

    def refresh(self) -> None:
        self.clear_body()
        drafts = self.hub.drafts.list()
        if not drafts:
            e = label("No drafts. Unsaved materials you keep for later appear here.", "muted")
            e.setAlignment(Qt.AlignmentFlag.AlignCenter)
            self.body.addStretch(1)
            self.body.addWidget(e)
            self.body.addStretch(2)
            return
        kinds = {"photo": "From photo", "import": "Imported maps", "adjust": "Adjustment", "regenerate": "Regenerate"}
        for d in drafts:
            name = label(d.name or "Untitled")
            name.setStyleSheet("font-weight: 500;")
            info = label(f"{kinds.get(d.kind, d.kind)} · changed {_when(d.modified)}", "muted")
            col = QWidget()
            cl = QVBoxLayout(col)
            cl.setContentsMargins(0, 0, 0, 0)
            cl.setSpacing(2)
            cl.addWidget(name)
            cl.addWidget(info)
            thumb = str(d.source) if d.source else None
            self.body.addWidget(_row([col, None,
                                      button("Open", "edit", "primary", on_click=lambda _=False, x=d: self.openDraft.emit(x)),
                                      button("Discard", "trash", "ghost", on_click=lambda _=False, x=d: self._discard(x))],
                                     thumb))
        self.body.addStretch(1)

    def _discard(self, d) -> None:
        if confirm(self, "Discard draft?", f"{d.name or 'This draft'} and its copied files are removed.", "Discard", True):
            self.hub.drafts.discard(d.id)
            self.hub.draftsChanged.emit()


class AccentRow(QWidget):
    """'Accent colour' row: the label, then round swatches; the chosen one has a ring."""
    picked = Signal(str)

    def __init__(self, value: str, parent=None):
        super().__init__(parent)
        self.value = (value or theme.ACCENTS[0][0]).lower()
        self.hover = -1
        self.setFixedHeight(38)
        self.setMouseTracking(True)
        self.setProperty("interactive", True)

    def _rects(self):
        n = len(theme.ACCENTS)
        x = self.width() - 14 - n * 22 - (n - 1) * 8
        return [QRectF(x + i * 30, (self.height() - 22) / 2, 22, 22) for i in range(n)]

    def _at(self, pos) -> int:
        return next((i for i, r in enumerate(self._rects()) if r.adjusted(-3, -3, 3, 3).contains(pos)), -1)

    def mouseMoveEvent(self, e):
        i = self._at(e.position())
        if i != self.hover:
            self.hover = i
            self.setCursor(Qt.CursorShape.PointingHandCursor if i >= 0 else Qt.CursorShape.ArrowCursor)
            if i >= 0:
                self.setToolTip(theme.ACCENTS[i][1])
            self.update()

    def leaveEvent(self, e):
        self.hover = -1
        self.update()

    def mouseReleaseEvent(self, e):
        i = self._at(e.position())
        if i >= 0:
            self.value = theme.ACCENTS[i][0]
            self.update()
            self.picked.emit(self.value)

    def paintEvent(self, e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = QRectF(self.rect()).adjusted(0.5, 0.5, -0.5, -0.5)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(theme.ROW))
        p.drawRoundedRect(r, 9, 9)
        p.setBrush(QColor("#4a4a4f"))
        p.drawRoundedRect(QRectF(r.left() + 14, r.top() + 11, 2, r.height() - 22), 1, 1)
        p.setPen(QColor(theme.TEXT_2))
        p.drawText(r.adjusted(26, 0, -14, 0), Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft, "Accent colour")
        for i, (rect, (col, _name)) in enumerate(zip(self._rects(), theme.ACCENTS)):
            if col.lower() == self.value or i == self.hover:
                p.setPen(QPen(QColor(theme.TEXT if col.lower() == self.value else "#5a5a60"), 1.5))
                p.setBrush(Qt.BrushStyle.NoBrush)
                p.drawEllipse(rect.adjusted(-3.5, -3.5, 3.5, 3.5))
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(QColor(col))
            p.drawEllipse(rect)
        p.end()


TILE_CHOICES = [("0.5", "½ (zoomed in)"), ("1.0", "1 × 1"), ("1.5", "1.5 × 1.5"), ("2.0", "2 × 2"), ("3.0", "3 × 3"),
                ("4.0", "4 × 4"), ("6.0", "6 × 6"), ("8.0", "8 × 8")]


class SettingsPage(_Page):
    def __init__(self, hub: Hub, parent=None):
        super().__init__(hub, "Settings", "gear", parent)
        self.body_host.setMaximumWidth(820)          # long lines are hard to read on wide windows
        self.body.setSpacing(6)
        hub.libraryOpened.connect(self.refresh)

    def _kv(self, k: str, v: str, *buttons) -> QWidget:
        w = QWidget()
        lay = QHBoxLayout(w)
        lay.setContentsMargins(0, 4, 0, 4)
        lay.setSpacing(8)
        kl = label(k, "muted")
        kl.setFixedWidth(160)
        lay.addWidget(kl)
        vl = label(v)
        vl.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        vl.setWordWrap(True)
        lay.addWidget(vl, 1)
        for b in buttons:
            lay.addWidget(b)
        return w

    def _section(self, text: str, hint: str = "") -> None:
        lb = label(text, "section")
        lb.setContentsMargins(0, 22, 0, 2 if hint else 6)
        self.body.addWidget(lb)
        if hint:
            h = label(hint, "muted", wrap=True)
            h.setStyleSheet(f"color: {theme.MUTED}; font-size: 12px;")
            h.setContentsMargins(0, 0, 0, 6)
            self.body.addWidget(h)

    # rows that write a preference and apply it at once ------------------------------------------
    def _choice(self, text: str, key: str, options, cast=str) -> ChoiceRow:
        cur = self.hub.settings.get(key)
        row = ChoiceRow(text, options, str(cur) if cur is not None else options[0][0])
        row.changed.connect(lambda v, k=key, c=cast: self.hub.set_setting(k, c(v)))
        self.body.addWidget(row)
        return row

    def _toggle(self, text: str, key: str) -> ToggleRow:
        row = ToggleRow(text, bool(self.hub.settings.get(key)))
        row.toggled.connect(lambda on, k=key: self.hub.set_setting(k, bool(on)))
        self.body.addWidget(row)
        return row

    def refresh(self) -> None:
        self.clear_body()
        s, lib = self.hub.settings, self.hub.library
        from .library_page import SORTS
        from .viewer import BACKGROUNDS, LIGHTS, RENDERER_LABELS, RENDERERS, SHAPES, MaterialView
        from .editor import OUTPUT_SIZES, SEAMLESS_LABELS
        from ..engine.seamless import MODES
        from .dialogs import EXPORT_HEIGHT, EXPORT_NAMING, EXPORT_NORMALS

        # ---- appearance
        self._section("APPEARANCE")
        accent = AccentRow(s.get("accent") or theme.ACCENT)
        accent.picked.connect(lambda c: self.hub.set_setting("accent", c))
        self.body.addWidget(accent)
        self._choice("Card thumbnails", "thumb_style", [("sphere", "Lit sphere"), ("flat", "Flat, fills the card")])
        self._toggle("Tags on cards", "card_tags")
        self._choice("Animations", "animations", [("on", "On"), ("off", "Off (instant)")])
        self._toggle("Splash screen at start", "splash")
        self._choice("Window at start", "startup_window", [("last", "Last size and place"), ("maximized", "Maximised")])

        # ---- library
        self._section("LIBRARY")
        change = button("Change…", "folder", on_click=self._change)
        change.setEnabled(not s.library_pinned)
        if s.library_pinned:
            change.setToolTip("Pinned by the LUMO_LIBRARY_DIR environment variable")
        self.body.addWidget(self._kv("Folder", str(lib.root) if lib else "not chosen", change,
                                     button("Show", "reveal", "ghost", on_click=lambda: lib and reveal(lib.root)),
                                     button("Rescan", "refresh", "ghost", on_click=self._rescan)))
        if lib:
            self.body.addWidget(self._kv("Materials", f"{lib.count()} in {len(lib.categories())} categories"))
        self._choice("Materials per page", "page_size", [("12", "12"), ("24", "24"), ("48", "48"), ("96", "96")], int)
        self._choice("Sort by", "sort", SORTS)
        self._toggle("Ask before moving to the trash", "confirm_trash")
        self._choice("Warn about repeated images", "duplicate_check",
                     [("similar", "Same file or same picture"), ("identical", "Only the very same file"), ("off", "Off")])

        # ---- new materials
        self._section("NEW MATERIALS")
        preset = ChoiceRow("Default material type", [(k, v[0]) for k, v in PRESETS.items()], s.get("default_preset"))
        preset.changed.connect(lambda v: self.hub.set_setting("default_preset", v))
        self.body.addWidget(preset)
        self._choice("Default seamless mode", "default_seamless", [(m, SEAMLESS_LABELS[m]) for m in MODES])
        self._choice("Default output size", "default_output_px", OUTPUT_SIZES, int)
        self._choice("Live preview resolution", "preview_px", [("512", "512 px (fastest)"), ("768", "768 px"),
                                                               ("1024", "1024 px (sharper)")], int)
        self._toggle("Generate missing maps on import", "import_generate_missing")
        self._choice("PNG compression", "png_compression", [("fast", "Fast saving (larger files)"),
                                                            ("small", "Smaller files (slower saving)")])

        # ---- 3D preview
        self._section("3D PREVIEW")
        gl = ChoiceRow("Renderer (after restart)", RENDERERS, s.get("renderer") or "auto")
        gl.changed.connect(lambda v: (self.hub.set_setting("renderer", v),
                                      self.hub.notify("The renderer changes the next time lumo materials starts.", "info")))
        self.body.addWidget(gl)
        now = MaterialView.device_info or RENDERER_LABELS.get(MaterialView.backend, "not started yet")
        if MaterialView.backend == "cpu" and self.hub.gpu_note:
            now = self.hub.gpu_note
        self.body.addWidget(self._kv("In use now", now))
        self._choice("Shape", "preview_shape", SHAPES)
        self._choice("Light", "light", [(k, v[0]) for k, v in LIGHTS.items()])
        self._choice("Background", "background", [(k, v[0]) for k, v in BACKGROUNDS.items()])
        self._toggle("Spin the preview", "preview_spin")
        self._choice("Tile size in the editor", "editor_tiling", TILE_CHOICES, float)

        # ---- export
        self._section("EXPORT", "Defaults of the Export window. It also remembers your last choices.")
        self._choice("Export as", "export_target", [("zip", "ZIP file"), ("folder", "Folder")])
        self._choice("Normal map", "export_normal", EXPORT_NORMALS)
        self._choice("File names", "export_naming", EXPORT_NAMING)
        self._choice("Height map", "export_height", EXPORT_HEIGHT)
        self._toggle("Packed ORM map", "export_orm")
        self._toggle("Include previews", "export_previews")

        # ---- program
        self._section("PROGRAM")
        self.body.addWidget(self._kv("Version", f"{APP_NAME} {__version__}"))
        self.body.addWidget(self._kv("Program data", str(s.folder), button("Show", "reveal", "ghost",
                                                                           on_click=lambda: reveal(s.folder))))
        lic = theme.asset_dir() / "licenses"
        self.body.addWidget(self._kv("Licences", "Inter and Poppins (SIL OFL 1.1), Qt / PySide6 (LGPL 3), NumPy (BSD), "
                                     "Pillow (MIT-CMU)", button("Open", "reveal", "ghost", on_click=lambda: reveal(lic))))
        self.body.addWidget(self._kv("Installed in", str(app_dir())))
        self.body.addWidget(self._kv("Reset", "All settings back to their defaults. The library folder stays.",
                                     button("Reset settings…", "restore", "danger", on_click=self._reset)))
        self.body.addStretch(1)

    def _reset(self) -> None:
        if not confirm(self.window(), "Reset all settings?", "Every preference goes back to its default. Your library, "
                       "materials and drafts are not touched.", "Reset", True):
            return
        s = self.hub.settings
        before = dict(s.values)
        s.reset()
        for k, v in s.values.items():
            if before.get(k) != v:
                self.hub.settingsChanged.emit(k)
        self.refresh()
        self.hub.notify("Settings reset to their defaults.", "ok")

    def _change(self) -> None:
        if LibraryChooser(self.window(), self.hub).exec():
            self.hub.notify(f"Library: {self.hub.library.root}", "ok")
            self.refresh()

    def _rescan(self) -> None:
        n = self.hub.rescan()
        self.hub.notify(f"Rescanned: {n} materials", "ok")
        self.refresh()
