"""The main window: sidebar | pages | inspector, frameless with custom caption buttons."""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QByteArray, QEasingCurve, QPropertyAnimation, Qt, QTimer
from PySide6.QtGui import QKeySequence, QShortcut
from PySide6.QtWidgets import (QApplication, QGraphicsOpacityEffect, QHBoxLayout, QLabel, QLineEdit, QPlainTextEdit,
                               QStackedWidget, QVBoxLayout, QWidget)

from .. import APP_NAME
from ..engine import importer as imp
from ..engine import imageio
from ..engine.imageio import PHOTO_EXTENSIONS
from .dialogs import DetailsDialog, ExportDialog, LibraryChooser, MoveDialog, TagDialog, confirm, prompt
from .editor import EditorPage, pick_maps, pick_photo
from .frameless import FramelessWindow
from .hub import Hub, reveal
from .inspector import Inspector
from .library_page import LibraryPage
from .pages import DraftsPage, SettingsPage, TrashPage
from .sidebar import Sidebar
from . import theme
from .widgets import CaptionButtons, Toast, label, vline

INSPECTOR_MIN_WIDTH = 1120


class DropOverlay(QWidget):
    def __init__(self, parent):
        super().__init__(parent)
        self.setObjectName("DropOverlay")
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)
        lay = QVBoxLayout(self)
        lay.addStretch(1)
        self.title = label("Drop to create a material", "title")
        self.title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.sub = label("One photo: new material.  Several map files: import as a map set.", "muted")
        self.sub.setAlignment(Qt.AlignmentFlag.AlignCenter)
        lay.addWidget(self.title)
        lay.addWidget(self.sub)
        lay.addStretch(1)
        self.hide()


