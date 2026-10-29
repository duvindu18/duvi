"""Ceylon Buildex - the desktop program (this file is what CeylonBuildex.exe runs).

Double-click and a window opens: there is no console, no .bat file and no browser tab to find. It
  1. makes sure only one copy runs (a second double-click just brings up a window on the running one);
  2. prepares the user's own data folder (first run: the shipped reference data is copied in);
  3. starts the portal on a free local port and checks Ollama in the background (ollama run qwen3.5:4b "Say ready");
  4. opens the portal in its own app window (Microsoft Edge or Google Chrome in --app mode, with its own profile);
  5. when that window is closed, stops everything it started.
Errors are written to <data folder>/logs/launcher.log and, on Windows, shown in a message box.

`launcher.py --desktop` is the back end of the installed desktop program (desktop/, an Electron window with its own title bar):
it serves on the port it is given and runs until that window asks it to quit (POST /api/desktop/quit with the token it was given)
or the window's process goes away. The window owns the "one copy" rule there, so no browser is opened and no lock port is held.

Settings by environment variable (all optional):  LRP_HOME (where the user's data lives)  PORT  LRP_BROWSER (path of a browser, or "none")
Desktop back end:  LRP_PARENT_PID (quit when this process ends)  LRP_DESKTOP_TOKEN (the secret the quit request must carry)
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
import webbrowser
from pathlib import Path

APP_NAME = "Ceylon Buildex"
BUNDLE = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))      # where the shipped files are (inside the exe when frozen)
GUARD_PORT = int(os.environ.get("LRP_GUARD_PORT", "47318"))                    # held while a copy is running: the "only one copy" lock
_LOG = None


# ------------------------------------------------------------------ small helpers
def user_home() -> Path:
    if os.environ.get("LRP_HOME"):
        return Path(os.environ["LRP_HOME"])
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return base / "CeylonBuildex"


def log(msg: str) -> None:
    if _LOG:
        try:
            _LOG.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg.rstrip() + "\n")
            _LOG.flush()
        except Exception:
            pass


def setup_logging(home: Path) -> None:
    """A windowed program has no stdout/stderr: send them (and our own notes) to a log file."""
    global _LOG
    d = home / "logs"
    d.mkdir(parents=True, exist_ok=True)
    f = d / "launcher.log"
    try:
        if f.exists() and f.stat().st_size > 1_000_000:
            f.replace(d / "launcher.old.log")
    except OSError:
        pass
    _LOG = open(f, "a", encoding="utf-8", buffering=1)
    if getattr(sys, "frozen", False) or sys.stdout is None or sys.stderr is None:
        sys.stdout = sys.stderr = _LOG


def fatal(msg: str) -> None:
    """Say what went wrong where the person will see it (no console to print to)."""
    log("FATAL " + msg)
    if os.name == "nt":
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, msg[-1800:], APP_NAME, 0x10)      # MB_ICONERROR
        except Exception:
            pass
    else:
        print(msg, file=sys.__stderr__ or sys.stderr)


def read_version() -> str:
    try:
        return (BUNDLE / "VERSION").read_text().strip() or "dev"
    except OSError:
        return "dev"


# ------------------------------------------------------------------ one copy at a time
def hold_guard() -> socket.socket | None:
    """Bind a local port for as long as this copy runs. None means another copy already holds it."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
        s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    try:
        s.bind(("127.0.0.1", GUARD_PORT))
        s.listen(1)
        return s
    except OSError:
        s.close()
        return None


def running_url(home: Path, wait: float = 20.0) -> str | None:
    """The address of the copy that is already running (it writes running.json once it is ready)."""
    end = time.time() + wait
    while time.time() < end:
        try:
            url = json.loads((home / "running.json").read_text())["url"]
            urllib.request.build_opener(urllib.request.ProxyHandler({})).open(url + "/api/status", timeout=2).read()
            return url
        except Exception:
            time.sleep(0.5)
    return None


# ------------------------------------------------------------------ the user's data folder
def seed_data(home: Path) -> Path:
    """First run (and after an upgrade) copy the shipped reference data (seed extracts, FAR rules) into the user's data folder.
    Everything the person adds or downloads lives there too and is never overwritten."""
    data = home / "data"
    data.mkdir(parents=True, exist_ok=True)
    stamp, ver, src = data / ".bundle-version", read_version(), BUNDLE / "data"
    fresh = not stamp.exists() or stamp.read_text().strip() != ver
    for name in ("seed", "rules"):
        if src.joinpath(name).is_dir() and (fresh or not (data / name).exists()):
            shutil.copytree(src / name, data / name, dirs_exist_ok=True)
    stamp.write_text(ver)
    return data


