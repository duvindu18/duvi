"""GUI bootstrap."""

from __future__ import annotations

import getpass
import logging
import sys
import traceback

from PySide6.QtCore import Qt
from PySide6.QtGui import QGuiApplication
from PySide6.QtNetwork import QLocalServer, QLocalSocket
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


def _instance_name() -> str:
    try:
        user = getpass.getuser()
    except Exception:
        user = "user"
    return f"VeilSingleInstance-{user}"


def _signal_running_instance(name: str) -> bool:
    """True if another Veil is running; it is asked to come to the front."""
    sock = QLocalSocket()
    sock.connectToServer(name)
    if not sock.waitForConnected(400):
        return False
    if sys.platform == "win32":  # let the running instance take the foreground
        try:
            import ctypes

            ctypes.windll.user32.AllowSetForegroundWindow(-1)  # ASFW_ANY
        except Exception:
            pass
    sock.write(b"show")
    sock.flush()
    sock.waitForBytesWritten(400)
    sock.disconnectFromServer()
    return True


def _windows_mutex(name: str):
    """Named mutex: catches a second launch made before the first one is listening."""
    if sys.platform != "win32":
        return None, False
    import ctypes

    handle = ctypes.windll.kernel32.CreateMutexW(None, False, f"Local\\{name}")
    return handle, ctypes.windll.kernel32.GetLastError() == 183  # ERROR_ALREADY_EXISTS


def _bring_to_front(window) -> None:
    if window.isMinimized():
        window.showNormal()
    window.show()
    window.raise_()
    window.activateWindow()


def run_gui(argv: list[str] | None = None) -> int:
    set_app_user_model_id()
    QGuiApplication.setHighDpiScaleFactorRoundingPolicy(Qt.HighDpiScaleFactorRoundingPolicy.PassThrough)
    app = QApplication(argv if argv is not None else sys.argv)
    name = _instance_name()
    mutex, already = _windows_mutex(name)
    if _signal_running_instance(name) or already:
        # Wait briefly for the first instance's listener, then hand over and leave.
        import time

        for _ in range(20):
            if _signal_running_instance(name):
                break
            time.sleep(0.25)
        return 0
    server = QLocalServer()
    QLocalServer.removeServer(name)  # stale socket after a crash
    server.listen(name)
    app.setApplicationName(__app_name__)
    app.setOrganizationName(__app_name__)
    app.setWindowIcon(app_icon())
    apply_theme(app)
    _install_excepthook()

    ctx = AppContext(AppConfig.load())
    window = MainWindow(ctx)
    window.show()

    def on_connection() -> None:
        sock = server.nextPendingConnection()
        if sock is not None:
            sock.readyRead.connect(sock.readAll)
            sock.disconnected.connect(sock.deleteLater)
        _bring_to_front(window)

    server.newConnection.connect(on_connection)
    app._veil_instance = (server, mutex)  # keep alive for the whole session
    return app.exec()
