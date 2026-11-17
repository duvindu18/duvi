"""Saver end-to-end against a simulated desktop (no Windows needed)."""
import os
from dataclasses import dataclass, replace

import pytest

from autosave import keys
from autosave.config import AppProfile, Config, General
from autosave.saver import Saver, summarize

CTRL_S = keys.parse("ctrl+s")


@dataclass(frozen=True)
class W:
    hwnd: int
    title: str
    pid: int
    owned: bool = False
    enabled: bool = True
    cls: str = ""


class FakeDesktop:
    def __init__(self, windows, exes, files, on_save):
        self.windows = {w.hwnd: w for w in windows}
        self.exes, self.files, self.on_save = exes, files, on_save
        self.fg = 999
        self.pressed = []

    def list_windows(self):
        return list(self.windows.values())

    def exists(self, h):
        return h in self.windows or h == 999

    def is_hung(self, h):
        return False

    def is_minimized(self, h):
        return False

    def foreground(self):
        return self.fg

    def focus(self, h):
        self.fg = h
        return True

    def minimize(self, h):
        pass

    def release_modifiers(self):
        pass

    def press(self, codes):
        self.pressed.append((self.fg, codes))
        if codes == CTRL_S:
            self.on_save(self, self.fg)

    def close(self, h):
        self.windows.pop(h, None)

    def exe_name(self, pid):
        return self.exes.get(pid)

    def open_files(self, pid):
        return self.files.get(pid, [])


def profiles(**over):
    base = dict(timeout_seconds=1.5)
    base.update(over)
    return [
        AppProfile("AutoCAD", ["acad.exe"], [".dwg"], pre_keys=["esc", "esc"], untitled=r"^Drawing\d+", **base),
        AppProfile("Word", ["winword.exe"], [".docx"], untitled=r"^Document\d+$", **base),
        AppProfile("D5 Render", ["d5*.exe"], [".drs"], detect_dialogs=False, **base),
    ]


def make_cfg(tmp_path, **over):
    return Config(General(search_dirs=[str(tmp_path)], between_windows_seconds=0), profiles(**over))


def touch_newer(path):
    st = os.stat(path)
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 5 * 10**9))


@pytest.fixture
def files(tmp_path):
    out = {}
    for name in ("plan.dwg", "Report.docx", "Villa.drs"):
        p = tmp_path / name
        p.write_text("x")
        out[name] = str(p)
    return out


def test_saves_and_verifies_each_app(tmp_path, files):
    windows = [
        W(1, "Autodesk AutoCAD 2025 - [plan.dwg]", 10),
        W(2, "Report - Word", 20),
        W(3, "Villa - D5 Render", 30),
        W(4, "Untitled - Notepad", 40),
    ]
    by_hwnd = {1: files["plan.dwg"], 2: files["Report.docx"], 3: files["Villa.drs"]}

    def on_save(d, h):
        touch_newer(by_hwnd[h])

    desk = FakeDesktop(windows, {10: "acad.exe", 20: "WINWORD.EXE", 30: "d5.exe", 40: "notepad.exe"},
                       {10: [files["plan.dwg"]], 20: [files["Report.docx"]]}, on_save)
    results = Saver(make_cfg(tmp_path), desk).save_all()
    assert [(r.app, r.status, r.file) for r in results] == [
        ("AutoCAD", "SAVED", files["plan.dwg"]),
        ("Word", "SAVED", files["Report.docx"]),
        ("D5 Render", "SAVED", files["Villa.drs"]),  # found via search_dirs, not open files
    ]
    # AutoCAD got Esc Esc before Ctrl+S; Notepad untouched; focus restored
    acad_keys = [c for h, c in desk.pressed if h == 1]
    assert acad_keys == [[0x1B], [0x1B], CTRL_S]
    assert all(h != 4 for h, _ in desk.pressed)
    assert desk.fg == 999
    assert summarize(results)["safe_to_shutdown"]


def test_unchanged_untitled_and_dialog(tmp_path, files):
    windows = [
        W(1, "Report - Word", 20),
        W(2, "Document2 - Word", 20),
        W(3, "Autodesk AutoCAD 2025 - [plan.dwg]", 10),
    ]

    def on_save(d, h):
        if h == 3:  # AutoCAD pops up a read-only warning instead of saving
            d.windows[50] = W(50, "AutoCAD Alert", 10, owned=True)

    desk = FakeDesktop(windows, {10: "acad.exe", 20: "winword.exe"},
                       {10: [files["plan.dwg"]], 20: [files["Report.docx"]]}, on_save)
    cfg = make_cfg(tmp_path, timeout_seconds=3)
    results = {r.title: r for r in Saver(cfg, desk).save_all()}
    assert results["Report - Word"].status == "UNCHANGED"
    assert results["Document2 - Word"].status == "UNTITLED"
    dlg = results["Autodesk AutoCAD 2025 - [plan.dwg]"]
    assert dlg.status == "DIALOG" and "AutoCAD Alert" in dlg.detail
    assert desk.pressed[-1] == (3, [0x1B])  # prompt dismissed with Esc
    assert not summarize(list(results.values()))["safe_to_shutdown"]


def test_busy_when_modal_dialog_already_open(tmp_path, files):
    desk = FakeDesktop([W(1, "Report - Word", 20, enabled=False)], {20: "winword.exe"},
                       {20: [files["Report.docx"]]}, lambda d, h: None)
    [r] = Saver(make_cfg(tmp_path), desk).save_all()
    assert r.status == "BUSY" and desk.pressed == []


def test_close_all_reports_unsaved_prompt(tmp_path, files):
    windows = [W(1, "Report - Word", 20), W(2, "Notes - Word", 21)]
    desk = FakeDesktop(windows, {20: "winword.exe", 21: "winword.exe"}, {}, lambda d, h: None)

    def close(h):
        if h == 2:  # unsaved changes -> "Do you want to save?" prompt
            desk.windows[60] = W(60, "Microsoft Word", 21, owned=True)
        else:
            desk.windows.pop(h)

    desk.close = close
    saver = Saver(make_cfg(tmp_path), desk)
    out = {r.title: r.status for r in saver.close_all(saver.find_documents(), timeout=2)}
    assert out == {"Report - Word": "SAVED", "Notes - Word": "DIALOG"}
