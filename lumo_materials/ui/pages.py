"""Trash, Drafts and Settings pages."""
from __future__ import annotations

from PySide6.QtCore import QRectF, Qt, Signal
from PySide6.QtGui import QColor, QPainter, QPen, QPixmap
from PySide6.QtWidgets import (QButtonGroup, QFrame, QGridLayout, QHBoxLayout, QLabel, QPushButton, QScrollArea,
                               QVBoxLayout, QWidget)

from .. import APP_NAME, __version__
from ..engine.presets import PRESETS
from . import icons, theme
from .dialogs import LibraryChooser, confirm
from .hub import Hub, app_dir, reveal
from .library_page import ago
from .widgets import ChoiceRow, ElidedLabel, ToggleRow, button, clear_layout, human_bytes, label, vline


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
        self.scroll = scroll
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

SECTIONS = [("appearance", "Appearance", "palette", "How lumo materials looks and moves."),
            ("library", "Library", "grid", "Where your materials live and how they are listed."),
            ("new", "New materials", "photo", "Starting values for photos and imported map sets."),
            ("preview", "3D preview", "regen", "The renderer and how materials are shown."),
            ("export", "Export", "export", "Defaults of the Export window. It also remembers your last choices."),
            ("about", "About", "info", "Version, folders, licences and reset.")]

_SMALL_BUTTON = "QPushButton { min-height: 26px; max-height: 26px; padding: 0 10px; font-size: 12px; }"


class InfoRow(QFrame):
    """A read-only row in the same style as the setting rows: label left, value (and buttons) right."""

    def __init__(self, text: str, value: str, *buttons, parent=None):
        super().__init__(parent)
        self.setObjectName("InfoRow")
        self.setStyleSheet(f"QFrame#InfoRow {{ background: {theme.ROW}; border-radius: 9px; }}")
        self.setFixedHeight(38)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(26, 0, 8 if buttons else 14, 0)
        lay.setSpacing(8)
        kl = label(text)
        kl.setStyleSheet(f"color: {theme.TEXT_2};")
        lay.addWidget(kl)
        lay.addSpacing(12)
        vl = ElidedLabel(value)
        vl.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        vl.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        lay.addWidget(vl, 1)
        for b in buttons:
            b.setFixedHeight(28)
            b.setStyleSheet(_SMALL_BUTTON)
            lay.addWidget(b)

    def paintEvent(self, e):
        super().paintEvent(e)
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor("#4a4a4f"))
        p.drawRoundedRect(QRectF(14, 11, 2, self.height() - 22), 1, 1)
        p.end()


class SettingsCard(QFrame):
    """A titled group of settings. Its rows sit in two columns when the card is wide enough, else in one."""
    TWO_COLUMNS = 760

    def __init__(self, title: str, hint: str = "", parent=None):
        super().__init__(parent)
        self.setObjectName("SettingsCard")
        self.setStyleSheet(f"QFrame#SettingsCard {{ background: #151517; border: 1px solid {theme.LINE}; "
                           f"border-radius: 12px; }}")
        lay = QVBoxLayout(self)
        lay.setContentsMargins(16, 14, 16, 16)
        lay.setSpacing(4)
        t = label(title, "h2")
        lay.addWidget(t)
        if hint:
            h = label(hint, "muted", wrap=True)
            h.setStyleSheet(f"color: {theme.MUTED}; font-size: 12px;")
            lay.addWidget(h)
        lay.addSpacing(8)
        self.grid = QGridLayout()
        self.grid.setHorizontalSpacing(10)
        self.grid.setVerticalSpacing(6)
        lay.addLayout(self.grid)
        self.items: list[tuple[QWidget, bool]] = []      # (row, spans both columns)
        self.cols = 0

    def add(self, w: QWidget, wide: bool = False) -> QWidget:
        self.items.append((w, wide))
        self._place(max(1, self.cols))
        return w

    def _place(self, cols: int) -> None:
        self.cols = cols
        while self.grid.count():
            self.grid.takeAt(0)
        r = c = 0
        for w, wide in self.items:
            if wide or cols == 1:
                if c:
                    r, c = r + 1, 0
                self.grid.addWidget(w, r, 0, 1, cols)
                r += 1
                continue
            self.grid.addWidget(w, r, c)
            c += 1
            if c == cols:
                r, c = r + 1, 0
        for i in range(2):
            self.grid.setColumnStretch(i, 1 if i < cols else 0)

    def resizeEvent(self, e):
        super().resizeEvent(e)
        cols = 2 if self.width() >= self.TWO_COLUMNS else 1
        if cols != self.cols:
            self._place(cols)


