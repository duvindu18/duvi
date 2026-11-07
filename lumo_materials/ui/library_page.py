"""The library page: header, title row, filter pills, card grid / list, pager, bulk actions."""
from __future__ import annotations

import datetime as dt
from typing import Callable

from PySide6.QtCore import QAbstractListModel, QEvent, QModelIndex, QPointF, QRect, QRectF, QSize, Qt, Signal
from PySide6.QtGui import QColor, QFont, QFontMetrics, QPainter, QPainterPath, QPen, QPixmap, QPixmapCache
from PySide6.QtWidgets import (QAbstractItemView, QHBoxLayout, QListView, QMenu, QPushButton, QStackedLayout,
                               QStyle, QStyledItemDelegate, QStyleOptionViewItem, QVBoxLayout, QWidget)

from ..library.store import Material
from ..viewmodel import LibraryFilter, grid_layout
from . import icons, theme
from .hub import Hub
from .widgets import Pager, SearchField, Segmented, button, human_bytes, label

SORTS = [("recent", "Recently added"), ("modified", "Recently changed"), ("name", "Name"),
         ("category", "Category"), ("size", "Resolution")]
GAP = 12


def ago(iso: str) -> str:
    try:
        t = dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return ""
    s = (dt.datetime.now(dt.timezone.utc) - t).total_seconds()
    if s < 90:
        return "just now"
    if s < 3600:
        return f"{int(s // 60)} minutes ago"
    if s < 86400 * 2:
        h = int(s // 3600)
        return f"{h} hour{'s' if h != 1 else ''} ago"
    d = int(s // 86400)
    if d < 60:
        return f"{d} days ago"
    return t.astimezone().strftime("%d %b %Y")


def preview_pixmap(m: Material, size: int, dpr: float) -> QPixmap | None:
    p = m.preview_path("sphere")
    if p is None:
        return None
    try:
        mt = p.stat().st_mtime_ns
    except OSError:
        return None
    key = f"{p}|{mt}|{size}|{dpr}"
    pm = QPixmapCache.find(key)
    if pm is None or pm.isNull():
        src = QPixmap(str(p))
        if src.isNull():
            return None
        px = int(size * dpr)
        pm = src.scaled(px, px, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
        pm.setDevicePixelRatio(dpr)
        QPixmapCache.insert(key, pm)
    return pm


class MaterialModel(QAbstractListModel):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.items: list[Material] = []
        self.checked: set[str] = set()

    def rowCount(self, parent=QModelIndex()):
        return 0 if parent.isValid() else len(self.items)

    def data(self, index, role=Qt.ItemDataRole.DisplayRole):
        if not index.isValid():
            return None
        m = self.items[index.row()]
        if role == Qt.ItemDataRole.DisplayRole:
            return m.name
        if role == Qt.ItemDataRole.UserRole:
            return m
        if role == Qt.ItemDataRole.ToolTipRole:
            return f"{m.name}\n{m.category} · {m.width} × {m.height}" + (f"\n{', '.join(m.tags)}" if m.tags else "")
        return None

    def set_items(self, items: list[Material]) -> None:
        self.beginResetModel()
        self.items = items
        self.endResetModel()

    def row_of(self, mid: str) -> int:
        return next((i for i, m in enumerate(self.items) if m.id == mid), -1)


class CardDelegate(QStyledItemDelegate):
    """Paints one material card; handles clicks on the select box and the star."""
    toggledCheck = Signal(str)
    toggledFavourite = Signal(str)

    def __init__(self, model: MaterialModel, parent=None):
        super().__init__(parent)
        self.model = model
        self.card = QSize(226, 238)
        self.row_width = 600
        self.list_mode = False

    def set_card_width(self, w: int) -> None:
        self.card = QSize(w, int(w * 0.66) + 76)

    def sizeHint(self, option, index):
        if self.list_mode:
            return QSize(self.row_width, 64)
        return self.card

    # hit areas -----------------------------------------------------------------
    def _card_rect(self, option) -> QRect:
        if self.list_mode:
            return QRect(option.rect.left(), option.rect.top(), option.rect.width(), 58)
        return QRect(option.rect.topLeft(), self.card)

    def _action_rects(self, r: QRect) -> tuple[QRect, QRect]:
        if self.list_mode:
            cy = r.center().y()
            return QRect(r.right() - 64, cy - 11, 26, 22), QRect(r.right() - 34, cy - 11, 26, 22)
        thumb_h = int(r.width() * 0.66)
        x = r.right() - 32
        y0 = r.top() + thumb_h + 8
        return QRect(x, y0, 26, 22), QRect(x, y0 + 26, 26, 22)

    def editorEvent(self, event, model, option, index):
        if event.type() == QEvent.Type.MouseButtonRelease and event.button() == Qt.MouseButton.LeftButton:
            m: Material = index.data(Qt.ItemDataRole.UserRole)
            chk, star = self._action_rects(self._card_rect(option))
            pos = event.position().toPoint()
            if chk.adjusted(-4, -4, 4, 4).contains(pos):
                self.toggledCheck.emit(m.id)
                return True
            if star.adjusted(-4, -4, 4, 4).contains(pos):
                self.toggledFavourite.emit(m.id)
                return True
        if event.type() == QEvent.Type.MouseButtonPress and event.button() == Qt.MouseButton.LeftButton:
            chk, star = self._action_rects(self._card_rect(option))
            pos = event.position().toPoint()
            if chk.adjusted(-4, -4, 4, 4).contains(pos) or star.adjusted(-4, -4, 4, 4).contains(pos):
                return True   # do not change the current material when only toggling
        return super().editorEvent(event, model, option, index)

    # painting ------------------------------------------------------------------
    def paint(self, p: QPainter, option: QStyleOptionViewItem, index):
        m: Material = index.data(Qt.ItemDataRole.UserRole)
        r = self._card_rect(option)
        selected = bool(option.state & QStyle.StateFlag.State_Selected)
        hover = bool(option.state & QStyle.StateFlag.State_MouseOver)
        checked = m.id in self.model.checked
        p.save()
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        bg = QColor("#1b1b1d" if selected else ("#1a1a1c" if hover else theme.CARD))
        border = QColor("#4a4a4f" if (selected or checked) else theme.LINE)
        rf = QRectF(r).adjusted(0.5, 0.5, -0.5, -0.5)
        p.setPen(QPen(border, 1))
        p.setBrush(bg)
        p.drawRoundedRect(rf, 10, 10)
        dpr = p.device().devicePixelRatioF() if p.device() else 1.0
        if self.list_mode:
            self._paint_row(p, r, m, dpr, checked)
        else:
            self._paint_card(p, r, m, dpr, checked)
        p.restore()

    def _paint_actions(self, p: QPainter, r: QRect, m: Material, checked: bool) -> None:
        chk, star = self._action_rects(r)
        box = QRectF(chk.center().x() - 7, chk.center().y() - 7, 14, 14)
        if checked:
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(QColor(theme.ACCENT))
            p.drawRoundedRect(box, 4, 4)
            p.drawPixmap(QRectF(box.left() + 1.5, box.top() + 1.5, 11, 11).toRect(), icons.pixmap("check", "#111113", 11,
                                                                                                    stroke=2.2))
        else:
            p.setPen(QPen(QColor("#4a4a50"), 1.5))
            p.setBrush(Qt.BrushStyle.NoBrush)
            p.drawRoundedRect(box, 4, 4)
        name = "star-fill" if m.favourite else "star"
        col = theme.STAR if m.favourite else theme.FAINT
        p.drawPixmap(QRect(star.center().x() - 7, star.center().y() - 7, 14, 14), icons.pixmap(name, col, 14))

    def _paint_card(self, p: QPainter, r: QRect, m: Material, dpr: float, checked: bool) -> None:
        thumb_h = int(r.width() * 0.66)
        thumb = QRectF(r.left() + 1, r.top() + 1, r.width() - 2, thumb_h)
        path = QPainterPath()
        path.addRoundedRect(QRectF(r).adjusted(1, 1, -1, -1), 9, 9)
        p.save()
        p.setClipPath(path)
        p.fillRect(thumb, QColor("#18181b"))
        p.setPen(QPen(QColor(theme.LINE), 1))
        p.drawLine(QPointF(thumb.left(), thumb.bottom()), QPointF(thumb.right(), thumb.bottom()))
        p.restore()
        side = int(min(thumb_h - 30, r.width() * 0.55))
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(0, 0, 0, 120))
        cx = thumb.center().x()
        p.drawEllipse(QPointF(cx, thumb.top() + (thumb_h + side) / 2 + 2), side * 0.28, 5)
        pm = preview_pixmap(m, side, dpr)
        if pm is not None:
            p.drawPixmap(QRect(int(cx - side / 2), int(thumb.top() + (thumb_h - side) / 2), side, side), pm)
        # resolution badge
        f = QFont(p.font())
        f.setPixelSize(10)
        f.setWeight(QFont.Weight.DemiBold)
        p.setFont(f)
        fm = QFontMetrics(f)
        txt = m.size_label
        bw = fm.horizontalAdvance(txt) + 10
        badge = QRectF(r.left() + 8, r.top() + 8, bw, 16)
        p.setPen(QPen(QColor(theme.LINE_2), 1))
        p.setBrush(QColor("#141416"))
        p.drawRoundedRect(badge, 5, 5)
        p.setPen(QColor(theme.MUTED))
        p.drawText(badge, Qt.AlignmentFlag.AlignCenter, txt)
        if m.seam_score is not None and m.seam_score > 1.5:
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(QColor(theme.STAR))
            p.drawEllipse(QPointF(r.right() - 14, r.top() + 16), 3.5, 3.5)
        # text
        f2 = QFont(p.font())
        f2.setPixelSize(13)
        f2.setWeight(QFont.Weight.Medium)
        p.setFont(f2)
        p.setPen(QColor(theme.TEXT))
        tr = QRect(r.left() + 12, r.top() + thumb_h + 10, r.width() - 52, 18)
        p.drawText(tr, Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                   QFontMetrics(f2).elidedText(m.name, Qt.TextElideMode.ElideRight, tr.width()))
        f3 = QFont(p.font())
        f3.setPixelSize(12)
        f3.setWeight(QFont.Weight.Normal)
        p.setFont(f3)
        p.setPen(QColor(theme.MUTED))
        sub = m.category + (f"  ·  {', '.join(m.tags[:2])}" if m.tags else "")
        sr = QRect(r.left() + 12, r.top() + thumb_h + 30, r.width() - 52, 16)
        p.drawText(sr, Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                   QFontMetrics(f3).elidedText(sub, Qt.TextElideMode.ElideRight, sr.width()))
        self._paint_actions(p, r, m, checked)

    def _paint_row(self, p: QPainter, r: QRect, m: Material, dpr: float, checked: bool) -> None:
        pm = preview_pixmap(m, 40, dpr)
        if pm is not None:
            p.drawPixmap(QRect(r.left() + 10, r.top() + 9, 40, 40), pm)
        f2 = QFont(p.font())
        f2.setPixelSize(13)
        f2.setWeight(QFont.Weight.Medium)
        p.setFont(f2)
        p.setPen(QColor(theme.TEXT))
        p.drawText(QRect(r.left() + 62, r.top() + 10, 300, 18), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                   m.name)
        f3 = QFont(p.font())
        f3.setPixelSize(12)
        f3.setWeight(QFont.Weight.Normal)
        p.setFont(f3)
        p.setPen(QColor(theme.MUTED))
        p.drawText(QRect(r.left() + 62, r.top() + 30, 300, 16), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                   m.category)
        cols = [(", ".join(m.tags), 260), (f"{m.width} × {m.height}", 110), (ago(m.created), 120)]
        x = r.left() + 380
        for text, w in cols:
            if x + w > r.right() - 80:
                break
            p.drawText(QRect(x, r.top(), w, r.height()), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                       QFontMetrics(f3).elidedText(text, Qt.TextElideMode.ElideRight, w - 10))
            x += w
        self._paint_actions(p, r, m, checked)


class MaterialGrid(QListView):
    def __init__(self, model: MaterialModel, delegate: CardDelegate, parent=None):
        super().__init__(parent)
        self.setModel(model)
        self.setItemDelegate(delegate)
        self.delegate = delegate
        self.setMouseTracking(True)
        self.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.setVerticalScrollMode(QAbstractItemView.ScrollMode.ScrollPerPixel)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setUniformItemSizes(True)
        self.setResizeMode(QListView.ResizeMode.Adjust)
        self.setMovement(QListView.Movement.Static)
        self.setFrameShape(QListView.Shape.NoFrame)
        self.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.set_list_mode(False)

    def set_list_mode(self, on: bool) -> None:
        self.delegate.list_mode = on
        if on:
            self.setViewMode(QListView.ViewMode.ListMode)
            self.setGridSize(QSize())
            self.setSpacing(3)
        else:
            self.setViewMode(QListView.ViewMode.IconMode)
            self.setWrapping(True)
            self.setFlow(QListView.Flow.LeftToRight)
            self.setSpacing(0)
        self._relayout()

    def _relayout(self):
        if self.delegate.list_mode:
            self.delegate.row_width = max(300, self.viewport().width() - 8)
            self.doItemsLayout()
            return
        avail = self.viewport().width() - 2
        cols, w = grid_layout(avail + GAP, min_card=210, gap=GAP)
        w = (avail - GAP * (cols - 1)) // cols
        self.delegate.set_card_width(max(150, w))
        self.setGridSize(QSize(self.delegate.card.width() + GAP, self.delegate.card.height() + GAP))
        self.doItemsLayout()

    def resizeEvent(self, e):
        super().resizeEvent(e)
        self._relayout()


class LibraryPage(QWidget):
    currentChanged = Signal(object)        # Material | None
    openEditor = Signal(str, str)          # (mode, material id) e.g. ("adjust", id)
    requestExport = Signal(list)
    requestNew = Signal(str)               # new_photo | import
    bulkAction = Signal(str, list)         # (move | tag | favourite | export | trash | clear | details | ..., ids)

    def __init__(self, hub: Hub, parent=None):
        super().__init__(parent)
        self.hub = hub
        self.setObjectName("Page")
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.f = LibraryFilter(page_size=int(hub.settings.get("page_size") or 24), sort=hub.settings.get("sort") or "recent")
        self.current_id: str | None = None
        self._all: list[Material] = []

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        # header ---------------------------------------------------------------
        self.header = QWidget()
        self.header.setObjectName("Header")
        self.header.setProperty("dragArea", True)
        self.header.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.header.setFixedHeight(52)
        hl = QHBoxLayout(self.header)
        hl.setContentsMargins(20, 0, 8, 0)
        hl.setSpacing(10)
        crumb_icon = label()
        crumb_icon.setPixmap(icons.pixmap("grid", theme.TEXT_2))
        hl.addWidget(crumb_icon)
        hl.addWidget(label("Library", "crumb"))
        hl.addWidget(label("/", "faint"))
        self.crumb_now = label("All materials", "crumbNow")
        hl.addWidget(self.crumb_now)
        hl.addStretch(1)
        self.search = SearchField("Search names, tags, descriptions")
        self.search.setFixedWidth(300)
        self.search.textChanged.connect(self._on_search)
        hl.addWidget(self.search)
        self.b_refresh = button("", "refresh", "ghost", "Rescan the library folder (F5)", self._rescan)
        self.b_refresh.setFixedSize(32, 32)
        hl.addWidget(self.b_refresh)
        self.caption_space = QWidget()
        self.caption_space.setFixedWidth(0)
        hl.addWidget(self.caption_space)
        root.addWidget(self.header)

        body = QWidget()
        bl = QVBoxLayout(body)
        bl.setContentsMargins(20, 20, 20, 0)
        bl.setSpacing(0)

        # title row -------------------------------------------------------------
        row = QHBoxLayout()
        row.setSpacing(6)
        tcol = QVBoxLayout()
        tcol.setSpacing(4)
        self.title = label("0 materials", "title")
        self.subtitle = label("", "muted")
        tcol.addWidget(self.title)
        tcol.addWidget(self.subtitle)
        row.addLayout(tcol)
        row.addStretch(1)
        # bulk actions (visible when something is selected)
        self.bulk = QWidget()
        bk = QHBoxLayout(self.bulk)
        bk.setContentsMargins(0, 0, 0, 0)
        bk.setSpacing(6)
        self.bulk_count = label("", "muted")
        bk.addWidget(self.bulk_count)
        self.bulk_buttons: dict[str, QPushButton] = {}
        for key, text, ic in (("move", "Move", "folder"), ("tag", "Tag", "tag"), ("favourite", "Favourite", "star"),
                              ("export", "Export", "export"), ("trash", "Trash", "trash"), ("clear", "Clear", "close")):
            b = button(text, ic, "ghost" if key == "clear" else None)
            b.clicked.connect(lambda _=False, k=key: self.bulkAction.emit(k, sorted(self.model.checked)))
            self.bulk_buttons[key] = b
            bk.addWidget(b)
        self.bulk.hide()
        row.addWidget(self.bulk)
        self.b_sort = button("Recently added", "sort", "ghost")
        self.b_sort.clicked.connect(self._sort_menu)
        row.addWidget(self.b_sort)
        self.view_toggle = Segmented([("grid", "grid"), ("list", "list")], "grid", icon_only=True)
        self.view_toggle.changed.connect(lambda k: self.grid.set_list_mode(k == "list"))
        row.addWidget(self.view_toggle)
        bl.addLayout(row)
        bl.addSpacing(18)

        # filter pills ------------------------------------------------------------
        self.pills_row = QHBoxLayout()
        self.pills_row.setSpacing(6)
        bl.addLayout(self.pills_row)
        bl.addSpacing(14)

        # grid / empty -----------------------------------------------------------
        self.stack_host = QWidget()
        self.stack = QStackedLayout(self.stack_host)
        self.model = MaterialModel(self)
        self.delegate = CardDelegate(self.model, self)
        self.grid = MaterialGrid(self.model, self.delegate)
        self.grid.selectionModel().currentChanged.connect(self._current_changed)
        self.grid.doubleClicked.connect(self._double_clicked)
        self.grid.customContextMenuRequested.connect(self._context_menu)
        self.delegate.toggledCheck.connect(self._toggle_check)
        self.delegate.toggledFavourite.connect(self._toggle_fav)
        self.stack.addWidget(self.grid)
        self.empty = self._make_empty()
        self.stack.addWidget(self.empty)
        bl.addWidget(self.stack_host, 1)

        self.pager = Pager()
        self.pager.pageChanged.connect(self._go_page)
        self.pager.pageSizeChanged.connect(self._page_size)
        bl.addSpacing(12)
        bl.addWidget(self.pager)
        bl.addSpacing(14)
        root.addWidget(body, 1)

        hub.changed.connect(self.reload)
        self._update_sort_label()

    # ------------------------------------------------------------------ empty state
    def _make_empty(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        lay.addStretch(1)
        self.empty_title = label("No materials yet", "h2")
        self.empty_title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.empty_text = label("Drop a photo onto this window, or start here.", "muted")
        self.empty_text.setAlignment(Qt.AlignmentFlag.AlignCenter)
        lay.addWidget(self.empty_title)
        lay.addWidget(self.empty_text)
        lay.addSpacing(12)
        self.empty_buttons = QWidget()
        eb = QHBoxLayout(self.empty_buttons)
        eb.setContentsMargins(0, 0, 0, 0)
        eb.addStretch(1)
        eb.addWidget(button("New from photo", "photo", "primary", on_click=lambda: self.requestNew.emit("new_photo")))
        eb.addWidget(button("Import map set", "import", on_click=lambda: self.requestNew.emit("import")))
        eb.addStretch(1)
        lay.addWidget(self.empty_buttons)
        self.b_clear_filters = button("Clear search and filters", None, "ghost", on_click=self.clear_filters)
        lay.addWidget(self.b_clear_filters, 0, Qt.AlignmentFlag.AlignHCenter)
        lay.addStretch(2)
        return w

    # ------------------------------------------------------------------ filters
    def set_caption_space(self, on: bool) -> None:
        self.caption_space.setFixedWidth(138 if on else 0)

    def set_view(self, view: str) -> None:
        self.f.view = view
        self.f.category = None
        self.f.page = 0
        self.reload()

    def set_category(self, cat: str | None) -> None:
        self.f.category = cat
        self.f.view = "library"
        self.f.page = 0
        self.reload()

    def clear_filters(self) -> None:
        self.f.search, self.f.category, self.f.tags, self.f.page = "", None, [], 0
        self.f.view = "library"
        self.search.edit.clear()
        self.reload()

    def focus_search(self) -> None:
        self.search.focus()

    def _on_search(self, text: str) -> None:
        self.f.search = text
        self.f.page = 0
        self.reload()

    def _sort_menu(self) -> None:
        m = QMenu(self)
        for key, text in SORTS:
            a = m.addAction(text)
            a.setCheckable(True)
            a.setChecked(key == self.f.sort)
            a.triggered.connect(lambda _=False, k=key: self._set_sort(k))
        m.exec(self.b_sort.mapToGlobal(self.b_sort.rect().bottomLeft()))

    def _set_sort(self, key: str) -> None:
        self.f.sort = key
        self.hub.settings.set("sort", key)
        self._update_sort_label()
        self.reload()

    def _update_sort_label(self) -> None:
        self.b_sort.setText(dict(SORTS).get(self.f.sort, "Recently added"))

    def _go_page(self, page: int) -> None:
        self.f.page = page
        self.reload(keep_scroll=False)

    def _page_size(self, size: int) -> None:
        first = self.f.page * self.f.page_size
        self.f.page_size = size
        self.f.page = first // size
        self.hub.settings.set("page_size", size)
        self.reload()

    def _rebuild_pills(self) -> None:
        while self.pills_row.count():
            it = self.pills_row.takeAt(0)
            if it.widget():
                it.widget().deleteLater()
        lib = self.hub.library
        if not lib:
            return
        total = lib.count()

        def pill(text: str, n: int | None, on: bool, cb: Callable) -> QPushButton:
            b = button(f"{text}  {n}" if n is not None else text, None, "pill", checkable=True)
            b.setChecked(on)
            b.clicked.connect(cb)
            return b

        self.pills_row.addWidget(pill("All", total, self.f.category is None and self.f.view == "library",
                                      lambda: self.set_category(None)))
        cats = [(c, n) for c, n in lib.categories() if n > 0]
        shown, rest = cats[:8], cats[8:]
        for c, n in shown:
            self.pills_row.addWidget(pill(c, n, self.f.category == c, lambda _=False, cc=c: self.set_category(cc)))
        if rest:
            more = button("More", "caret", "pill")
            menu = QMenu(more)
            for c, n in rest:
                menu.addAction(f"{c}  ({n})", lambda cc=c: self.set_category(cc))
            more.setMenu(menu)
            self.pills_row.addWidget(more)
        self.pills_row.addStretch(1)
        fav = button("Favourites", "star", "pill", checkable=True)
        fav.setChecked(self.f.view == "favourites")
        fav.clicked.connect(lambda: self.set_view("library" if self.f.view == "favourites" else "favourites"))
        self.pills_row.addWidget(fav)

    # ------------------------------------------------------------------ data
    def reload(self, keep_scroll: bool = True) -> None:
        lib = self.hub.library
        scroll = self.grid.verticalScrollBar().value() if keep_scroll else 0
        if not lib:
            self.model.set_items([])
            self.stack.setCurrentWidget(self.empty)
            return
        self._all = lib.query(**self.f.query_args())
        known = {m.id for m in lib.all()}
        self.model.checked &= known
        page_items = self.f.slice(self._all)
        self.model.set_items(page_items)
        self.pager.set_state(self.f.page, self.f.page_size, len(self._all))
        n = len(self._all)
        filtered = bool(self.f.search or self.f.category or self.f.view != "library" or self.f.tags)
        self.title.setText(f"{n} material{'s' if n != 1 else ''}" + ("" if not filtered else
                           f" of {lib.count()}"))
        newest = max((m.modified for m in lib.all()), default="")
        self.subtitle.setText(" · ".join(x for x in (human_bytes(self._usage()), ("last change " + ago(newest)) if newest else "") if x))
        self.crumb_now.setText(self.f.title() if not self.f.search else f"Search: {self.f.search}")
        self._rebuild_pills()
        if page_items:
            self.stack.setCurrentWidget(self.grid)
        else:
            self.stack.setCurrentWidget(self.empty)
            self.empty_title.setText("Nothing matches" if filtered and lib.count() else "No materials yet")
            self.empty_text.setText("Try other words or clear the filters." if filtered and lib.count()
                                    else "Drop a photo onto this window, or start here.")
            self.empty_buttons.setVisible(not (filtered and lib.count()))
            self.b_clear_filters.setVisible(bool(filtered and lib.count()))
        self._update_bulk()
        if self.current_id:
            row = self.model.row_of(self.current_id)
            if row >= 0:
                self.grid.setCurrentIndex(self.model.index(row))
            elif self.current_id not in known:
                self.current_id = None
                self.currentChanged.emit(None)
        self.grid.verticalScrollBar().setValue(scroll)

    _usage_cache: tuple[int, int] = (-1, 0)

    def _usage(self) -> int:
        lib = self.hub.library
        key = hash(tuple(sorted((m.id, m.modified) for m in lib.all()))) if lib else 0
        if self._usage_cache[0] != key:
            self._usage_cache = (key, lib.disk_usage() if lib else 0)
        return self._usage_cache[1]

    def select(self, mid: str) -> None:
        """Shows the page containing mid and makes it current."""
        if mid not in [m.id for m in self._all]:
            self.clear_filters()
        ids = [m.id for m in self._all]
        if mid in ids:
            self.f.page = ids.index(mid) // self.f.page_size
            self.current_id = mid
            self.reload(keep_scroll=False)
            row = self.model.row_of(mid)
            if row >= 0:
                idx = self.model.index(row)
                self.grid.setCurrentIndex(idx)
                self.grid.scrollTo(idx)

    def _current_changed(self, cur: QModelIndex, _prev: QModelIndex) -> None:
        m = cur.data(Qt.ItemDataRole.UserRole) if cur.isValid() else None
        new_id = m.id if m else None
        if new_id != self.current_id or m is not None:
            self.current_id = new_id
            self.currentChanged.emit(m)

    def _double_clicked(self, idx: QModelIndex) -> None:
        m = idx.data(Qt.ItemDataRole.UserRole)
        if m:
            self.openEditor.emit("adjust", m.id)

    def _toggle_check(self, mid: str) -> None:
        if mid in self.model.checked:
            self.model.checked.discard(mid)
        else:
            self.model.checked.add(mid)
        self.grid.viewport().update()
        self._update_bulk()

    def _toggle_fav(self, mid: str) -> None:
        lib = self.hub.library
        if not lib:
            return
        m = lib.get(mid)
        lib.update(mid, favourite=not m.favourite)
        self.hub.changed.emit()

    def select_all_on_page(self) -> None:
        for m in self.model.items:
            self.model.checked.add(m.id)
        self.grid.viewport().update()
        self._update_bulk()

    def clear_checked(self) -> None:
        self.model.checked.clear()
        self.grid.viewport().update()
        self._update_bulk()

    def _update_bulk(self) -> None:
        n = len(self.model.checked)
        self.bulk.setVisible(n > 0)
        self.b_sort.setVisible(n == 0)
        self.view_toggle.setVisible(n == 0)
        self.bulk_count.setText(f"{n} selected")

    def checked_or_current(self) -> list[str]:
        if self.model.checked:
            return sorted(self.model.checked)
        return [self.current_id] if self.current_id else []

    def _context_menu(self, pos) -> None:
        idx = self.grid.indexAt(pos)
        if not idx.isValid():
            return
        m: Material = idx.data(Qt.ItemDataRole.UserRole)
        self.grid.setCurrentIndex(idx)
        menu = QMenu(self)
        menu.addAction(icons.icon("sliders"), "Adjust maps…", lambda: self.openEditor.emit("adjust", m.id))
        if m.source_path is not None:
            menu.addAction(icons.icon("regen"), "Regenerate from photo…", lambda: self.openEditor.emit("regenerate", m.id))
        menu.addAction(icons.icon("edit"), "Edit details…", lambda: self.bulkAction.emit("details", [m.id]))
        menu.addAction(icons.icon("copy"), "Duplicate", lambda: self.bulkAction.emit("duplicate", [m.id]))
        menu.addAction(icons.icon("export"), "Export…", lambda: self.requestExport.emit([m.id]))
        menu.addAction(icons.icon("star"), "Remove from favourites" if m.favourite else "Add to favourites",
                       lambda: self._toggle_fav(m.id))
        menu.addAction(icons.icon("reveal"), "Show in Explorer", lambda: self.bulkAction.emit("reveal", [m.id]))
        menu.addSeparator()
        menu.addAction(icons.icon("trash"), "Move to trash", lambda: self.bulkAction.emit("trash", [m.id]))
        menu.exec(self.grid.viewport().mapToGlobal(pos))
