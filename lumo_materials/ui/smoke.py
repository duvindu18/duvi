"""UI smoke test: drives the real window through every page with sample content and saves screenshots.

    lumo-materials.exe --smoke-ui <output folder>      (also: python -m lumo_materials --smoke-ui out)

Exit code 0 = no exception and no Qt critical message; report.json + PNG screenshots in the output folder.
Runs in a throw-away library and data folder, never in the user's.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import traceback
from pathlib import Path


def run(outdir: str) -> int:
    out = Path(outdir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="lumo-smoke-"))
    os.environ["LUMO_MATERIALS_DATA"] = str(tmp / "data")
    os.environ.pop("LUMO_LIBRARY_DIR", None)

    from ..library.store import prepare_folder
    from .. import samples

    t0 = time.perf_counter()
    lib_dir = tmp / "library"
    lib = prepare_folder(lib_dir)
    sample_ids = samples.fill_library(lib, size=256)
    photo = samples.write_photo(tmp / "inputs" / "Old_Red_Brick_Wall_2K.jpg", seed=42)
    map_files = samples.write_map_set(tmp / "inputs" / "set", "Granite")
    prep_s = time.perf_counter() - t0

    from PySide6.QtCore import QEvent, QtMsgType, QTimer, qInstallMessageHandler
    from PySide6.QtWidgets import QApplication

    from . import theme
    from .dialogs import ExportDialog, LibraryChooser
    from .hub import Hub
    from .main_window import MainWindow
    from .viewer import MaterialView, configure_default_format, configure_renderer

    report = {"errors": [], "qt_warnings": [], "steps": [], "screenshots": [], "prepare_s": round(prep_s, 2)}

    def hook(t, v, tb):
        report["errors"].append("".join(traceback.format_exception(t, v, tb)))
        print(report["errors"][-1], file=sys.stderr)

    sys.excepthook = hook

    def qt_messages(mode, ctx, msg):
        if mode in (QtMsgType.QtCriticalMsg, QtMsgType.QtFatalMsg):
            report["errors"].append(f"Qt: {msg}")
        elif mode == QtMsgType.QtWarningMsg:
            report["qt_warnings"].append(msg)
        print(f"[qt] {msg}", file=sys.stderr)

    qInstallMessageHandler(qt_messages)
    report["renderer_chain"] = configure_renderer("auto")
    configure_default_format()
    app = QApplication.instance() or QApplication(sys.argv[:1])
    theme.apply(app)
    hub = Hub()
    lib = hub.open_library(lib_dir, remember=False)      # count through the app's own library object
    win = MainWindow(hub)
    app.main_window = win
    win.resize(1600, 1000)
    win.show()

    def shot(name: str, widget=None) -> None:
        w = widget or win
        path = out / f"{len(report['screenshots']) + 1:02d}-{name}.png"
        w.grab().save(str(path))
        report["screenshots"].append(path.name)

    def wait_idle(pred, timeout=20.0):
        end = time.perf_counter() + timeout
        while time.perf_counter() < end:
            app.processEvents()
            if pred():
                return True
            time.sleep(0.02)
        return False

    def step(name, fn):
        s = time.perf_counter()
        try:
            fn()
            report["steps"].append({"step": name, "ok": True, "s": round(time.perf_counter() - s, 2)})
        except Exception:
            report["errors"].append(f"{name}: {traceback.format_exc()}")
            report["steps"].append({"step": name, "ok": False})

    def settle(ms=600):
        end = time.perf_counter() + ms / 1000
        while time.perf_counter() < end:
            app.processEvents()
            app.sendPostedEvents(None, QEvent.Type.DeferredDelete)   # as the event loop would
            time.sleep(0.01)

    def scenario():
        from .splash import Splash
        sp = Splash()
        sp.start()
        sp.set_status("Opening your library…")
        settle(500)
        shot("splash", sp)
        sp.close()
        settle(1200)
        report["window"] = [win.width(), win.height()]
        step("library", lambda: shot("library"))

        def select_first():
            win.library.grid.setCurrentIndex(win.library.model.index(0))
            settle(300)
            wait_idle(lambda: not hub.runner.busy("inspector"))
            settle(1500)
            shot("library-inspector")
            card = win.inspector.card
            for shape in ("sphere", "plane", "both"):
                card.shape.setValue(shape)              # the switch, as a click would leave it
                card.view.set_option("shape", shape)
                settle(700)
                shot(f"viewer-{shape}", card)
            card.shape.setValue("sphere")
            card.view.set_option("shape", "sphere")
        step("inspector", select_first)

        def switching():
            card = win.inspector.card
            times = []
            for i in (3, 4, 5, 3, 4):              # three new materials, then two seen before (cached)
                win.library.grid.setCurrentIndex(win.library.model.index(i))
                t = time.perf_counter()
                if i == 5:
                    app.processEvents()
                    shot("inspector-loading", card)          # the skeleton / thumbnail while loading
                wait_idle(lambda: not card.placeholder.isVisible(), 20)
                times.append(round((time.perf_counter() - t) * 1000))
                settle(150)
            report["switch_ms"] = {"first_view": times[:3], "cached": times[3:]}
        step("switch materials", switching)

        def card_sizes():
            for px in (160, 320):
                win.library.size_slider.setValue(px)
                win.library._card_size(px)
                settle(500)
                shot(f"grid-{px}")
            win.library._card_size(210)
            win.library.size_slider.setValue(210)
        step("card sizes", card_sizes)

        def list_mode():
            win.library.view_toggle.setValue("list")
            win.library._view_mode("list")
            settle(400)
            shot("library-list")
            win.library._view_mode("grid")
            win.library.view_toggle.setValue("grid")
        step("list view", list_mode)

        def search_and_select():
            win.library.search.edit.setText("brick")
            settle(500)
            assert win.library.model.rowCount() >= 1, "search found nothing"
            win.library.clear_filters()
            win.library._toggle_check(sample_ids[1])
            win.library._toggle_check(sample_ids[2])
            settle(200)
            shot("library-multiselect")
            win.library.clear_checked()
        step("search + multi-select", search_and_select)

        def editor_photo():
            win.open_files([str(photo)])
            assert win.pages.currentWidget() is win.editor, "editor did not open"
            wait_idle(lambda: win.editor.last is not None, 30)
            settle(900)
            shot("editor-photo")
            win.editor.save()
            wait_idle(lambda: not win.editor.saving and win.pages.currentWidget() is win.library, 60)
            assert lib.count() == len(sample_ids) + 1, "photo material was not saved"
            settle(600)
            shot("after-save-photo")
        step("new from photo + save", editor_photo)

        def editor_import():
            win.editor.start_import([str(p) for p in map_files])
            win.show_page("editor")
            wait_idle(lambda: win.editor.last is not None, 30)
            settle(900)
            roles = sorted(a.role for a in win.editor.assignments)
            assert roles == ["albedo", "height", "normal", "roughness"], roles
            shot("editor-import")
            win.editor.save()
            wait_idle(lambda: not win.editor.saving and win.pages.currentWidget() is win.library, 60)
            assert lib.count() == len(sample_ids) + 2, "imported material was not saved"
        step("import map set + save", editor_import)

        def editor_adjust():
            win._open_editor("adjust", sample_ids[0])
            wait_idle(lambda: win.editor.last is not None, 30)
            win.editor.adjust_widgets[("albedo", "exposure")].setValue(0.8, emit=True)
            settle(500)
            wait_idle(lambda: not hub.runner.busy("editor-preview"))
            settle(500)
            shot("editor-adjust")
            win.editor.save_mode.setValue("copy")
            win.editor._save_mode_changed("copy")
            win.editor.save()
            wait_idle(lambda: not win.editor.saving and win.pages.currentWidget() is win.library, 60)
            assert lib.count() == len(sample_ids) + 3, "adjusted copy was not saved"
        step("adjust + save copy", editor_adjust)

        def draft_roundtrip():
            win.editor.start_photo(str(photo))
            win.show_page("editor")
            wait_idle(lambda: win.editor.last is not None, 30)
            win.editor._keep_draft()            # what "Keep as draft" does
            win.editor.dirty = False
            win.editor.draft = None
            win.editor.closed.emit(None)
            assert len(hub.drafts.list()) == 1, "draft not kept"
            win._section("drafts")
            settle(300)
            shot("drafts")
        step("draft", draft_roundtrip)

        def trash_and_pages():
            win._bulk("trash", [sample_ids[5]])
            win._section("trash")
            settle(300)
            shot("trash")
            win._undo_trash([sample_ids[5]])
            assert sample_ids[5] in {m.id for m in lib.all()}, "undo trash failed"
            win._section("settings")
            settle(300)
            shot("settings")
            win._section("library")
        step("trash + settings", trash_and_pages)

        def dialogs():
            d = ExportDialog(win, hub, sample_ids[:2])
            d.show()
            settle(300)
            shot("dialog-export", d)
            d.reject()
            c = LibraryChooser(win, hub)
            c.show()
            settle(300)
            shot("dialog-library", c)
            c.reject()
        step("dialogs", dialogs)

        def window_states():
            win.showMaximized()
            settle(600)
            win.caption.sync()
            shot("maximized")
            win.showNormal()
            settle(400)
            win.resize(1000, 700)
            settle(400)
            shot("narrow")
            win.resize(1600, 1000)
        step("window states", window_states)

        report["gpu_note"] = hub.gpu_note
        report["renderer"] = MaterialView.backend
        report["device"] = MaterialView.device_info
        report["gl_info"] = MaterialView.gl_info
        report["gpu_viewer_used"] = MaterialView.backend in ("d3d12", "d3d11", "opengl")
        report["materials"] = lib.count()
        report["seconds"] = round(time.perf_counter() - t0, 1)
        report["ok"] = not report["errors"]
        (out / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        hub.runner.wait(5000)
        app.exit(0 if report["ok"] else 1)

    watchdog = QTimer()
    watchdog.setSingleShot(True)
    watchdog.timeout.connect(lambda: (report["errors"].append("watchdog: smoke test took longer than 6 minutes"),
                                      (out / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8"),
                                      app.exit(2)))
    watchdog.start(360_000)
    QTimer.singleShot(0, scenario)
    code = app.exec()
    print(json.dumps({k: v for k, v in report.items() if k != "qt_warnings"}, indent=2))
    return code
