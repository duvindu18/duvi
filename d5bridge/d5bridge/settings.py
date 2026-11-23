"""Persistent user settings (JSON in %APPDATA%\\D5Bridge)."""
from __future__ import annotations

import json
import os
from pathlib import Path


def settings_path() -> Path:
    base = os.environ.get("APPDATA") or os.path.join(Path.home(), ".config")
    return Path(base) / "D5Bridge" / "settings.json"


def load_settings() -> dict:
    p = settings_path()
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_settings(data: dict) -> None:
    p = settings_path()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data, indent=1), encoding="utf-8")
    except OSError:
        pass
