"""D5 Bridge desktop app."""
from __future__ import annotations

import os
import subprocess
import sys
import traceback
from pathlib import Path

from PySide6.QtCore import QObject, QRunnable, QSize, Qt, QThreadPool, QTimer, Signal
from PySide6.QtGui import QAction, QColor, QFont, QIcon, QKeySequence, QPixmap, QShortcut
from PySide6.QtWidgets import (QApplication, QButtonGroup, QFileDialog, QFrame, QGridLayout,
                               QHBoxLayout, QLabel, QLineEdit, QMainWindow, QMenu, QPlainTextEdit,
                               QProgressBar, QPushButton, QScrollArea, QSizePolicy, QSplitter,
                               QStackedWidget, QTreeWidget, QTreeWidgetItem, QTreeWidgetItemIterator,
                               QVBoxLayout, QWidget)

from .. import __version__
from ..io import SUPPORTED, load_any
from ..pipeline import Cancelled, ExportOptions, export
from ..scene import Material, Node, Scene, TextureRef, Variant
from ..settings import load_settings, save_settings
from .theme import DARK, LIGHT, Palette, qss
from .view_common import prepare_scene


def make_viewport(pref: str):
    """'directx' (Qt RHI: Direct3D 11 on Windows) with OpenGL as the fallback."""
    if pref != "opengl":
        try:
            from .viewport_rhi import RhiViewport
            return RhiViewport()
        except Exception:  # noqa: BLE001 - old Qt or missing shaders
            pass
    from .viewport import Viewport
    return Viewport()
from .widgets import Segmented, Toast, Toggle, badge, card, divider, label, make_icon

CHANNEL_LABELS = [("base_color", "Base colour"), ("opacity", "Opacity"), ("normal", "Normal"),
                  ("roughness", "Roughness"), ("metallic", "Metallic"), ("ao", "AO"),
                  ("translucency", "Translucency"), ("bump", "Bump"), ("emissive", "Emissive")]


# =========================================================================== #
# background work
# =========================================================================== #
class _Signals(QObject):
    log = Signal(str)
    progress = Signal(str, float)
    done = Signal(object)
    failed = Signal(str)


class Job(QRunnable):
    def __init__(self, fn, *args, **kw) -> None:
        super().__init__()
        self.fn, self.args, self.kw = fn, args, kw
        self.signals = _Signals()
        self.cancelled = False

    def run(self) -> None:
        try:
            res = self.fn(*self.args, job=self, **self.kw)
            self.signals.done.emit(res)
        except Cancelled:
            self.signals.failed.emit("Cancelled")
        except Exception as e:  # noqa: BLE001
            self.signals.failed.emit(f"{e}\n\n{traceback.format_exc()}")


def _load_job(path: str, job: Job, max_options: dict, lod: int) -> Scene:
    scene = load_any(path, log=job.signals.log.emit, max_options=max_options, lod=lod)
    # build GPU-ready buffers here, off the UI thread, so the preview appears at once
    prepare_scene(scene, job.signals.log.emit)
    return scene


def _export_job(scene: Scene, variants, selected, opts: ExportOptions, job: Job):
    return export(scene, variants, selected, opts,
                  progress=lambda m, f: job.signals.progress.emit(m, f),
                  cancel=lambda: job.cancelled)


# =========================================================================== #
# helpers
# =========================================================================== #
def hbox(*widgets, spacing: int = 8, margins=(0, 0, 0, 0), stretch_at: int | None = None) -> QHBoxLayout:
    lay = QHBoxLayout()
    lay.setSpacing(spacing)
    lay.setContentsMargins(*margins)
    for i, w in enumerate(widgets):
        if i == stretch_at:
            lay.addStretch(1)
        if w is None:
            lay.addStretch(1)
        elif isinstance(w, QWidget):
            lay.addWidget(w)
        else:
            lay.addLayout(w)
    return lay


def vbox(*widgets, spacing: int = 8, margins=(0, 0, 0, 0)) -> QVBoxLayout:
    lay = QVBoxLayout()
    lay.setSpacing(spacing)
    lay.setContentsMargins(*margins)
    for w in widgets:
        if w is None:
            lay.addStretch(1)
        elif isinstance(w, QWidget):
            lay.addWidget(w)
        else:
            lay.addLayout(w)
    return lay


def fmt_bytes(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


def thumb(path: str, size: int = 44) -> QPixmap | None:
    pm = QPixmap(path)
    if pm.isNull():
        try:
            from PIL import Image
            from PIL.ImageQt import ImageQt
            im = Image.open(path)
            im.thumbnail((size * 2, size * 2))
            pm = QPixmap.fromImage(ImageQt(im.convert("RGBA")))
        except Exception:  # noqa: BLE001
            return None
    return pm.scaled(size * 2, size * 2, Qt.KeepAspectRatioByExpanding, Qt.SmoothTransformation)


class Row(QFrame):
    """Label/description on the left, control on the right."""

    def __init__(self, title: str, desc: str, control: QWidget) -> None:
        super().__init__()
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 8, 0, 8)
        text = QWidget()
        text.setLayout(vbox(label(title, "H3"), label(desc, "Muted", wrap=True), spacing=2))
        text.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Minimum)
        lay.addWidget(text, 1)
        lay.addSpacing(12)
        lay.addWidget(control, 0, Qt.AlignVCenter | Qt.AlignRight)


