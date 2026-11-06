"""Build the single-file app with PyInstaller.

    pip install -r seo_agent/requirements-build.txt
    python seo_agent/packaging/build_exe.py

Output: dist/ArchVizSEO.exe on Windows (dist/ArchVizSEO on Linux/macOS).
PyInstaller can't cross-compile, so build the .exe on Windows (or let the
GitHub Actions workflow "Build ArchViz SEO exe" do it).
"""
import hashlib
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def make_icon() -> None:
    """Create a simple icon if Pillow is available (optional)."""
    ico = HERE / "icon.ico"
    if ico.exists():
        return
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return
    img = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((8, 8, 248, 248), radius=48, fill=(28, 25, 23, 255))
    d.polygon([(48, 150), (128, 70), (208, 150)], fill=(250, 250, 249, 255))   # roof
    d.rectangle((72, 150, 184, 206), fill=(250, 250, 249, 255))               # house body
    d.rectangle((114, 168, 142, 206), fill=(28, 25, 23, 255))                  # door
    img.save(ico, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


def main() -> None:
    make_icon()
    subprocess.check_call([sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean",
                           "--distpath", str(ROOT / "dist"), "--workpath", str(ROOT / "build"),
                           str(HERE / "ArchVizSEO.spec")], cwd=ROOT)
    for exe in (ROOT / "dist").glob("ArchVizSEO*"):
        if exe.suffix in ("", ".exe") and exe.is_file():
            digest = hashlib.sha256(exe.read_bytes()).hexdigest()
            (exe.parent / (exe.name + ".sha256")).write_text(f"{digest}  {exe.name}\n")
            print(f"Built {exe} ({exe.stat().st_size / 1e6:.1f} MB)\nSHA256 {digest}")


if __name__ == "__main__":
    main()
