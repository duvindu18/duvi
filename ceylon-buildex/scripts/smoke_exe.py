"""Start the built program headless and check it works:  python scripts/smoke_exe.py [path/to/CeylonBuildex.exe]

It runs the program with no window (LRP_BROWSER=none) in a throw-away data folder, waits for it to serve, checks the page and the status,
then tells it the page closed and expects it to quit by itself. Exit code 0 = all good. Standard library only.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def main() -> int:
    exe = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "dist" / "CeylonBuildex.exe"
    if not exe.is_file():
        print(f"not found: {exe}", file=sys.stderr)
        return 2
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with tempfile.TemporaryDirectory() as t:
        home = Path(t) / "home"
        env = dict(os.environ, LRP_HOME=str(home), LRP_BROWSER="none", LRP_OLLAMA_BOOT="0", UPDATE_ON_START="0", LRP_BYE_GRACE="1",
                   PORT=str(free_port()), LRP_GUARD_PORT=str(free_port()))
        p = subprocess.Popen([str(exe)], env=env)
        try:
            url, end = None, time.time() + 90
            while time.time() < end and not url:
                try:
                    url = json.loads((home / "running.json").read_text())["url"]
                except Exception:
                    if p.poll() is not None:
                        break
                    time.sleep(0.5)
            if not url:
                log = home / "logs" / "launcher.log"
                print("the program did not become ready.\n" + (log.read_text()[-1500:] if log.exists() else "(no log)"), file=sys.stderr)
                return 1
            st = json.loads(op.open(url + "/api/status", timeout=10).read())
            page = op.open(url + "/", timeout=10).read()
            assert b"Ceylon Buildex" in page, "the page did not load"
            assert st["dataset"], "no dataset in the status"
            print("status ok:", {k: st[k] for k in ("version", "heartbeat")}, "| ocr:", st.get("ocr"))
            for path in ("/api/ping", "/api/bye"):
                op.open(urllib.request.Request(url + path, method="POST", data=b""), timeout=10)
            try:
                code = p.wait(timeout=30)
            except subprocess.TimeoutExpired:
                print("it did not quit after the page closed", file=sys.stderr)
                return 1
            print("quit by itself, exit code", code)
            return 0 if code == 0 else 1
        finally:
            if p.poll() is None:
                p.kill()


if __name__ == "__main__":
    raise SystemExit(main())