# =========================================================================== #
class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.settings = load_settings()
        self.palette_ = DARK if self.settings.get("theme", "dark") == "dark" else LIGHT
        self.pool = QThreadPool.globalInstance()
        self.scene: Scene | None = None
        self.node_items: dict[int, QTreeWidgetItem] = {}
        self.item_nodes: dict[int, Node] = {}
        self.current_job: Job | None = None
        self.export_opts = ExportOptions.from_json(self.settings.get("export", {}))
        if not self.export_opts.out_dir:
            self.export_opts.out_dir = str(Path.home() / "Documents" / "D5 Bridge")
        self.selected_material: Material | None = None

        self.setWindowTitle("D5 Bridge")
        self.resize(1440, 900)
        self.setAcceptDrops(True)
        root = QWidget()
        root.setObjectName("Root")
        self.setCentralWidget(root)
        lay = QHBoxLayout(root)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(0)
        lay.addWidget(self._build_sidebar())

        main = QWidget()
        mlay = QVBoxLayout(main)
        mlay.setContentsMargins(0, 0, 0, 0)
        mlay.setSpacing(0)
        mlay.addWidget(self._build_topbar())
        self.stack = QStackedWidget()
        mlay.addWidget(self.stack, 1)
        lay.addWidget(main, 1)

        self.page_home = self._build_home()
        self.page_model = self._build_model()
        self.page_export = self._build_export()
        self.page_settings = self._build_settings()
        self.page_help = self._build_help()
        for p in (self.page_home, self.page_model, self.page_export, self.page_settings, self.page_help):
            self.stack.addWidget(p)
        self.toast = Toast(root)
        self.apply_theme(self.palette_)
        self.go("home")
        QShortcut(QKeySequence("/"), self, activated=lambda: self.search.setFocus())
        QShortcut(QKeySequence("Ctrl+O"), self, activated=self.open_file_dialog)
        QShortcut(QKeySequence("Ctrl+E"), self, activated=lambda: self.go("export"))
        QTimer.singleShot(200, self.refresh_max_status)

    # ------------------------------------------------------------------ #
    # chrome
    # ------------------------------------------------------------------ #
    def _build_sidebar(self) -> QWidget:
        sb = QWidget()
        sb.setObjectName("Sidebar")
        sb.setFixedWidth(248)
        lay = QVBoxLayout(sb)
        lay.setContentsMargins(10, 14, 10, 12)
        lay.setSpacing(2)
        brand = QHBoxLayout()
        brand.setContentsMargins(10, 0, 0, 10)
        brand.setSpacing(0)
        brand.addWidget(label("D5 Bridge", "Brand"))
        brand.addWidget(label(".", "BrandDot"))
        brand.addStretch(1)
        lay.addLayout(brand)

        self.nav_group = QButtonGroup(self)
        self.nav: dict[str, QPushButton] = {}
        self.nav_badges: dict[str, QLabel] = {}
        self._icons_for_nav: dict[str, str] = {}

        def section(text: str) -> None:
            lay.addWidget(label(text, "Section"))

        def item(key: str, text: str, icon: str, with_badge: bool = False) -> None:
            b = QPushButton(f"  {text}")
            b.setObjectName("NavItem")
            b.setCheckable(True)
            b.setCursor(Qt.PointingHandCursor)
            b.clicked.connect(lambda _=False, k=key: self.go(k))
            self.nav_group.addButton(b)
            self.nav[key] = b
            self._icons_for_nav[key] = icon
            row = QHBoxLayout()
            row.setContentsMargins(0, 0, 0, 0)
            row.addWidget(b, 1)
            if with_badge:
                bd = badge("0")
                bd.hide()
                self.nav_badges[key] = bd
                # overlay the badge inside the pill
                bd.setParent(b)
            lay.addLayout(row)

        section("Workspace")
        item("home", "Open", "home")
        item("model", "Model", "tree", True)
        item("export", "Export", "export", True)
        section("Variants")
        self.variant_list = QVBoxLayout()
        self.variant_list.setSpacing(2)
        lay.addLayout(self.variant_list)
        self.variant_empty = label("Open a model to see its variants", "Faint", wrap=True)
        self.variant_empty.setContentsMargins(12, 2, 8, 2)
        self.variant_list.addWidget(self.variant_empty)
        lay.addStretch(1)
        lay.addWidget(divider())
        item("settings", "Settings", "settings")
        item("help", "Help", "help")
        st = QHBoxLayout()
        st.setContentsMargins(12, 10, 0, 0)
        self.status_dot = label("●", "StatusDot")
        self.status_text = label("Checking for 3ds Max…", "StatusText")
        st.addWidget(self.status_dot)
        st.addWidget(self.status_text, 1)
        lay.addLayout(st)
        return sb

    def _build_topbar(self) -> QWidget:
        bar = QWidget()
        bar.setFixedHeight(64)
        lay = QHBoxLayout(bar)
        lay.setContentsMargins(20, 12, 20, 8)
        self.search = QLineEdit()
        self.search.setObjectName("Search")
        self.search.setPlaceholderText("Search objects and materials")
        self.search.setFixedWidth(440)
        self.search.textChanged.connect(self.filter_tree)
        self.search_icon = QLabel(self.search)
        self.search_icon.move(12, 9)
        slash = badge("/")
        slash.setParent(self.search)
        slash.move(404, 8)
        lay.addWidget(self.search)
        lay.addStretch(1)
        self.warn_btn = QPushButton()
        self.warn_btn.setObjectName("Icon")
        self.warn_btn.setToolTip("Warnings")
        self.warn_btn.clicked.connect(self.show_warnings)
        self.warn_badge = badge("0", alert=True)
        self.warn_badge.setParent(self.warn_btn)
        self.warn_badge.move(18, -2)
        self.warn_badge.hide()
        self.theme_btn = QPushButton()
        self.theme_btn.setObjectName("Icon")
        self.theme_btn.setToolTip("Light / dark")
        self.theme_btn.clicked.connect(self.toggle_theme)
        self.open_btn = QPushButton("Open")
        self.open_btn.setObjectName("Primary")
        self.open_btn.clicked.connect(self.open_file_dialog)
        lay.addWidget(self.warn_btn)
        lay.addWidget(self.theme_btn)
        lay.addSpacing(6)
        lay.addWidget(self.open_btn)
        line = QFrame()
        line.setObjectName("Divider")
        wrap = QWidget()
        w = QVBoxLayout(wrap)
        w.setContentsMargins(0, 0, 0, 0)
        w.setSpacing(0)
        w.addWidget(bar)
        w.addWidget(line)
        return wrap

    def _scroll(self, inner: QWidget) -> QScrollArea:
        sc = QScrollArea()
        sc.setWidgetResizable(True)
        sc.setFrameShape(QFrame.NoFrame)
        sc.setWidget(inner)
        return sc

    def _page(self, title: str, subtitle: str) -> tuple[QWidget, QVBoxLayout]:
        inner = QWidget()
        lay = QVBoxLayout(inner)
        lay.setContentsMargins(28, 24, 28, 28)
        lay.setSpacing(14)
        lay.addWidget(label(title, "H1"))
        sub = label(subtitle, "Muted", wrap=True)
        sub.setMaximumWidth(720)
        lay.addWidget(sub)
        lay.addSpacing(6)
        return inner, lay

    # ------------------------------------------------------------------ #
    # Home
    # ------------------------------------------------------------------ #
    def _build_home(self) -> QWidget:
        inner, lay = self._page(
            "Bring models into D5",
            "Open a 3ds Max file (MaxTree, Evermotion, Corona or V-Ray), a Megascans or Fab download, "
            "or any FBX / OBJ. Preview it with its textures, pick the variants and objects you need, "
            "and export a lean FBX with full-resolution textures that D5 Render reads directly.")

        self.drop = card("DropZone")
        self.drop.setMinimumHeight(220)
        d = QVBoxLayout(self.drop)
        d.setContentsMargins(24, 28, 24, 28)
        d.setSpacing(10)
        self.drop_icon = QLabel()
        self.drop_icon.setAlignment(Qt.AlignCenter)
        d.addWidget(self.drop_icon)
        t = label("Drop a .max, .fbx, .obj or Megascans folder here", "H2")
        t.setAlignment(Qt.AlignCenter)
        d.addWidget(t)
        s = label("Several tree variants in one file are detected automatically.", "Muted")
        s.setAlignment(Qt.AlignCenter)
        d.addWidget(s)
        b1 = QPushButton("Open file")
        b1.setObjectName("Primary")
        b1.clicked.connect(self.open_file_dialog)
        b2 = QPushButton("Open Megascans folder")
        b2.clicked.connect(self.open_folder_dialog)
        d.addSpacing(6)
        d.addLayout(hbox(None, b1, b2, None))
        lay.addWidget(self.drop)

        grid = QGridLayout()
        grid.setSpacing(14)
        # 3ds Max card
        mc = card()
        ml = QVBoxLayout(mc)
        ml.setContentsMargins(18, 18, 18, 18)
        ml.setSpacing(10)
        tile = card("IconTile")
        tile.setFixedSize(40, 40)
        tl = QVBoxLayout(tile)
        tl.setContentsMargins(0, 0, 0, 0)
        self.max_tile_icon = QLabel()
        self.max_tile_icon.setAlignment(Qt.AlignCenter)
        tl.addWidget(self.max_tile_icon)
        self.max_title = label("3ds Max", "H3")
        self.max_desc = label("Looking for 3ds Max…", "Muted", wrap=True)
        self.max_chip = badge("…")
        self.max_chip.setMinimumWidth(64)
        ml.addLayout(hbox(tile, vbox(self.max_title, self.max_desc, spacing=2), self.max_chip, spacing=12))
        ml.addWidget(divider())
        recheck = QPushButton("Check again")
        recheck.clicked.connect(self.refresh_max_status)
        plugin = QPushButton("3ds Max toolbar button")
        plugin.clicked.connect(self.open_plugin_folder)
        ml.addLayout(hbox(recheck, plugin, None))
        ml.addWidget(label(".max files are opened by your own 3ds Max in the background, so Corona "
                           "and V-Ray materials are read exactly. Without 3ds Max, export to FBX first.",
                           "Faint", wrap=True))
        grid.addWidget(mc, 0, 0)

        # recent
        rc = card()
        self.recent_lay = QVBoxLayout(rc)
        self.recent_lay.setContentsMargins(18, 18, 18, 18)
        self.recent_lay.setSpacing(6)
        grid.addWidget(rc, 0, 1)
        grid.setColumnStretch(0, 1)
        grid.setColumnStretch(1, 1)
        lay.addLayout(grid)

        # what happens on export
        fc = card()
        fl = QGridLayout(fc)
        fl.setContentsMargins(18, 18, 18, 18)
        fl.setHorizontalSpacing(24)
        fl.setVerticalSpacing(8)
        facts = [
            ("Materials", "Corona Physical, Corona Legacy, V-Ray, V-Ray 2-Sided, Physical and Standard "
                          "become PBR: base colour, opacity, normal, roughness, metallic, AO, translucency."),
            ("Procedural maps", "Colour Correct, Mix, Falloff and tint maps are baked at the source "
                                "resolution, so D5 shows what Corona rendered."),
            ("Smaller files", "Duplicate textures, opaque alpha, grey maps stored as RGB and repeated "
                              "geometry are removed. No decimation, no downscaling."),
            ("Leaves", "Opacity is packed into the base colour alpha and written as its own map; leaf "
                       "materials are flagged two-sided for D5's Foliage template."),
        ]
        for i, (h, t) in enumerate(facts):
            fl.addWidget(self._fact(h, t), i // 2, i % 2)
        lay.addWidget(fc)
        lay.addStretch(1)
        self.refresh_recent()
        return self._scroll(inner)

    def _fact(self, h: str, t: str) -> QWidget:
        w = QWidget()
        w.setLayout(vbox(label(h, "H3"), label(t, "Muted", wrap=True), spacing=4))
        return w

    def refresh_recent(self) -> None:
        while self.recent_lay.count():
            it = self.recent_lay.takeAt(0)
            if it.widget():
                it.widget().deleteLater()
            elif it.layout():
                self._clear_layout(it.layout())
        recent = [r for r in self.settings.get("recent", []) if os.path.exists(r)][:6]
        self.recent_lay.addLayout(hbox(label("Recent", "H3"), badge(str(len(recent))), None))
        if not recent:
            self.recent_lay.addWidget(label("Files you open appear here.", "Muted"))
        for r in recent:
            name = label(Path(r).name, "H3")
            where = label(str(Path(r).parent), "Faint")
            where.setMaximumWidth(380)
            b = QPushButton("Open")
            b.clicked.connect(lambda _=False, p=r: self.load(p))
            self.recent_lay.addLayout(hbox(vbox(name, where, spacing=0), None, b))
        self.recent_lay.addStretch(1)

    def _clear_layout(self, lay) -> None:
        while lay.count():
            it = lay.takeAt(0)
            if it.widget():
                it.widget().deleteLater()
            elif it.layout():
                self._clear_layout(it.layout())

    # ------------------------------------------------------------------ #
    # Model page
    # ------------------------------------------------------------------ #
    def _build_model(self) -> QWidget:
        page = QWidget()
        lay = QVBoxLayout(page)
        lay.setContentsMargins(20, 16, 20, 16)
        lay.setSpacing(12)
        self.model_title = label("No model", "H2")
        self.model_sub = label("", "Muted")
        to_export = QPushButton("Export selection")
        to_export.setObjectName("Primary")
        to_export.clicked.connect(lambda: self.go("export"))
        lay.addLayout(hbox(vbox(self.model_title, self.model_sub, spacing=2), None, to_export))

        split = QSplitter(Qt.Horizontal)
        split.setHandleWidth(12)

        # outliner
        oc = card()
        ol = QVBoxLayout(oc)
        ol.setContentsMargins(12, 12, 12, 12)
        ol.setSpacing(8)
        self.out_count = badge("0")
        all_b = QPushButton("All")
        all_b.setObjectName("Ghost")
        all_b.clicked.connect(lambda: self.check_all(True))
        none_b = QPushButton("None")
        none_b.setObjectName("Ghost")
        none_b.clicked.connect(lambda: self.check_all(False))
        ol.addLayout(hbox(label("Objects", "H3"), self.out_count, None, all_b, none_b))
        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["Name", "Triangles"])
        self.tree.setColumnWidth(0, 190)
        self.tree.header().setStretchLastSection(True)
        self.tree.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.tree.setUniformRowHeights(True)
        self.tree.setSelectionMode(QTreeWidget.ExtendedSelection)
        self.tree.itemChanged.connect(self.on_item_changed)
        self.tree.itemSelectionChanged.connect(self.on_tree_selection)
        self.tree.setContextMenuPolicy(Qt.CustomContextMenu)
        self.tree.customContextMenuRequested.connect(self.tree_menu)
        ol.addWidget(self.tree, 1)
        self.sel_summary = label("", "Faint", wrap=True)
        ol.addWidget(self.sel_summary)
        oc.setMinimumWidth(280)
        split.addWidget(oc)

        # viewport
        vc = card("Viewport")
        vl = QVBoxLayout(vc)
        vl.setContentsMargins(10, 10, 10, 10)
        vl.setSpacing(8)
        self.view_mode = Segmented([("textured", "Textured"), ("clay", "Clay")], "textured")
        self.view_mode.changed.connect(self.set_view_mode)
        self.wire_t = Toggle(False)
        self.wire_t.toggled.connect(self.set_wire)
        self.spread_t = Toggle(False)
        self.spread_t.toggled.connect(self.set_spread)
        self.grid_t = Toggle(True)
        self.grid_t.toggled.connect(self.set_grid)
        frame_b = QPushButton("Frame")
        frame_b.clicked.connect(lambda: self.viewport.frame())
        vl.addLayout(hbox(self.view_mode, None, label("Wire", "Muted"), self.wire_t,
                          label("Side by side", "Muted"), self.spread_t,
                          label("Grid", "Muted"), self.grid_t, frame_b, spacing=10))
        self.viewport = make_viewport(self.settings.get("renderer", "directx"))
        self.viewport.picked.connect(self.on_pick)
        self.viewport.status.connect(self.on_view_status)
        vl.addWidget(self.viewport, 1)
        self.view_stats = label("", "Faint")
        vl.addWidget(label("Left drag orbit · Middle or Shift drag pan · Wheel zoom · Click select · "
                           "F frame selection · A frame all", "Faint"))
        vl.addWidget(self.view_stats)
        split.addWidget(vc)

        # inspector
        ic = card()
        il = QVBoxLayout(ic)
        il.setContentsMargins(14, 14, 14, 14)
        il.setSpacing(10)
        il.addWidget(label("Inspector", "H3"))
        self.insp_obj = label("Click an object in the view or the list.", "Muted", wrap=True)
        il.addWidget(self.insp_obj)
        il.addWidget(divider())
        self.mat_header = QHBoxLayout()
        self.mat_title = label("Material", "H3")
        self.mat_type = badge("")
        self.mat_type.hide()
        il.addLayout(hbox(self.mat_title, self.mat_type, None))
        self.mat_list = QVBoxLayout()
        self.mat_list.setSpacing(6)
        mats_w = QWidget()
        mats_w.setLayout(self.mat_list)
        il.addWidget(mats_w)
        self.foliage_t = Toggle(False)
        self.foliage_t.toggled.connect(self.set_foliage)
        self.normal_seg = Segmented([("directx", "DirectX"), ("opengl", "OpenGL")], "directx")
        self.normal_seg.changed.connect(self.set_normal_conv)
        il.addLayout(hbox(label("Leaf / two-sided", "Muted"), None, self.foliage_t))
        il.addLayout(hbox(label("Normal map", "Muted"), None, self.normal_seg))
        self.mat_notes = label("", "Faint", wrap=True)
        il.addWidget(self.mat_notes)
        il.addStretch(1)
        insp_scroll = self._scroll(ic)
        insp_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        insp_scroll.setMinimumWidth(340)
        split.addWidget(insp_scroll)
        split.setStretchFactor(0, 0)
        split.setStretchFactor(1, 1)
        split.setStretchFactor(2, 0)
        split.setSizes([300, 780, 360])
        lay.addWidget(split, 1)
        return page

    # ------------------------------------------------------------------ #
    # Export page
    # ------------------------------------------------------------------ #
    def _build_export(self) -> QWidget:
        inner, lay = self._page(
            "Export for D5",
            "Writes FBX files plus a textures folder. Geometry and textures stay full detail: the "
            "savings come from removing duplicates and redundant data, not from quality.")
        o = self.export_opts
        cols = QHBoxLayout()
        cols.setSpacing(14)
        left = QVBoxLayout()
        left.setSpacing(14)

        # output
        c1 = card()
        l1 = QVBoxLayout(c1)
        l1.setContentsMargins(18, 16, 18, 16)
        l1.addWidget(label("Output", "H3"))
        self.out_edit = QLineEdit(o.out_dir)
        browse = QPushButton("Browse")
        browse.clicked.connect(self.pick_out_dir)
        l1.addLayout(hbox(self.out_edit, browse))
        self.asset_edit = QLineEdit(o.asset_name)
        self.asset_edit.setPlaceholderText("Asset folder name (default: file name)")
        l1.addWidget(self.asset_edit)
        self.layout_seg = Segmented([("split", "One FBX per variant"), ("single", "One FBX")],
                                    "split" if o.split_variants else "single")
        l1.addWidget(Row("Files", "Separate FBX per tree variant share one textures folder.", self.layout_seg))
        self.center_t = Toggle(o.center_to_origin)
        l1.addWidget(Row("Place at origin", "Each variant sits on the ground at 0,0,0 so it drops "
                         "into D5 where you click.", self.center_t))
        self.embed_t = Toggle(o.embed_textures)
        l1.addWidget(Row("Embed textures", "Off keeps the FBX small; textures sit next to it.", self.embed_t))
        left.addWidget(c1)

        # geometry
        c2 = card()
        l2 = QVBoxLayout(c2)
        l2.setContentsMargins(18, 16, 18, 16)
        l2.addWidget(label("Geometry", "H3"))
        self.opt_mesh_t = Toggle(o.optimize_meshes)
        l2.addWidget(Row("Lossless optimisation", "Welds identical points, stores each normal and UV "
                         "once, removes zero-area faces and unused slots. Shape is unchanged.", self.opt_mesh_t))
        self.inst_t = Toggle(o.instancing)
        l2.addWidget(Row("Instancing", "Identical objects are written once and referenced.", self.inst_t))
        self.hidden_t = Toggle(o.include_hidden)
        l2.addWidget(Row("Include hidden objects", "MaxTree often hides alternative variants.", self.hidden_t))
        left.addWidget(c2)
        left.addStretch(1)

        right = QVBoxLayout()
        right.setSpacing(14)
        c3 = card()
        l3 = QVBoxLayout(c3)
        l3.setContentsMargins(18, 16, 18, 16)
        l3.addWidget(label("Textures", "H3"))
        self.tex_mode = Segmented([("lossless", "Lossless"), ("visually_lossless", "Visually lossless"),
                                   ("copy", "Copy originals")], o.textures.mode)
        l3.addWidget(self.tex_mode)
        self.tex_mode_desc = label("", "Faint", wrap=True)
        l3.addWidget(self.tex_mode_desc)
        self.tex_mode.changed.connect(self._tex_mode_text)
        self._tex_mode_text(o.textures.mode)
        self.pack_t = Toggle(o.textures.pack_opacity_in_base_alpha)
        l3.addWidget(Row("Opacity in base colour alpha", "Lets D5 detect leaf cut-outs on import.", self.pack_t))
        self.gloss_t = Toggle(o.textures.convert_gloss_to_roughness)
        l3.addWidget(Row("Glossiness to roughness", "Corona / V-Ray gloss maps are inverted exactly "
                         "(255 - value) because D5 uses roughness.", self.gloss_t))
        self.const_t = Toggle(o.textures.collapse_constant)
        l3.addWidget(Row("Single-colour maps to values", "A 4K map of one colour becomes a number.", self.const_t))
        self.ntarget = Segmented([("directx", "DirectX"), ("opengl", "OpenGL")], o.textures.normal_target)
        l3.addWidget(Row("Normal maps for", "D5 Render expects DirectX.", self.ntarget))
        right.addWidget(c3)

        c4 = card()
        l4 = QVBoxLayout(c4)
        l4.setContentsMargins(18, 16, 18, 16)
        self.exp_summary = label("Nothing selected", "Muted", wrap=True)
        self.exp_btn = QPushButton("Export")
        self.exp_btn.setObjectName("Primary")
        self.exp_btn.clicked.connect(self.start_export)
        self.cancel_btn = QPushButton("Cancel")
        self.cancel_btn.clicked.connect(self.cancel_job)
        self.cancel_btn.hide()
        l4.addLayout(hbox(label("Selection", "H3"), None))
        l4.addWidget(self.exp_summary)
        self.exp_progress = QProgressBar()
        self.exp_progress.setRange(0, 1000)
        self.exp_progress.setTextVisible(False)
        self.exp_progress.hide()
        self.exp_status = label("", "Faint", wrap=True)
        l4.addWidget(self.exp_progress)
        l4.addWidget(self.exp_status)
        open_out = QPushButton("Open folder")
        open_out.clicked.connect(self.open_out_dir)
        l4.addLayout(hbox(None, open_out, self.cancel_btn, self.exp_btn))
        right.addWidget(c4)
        self.report_box = QPlainTextEdit()
        self.report_box.setReadOnly(True)
        self.report_box.setMinimumHeight(260)
        self.report_box.setPlaceholderText("The export report appears here.")
        right.addWidget(self.report_box, 1)
        cols.addLayout(left, 1)
        cols.addLayout(right, 1)
        lay.addLayout(cols, 1)
        return self._scroll(inner)

    def _tex_mode_text(self, mode: str) -> None:
        self.tex_mode_desc.setText({
            "lossless": "Every pixel and the full resolution are kept. PNG/TIFF/TGA are recompressed "
                        "losslessly, JPEGs are copied byte for byte.",
            "visually_lossless": "Colour maps without alpha are saved as JPEG quality 95 with full "
                                 "chroma. Smallest files; not bit-exact. Data maps stay lossless.",
            "copy": "Originals are copied as they are (only required conversions are applied).",
        }.get(mode, ""))

    # ------------------------------------------------------------------ #
    # Settings & help
    # ------------------------------------------------------------------ #
    def _build_settings(self) -> QWidget:
        inner, lay = self._page("Settings", "Defaults for opening files. Export options live on the Export page.")
        c = card()
        l = QVBoxLayout(c)
        l.setContentsMargins(18, 16, 18, 16)
        l.addWidget(label("3ds Max", "H3"))
        self.max_path = QLineEdit(self.settings.get("max_batch", ""))
        self.max_path.setPlaceholderText(r"Auto-detect, or C:\Program Files\Autodesk\3ds Max 2025\3dsmaxbatch.exe")
        pick = QPushButton("Browse")
        pick.clicked.connect(self.pick_max_exe)
        l.addLayout(hbox(self.max_path, pick))
        self.bake_t = Toggle(self.settings.get("bake_procedural", True))
        l.addWidget(Row("Bake procedural maps", "Colour Correct, Mix, Falloff and similar maps are "
                        "rendered to images at full resolution.", self.bake_t))
        self.proxy_t = Toggle(self.settings.get("convert_proxies", True))
        l.addWidget(Row("Convert proxies", "Corona / V-Ray proxies are turned into real meshes.", self.proxy_t))
        self.cache_t = Toggle(self.settings.get("reuse_cache", True))
        l.addWidget(Row("Reuse previous 3ds Max export", "Reopening an unchanged .max file is instant.", self.cache_t))
        self.usemax_t = Toggle(self.settings.get("use_3dsmax", True))
        l.addWidget(Row("Use 3ds Max for .max files", "Off: open .max files from the FBX/OBJ exports in their "
                        "library folder (no 3ds Max needed, faster).", self.usemax_t))
        lay.addWidget(c)
        cr = card()
        lr = QVBoxLayout(cr)
        lr.setContentsMargins(18, 16, 18, 16)
        lr.addWidget(label("Preview", "H3"))
        self.renderer_seg = Segmented([("directx", "DirectX 11"), ("opengl", "OpenGL")],
                                      self.settings.get("renderer", "directx"))
        lr.addWidget(Row("Renderer", "DirectX 11 is the default on Windows. Switch to OpenGL if the "
                         "preview stays empty on your graphics driver. Applies after restart.", self.renderer_seg))
        lay.addWidget(cr)
        c2 = card()
        l2 = QVBoxLayout(c2)
        l2.setContentsMargins(18, 16, 18, 16)
        l2.addWidget(label("Megascans", "H3"))
        self.lod_seg = Segmented([(str(i), f"LOD{i}") for i in range(4)], str(self.settings.get("lod", 0)))
        l2.addWidget(Row("Level of detail", "LOD0 is the full-detail model.", self.lod_seg))
        self.ms_normal = Segmented([("opengl", "OpenGL"), ("directx", "DirectX")],
                                   self.settings.get("megascans_normals", "opengl"))
        l2.addWidget(Row("Source normal maps", "How the downloaded normal maps are encoded "
                         "(Bridge default: OpenGL). They are converted for D5.", self.ms_normal))
        lay.addWidget(c2)
        save = QPushButton("Save")
        save.setObjectName("Primary")
        save.clicked.connect(self.save_prefs)
        lay.addLayout(hbox(None, save))
        lay.addStretch(1)
        return self._scroll(inner)

    def _build_help(self) -> QWidget:
        inner, lay = self._page("Help", f"D5 Bridge {__version__}")
        steps = [
            ("1  Open", "Drop a .max file, a Megascans folder or an FBX/OBJ. For .max files your installed "
                        "3ds Max (2021+) opens the file in the background; Corona or V-Ray must be installed "
                        "for their materials to be read. You can also use the D5 Bridge toolbar button inside 3ds Max."),
            ("2  Choose", "Each variant (tree version) is listed in the sidebar and the Objects panel. Untick "
                          "what you don't need: a variant, or single parts such as a pot or ground plane. Click "
                          "objects in the view to inspect their material and textures."),
            ("3  Check materials", "The inspector shows every map D5 will receive. Click a map to replace it, "
                                   "switch the normal-map convention if bumps look inverted, and mark leaves as "
                                   "two-sided."),
            ("4  Export", "One FBX per variant plus one shared textures folder. In D5: Import model, pick the "
                          "FBX. For leaves choose the Foliage material template if D5 didn't. Extra maps "
                          "(roughness, AO, translucency) are in textures/ with D5 suffixes."),
        ]
        for h, t in steps:
            c = card()
            l = QVBoxLayout(c)
            l.setContentsMargins(18, 14, 18, 14)
            l.addWidget(label(h, "H3"))
            l.addWidget(label(t, "Muted", wrap=True))
            lay.addWidget(c)
        lay.addWidget(label("Command line: D5Bridge.exe --export file.max --out D:\\D5 --split-variants", "Mono"))
        lay.addStretch(1)
        return self._scroll(inner)

    # ------------------------------------------------------------------ #
    # theme / navigation
    # ------------------------------------------------------------------ #
    def apply_theme(self, p: Palette) -> None:
        self.palette_ = p
        QApplication.instance().setStyleSheet(qss(p))
        muted = p.text_muted
        for key, b in self.nav.items():
            b.setIcon(make_icon(self._icons_for_nav[key], p.primary_fg if b.isChecked() else muted))
            b.setIconSize(QSize(18, 18))
        self.theme_btn.setIcon(make_icon("sun" if p.name == "dark" else "moon", p.text, 20))
        self.theme_btn.setIconSize(QSize(20, 20))
        self.warn_btn.setIcon(make_icon("bell", p.text, 20))
        self.warn_btn.setIconSize(QSize(20, 20))
        self.search_icon.setPixmap(make_icon("search", p.text_faint, 16).pixmap(16, 16))
        self.drop_icon.setPixmap(make_icon("tree", p.text_muted, 40).pixmap(40, 40))
        self.max_tile_icon.setPixmap(make_icon("cpu", p.text, 20).pixmap(20, 20))
        self.viewport.set_theme(p.viewport_top, p.viewport_bottom, p.accent, p.text_faint)
        for t in self.findChildren(Toggle):
            t.colors = (p.primary_bg, p.border_strong, p.primary_fg)
            t.update()
        _dark_title_bar(self, p.name == "dark")

    def toggle_theme(self) -> None:
        self.apply_theme(LIGHT if self.palette_.name == "dark" else DARK)
        self.settings["theme"] = self.palette_.name
        save_settings(self.settings)

    def go(self, key: str) -> None:
        pages = {"home": self.page_home, "model": self.page_model, "export": self.page_export,
                 "settings": self.page_settings, "help": self.page_help}
        if key in ("model", "export") and self.scene is None:
            self.toast.show_message("Open a model first", "Open", self.open_file_dialog)
            key = "home"
        self.stack.setCurrentWidget(pages[key])
        self.nav[key].setChecked(True)
        for k, b in self.nav.items():
            b.setIcon(make_icon(self._icons_for_nav[k], self.palette_.primary_fg if b.isChecked()
                                else self.palette_.text_muted))
        if key == "export":
            self.update_export_summary()
        if key == "home":
            self.refresh_recent()

    # ------------------------------------------------------------------ #
    # opening
    # ------------------------------------------------------------------ #
    def open_file_dialog(self) -> None:
        start = self.settings.get("last_dir", str(Path.home()))
        path, _ = QFileDialog.getOpenFileName(
            self, "Open model", start,
            "Models (*.max *.fbx *.obj manifest.json);;3ds Max (*.max);;FBX (*.fbx);;OBJ (*.obj)")
        if path:
            self.load(path)

    def open_folder_dialog(self) -> None:
        start = self.settings.get("last_dir", str(Path.home()))
        d = QFileDialog.getExistingDirectory(self, "Megascans / Fab asset folder", start)
        if d:
            self.load(d)

    def dragEnterEvent(self, e) -> None:
        if e.mimeData().hasUrls():
            e.acceptProposedAction()
            self.drop.setProperty("hover", True)
            self.drop.style().polish(self.drop)

    def dragLeaveEvent(self, _e) -> None:
        self.drop.setProperty("hover", False)
        self.drop.style().polish(self.drop)

    def dropEvent(self, e) -> None:
        self.dragLeaveEvent(e)
        urls = e.mimeData().urls()
        if urls:
            self.load(urls[0].toLocalFile())

    def load(self, path: str) -> None:
        if self.current_job is not None:
            self.toast.show_message("Still working on the previous file")
            return
        p = Path(path)
        if p.is_file() and p.suffix.lower() not in SUPPORTED:
            self.toast.show_message(f"{p.suffix} files are not supported")
            return
        self.settings["last_dir"] = str(p.parent if p.is_file() else p)
        rec = [str(p)] + [r for r in self.settings.get("recent", []) if r != str(p)]
        self.settings["recent"] = rec[:12]
        save_settings(self.settings)
        if self.settings.get("max_batch"):
            os.environ["D5B_3DSMAXBATCH"] = self.settings["max_batch"]
        max_opts = {"bake_procedural": self.settings.get("bake_procedural", True),
                    "convert_proxies": self.settings.get("convert_proxies", True),
                    "use_3dsmax": self.settings.get("use_3dsmax", True)}
        job = Job(_load_job, str(p), max_options=max_opts, lod=int(self.settings.get("lod", 0)))
        job.signals.log.connect(lambda s: self.toast.show_message(s, ms=8000))
        job.signals.done.connect(lambda sc: self.on_loaded(sc, p))
        job.signals.failed.connect(self.on_failed)
        self.current_job = job
        self.open_btn.setEnabled(False)
        self.toast.show_message(f"Opening {p.name}…" + (" (3ds Max runs in the background, this can take a "
                                                        "minute)" if p.suffix.lower() == ".max" else ""), ms=60000)
        self.pool.start(job)

    def on_failed(self, msg: str) -> None:
        self.current_job = None
        self.open_btn.setEnabled(True)
        self.exp_btn.setEnabled(True)
        self.cancel_btn.hide()
        self.exp_progress.hide()
        first = msg.strip().splitlines()[0] if msg.strip() else "Failed"
        self.toast.show_message(first[:140], "Details", lambda: self.show_text("Error", msg), ms=10000)
        self.exp_status.setText(first)

    def on_loaded(self, scene: Scene, path: Path) -> None:
        self.current_job = None
        self.open_btn.setEnabled(True)
        if scene.source_kind == "megascans" and self.settings.get("megascans_normals", "opengl") == "directx":
            for m in scene.materials():
                m.normal_convention = "directx"
        self.scene = scene
        self.model_title.setText(path.stem if path.is_file() else path.name)
        st = scene.stats()
        self.model_sub.setText(f"{len(scene.variants)} variant(s) · {st['objects']} objects · "
                               f"{st['triangles']:,} triangles · {st['materials']} materials · "
                               f"{scene.up_axis}-up")
        self.populate_tree()
        self.populate_variant_nav()
        self.viewport.set_scene(scene)
        self.sync_visible()
        self.update_warnings()
        self.asset_edit.setText(path.stem if path.is_file() else path.name)
        self.go("model")
        self.toast.show_message(f"Opened {path.name} · {len(scene.variants)} variant(s)")

    # ------------------------------------------------------------------ #
    # outliner
    # ------------------------------------------------------------------ #
    def populate_tree(self) -> None:
        self.tree.blockSignals(True)
        self.tree.clear()
        self.node_items.clear()
        self.item_nodes.clear()
        sc = self.scene
        assert sc is not None
        for v in sc.variants:
            tris = sum(n.mesh.num_triangles for n in v.mesh_nodes() if n.mesh is not None)
            vi = QTreeWidgetItem([v.name, f"{tris:,}"])
            vi.setFlags(vi.flags() | Qt.ItemIsUserCheckable | Qt.ItemIsAutoTristate)
            vi.setCheckState(0, Qt.Checked)
            f = vi.font(0)
            f.setWeight(QFont.DemiBold)
            vi.setFont(0, f)
            vi.setToolTip(0, f"Detected by: {v.reason.split('|')[0]}")
            vi.setData(0, Qt.UserRole, ("variant", v))
            self.tree.addTopLevelItem(vi)
            for n in v.mesh_nodes():
                mats = ", ".join(dict.fromkeys(m.name for m in n.materials))
                it = QTreeWidgetItem([n.name, f"{n.mesh.num_triangles:,}" if n.mesh else ""])
                it.setFlags(it.flags() | Qt.ItemIsUserCheckable)
                hidden = n.tags.get("hidden_in_max") == "1"
                it.setCheckState(0, Qt.Checked)
                it.setToolTip(0, f"{n.path()}\nMaterials: {mats}" + ("\nHidden in 3ds Max" if hidden else ""))
                if hidden:
                    it.setForeground(0, QColor(self.palette_.text_muted))
                it.setData(0, Qt.UserRole, ("node", n))
                vi.addChild(it)
                self.node_items[id(n)] = it
                self.item_nodes[id(it)] = n
            vi.setExpanded(len(sc.variants) <= 3)
        self.tree.blockSignals(False)
        self.out_count.setText(str(len(self.node_items)))
        self.update_selection_summary()

    def populate_variant_nav(self) -> None:
        self._clear_layout(self.variant_list)
        sc = self.scene
        if sc is None or not sc.variants:
            self.variant_list.addWidget(label("No variants", "Faint"))
            return
        for i, v in enumerate(sc.variants[:14]):
            b = QPushButton(f"  {v.name}")
            b.setObjectName("NavItem")
            b.setToolTip(f"Show only {v.name}")
            b.setIcon(make_icon("tree", self.palette_.text_muted))
            b.clicked.connect(lambda _=False, idx=i: self.solo_variant(idx))
            n = badge(str(len(v.mesh_nodes())))
            self.variant_list.addLayout(hbox(b, n, spacing=4))
        if len(sc.variants) > 1:
            allb = QPushButton("  Show all")
            allb.setObjectName("NavItem")
            allb.setIcon(make_icon("grid", self.palette_.text_muted))
            allb.clicked.connect(lambda: self.check_all(True))
            self.variant_list.addWidget(allb)

    def solo_variant(self, idx: int) -> None:
        self.tree.blockSignals(True)
        for i in range(self.tree.topLevelItemCount()):
            self.tree.topLevelItem(i).setCheckState(0, Qt.Checked if i == idx else Qt.Unchecked)
        self.tree.blockSignals(False)
        self.sync_visible()
        self.viewport.frame(all_nodes=True)
        if self.stack.currentWidget() is not self.page_model:
            self.go("model")

    def check_all(self, state: bool) -> None:
        self.tree.blockSignals(True)
        for i in range(self.tree.topLevelItemCount()):
            self.tree.topLevelItem(i).setCheckState(0, Qt.Checked if state else Qt.Unchecked)
        self.tree.blockSignals(False)
        self.sync_visible()
        if state:
            self.viewport.frame(all_nodes=True)

    def on_item_changed(self, _item, _col) -> None:
        self.sync_visible()

    def checked_nodes(self) -> list[Node]:
        out = []
        for nid, it in self.node_items.items():
            if it.checkState(0) == Qt.Checked:
                out.append(self.item_nodes[id(it)])
        return out

    def checked_variants(self) -> list[Variant]:
        out = []
        for i in range(self.tree.topLevelItemCount()):
            it = self.tree.topLevelItem(i)
            if it.checkState(0) != Qt.Unchecked:
                out.append(it.data(0, Qt.UserRole)[1])
        return out

    def sync_visible(self) -> None:
        nodes = self.checked_nodes()
        self.viewport.set_visible(nodes)
        tris = sum(n.mesh.num_triangles for n in nodes if n.mesh is not None)
        api = getattr(self, "renderer_name", "") or getattr(self.viewport, "backend_name", "")
        self.view_stats.setText(f"{len(nodes)} objects · {tris:,} triangles shown · {api}")
        self.update_selection_summary()
        self.nav_badges["model"].hide()

    def update_selection_summary(self) -> None:
        nodes = self.checked_nodes()
        vs = self.checked_variants()
        mats = {id(m): m for n in nodes for m in n.materials}
        tex = {r.path for m in mats.values() for r in m.maps.values()}
        self.sel_summary.setText(f"Export: {len(vs)} variant(s), {len(nodes)} objects, "
                                 f"{len(mats)} materials, {len(tex)} textures")

    def filter_tree(self, text: str) -> None:
        t = text.lower().strip()
        for i in range(self.tree.topLevelItemCount()):
            vi = self.tree.topLevelItem(i)
            any_child = False
            for j in range(vi.childCount()):
                c = vi.child(j)
                n = self.item_nodes.get(id(c))
                mats = " ".join(m.name for m in n.materials).lower() if n else ""
                ok = not t or t in c.text(0).lower() or t in mats
                c.setHidden(not ok)
                any_child |= ok
            vi.setHidden(not (any_child or t in vi.text(0).lower()))
        if t and self.stack.currentWidget() is self.page_home and self.scene is not None:
            self.go("model")

    def on_tree_selection(self) -> None:
        nodes = []
        for it in self.tree.selectedItems():
            kind, obj = it.data(0, Qt.UserRole)
            if kind == "node":
                nodes.append(obj)
            else:
                nodes.extend(obj.mesh_nodes())
        self.viewport.set_selected({id(n) for n in nodes})
        self.show_inspector(nodes[0] if nodes else None)

    def on_pick(self, node: Node | None, additive: bool) -> None:
        self.tree.blockSignals(True)
        if not additive:
            self.tree.clearSelection()
        if node is not None and id(node) in self.node_items:
            it = self.node_items[id(node)]
            it.setSelected(True)
            self.tree.scrollToItem(it)
        self.tree.blockSignals(False)
        self.on_tree_selection()

    def tree_menu(self, pos) -> None:
        it = self.tree.itemAt(pos)
        if it is None:
            return
        m = QMenu(self)
        kind, obj = it.data(0, Qt.UserRole)
        if kind == "variant":
            idx = self.tree.indexOfTopLevelItem(it)
            m.addAction("Show only this variant", lambda: self.solo_variant(idx))
            m.addAction("Rename…", lambda: self.rename_variant(it, obj))
        m.addAction("Frame", lambda: (self.on_tree_selection(), self.viewport.frame()))
        m.exec(self.tree.viewport().mapToGlobal(pos))

    def rename_variant(self, it: QTreeWidgetItem, v: Variant) -> None:
        from PySide6.QtWidgets import QInputDialog
        name, ok = QInputDialog.getText(self, "Rename variant", "Name", text=v.name)
        if ok and name.strip():
            v.name = name.strip()
            it.setText(0, v.name)
            self.populate_variant_nav()

    # ------------------------------------------------------------------ #
    # inspector
    # ------------------------------------------------------------------ #
    def show_inspector(self, node: Node | None) -> None:
        self._clear_layout(self.mat_list)
        if node is None:
            self.insp_obj.setText("Click an object in the view or the list.")
            self.selected_material = None
            self.mat_type.hide()
            self.mat_notes.setText("")
            return
        m = node.mesh
        self.insp_obj.setText(f"<b>{node.name}</b><br>{m.num_triangles:,} triangles · {m.num_vertices:,} points"
                              f" · {len(m.uv_sets)} UV channel(s)<br><span style='color:{self.palette_.text_faint}'>"
                              f"{node.path()}</span>" if m else node.name)
        mats = list({id(m): m for m in node.materials}.values())
        for mat in mats:
            self._material_card(mat)
        self.select_material(mats[0] if mats else None)

    def _material_card(self, mat: Material) -> None:
        box = card("CardFlat")
        bl = QVBoxLayout(box)
        bl.setContentsMargins(10, 10, 10, 10)
        bl.setSpacing(6)
        head = QPushButton(mat.name)
        head.setObjectName("Ghost")
        head.setStyleSheet("text-align:left; font-weight:600;")
        head.clicked.connect(lambda: self.select_material(mat))
        bl.addWidget(head)
        grid = QGridLayout()
        grid.setSpacing(6)
        col = 0
        row = 0
        for ch, text in CHANNEL_LABELS:
            ref = mat.maps.get(ch)
            if ref is None and ch not in ("base_color", "opacity", "normal", "roughness"):
                continue
            tile = QPushButton()
            tile.setFixedSize(46, 46)
            tile.setStyleSheet("border-radius: 10px; padding: 0;")
            tile.setToolTip(f"{text}: {ref.path if ref else 'none'}\nClick to replace")
            if ref is not None:
                pm = thumb(ref.path, 26)
                if pm is not None:
                    tile.setIcon(QIcon(pm))
                    tile.setIconSize(QSize(42, 42))
                else:
                    tile.setText("missing")
            else:
                tile.setText("+")
            tile.clicked.connect(lambda _=False, c=ch, m=mat: self.replace_map(m, c))
            cap = label(text + (" (inv)" if ref is not None and ref.invert else ""), "Faint")
            cap.setAlignment(Qt.AlignCenter)
            w = QWidget()
            w.setLayout(vbox(tile, cap, spacing=2))
            grid.addWidget(w, row, col)
            col += 1
            if col == 4:
                col, row = 0, row + 1
        bl.addLayout(grid)
        r, g, b = (int(max(0, min(1, x)) * 255) for x in mat.base_color)
        bl.addWidget(label(f"roughness {mat.roughness:.2f} · metallic {mat.metallic:.2f} · "
                           f"colour <span style='color:rgb({r},{g},{b})'>■</span>", "Faint"))
        self.mat_list.addWidget(box)

    def select_material(self, mat: Material | None) -> None:
        self.selected_material = mat
        if mat is None:
            return
        self.mat_title.setText(mat.name)
        self.mat_type.setText(mat.source_type or "material")
        self.mat_type.setVisible(bool(mat.source_type))
        self.foliage_t.blockSignals(True)
        self.foliage_t.setChecked(mat.is_foliage or mat.two_sided)
        self.foliage_t.blockSignals(False)
        self.normal_seg.set_value(mat.normal_convention)
        self.mat_notes.setText("\n".join(f"• {n}" for n in mat.notes))

    def replace_map(self, mat: Material, ch: str) -> None:
        cur = mat.maps.get(ch)
        start = str(Path(cur.path).parent) if cur else self.settings.get("last_dir", "")
        p, _ = QFileDialog.getOpenFileName(self, f"{ch} map for {mat.name}", start,
                                           "Images (*.png *.jpg *.jpeg *.tif *.tiff *.tga *.bmp *.exr *.psd)")
        if not p:
            return
        mat.maps[ch] = TextureRef(p, uv_scale=cur.uv_scale if cur else (1, 1),
                                  uv_offset=cur.uv_offset if cur else (0, 0))
        if ch == "opacity":
            mat.is_foliage = mat.two_sided = True
        self.viewport.update()
        self.on_tree_selection()

    def set_foliage(self, on: bool) -> None:
        if self.selected_material is not None:
            self.selected_material.is_foliage = on
            self.selected_material.two_sided = on
            self.viewport.update()

    def set_normal_conv(self, conv: str) -> None:
        if self.selected_material is not None:
            self.selected_material.normal_convention = conv
            self.viewport.update()

    def on_view_status(self, msg: str) -> None:
        if "fail" in msg.lower() or "error" in msg.lower() or "not available" in msg.lower():
            self.toast.show_message(msg, ms=10000)
        self.renderer_name = msg.replace("Preview: ", "")
        self.sync_visible() if self.scene is not None else None

    def set_view_mode(self, mode: str) -> None:
        self.viewport.mode = mode
        self.viewport.update()

    def set_wire(self, on: bool) -> None:
        self.viewport.wire = on
        self.viewport.update()

    def set_spread(self, on: bool) -> None:
        self.viewport.set_spread(on)

    def set_grid(self, on: bool) -> None:
        self.viewport.show_grid = on
        self.viewport.update()

    # ------------------------------------------------------------------ #
    # export
    # ------------------------------------------------------------------ #
    def collect_export_opts(self) -> ExportOptions:
        o = self.export_opts
        o.out_dir = self.out_edit.text().strip()
        o.asset_name = self.asset_edit.text().strip()
        o.split_variants = self.layout_seg.value() == "split"
        o.center_to_origin = self.center_t.isChecked()
        o.embed_textures = self.embed_t.isChecked()
        o.optimize_meshes = self.opt_mesh_t.isChecked()
        o.instancing = self.inst_t.isChecked()
        o.include_hidden = self.hidden_t.isChecked()
        o.textures.mode = self.tex_mode.value()
        o.textures.pack_opacity_in_base_alpha = self.pack_t.isChecked()
        o.textures.convert_gloss_to_roughness = self.gloss_t.isChecked()
        o.textures.collapse_constant = self.const_t.isChecked()
        o.textures.normal_target = self.ntarget.value()
        d = o.to_json()
        d["asset_name"] = ""
        self.settings["export"] = d
        save_settings(self.settings)
        return o

    def update_export_summary(self) -> None:
        if self.scene is None:
            return
        nodes = self.checked_nodes()
        vs = self.checked_variants()
        tris = sum(n.mesh.num_triangles for n in nodes if n.mesh is not None)
        mats = {id(m): m for n in nodes for m in n.materials}
        tex = {r.path for m in mats.values() for r in m.maps.values() if r.path}
        size = sum(os.path.getsize(p) for p in tex if os.path.isfile(p))
        self.exp_summary.setText(
            f"{len(vs)} variant(s) · {len(nodes)} objects · {tris:,} triangles<br>"
            f"{len(mats)} materials · {len(tex)} source textures ({fmt_bytes(size)})")

    def start_export(self) -> None:
        if self.scene is None or self.current_job is not None:
            return
        opts = self.collect_export_opts()
        if not opts.out_dir:
            self.toast.show_message("Choose an output folder")
            return
        nodes = self.checked_nodes()
        if not nodes:
            self.toast.show_message("Tick at least one object")
            return
        selected = {id(n) for n in nodes}
        variants = self.checked_variants()
        job = Job(_export_job, self.scene, variants, selected, opts)
        job.signals.progress.connect(self.on_export_progress)
        job.signals.done.connect(self.on_exported)
        job.signals.failed.connect(self.on_failed)
        self.current_job = job
        self.exp_btn.setEnabled(False)
        self.cancel_btn.show()
        self.exp_progress.show()
        self.exp_progress.setValue(0)
        self.report_box.clear()
        self.pool.start(job)

    def on_export_progress(self, msg: str, frac: float) -> None:
        self.exp_progress.setValue(int(frac * 1000))
        self.exp_status.setText(msg)

    def on_exported(self, res) -> None:
        self.current_job = None
        self.exp_btn.setEnabled(True)
        self.cancel_btn.hide()
        self.exp_progress.hide()
        saved = res.bytes_source - res.bytes_output
        self.exp_status.setText(f"{len(res.files)} FBX · {fmt_bytes(res.bytes_output)} "
                                f"(source {fmt_bytes(res.bytes_source)}) · {res.seconds:.1f} s")
        try:
            self.report_box.setPlainText(Path(res.report_path).read_text(encoding="utf-8"))
        except OSError:
            pass
        self._last_out = str(Path(res.files[0]).parent) if res.files else ""
        msg = f"Exported {len(res.files)} FBX"
        if saved > 0:
            msg += f" · {fmt_bytes(saved)} smaller"
        self.toast.show_message(msg, "Open folder", self.open_out_dir, ms=8000)
        self.nav_badges["export"].hide()

    def cancel_job(self) -> None:
        if self.current_job is not None:
            self.current_job.cancelled = True

    def pick_out_dir(self) -> None:
        d = QFileDialog.getExistingDirectory(self, "Output folder", self.out_edit.text())
        if d:
            self.out_edit.setText(d)

    def open_out_dir(self) -> None:
        p = getattr(self, "_last_out", "") or self.out_edit.text()
        if p and os.path.isdir(p):
            _open_path(p)

    # ------------------------------------------------------------------ #
    # 3ds Max status / settings
    # ------------------------------------------------------------------ #
    def refresh_max_status(self) -> None:
        from ..max.bridge import find_max_installs
        if self.settings.get("max_batch"):
            os.environ["D5B_3DSMAXBATCH"] = self.settings["max_batch"]
        installs = find_max_installs()
        if installs:
            names = ", ".join(i.label for i in installs[:3])
            self.max_title.setText(installs[0].label)
            self.max_desc.setText(f"Ready to open .max files. Found: {names}.")
            self.max_chip.setText("Ready")
            self.status_dot.setStyleSheet(f"color:{self.palette_.success}")
            self.status_text.setText(f"{installs[0].label} ready")
        else:
            self.max_title.setText("3ds Max not found")
            self.max_desc.setText("FBX, OBJ and Megascans work without it. For .max files install 3ds Max "
                                  "2021+ or set its path in Settings.")
            self.max_chip.setText("Not found")
            self.status_dot.setStyleSheet(f"color:{self.palette_.text_faint}")
            self.status_text.setText("FBX / OBJ / Megascans mode")

    def pick_max_exe(self) -> None:
        p, _ = QFileDialog.getOpenFileName(self, "3dsmaxbatch.exe", r"C:\Program Files\Autodesk",
                                           "3dsmaxbatch.exe (3dsmaxbatch.exe)")
        if p:
            self.max_path.setText(p)

    def save_prefs(self) -> None:
        self.settings["max_batch"] = self.max_path.text().strip()
        self.settings["bake_procedural"] = self.bake_t.isChecked()
        self.settings["convert_proxies"] = self.proxy_t.isChecked()
        self.settings["reuse_cache"] = self.cache_t.isChecked()
        self.settings["lod"] = int(self.lod_seg.value() or 0)
        self.settings["megascans_normals"] = self.ms_normal.value()
        self.settings["use_3dsmax"] = self.usemax_t.isChecked()
        self.settings["renderer"] = self.renderer_seg.value()
        save_settings(self.settings)
        self.refresh_max_status()
        self.toast.show_message("Settings saved")

    def open_plugin_folder(self) -> None:
        from ..max.bridge import plugin_dir
        try:
            d = plugin_dir()
        except FileNotFoundError as e:
            self.toast.show_message(str(e))
            return
        _open_path(str(d))
        self.toast.show_message("Run install_max_plugin.bat, then add the D5 Bridge button in 3ds Max")

    # ------------------------------------------------------------------ #
    def update_warnings(self) -> None:
        n = len(self.scene.warnings) if self.scene else 0
        self.warn_badge.setText(str(n))
        self.warn_badge.setVisible(n > 0)

    def show_warnings(self) -> None:
        if not self.scene or not self.scene.warnings:
            self.toast.show_message("No warnings")
            return
        self.show_text("Warnings", "\n\n".join(self.scene.warnings))

    def show_text(self, title: str, text: str) -> None:
        from PySide6.QtWidgets import QDialog
        dlg = QDialog(self)
        dlg.setWindowTitle(title)
        dlg.resize(720, 460)
        lay = QVBoxLayout(dlg)
        box = QPlainTextEdit(text)
        box.setReadOnly(True)
        lay.addWidget(box)
        ok = QPushButton("Close")
        ok.setObjectName("Primary")
        ok.clicked.connect(dlg.accept)
        lay.addLayout(hbox(None, ok))
        dlg.exec()

    def resizeEvent(self, e) -> None:
        super().resizeEvent(e)
        if hasattr(self, "toast"):
            self.toast.reposition()
        for key, bd in self.nav_badges.items():
            b = self.nav[key]
            bd.adjustSize()
            bd.move(b.width() - bd.width() - 10, (b.height() - bd.height()) // 2)


# =========================================================================== #
def _open_path(p: str) -> None:
    if sys.platform == "win32":
        os.startfile(p)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", p])
    else:
        subprocess.Popen(["xdg-open", p])


def _dark_title_bar(win: QWidget, dark: bool) -> None:
    if sys.platform != "win32":
        return
    try:
        import ctypes
        hwnd = int(win.winId())
        val = ctypes.c_int(1 if dark else 0)
        for attr in (20, 19):   # DWMWA_USE_IMMERSIVE_DARK_MODE (new, old builds)
            if ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, attr, ctypes.byref(val), 4) == 0:
                break
    except Exception:  # noqa: BLE001
        pass


