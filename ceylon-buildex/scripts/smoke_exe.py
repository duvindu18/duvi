"""Check the built Windows program. Standard library only. Exit code 0 = all good.

  python scripts/smoke_exe.py                     the back end in dist/CeylonBuildexServer: it serves on the port it is given, refuses a
                                                  quit request without the token, quits on the token, and quits when its parent process ends
  python scripts/smoke_exe.py --installed DIR     the installed program in DIR (after `CeylonBuildex-Setup.exe /S /D=DIR`): the window
                                                  starts its back end; with `playwright` installed it also presses the title-bar buttons
                                                  (maximize, restore, minimize, a second start brings the window back, close); closing
                                                  the window stops the back end too
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def wait_status(url: str, proc: subprocess.Popen | None, timeout: float = 120) -> dict:
    end = time.time() + timeout
    while time.time() < end:
        try:
            return json.loads(OPENER.open(url + "/api/status", timeout=3).read())
        except Exception:
            if proc is not None and proc.poll() is not None:
                raise SystemExit(f"it exited with code {proc.returncode} before serving")
            time.sleep(0.5)
    raise SystemExit("it did not serve in time")


def quit_request(url: str, token: str) -> int:
    req = urllib.request.Request(url + "/api/desktop/quit", method="POST", data=b"", headers={"X-Desktop-Token": token})
    try:
        return OPENER.open(req, timeout=5).status
    except urllib.error.HTTPError as e:
        return e.code


def check_page(url: str, home: Path) -> None:
    t0 = time.time()
    st = json.loads(OPENER.open(url + "/api/status", timeout=10).read())
    page = OPENER.open(url + "/", timeout=10).read()
    assert b"Ceylon Buildex" in page and b'id="winctl"' in page, "the page did not load"
    assert st["dataset"]["documents"] > 0, "no documents in the dataset"
    assert not st["heartbeat"], "the desktop back end must not ask the page to ping"
    assert st["ocr"]["available"], "Tesseract is not available inside the program"
    for lang in ("eng", "sin", "tam"):
        assert lang in st["ocr"]["languages"], f"OCR language {lang} is missing: {st['ocr']['languages']}"
    ans = json.loads(OPENER.open(urllib.request.Request(url + "/api/ask", method="POST", headers={"content-type": "application/json"},
                                                        data=json.dumps({"question": "What is the floor area ratio in Colombo?"}).encode()), timeout=30).read())
    assert ans["citations"], "a question found no passages"
    print(f"status ok: version {st['version']}, {st['dataset']['documents']} documents, OCR {st['ocr']['languages']}, "
          f"answer in {ans['took_ms']} ms, status+page+answer in {time.time() - t0:.2f} s")
    assert (home / "logs" / "launcher.log").is_file(), "no log file"


def server(exe: Path) -> int:
    with tempfile.TemporaryDirectory() as t:
        home = Path(t) / "home"
        base = dict(os.environ, LRP_HOME=str(home), LRP_OLLAMA_BOOT="0", UPDATE_ON_START="0", LLM_PROVIDER="none")
        # 1. serves on the given port, refuses a quit without the token, quits with it
        port = free_port()
        t0 = time.time()
        p = subprocess.Popen([str(exe), "--desktop"], env=dict(base, PORT=str(port), LRP_DESKTOP_TOKEN="tok"))
        try:
            url = f"http://127.0.0.1:{port}"
            wait_status(url, p)
            print(f"first start served after {time.time() - t0:.1f} s")
            check_page(url, home)
            assert quit_request(url, "wrong") == 403, "a quit request with the wrong token was accepted"
            assert p.poll() is None
            assert quit_request(url, "tok") == 204
            assert p.wait(timeout=30) == 0, "it did not exit cleanly"
            print("quit on the window's request")
        finally:
            if p.poll() is None:
                p.kill()
        # 2. second start (data already there) and quitting when the parent process is gone
        parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
        port = free_port()
        t0 = time.time()
        p = subprocess.Popen([str(exe), "--desktop"], env=dict(base, PORT=str(port), LRP_DESKTOP_TOKEN="tok", LRP_PARENT_PID=str(parent.pid)))
        try:
            wait_status(f"http://127.0.0.1:{port}", p)
            print(f"second start served after {time.time() - t0:.1f} s")
            parent.kill(); parent.wait()                                   # reaped, as the real window process is
            assert p.wait(timeout=30) == 0, "it did not quit when its parent ended"
            print("quit when the parent process ended")
        finally:
            for x in (p, parent):
                if x.poll() is None:
                    x.kill()
    return 0


def tasklist(image: str) -> list[int]:
    out = subprocess.run(["tasklist", "/FI", f"IMAGENAME eq {image}", "/FO", "CSV", "/NH"], capture_output=True, text=True).stdout
    return [int(line.split('","')[1]) for line in out.splitlines() if line.startswith(f'"{image}"')]


def installed(app_dir: Path) -> int:
    exe = app_dir / "CeylonBuildex.exe"
    srv = app_dir / "resources" / "server" / "CeylonBuildexServer.exe"
    for f in (exe, srv, app_dir / "resources" / "server" / "_internal" / "vendor" / "tesseract" / "tesseract.exe",
              app_dir / "resources" / "server" / "_internal" / "vendor" / "poppler" / "pdftotext.exe"):
        assert f.is_file(), f"not installed: {f}"
    with tempfile.TemporaryDirectory() as t:
        home = Path(t) / "home"
        env = dict(os.environ, LRP_HOME=str(home), LRP_OLLAMA_BOOT="0", UPDATE_ON_START="0", LLM_PROVIDER="none")
        t0 = time.time()
        p = subprocess.Popen([str(exe), "--remote-debugging-port=9333"], env=env)
        try:
            url = "http://127.0.0.1:47319"
            st = wait_status(url, None, timeout=150)
            print(f"the window's back end served after {time.time() - t0:.1f} s (version {st['version']})")
            check_page(url, home)
            servers = tasklist("CeylonBuildexServer.exe")
            assert servers, "no back end process found"
            time.sleep(3)
            if not window_buttons(exe, env):
                subprocess.run(["taskkill", "/IM", "CeylonBuildex.exe", "/T"], capture_output=True)   # like closing the window
            end = time.time() + 30
            while time.time() < end and (tasklist("CeylonBuildexServer.exe") or tasklist("CeylonBuildex.exe")):
                time.sleep(0.5)
            if tasklist("CeylonBuildex.exe"):
                subprocess.run(["taskkill", "/IM", "CeylonBuildex.exe", "/T", "/F"], capture_output=True)
                end = time.time() + 30
                while time.time() < end and tasklist("CeylonBuildexServer.exe"):
                    time.sleep(0.5)
            left = tasklist("CeylonBuildexServer.exe")
            assert not left, f"the back end is still running after the window went: {left}"
            print("closing the window stopped the back end")
            log = (home / "logs" / "launcher.log").read_text()
            print("log tail:\n" + log[-600:])
        finally:
            if p.poll() is None:
                p.kill()
            subprocess.run(["taskkill", "/IM", "CeylonBuildexServer.exe", "/T", "/F"], capture_output=True)
    return 0


def window_buttons(exe: Path, env: dict) -> bool:
    """Press the page's own minimize / maximize / close buttons in the real window (over the DevTools protocol). False: playwright is not installed."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright is not installed: the title-bar buttons were not pressed")
        return False
    with sync_playwright() as pw:
        br = pw.chromium.connect_over_cdp("http://127.0.0.1:9333")
        pg = next((g for c in br.contexts for g in c.pages if g.url.startswith("http://127.0.0.1:47319")), None)
        assert pg, "the window does not show the portal"
        pg.wait_for_function("document.documentElement.dataset.ready === '1'", timeout=30000)
        g = pg.evaluate("""() => ({cls: document.documentElement.className, shown: getComputedStyle(document.querySelector('#winctl')).display,
          size: [outerWidth, outerHeight], screen: [screen.availWidth, screen.availHeight]})""")
        assert "desktop" in g["cls"] and g["shown"] == "flex", f"the title-bar buttons are not shown: {g}"
        pg.click('#winctl [data-win="maximize"]')
        pg.wait_for_function("document.documentElement.classList.contains('win-max')", timeout=5000)
        m = pg.evaluate("[outerWidth, outerHeight, document.querySelector('[data-win=maximize]').getAttribute('aria-label')]")
        assert m[0] >= g["screen"][0] - 16 and m[2] == "Restore", f"maximize did not fill the screen: {m} (screen {g['screen']})"
        pg.click('#winctl [data-win="maximize"]')
        pg.wait_for_function("!document.documentElement.classList.contains('win-max')", timeout=5000)
        r = pg.evaluate("[outerWidth, outerHeight]")
        assert abs(r[0] - g["size"][0]) <= 16, f"restore did not bring back the size: {r} vs {g['size']}"
        print(f"maximize {g['size']} -> {m[:2]}, restore -> {r}")
        pg.click('#winctl [data-win="minimize"]')
        pg.wait_for_function("document.visibilityState === 'hidden'", timeout=5000)
        print("minimize hid the window")
        second = subprocess.run([str(exe)], env=env, timeout=60)           # a second start only brings the running window back
        pg.wait_for_function("document.visibilityState === 'visible'", timeout=10000)
        assert len(tasklist("CeylonBuildexServer.exe")) == 1, "a second start started a second back end"
        print(f"a second start (exit {second.returncode}) brought the window back; still one back end")
        pg.click('#winctl [data-win="close"]')
        print("pressed close")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("exe", nargs="?", default=str(ROOT / "dist" / "CeylonBuildexServer" / "CeylonBuildexServer.exe"))
    ap.add_argument("--installed", metavar="DIR", help="check the installed program in DIR instead")
    a = ap.parse_args()
    if a.installed:
        return installed(Path(a.installed))
    exe = Path(a.exe)
    if not exe.is_file():
        print(f"not found: {exe}", file=sys.stderr)
        return 2
    return server(exe)


if __name__ == "__main__":
    raise SystemExit(main())
