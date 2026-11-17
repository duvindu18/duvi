"""Command line: python -m autosave {list|save|watch|shutdown}"""
from __future__ import annotations

import argparse
import json
import logging
import subprocess
import sys
import time
from pathlib import Path

from . import config as config_mod
from .saver import Saver, summarize

log = logging.getLogger("autosave")

ICON = {"SAVED": "OK ", "UNCHANGED": "-- ", "SENT_UNVERIFIED": "?? ", "UNTITLED": "!! ",
        "DIALOG": "!! ", "BUSY": "!! ", "FOCUS_FAILED": "!! ", "ERROR": "XX "}


def _setup_logging(log_dir: Path, verbose: bool) -> None:
    log_dir.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    fh = logging.FileHandler(log_dir / "autosave.log", encoding="utf-8")
    fh.setFormatter(fmt)
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    root = logging.getLogger()
    root.handlers[:] = [fh, sh]
    root.setLevel(logging.DEBUG if verbose else logging.INFO)


def _write_report(log_dir: Path, report: dict, name: str) -> Path:
    out = log_dir / "reports"
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"{time.strftime('%Y%m%d-%H%M%S')}-{name}.json"
    path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    (log_dir / "last-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return path


def _print(results) -> None:
    if not results:
        print("No open documents from the configured apps.")
    for r in results:
        where = r.file or r.detail
        print(f"{ICON.get(r.status, '   ')}{r.status:<15} {r.app:<11} {r.title}\n"
              f"{'':19}{where}" + (f"  ({r.detail})" if r.file and r.detail else ""))


def cmd_list(saver: Saver, args) -> int:
    docs = saver.find_documents()
    if not docs:
        print("No open documents from the configured apps.")
    for d in docs:
        print(f"[{d.profile.name}] {d.exe} pid={d.pid}\n  title : {d.title}\n  doc   : {d.doc}")
        if d.profile.is_untitled(d.doc):
            print("  file  : (never saved - untitled)")
        for c in d.candidates or ["(not found - Ctrl+S will be sent but cannot be verified)"]:
            print(f"  file  : {c}")
    if args.all_windows:
        print("\nAll visible top-level windows:")
        for w in saver.d.list_windows():
            if not w.owned and w.title.strip():
                print(f"  {saver.d.exe_name(w.pid) or '?':<22} {w.title}")
    return 0


def cmd_save(saver: Saver, args) -> int:
    results = saver.save_all()
    report = summarize(results)
    path = _write_report(saver.cfg.general.log_path(), report, "save")
    _print(results)
    print(f"\nReport: {path}")
    return 0 if report["safe_to_shutdown"] else 2


def cmd_watch(saver: Saver, args) -> int:
    g = saver.cfg.general
    interval = (args.interval or g.interval_minutes) * 60
    log.info("watching: every %.0f min, after %.0f s idle", interval / 60, g.require_idle_seconds)
    next_run = time.monotonic()
    while True:
        if time.monotonic() >= next_run:
            idle = saver.d.idle_seconds()
            if idle < g.require_idle_seconds:
                log.debug("user active (idle %.0fs) - waiting", idle)
                time.sleep(min(15, g.require_idle_seconds - idle + 1))
                continue
            if not saver.d.foreground():  # screen locked: keys can't be delivered
                log.debug("desktop locked - skipping this round")
                next_run = time.monotonic() + 60
                continue
            results = saver.save_all()
            _write_report(g.log_path(), summarize(results), "watch")
            next_run = time.monotonic() + interval
        time.sleep(5)


def cmd_shutdown(saver: Saver, args) -> int:
    docs = saver.find_documents()
    results = saver.save_all(docs)
    if args.close or args.action == "shutdown":
        results += saver.close_all(docs)
    report = summarize(results)
    report["action"] = args.action
    _print(results)
    if not report["safe_to_shutdown"] and not args.force:
        report["action_taken"] = "cancelled"
        path = _write_report(saver.cfg.general.log_path(), report, "shutdown")
        print(f"\nNOT shutting down - some documents need attention (see above). Report: {path}")
        return 2
    cmd = {"shutdown": ["shutdown", "/s", "/t", str(args.delay), "/c", "PC Agent: documents saved"],
           "hibernate": ["shutdown", "/h"],
           "restart": ["shutdown", "/r", "/t", str(args.delay)]}[args.action]
    report["action_taken"] = "dry-run" if args.dry_run else " ".join(cmd)
    path = _write_report(saver.cfg.general.log_path(), report, "shutdown")
    print(f"\nAll documents safe. {'Would run' if args.dry_run else 'Running'}: {' '.join(cmd)}\nReport: {path}")
    if not args.dry_run:
        subprocess.run(cmd, check=False)
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="autosave", description="Save open AutoCAD / D5 / Office documents and verify on disk.")
    ap.add_argument("-c", "--config", help="path to autosave.toml")
    ap.add_argument("-v", "--verbose", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("list", help="show detected documents and their files (sends no keys)")
    p.add_argument("--all-windows", action="store_true", help="also list every window + exe name")
    sub.add_parser("save", help="save everything once and report")
    p = sub.add_parser("watch", help="keep saving every N minutes while you are idle")
    p.add_argument("--interval", type=float, help="minutes (overrides config)")
    p = sub.add_parser("shutdown", help="save, close apps, then shut down / hibernate if all is safe")
    p.add_argument("action", nargs="?", default="shutdown", choices=["shutdown", "hibernate", "restart"])
    p.add_argument("--close", action="store_true", help="close apps before hibernate/restart too")
    p.add_argument("--delay", type=int, default=60, help="seconds Windows waits before shutting down")
    p.add_argument("--force", action="store_true", help="go ahead even if some documents need attention")
    p.add_argument("--dry-run", action="store_true", help="do everything except the shutdown itself")
    args = ap.parse_args(argv)

    if sys.platform != "win32":
        print("autosave controls Windows desktop apps and only runs on Windows.", file=sys.stderr)
        return 1
    from .desktop import WindowsDesktop

    cfg = config_mod.load(args.config)
    _setup_logging(cfg.general.log_path(), args.verbose)
    saver = Saver(cfg, WindowsDesktop())
    return {"list": cmd_list, "save": cmd_save, "watch": cmd_watch, "shutdown": cmd_shutdown}[args.cmd](saver, args)


if __name__ == "__main__":
    sys.exit(main())