class SettingsPage(_Page):
    """Sections on the left (like Windows Settings); the chosen section's cards fill the rest."""

    def __init__(self, hub: Hub, parent=None):
        super().__init__(hub, "Settings", "gear", parent)
        self.section = "appearance"
        self.scroll.setParent(None)                 # this page lays itself out (sections + content)
        root = self.layout()
        content = QWidget()
        cl = QHBoxLayout(content)
        cl.setContentsMargins(0, 0, 0, 0)
        cl.setSpacing(0)
        nav = QWidget()
        nav.setFixedWidth(220)
        nl = QVBoxLayout(nav)
        nl.setContentsMargins(14, 18, 14, 18)
        nl.setSpacing(2)
        from .sidebar import NavButton
        self.nav_group = QButtonGroup(self)
        self.nav_group.setExclusive(True)
        self.nav: dict[str, QPushButton] = {}
        for key, text, ic, _hint in SECTIONS:
            b = NavButton(text, ic)
            self.nav_group.addButton(b)
            b.clicked.connect(lambda _=False, k=key: self.show_section(k))
            self.nav[key] = b
            nl.addWidget(b)
        nl.addStretch(1)
        cl.addWidget(nav)
        cl.addWidget(vline())
        self.page_scroll = QScrollArea()
        self.page_scroll.setWidgetResizable(True)
        self.page_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.page_scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOn)
        cl.addWidget(self.page_scroll, 1)
        root.addWidget(content, 1)
        hub.libraryOpened.connect(self.refresh)

    # rows that write a preference and apply it at once ------------------------------------------
    def _choice(self, text: str, key: str, options, cast=str) -> ChoiceRow:
        cur = self.hub.settings.get(key)
        row = ChoiceRow(text, options, str(cur) if cur is not None else options[0][0])
        row.changed.connect(lambda v, k=key, c=cast: self.hub.set_setting(k, c(v)))
        return row

    def _toggle(self, text: str, key: str) -> ToggleRow:
        row = ToggleRow(text, bool(self.hub.settings.get(key)))
        row.toggled.connect(lambda on, k=key: self.hub.set_setting(k, bool(on)))
        return row

    def show_section(self, key: str) -> None:
        self.section = key
        self.refresh()

    def refresh(self) -> None:
        key = self.section if self.section in self.nav else "appearance"
        self.nav[key].setChecked(True)
        title, hint = next((t, h) for k, t, _i, h in SECTIONS if k == key)
        host = QWidget()
        lay = QVBoxLayout(host)
        lay.setContentsMargins(24, 22, 14, 24)         # + the 10 px scroll bar on the right
        lay.setSpacing(14)
        head = QVBoxLayout()
        head.setSpacing(2)
        head.addWidget(label(title, "title"))
        sub = label(hint, "muted", wrap=True)
        head.addWidget(sub)
        lay.addLayout(head)
        lay.addSpacing(2)
        for card in getattr(self, f"_section_{key}")():
            lay.addWidget(card)
        lay.addStretch(1)
        self.page_scroll.setWidget(host)           # the previous section's widgets are deleted with it

    # sections -----------------------------------------------------------------------------------
    def _section_appearance(self) -> list[QFrame]:
        s = self.hub.settings
        look = SettingsCard("Look", "Colours and what the cards show.")
        accent = AccentRow(s.get("accent") or theme.ACCENT)
        accent.picked.connect(lambda c: self.hub.set_setting("accent", c))
        look.add(accent, wide=True)
        look.add(self._choice("Card thumbnails", "thumb_style", [("sphere", "Lit sphere"),
                                                                  ("flat", "Flat, fills the card")]))
        look.add(self._toggle("Tags on cards", "card_tags"))
        start = SettingsCard("Motion and start", "Animations, the splash screen and the window when the program opens.")
        start.add(self._choice("Animations", "animations", [("on", "On"), ("off", "Off (instant)")]))
        start.add(self._toggle("Splash screen at start", "splash"))
        start.add(self._choice("Window at start", "startup_window", [("last", "Last size and place"),
                                                                      ("maximized", "Maximised")]))
        return [look, start]

    def _section_library(self) -> list[QFrame]:
        from .library_page import SORTS
        s, lib = self.hub.settings, self.hub.library
        folder = SettingsCard("Library folder", "Materials are ordinary folders of PNG maps: one folder per category.")
        change = button("Change…", "folder", on_click=self._change)
        change.setEnabled(not s.library_pinned)
        if s.library_pinned:
            change.setToolTip("Pinned by the LUMO_LIBRARY_DIR environment variable")
        folder.add(InfoRow("Folder", str(lib.root) if lib else "not chosen", change,
                           button("Show", "reveal", "ghost", on_click=lambda: lib and reveal(lib.root)),
                           button("Rescan", "refresh", "ghost", on_click=self._rescan)), wide=True)
        if lib:
            folder.add(InfoRow("Materials", f"{lib.count()} in {len(lib.categories())} categories"))
            folder.add(InfoRow("Space used", human_bytes(lib.disk_usage())))
        browse = SettingsCard("Browsing", "How the grid lists materials.")
        browse.add(self._choice("Materials per page", "page_size", [("12", "12"), ("24", "24"), ("48", "48"),
                                                                    ("96", "96")], int))
        browse.add(self._choice("Sort by", "sort", SORTS))
        safety = SettingsCard("Safety", "Questions before things you may not mean to do.")
        safety.add(self._toggle("Ask before moving to the trash", "confirm_trash"))
        safety.add(self._choice("Warn about repeated images", "duplicate_check",
                                [("similar", "Same file or same picture"), ("identical", "Only the very same file"),
                                 ("off", "Off")]))
        return [folder, browse, safety]

    def _section_new(self) -> list[QFrame]:
        from .editor import OUTPUT_SIZES, SEAMLESS_LABELS
        from ..engine.seamless import MODES
        defaults = SettingsCard("Defaults", "Used when the file name does not suggest a material type.")
        preset = ChoiceRow("Material type", [(k, v[0]) for k, v in PRESETS.items()], self.hub.settings.get("default_preset"))
        preset.changed.connect(lambda v: self.hub.set_setting("default_preset", v))
        defaults.add(preset)
        defaults.add(self._choice("Seamless mode", "default_seamless", [(m, SEAMLESS_LABELS[m]) for m in MODES]))
        defaults.add(self._choice("Output size", "default_output_px", OUTPUT_SIZES, int))
        defaults.add(self._toggle("Generate missing maps on import", "import_generate_missing"))
        editor = SettingsCard("Editor", "The live preview while you adjust a material.")
        editor.add(self._choice("Live preview resolution", "preview_px", [("512", "512 px (fastest)"), ("768", "768 px"),
                                                                          ("1024", "1024 px (sharper)")], int))
        editor.add(self._choice("Tile size in the preview", "editor_tiling", TILE_CHOICES, float))
        saving = SettingsCard("Saving", "PNG maps are lossless either way; this only trades speed for file size.")
        saving.add(self._choice("PNG compression", "png_compression", [("fast", "Fast saving (larger files)"),
                                                                       ("small", "Smaller files (slower saving)")]))
        return [defaults, editor, saving]

    def _section_preview(self) -> list[QFrame]:
        from .viewer import BACKGROUNDS, LIGHTS, RENDERER_LABELS, RENDERERS, SHAPES, MaterialView
        s = self.hub.settings
        render = SettingsCard("Renderer", "Direct3D 12 first; Direct3D 11, OpenGL and the CPU are the fallbacks.")
        gl = ChoiceRow("Renderer (after restart)", RENDERERS, s.get("renderer") or "auto")
        gl.changed.connect(lambda v: (self.hub.set_setting("renderer", v),
                                      self.hub.notify("The renderer changes the next time lumo materials starts.", "info")))
        render.add(gl)
        now = MaterialView.device_info or RENDERER_LABELS.get(MaterialView.backend, "not started yet")
        if MaterialView.backend == "cpu" and self.hub.gpu_note:
            now = self.hub.gpu_note
        render.add(InfoRow("In use now", now))
        view = SettingsCard("View", "How the inspector and the editor show a material.")
        view.add(self._choice("Shape", "preview_shape", SHAPES))
        view.add(self._choice("Light", "light", [(k, v[0]) for k, v in LIGHTS.items()]))
        view.add(self._choice("Background", "background", [(k, v[0]) for k, v in BACKGROUNDS.items()]))
        view.add(self._toggle("Spin the preview", "preview_spin"))
        return [render, view]

    def _section_export(self) -> list[QFrame]:
        from .dialogs import EXPORT_HEIGHT, EXPORT_NAMING, EXPORT_NORMALS
        target = SettingsCard("Destination")
        target.add(self._choice("Export as", "export_target", [("zip", "ZIP file"), ("folder", "Folder")]))
        files = SettingsCard("Files", "Match these to the program you take the materials into.")
        files.add(self._choice("Normal map", "export_normal", EXPORT_NORMALS))
        files.add(self._choice("File names", "export_naming", EXPORT_NAMING))
        files.add(self._choice("Height map", "export_height", EXPORT_HEIGHT))
        files.add(self._toggle("Packed ORM map", "export_orm"))
        files.add(self._toggle("Include previews", "export_previews"))
        return [target, files]

    def _section_about(self) -> list[QFrame]:
        s = self.hub.settings
        prog = SettingsCard("Program")
        prog.add(InfoRow("Version", f"{APP_NAME} {__version__}"))
        prog.add(InfoRow("Installed in", str(app_dir())))
        prog.add(InfoRow("Program data", str(s.folder), button("Show", "reveal", "ghost", on_click=lambda: reveal(s.folder))),
                 wide=True)
        lic = theme.asset_dir() / "licenses"
        prog.add(InfoRow("Licences", "Inter and Poppins (SIL OFL 1.1), Qt / PySide6 (LGPL 3), NumPy (BSD), Pillow (MIT-CMU)",
                         button("Open", "reveal", "ghost", on_click=lambda: reveal(lic))), wide=True)
        reset = SettingsCard("Reset", "Every preference back to its default. Your library, materials and drafts are "
                             "not touched.")
        reset.add(InfoRow("All settings", "Library folder and window position stay",
                          button("Reset settings…", "restore", "danger", on_click=self._reset)), wide=True)
        return [prog, reset]

    # actions ------------------------------------------------------------------------------------
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
