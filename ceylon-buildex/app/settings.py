"""User settings saved by the portal (data/settings.json, owner-read/write only). Holds the answer-model choice and API key
entered on the Settings screen. Keys are never sent back to the browser - only a masked form."""
from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path

from . import config

_lock = threading.Lock()
PATH = config.DATA / "settings.json"
FIELDS = ("provider", "anthropic_key", "anthropic_model", "openai_key", "openai_base", "openai_model")


def load() -> dict:
    try:
        d = json.loads(PATH.read_text())
        return {k: d.get(k) for k in FIELDS if d.get(k)}
    except Exception:
        return {}


def save(d: dict) -> None:
    clean = {k: d[k] for k in FIELDS if d.get(k)}
    with _lock:
        fd, tmp = tempfile.mkstemp(dir=str(PATH.parent), prefix=".settings-")
        try:
            os.fchmod(fd, 0o600) if hasattr(os, "fchmod") else None
            with os.fdopen(fd, "w") as f:
                json.dump(clean, f, indent=1)
            Path(tmp).replace(PATH)
        finally:
            Path(tmp).unlink(missing_ok=True)


def mask(key: str | None) -> str:
    if not key:
        return ""
    return ("•" * 8) + key[-4:] if len(key) > 8 else "•" * len(key)


def public() -> dict:
    """What the browser may see: choices and masked keys, never a key."""
    s = load()
    return {"provider": s.get("provider") or "", "anthropic_model": s.get("anthropic_model") or "", "anthropic_key": mask(s.get("anthropic_key")),
            "openai_base": s.get("openai_base") or "", "openai_model": s.get("openai_model") or "", "openai_key": mask(s.get("openai_key"))}
