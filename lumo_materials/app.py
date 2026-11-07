"""Program entry point: single instance, logging, theme, first start."""
from __future__ import annotations

import datetime as dt
import getpass
import json
import os
import sys
import traceback
from pathlib import Path

from . import APP_ID, APP_NAME, __version__


def _setup_logging() -> Path:
    from .library.settings import data_dir
    logs = data_dir().parent / "logs" if sys.platform == "win32" else data_dir() / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    log = logs / "lumo-materials.log"
    try:
        if log.exists() and log.stat().st_size > 2_000_000:
            log.replace(log.with_suffix(".old.log"))
    except OSError:
        pass
    # A windowed .exe has no console: sys.stdout / sys.stderr are None.
    if sys.stdout is None or sys.stderr is None or getattr(sys, "frozen", False):
        f = open(log, "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr = f
    print(f"--- {APP_NAME} {__version__} started {dt.datetime.now().isoformat(timespec='seconds')}")
    return log


def self_check() -> int:
    """Headless check used by the installer and CI: engine + library round trip, no window."""
    import tempfile

    import numpy as np

    from .engine import maps, render
    from .engine.presets import for_preset
    from .library.store import prepare_folder

    rng = np.random.default_rng(0)
    src = rng.random((96, 96, 3)).astype(np.float32)
    m = maps.generate(src, for_preset("brick"))
    render.sphere(m, size=48)
    with tempfile.TemporaryDirectory() as d:
        lib = prepare_folder(Path(d) / "lib")
        mat = lib.create(m, "Self check", "Walls")
        lib.load_maps(mat.id)
    print(f"{APP_NAME} {__version__}: OK")
    return 0


def _excepthook(exc_type, exc, tb):
    text = "".join(traceback.format_exception(exc_type, exc, tb))
    print(text, file=sys.stderr)
    try:
        from PySide6.QtWidgets import QApplication
        app = QApplication.instance()
        win = getattr(app, "main_window", None) if app else None
        if win is not None:
            win.hub.error(f"Unexpected error: {exc}. Details are in the log.")
    except Exception:
        pass


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv if argv is None else argv)
    if "--version" in argv:
        print(f"{APP_NAME} {__version__}")
        return 0
    if "--check" in argv:
        _setup_logging()
        try:
            return self_check()
        except Exception:
            traceback.print_exc()
            return 1

    if "--smoke-ui" in argv:
        _setup_logging()
        i = argv.index("--smoke-ui")
        target = argv[i + 1] if i + 1 < len(argv) and not argv[i + 1].startswith("--") else "smoke-ui"
        from .ui.smoke import run
        return run(target)

    _setup_logging()
    sys.excepthook = _excepthook

    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("lumo.materials")
        except Exception:
            pass

    from PySide6.QtCore import QByteArray, Qt, QTimer
    from PySide6.QtGui import QGuiApplication, QIcon
    from PySide6.QtNetwork import QLocalServer, QLocalSocket
    from PySide6.QtWidgets import QApplication

    from .ui import theme
    from .ui.hub import Hub
    from .ui.main_window import MainWindow
    from .library.settings import Settings
    from .ui.viewer import configure_default_format, configure_opengl

    files = [a for a in argv[1:] if not a.startswith("--") and os.path.isfile(a)]

    # ---- single instance: hand our files to the running window and quit
    key = f"{APP_ID}-{getpass.getuser()}".replace(" ", "_")
    probe = QLocalSocket()
    probe.connectToServer(key)
    if probe.waitForConnected(300):
        probe.write(QByteArray(json.dumps({"files": files}).encode()))
        probe.flush()
        probe.waitForBytesWritten(1000)
        probe.disconnectFromServer()
        return 0

    QGuiApplication.setHighDpiScaleFactorRoundingPolicy(Qt.HighDpiScaleFactorRoundingPolicy.PassThrough)
    configure_opengl(Settings().get("opengl"))
    configure_default_format()
    app = QApplication(argv)
    app.setApplicationName(APP_NAME)
    app.setApplicationVersion(__version__)
    app.setOrganizationName("lumo")
    icon_file = theme.asset_dir() / "icons" / ("app.ico" if sys.platform == "win32" else "app.png")
    if icon_file.exists():
        app.setWindowIcon(QIcon(str(icon_file)))
    theme.apply(app)

    hub = Hub()
    hub.try_open_saved()
    win = MainWindow(hub)
    app.main_window = win   # for the exception hook

    server = QLocalServer()
    QLocalServer.removeServer(key)
    server.listen(key)

    def on_connection():
        sock = server.nextPendingConnection()
        if sock is None:
            return

        def read():
            try:
                data = json.loads(bytes(sock.readAll()).decode() or "{}")
            except ValueError:
                data = {}
            win.activate()
            if data.get("files"):
                win.open_files(data["files"])

        sock.readyRead.connect(read)
        sock.disconnected.connect(sock.deleteLater)
        QTimer.singleShot(600, win.activate)

    server.newConnection.connect(on_connection)

    win.show()
    if not hub.library:
        QTimer.singleShot(250, win.choose_library_first)
    if files:
        QTimer.singleShot(400, lambda: win.open_files(files))
    code = app.exec()
    server.close()
    return code


if __name__ == "__main__":
    sys.exit(main())
