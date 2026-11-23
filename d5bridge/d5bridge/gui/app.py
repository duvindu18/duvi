"""D5 Bridge desktop app.

Layout (one workspace, like DCC / asset tools):

    rail | header: file name ........................ [warnings] [Open] [Export]
         | outliner | viewport (toolbar + view)        | Material / Export tabs
         | status bar: progress / message ................... renderer · 3ds Max
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
import traceback
from pathlib import Path

from PySide6.QtCore import QObject, QRunnable, QSize, Qt, QThreadPool, QTimer, Signal
from PySide6.QtGui import QColor, QFont, QIcon, QKeySequence, QPixmap, QShortcut
from PySide6.QtWidgets import (QApplication, QButtonGroup, QDialog, QFileDialog, QFrame, QGridLayout,
                               QHBoxLayout, QInputDialog, QLabel, QLineEdit, QMainWindow, QMenu,
                               QPlainTextEdit, QProgressBar, QPushButton, QScrollArea, QSplitter,
                               QStackedWidget, QTabBar, QToolButton, QTreeWidget, QTreeWidgetItem,
                               QVBoxLayout, QWidget)

from .. import __version__
from ..io import SUPPORTED, load_any
from ..pipeline import Cancelled, ExportOptions, export
from ..scene import Material, Node, Scene, TextureRef, Variant
from ..settings import load_settings, save_settings
from .theme import DARK, LIGHT, Palette, qss
from .view_common import prepare_scene
from .widgets import Segmented, Toast, Toggle, badge, divider, label, make_icon

CHANNELS = [("base_color", "Color"), ("opacity", "Opacity"), ("normal", "Normal"),
            ("roughness", "Rough"), ("metallic", "Metal"), ("ao", "AO"),
            ("translucency", "Transl."), ("bump", "Bump"), ("emissive", "Emit")]
CORE_CHANNELS = {"base_color", "opacity", "normal", "roughness"}


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
            self.signals.done.emit(self.fn(*self.args, job=self, **self.kw))
        except Cancelled:
            self.signals.failed.emit("Cancelled")
        except Exception as e:  # noqa: BLE001
            self.signals.failed.emit(f"{e}\n\n{traceback.format_exc()}")


def _load_job(path: str, job: Job, max_options: dict, lod: int) -> Scene:
    scene = load_any(path, log=job.signals.log.emit, max_options=max_options, lod=lod)
    prepare_scene(scene, job.signals.log.emit)      # GPU-ready buffers, off the UI thread
    return scene


def _export_job(scene: Scene, variants, selected, opts: ExportOptions, job: Job):
    return export(scene, variants, selected, opts,
                  progress=lambda m, f: job.signals.progress.emit(m, f),
                  cancel=lambda: job.cancelled)


# =========================================================================== #
# small helpers
# =========================================================================== #
def hbox(*items, spacing: int = 8, margins=(0, 0, 0, 0)) -> QHBoxLayout:
    lay = QHBoxLayout()
    lay.setSpacing(spacing)
    lay.setContentsMargins(*margins)
    for w in items:
        if w is None:
            lay.addStretch(1)
        elif isinstance(w, int):
            lay.addSpacing(w)
        elif isinstance(w, QWidget):
            lay.addWidget(w)
        else:
            lay.addLayout(w)
    return lay


def vbox(*items, spacing: int = 8, margins=(0, 0, 0, 0)) -> QVBoxLayout:
    lay = QVBoxLayout()
    lay.setSpacing(spacing)
    lay.setContentsMargins(*margins)
    for w in items:
        if w is None:
            lay.addStretch(1)
        elif isinstance(w, int):
            lay.addSpacing(w)
        elif isinstance(w, QWidget):
            lay.addWidget(w)
        else:
            lay.addLayout(w)
    return lay


def pane() -> tuple[QFrame, QVBoxLayout]:
    f = QFrame()
    f.setObjectName("Pane")
    lay = QVBoxLayout(f)
    lay.setContentsMargins(12, 12, 12, 12)
    lay.setSpacing(8)
    return f, lay


def fmt_bytes(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


_THUMBS: dict[tuple[str, int], QPixmap] = {}


def thumb(path: str, size: int) -> QPixmap | None:
    """Small cached preview (decoded with PIL draft mode: fast even for 8K JPEGs)."""
    key = (path, size)
    if key in _THUMBS:
        return _THUMBS[key]
    try:
        from PIL import Image
        from PIL.ImageQt import ImageQt
        im = Image.open(path)
        im.draft("RGB", (size * 2, size * 2))
        im.thumbnail((size * 2, size * 2))
        pm = QPixmap.fromImage(ImageQt(im.convert("RGBA")))
    except Exception:  # noqa: BLE001
        return None
    _THUMBS[key] = pm
    return pm


def form_row(text: str, control: QWidget, tip: str = "") -> QHBoxLayout:
    lb = label(text, "FormLabel")
    if tip:
        lb.setToolTip(tip)
        control.setToolTip(tip)
    return hbox(lb, None, control)


def tool(icon: str, tip: str, checkable: bool = False) -> QToolButton:
    b = QToolButton()
    b.setObjectName("Tool")
    b.setToolTip(tip)
    b.setCheckable(checkable)
    b.setCursor(Qt.PointingHandCursor)
    b.setIconSize(QSize(18, 18))
    b.setProperty("icon_name", icon)
    return b


class Collapsible(QWidget):
    def __init__(self, title: str, content: QWidget, open_: bool = False) -> None:
        super().__init__()
        self.btn = QToolButton()
        self.btn.setObjectName("Disclosure")
        self.btn.setCheckable(True)
        self.btn.setChecked(open_)
        self.btn.setToolButtonStyle(Qt.ToolButtonTextOnly)
        self.btn.setCursor(Qt.PointingHandCursor)
        self.title = title
        self.content = content
        self._toggle(open_)
        self.btn.toggled.connect(self._toggle)
        self.setLayout(vbox(self.btn, content, spacing=4))

    def _toggle(self, on: bool) -> None:
        self.content.setVisible(on)
        self.btn.setText(("▾  " if on else "▸  ") + self.title)


# =========================================================================== #
class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.settings = load_settings()
        self.palette_ = DARK if self.settings.get("theme", "dark") == "dark" else LIGHT
        self.pool = QThreadPool.globalInstance()
        self.scene: Scene | None = None
        self.source: Path | None = None
        self.node_items: dict[int, QTreeWidgetItem] = {}
        self.item_nodes: dict[int, Node] = {}
        self.current_job: Job | None = None
        self.last_out = ""
        self.last_report = ""
        self.renderer_name = ""
        self._t0 = time.time()
        self.export_opts = ExportOptions.from_json(self.settings.get("export", {}))
        if not self.export_opts.out_dir:
            self.export_opts.out_dir = str(Path.home() / "Documents" / "D5 Bridge")

        self.setWindowTitle("D5 Bridge")
        self.resize(1440, 900)
        self.setMinimumSize(1100, 680)
        self.setAcceptDrops(True)

        root = QWidget()
        root.setObjectName("Root")
        self.setCentralWidget(root)
        outer = QHBoxLayout(root)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        outer.addWidget(self._build_rail())
        main = QWidget()
        ml = QVBoxLayout(main)
        ml.setContentsMargins(0, 0, 0, 0)
        ml.setSpacing(0)
        ml.addWidget(self._build_header())
        self.stack = QStackedWidget()
        ml.addWidget(self.stack, 1)
        ml.addWidget(self._build_status())
        outer.addWidget(main, 1)

        self.page_home = self._build_home()
        self.page_work = self._build_workspace()
        self.page_settings = self._build_settings()
        for p in (self.page_home, self.page_work, self.page_settings):
            self.stack.addWidget(p)
        self.toast = Toast(root)
        self.apply_theme(self.palette_)
        self.go("home")

        QShortcut(QKeySequence("Ctrl+O"), self, activated=self.open_file_dialog)
        QShortcut(QKeySequence("Ctrl+E"), self, activated=self.start_export)
        QShortcut(QKeySequence("Ctrl+F"), self, activated=lambda: (self.go("work"), self.filter.setFocus()))
        QShortcut(QKeySequence("H"), self, activated=self.hide_selected)
        QShortcut(QKeySequence("Alt+H"), self, activated=lambda: self.check_all(True))
        QShortcut(QKeySequence("F1"), self, activated=self.show_shortcuts)
        QTimer.singleShot(200, self.refresh_max_status)

    # ------------------------------------------------------------------ #
    # shell
    # ------------------------------------------------------------------ #
    def _rail_button(self, icon: str, tip: str) -> QToolButton:
        b = QToolButton()
        b.setObjectName("RailBtn")
        b.setToolTip(tip)
        b.setIconSize(QSize(20, 20))
        b.setFixedSize(40, 40)
        b.setCursor(Qt.PointingHandCursor)
        b.setProperty("icon_name", icon)
        return b

    def _build_rail(self) -> QWidget:
        rail = QWidget()
        rail.setObjectName("Rail")
        rail.setFixedWidth(60)
        lay = QVBoxLayout(rail)
        lay.setContentsMargins(10, 12, 10, 12)
        lay.setSpacing(6)
        mark = QLabel("D5")
        mark.setObjectName("RailMark")
        mark.setAlignment(Qt.AlignCenter)
        mark.setFixedSize(40, 32)
        mark.setToolTip(f"D5 Bridge {__version__}")
        lay.addWidget(mark)
        lay.addSpacing(10)
        self.rail_group = QButtonGroup(self)
        self.rail: dict[str, QToolButton] = {}
        for key, icon, tip in (("home", "home", "Home"), ("work", "tree", "Workspace"),
                               ("settings", "settings", "Settings")):
            b = self._rail_button(icon, tip)
            b.setCheckable(True)
            b.clicked.connect(lambda _=False, k=key: self.go(k))
            self.rail_group.addButton(b)
            self.rail[key] = b
            if key == "settings":
                lay.addStretch(1)
            lay.addWidget(b)
        self.theme_btn = self._rail_button("sun", "Light / dark theme")
        self.theme_btn.clicked.connect(self.toggle_theme)
        self.help_btn = self._rail_button("help", "Keyboard shortcuts  (F1)")
        self.help_btn.clicked.connect(self.show_shortcuts)
        lay.addWidget(self.theme_btn)
        lay.addWidget(self.help_btn)
        return rail

    def _build_header(self) -> QWidget:
        bar = QWidget()
        bar.setObjectName("Header")
        bar.setFixedHeight(56)
        lay = QHBoxLayout(bar)
        lay.setContentsMargins(20, 0, 16, 0)
        lay.setSpacing(8)
        self.crumb1 = label("D5 Bridge", "Crumb1")
        self.crumb_sep = label("/", "Crumb2")
        self.crumb2 = label("", "Crumb2")
        self.crumb_sep.hide()
        lay.addWidget(self.crumb1)
        lay.addWidget(self.crumb_sep)
        lay.addWidget(self.crumb2)
        lay.addStretch(1)
        self.warn_btn = QToolButton()
        self.warn_btn.setObjectName("Tool")
        self.warn_btn.setIconSize(QSize(20, 20))
        self.warn_btn.setToolTip("Warnings")
        self.warn_btn.clicked.connect(self.show_warnings)
        self.warn_badge = badge("0", alert=True)
        self.warn_badge.setParent(self.warn_btn)
        self.warn_badge.move(18, 0)
        self.warn_badge.hide()
        self.open_btn = QPushButton("Open")
        self.open_btn.setToolTip("Open a file  (Ctrl+O)")
        self.open_btn.clicked.connect(self.open_file_dialog)
        self.export_btn = QPushButton("Export")
        self.export_btn.setObjectName("Primary")
        self.export_btn.setToolTip("Export the ticked objects  (Ctrl+E)")
        self.export_btn.clicked.connect(self.start_export)
        self.export_btn.setEnabled(False)
        lay.addWidget(self.warn_btn)
        lay.addSpacing(4)
        lay.addWidget(self.open_btn)
        lay.addWidget(self.export_btn)
        return bar

    def _build_status(self) -> QWidget:
        bar = QWidget()
        bar.setObjectName("StatusBar")
        bar.setFixedHeight(30)
        lay = QHBoxLayout(bar)
        lay.setContentsMargins(16, 0, 16, 0)
        lay.setSpacing(10)
        self.status_msg = QLabel("Ready")
        self.status_progress = QProgressBar()
        self.status_progress.setRange(0, 1000)
        self.status_progress.setTextVisible(False)
        self.status_progress.setFixedWidth(160)
        self.status_progress.hide()
        self.cancel_btn = QPushButton("Cancel")
        self.cancel_btn.setObjectName("Ghost")
        self.cancel_btn.clicked.connect(self.cancel_job)
        self.cancel_btn.hide()
        self.status_stats = QLabel("")
        self.status_api = QLabel("")
        self.max_dot = label("●", "Dot")
        self.max_text = QLabel("")
        lay.addWidget(self.status_msg)
        lay.addWidget(self.status_progress)
        lay.addWidget(self.cancel_btn)
        lay.addStretch(1)
        lay.addWidget(self.status_stats)
        lay.addSpacing(12)
        lay.addWidget(self.status_api)
        lay.addSpacing(12)
        lay.addWidget(self.max_dot)
        lay.addWidget(self.max_text)
        return bar

    # ------------------------------------------------------------------ #
    # Home
    # ------------------------------------------------------------------ #
    def _build_home(self) -> QWidget:
        page = QWidget()
        outer = QVBoxLayout(page)
        outer.setContentsMargins(0, 0, 0, 0)
        col = QWidget()
        col.setMaximumWidth(640)
        col.setMinimumWidth(520)
        lay = QVBoxLayout(col)
        lay.setContentsMargins(24, 56, 24, 24)
        lay.setSpacing(12)
        self.drop = QFrame()
        self.drop.setObjectName("DropZone")
        d = QVBoxLayout(self.drop)
        d.setContentsMargins(32, 40, 32, 32)
        d.setSpacing(10)
        self.drop_icon = QLabel()
        self.drop_icon.setAlignment(Qt.AlignCenter)
        t = label("Open a model", "H1")
        t.setAlignment(Qt.AlignCenter)
        sub = label(".max  ·  .fbx  ·  .obj  ·  Megascans or library folder", "Muted")
        sub.setAlignment(Qt.AlignCenter)
        b1 = QPushButton("Open file")
        b1.setObjectName("Primary")
        b1.clicked.connect(self.open_file_dialog)
        b2 = QPushButton("Open folder")
        b2.clicked.connect(self.open_folder_dialog)
        hint = label("or drop it here", "Faint")
        hint.setAlignment(Qt.AlignCenter)
        d.addWidget(self.drop_icon)
        d.addWidget(t)
        d.addWidget(sub)
        d.addSpacing(8)
        d.addLayout(hbox(None, b1, b2, None))
        d.addWidget(hint)
        lay.addWidget(self.drop)
        lay.addSpacing(18)
        self.recent_title = label("RECENT", "Section2")
        lay.addWidget(self.recent_title)
        self.recent_lay = QVBoxLayout()
        self.recent_lay.setSpacing(2)
        lay.addLayout(self.recent_lay)
        lay.addStretch(1)
        outer.addLayout(hbox(None, col, None))
        self.refresh_recent()
        return page

    def refresh_recent(self) -> None:
        _clear(self.recent_lay)
        recent = [r for r in self.settings.get("recent", []) if os.path.exists(r)][:8]
        self.recent_title.setVisible(bool(recent))
        for r in recent:
            p = Path(r)
            b = QPushButton()
            b.setObjectName("RecentRow")
            b.setCursor(Qt.PointingHandCursor)
            b.setToolTip(r)
            b.clicked.connect(lambda _=False, x=r: self.load(x))
            row = QHBoxLayout(b)
            row.setContentsMargins(12, 8, 12, 8)
            icon = QLabel()
            icon.setPixmap(make_icon("folder" if p.is_dir() else "box", self.palette_.text_muted, 18)
                           .pixmap(18, 18))
            name = label(p.name, "H3")
            where = label(_short(str(p.parent), 56), "Faint")
            when = label(_ago(p), "Faint")
            for w in (icon, name, where, when):
                w.setAttribute(Qt.WA_TransparentForMouseEvents)
            row.addWidget(icon)
            row.addSpacing(6)
            row.addWidget(name)
            row.addSpacing(8)
            row.addWidget(where, 1)
            row.addWidget(when)
            b.setMinimumHeight(44)
            self.recent_lay.addWidget(b)

    # ------------------------------------------------------------------ #
    # Workspace
    # ------------------------------------------------------------------ #
    def _build_workspace(self) -> QWidget:
        page = QWidget()
        lay = QVBoxLayout(page)
        lay.setContentsMargins(12, 12, 12, 12)
        split = QSplitter(Qt.Horizontal)
        split.setHandleWidth(10)
        split.setChildrenCollapsible(False)

        # ---- outliner ------------------------------------------------- #
        op, ol = pane()
        self.obj_count = badge("0")
        all_b = tool("eye", "Show all  (Alt+H)")
        all_b.clicked.connect(lambda: self.check_all(True))
        none_b = tool("check", "Untick all")
        none_b.clicked.connect(lambda: self.check_all(False))
        self._outliner_tools = [all_b, none_b]
        ol.addLayout(hbox(label("Objects", "PaneTitle"), self.obj_count, None, all_b, none_b, spacing=6))
        self.filter = QLineEdit()
        self.filter.setObjectName("Filter")
        self.filter.setPlaceholderText("Filter  (Ctrl+F)")
        self.filter.textChanged.connect(self.filter_tree)
        self.filter_icon = QLabel(self.filter)
        self.filter_icon.move(10, 9)
        ol.addWidget(self.filter)
        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["Name", "Tris"])
        self.tree.setColumnWidth(0, 180)
        self.tree.header().setStretchLastSection(True)
        self.tree.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.tree.setUniformRowHeights(True)
        self.tree.setSelectionMode(QTreeWidget.ExtendedSelection)
        self.tree.itemChanged.connect(lambda *_: self.sync_visible())
        self.tree.itemSelectionChanged.connect(self.on_tree_selection)
        self.tree.setContextMenuPolicy(Qt.CustomContextMenu)
        self.tree.customContextMenuRequested.connect(self.tree_menu)
        ol.addWidget(self.tree, 1)
        op.setMinimumWidth(240)
        split.addWidget(op)

        # ---- viewport -------------------------------------------------- #
        vp, vl = pane()
        vl.setContentsMargins(8, 8, 8, 8)
        self.t_textured = tool("image", "Textured", True)
        self.t_clay = tool("clay", "Clay", True)
        shade = QButtonGroup(self)
        shade.setExclusive(True)
        shade.addButton(self.t_textured)
        shade.addButton(self.t_clay)
        self.t_textured.setChecked(True)
        self.t_textured.clicked.connect(lambda: self.set_view_mode("textured"))
        self.t_clay.clicked.connect(lambda: self.set_view_mode("clay"))
        self.t_wire = tool("wire", "Wireframe", True)
        self.t_wire.toggled.connect(self.set_wire)
        self.t_grid = tool("grid", "Grid", True)
        self.t_grid.setChecked(True)
        self.t_grid.toggled.connect(self.set_grid)
        self.t_spread = tool("layers", "Variants side by side", True)
        self.t_spread.toggled.connect(lambda on: self.viewport.set_spread(on))
        self.t_frame = tool("target", "Frame selection  (F)")
        self.t_frame.clicked.connect(lambda: self.viewport.frame())
        self._view_tools = [self.t_textured, self.t_clay, self.t_wire, self.t_grid, self.t_spread,
                            self.t_frame]
        vl.addLayout(hbox(self.t_textured, self.t_clay, 10, self.t_wire, self.t_grid, self.t_spread,
                          None, self.t_frame, spacing=2))
        self.viewport = make_viewport(self.settings.get("renderer", "directx"))
        self.viewport.picked.connect(self.on_pick)
        self.viewport.status.connect(self.on_view_status)
        self.viewport.setToolTip("Drag: orbit · Middle/Shift-drag: pan · Wheel: zoom · Click: select")
        vl.addWidget(self.viewport, 1)
        split.addWidget(vp)

        # ---- right panel: Material | Export ---------------------------- #
        rp, rl = pane()
        rl.setContentsMargins(14, 6, 14, 14)
        self.tabs = QTabBar()
        self.tabs.addTab("Material")
        self.tabs.addTab("Export")
        self.tabs.setExpanding(False)
        self.tabs.setDrawBase(False)
        rl.addWidget(self.tabs)
        self.right_stack = QStackedWidget()
        self.right_stack.addWidget(self._build_material_tab())
        self.right_stack.addWidget(self._build_export_tab())
        self.tabs.currentChanged.connect(self.right_stack.setCurrentIndex)
        rl.addWidget(self.right_stack, 1)
        rp.setMinimumWidth(320)
        split.addWidget(rp)
        split.setStretchFactor(0, 0)
        split.setStretchFactor(1, 1)
        split.setStretchFactor(2, 0)
        split.setSizes([270, 800, 340])
        lay.addWidget(split, 1)
        return page

    def _scroll(self, w: QWidget) -> QScrollArea:
        sc = QScrollArea()
        sc.setWidgetResizable(True)
        sc.setFrameShape(QFrame.NoFrame)
        sc.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        sc.setWidget(w)
        return sc

    def _build_material_tab(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        lay.setContentsMargins(0, 10, 0, 0)
        lay.setSpacing(10)
        self.insp_name = label("Nothing selected", "H3")
        self.insp_info = label("Click an object in the view", "Faint")
        lay.addLayout(vbox(self.insp_name, self.insp_info, spacing=2))
        self.mat_list = QVBoxLayout()
        self.mat_list.setSpacing(12)
        lay.addLayout(self.mat_list)
        lay.addStretch(1)
        return self._scroll(w)

    def _build_export_tab(self) -> QWidget:
        o = self.export_opts
        w = QWidget()
        lay = QVBoxLayout(w)
        lay.setContentsMargins(0, 12, 0, 0)
        lay.setSpacing(12)

        self.fmt_seg = Segmented([("fbx", "FBX"), ("obj", "OBJ")], o.format)
        self.fmt_seg.changed.connect(self._fmt_changed)
        lay.addLayout(form_row("Format", self.fmt_seg))
        self.tex_seg = Segmented([("embed", "Embedded"), ("files", "Files")],
                                 "embed" if o.embed_textures else "files")
        self.tex_label = label("Textures", "FormLabel")
        tip = ("Embedded: one .fbx with every texture inside, no folder.\n"
               "Files: textures next to the model. OBJ always uses files.")
        self.tex_label.setToolTip(tip)
        self.tex_seg.setToolTip(tip)
        lay.addLayout(hbox(self.tex_label, None, self.tex_seg))
        self.split_seg = Segmented([("split", "Per variant"), ("single", "Single")],
                                   "split" if o.split_variants else "single")
        lay.addLayout(form_row("Files", self.split_seg, "One file per tree variant, or all in one file"))
        self.quality_seg = Segmented([("lossless", "Lossless"), ("visually_lossless", "Smaller")],
                                     o.textures.mode if o.textures.mode != "copy" else "lossless")
        lay.addLayout(form_row("Quality", self.quality_seg,
                               "Lossless: every pixel and full resolution kept.\n"
                               "Smaller: colour maps as JPEG 95 (not bit-exact)."))
        self.center_t = Toggle(o.center_to_origin)
        lay.addLayout(form_row("Place at origin", self.center_t, "Each variant on the ground at 0,0,0"))

        lay.addSpacing(4)
        lay.addWidget(label("OUTPUT", "Section2"))
        self.out_edit = QLineEdit(o.out_dir)
        self.out_edit.setToolTip("Output folder")
        browse = tool("folder", "Choose folder")
        browse.clicked.connect(self.pick_out_dir)
        self._export_tools = [browse]
        lay.addLayout(hbox(self.out_edit, browse, spacing=4))
        self.asset_edit = QLineEdit()
        self.asset_edit.setPlaceholderText("File name")
        self.asset_edit.setToolTip("File name")
        lay.addWidget(self.asset_edit)

        adv = QWidget()
        al = QVBoxLayout(adv)
        al.setContentsMargins(0, 4, 0, 0)
        al.setSpacing(10)
        self.opt_mesh_t = Toggle(o.optimize_meshes)
        al.addLayout(form_row("Optimise mesh", self.opt_mesh_t,
                              "Lossless: welds identical points, stores normals/UVs once, "
                              "removes zero-area faces"))
        self.inst_t = Toggle(o.instancing)
        al.addLayout(form_row("Instancing", self.inst_t, "Identical objects are stored once"))
        self.hidden_t = Toggle(o.include_hidden)
        al.addLayout(form_row("Hidden objects", self.hidden_t, "Include objects hidden in 3ds Max"))
        self.pack_t = Toggle(o.textures.pack_opacity_in_base_alpha)
        al.addLayout(form_row("Opacity in alpha", self.pack_t, "Leaf mask in the base colour alpha (D5 cut-outs)"))
        self.gloss_t = Toggle(o.textures.convert_gloss_to_roughness)
        al.addLayout(form_row("Gloss → roughness", self.gloss_t, "Invert Corona/V-Ray glossiness maps exactly"))
        self.const_t = Toggle(o.textures.collapse_constant)
        al.addLayout(form_row("Flat maps → values", self.const_t, "Single-colour textures become material values"))
        self.ntarget = Segmented([("directx", "DirectX"), ("opengl", "OpenGL")], o.textures.normal_target)
        al.addLayout(form_row("Normal maps", self.ntarget, "D5 Render expects DirectX"))
        self.report_t = Toggle(o.write_reports)
        al.addLayout(form_row("Report file", self.report_t, "Also write an export report next to the model"))
        lay.addWidget(Collapsible("Advanced", adv))
        lay.addStretch(1)

        self.exp_summary = label("", "Faint")
        self.exp_go = QPushButton("Export")
        self.exp_go.setObjectName("PrimaryWide")
        self.exp_go.setToolTip("Ctrl+E")
        self.exp_go.clicked.connect(self.start_export)
        self.last_line = QPushButton("")
        self.last_line.setObjectName("Link")
        self.last_line.setCursor(Qt.PointingHandCursor)
        self.last_line.clicked.connect(lambda: self.show_text("Export report", self.last_report))
        self.last_line.hide()
        lay.addWidget(self.exp_summary)
        lay.addWidget(self.exp_go)
        lay.addWidget(self.last_line, 0, Qt.AlignLeft)
        self._fmt_changed(o.format)
        return self._scroll(w)

    def _fmt_changed(self, fmt: str) -> None:
        self.tex_seg.setEnabled(fmt == "fbx")
        self.tex_label.setEnabled(fmt == "fbx")
        if fmt == "obj":
            self.tex_seg.set_value("files")

    # ------------------------------------------------------------------ #
    # Settings
    # ------------------------------------------------------------------ #
    def _build_settings(self) -> QWidget:
        w = QWidget()
        col = QWidget()
        col.setMaximumWidth(620)
        col.setMinimumWidth(520)
        lay = QVBoxLayout(col)
        lay.setContentsMargins(24, 28, 24, 24)
        lay.setSpacing(12)
        lay.addWidget(label("Settings", "H1"))
        lay.addSpacing(6)

        lay.addWidget(label("3DS MAX", "Section2"))
        self.max_path = QLineEdit(self.settings.get("max_batch", ""))
        self.max_path.setPlaceholderText("3dsmaxbatch.exe  (auto-detect)")
        pick = tool("folder", "Choose 3dsmaxbatch.exe")
        pick.clicked.connect(self.pick_max_exe)
        self._settings_tools = [pick]
        lay.addLayout(hbox(self.max_path, pick, spacing=4))
        self.usemax_t = Toggle(self.settings.get("use_3dsmax", True))
        lay.addLayout(form_row("Use 3ds Max for .max files", self.usemax_t,
                               "Off: open .max files from the FBX/OBJ exports in their library (faster)"))
        self.bake_t = Toggle(self.settings.get("bake_procedural", True))
        lay.addLayout(form_row("Bake procedural maps", self.bake_t,
                               "Colour Correct, Mix, Falloff… rendered to images at full resolution"))
        self.proxy_t = Toggle(self.settings.get("convert_proxies", True))
        lay.addLayout(form_row("Convert proxies to mesh", self.proxy_t))
        self.cache_t = Toggle(self.settings.get("reuse_cache", True))
        lay.addLayout(form_row("Reuse previous conversion", self.cache_t,
                               "Reopening an unchanged .max file is instant"))

        lay.addSpacing(8)
        lay.addWidget(label("MEGASCANS", "Section2"))
        self.lod_seg = Segmented([(str(i), f"LOD{i}") for i in range(4)], str(self.settings.get("lod", 0)))
        lay.addLayout(form_row("Level of detail", self.lod_seg))
        self.ms_normal = Segmented([("opengl", "OpenGL"), ("directx", "DirectX")],
                                   self.settings.get("megascans_normals", "opengl"))
        lay.addLayout(form_row("Source normal maps", self.ms_normal))

        lay.addSpacing(8)
        lay.addWidget(label("PREVIEW", "Section2"))
        self.renderer_seg = Segmented([("directx", "DirectX 11"), ("opengl", "OpenGL")],
                                      self.settings.get("renderer", "directx"))
        lay.addLayout(form_row("Renderer", self.renderer_seg, "Applies after restart"))
        lay.addSpacing(12)
        save = QPushButton("Save")
        save.setObjectName("Primary")
        save.clicked.connect(self.save_prefs)
        lay.addLayout(hbox(None, save))
        lay.addStretch(1)
        lay.addWidget(label(f"D5 Bridge {__version__}", "Faint"))
        outer = QVBoxLayout(w)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addLayout(hbox(None, col, None))
        return self._scroll(w)

    # ------------------------------------------------------------------ #
    # theme / navigation
    # ------------------------------------------------------------------ #
    def apply_theme(self, p: Palette) -> None:
        self.palette_ = p
        QApplication.instance().setStyleSheet(qss(p))
        self._paint_icons()
        self.viewport.set_theme(p.viewport_top, p.viewport_bottom, p.accent, p.text_faint)
        for t in self.findChildren(Toggle):
            t.colors = (p.primary_bg, p.border_strong, p.primary_fg)
            t.update()
        if self.scene is not None:
            self.on_tree_selection()
        _dark_title_bar(self, p.name == "dark")

    def _paint_icons(self) -> None:
        p = self.palette_
        for b in self.rail.values():
            b.setIcon(make_icon(b.property("icon_name"), p.primary_fg if b.isChecked() else p.text_muted, 20))
        self.theme_btn.setIcon(make_icon("sun" if p.name == "dark" else "moon", p.text_muted, 20))
        self.help_btn.setIcon(make_icon("help", p.text_muted, 20))
        self.warn_btn.setIcon(make_icon("bell", p.text, 20))
        for b in self._view_tools + self._outliner_tools + self._export_tools + self._settings_tools:
            b.setIcon(make_icon(b.property("icon_name"), p.text, 18))
        self.filter_icon.setPixmap(make_icon("search", p.text_faint, 14).pixmap(14, 14))
        self.drop_icon.setPixmap(make_icon("tree", p.text_muted, 44).pixmap(44, 44))

    def toggle_theme(self) -> None:
        self.apply_theme(LIGHT if self.palette_.name == "dark" else DARK)
        self.settings["theme"] = self.palette_.name
        save_settings(self.settings)

    def go(self, key: str) -> None:
        if key == "work" and self.scene is None:
            key = "home"
        page = {"home": self.page_home, "work": self.page_work, "settings": self.page_settings}[key]
        self.stack.setCurrentWidget(page)
        self.rail[key].setChecked(True)
        self._paint_icons()
        if key == "home":
            self.refresh_recent()

    def set_status(self, msg: str, progress: float | None = None) -> None:
        self.status_msg.setText(msg)
        if progress is None:
            self.status_progress.hide()
        else:
            self.status_progress.show()
            self.status_progress.setValue(int(progress * 1000))

    # ------------------------------------------------------------------ #
    # opening
    # ------------------------------------------------------------------ #
    def open_file_dialog(self) -> None:
        start = self.settings.get("last_dir", str(Path.home()))
        path, _ = QFileDialog.getOpenFileName(self, "Open model", start,
                                              "Models (*.max *.fbx *.obj manifest.json)")
        if path:
            self.load(path)

    def open_folder_dialog(self) -> None:
        d = QFileDialog.getExistingDirectory(self, "Open folder", self.settings.get("last_dir", str(Path.home())))
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
            self.toast.show_message("Busy, try again in a moment")
            return
        p = Path(path)
        if p.is_file() and p.suffix.lower() not in SUPPORTED:
            self.toast.show_message(f"{p.suffix} is not supported")
            return
        self.settings["last_dir"] = str(p.parent if p.is_file() else p)
        self.settings["recent"] = ([str(p)] + [r for r in self.settings.get("recent", []) if r != str(p)])[:12]
        save_settings(self.settings)
        if self.settings.get("max_batch"):
            os.environ["D5B_3DSMAXBATCH"] = self.settings["max_batch"]
        max_opts = {"bake_procedural": self.settings.get("bake_procedural", True),
                    "convert_proxies": self.settings.get("convert_proxies", True),
                    "use_3dsmax": self.settings.get("use_3dsmax", True)}
        job = Job(_load_job, str(p), max_options=max_opts, lod=int(self.settings.get("lod", 0)))
        job.signals.log.connect(lambda s: self.status_msg.setText(s))
        job.signals.done.connect(lambda sc: self.on_loaded(sc, p))
        job.signals.failed.connect(self.on_failed)
        self.current_job = job
        self._t0 = time.time()
        self.open_btn.setEnabled(False)
        self.status_progress.setRange(0, 0)          # indeterminate while loading
        self.set_status(f"Opening {p.name}…", 0.0)
        self.pool.start(job)

    def on_failed(self, msg: str) -> None:
        self.current_job = None
        self.open_btn.setEnabled(True)
        self.cancel_btn.hide()
        self.status_progress.setRange(0, 1000)
        first = msg.strip().splitlines()[0] if msg.strip() else "Failed"
        self.set_status(first[:120])
        if self.scene is not None:
            self.sync_visible()
        if first != "Cancelled":
            self.toast.show_message(first[:110], "Details", lambda: self.show_text("Error", msg), ms=10000)

    def on_loaded(self, scene: Scene, path: Path) -> None:
        self.current_job = None
        self.open_btn.setEnabled(True)
        self.status_progress.setRange(0, 1000)
        if scene.source_kind == "megascans" and self.settings.get("megascans_normals", "opengl") == "directx":
            for m in scene.materials():
                m.normal_convention = "directx"
        self.scene = scene
        self.source = path
        name = path.stem if path.is_file() else path.name
        self.crumb2.setText(name)
        self.crumb_sep.show()
        self.asset_edit.setText(name)
        self.populate_tree()
        self.viewport.set_scene(scene)
        self.sync_visible()
        self.update_warnings()
        self.show_inspector(None)
        self.go("work")
        self.set_status(f"Opened in {time.time() - self._t0:.1f} s")

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
            vi = QTreeWidgetItem([v.name, _k(tris)])
            vi.setFlags(vi.flags() | Qt.ItemIsUserCheckable | Qt.ItemIsAutoTristate)
            vi.setCheckState(0, Qt.Checked)
            f = vi.font(0)
            f.setWeight(QFont.DemiBold)
            vi.setFont(0, f)
            vi.setData(0, Qt.UserRole, ("variant", v))
            self.tree.addTopLevelItem(vi)
            for n in v.mesh_nodes():
                it = QTreeWidgetItem([n.name, _k(n.mesh.num_triangles) if n.mesh else ""])
                it.setFlags(it.flags() | Qt.ItemIsUserCheckable)
                it.setCheckState(0, Qt.Checked)
                mats = ", ".join(dict.fromkeys(m.name for m in n.materials))
                hidden = n.tags.get("hidden_in_max") == "1"
                it.setToolTip(0, f"{n.path()}\n{mats}" + ("\nHidden in 3ds Max" if hidden else ""))
                if hidden:
                    it.setForeground(0, QColor(self.palette_.text_muted))
                it.setData(0, Qt.UserRole, ("node", n))
                vi.addChild(it)
                self.node_items[id(n)] = it
                self.item_nodes[id(it)] = n
            vi.setExpanded(len(sc.variants) <= 3)
        self.tree.blockSignals(False)
        self.obj_count.setText(str(len(self.node_items)))
        self.t_spread.setEnabled(len(sc.variants) > 1)

    def check_all(self, state: bool) -> None:
        self.tree.blockSignals(True)
        for i in range(self.tree.topLevelItemCount()):
            self.tree.topLevelItem(i).setCheckState(0, Qt.Checked if state else Qt.Unchecked)
        self.tree.blockSignals(False)
        self.sync_visible()
        if state:
            self.viewport.frame(all_nodes=True)

    def solo_variant(self, idx: int) -> None:
        self.tree.blockSignals(True)
        for i in range(self.tree.topLevelItemCount()):
            self.tree.topLevelItem(i).setCheckState(0, Qt.Checked if i == idx else Qt.Unchecked)
        self.tree.blockSignals(False)
        self.sync_visible()
        self.viewport.frame(all_nodes=True)

    def hide_selected(self) -> None:
        if self.stack.currentWidget() is not self.page_work or self.filter.hasFocus():
            return
        self.tree.blockSignals(True)
        for it in self.tree.selectedItems():
            it.setCheckState(0, Qt.Unchecked)
        self.tree.blockSignals(False)
        self.sync_visible()

    def checked_nodes(self) -> list[Node]:
        return [self.item_nodes[id(it)] for it in self.node_items.values() if it.checkState(0) == Qt.Checked]

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
        self.status_stats.setText(f"{len(nodes)} objects · {tris:,} tris")
        vs = self.checked_variants()
        mats = {id(m) for n in nodes for m in n.materials}
        self.exp_summary.setText(f"{len(vs)} variant{'s' if len(vs) != 1 else ''} · {len(nodes)} objects · "
                                 f"{len(mats)} materials")
        ok = bool(nodes) and self.current_job is None
        self.exp_go.setEnabled(ok)
        self.export_btn.setEnabled(ok)

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
            if t:
                vi.setExpanded(True)

    def on_tree_selection(self) -> None:
        nodes = []
        for it in self.tree.selectedItems():
            kind, obj = it.data(0, Qt.UserRole)
            nodes.extend([obj] if kind == "node" else obj.mesh_nodes())
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
        if node is not None:
            self.tabs.setCurrentIndex(0)

    def tree_menu(self, pos) -> None:
        it = self.tree.itemAt(pos)
        if it is None:
            return
        m = QMenu(self)
        kind, obj = it.data(0, Qt.UserRole)
        if kind == "variant":
            idx = self.tree.indexOfTopLevelItem(it)
            m.addAction("Show only this", lambda: self.solo_variant(idx))
            m.addAction("Rename…", lambda: self.rename_variant(it, obj))
        m.addAction("Frame", lambda: (self.on_tree_selection(), self.viewport.frame()))
        m.addAction("Hide  (H)", self.hide_selected)
        m.exec(self.tree.viewport().mapToGlobal(pos))

    def rename_variant(self, it: QTreeWidgetItem, v: Variant) -> None:
        name, ok = QInputDialog.getText(self, "Rename", "Name", text=v.name)
        if ok and name.strip():
            v.name = name.strip()
            it.setText(0, v.name)

    # ------------------------------------------------------------------ #
    # material inspector
    # ------------------------------------------------------------------ #
    def show_inspector(self, node: Node | None) -> None:
        _clear(self.mat_list)
        if node is None or node.mesh is None:
            self.insp_name.setText("Nothing selected")
            self.insp_info.setText("Click an object in the view")
            return
        m = node.mesh
        self.insp_name.setText(node.name)
        self.insp_info.setText(f"{m.num_triangles:,} tris · {len(m.uv_sets)} UV")
        self.insp_info.setToolTip(node.path())
        for mat in {id(x): x for x in node.materials}.values():
            self.mat_list.addWidget(self._material_block(mat))

    def _material_block(self, mat: Material) -> QWidget:
        p = self.palette_
        w = QWidget()
        lay = QVBoxLayout(w)
        lay.setContentsMargins(0, 8, 0, 0)
        lay.setSpacing(8)
        lay.addWidget(divider())
        title = label(_short(mat.name, 30), "H3")
        title.setToolTip(f"{mat.name}\n{mat.source_type}")
        lay.addWidget(title)
        grid = QGridLayout()
        grid.setHorizontalSpacing(8)
        grid.setVerticalSpacing(2)
        col = row = 0
        for ch, text in CHANNELS:
            ref = mat.maps.get(ch)
            if ref is None and ch not in CORE_CHANNELS:
                continue
            tile = QPushButton()
            tile.setObjectName("Tile")
            tile.setFixedSize(56, 56)
            tile.setCursor(Qt.PointingHandCursor)
            if ref is not None:
                pm = thumb(ref.path, 26)
                if pm is not None:
                    tile.setIcon(QIcon(pm))
                    tile.setIconSize(QSize(52, 52))
                else:
                    tile.setText("!")
                tile.setToolTip(f"{text}: {Path(ref.path).name}" + ("  (inverted)" if ref.invert else "")
                                + "\nClick to replace · right-click to remove")
            else:
                tile.setIcon(make_icon("plus", p.text_faint, 16))
                tile.setToolTip(f"Add {text.lower()} map")
            tile.clicked.connect(lambda _=False, c=ch, m=mat: self.replace_map(m, c))
            tile.setContextMenuPolicy(Qt.CustomContextMenu)
            tile.customContextMenuRequested.connect(lambda _p, c=ch, m=mat: self.remove_map(m, c))
            cap = label(text, "Faint")
            cap.setAlignment(Qt.AlignCenter)
            grid.addWidget(tile, row * 2, col, Qt.AlignCenter)
            grid.addWidget(cap, row * 2 + 1, col, Qt.AlignCenter)
            col += 1
            if col == 4:
                col, row = 0, row + 1
        lay.addLayout(grid)
        leaf = Toggle(mat.is_foliage or mat.two_sided)
        leaf.colors = (p.primary_bg, p.border_strong, p.primary_fg)
        leaf.toggled.connect(lambda on, m=mat: self.set_foliage(m, on))
        lay.addLayout(form_row("Two-sided leaf", leaf, "Foliage: two-sided with translucency in D5"))
        if "normal" in mat.maps:
            nseg = Segmented([("directx", "DirectX"), ("opengl", "OpenGL")], mat.normal_convention)
            nseg.changed.connect(lambda v, m=mat: self.set_normal(m, v))
            lay.addLayout(form_row("Normal map", nseg, "Switch if bumps look inverted"))
        if mat.notes:
            n = label("ⓘ  " + mat.notes[0], "Faint", wrap=True)
            n.setToolTip("\n".join(mat.notes))
            lay.addWidget(n)
        return w

    def replace_map(self, mat: Material, ch: str) -> None:
        cur = mat.maps.get(ch)
        start = str(Path(cur.path).parent) if cur else self.settings.get("last_dir", "")
        p, _ = QFileDialog.getOpenFileName(self, f"{ch.replace('_', ' ').title()} map", start,
                                           "Images (*.png *.jpg *.jpeg *.tif *.tiff *.tga *.bmp *.exr *.psd)")
        if not p:
            return
        mat.maps[ch] = TextureRef(p, uv_scale=cur.uv_scale if cur else (1, 1),
                                  uv_offset=cur.uv_offset if cur else (0, 0))
        if ch == "opacity":
            mat.is_foliage = mat.two_sided = True
        self.viewport.update()
        self.on_tree_selection()

    def remove_map(self, mat: Material, ch: str) -> None:
        if ch in mat.maps:
            del mat.maps[ch]
            self.viewport.update()
            self.on_tree_selection()

    def set_foliage(self, mat: Material, on: bool) -> None:
        mat.is_foliage = mat.two_sided = on
        self.viewport.update()

    def set_normal(self, mat: Material, conv: str) -> None:
        mat.normal_convention = conv
        self.viewport.update()

    # ------------------------------------------------------------------ #
    # viewport
    # ------------------------------------------------------------------ #
    def on_view_status(self, msg: str) -> None:
        if any(k in msg.lower() for k in ("fail", "error", "not available")):
            self.toast.show_message(msg, ms=10000)
        self.renderer_name = msg.replace("Preview: ", "")
        self.status_api.setText(self.renderer_name)

    def set_view_mode(self, mode: str) -> None:
        self.viewport.mode = mode
        self.viewport.update()

    def set_wire(self, on: bool) -> None:
        self.viewport.wire = on
        self.viewport.update()

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
        o.format = self.fmt_seg.value() or "fbx"
        o.embed_textures = self.tex_seg.value() == "embed" and o.format == "fbx"
        o.split_variants = self.split_seg.value() == "split"
        o.center_to_origin = self.center_t.isChecked()
        o.optimize_meshes = self.opt_mesh_t.isChecked()
        o.instancing = self.inst_t.isChecked()
        o.include_hidden = self.hidden_t.isChecked()
        o.write_reports = self.report_t.isChecked()
        o.textures.mode = self.quality_seg.value() or "lossless"
        o.textures.pack_opacity_in_base_alpha = self.pack_t.isChecked()
        o.textures.convert_gloss_to_roughness = self.gloss_t.isChecked()
        o.textures.collapse_constant = self.const_t.isChecked()
        o.textures.normal_target = self.ntarget.value()
        d = o.to_json()
        d["asset_name"] = ""
        self.settings["export"] = d
        save_settings(self.settings)
        return o

    def start_export(self) -> None:
        if self.scene is None or self.current_job is not None:
            return
        opts = self.collect_export_opts()
        if not opts.out_dir:
            self.tabs.setCurrentIndex(1)
            self.out_edit.setFocus()
            self.toast.show_message("Choose an output folder")
            return
        nodes = self.checked_nodes()
        if not nodes:
            self.toast.show_message("Tick at least one object")
            return
        job = Job(_export_job, self.scene, self.checked_variants(), {id(n) for n in nodes}, opts)
        job.signals.progress.connect(lambda m, f: self.set_status(m, f))
        job.signals.done.connect(self.on_exported)
        job.signals.failed.connect(self.on_failed)
        self.current_job = job
        self.exp_go.setEnabled(False)
        self.export_btn.setEnabled(False)
        self.cancel_btn.show()
        self.set_status("Exporting…", 0.0)
        self.pool.start(job)

    def on_exported(self, res) -> None:
        self.current_job = None
        self.cancel_btn.hide()
        self.sync_visible()
        self.last_out = res.out_dir
        self.last_report = res.report_text
        n = len(res.files)
        what = Path(res.files[0]).name if n == 1 else f"{n} files"
        self.set_status(f"Exported {what} · {fmt_bytes(res.bytes_output)} · {res.seconds:.1f} s")
        self.last_line.setText(f"Last export: {what}, {fmt_bytes(res.bytes_output)}  ›")
        self.last_line.show()
        self.toast.show_message(f"Exported {what}", "Show in folder", self.open_out_dir, ms=8000)

    def cancel_job(self) -> None:
        if self.current_job is not None:
            self.current_job.cancelled = True

    def pick_out_dir(self) -> None:
        d = QFileDialog.getExistingDirectory(self, "Output folder", self.out_edit.text())
        if d:
            self.out_edit.setText(d)

    def open_out_dir(self) -> None:
        p = self.last_out or self.out_edit.text()
        if p and os.path.isdir(p):
            _open_path(p)

    # ------------------------------------------------------------------ #
    # settings / 3ds Max
    # ------------------------------------------------------------------ #
    def refresh_max_status(self) -> None:
        from ..max.bridge import find_max_installs
        if self.settings.get("max_batch"):
            os.environ["D5B_3DSMAXBATCH"] = self.settings["max_batch"]
        installs = find_max_installs()
        if installs:
            self.max_dot.setStyleSheet(f"color:{self.palette_.success}")
            self.max_text.setText(installs[0].label)
            self.max_text.setToolTip("Used to open .max files")
        else:
            self.max_dot.setStyleSheet(f"color:{self.palette_.text_faint}")
            self.max_text.setText("No 3ds Max")
            self.max_text.setToolTip(".max files open from their library's FBX/OBJ exports")

    def pick_max_exe(self) -> None:
        p, _ = QFileDialog.getOpenFileName(self, "3dsmaxbatch.exe", r"C:\Program Files\Autodesk",
                                           "3dsmaxbatch.exe (3dsmaxbatch.exe)")
        if p:
            self.max_path.setText(p)

    def save_prefs(self) -> None:
        s = self.settings
        s["max_batch"] = self.max_path.text().strip()
        s["use_3dsmax"] = self.usemax_t.isChecked()
        s["bake_procedural"] = self.bake_t.isChecked()
        s["convert_proxies"] = self.proxy_t.isChecked()
        s["reuse_cache"] = self.cache_t.isChecked()
        s["lod"] = int(self.lod_seg.value() or 0)
        s["megascans_normals"] = self.ms_normal.value()
        s["renderer"] = self.renderer_seg.value()
        save_settings(s)
        self.refresh_max_status()
        self.toast.show_message("Saved")

    # ------------------------------------------------------------------ #
    # dialogs
    # ------------------------------------------------------------------ #
    def update_warnings(self) -> None:
        n = len(self.scene.warnings) if self.scene else 0
        self.warn_badge.setText(str(n))
        self.warn_badge.adjustSize()
        self.warn_badge.setVisible(n > 0)

    def show_warnings(self) -> None:
        if not self.scene or not self.scene.warnings:
            self.toast.show_message("No warnings")
            return
        self.show_text("Warnings", "\n\n".join(self.scene.warnings))

    def show_shortcuts(self) -> None:
        rows = [("Ctrl+O", "Open"), ("Ctrl+E", "Export"), ("Ctrl+F", "Filter objects"),
                ("Click / Ctrl+click", "Select / add to selection"), ("H", "Hide selected"),
                ("Alt+H", "Show all"), ("F", "Frame selection"), ("A", "Frame all"),
                ("Left drag", "Orbit"), ("Middle or Shift drag", "Pan"), ("Wheel", "Zoom")]
        self.show_text("Keyboard shortcuts", "\n".join(f"{k:<24}{v}" for k, v in rows))

    def show_text(self, title: str, text: str) -> None:
        dlg = QDialog(self)
        dlg.setWindowTitle(title)
        dlg.resize(640, 420)
        lay = QVBoxLayout(dlg)
        lay.setContentsMargins(16, 16, 16, 16)
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


# =========================================================================== #
def _clear(lay) -> None:
    while lay.count():
        it = lay.takeAt(0)
        if it.widget():
            it.widget().deleteLater()
        elif it.layout():
            _clear(it.layout())


def _k(n: int) -> str:
    return f"{n / 1e6:.1f}M" if n >= 1e6 else (f"{n / 1e3:.1f}k" if n >= 1e4 else str(n))


def _short(s: str, n: int) -> str:
    return s if len(s) <= n else "…" + s[-(n - 1):]


def _ago(p: Path) -> str:
    try:
        d = time.time() - p.stat().st_mtime
    except OSError:
        return ""
    for sec, unit in ((86400 * 30, "mo"), (86400, "d"), (3600, "h"), (60, "min")):
        if d >= sec:
            return f"{int(d // sec)} {unit}"
    return "now"


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
    w._instance_server = _listen_for_instances(w)
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


def _listen_for_instances(w: MainWindow):
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
