"""Frameless dialogs in the app style."""
from __future__ import annotations

from pathlib import Path
from typing import Sequence

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QComboBox, QDialog, QFileDialog, QFrame, QHBoxLayout, QLineEdit, QPlainTextEdit,
                               QProgressBar, QVBoxLayout, QWidget)

from ..library.export import ExportOptions, export_folder, export_zip
from ..library.store import Library, Material, inspect_folder
from . import theme
from .hub import Hub, app_dir, reveal
from .widgets import ChoiceRow, Segmented, TagEdit, ToggleRow, button, label


class FDialog(QDialog):
    def __init__(self, parent: QWidget | None, title: str, width: int = 440):
        super().__init__(parent)
        self.setWindowFlags(Qt.WindowType.Dialog | Qt.WindowType.FramelessWindowHint)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setModal(True)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        self.frame = QFrame()
        self.frame.setObjectName("Panel")
        self.frame.setStyleSheet(f"QFrame#Panel {{ background: #121213; border: 1px solid {theme.LINE_2}; border-radius: 12px; }}")
        outer.addWidget(self.frame)
        lay = QVBoxLayout(self.frame)
        lay.setContentsMargins(20, 14, 14, 18)
        lay.setSpacing(12)
        head = QHBoxLayout()
        self.title = label(title, "h2")
        head.addWidget(self.title, 1)
        close = button("", "close", "ghost", "Close", self.reject)
        close.setFixedSize(28, 28)
        head.addWidget(close)
        lay.addLayout(head)
        self.body = QVBoxLayout()
        self.body.setSpacing(10)
        self.body.setContentsMargins(0, 0, 6, 0)
        lay.addLayout(self.body)
        self.buttons = QHBoxLayout()
        self.buttons.setSpacing(8)
        self.buttons.addStretch(1)
        lay.addSpacing(4)
        lay.addLayout(self.buttons)
        self.setFixedWidth(width)
        self._drag = None

    def add_button(self, text: str, kind: str | None = None, result: int | None = None, icon: str | None = None):
        b = button(text, icon, kind)
        if result is not None:
            b.clicked.connect(lambda: self.done(result))
        self.buttons.addWidget(b)
        return b

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton and e.position().y() < 48 and self.windowHandle():
            self.windowHandle().startSystemMove()

    def showEvent(self, e):
        super().showEvent(e)
        par = self.parentWidget()
        if par is not None:
            g = par.window().frameGeometry()
            self.adjustSize()
            self.move(g.center().x() - self.width() // 2, g.center().y() - self.height() // 2)


def ask(parent, title: str, text: str, choices: Sequence[tuple[str, str, str | None]], default: str | None = None) -> str:
    """choices: (key, label, kind). Returns the key, or '' if closed."""
    d = FDialog(parent, title)
    t = label(text, "muted", wrap=True)
    d.body.addWidget(t)
    result = {"key": ""}
    for key, text_, kind in choices:
        b = d.add_button(text_, kind)
        b.clicked.connect(lambda _=False, k=key: (result.__setitem__("key", k), d.accept()))
        if key == default:
            b.setDefault(True)
    d.exec()
    return result["key"]


def confirm(parent, title: str, text: str, ok: str = "OK", danger: bool = False) -> bool:
    return ask(parent, title, text, [("cancel", "Cancel", "ghost"), ("ok", ok, "danger" if danger else "primary")],
               "ok") == "ok"


def prompt(parent, title: str, text: str, value: str = "", ok: str = "OK") -> str | None:
    d = FDialog(parent, title)
    if text:
        d.body.addWidget(label(text, "muted", wrap=True))
    e = QLineEdit(value)
    e.selectAll()
    d.body.addWidget(e)
    d.add_button("Cancel", "ghost", 0)
    b = d.add_button(ok, "primary", 1)
    b.setDefault(True)
    e.returnPressed.connect(lambda: d.done(1))
    e.setFocus()
    return e.text().strip() if d.exec() == 1 and e.text().strip() else None


def category_combo(lib: Library | None, current: str = "") -> QComboBox:
    c = QComboBox()
    c.setEditable(True)
    cats = [name for name, _ in lib.categories()] if lib else []
    c.addItems(cats)
    if current:
        i = c.findText(current)
        if i >= 0:
            c.setCurrentIndex(i)
        else:
            c.setEditText(current)
    return c


class DetailsDialog(FDialog):
    def __init__(self, parent, lib: Library, m: Material):
        super().__init__(parent, "Edit details", 460)
        self.name = QLineEdit(m.name)
        self.cat = category_combo(lib, m.category)
        self.tags = TagEdit()
        self.tags.setTags(m.tags)
        self.desc = QPlainTextEdit(m.description)
        self.desc.setFixedHeight(80)
        self.fav = ToggleRow("Favourite", m.favourite)
        for text, w in (("Name", self.name), ("Category", self.cat), ("Tags", self.tags), ("Description", self.desc)):
            self.body.addWidget(label(text, "section"))
            self.body.addWidget(w)
        self.body.addWidget(self.fav)
        self.add_button("Cancel", "ghost", 0)
        self.add_button("Save", "primary", 1).setDefault(True)

    def values(self) -> dict:
        return dict(name=self.name.text().strip(), category=self.cat.currentText().strip(), tags=self.tags.tags(),
                    description=self.desc.toPlainText().strip(), favourite=self.fav.checked())


class TagDialog(FDialog):
    def __init__(self, parent, count: int):
        super().__init__(parent, f"Tag {count} material{'s' if count != 1 else ''}")
        self.add = TagEdit()
        self.remove = TagEdit()
        self.remove.setPlaceholderText("tags to remove, separated by commas")
        self.body.addWidget(label("Add tags", "section"))
        self.body.addWidget(self.add)
        self.body.addWidget(label("Remove tags", "section"))
        self.body.addWidget(self.remove)
        self.add_button("Cancel", "ghost", 0)
        self.add_button("Apply", "primary", 1).setDefault(True)


class MoveDialog(FDialog):
    def __init__(self, parent, lib: Library, count: int):
        super().__init__(parent, f"Move {count} material{'s' if count != 1 else ''}")
        self.cat = category_combo(lib)
        self.body.addWidget(label("To category (type a new name to create one)", "muted", wrap=True))
        self.body.addWidget(self.cat)
        self.add_button("Cancel", "ghost", 0)
        self.add_button("Move", "primary", 1).setDefault(True)


class ExportDialog(FDialog):
    def __init__(self, parent, hub: Hub, ids: list[str]):
        super().__init__(parent, f"Export {len(ids)} material{'s' if len(ids) != 1 else ''}", 480)
        self.hub, self.ids = hub, ids
        self.target = Segmented([("zip", "ZIP file"), ("folder", "Folder")], "zip")
        self.body.addWidget(self.target)
        self.normal = ChoiceRow("Normal map", [("gl", "OpenGL (Blender, Unity)"), ("dx", "DirectX (Unreal, 3ds Max)")], "gl")
        self.naming = ChoiceRow("File names", [("plain", "albedo.png …"), ("engine", "Name_BaseColor.png …")], "plain")
        self.height_row = ChoiceRow("Height map", [("16", "16-bit PNG"), ("8", "8-bit PNG")], "16")
        self.orm = ToggleRow("Packed ORM map", False)
        self.previews = ToggleRow("Include previews", False)
        for w in (self.normal, self.naming, self.height_row, self.orm, self.previews):
            self.body.addWidget(w)
        self.progress = QProgressBar()
        self.progress.setRange(0, 1000)
        self.progress.hide()
        self.status = label("", "muted")
        self.body.addWidget(self.progress)
        self.body.addWidget(self.status)
        self.add_button("Cancel", "ghost", 0)
        self.go = self.add_button("Export…", "primary", None, "export")
        self.go.clicked.connect(self._export)

    def _options(self) -> ExportOptions:
        return ExportOptions(normal=self.normal.value(), naming=self.naming.value(), orm=self.orm.checked(),
                             height_bits=int(self.height_row.value()), include_previews=self.previews.checked())

    def _export(self):
        lib = self.hub.library
        if not lib:
            return
        last = self.hub.settings.get("last_folder") or str(Path.home())
        opts = self._options()
        if self.target.value() == "zip":
            default = lib.get(self.ids[0]).name if len(self.ids) == 1 else "lumo materials"
            path, _ = QFileDialog.getSaveFileName(self, "Export as ZIP", str(Path(last) / f"{default}.zip"), "ZIP files (*.zip)")
            if not path:
                return
            self.hub.settings.set("last_folder", str(Path(path).parent))
            fn, target = export_zip, path
        else:
            path = QFileDialog.getExistingDirectory(self, "Export into folder", last)
            if not path:
                return
            self.hub.settings.set("last_folder", path)
            fn, target = export_folder, path
        self.go.setEnabled(False)
        self.progress.show()
        self.hub.runner.run("export", fn, lib, self.ids, target, opts, on_done=self._done, on_error=self._failed,
                            on_progress=lambda f, s: (self.progress.setValue(int(f * 1000)), self.status.setText(s)))

    def _done(self, result):
        where = result if isinstance(result, Path) else (result[0] if result else None)
        self.accept()
        if where is not None:
            self.hub.notify(f"Exported to {where}", "ok", "Show", lambda: reveal(where))

    def _failed(self, msg: str):
        self.go.setEnabled(True)
        self.progress.hide()
        self.status.setText(msg)
        self.status.setProperty("role", "error")
        theme.restyle(self.status)


class LibraryChooser(FDialog):
    """First start (or 'Change library folder'): pick or create the folder that holds the library."""

    def __init__(self, parent, hub: Hub, first_start: bool = False):
        super().__init__(parent, "Choose your material library" if first_start else "Change library folder", 520)
        self.hub = hub
        intro = ("Pick a folder for your materials. It can be a new empty folder, an existing lumo library, or any "
                 "other folder (then only a Materials folder and a library.json are added). You can change it later.")
        self.body.addWidget(label(intro, "muted", wrap=True))
        row = QHBoxLayout()
        self.path = QLineEdit(hub.settings.get("library_dir") or self._suggest())
        self.path.textChanged.connect(self._check)
        row.addWidget(self.path, 1)
        row.addWidget(button("Browse…", "folder", on_click=self._browse))
        self.body.addLayout(row)
        self.state = label("", "muted", wrap=True)
        self.body.addWidget(self.state)
        if not first_start:
            self.add_button("Cancel", "ghost", 0)
        self.ok = self.add_button("Use this folder", "primary", None)
        self.ok.clicked.connect(self._accept)
        self._info = None
        self._check()

    @staticmethod
    def _suggest() -> str:
        import os
        import sys
        if sys.platform == "win32":
            for drive in ("D:\\", "E:\\"):
                if os.path.isdir(drive):
                    return drive + ".lumo\\materials"
        return str(Path.home() / "Documents" / "lumo materials")

    def _browse(self):
        start = self.path.text() or str(Path.home())
        p = QFileDialog.getExistingDirectory(self, "Library folder", start)
        if p:
            self.path.setText(str(Path(p)))

    def _check(self):
        p = self.path.text().strip()
        if not p:
            self.state.setText("Type a path or press Browse.")
            self.ok.setEnabled(False)
            return
        self._info = inspect_folder(p, app_dir())
        st = self._info["state"]
        text = {
            "library": f"An existing library with {self._info.get('materials', 0)} materials. It is opened as it is.",
            "empty": "An empty folder. The library is created here.",
            "new": "This folder does not exist yet. It is created.",
            "other": "This folder already holds other files. They stay untouched; a Materials folder and a "
                     "library.json are added.",
            "refused": self._info.get("reason", "This folder cannot be used."),
        }[st]
        self.state.setText(text)
        self.state.setProperty("role", "error" if st == "refused" else "muted")
        theme.restyle(self.state)
        self.ok.setEnabled(st != "refused")
        self.ok.setText("Add library here" if st == "other" else "Use this folder")

    def _accept(self):
        try:
            self.hub.open_library(self.path.text().strip())
        except Exception as e:  # show any problem in the dialog
            self.state.setText(str(e))
            self.state.setProperty("role", "error")
            theme.restyle(self.state)
            return
        self.accept()
