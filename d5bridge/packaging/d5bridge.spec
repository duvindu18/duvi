# PyInstaller spec: pyinstaller packaging/d5bridge.spec --noconfirm
from PyInstaller.utils.hooks import collect_submodules
import os

root = os.path.abspath(os.path.join(SPECPATH, ".."))
hidden = collect_submodules("OpenGL.platform") + collect_submodules("OpenGL.arrays") + [
    "OpenGL.GL", "PIL.ImageQt", "winreg", "PySide6.QtNetwork",
]

a = Analysis(
    [os.path.join(root, "run_d5bridge.py")],
    pathex=[root],
    datas=[(os.path.join(root, "max_plugin"), "max_plugin"),
           (os.path.join(root, "d5bridge", "gui", "shaders", "*.qsb"), os.path.join("d5bridge", "gui", "shaders"))],
    hiddenimports=hidden,
    excludes=["tkinter", "matplotlib", "scipy", "PySide6.QtWebEngineCore", "PySide6.Qt3DCore"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="D5Bridge", console=False,
          icon=os.path.join(root, "packaging", "d5bridge.ico") if os.path.exists(
              os.path.join(root, "packaging", "d5bridge.ico")) else None)
# a console twin for command-line batch use
exe_cli = EXE(pyz, a.scripts, [], exclude_binaries=True, name="D5BridgeCLI", console=True)
coll = COLLECT(exe, exe_cli, a.binaries, a.datas, strip=False, upx=False, name="D5Bridge")
