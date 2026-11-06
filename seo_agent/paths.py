"""File locations that work both from source and inside the packaged .exe."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

APP_NAME = "ArchViz SEO Agent"
FROZEN = getattr(sys, "frozen", False)


def resource_dir() -> Path:
    """Folder holding bundled read-only files (static/)."""
    if FROZEN:
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / "seo_agent"
    return Path(__file__).resolve().parent


def data_dir() -> Path:
    """Per-user writable folder for settings."""
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    path = base / "ArchVizSEO"
    path.mkdir(parents=True, exist_ok=True)
    return path


def reports_dir() -> Path:
    """Where saved reports go: next to the code when run from source, Documents when packaged."""
    if FROZEN:
        docs = Path.home() / "Documents"
        return (docs if docs.exists() else Path.home()) / "ArchViz SEO Reports"
    return Path(__file__).resolve().parent / "reports"


def _config_file() -> Path:
    return data_dir() / "config.json"


def load_config() -> dict:
    try:
        return json.loads(_config_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_config(cfg: dict) -> None:
    path = _config_file()
    path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def api_key() -> str | None:
    """API key from the environment first, then the saved settings."""
    return os.environ.get("ANTHROPIC_API_KEY") or load_config().get("anthropic_api_key") or None
