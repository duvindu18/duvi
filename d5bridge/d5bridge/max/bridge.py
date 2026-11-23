"""Run 3ds Max headless (3dsmaxbatch.exe) to turn a .max file into a bundle.

.max is a closed format: only 3ds Max itself can read it, and Corona / V-Ray
materials can only be read when that renderer is installed. D5 Bridge
therefore drives the 3ds Max you already have, in the background, with no UI.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

PLUGIN_DIR_CANDIDATES = [
    Path(__file__).resolve().parents[2] / "max_plugin",          # source checkout
    Path(getattr(sys, "_MEIPASS", "")) / "max_plugin",            # PyInstaller bundle
    Path(sys.executable).resolve().parent / "max_plugin",
]


@dataclass
class MaxInstall:
    version: str
    batch_exe: str

    @property
    def label(self) -> str:
        return f"3ds Max {self.version}"


def plugin_dir() -> Path:
    for c in PLUGIN_DIR_CANDIDATES:
        if (c / "d5bridge_max_export.py").is_file():
            return c
    raise FileNotFoundError("max_plugin folder not found next to D5 Bridge")


def find_max_installs() -> list[MaxInstall]:
    found: dict[str, MaxInstall] = {}
    if sys.platform == "win32":
        try:
            import winreg
            for root in (winreg.HKEY_LOCAL_MACHINE,):
                try:
                    k = winreg.OpenKey(root, r"SOFTWARE\Autodesk\3dsMax")
                except OSError:
                    continue
                i = 0
                while True:
                    try:
                        ver = winreg.EnumKey(k, i)
                    except OSError:
                        break
                    i += 1
                    try:
                        sk = winreg.OpenKey(k, ver)
                        loc, _ = winreg.QueryValueEx(sk, "Installdir")
                    except OSError:
                        continue
                    exe = Path(loc) / "3dsmaxbatch.exe"
                    if exe.is_file():
                        year = _year_from(ver, str(loc))
                        found[str(exe).lower()] = MaxInstall(year, str(exe))
        except ImportError:
            pass
    pf = os.environ.get("ProgramFiles", r"C:\Program Files")
    base = Path(pf) / "Autodesk"
    if base.is_dir():
        for d in base.glob("3ds Max *"):
            exe = d / "3dsmaxbatch.exe"
            if exe.is_file():
                found.setdefault(str(exe).lower(), MaxInstall(_year_from("", d.name), str(exe)))
    env = os.environ.get("D5B_3DSMAXBATCH")
    if env and Path(env).is_file():
        found.setdefault(env.lower(), MaxInstall("custom", env))
    return sorted(found.values(), key=lambda m: m.version, reverse=True)


def _year_from(reg_ver: str, path: str) -> str:
    m = re.search(r"(20\d\d)", path)
    if m:
        return m.group(1)
    try:
        major = int(float(reg_ver))
        return str(major + 1998)       # 26.0 -> 2024
    except ValueError:
        return reg_ver or "?"


def bundle_dir_for(max_file: str) -> Path:
    h = hashlib.md5(str(Path(max_file).resolve()).encode()).hexdigest()[:8]
    return Path(tempfile.gettempdir()) / "D5Bridge" / f"{Path(max_file).stem}_{h}"


def convert_max_file(max_file: str, install: MaxInstall | None = None,
                     options: dict | None = None, log=print, timeout: int = 1800,
                     reuse_cache: bool = True) -> Path:
    """Export ``max_file`` to a bundle folder. Returns the bundle folder."""
    max_file = str(Path(max_file).resolve())
    out = bundle_dir_for(max_file)
    manifest = out / "manifest.json"
    if reuse_cache and manifest.is_file() and manifest.stat().st_mtime > Path(max_file).stat().st_mtime:
        try:
            if json.loads(manifest.read_text(encoding="utf-8")).get("version", 0) >= 2:
                log(f"Using cached 3ds Max export: {out}")
                return out
        except ValueError:
            pass
    installs = [install] if install else find_max_installs()
    if not installs:
        raise RuntimeError(
            "3ds Max was not found. .max files can only be read by 3ds Max itself "
            "(2021 or newer). Install it, or in 3ds Max use the D5 Bridge toolbar button, "
            "or export the model to FBX/OBJ and open that instead.")
    inst = installs[0]
    if out.exists():
        shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True, exist_ok=True)
    script = plugin_dir() / "d5bridge_batch.ms"
    env = dict(os.environ)
    env["D5B_BUNDLE"] = str(out)
    env["D5B_OPTIONS"] = json.dumps(options or {})
    logfile = out / "max_log.txt"
    cmd = [inst.batch_exe, str(script), "-sceneFile", max_file, "-v", "3", "-log", str(logfile)]
    log(f"Opening the file in {inst.label} (background, no UI)...")
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    proc = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace", creationflags=flags)
    lines: list[str] = []
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.rstrip()
            if line:
                lines.append(line)
                if any(k in line for k in ("D5BRIDGE", "Error", "error", "Missing", "Loading")):
                    log("3ds Max: " + line[:300])
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        raise RuntimeError("3ds Max did not finish in time")
    if not manifest.is_file():
        err = (out / "error.txt")
        detail = err.read_text(encoding="utf-8", errors="replace") if err.is_file() else "\n".join(lines[-30:])
        raise RuntimeError(f"3ds Max export failed:\n{detail}")
    return out
