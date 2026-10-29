# PyInstaller recipe for the single-file Windows program (no console window).
#   python scripts/build_exe.py          (does everything, including the OCR tools)
#   python -m PyInstaller CeylonBuildex.spec --noconfirm        (just this step)
# Result: dist/CeylonBuildex.exe
from pathlib import Path
from PyInstaller.utils.hooks import collect_submodules

ROOT = Path(SPECPATH)
datas = [
    (str(ROOT / "web"), "web"),                       # the portal's pages, styles, scripts and fonts
    (str(ROOT / "config"), "config"),                 # the list of sources
    (str(ROOT / "data" / "seed"), "data/seed"),       # verified extracts shipped with the program
    (str(ROOT / "data" / "rules"), "data/rules"),     # the FAR rules
    (str(ROOT / "VERSION"), "."),
]
if (ROOT / "vendor").is_dir():                        # Tesseract and Poppler, put there by scripts/build_exe.py
    datas.append((str(ROOT / "vendor"), "vendor"))

a = Analysis(
    ["launcher.py"],
    pathex=[str(ROOT)],
    datas=datas,
    hiddenimports=collect_submodules("app"),
    excludes=["tkinter", "playwright", "reportlab", "pypdf", "docx", "pytest", "unittest.mock"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, a.binaries, a.datas, [],
    name="CeylonBuildex",
    console=False,                                    # no command window, ever
    icon=str(ROOT / "assets" / "ceylon-buildex.ico"),
    upx=False,                                        # UPX-packed programs are flagged by more virus scanners
    disable_windowed_traceback=False,
)
