"""Safe names for Windows folders, and which folders may hold a library."""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

_INVALID = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
MAX_NAME = 80


def safe_name(name: str, fallback: str = "Material") -> str:
    """A folder name that is valid on Windows (and everywhere else)."""
    s = _INVALID.sub(" ", str(name or ""))
    s = re.sub(r"\s+", " ", s).strip().rstrip(". ")
    if len(s) > MAX_NAME:
        s = s[:MAX_NAME].rstrip(". ")
    if not s or s in (".", ".."):
        s = fallback
    if s.split(".")[0].upper() in _RESERVED:
        s = s + "_"
    return s


def unique_child(parent: Path, name: str, exclude: Path | None = None) -> Path:
    """parent/name, or parent/'name (2)', 'name (3)' ... if taken (case-insensitive, like Windows)."""
    taken = {p.name.lower() for p in parent.iterdir()} if parent.exists() else set()
    if exclude is not None:
        taken.discard(exclude.name.lower())
    if name.lower() not in taken:
        return parent / name
    i = 2
    while f"{name} ({i})".lower() in taken:
        i += 1
    return parent / f"{name} ({i})"


def is_inside(child: Path, parent: Path) -> bool:
    try:
        c = Path(os.path.normcase(os.path.abspath(child)))
        p = Path(os.path.normcase(os.path.abspath(parent)))
    except (OSError, ValueError):
        return False
    return c == p or p in c.parents


def _protected_dirs() -> list[Path]:
    out: list[Path] = []
    for var in ("WINDIR", "SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData"):
        v = os.environ.get(var)
        if v:
            out.append(Path(v))
    if sys.platform != "win32":
        out += [Path(p) for p in ("/bin", "/boot", "/dev", "/etc", "/lib", "/proc", "/sbin", "/sys", "/usr", "/var")]
    return out


def refuse_reason(folder: str | os.PathLike, app_dir: str | os.PathLike | None = None) -> str | None:
    """Why a folder may not hold the library, or None if it may."""
    p = Path(os.path.abspath(os.path.expanduser(str(folder))))
    if p.parent == p:  # C:\ or /
        return "A whole drive cannot be the library. Choose or create a folder on it, for example D:\\.lumo\\materials."
    for d in _protected_dirs():
        if is_inside(p, d):
            return f"Folders inside {d} are protected by Windows. Choose a folder elsewhere."
    if app_dir and (is_inside(p, Path(app_dir)) or is_inside(Path(app_dir), p)):
        return "The program's own folder cannot hold the library (an update or uninstall would touch it)."
    home = Path.home()
    if p == home:
        return "Your whole user folder cannot be the library. Choose or create a folder inside it."
    return None