def add_tool_paths() -> None:
    """OCR and PDF tools: the ones shipped inside the program come first, then the usual install folders on Windows."""
    dirs = [BUNDLE / "vendor" / "tesseract", BUNDLE / "vendor" / "poppler"]
    if os.name == "nt":
        for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
            if base:
                dirs.append(Path(base) / "Tesseract-OCR")
    have = [str(d) for d in dirs if d.is_dir()]
    if have:
        os.environ["PATH"] = os.pathsep.join(have + [os.environ.get("PATH", "")])
    td = BUNDLE / "vendor" / "tesseract" / "tessdata"
    if td.is_dir() and not os.environ.get("TESSDATA_PREFIX"):
        os.environ["TESSDATA_PREFIX"] = str(td)


# ------------------------------------------------------------------ the window
def find_browser() -> str | None:
    """Edge ships with Windows 10/11; Chrome is the second choice. LRP_BROWSER overrides ('none' = open no window)."""
    forced = os.environ.get("LRP_BROWSER")
    if forced:
        return None if forced.lower() == "none" else forced
    cands: list[str] = []
    if os.name == "nt":
        for var in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"):
            b = os.environ.get(var)
            if b:
                cands += [os.path.join(b, "Microsoft", "Edge", "Application", "msedge.exe"), os.path.join(b, "Google", "Chrome", "Application", "chrome.exe")]
    elif sys.platform == "darwin":
        cands += ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    for n in ("microsoft-edge", "microsoft-edge-stable", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
        w = shutil.which(n)
        if w:
            cands.append(w)
    return next((c for c in cands if os.path.isfile(c)), None)


def open_window(url: str, home: Path) -> subprocess.Popen | None:
    """The portal in its own window (no tabs, no address bar). Its own profile folder means closing the window ends that process."""
    exe = find_browser()
    if not exe:
        if os.environ.get("LRP_BROWSER", "").lower() != "none":
            webbrowser.open(url)                      # no Edge or Chrome: the default browser; the page's heartbeat closes the program when the tab goes
        return None
    args = [exe, f"--app={url}", f"--user-data-dir={home / 'window'}", "--no-first-run", "--no-default-browser-check", "--window-size=1360,880",
            "--disable-features=Translate,msEdgeSidebarV2", "--disable-session-crashed-bubble"]
    kw: dict = {}
    if os.name == "nt":
        kw["creationflags"] = 0x08000000             # CREATE_NO_WINDOW for the launcher's own children
    return subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kw)


# ------------------------------------------------------------------ run
def serve(home: Path, heartbeat: bool = True, fixed_port: bool = False, before_start=None):
    """Start the portal on a free port. Returns (server, url, server module).
    fixed_port: use exactly PORT (the desktop window chose it and will connect to it), never another one.
    before_start(portal): called before the first request can arrive (routes can only be added until then)."""
    data = seed_data(home)
    os.environ.update(LRP_DATA=str(data), LRP_HEARTBEAT="1" if heartbeat else "0", HOST="127.0.0.1")
    os.environ.setdefault("UPDATE_ON_START", "first")
    add_tool_paths()
    from app import winquiet
    winquiet.install()
    from app import server as portal                  # imported only now: the data folder and PATH must be set first
    from werkzeug.serving import make_server
    portal.prepare()
    if before_start:
        before_start(portal)
    srv = None
    ports = [int(os.environ["PORT"])] if os.environ.get("PORT") else [8080]
    for port in ports + ([] if fixed_port else [0]):
        try:
            srv = make_server("127.0.0.1", port, portal.app, threaded=True)
            break
        except OSError:
            continue
    if srv is None:
        raise RuntimeError("No free local port to start on.")
    threading.Thread(target=srv.serve_forever, name="portal", daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_port}", portal


def wait_ready(url: str, timeout: float = 40.0) -> bool:
    end = time.time() + timeout
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    while time.time() < end:
        try:
            op.open(url + "/api/status", timeout=2).read()
            return True
        except Exception:
            time.sleep(0.25)
    return False


def watch(proc: subprocess.Popen | None, beat: dict, poll: float = 0.5, bye_grace: float | None = None, lost_after: float = 120.0, no_window_after: float = 180.0) -> str:
    """Block until it is time to quit; return why. A window process that ends is the normal case; the page's own
    pings cover the case where there is no window process of ours (a default-browser tab, or a browser that handed
    its window to a process already running). With no console to look at, it must never linger invisibly: if no page
    ever shows up, it quits."""
    if bye_grace is None:
        bye_grace = float(os.environ.get("LRP_BYE_GRACE", "8"))
    handoff = float(os.environ.get("LRP_HANDOFF_SECS", "5"))
    t0 = time.time()
    while True:
        now = time.time()
        if proc is not None and proc.poll() is not None:
            if now - t0 < handoff and not beat["n"]:
                proc = None                              # it left almost at once: probably handed its window to another browser process. Go by the page's pings.
            else:
                return "window closed"
        if beat["bye"] and beat["bye"] > beat["last"] and now - beat["bye"] > bye_grace:
            return "page closed"
        if proc is None and beat["n"] and now - beat["last"] > lost_after:
            return "page stopped pinging"
        if proc is None and not beat["n"] and now - t0 > no_window_after:
            return "no window opened"
        time.sleep(poll)


