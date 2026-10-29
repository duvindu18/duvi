"""No console windows on Windows.

A program built without a console (the desktop app) makes Windows flash a black window for every helper it starts
(tesseract, pdftotext, ollama...). `install()` makes every subprocess start with CREATE_NO_WINDOW, so nothing appears.
It does nothing on other systems."""
from __future__ import annotations

import os
import subprocess

CREATE_NO_WINDOW = 0x08000000


def patched(kwargs: dict, nt: bool | None = None) -> dict:
    """The keyword arguments for Popen with the 'no window' flag added (unchanged off Windows)."""
    if not (os.name == "nt" if nt is None else nt):
        return kwargs
    out = dict(kwargs)
    out["creationflags"] = int(out.get("creationflags") or 0) | CREATE_NO_WINDOW
    return out


def install() -> bool:
    if os.name != "nt" or getattr(subprocess.Popen, "_quiet", False):
        return False
    original = subprocess.Popen.__init__

    def __init__(self, *args, **kwargs):
        original(self, *args, **patched(kwargs))

    subprocess.Popen.__init__ = __init__
    subprocess.Popen._quiet = True
    return True
