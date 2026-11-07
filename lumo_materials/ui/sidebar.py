"""Left sidebar: library switcher, actions, sections, categories, drop card."""
from __future__ import annotations

from PySide6.QtCore import QRectF, Qt, Signal
from PySide6.QtGui import QColor, QFontMetrics, QPainter, QPixmap
from PySide6.QtWidgets import (QButtonGroup, QFrame, QHBoxLayout, QLabel, QMenu, QPushButton, QScrollArea,
                               QVBoxLayout, QWidget)

from ..library.store import UNCATEGORIZED
from . import icons, theme
from .hub import Hub, reveal
from .widgets import button, hline, label


class NavButton(QPushButton):
    def __init__(self, text: str, icon: str | None = None, shortcut: str = "", swatch: str | None = None):
        super().__init__(text)
        self.setProperty("kind", "nav")
        self.setCheckable(True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.swatch = swatch
        self.right = shortcut
        if icon:
            self.setIcon(icons.icon(icon, theme.MUTED, theme.TEXT))
            self.setIconSize(icons.ICON_SIZE)
        elif swatch:
            self.setStyleSheet("QPushButton { padding-left: 34px; }")
        self.setFixedHeight(32)

    def set_right(self, text: str) -> None:
        self.right = text
        self.update()

    def paintEvent(self, e):
        super().paintEvent(e)
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        if self.swatch:   # small folder in the category colour
            c = QColor(self.swatch)
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(c)
            y = self.height() / 2 - 5
            p.drawRoundedRect(QRectF(11, y + 1.5, 14, 10), 2, 2)
            p.drawRoundedRect(QRectF(11, y, 6, 3), 1, 1)
        if self.right:
            f = self.font()
            f.setPixelSize(11)
            p.setFont(f)
            p.setPen(QColor(theme.FAINT))
            p.drawText(self.rect().adjusted(0, 0, -10, 0), Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignRight,
                       self.right)
        p.end()


class LibrarySwitch(QFrame):
    clicked = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setStyleSheet(f"LibrarySwitch {{ border: 1px solid {theme.LINE_2}; border-radius: 9px; background: #121213; }}"
                           f"LibrarySwitch:hover {{ background: #161618; }}")
        self.setFixedHeight(46)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setProperty("interactive", True)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(10, 0, 8, 0)
        lay.setSpacing(10)
        self.mark = QLabel()
        self.mark.setFixedSize(24, 24)
        logo = theme.asset_dir() / "icons" / "mark.png"
        if logo.exists():
            self.mark.setPixmap(QPixmap(str(logo)).scaled(24, 24, Qt.AspectRatioMode.KeepAspectRatio,
                                                          Qt.TransformationMode.SmoothTransformation))
        lay.addWidget(self.mark)
        col = QVBoxLayout()
        col.setSpacing(0)
        self.name = label("lumo materials")
        self.name.setStyleSheet("font-size: 14px; font-weight: 500;")
        self.path = label("No library yet")
        self.path.setStyleSheet(f"font-size: 11px; color: {theme.MUTED};")
        col.addWidget(self.name)
        col.addWidget(self.path)
        lay.addLayout(col, 1)
        ch = QLabel()
        ch.setPixmap(icons.pixmap("chev-ud", theme.MUTED))
        lay.addWidget(ch)

    def set_path(self, p: str) -> None:
        fm = QFontMetrics(self.path.font())
        self.path.setText(fm.elidedText(p, Qt.TextElideMode.ElideMiddle, 170))
        self.path.setToolTip(p)

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self.clicked.emit()


class Sidebar(QWidget):
    action = Signal(str)                 # new_photo | import | search | change_library | create_category
    section = Signal(str)                # library | favourites | recent | drafts | trash | settings
    categoryChosen = Signal(object)      # str | None
    categoryMenu = Signal(str, str)      # (action, category) rename | delete

    def __init__(self, hub: Hub, parent=None):
        super().__init__(parent)
        self.hub = hub
        self.setObjectName("Sidebar")
        self.setFixedWidth(260)
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        root = QVBoxLayout(self)
        root.setContentsMargins(10, 10, 10, 10)
        root.setSpacing(2)

        top = QWidget()
        top.setProperty("dragArea", True)
        tl = QVBoxLayout(top)
        tl.setContentsMargins(0, 0, 0, 8)
        self.switch = LibrarySwitch()
        self.switch.clicked.connect(self._switch_menu)
        tl.addWidget(self.switch)
        root.addWidget(top)

        self.b_search = NavButton("Search", "search", "/")
        self.b_new = NavButton("New from photo", "photo", "Ctrl N")
        self.b_import = NavButton("Import map set", "import", "Ctrl I")
        for b, key in ((self.b_search, "search"), (self.b_new, "new_photo"), (self.b_import, "import")):
            b.setCheckable(False)
            b.clicked.connect(lambda _=False, k=key: self.action.emit(k))
            root.addWidget(b)
        root.addSpacing(6)
        root.addWidget(hline())
        root.addSpacing(6)

        self.group = QButtonGroup(self)
        self.group.setExclusive(True)
        self.nav: dict[str, NavButton] = {}
        for key, text, ic in (("library", "Library", "grid"), ("favourites", "Favourites", "star"),
                              ("recent", "Recently added", "clock"), ("drafts", "Drafts", "file"),
                              ("trash", "Trash", "trash"), ("settings", "Settings", "gear")):
            b = NavButton(text, ic)
            self.group.addButton(b)
            self.nav[key] = b
            b.clicked.connect(lambda _=False, k=key: self.section.emit(k))
            root.addWidget(b)
        root.addSpacing(6)
        root.addWidget(hline())
        root.addSpacing(6)

        self.cat_area = QScrollArea()
        self.cat_area.setWidgetResizable(True)
        self.cat_area.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.cat_host = QWidget()
        self.cat_lay = QVBoxLayout(self.cat_host)
        self.cat_lay.setContentsMargins(0, 0, 0, 0)
        self.cat_lay.setSpacing(2)
        self.cat_area.setWidget(self.cat_host)
        root.addWidget(self.cat_area, 1)
        self.cat_buttons: dict[str, NavButton] = {}

        card = QFrame()
        card.setObjectName("Panel")
        cl = QVBoxLayout(card)
        cl.setContentsMargins(12, 12, 12, 12)
        cl.setSpacing(4)
        ic = QLabel()
        ic.setFixedSize(36, 36)
        ic.setAlignment(Qt.AlignmentFlag.AlignCenter)
        ic.setStyleSheet(f"border: 1px solid {theme.LINE_2}; border-radius: 8px; background: #161618;")
        ic.setPixmap(icons.pixmap("drop", theme.TEXT_2, 18))
        cl.addWidget(ic)
        cl.addSpacing(8)
        h = label("Drop a photo anywhere")
        h.setStyleSheet("font-size: 14px; font-weight: 500;")
        cl.addWidget(h)
        d = label("Seamless albedo, normal, roughness, height and AO in one step.", "muted", wrap=True)
        d.setStyleSheet(f"font-size: 12px; color: {theme.MUTED};")
        cl.addWidget(d)
        cl.addSpacing(8)
        cl.addWidget(button("New from photo", on_click=lambda: self.action.emit("new_photo")))
        root.addSpacing(8)
        root.addWidget(card)

        self.nav["library"].setChecked(True)
        hub.changed.connect(self.refresh)
        hub.draftsChanged.connect(self.refresh)
        hub.libraryOpened.connect(self.refresh)

    # ------------------------------------------------------------------
    def _switch_menu(self):
        m = QMenu(self)
        m.addAction("Change library folder…", lambda: self.action.emit("change_library"))
        if self.hub.library:
            m.addAction("Show in Explorer", lambda: reveal(self.hub.library.root))
            m.addAction("Rescan folder", lambda: self.action.emit("rescan"))
        m.exec(self.switch.mapToGlobal(self.switch.rect().bottomLeft()))

    def select_section(self, key: str) -> None:
        if key in self.nav:
            self.nav[key].setChecked(True)
        if key != "library":
            self.select_category(None)

    def select_category(self, cat: str | None) -> None:
        for name, b in self.cat_buttons.items():
            b.setChecked(name == cat)

    def refresh(self):
        lib = self.hub.library
        if lib:
            self.switch.set_path(str(lib.root))
            self.nav["library"].set_right(str(lib.count()))
            self.nav["favourites"].set_right(str(sum(1 for m in lib.all() if m.favourite)))
            self.nav["trash"].set_right(str(len(lib.trash_items())) if lib.trash_items() else "")
        drafts = len(self.hub.drafts.list())
        self.nav["drafts"].set_right(str(drafts) if drafts else "")
        current = next((n for n, b in self.cat_buttons.items() if b.isChecked()), None)
        while self.cat_lay.count():
            it = self.cat_lay.takeAt(0)
            if it.widget():
                it.widget().deleteLater()
        self.cat_buttons.clear()
        if lib:
            for i, (cat, n) in enumerate(lib.categories()):
                if n == 0 and cat == UNCATEGORIZED:
                    continue
                b = NavButton(cat, swatch=theme.category_colour(cat, i))
                b.setStyleSheet("QPushButton { padding-left: 34px; color: %s; }" % theme.TEXT)
                b.set_right(str(n))
                b.setChecked(cat == current)
                b.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
                b.customContextMenuRequested.connect(lambda _p, c=cat, w=b: self._cat_menu(c, w))
                b.clicked.connect(lambda _=False, c=cat: self._cat_clicked(c))
                self.cat_buttons[cat] = b
                self.cat_lay.addWidget(b)
        add = NavButton("Create category", "plus-folder")
        add.setCheckable(False)
        add.clicked.connect(lambda: self.action.emit("create_category"))
        self.cat_lay.addWidget(add)
        self.cat_lay.addStretch(1)

    def _cat_clicked(self, cat: str):
        b = self.cat_buttons.get(cat)
        on = b.isChecked() if b else False
        for name, other in self.cat_buttons.items():
            if name != cat:
                other.setChecked(False)
        self.categoryChosen.emit(cat if on else None)

    def _cat_menu(self, cat: str, w: QWidget):
        m = QMenu(self)
        if cat != UNCATEGORIZED:
            m.addAction(icons.icon("edit"), "Rename…", lambda: self.categoryMenu.emit("rename", cat))
            m.addAction(icons.icon("trash"), "Delete (materials move to Uncategorized)",
                        lambda: self.categoryMenu.emit("delete", cat))
        if self.hub.library:
            m.addAction(icons.icon("folder"), "Show in Explorer",
                        lambda: reveal(self.hub.library.materials_dir / cat))
        m.exec(w.mapToGlobal(w.rect().bottomLeft()))
