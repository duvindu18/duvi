"""The library page: header, title row, filter pills, card grid / list, pager, bulk actions."""
from __future__ import annotations

import datetime as dt
from typing import Callable

from PySide6.QtCore import (QAbstractListModel, QEvent, QModelIndex, QObject, QPointF, QRect, QRectF, QRunnable, QSize, Qt,
                            QThreadPool, Signal)
from PySide6.QtGui import QColor, QFont, QFontMetrics, QImage, QImageReader, QPainter, QPainterPath, QPen, QPixmap, QPixmapCache
from PySide6.QtWidgets import (QAbstractItemView, QHBoxLayout, QListView, QMenu, QPushButton, QStackedLayout,
                               QStyle, QStyledItemDelegate, QStyleOptionViewItem, QVBoxLayout, QWidget)

from ..library.store import Material
from ..viewmodel import LibraryFilter, grid_layout
from . import icons, theme
from .hub import Hub
from .widgets import (Pager, SearchField, Segmented, ShimmerClock, SizeSlider, button, clear_layout, human_bytes,
                      label, shimmer_brush)

SORTS = [("recent", "Recently added"), ("modified", "Recently changed"), ("name", "Name"),
         ("category", "Category"), ("size", "Resolution")]
GAP = 12          # space between cards (half of it on each side of a card)
ROW_H = 64        # list rows
CARD_MIN, CARD_MAX = 150, 380


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


class _ThumbJob(QRunnable):
    def __init__(self, loader, key: str, path: str, px: int):
        super().__init__()
        self.loader, self.key, self.path, self.px = loader, key, path, px

    def run(self):
        r = QImageReader(self.path)
        sz = r.size()
        if sz.isValid() and max(sz.width(), sz.height()) > self.px:
            k = self.px / max(sz.width(), sz.height())
            r.setScaledSize(QSize(max(1, round(sz.width() * k)), max(1, round(sz.height() * k))))
        img = r.read()                       # QImage is safe to make off the UI thread; QPixmap is not
        self.loader.loaded.emit(self.key, img)