# ------------------------------------------------------------------ back end of the desktop window
def parent_gone(pid: int, stop: threading.Event, poll: float = 1.0) -> None:
    """Set `stop` when process `pid` ends (the desktop window crashed or was killed), so no server is left running invisibly."""
    if os.name == "nt":
        import ctypes
        k32 = ctypes.windll.kernel32
        h = k32.OpenProcess(0x00100000, False, pid)                  # SYNCHRONIZE
        if h:
            k32.WaitForSingleObject(h, 0xFFFFFFFF)                    # INFINITE: returns when the process ends
            k32.CloseHandle(h)
            stop.set()
            return
    while not stop.is_set():
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
        except OSError:
            pass                                                      # exists but belongs to someone else (cannot happen for our parent)
        stop.wait(poll)
    stop.set()


def add_quit_route(portal, token: str, stop: threading.Event) -> None:
    """POST /api/desktop/quit, for the desktop window only: it must carry the token the window gave us.
    A web page cannot send that header to another origin without a CORS pre-flight, which this server never grants."""
    from flask import request

    @portal.app.post("/api/desktop/quit")
    def desktop_quit():
        if not token or request.headers.get("X-Desktop-Token") != token:
            return ("", 403)
        stop.set()
        return ("", 204)


def shutdown(srv) -> None:
    try:
        from app import ollama_boot
        ollama_boot.stop_own_server()                 # only an Ollama this program started itself
    except Exception:
        pass
    try:
        srv.shutdown()
    except Exception:
        pass


def main_desktop() -> int:
    home = user_home()
    home.mkdir(parents=True, exist_ok=True)
    setup_logging(home)
    log(f"start {APP_NAME} {read_version()} (desktop back end) frozen={getattr(sys, 'frozen', False)} home={home}")
    stop = threading.Event()
    try:
        srv, url, _ = serve(home, heartbeat=False, fixed_port=True,
                            before_start=lambda portal: add_quit_route(portal, os.environ.get("LRP_DESKTOP_TOKEN", ""), stop))
        if not wait_ready(url):
            raise RuntimeError("The portal did not start in time.")
    except Exception:
        log("FATAL " + traceback.format_exc())
        return 1
    log("serving on " + url)
    parent = int(os.environ.get("LRP_PARENT_PID") or 0)
    if parent:
        threading.Thread(target=parent_gone, args=(parent, stop), name="parent", daemon=True).start()
    stop.wait()
    log("quitting: " + ("asked by the window" if not parent or _alive(parent) else "the window's process ended"))
    shutdown(srv)
    return 0


def _alive(pid: int) -> bool:
    if os.name == "nt":
        import ctypes
        h = ctypes.windll.kernel32.OpenProcess(0x00100000, False, pid)
        if not h:
            return False
        try:
            return ctypes.windll.kernel32.WaitForSingleObject(h, 0) == 0x102     # WAIT_TIMEOUT: still running
        finally:
            ctypes.windll.kernel32.CloseHandle(h)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except OSError:
        return True


def main() -> int:
    if "--desktop" in sys.argv[1:]:
        return main_desktop()
    home = user_home()
    home.mkdir(parents=True, exist_ok=True)
    setup_logging(home)
    log(f"start {APP_NAME} {read_version()} frozen={getattr(sys, 'frozen', False)} home={home}")
    guard = hold_guard()
    if guard is None:
        url = running_url(home)
        if url:
            log("already running: opening a window on " + url)
            open_window(url, home)
            return 0
        fatal(f"{APP_NAME} is already starting. Wait a few seconds and open it again.")
        return 1
    try:
        srv, url, portal = serve(home)
        if not wait_ready(url):
            raise RuntimeError("The portal did not start in time. See " + str(home / "logs" / "launcher.log"))
        (home / "running.json").write_text(json.dumps({"url": url, "pid": os.getpid()}))
        log("serving on " + url)
        proc = open_window(url, home)
        why = watch(proc, portal.HEARTBEAT)
        log("quitting: " + why)
    except Exception:
        fatal(f"{APP_NAME} could not start.\n\n" + traceback.format_exc()[-1500:])
        return 1
    finally:
        try:
            (home / "running.json").unlink(missing_ok=True)
        except OSError:
            pass
    shutdown(srv)
    guard.close()
    return 0


if __name__ == "__main__":
    code = main()
    sys.stdout and sys.stdout.flush()
    os._exit(code)                                    # do not wait for background threads (an update that was running, for instance)