def run_app(path: str | None = None) -> int:
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("D5Bridge.App")
        except Exception:  # noqa: BLE001
            pass
    from .viewport import Viewport
    Viewport.configure_default_format()
    app = QApplication.instance() or QApplication(sys.argv)
    if _forward_to_running_instance(path):
        return 0
    app.setStyle("Fusion")
    app.setApplicationName("D5 Bridge")
    f = QFont("Inter")
    if not f.exactMatch():
        f = QFont("Segoe UI Variable Text" if sys.platform == "win32" else "")
    f.setPointSizeF(9.75)
    app.setFont(f)
    w = MainWindow()
    w.show()
    server = _listen_for_instances(w)
    _ = server
    if path:
        QTimer.singleShot(150, lambda: w.load(path))
    return app.exec()


def _instance_name() -> str:
    import getpass
    try:
        user = getpass.getuser()
    except Exception:  # noqa: BLE001
        user = "user"
    return f"D5Bridge-{user}"


def _forward_to_running_instance(path: str | None) -> bool:
    """If D5 Bridge is already open, hand it the file and quit this second copy."""
    from PySide6.QtNetwork import QLocalSocket
    sock = QLocalSocket()
    sock.connectToServer(_instance_name())
    if not sock.waitForConnected(400):
        return False
    sock.write((path or "").encode("utf-8") + b"\n")
    sock.flush()
    sock.waitForBytesWritten(1000)
    sock.disconnectFromServer()
    return True


def _listen_for_instances(w: "MainWindow"):
    from PySide6.QtNetwork import QLocalServer
    server = QLocalServer(w)
    name = _instance_name()
    if not server.listen(name):
        QLocalServer.removeServer(name)        # stale socket after a crash
        server.listen(name)

    def on_conn() -> None:
        sock = server.nextPendingConnection()
        if sock is None:
            return

        def read() -> None:
            data = bytes(sock.readAll()).decode("utf-8", "replace").strip()
            if w.isMinimized():
                w.showNormal()
            w.raise_()
            w.activateWindow()
            if data:
                w.load(data)
        sock.readyRead.connect(read)
        sock.disconnected.connect(sock.deleteLater)
    server.newConnection.connect(on_conn)
    return server