class ThumbLoader(QObject):
    """Card thumbnails decoded in background threads; cards show a shimmering skeleton until theirs arrives."""
    loaded = Signal(str, QImage)
    ready = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.pool = QThreadPool(self)
        self.pool.setMaxThreadCount(4)
        self.pending: set[str] = set()
        self.failed: set[str] = set()
        self.loaded.connect(self._done)

    def get(self, m: Material, size: int, dpr: float) -> QPixmap | None | bool:
        """QPixmap when ready, None while loading, False when the material has no preview at all."""
        p = m.preview_path("sphere")
        if p is None:
            return False
        try:
            mt = p.stat().st_mtime_ns
        except OSError:
            return False
        px = max(16, int(size * dpr))
        key = f"{p}|{mt}|{px}"
        pm = QPixmapCache.find(key)
        if pm is not None and not pm.isNull():
            pm.setDevicePixelRatio(dpr)
            return pm
        if key in self.failed:
            return False
        if key not in self.pending:
            self.pending.add(key)
            self.pool.start(_ThumbJob(self, key, str(p), px))
        return None

    def _done(self, key: str, img: QImage) -> None:
        self.pending.discard(key)
        if img.isNull():
            self.failed.add(key)
        else:
            QPixmapCache.insert(key, QPixmap.fromImage(img))
        self.ready.emit()


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

    def __init__(self, model: MaterialModel, loader: "ThumbLoader", parent=None):
        super().__init__(parent)
        self.model = model
        self.loader = loader
        self.cell = QSize(226 + GAP, 238 + GAP)     # grid cell; the card sits centred in it
        self.row_width = 600
        self.list_mode = False
        self.loading_visible = False                # set while painting: any skeleton on screen?

    @property
    def card(self) -> QSize:
        return QSize(self.cell.width() - GAP, self.cell.height() - GAP)

    def set_cell(self, cell_w: int) -> None:
        w = cell_w - GAP
        self.cell = QSize(cell_w, int(w * 0.66) + 72 + GAP)

    def sizeHint(self, option, index):
        if self.list_mode:
            return QSize(self.row_width, ROW_H)
        return self.cell

    # hit areas -----------------------------------------------------------------
    def _card_rect(self, option) -> QRect:
        half = GAP // 2
        if self.list_mode:
            return QRect(option.rect.left() + half, option.rect.top() + 3, option.rect.width() - GAP, ROW_H - 6)
        return QRect(option.rect.left() + half, option.rect.top() + half, self.card.width(), self.card.height())

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
        pm = self.loader.get(m, side, dpr)
        target = QRect(int(cx - side / 2), int(thumb.top() + (thumb_h - side) / 2), side, side)
        if pm:
            p.drawPixmap(target, pm)
        elif pm is None:                              # still loading: skeleton sphere
            self.loading_visible = True
            sk = QPainterPath()
            sk.addEllipse(QRectF(target).adjusted(side * 0.06, side * 0.06, -side * 0.06, -side * 0.06))
            p.fillPath(sk, shimmer_brush(QRectF(target), ShimmerClock.get().phase()))
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
        pm = self.loader.get(m, 40, dpr)
        target = QRect(r.left() + 10, r.center().y() - 20, 40, 40)
        if pm:
            p.drawPixmap(target, pm)
        elif pm is None:
            self.loading_visible = True
            sk = QPainterPath()
            sk.addEllipse(QRectF(target).adjusted(3, 3, -3, -3))
            p.fillPath(sk, shimmer_brush(QRectF(target), ShimmerClock.get().phase()))
        f2 = QFont(p.font())
        f2.setPixelSize(13)
        f2.setWeight(QFont.Weight.Medium)
        p.setFont(f2)
        p.setPen(QColor(theme.TEXT))
        p.drawText(QRect(r.left() + 62, r.center().y() - 18, 300, 18), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                   m.name)
        f3 = QFont(p.font())
        f3.setPixelSize(12)
        f3.setWeight(QFont.Weight.Normal)
        p.setFont(f3)
        p.setPen(QColor(theme.MUTED))
        p.drawText(QRect(r.left() + 62, r.center().y() + 2, 300, 16), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
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
        self.card_size = 210                      # wanted card width; the real width fills the row exactly
        self.setMouseTracking(True)
        self.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.setVerticalScrollMode(QAbstractItemView.ScrollMode.ScrollPerPixel)
        self.verticalScrollBar().setSingleStep(24)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setUniformItemSizes(True)
        self.setResizeMode(QListView.ResizeMode.Adjust)
        self.setMovement(QListView.Movement.Static)
        self.setFrameShape(QListView.Shape.NoFrame)
        self.setSpacing(0)
        self.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        delegate.loader.ready.connect(self.viewport().update)
        self.set_list_mode(False)

    def set_list_mode(self, on: bool) -> None:
        self.delegate.list_mode = on
        if on:
            self.setViewMode(QListView.ViewMode.ListMode)
            self.setGridSize(QSize())
        else:
            self.setViewMode(QListView.ViewMode.IconMode)
            self.setWrapping(True)
            self.setFlow(QListView.Flow.LeftToRight)
        self.setSpacing(0)
        self._relayout()

    def set_card_size(self, px: int) -> None:
        self.card_size = int(px)
        self._relayout()

    def _relayout(self):
        avail = max(200, self.viewport().width())
        if self.delegate.list_mode:
            self.delegate.row_width = avail
            self.doItemsLayout()
            return
        cols, _ = grid_layout(avail, min_card=self.card_size + GAP, gap=0)
        self.delegate.set_cell(avail // cols)       # equal cells across the whole width
        self.setGridSize(self.delegate.cell)
        self.doItemsLayout()

    def resizeEvent(self, e):
        super().resizeEvent(e)
        self._relayout()

    def paintEvent(self, e):
        self.delegate.loading_visible = False
        super().paintEvent(e)
        clock = ShimmerClock.get()
        if self.delegate.loading_visible:
            clock.add(self.viewport())
        else:
            clock.discard(self.viewport())

    def wheelEvent(self, e):
        if e.modifiers() & Qt.KeyboardModifier.ControlModifier and not self.delegate.list_mode:
            step = 20 if e.angleDelta().y() > 0 else -20       # Ctrl + wheel: card size
            self.sizeRequested.emit(max(CARD_MIN, min(CARD_MAX, self.card_size + step)))
            e.accept()
            return
        super().wheelEvent(e)

    sizeRequested = Signal(int)


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
        # The grid draws half a gap around each card, so it gets GAP/2 less margin than the rows above it:
        # card edges then line up exactly with the title, the pills and the pager.
        side = 20
        bl.setContentsMargins(side - GAP // 2, 20, side - GAP // 2, 0)
        bl.setSpacing(0)

        def padded(layout) -> QWidget:
            w = QWidget()
            layout.setContentsMargins(GAP // 2, 0, GAP // 2, 0)
            w.setLayout(layout)
            return w

        # title row -------------------------------------------------------------
        row = QHBoxLayout()
        row.setSpacing(8)
        tcol = QVBoxLayout()
        tcol.setSpacing(2)
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
        bk.addSpacing(4)
        self.bulk_buttons: dict[str, QPushButton] = {}
        for key, text, ic in (("move", "Move", "folder"), ("tag", "Tag", "tag"), ("favourite", "Favourite", "star"),
                              ("export", "Export", "export"), ("trash", "Trash", "trash"), ("clear", "Clear", "close")):
            b = button(text, ic, "ghost" if key == "clear" else None)
            b.setFixedHeight(32)
            b.clicked.connect(lambda _=False, k=key: self.bulkAction.emit(k, sorted(self.model.checked)))
            self.bulk_buttons[key] = b
            bk.addWidget(b)
        self.bulk.hide()
        row.addWidget(self.bulk, 0, Qt.AlignmentFlag.AlignVCenter)
        self.tools = QWidget()
        tl = QHBoxLayout(self.tools)
        tl.setContentsMargins(0, 0, 0, 0)
        tl.setSpacing(8)
        self.b_sort = button("Recently added", "sort")
        self.b_sort.setFixedHeight(32)
        self.b_sort.clicked.connect(self._sort_menu)
        tl.addWidget(self.b_sort)
        self.size_slider = SizeSlider(CARD_MIN, CARD_MAX, int(hub.settings.get("card_size") or 210))
        self.size_slider.valueChanged.connect(self._card_size)
        tl.addWidget(self.size_slider)
        self.view_toggle = Segmented([("grid", "grid"), ("list", "list")], "grid", icon_only=True, height=32)
        self.view_toggle.changed.connect(self._view_mode)
        tl.addWidget(self.view_toggle)
        row.addWidget(self.tools, 0, Qt.AlignmentFlag.AlignVCenter)
        bl.addWidget(padded(row))
        bl.addSpacing(18)

        # filter pills ------------------------------------------------------------
        self.pills_row = QHBoxLayout()
        self.pills_row.setSpacing(6)
        bl.addWidget(padded(self.pills_row))
        bl.addSpacing(14 - GAP // 2)        # the first card row starts half a gap lower

        # grid / empty -----------------------------------------------------------
        self.stack_host = QWidget()
        self.stack = QStackedLayout(self.stack_host)
        self.model = MaterialModel(self)
        self.thumbs = ThumbLoader(self)
        self.delegate = CardDelegate(self.model, self.thumbs, self)
        self.grid = MaterialGrid(self.model, self.delegate)
        self.grid.set_card_size(self.size_slider.value())
        self.grid.sizeRequested.connect(lambda v: (self.size_slider.setValue(v), self._card_size(v)))
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
        bl.addSpacing(12 - GAP // 2)
        pw = QHBoxLayout()
        pw.addWidget(self.pager)
        bl.addWidget(padded(pw))
        bl.addSpacing(16)
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

    def _card_size(self, px: int) -> None:
        self.grid.set_card_size(px)
        self.hub.settings.set("card_size", int(px))

    def _view_mode(self, key: str) -> None:
        self.grid.set_list_mode(key == "list")
        self.size_slider.setEnabled(key != "list")
        self.size_slider.setVisible(key != "list")

    def neighbours(self, mid: str, n: int = 2) -> list[Material]:
        """Materials next to mid on the current page (for preloading)."""
        items = self.model.items
        i = next((k for k, m in enumerate(items) if m.id == mid), -1)
        if i < 0:
            return []
        out = []
        for d in range(1, n + 1):
            for j in (i + d, i - d):
                if 0 <= j < len(items):
                    out.append(items[j])
        return out[:n * 2]

    def _rescan(self) -> None:
        if self.hub.library:
            n = self.hub.rescan()
            self.hub.notify(f"Rescanned: {n} materials", "ok")

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
        clear_layout(self.pills_row)
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
        self.tools.setVisible(n == 0)
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
