"""Build the back end of the Windows desktop program:  python scripts/build_exe.py   ->   dist/CeylonBuildexServer/

Run it on Windows (PyInstaller makes programs for the system it runs on). It
  1. installs PyInstaller if needed;
  2. gathers Tesseract (OCR, with English, Sinhala and Tamil) and Poppler (PDF text) into vendor/, so the program needs nothing
     else installed (looks in TESSERACT_DIR / POPPLER_DIR, the usual install folders and Chocolatey's folders; --no-vendor skips this);
  3. runs PyInstaller with CeylonBuildex.spec (a folder, no console window).
Then `python scripts/build_installer.py` wraps it in the desktop window and the Setup program.
Needs: Python 3.10+, `pip install -r requirements.txt`, and for step 2 Tesseract and Poppler installed
(winget install UB-Mannheim.TesseractOCR oschwartz10612.Poppler   or   choco install tesseract poppler).
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor"
OUT = ROOT / "dist" / "CeylonBuildexServer"
LANGS = {"eng", "osd", "sin", "tam"}                  # OCR languages shipped (the Scan page lists what is installed)
TESSDATA_URL = "https://github.com/tesseract-ocr/tessdata_fast/raw/main/{}.traineddata"


def say(msg: str) -> None:
    print(f"==> {msg}", flush=True)


def find_dir_with(exe: str, roots: list[Path]) -> Path | None:
    for r in roots:
        if r and r.is_dir():
            if (r / exe).is_file():
                return r
            hit = next(iter(sorted(r.rglob(exe))), None)
            if hit:
                return hit.parent
    return None


def vendor_tesseract() -> bool:
    cand = [Path(os.environ["TESSERACT_DIR"])] if os.environ.get("TESSERACT_DIR") else []
    cand += [Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Tesseract-OCR", Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Tesseract-OCR"]
    src = find_dir_with("tesseract.exe", cand)
    if not src:
        w = shutil.which("tesseract")
        src = Path(w).parent if w and (Path(w).parent / "tessdata").is_dir() else None
    if not src:
        return False
    dst = VENDOR / "tesseract"
    shutil.rmtree(dst, ignore_errors=True)
    dst.mkdir(parents=True)
    shutil.copy2(src / "tesseract.exe", dst)
    for dll in src.glob("*.dll"):
        shutil.copy2(dll, dst)
    (dst / "tessdata").mkdir()
    if (src / "tessdata").is_dir():
        for f in (src / "tessdata").iterdir():
            if f.is_dir():
                shutil.copytree(f, dst / "tessdata" / f.name)
            elif f.suffix != ".traineddata" or f.stem in LANGS:
                shutil.copy2(f, dst / "tessdata" / f.name)
    for lang in sorted(LANGS):                        # a language the local install lacks (Sinhala, Tamil) is downloaded once
        f = dst / "tessdata" / f"{lang}.traineddata"
        if not f.is_file():
            say(f"Downloading OCR language data: {lang}")
            try:
                with urllib.request.urlopen(TESSDATA_URL.format(lang), timeout=120) as r:
                    f.write_bytes(r.read())
            except OSError as e:
                print(f"warning: could not download {lang}.traineddata ({e}); that OCR language will not be available.", file=sys.stderr)
    say(f"Tesseract from {src}")
    return True


def vendor_poppler() -> bool:
    cand = [Path(os.environ["POPPLER_DIR"])] if os.environ.get("POPPLER_DIR") else []
    choco = Path(os.environ.get("ChocolateyInstall", r"C:\ProgramData\chocolatey")) / "lib" / "poppler"
    pk = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Packages"
    src = find_dir_with("pdftotext.exe", cand + [choco, pk])
    if not src:
        w = shutil.which("pdftotext")
        src = Path(w).parent if w else None            # a Chocolatey "shim" is not the real program; the search above finds that one first
    if not src:
        return False
    dst = VENDOR / "poppler"
    shutil.rmtree(dst, ignore_errors=True)
    dst.mkdir(parents=True)
    for name in ("pdftotext.exe", "pdftoppm.exe", "pdfinfo.exe"):
        if (src / name).is_file():
            shutil.copy2(src / name, dst)
    for dll in src.glob("*.dll"):
        shutil.copy2(dll, dst)
    say(f"Poppler from {src}")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-vendor", action="store_true", help="do not bundle Tesseract and Poppler (the program then needs them installed)")
    ap.add_argument("--clean", action="store_true", help="delete build/ and dist/ first")
    args = ap.parse_args()
    if os.name != "nt":
        print("This builds the Windows program, so it has to run on Windows (PyInstaller cannot cross-build).\n"
              "No Windows machine? The GitHub Actions workflow (ceylon-buildex-installer.yml) builds it for you.", file=sys.stderr)
        return 2
    os.chdir(ROOT)
    if args.clean:
        shutil.rmtree("build", ignore_errors=True)
        shutil.rmtree("dist", ignore_errors=True)
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        say("Installing PyInstaller")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "pyinstaller"])
    if not (ROOT / "assets" / "ceylon-buildex.ico").is_file():
        raise SystemExit("assets/ceylon-buildex.ico is missing")
    if args.no_vendor:
        shutil.rmtree(VENDOR, ignore_errors=True)
    else:
        t, p = vendor_tesseract(), vendor_poppler()
        if not t:
            print("warning: Tesseract not found: the program will not be able to read scanned pages unless it is installed on the computer.", file=sys.stderr)
        if not p:
            print("warning: Poppler not found: the program will not be able to read PDFs unless it is installed on the computer.", file=sys.stderr)
    say("Building dist/CeylonBuildexServer/")
    subprocess.check_call([sys.executable, "-m", "PyInstaller", "CeylonBuildex.spec", "--noconfirm"])
    exe = OUT / "CeylonBuildexServer.exe"
    if not exe.is_file():
        raise SystemExit(f"The build finished but {exe} is not there.")
    size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    say(f"Done: {OUT}  ({size / 1e6:.0f} MB). Test it with: python scripts/smoke_exe.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
