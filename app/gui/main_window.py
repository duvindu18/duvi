"""Main window: navigation rail + stacked pages on the ember backdrop."""

from __future__ import annotations

import logging

from PySide6.QtCore import QByteArray, QRectF, QSize, Qt
from PySide6.QtGui import QCloseEvent, QColor, QKeySequence, QPainter, QShortcut
from PySide6.QtWidgets import QButtonGroup, QHBoxLayout, QMainWindow, QStackedWidget, QVBoxLayout, QWidget

from app import __app_name__, __version__
from app.gui.bridge import PipelineController, RunState
from app.gui.context import AppContext
from app.gui.icons import app_icon, draw_logo
from app.gui.pages.export_page import ExportPage
from app.gui.pages.identities_page import IdentitiesPage
from app.gui.pages.live_page import LivePage
from app.gui.pages.settings_page import SettingsPage
from app.gui.theme import P
from app.gui.widgets import Banner, EmberBackground, NavButton, label
from app.gui.winstyle import style_window

log = logging.getLogger(__name__)


class Logo(QWidget):
    def __init__(self) -> None:
        super().__init__()
        self.setFixedSize(52, 52)
        self.setToolTip(f"{__app_name__} {__version__}")

    def paintEvent(self, _e) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        draw_logo(p, QRectF(8, 8, 36, 36), QColor("white"))


class NavRail(QWidget):
    """Vertical glass rail; the reference's bottom tab bar adapted for desktop."""

    WIDTH = 92
    INSET_X = 12
    INSET_Y = 12

    def __init__(self) -> None:
        super().__init__()
        self.setFixedWidth(self.WIDTH)
        lay = QVBoxLayout(self)
        # The rail is a capsule; its rounded ends are half circles of radius
        # (WIDTH - 2*INSET_X) / 2. Logo and version sit at those circles' centres.
        radius = (self.WIDTH - 2 * self.INSET_X) / 2
        end_center = self.INSET_Y + radius
        lay.setContentsMargins(0, int(end_center - 26), 0, int(end_center - 9))
        lay.setSpacing(14)
        lay.addWidget(Logo(), 0, Qt.AlignmentFlag.AlignHCenter)
        lay.addSpacing(30)
        self.group = QButtonGroup(self)
        self.group.setExclusive(True)
        self.buttons: list[NavButton] = []
        for i, (icon, text) in enumerate(
            (("shield", "Live  (Ctrl+1)"), ("faces", "Identities  (Ctrl+2)"), ("export", "Export  (Ctrl+3)"), ("settings", "Settings  (Ctrl+4)"))
        ):
            b = NavButton(icon, text)
            self.group.addButton(b, i)
            self.buttons.append(b)
            lay.addWidget(b, 0, Qt.AlignmentFlag.AlignHCenter)
        lay.addStretch(1)
        self.version = label(f"v{__version__}", "faint")
        self.version.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.version.setFixedHeight(18)
        lay.addWidget(self.version, 0, Qt.AlignmentFlag.AlignHCenter)

    def paintEvent(self, _e) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = QRectF(self.rect()).adjusted(self.INSET_X, self.INSET_Y, -self.INSET_X, -self.INSET_Y)
        p.setPen(QColor(255, 255, 255, 36))
        p.setBrush(QColor(20, 5, 3, 70))
        p.drawRoundedRect(r, r.width() / 2, r.width() / 2)


