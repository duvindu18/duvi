# PyInstaller spec for ArchVizSEO.exe - build with:  python seo_agent/packaging/build_exe.py
import os

ROOT = os.path.abspath(os.path.join(SPECPATH, "..", ".."))
ICON = os.path.join(SPECPATH, "icon.ico")

a = Analysis(
    [os.path.join(SPECPATH, "run_app.py")],
    pathex=[ROOT],
    datas=[(os.path.join(ROOT, "seo_agent", "static"), os.path.join("seo_agent", "static"))],
    hiddenimports=["seo_agent.web", "seo_agent.core", "seo_agent.tools", "seo_agent.offline", "seo_agent.local_llm"],
    excludes=["tkinter", "pytest", "unittest", "pydoc_data"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="ArchVizSEO",
    console=True,   # the small console window shows the URL; closing it quits the app
    upx=False,
    icon=ICON if os.path.exists(ICON) else None,
)
