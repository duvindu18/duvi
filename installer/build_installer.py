"""Build VeilSetup.exe - a single, self-contained Windows installer.

Runs on Windows *or* Linux (NSIS cross-compiles), with internet access:

    pip install -r requirements-dev.txt          # PySide6 + Pillow for the artwork
    # Windows: winget install -e --id NSIS.NSIS   Linux: sudo apt install nsis
    python installer/build_installer.py --version 1.0.0

Output: dist/VeilSetup-<version>.exe

What gets staged (build/installer/stage):
    payload/python/        Python 3.11.9 x64 (official NuGet package, full stdlib + pip)
    payload/app/           main.py, app/ package, docs
    payload/wheels/        offline wheelhouse (Qt, OpenCV, NumPy, SciPy, ONNX Runtime CPU + DirectML)
    payload/requirements/  pinned component lists used by provision.py
    payload/provision.py   component installer run by setup
    payload/Veil.exe       launcher (compiled from launcher.nsi)
    payload/veil.cmd       command-line entry point
    mediamtx/              phone receiver (separate installer component)
    veil.ico, header.bmp, wizard.bmp, NOTICE.txt   installer artwork / licence page
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
HERE = REPO / "installer"
PYTHON_VERSION = "3.11.9"
PYTHON_NUPKG = f"https://api.nuget.org/v3-flatcontainer/python/{PYTHON_VERSION}/python.{PYTHON_VERSION}.nupkg"
PYTHON_NUPKG_SHA256 = None  # set to pin the exact archive once verified on your build machine

APP_ITEMS = ["main.py", "app", "README.md", "requirements.txt"]
MEDIAMTX_VERSION = "1.9.3"
MEDIAMTX_URL = (
    f"https://github.com/bluenviron/mediamtx/releases/download/v{MEDIAMTX_VERSION}/"
    f"mediamtx_v{MEDIAMTX_VERSION}_windows_amd64.zip"
)
PRUNE_DIRS = {"__pycache__", "test", "tests", "idlelib", "tkinter", "turtledemo", "ensurepip"}


def log(msg: str) -> None:
    print(f"[build] {msg}", flush=True)


def fetch(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    log(f"downloading {url}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=120) as resp, tmp.open("wb") as out:
        shutil.copyfileobj(resp, out)
    tmp.replace(dest)
    return dest


def find_makensis() -> str:
    for candidate in (
        shutil.which("makensis"),
        r"C:\Program Files (x86)\NSIS\makensis.exe",
        r"C:\Program Files\NSIS\makensis.exe",
    ):
        if candidate and Path(candidate).exists():
            return candidate
    sys.exit("makensis not found. Install NSIS 3.x (winget install -e --id NSIS.NSIS / apt install nsis).")


# ---------------------------------------------------------------------------
def stage_python(cache: Path, dest: Path) -> None:
    nupkg = fetch(PYTHON_NUPKG, cache / f"python.{PYTHON_VERSION}.nupkg")
    if PYTHON_NUPKG_SHA256:
        digest = hashlib.sha256(nupkg.read_bytes()).hexdigest()
        if digest != PYTHON_NUPKG_SHA256:
            sys.exit(f"Python package checksum mismatch: {digest}")
    log("extracting Python runtime")
    with zipfile.ZipFile(nupkg) as zf:
        for member in zf.namelist():
            if not member.startswith("tools/") or member.endswith("/"):
                continue
            rel = Path(member[len("tools/"):])
            # Drop the test suite, IDLE and Tk - Veil uses Qt and never needs them.
            if any(part in PRUNE_DIRS for part in rel.parts[:-1]) and "pip" not in rel.parts:
                continue
            if rel.name.startswith(("_tkinter", "tcl", "tk")) and rel.parts[0] == "DLLs":
                continue
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(member) as src, target.open("wb") as out:
                shutil.copyfileobj(src, out)
    if not (dest / "python.exe").exists() or not (dest / "Lib" / "site-packages" / "pip").exists():
        sys.exit("Unexpected Python package layout (python.exe or pip missing).")


def stage_app(dest: Path) -> None:
    log("copying application")
    dest.mkdir(parents=True, exist_ok=True)
    for item in APP_ITEMS:
        src = REPO / item
        if src.is_dir():
            shutil.copytree(src, dest / item, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        else:
            shutil.copy2(src, dest / item)
    (dest / "faces").mkdir(exist_ok=True)
    shutil.copy2(REPO / "faces" / "README.md", dest / "faces" / "README.md")


def stage_wheels(cache: Path, dest: Path) -> None:
    log("collecting offline wheelhouse (win_amd64, cp311)")
    wheel_cache = cache / "wheels"
    wheel_cache.mkdir(parents=True, exist_ok=True)
    req = HERE / "requirements"
    cmd = [
        sys.executable, "-m", "pip", "download", "--disable-pip-version-check",
        "--only-binary=:all:", "--platform", "win_amd64", "--python-version", "3.11",
        "--implementation", "cp", "--abi", "cp311", "-d", str(wheel_cache),
        "-r", str(req / "core.txt"), "-r", str(req / "offline-runtimes.txt"), "-c", str(req / "constraints.txt"),
    ]
    subprocess.run(cmd, check=True)
    dest.mkdir(parents=True, exist_ok=True)
    for whl in wheel_cache.glob("*.whl"):
        shutil.copy2(whl, dest / whl.name)


def stage_mediamtx(cache: Path, dest: Path) -> None:
    """Phone receiver: only the executable and its licence (Veil writes its own
    config at runtime)."""
    log("staging MediaMTX phone receiver")
    archive = fetch(MEDIAMTX_URL, cache / Path(MEDIAMTX_URL).name)
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as zf:
        for name in ("mediamtx.exe", "LICENSE"):
            with zf.open(name) as src, (dest / name).open("wb") as out:
                shutil.copyfileobj(src, out)


def render_artwork(stage: Path) -> None:
    """App icon and installer bitmaps in the Noir theme (Qt draws, Pillow encodes)."""
    log("rendering icon and installer artwork")
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    sys.path.insert(0, str(REPO))
    from PIL import Image
    from PySide6.QtCore import QRectF, Qt
    from PySide6.QtGui import QColor, QFont, QImage, QPainter
    from PySide6.QtWidgets import QApplication

    from app.gui.icons import draw_logo

    app = QApplication.instance() or QApplication([])  # noqa: F841 - fonts need an app

    def qimage_to_pil(img: QImage) -> Image.Image:
        img = img.convertToFormat(QImage.Format.Format_RGBA8888)
        return Image.frombuffer("RGBA", (img.width(), img.height()), bytes(img.constBits()), "raw", "RGBA", 0, 1)

    def ember(p: QPainter, w: int, h: int) -> None:
        p.fillRect(QRectF(0, 0, w, h), QColor("#0B0B0C"))

    # Icon
    frames = []
    for size in (16, 24, 32, 48, 64, 128, 256):
        img = QImage(size, size, QImage.Format.Format_ARGB32)
        img.fill(Qt.GlobalColor.transparent)
        p = QPainter(img)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor("#141416"))
        p.drawRoundedRect(QRectF(0, 0, size, size), size * 0.26, size * 0.26)
        pad = size * 0.2
        draw_logo(p, QRectF(pad, pad, size - 2 * pad, size - 2 * pad), QColor("#E4F17A"))
        p.end()
        frames.append(qimage_to_pil(img))
    frames[-1].save(stage / "veil.ico", sizes=[(f.width, f.height) for f in frames], append_images=frames[:-1])

    # Wizard (welcome/finish) 164x314 and header 150x57, 24-bit BMP as NSIS requires.
    for name, (w, h), title in (("wizard.bmp", (164, 314), True), ("header.bmp", (150, 57), False)):
        img = QImage(w, h, QImage.Format.Format_ARGB32)
        p = QPainter(img)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        ember(p, w, h)
        if title:
            draw_logo(p, QRectF(w / 2 - 34, 70, 68, 68), QColor("#E4F17A"))
            f = QFont()
            f.setPixelSize(30)
            f.setWeight(QFont.Weight.Light)
            p.setFont(f)
            p.setPen(QColor("white"))
            p.drawText(QRectF(0, 150, w, 40), Qt.AlignmentFlag.AlignHCenter, "Veil")
            f.setPixelSize(11)
            p.setFont(f)
            p.setPen(QColor(255, 255, 255, 180))
            p.drawText(QRectF(10, 192, w - 20, 60), Qt.AlignmentFlag.AlignHCenter | Qt.TextFlag.TextWordWrap,
                       "Protect every face.")
        else:
            draw_logo(p, QRectF(w - 50, 10, 38, 38), QColor("white"))
        p.end()
        qimage_to_pil(img).convert("RGB").save(stage / name, format="BMP")


def write_cli(payload: Path) -> None:
    (payload / "veil.cmd").write_text(
        '@echo off\r\n"%~dp0python\\python.exe" -E -s "%~dp0app\\main.py" %*\r\n', encoding="ascii"
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--version", default=None)
    ap.add_argument("--out", default=str(REPO / "dist"))
    ap.add_argument("--build-dir", default=str(REPO / "build" / "installer"))
    args = ap.parse_args()

    sys.path.insert(0, str(REPO))
    from app import __version__

    version = args.version or __version__
    build = Path(args.build_dir)
    cache = build / "cache"
    stage = build / "stage"
    payload = stage / "payload"
    if stage.exists():
        shutil.rmtree(stage)
    payload.mkdir(parents=True)

    makensis = find_makensis()
    stage_python(cache, payload / "python")
    stage_app(payload / "app")
    stage_wheels(cache, payload / "wheels")
    stage_mediamtx(cache, stage / "mediamtx")
    shutil.copytree(HERE / "requirements", payload / "requirements")
    shutil.copy2(HERE / "provision.py", payload / "provision.py")
    shutil.copy2(HERE / "NOTICE.txt", stage / "NOTICE.txt")
    shutil.copy2(HERE / "NOTICE.txt", payload / "NOTICE.txt")
    write_cli(payload)
    render_artwork(stage)
    shutil.copy2(stage / "veil.ico", payload / "veil.ico")

    log("compiling launcher (Veil.exe)")
    subprocess.run(
        [makensis, "-V2", f"-DOUTFILE={payload / 'Veil.exe'}", f"-DICON={stage / 'veil.ico'}",
         f"-DVERSION={version}", str(HERE / "launcher.nsi")],
        check=True,
    )
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    exe = out / f"VeilSetup-{version}.exe"
    log(f"compiling installer ({exe.name}) - LZMA solid compression takes a few minutes")
    subprocess.run(
        [makensis, "-V2", f"-DSTAGE={stage}", f"-DVERSION={version}", f"-DOUTFILE={exe}", str(HERE / "veil.nsi")],
        check=True,
    )
    digest = hashlib.sha256(exe.read_bytes()).hexdigest()
    (out / f"{exe.name}.sha256").write_text(f"{digest}  {exe.name}\n")
    log(f"done: {exe}  ({exe.stat().st_size / 1e6:.0f} MB)  sha256 {digest}")


if __name__ == "__main__":
    main()
