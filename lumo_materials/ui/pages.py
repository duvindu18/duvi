"""Trash, Drafts and Settings pages."""
from __future__ import annotations

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QPixmap
from PySide6.QtWidgets import QFrame, QHBoxLayout, QLabel, QScrollArea, QVBoxLayout, QWidget

from .. import APP_NAME, __version__
from ..engine.presets import PRESETS
from . import icons, theme
from .dialogs import LibraryChooser, confirm
from .hub import Hub, app_dir, reveal
from .library_page import ago
from .widgets import ChoiceRow, button, clear_layout, label


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


class SettingsPage(_Page):
    def __init__(self, hub: Hub, parent=None):
        super().__init__(hub, "Settings", "gear", parent)
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

    def _section(self, text: str) -> None:
        lb = label(text, "section")
        lb.setContentsMargins(0, 18, 0, 4)
        self.body.addWidget(lb)

    def refresh(self) -> None:
        self.clear_body()
        s, lib = self.hub.settings, self.hub.library
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
        self._section("NEW MATERIALS")
        preset = ChoiceRow("Default material type", [(k, v[0]) for k, v in PRESETS.items()], s.get("default_preset"))
        preset.changed.connect(lambda v: s.set("default_preset", v))
        self.body.addWidget(preset)
        size = ChoiceRow("Default output size", [("512", "512 px"), ("1024", "1024 px"), ("2048", "2048 px"),
                                                 ("4096", "4096 px")], str(s.get("default_output_px")))
        size.changed.connect(lambda v: s.set("default_output_px", int(v)))
        self.body.addWidget(size)
        prev = ChoiceRow("Live preview resolution", [("512", "512 px (fastest)"), ("768", "768 px"),
                                                     ("1024", "1024 px (sharper)")], str(s.get("preview_px")))
        prev.changed.connect(lambda v: s.set("preview_px", int(v)))
        self.body.addWidget(prev)
        self._section("3D PREVIEW")
        from .viewer import OPENGL_MODES, MaterialView
        gl = ChoiceRow("Renderer (after restart)", OPENGL_MODES, s.get("opengl") or "auto")
        gl.changed.connect(lambda v: (s.set("opengl", v),
                                      self.hub.notify("The renderer changes the next time lumo materials starts.", "info")))
        self.body.addWidget(gl)
        now = self.hub.gpu_note or ("Software OpenGL" if MaterialView.opengl_mode == "software" else
                                    "CPU preview" if MaterialView.opengl_mode == "off" else "Graphics card (OpenGL 3.3+)")
        self.body.addWidget(self._kv("In use now", now + (f"  ({MaterialView.gl_info})" if MaterialView.gl_info else "")))
        self._section("PROGRAM")
        self.body.addWidget(self._kv("Version", f"{APP_NAME} {__version__}"))
        self.body.addWidget(self._kv("Program data", str(s.folder), button("Show", "reveal", "ghost",
                                                                           on_click=lambda: reveal(s.folder))))
        lic = theme.asset_dir() / "licenses"
        self.body.addWidget(self._kv("Licences", "Inter (SIL OFL 1.1), Qt / PySide6 (LGPL 3), NumPy (BSD), Pillow (MIT-CMU)",
                                     button("Open", "reveal", "ghost", on_click=lambda: reveal(lic))))
        self.body.addWidget(self._kv("Installed in", str(app_dir())))
        self.body.addStretch(1)

    def _change(self) -> None:
        if LibraryChooser(self.window(), self.hub).exec():
            self.hub.notify(f"Library: {self.hub.library.root}", "ok")
            self.refresh()

    def _rescan(self) -> None:
        n = self.hub.rescan()
        self.hub.notify(f"Rescanned: {n} materials", "ok")
        self.refresh()

