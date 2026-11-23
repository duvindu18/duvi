"""Entry point: CLI when --export/--info is given, otherwise the desktop app."""
from __future__ import annotations

import sys


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if any(a in ("--export", "--info", "-h", "--help") for a in argv):
        from .cli import run_cli
        return run_cli(argv)
    from .gui.app import run_app
    path = next((a for a in argv if not a.startswith("-")), None)
    return run_app(path)
