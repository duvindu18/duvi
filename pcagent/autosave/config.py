"""Load autosave.toml into typed settings."""
from __future__ import annotations

import fnmatch
import os
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_CONFIG = Path(__file__).resolve().parents[1] / "autosave.toml"


@dataclass
class AppProfile:
    name: str
    process: list[str]
    extensions: list[str]
    save_keys: list[str] = field(default_factory=lambda: ["ctrl+s"])
    pre_keys: list[str] = field(default_factory=list)
    timeout_seconds: float = 30.0
    untitled: str | None = None
    detect_dialogs: bool = True   # treat a window that pops up after Ctrl+S as a prompt
    enabled: bool = True

    def __post_init__(self) -> None:
        self.extensions = [e.lower() if e.startswith(".") else "." + e.lower() for e in self.extensions]
        self._untitled_re = re.compile(self.untitled, re.IGNORECASE) if self.untitled else None

    def matches_process(self, exe_name: str) -> bool:
        exe = exe_name.lower()
        return any(fnmatch.fnmatchcase(exe, p.lower()) for p in self.process)

    def is_untitled(self, doc_name: str | None) -> bool:
        return bool(doc_name and self._untitled_re and self._untitled_re.search(doc_name))


@dataclass
class General:
    interval_minutes: float = 10.0
    require_idle_seconds: float = 60.0
    search_dirs: list[str] = field(default_factory=lambda: ["~/Documents", "~/Desktop"])
    search_depth: int = 4
    log_dir: str = "%LOCALAPPDATA%/PCAgent/autosave"
    cancel_unexpected_dialogs: bool = True
    between_windows_seconds: float = 0.5

    def search_paths(self) -> list[Path]:
        return [expand(d) for d in self.search_dirs]

    def log_path(self) -> Path:
        return expand(self.log_dir)


@dataclass
class Config:
    general: General
    apps: list[AppProfile]

    def profile_for(self, exe_name: str) -> AppProfile | None:
        for app in self.apps:
            if app.enabled and app.matches_process(exe_name):
                return app
        return None


def expand(p: str) -> Path:
    s = os.path.expandvars(os.path.expanduser(p))
    if "%LOCALAPPDATA%" in s:  # not set (e.g. non-Windows): fall back to home
        s = s.replace("%LOCALAPPDATA%", str(Path.home() / ".local" / "share"))
    return Path(s)


def load(path: str | os.PathLike | None = None) -> Config:
    with open(path or DEFAULT_CONFIG, "rb") as f:
        data = tomllib.load(f)
    general = General(**data.get("general", {}))
    apps = [AppProfile(**a) for a in data.get("app", [])]
    return Config(general, apps)
