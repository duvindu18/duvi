"""GUI bootstrap."""

from __future__ import annotations

import logging
import sys
import traceback

from PySide6.QtCore import Qt
from PySide6.QtGui import QGuiApplication
from PySide6.QtWidgets import QApplication, QMessageBox

from app import __app_name__
from app.core.config import AppConfig
from app.gui.context import AppContext
from app.gui.icons import app_icon
from app.gui.main_window import MainWindow
from app.gui.theme import apply_theme
from app.gui.winstyle import set_app_user_model_id

log = logging.getLogger(__name__)


def _install_excepthook() -> None:
    """Show unexpected GUI-thread exceptions instead of silently killing Qt."""

    def hook(exc_type, exc, tb) -> None:
        text = "".join(traceback.format_exception(exc_type, exc, tb))
        log.critical("Unhandled exception:\n%s", text)
        app = QApplication.instance()
        if app is not None:
            QMessageBox.critical(None, f"{__app_name__} error", f"{exc}\n\nDetails were written to the log file.")

    sys.excepthook = hook


def run_gui(argv: list[str] | None = None) -> int:
    set_app_user_model_id()
    QGuiApplication.setHighDpiScaleFactorRoundingPolicy(Qt.HighDpiScaleFactorRoundingPolicy.PassThrough)
    app = QApplication(argv if argv is not None else sys.argv)
    app.setApplicationName(__app_name__)
    app.setOrganizationName(__app_name__)
    app.setWindowIcon(app_icon())
    apply_theme(app)
    _install_excepthook()

    ctx = AppContext(AppConfig.load())
    window = MainWindow(ctx)
    window.show()
    return app.exec()
