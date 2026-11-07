# PyInstaller spec: one folder (fast start, LGPL-friendly separate Qt DLLs), windowed, no UPX.
# Build with:  pyinstaller --noconfirm --clean packaging/lumo-materials.spec   (build.ps1 does this)
import os
from pathlib import Path

ROOT = Path(SPECPATH).resolve().parent
version_file = os.environ.get("LUMO_VERSION_FILE", str(ROOT / "build" / "version_info.txt"))

# Qt modules the program never uses (keeps the folder small)
EXCLUDE = [
    "tkinter", "PySide6.QtQml", "PySide6.QtQuick", "PySide6.QtQuickWidgets", "PySide6.QtQuickControls2",
    "PySide6.QtWebEngineCore", "PySide6.QtWebEngineWidgets", "PySide6.QtWebChannel", "PySide6.QtWebSockets",
    "PySide6.QtMultimedia", "PySide6.QtMultimediaWidgets", "PySide6.QtCharts", "PySide6.QtDataVisualization",
    "PySide6.QtPdf", "PySide6.QtPdfWidgets", "PySide6.QtBluetooth", "PySide6.QtNfc", "PySide6.QtSensors",
    "PySide6.QtSerialPort", "PySide6.QtSql", "PySide6.QtTest", "PySide6.QtDesigner", "PySide6.QtHelp",
    "PySide6.QtUiTools", "PySide6.QtXml", "PySide6.Qt3DCore", "PySide6.Qt3DRender", "PySide6.QtConcurrent",
    "PySide6.QtDBus", "PySide6.QtPrintSupport", "PySide6.QtSpatialAudio", "PySide6.QtTextToSpeech",
    "numpy.f2py", "numpy.distutils", "PIL.ImageQt", "PIL.ImageTk",
]

# Qt's software OpenGL (Mesa llvmpipe) for PCs without a working graphics driver: Qt loads it automatically.
extra_binaries = []
try:
    import PySide6
    _qt = Path(PySide6.__file__).parent
    for name in ("opengl32sw.dll",):
        if (_qt / name).exists():
            extra_binaries.append((str(_qt / name), "PySide6"))
except ImportError:
    pass

a = Analysis(
    [str(ROOT / "packaging" / "launch.py")],
    pathex=[str(ROOT)],
    binaries=extra_binaries,
    datas=[(str(ROOT / "lumo_materials" / "assets"), "assets")],
    hiddenimports=["PySide6.QtSvg", "PySide6.QtOpenGL", "PySide6.QtOpenGLWidgets", "PySide6.QtNetwork"],
    hookspath=[],
    runtime_hooks=[],
    excludes=EXCLUDE,
    noarchive=False,
    optimize=1,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="lumo-materials",
    icon=str(ROOT / "lumo_materials" / "assets" / "icons" / "app.ico"),
    version=version_file if os.path.exists(version_file) else None,
    console=False,
    disable_windowed_traceback=False,
    upx=False,
    debug=False,
    strip=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="lumo-materials",
)
