"""Offscreen GUI smoke test: builds every page and runs a short file preview."""

import os
from pathlib import Path

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
QtWidgets = pytest.importorskip("PySide6.QtWidgets")

from tests.conftest import FakeEngine  # noqa: E402
from tests.test_pipeline import make_video  # noqa: E402


@pytest.fixture(scope="module")
def qapp():
    from app.gui.theme import apply_theme

    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    apply_theme(app)
    return app


def _spin(app, predicate, timeout=15.0):
    import time

    end = time.time() + timeout
    while time.time() < end and not predicate():
        app.processEvents()
        time.sleep(0.01)
    return predicate()


def test_window_runs_preview(qapp, tmp_path, monkeypatch):
    import app.core.pipeline as pl
    from app.core.config import AppConfig
    from app.gui.bridge import RunState
    from app.gui.context import AppContext
    from app.gui.main_window import MainWindow

    monkeypatch.setattr(pl, "FaceEngine", lambda cfg, on_warning=None: FakeEngine())
    video = tmp_path / "in.avi"
    make_video(video)
    cfg = AppConfig()
    cfg.recognition.faces_dir = str(tmp_path / "faces")
    cfg.last_source_kind, cfg.last_source_value = "file", str(video)
    win = MainWindow(AppContext(cfg))
    for size in ((1480, 920), (980, 660)):  # wide and narrow (drawer) layouts
        win.resize(*size)
        win.show()
        qapp.processEvents()
    for i in range(4):
        win.go(i)
        qapp.processEvents()
    win.go(0)
    win.live.toggle_play()
    assert _spin(qapp, lambda: win.live.stage.view.has_image)
    win.live_ctrl.stop()
    assert _spin(qapp, lambda: win.live_ctrl.state == RunState.IDLE)
    win.close()