class MainWindow(FramelessWindow):
    def __init__(self, hub: Hub):
        super().__init__()
        self.hub = hub
        self.setObjectName("Root")
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setWindowTitle(APP_NAME)
        self.setMinimumSize(980, 640)
        self.setAcceptDrops(True)

        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(0)
        self.sidebar = Sidebar(hub)
        lay.addWidget(self.sidebar)
        lay.addWidget(vline())
        self.pages = QStackedWidget()
        self.pages.setObjectName("Pages")
        lay.addWidget(self.pages, 1)
        self.inspector_line = vline()
        lay.addWidget(self.inspector_line)
        self.inspector = Inspector(hub)
        lay.addWidget(self.inspector)

        self.library = LibraryPage(hub)
        self.editor = EditorPage(hub)
        self.trash = TrashPage(hub)
        self.drafts = DraftsPage(hub)
        self.settings_page = SettingsPage(hub)
        self.page_by_name = {"library": self.library, "editor": self.editor, "trash": self.trash,
                             "drafts": self.drafts, "settings": self.settings_page}
        for p in self.page_by_name.values():
            self.pages.addWidget(p)

        self.caption = CaptionButtons(self, self)
        self.toast = Toast(self)
        self.drop = DropOverlay(self)
        hub.set_notifier(lambda text, kind="info", action=None, cb=None: self.toast.show_message(text, kind, action, cb))

        # wiring -----------------------------------------------------------------
        self.sidebar.action.connect(self._sidebar_action)
        self.sidebar.section.connect(self._section)
        self.sidebar.categoryChosen.connect(self._category)
        self.sidebar.categoryMenu.connect(self._category_menu)
        self.sidebar.categoryColour.connect(self._category_colour)
        self.library.currentChanged.connect(self._current_material)
        self.library.openEditor.connect(self._open_editor)
        self.library.requestExport.connect(self._export)
        self.library.requestNew.connect(self._sidebar_action)
        self.library.bulkAction.connect(self._bulk)
        self.inspector.action.connect(self._inspector_action)
        self.editor.closed.connect(self._editor_closed)
        self.editor.showExisting.connect(self._show_existing)
        self.drafts.openDraft.connect(self._open_draft)
        hub.changed.connect(self._after_change)
        hub.settingsChanged.connect(self._setting_changed)
        imageio.PNG_LEVEL = 6 if hub.settings.get("png_compression") == "small" else 1
        for view in (self.inspector.card.view, self.editor.card.view):
            view.usingFallback.connect(self._gpu_fallback)

        for keys, fn in (("/", self._focus_search), ("Ctrl+F", self._focus_search), ("Ctrl+N", lambda: self._sidebar_action("new_photo")),
                         ("Ctrl+I", lambda: self._sidebar_action("import")), ("F5", lambda: self._sidebar_action("rescan")),
                         ("Delete", self._delete_key), ("Ctrl+A", self._select_all), ("Escape", self._escape),
                         ("Ctrl+E", lambda: self._export(self.library.checked_or_current())),
                         ("Ctrl+S", self._save_key)):
            sc = QShortcut(QKeySequence(keys), self)
            sc.setContext(Qt.ShortcutContext.WindowShortcut)
            sc.activated.connect(fn)

        self.show_page("library")
        self.sidebar.refresh()
        self.library.reload()
        self._restore_geometry()

    # ------------------------------------------------------------------ layout
    def resizeEvent(self, e):
        super().resizeEvent(e)
        self.caption.adjustSize()
        self.caption.move(self.width() - self.caption.width(), 0)
        self.caption.raise_()
        self.drop.setGeometry(self.rect().adjusted(270, 10, -10, -10))
        self._update_inspector()
        if self.toast.isVisible():
            from .widgets import TOAST_BOTTOM
            self.toast.move((self.width() - self.toast.width()) // 2, self.height() - self.toast.height() - TOAST_BOTTOM)

    def changeEvent(self, e):
        super().changeEvent(e)
        if e.type() == e.Type.WindowStateChange:
            self.caption.sync()

    def _update_inspector(self) -> None:
        show = self.pages.currentWidget() is self.library and self.width() >= INSPECTOR_MIN_WIDTH
        self.inspector.setVisible(show)
        self.inspector_line.setVisible(show)
        self.library.set_caption_space(not show)
        self.caption.raise_()

    def show_page(self, name: str) -> None:
        page = self.page_by_name[name]
        old = self.pages.currentWidget()
        snap = None
        # cross-fade: a picture of the old page dissolves over the new one. Not to or from the editor: its 3D
        # view is drawn by the GPU and a snapshot of it would flash.
        if (theme.ANIMATIONS and self.isVisible() and old is not None and old is not page
                and self.editor not in (old, page)):
            snap = self.pages.grab()
        if name in ("trash", "drafts", "settings"):
            page.refresh()
        self.pages.setCurrentWidget(page)
        self._update_inspector()
        if snap is not None:
            self._fade_out(snap)

    def _fade_out(self, pixmap) -> None:
        cover = QLabel(self.pages)
        cover.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)
        cover.setPixmap(pixmap)
        cover.setGeometry(self.pages.rect())
        eff = QGraphicsOpacityEffect(cover)
        cover.setGraphicsEffect(eff)
        cover.show()
        cover.raise_()
        anim = QPropertyAnimation(eff, b"opacity", cover)
        anim.setDuration(170)
        anim.setEasingCurve(QEasingCurve.Type.OutCubic)
        anim.setStartValue(1.0)
        anim.setEndValue(0.0)
        anim.finished.connect(cover.deleteLater)
        anim.start()

    def _setting_changed(self, key: str) -> None:
        s = self.hub.settings
        if key == "accent":
            theme.set_accent(s.get("accent"))
            theme.reapply()
            for w in QApplication.allWidgets():
                w.update()
        elif key == "animations":
            theme.ANIMATIONS = s.get("animations") != "off"
            self.library.apply_settings(key)
        elif key in ("thumb_style", "card_tags", "page_size", "sort"):
            self.library.apply_settings(key)
        elif key == "png_compression":
            imageio.PNG_LEVEL = 6 if s.get("png_compression") == "small" else 1
        elif key in ("preview_shape", "preview_spin", "light", "background"):
            self.inspector.apply_settings(key)
            if key in ("light", "preview_shape"):
                if key == "preview_shape":
                    self.editor.card.shape.setValue(s.get(key))
                self.editor.card.view.set_option("shape" if key == "preview_shape" else key, s.get(key))
        elif key == "editor_tiling":
            self.editor.card.set_tiling(float(s.get("editor_tiling") or 2.0))

    def _restore_geometry(self) -> None:
        g = self.hub.settings.get("window")
        if isinstance(g, dict) and g.get("geometry"):
            self.restoreGeometry(QByteArray.fromBase64(g["geometry"].encode()))
            if g.get("maximized"):
                QTimer.singleShot(0, self.showMaximized)
        else:
            scr = QApplication.primaryScreen().availableGeometry()
            w, h = min(1600, int(scr.width() * 0.9)), min(1000, int(scr.height() * 0.9))
            self.resize(w, h)
            self.move(scr.center().x() - w // 2, scr.center().y() - h // 2)
        if self.hub.settings.get("startup_window") == "maximized":
            QTimer.singleShot(0, self.showMaximized)

    def closeEvent(self, e):
        if self.pages.currentWidget() is self.editor and (self.editor.dirty or self.editor.saving):
            if not self.editor.leave():
                e.ignore()
                return
        geo = bytes(self.saveGeometry().toBase64()).decode()
        self.hub.settings.set("window", {"geometry": geo, "maximized": self.isMaximized()})
        self.hub.runner.wait(4000)
        super().closeEvent(e)

    # ------------------------------------------------------------------ helpers
    def _need_library(self) -> bool:
        if self.hub.library:
            return True
        return bool(LibraryChooser(self, self.hub, first_start=True).exec())

    def choose_library_first(self) -> None:
        if not self.hub.library:
            LibraryChooser(self, self.hub, first_start=True).exec()

    def _leave_editor_if_needed(self) -> bool:
        if self.pages.currentWidget() is self.editor:
            return self.editor.leave()
        return True

    def activate(self) -> None:
        if self.isMinimized():
            self.showNormal()
        self.show()
        self.raise_()
        self.activateWindow()

    # ------------------------------------------------------------------ drag and drop
    def dragEnterEvent(self, e):
        if e.mimeData().hasUrls() and any(u.isLocalFile() and Path(u.toLocalFile()).suffix.lower() in PHOTO_EXTENSIONS
                                          for u in e.mimeData().urls()):
            e.acceptProposedAction()
            self.drop.show()
            self.drop.raise_()

    def dragLeaveEvent(self, e):
        self.drop.hide()

    def dropEvent(self, e):
        self.drop.hide()
        files = [u.toLocalFile() for u in e.mimeData().urls() if u.isLocalFile()]
        e.acceptProposedAction()
        QTimer.singleShot(0, lambda: self.open_files(files))

    def open_files(self, files: list[str]) -> None:
        files = [f for f in files if Path(f).is_file() and Path(f).suffix.lower() in PHOTO_EXTENSIONS]
        if not files or not self._need_library() or not self._leave_editor_if_needed():
            return
        if len(files) == 1 and imp.guess(files[0])[0] in ("albedo", "ignore"):
            self.editor.start_photo(files[0], self.library.f.category)
        else:
            self.editor.start_import(files, self.library.f.category)
        self.show_page("editor")

    # ------------------------------------------------------------------ actions
    def _sidebar_action(self, key: str) -> None:
        if key == "search":
            self._section("library")
            self.sidebar.select_section("library")
            self.library.focus_search()
        elif key == "new_photo":
            if not self._need_library():
                return
            path = pick_photo(self, self.hub)
            if path:
                self._start_photo(path)
        elif key == "import":
            if not self._need_library():
                return
            paths = pick_maps(self, self.hub)
            if paths and self._leave_editor_if_needed():
                self.editor.start_import(paths, self.library.f.category)
                self.show_page("editor")
        elif key == "change_library":
            if self._leave_editor_if_needed() and LibraryChooser(self, self.hub).exec():
                self.library.clear_filters()
                self.show_page("library")
                self.hub.notify(f"Library: {self.hub.library.root}", "ok")
        elif key == "rescan":
            if self.hub.library:
                n = self.hub.rescan()
                self.hub.notify(f"Rescanned: {n} materials", "ok")
        elif key == "create_category":
            if not self._need_library():
                return
            name = prompt(self, "New category", "A category is a folder inside Materials.", "", "Create")
            if name:
                try:
                    self.hub.library.create_category(name)
                    self.hub.changed.emit()
                except Exception as ex:
                    self.hub.error(str(ex))

    def _start_photo(self, path: str) -> None:
        if self._leave_editor_if_needed():
            self.editor.start_photo(path, self.library.f.category)
            self.show_page("editor")

    def _section(self, key: str) -> None:
        if key in ("library", "favourites", "recent"):
            if not self._leave_editor_if_needed():
                self.sidebar.select_section("library")
                return
            self.library.set_view(key)
            self.sidebar.select_category(None)
            self.show_page("library")
        else:
            if not self._leave_editor_if_needed():
                return
            self.show_page(key)

    def _category(self, cat) -> None:
        if not self._leave_editor_if_needed():
            return
        self.sidebar.select_section("library")
        self.sidebar.nav["library"].setChecked(True)
        self.library.set_category(cat)
        self.sidebar.select_category(cat)
        self.show_page("library")

    def _category_menu(self, action: str, cat: str) -> None:
        lib = self.hub.library
        if not lib:
            return
        try:
            if action == "rename":
                new = prompt(self, "Rename category", "", cat, "Rename")
                if new and new != cat:
                    lib.rename_category(cat, new)
                    if self.library.f.category == cat:
                        self.library.f.category = new
            elif action == "delete":
                n = dict(lib.categories()).get(cat, 0)
                if confirm(self, f"Delete {cat}?", f"Its {n} material{'s move' if n != 1 else ' moves'} to Uncategorized. "
                           "Nothing is deleted from disk.", "Delete category", True):
                    lib.delete_category(cat)
                    if self.library.f.category == cat:
                        self.library.f.category = None
        except Exception as ex:
            self.hub.error(str(ex))
        self.hub.changed.emit()

    def _category_colour(self, cat: str, colour: str) -> None:
        lib = self.hub.library
        if not lib:
            return
        try:
            lib.set_category_colour(cat, colour or None)
        except Exception as ex:
            self.hub.error(str(ex))
        self.hub.changed.emit()

    def _current_material(self, m) -> None:
        self.inspector.show_material(m)
        if m is not None:                    # the cards around it load in the background: next click is instant
            self.inspector.prefetch(self.library.neighbours(m.id, 2))

    def _open_editor(self, mode: str, mid: str) -> None:
        if not self._leave_editor_if_needed():
            return
        try:
            if mode == "regenerate":
                self.editor.start_regenerate(mid)
            else:
                self.editor.start_adjust(mid)
        except Exception as ex:
            self.hub.error(str(ex))
            return
        if self.editor.mode in ("adjust", "regenerate") and self.editor.material_id == mid:
            self.show_page("editor")

    def _open_draft(self, d) -> None:
        self.editor.open_draft(d)
        if self.editor.draft is d:
            self.show_page("editor")

    def _editor_closed(self, saved_id) -> None:
        self.show_page("library")
        self.sidebar.select_section("library")
        if saved_id:
            self.library.select(saved_id)

    def _show_existing(self, mid: str) -> None:
        """From the duplicate notice: leave the editor (asking about unsaved work) and select the material."""
        if self.editor.leave():
            self.library.select(mid)

    def _inspector_action(self, what: str, mid: str) -> None:
        if what in ("adjust", "regenerate"):
            self._open_editor(what, mid)
        elif what == "export":
            self._export([mid])
        else:
            self._bulk(what, [mid])

    def _export(self, ids: list[str]) -> None:
        if ids and self.hub.library:
            ExportDialog(self, self.hub, ids).exec()

    def _bulk(self, what: str, ids: list[str]) -> None:
        lib = self.hub.library
        if not lib or not ids:
            return
        try:
            if what == "move":
                d = MoveDialog(self, lib, len(ids))
                if d.exec() == 1 and d.cat.value():
                    lib.bulk(ids, category=d.cat.value())
                    self.library.clear_checked()
            elif what == "tag":
                d = TagDialog(self, len(ids))
                if d.exec() == 1:
                    lib.bulk(ids, add_tags=d.add.tags(), remove_tags=d.remove.tags())
            elif what == "favourite":
                all_fav = all(lib.get(i).favourite for i in ids)
                lib.bulk(ids, favourite=not all_fav)
            elif what == "export":
                self._export(ids)
                return
            elif what == "trash":
                names = [lib.get(i).name for i in ids]
                if self.hub.settings.get("confirm_trash"):
                    what_ = names[0] if len(ids) == 1 else f"{len(ids)} materials"
                    if not confirm(self, f"Move {what_} to the trash?", "You can restore it from Trash.",
                                   "Move to trash", True):
                        return
                lib.trash(ids)
                self.library.clear_checked()
                text = f"Moved {names[0]} to the trash" if len(ids) == 1 else f"Moved {len(ids)} materials to the trash"
                self.hub.notify(text, "info", "Undo", lambda i=list(ids): self._undo_trash(i))
            elif what == "clear":
                self.library.clear_checked()
                return
            elif what == "details":
                m = lib.get(ids[0])
                d = DetailsDialog(self, lib, m)
                if d.exec() == 1:
                    lib.update(m.id, **d.values())
            elif what == "duplicate":
                c = lib.duplicate(ids[0])
                self.hub.changed.emit()
                self.library.select(c.id)
                self.hub.notify(f"Duplicated as {c.name}", "ok")
                return
            elif what == "reveal":
                reveal(lib.get(ids[0]).folder)
                return
        except Exception as ex:
            self.hub.error(str(ex))
        self.hub.changed.emit()

    def _undo_trash(self, ids: list[str]) -> None:
        lib = self.hub.library
        if not lib:
            return
        restored = 0
        for t in lib.trash_items():
            if t.id.split("-")[0] in ids:
                try:
                    lib.restore(t.id)
                    restored += 1
                except Exception as ex:
                    self.hub.error(str(ex))
        self.hub.changed.emit()
        if restored:
            self.hub.notify(f"Restored {restored} material{'s' if restored != 1 else ''}", "ok")

    def _after_change(self) -> None:
        cur = self.inspector.material
        lib = self.hub.library
        if cur and lib:
            try:
                fresh = lib.get(cur.id)
            except Exception:
                fresh = None
            if fresh is None:
                self.inspector.show_material(None)
            else:
                self.inspector.show_material(fresh, reload=False)   # reloads maps only if they changed on disk

    def _gpu_fallback(self, reason: str) -> None:
        from .viewer import MaterialView
        if MaterialView.chain == ["cpu"]:
            self.hub.gpu_note = f"CPU preview ({reason[:200]})"
            self.hub.notify("No Direct3D or OpenGL device is available: the 3D preview runs on the CPU.", "warn")

    # ------------------------------------------------------------------ keys
    def _typing(self) -> bool:
        return isinstance(QApplication.focusWidget(), (QLineEdit, QPlainTextEdit))

    def _focus_search(self) -> None:
        if self._typing():
            return
        self._sidebar_action("search")

    def _delete_key(self) -> None:
        if self._typing() or self.pages.currentWidget() is not self.library:
            return
        self._bulk("trash", self.library.checked_or_current())

    def _select_all(self) -> None:
        if not self._typing() and self.pages.currentWidget() is self.library:
            self.library.select_all_on_page()

    def _escape(self) -> None:
        if self.pages.currentWidget() is self.editor:
            self.editor.leave()
        elif self.pages.currentWidget() is self.library:
            if self.library.model.checked:
                self.library.clear_checked()
            elif self.library.search.text():
                self.library.clear_filters()
        elif self.pages.currentWidget() in (self.trash, self.drafts, self.settings_page):
            self._section("library")
            self.sidebar.select_section("library")

    def _save_key(self) -> None:
        if self.pages.currentWidget() is self.editor:
            self.editor.save()

