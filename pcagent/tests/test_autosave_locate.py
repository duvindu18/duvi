import os

import pytest

from autosave import keys, locate
from autosave.config import load
from autosave.verify import wait_for_save

DWG = [".dwg", ".dxf"]
DOCX = [".docx", ".doc"]
XLSX = [".xlsx", ".xls"]


@pytest.mark.parametrize("title,exts,expected", [
    ("Autodesk AutoCAD 2025 - [Floor Plan L2.dwg]", DWG, "Floor Plan L2.dwg"),
    ("Autodesk AutoCAD 2024 - [C:\\Work\\Villa\\site.dwg]", DWG, "C:\\Work\\Villa\\site.dwg"),
    ("Autodesk AutoCAD 2024 - [Drawing1.dwg]", DWG, "Drawing1.dwg"),
    ("Report Q3.docx - Word", DOCX, "Report Q3.docx"),
    ("Report Q3 - Word", DOCX, "Report Q3"),
    ("Old Spec [Compatibility Mode] - Word", DOCX, "Old Spec"),
    ("Old Spec  -  Compatibility Mode - Word", DOCX, "Old Spec"),
    ("Budget 2026 - Saved - Excel", XLSX, "Budget 2026"),
    ("Budget 2026 - Excel", XLSX, "Budget 2026"),
    ("*Villa Exterior - D5 Render", [".drs"], "Villa Exterior"),
    ("", DOCX, None),
])
def test_doc_name_from_title(title, exts, expected):
    assert locate.doc_name_from_title(title, exts) == expected


def test_open_files_match_by_stem_and_ignore_lock_files():
    files = ["C:\\P\\~$port Q3.docx", "C:\\P\\Report Q3.docx", "C:\\P\\Other.docx", "C:\\Windows\\x.dll"]
    assert locate.candidates_from_open_files("Report Q3", files, DOCX) == ["C:\\P\\Report Q3.docx"]
    assert locate.candidates_from_open_files("Report Q3.docx", files, DOCX) == ["C:\\P\\Report Q3.docx"]
    # unknown title -> all the app's open documents
    assert locate.candidates_from_open_files(None, files, DOCX) == ["C:\\P\\Report Q3.docx", "C:\\P\\Other.docx"]
    assert locate.candidates_from_open_files("Missing", files, DOCX) == []


def test_search_dirs_newest_first(tmp_path):
    a = tmp_path / "old" / "Villa.drs"
    b = tmp_path / "new" / "deep" / "Villa.drs"
    for p in (a, b):
        p.parent.mkdir(parents=True)
        p.write_text("x")
    os.utime(a, (1000, 1000))
    assert locate.search_dirs("Villa", [tmp_path], [".drs"]) == [str(b), str(a)]
    assert locate.search_dirs("Villa", [tmp_path], [".drs"], max_depth=1) == [str(a)]


def test_keys_parse():
    assert keys.parse("ctrl+s") == [0x11, ord("S")]
    assert keys.parse("Esc") == [0x1B]
    assert keys.parse("ctrl+shift+f12") == [0x11, 0x10, 0x7B]
    with pytest.raises(ValueError):
        keys.parse("ctrl+banana")


def test_default_config_profiles():
    cfg = load()
    assert cfg.profile_for("acad.exe").name == "AutoCAD"
    assert cfg.profile_for("WINWORD.EXE").name == "Word"
    assert cfg.profile_for("d5.exe").name == "D5 Render"
    assert cfg.profile_for("SketchUp.exe") is None  # disabled by default
    assert cfg.profile_for("notepad.exe") is None
    word = cfg.profile_for("winword.exe")
    assert word.is_untitled("Document3") and not word.is_untitled("Report")


class FakeClock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s


def test_wait_for_save_detects_newer_mtime(tmp_path):
    f = tmp_path / "a.docx"
    f.write_text("v1")
    os.utime(f, ns=(10**9, 10**9))
    clock = FakeClock()

    def sleep(s):
        clock.sleep(s)
        if clock.t >= 1.0 and f.read_text() == "v1":
            f.write_text("v2")  # the app saves after ~1 s
            os.utime(f, ns=(2 * 10**9, 2 * 10**9))

    r = wait_for_save([str(f)], 10, clock=clock, sleep=sleep)
    assert r.reason == "saved" and r.saved_path == str(f)


def test_wait_for_save_timeout_and_abort(tmp_path):
    f = tmp_path / "a.docx"
    f.write_text("v1")
    clock = FakeClock()
    r = wait_for_save([str(f)], 3, clock=clock, sleep=clock.sleep)
    assert r.reason == "timeout"
    clock = FakeClock()
    r = wait_for_save([str(f)], 30, abort=lambda: "Save As" if clock.t > 1 else None,
                      clock=clock, sleep=clock.sleep)
    assert r.reason == "aborted:Save As"