class MainWindow(QMainWindow):
    def __init__(self, ctx: AppContext) -> None:
        super().__init__()
        self.ctx = ctx
        self.setWindowTitle(__app_name__)
        self.setWindowIcon(app_icon())
        self.setMinimumSize(QSize(960, 640))

        self.live_ctrl = PipelineController(ctx.face_db, display=True, parent=self)
        self.export_ctrl = PipelineController(ctx.face_db, display=False, parent=self)

        bg = EmberBackground()
        self.setCentralWidget(bg)
        row = QHBoxLayout(bg)
        row.setContentsMargins(0, 0, 0, 0)
        row.setSpacing(0)
        self.rail = NavRail()
        row.addWidget(self.rail)
        self.pages = QStackedWidget()
        row.addWidget(self.pages, 1)

        self.live = LivePage(ctx, self.live_ctrl)
        self.identities = IdentitiesPage(ctx, self.live_ctrl)
        self.export = ExportPage(ctx, self.export_ctrl)
        self.settings = SettingsPage(ctx)
        for page in (self.live, self.identities, self.export, self.settings):
            self.pages.addWidget(page)

        self.banner = Banner(bg)
        self.rail.group.idClicked.connect(self.pages.setCurrentIndex)
        self.rail.buttons[0].setChecked(True)
        self.live.manageIdentities.connect(lambda: self.go(1))

        ctx.notify.connect(self.banner.show_message)
        ctx.configChanged.connect(self._push_config)
        ctx.facesChanged.connect(self._faces_changed)
        for ctrl in (self.live_ctrl, self.export_ctrl):
            ctrl.warning.connect(lambda m: self.banner.show_message(m, "warn", 8000))
            ctrl.error.connect(lambda m: self.banner.show_message(m, "error", 0))

        self._shortcuts()
        self._restore_geometry()

    # ------------------------------------------------------------------
    def go(self, index: int) -> None:
        self.rail.buttons[index].setChecked(True)
        self.pages.setCurrentIndex(index)

    def _shortcuts(self) -> None:
        for i in range(4):
            QShortcut(QKeySequence(f"Ctrl+{i + 1}"), self, activated=lambda i=i: self.go(i))
        QShortcut(QKeySequence(Qt.Key.Key_Space), self, activated=self._space)
        QShortcut(QKeySequence(Qt.Key.Key_Escape), self, activated=self.live_ctrl.stop)
        QShortcut(QKeySequence("Ctrl+S"), self, activated=self.live._on_snapshot)
        QShortcut(QKeySequence("Ctrl+R"), self, activated=self.live.stage.record_btn.toggle)
        QShortcut(QKeySequence(Qt.Key.Key_F11), self, activated=self._toggle_fullscreen)

    def _space(self) -> None:
        if self.pages.currentWidget() is self.live:
            self.live.toggle_play()

    def _toggle_fullscreen(self) -> None:
        self.showNormal() if self.isFullScreen() else self.showFullScreen()

    def _push_config(self) -> None:
        self.live_ctrl.update_config(self.ctx.cfg)

    def _faces_changed(self) -> None:
        self.live_ctrl.face_db = self.ctx.face_db
        self.export_ctrl.face_db = self.ctx.face_db

    def _restore_geometry(self) -> None:
        geo = self.ctx.cfg.window_geometry
        if geo:
            try:
                if self.restoreGeometry(QByteArray.fromBase64(geo.encode("ascii"))):
                    return
            except Exception:
                pass
        screen = self.screen().availableGeometry() if self.screen() else None
        if screen is not None:
            w = min(1480, int(screen.width() * 0.9))
            h = min(940, int(screen.height() * 0.9))
            self.resize(w, h)
            self.move(screen.center().x() - w // 2, screen.center().y() - h // 2)
        else:
            self.resize(1440, 900)

    # ------------------------------------------------------------------
    def showEvent(self, e) -> None:  # noqa: N802
        super().showEvent(e)
        style_window(int(self.winId()), caption=P.ember_lo)

    def resizeEvent(self, e) -> None:  # noqa: N802
        super().resizeEvent(e)
        if self.banner.isVisible():
            self.banner.reposition()

    def closeEvent(self, e: QCloseEvent) -> None:  # noqa: N802
        busy = [c for c in (self.live_ctrl, self.export_ctrl) if c.state != RunState.IDLE]
        for c in busy:
            c.stop()
        # Give writers a moment to finalise their containers so files stay playable.
        for c in busy:
            if c.pipeline is not None:
                c.pipeline.wait(8.0)
        self.live.shutdown()  # stops the phone receiver (MediaMTX)
        self.ctx.cfg.window_geometry = bytes(self.saveGeometry().toBase64()).decode("ascii")
        self.ctx.save_now()
        super().closeEvent(e)
