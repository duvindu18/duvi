"""Compiles lumo_materials/shaders/*.vert|*.frag into .qsb packs (HLSL for Direct3D 12 / 11, SPIR-V, GLSL)
with Qt's qsb tool, into lumo_materials/assets/shaders/. Run before packaging (build.ps1 does) or once after a
source checkout. Without the .qsb files the program still runs: the preview then uses OpenGL or the CPU.

    python packaging/compile_shaders.py
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "lumo_materials" / "shaders"
OUT = ROOT / "lumo_materials" / "assets" / "shaders"


def find_qsb() -> list[str] | None:
    """The real qsb program. (pyside6-qsb is only a wrapper: PySide6-Essentials ships it without qsb.exe.)"""
    try:
        import importlib

        import PySide6
        importlib.reload(PySide6)
        base = Path(PySide6.__file__).parent
        for cand in (base / "qsb.exe", base / "qsb", base / "bin" / "qsb.exe", base / "Qt" / "bin" / "qsb.exe",
                     base / "Qt" / "libexec" / "qsb"):
            if cand.exists():
                return [str(cand)]
    except ImportError:
        pass
    p = shutil.which("qsb")
    return [p] if p else None


def install_addons() -> None:
    """PySide6-Addons of the installed PySide6 version brings qsb if Essentials does not."""
    try:
        from importlib.metadata import version
        v = version("PySide6-Essentials")
    except Exception:
        v = ""
    spec = f"PySide6-Addons=={v}" if v else "PySide6-Addons"
    print(f"qsb not found: installing {spec} into the build environment")
    subprocess.run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", spec], check=False)


def main() -> int:
    qsb = find_qsb()
    if qsb is None and "--install-addons" in sys.argv:
        install_addons()
        qsb = find_qsb()
    if qsb is None:
        print("qsb (Qt Shader Tools) not found. It comes with PySide6 (pyside6-qsb); "
              "if your PySide6 lacks it: pip install PySide6-Addons", file=sys.stderr)
        return 2
    OUT.mkdir(parents=True, exist_ok=True)
    sources = sorted(list(SRC.glob("*.vert")) + list(SRC.glob("*.frag")))
    if not sources:
        print(f"no shaders in {SRC}", file=sys.stderr)
        return 2
    for src in sources:
        dst = OUT / (src.name + ".qsb")
        cmd = qsb + ["--glsl", "330,300 es", "--hlsl", "50", "--msl", "12", "-o", str(dst), str(src)]
        print("$ " + " ".join(cmd))
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.stdout.strip():
            print(r.stdout.strip())
        if r.returncode != 0 or not dst.exists():
            print(r.stderr, file=sys.stderr)
            print(f"FAILED: {src.name}", file=sys.stderr)
            return 1
        print(f"  -> {dst.relative_to(ROOT)} ({dst.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
