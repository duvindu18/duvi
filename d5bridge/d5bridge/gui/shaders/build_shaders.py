"""Compile src/*.vert|frag to .qsb (Direct3D 11 HLSL, OpenGL, GLES, Metal, Vulkan SPIR-V).

Needs the qsb tool from PySide6-Addons (developer machines only; the app
loads the prebuilt .qsb files):  python build_shaders.py
"""
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "src"


def inline(text: str) -> str:
    return re.sub(r'#include\s+"([^"]+)"', lambda m: (SRC / m.group(1)).read_text(), text)


def main() -> int:
    qsb = shutil.which("pyside6-qsb") or shutil.which("qsb")
    if not qsb:
        print("qsb not found: pip install PySide6-Addons", file=sys.stderr)
        return 1
    with tempfile.TemporaryDirectory() as tmp:
        for src in sorted(SRC.glob("*.vert")) + sorted(SRC.glob("*.frag")):
            flat = Path(tmp) / src.name
            flat.write_text(inline(src.read_text()))
            out = HERE / f"{src.name}.qsb"
            subprocess.run([qsb, "--glsl", "330,300 es", "--hlsl", "50", "--msl", "12",
                            "-o", str(out), str(flat)], check=True)
            print("built", out.name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
