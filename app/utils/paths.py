"""Filesystem locations used by the application.

On Windows everything user-specific lives under ``%APPDATA%\\Veil`` (config, logs,
embedding cache) and ``%LOCALAPPDATA%\\Veil`` (downloaded models, TensorRT engine
cache). On other platforms XDG-style fallbacks are used so the code stays testable.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

APP_DIR_NAME = "Veil"

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _roaming_base() -> Path:
    if sys.platform == "win32":
        base = os.environ.get("APPDATA")
        if base:
            return Path(base)
        return Path.home() / "AppData" / "Roaming"
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))


def _local_base() -> Path:
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA")
        if base:
            return Path(base)
        return Path.home() / "AppData" / "Local"
    return Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))


def _ensure(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def config_dir() -> Path:
    override = os.environ.get("VEIL_CONFIG_DIR")
    return _ensure(Path(override) if override else _roaming_base() / APP_DIR_NAME)


def config_file() -> Path:
    return config_dir() / "config.json"


def log_dir() -> Path:
    return _ensure(config_dir() / "logs")


def cache_dir() -> Path:
    override = os.environ.get("VEIL_CACHE_DIR")
    return _ensure(Path(override) if override else _local_base() / APP_DIR_NAME)


def models_dir() -> Path:
    return _ensure(cache_dir() / "models")


def trt_cache_dir() -> Path:
    return _ensure(cache_dir() / "trt_engines")


def default_faces_dir() -> Path:
    return _ensure(PROJECT_ROOT / "faces")


def default_export_dir() -> Path:
    videos = Path.home() / "Videos"
    return _ensure(videos / APP_DIR_NAME) if videos.parent.exists() else _ensure(cache_dir() / "exports")
