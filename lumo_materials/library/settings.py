"""Program data: settings.json (chosen library folder, preferences) and the drafts folder."""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

from .. import APP_ID

DEFAULTS: dict[str, Any] = {
    "library_dir": "",
    "page_size": 24,
    "default_preset": "generic",
    "default_output_px": 2048,
    "preview_px": 768,
    "sort": "recent",
    "light": "studio",
    "background": "auto",
    "tiling": 2.0,
    "displacement": 0.35,
    "inspector_open": True,
    "window": None,
    "last_folder": "",
    "renderer": "auto",        # auto (Direct3D 12 -> 11 -> OpenGL -> CPU) | d3d12 | d3d11 | opengl | cpu
}


def data_dir() -> Path:
    env = os.environ.get("LUMO_MATERIALS_DATA")
    if env:
        return Path(env)
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / APP_ID / "data"
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / APP_ID


def write_json_atomic(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name, suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def read_json(path: Path, default: Any = None) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


class Settings:
    def __init__(self, folder: Path | None = None):
        self.folder = Path(folder) if folder else data_dir()
        self.path = self.folder / "settings.json"
        stored = read_json(self.path, {}) or {}
        self.values: dict[str, Any] = {**DEFAULTS, **{k: v for k, v in stored.items() if k in DEFAULTS}}

    def get(self, key: str) -> Any:
        if key == "library_dir" and os.environ.get("LUMO_LIBRARY_DIR"):
            return os.environ["LUMO_LIBRARY_DIR"]
        return self.values.get(key, DEFAULTS.get(key))

    def set(self, key: str, value: Any, save: bool = True) -> None:
        self.values[key] = value
        if save:
            self.save()

    def save(self) -> None:
        write_json_atomic(self.path, self.values)

    @property
    def library_pinned(self) -> bool:
        return bool(os.environ.get("LUMO_LIBRARY_DIR"))

    @property
    def drafts_dir(self) -> Path:
        return self.folder / "drafts"
