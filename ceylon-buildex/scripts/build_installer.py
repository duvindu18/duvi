"""Build the Windows Setup program:  python scripts/build_installer.py   ->   dist/installer/CeylonBuildex-Setup-<version>.exe

Run it on Windows. It
  1. builds the back end with scripts/build_exe.py (Python, the portal, Tesseract with English/Sinhala/Tamil, Poppler) - skip with --skip-server;
  2. installs the desktop window's tools (Electron, electron-builder) with npm, from desktop/package-lock.json;
  3. makes the installer with electron-builder (NSIS): pick a folder, Start menu and desktop shortcuts, an uninstaller,
     and everything the program needs inside it - nothing else has to be installed on the PC.
Needs: what scripts/build_exe.py needs, plus Node.js 20 or newer.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DESKTOP = ROOT / "desktop"


def say(msg: str) -> None:
    print(f"==> {msg}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--skip-server", action="store_true", help="use the back end already in dist/CeylonBuildexServer")
    ap.add_argument("--clean", action="store_true", help="delete build/ and dist/ first")
    args = ap.parse_args()
    if os.name != "nt":
        print("The Setup program is built on Windows (the GitHub Actions workflow ceylon-buildex-installer.yml does it for you).", file=sys.stderr)
        return 2
    version = (ROOT / "VERSION").read_text().strip()
    pkg = json.loads((DESKTOP / "package.json").read_text())
    if pkg["version"] != version:
        raise SystemExit(f"desktop/package.json has version {pkg['version']} but VERSION says {version}: make them the same.")
    if not args.skip_server:
        subprocess.check_call([sys.executable, str(ROOT / "scripts" / "build_exe.py")] + (["--clean"] if args.clean else []))
    server = ROOT / "dist" / "CeylonBuildexServer" / "CeylonBuildexServer.exe"
    if not server.is_file():
        raise SystemExit(f"{server} is missing: build it first (python scripts/build_exe.py).")
    npm = shutil.which("npm") or shutil.which("npm.cmd")
    if not npm:
        raise SystemExit("npm was not found: install Node.js 20 or newer (winget install OpenJS.NodeJS.LTS).")
    say("Installing the desktop window's build tools (npm ci)")
    subprocess.check_call([npm, "ci", "--no-audit", "--no-fund"], cwd=DESKTOP)
    say("Building the installer (electron-builder, NSIS)")
    shutil.rmtree(ROOT / "dist" / "installer", ignore_errors=True)
    subprocess.check_call([npm, "run", "dist"], cwd=DESKTOP)
    setup = ROOT / "dist" / "installer" / f"CeylonBuildex-Setup-{version}.exe"
    if not setup.is_file():
        raise SystemExit(f"The build finished but {setup} is not there.")
    say(f"Done: {setup}  ({setup.stat().st_size / 1e6:.0f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
