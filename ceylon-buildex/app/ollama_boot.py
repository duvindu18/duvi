"""Start-up check for Ollama (the free, local way to write answers).

When the portal starts it makes sure the local model is ready:
  1. find the `ollama` program (OLLAMA_BIN, the PATH, or the places the installers use);
  2. if the Ollama server is not running, start it (`ollama serve`, hidden: no console window);
  3. if the model is not installed, download it (a few GB, once; progress is shown in Settings);
  4. run the real check:  ollama run qwen3.5:4b "Say ready"   and look for the word "ready" in the reply.
All of it happens in a background thread, so the page opens at once; Settings shows where it is.
Nothing here is required: if Ollama is missing the portal still works and quotes passages.
"""
from __future__ import annotations

import atexit
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from urllib.parse import urlparse

import requests

from . import config, settings

_lock = threading.Lock()
_state: dict = {"state": "idle", "message": "", "model": config.OLLAMA_MODEL, "progress": None, "reply": "", "binary": "", "started_server": False, "updated": 0.0}
_thread: threading.Thread | None = None
_server: subprocess.Popen | None = None

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07")
# idle | checking | starting | pulling | warming | ready | missing | error | disabled
BUSY = ("checking", "starting", "pulling", "warming")


def status() -> dict:
    with _lock:
        return dict(_state, command=f'ollama run {config.OLLAMA_MODEL} "{config.OLLAMA_CHECK_PROMPT}"')


def _set(state: str | None = None, message: str | None = None, **kw) -> None:
    with _lock:
        if state is not None:
            _state["state"] = state
        if message is not None:
            _state["message"] = message
        _state.update(kw)
        _state["updated"] = time.time()


def _hidden() -> dict:
    """Process options that keep a console window from appearing on Windows (and detach the child from ours elsewhere)."""
    if os.name == "nt":
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = 0
        return {"creationflags": 0x08000000, "startupinfo": si}          # CREATE_NO_WINDOW
    return {"start_new_session": True}


def _host_env() -> dict:
    u = urlparse(config.OLLAMA_URL)
    env = dict(os.environ)
    if u.hostname:
        env["OLLAMA_HOST"] = f"{u.hostname}:{u.port or 11434}"
    return env


# ------------------------------------------------------------------ steps
def find_binary() -> str | None:
    cands = []
    if config.OLLAMA_BIN:
        cands.append(config.OLLAMA_BIN)
    found = shutil.which("ollama")
    if found:
        cands.append(found)
    if os.name == "nt":
        for base in (os.environ.get("LOCALAPPDATA"), os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
            if base:
                cands += [os.path.join(base, "Programs", "Ollama", "ollama.exe"), os.path.join(base, "Ollama", "ollama.exe")]
    elif sys.platform == "darwin":
        cands += ["/Applications/Ollama.app/Contents/Resources/ollama", "/usr/local/bin/ollama", "/opt/homebrew/bin/ollama"]
    else:
        cands += ["/usr/local/bin/ollama", "/usr/bin/ollama"]
    return next((c for c in cands if c and os.path.isfile(c) and os.access(c, os.X_OK)), None)


def server_up(timeout: float = 1.0) -> bool:
    try:
        return requests.get(config.OLLAMA_URL.rstrip("/") + "/api/version", timeout=timeout).status_code == 200
    except Exception:
        return False


def installed_models() -> list[str]:
    try:
        r = requests.get(config.OLLAMA_URL.rstrip("/") + "/api/tags", timeout=3)
        return [m.get("name", "") for m in r.json().get("models", [])] if r.status_code == 200 else []
    except Exception:
        return []


def has_model(model: str) -> bool:
    want = model if ":" in model else model + ":latest"
    return any(n == want or n == model for n in installed_models())


def start_server(binary: str, wait: float = 60.0) -> bool:
    global _server
    _set("starting", "Starting Ollama…")
    _server = subprocess.Popen([binary, "serve"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=_host_env(), **_hidden())
    _set(started_server=True)
    end = time.time() + wait
    while time.time() < end:
        if server_up():
            return True
        if _server.poll() is not None:
            return server_up()
        time.sleep(0.4)
    return False


def pull(binary: str, model: str) -> None:
    """Download the model; progress (0-100) is reported while it comes down."""
    _set("pulling", f"Downloading {model} (first time only)…", progress=0)
    try:
        with requests.post(config.OLLAMA_URL.rstrip("/") + "/api/pull", json={"model": model, "name": model, "stream": True}, stream=True, timeout=(5, 120)) as r:
            if r.status_code != 200:
                raise RuntimeError(f"Ollama answered {r.status_code}: {r.text[:200]}")
            import json as _json
            for line in r.iter_lines():
                if not line:
                    continue
                d = _json.loads(line)
                if d.get("error"):
                    raise RuntimeError(d["error"])
                if d.get("total"):
                    _set(progress=int(100 * (d.get("completed") or 0) / d["total"]), message=f"Downloading {model}: {int(100 * (d.get('completed') or 0) / d['total'])}%")
    except requests.RequestException:
        # the HTTP route failed: let the program itself do it
        r = subprocess.run([binary, "pull", model], capture_output=True, text=True, env=_host_env(), timeout=3 * 3600, **_hidden())
        if r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout or "ollama pull failed").strip()[-300:])
    _set(progress=100)


def run_check(binary: str, model: str, prompt: str, timeout: float = 900.0) -> tuple[bool, str]:
    """The literal check: `ollama run <model> "<prompt>"`. Loading the model can take a while the first time."""
    r = subprocess.run([binary, "run", model, prompt], stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8", errors="replace",
                       env=_host_env(), timeout=timeout, **_hidden())
    out = ANSI.sub("", r.stdout or "").strip()
    if r.returncode != 0:
        raise RuntimeError(ANSI.sub("", (r.stderr or out or f"exit code {r.returncode}")).strip()[-300:])
    return ("ready" in out.lower()), out


# ------------------------------------------------------------------ the whole check
def boot() -> dict:
    """Run the check now (blocking). Returns the final status."""
    try:
        _set("checking", "Looking for Ollama…", progress=None, reply="", started_server=False)
        binary = find_binary()
        if not binary:
            if server_up():       # a server without the program on this machine (remote or container): just use it
                binary = ""
            else:
                _set("missing", "Ollama is not installed. Get it free from ollama.com, then start this program again.", binary="")
                return status()
        _set(binary=binary or "")
        if not server_up():
            if not binary or not start_server(binary):
                _set("error", "Ollama did not start. Open it once from the Start menu, or run: ollama serve")
                return status()
        model = config.OLLAMA_MODEL
        if not has_model(model):
            if not config.OLLAMA_AUTOPULL or not binary:
                _set("error", f"The model {model} is not installed. Run: ollama pull {model}")
                return status()
            pull(binary, model)
            if not has_model(model):
                _set("error", f"Could not install {model}. Run: ollama pull {model}")
                return status()
        if not binary:
            _set("ready", f"{model} is available.", progress=None)
            return status()
        _set("warming", f"Loading {model}…", progress=None)
        ok, reply = run_check(binary, model, config.OLLAMA_CHECK_PROMPT)
        from . import llm
        llm.forget_ollama()                                   # the answer writer should notice the model straight away
        last = (reply.strip().splitlines() or [""])[-1][:120]
        _set("ready", f"{model} is ready." if ok else f"{model} answered, but not with \"ready\": {last}", reply=reply[-400:], progress=None)
    except subprocess.TimeoutExpired:
        _set("error", f"{config.OLLAMA_MODEL} took too long to answer. It may still be loading; try again in a minute.")
    except Exception as e:                                      # never let a start-up check take the portal down
        _set("error", str(e)[:300] or "Ollama check failed.")
    return status()


def wanted() -> bool:
    """Start Ollama only when it could be used: not when the saved choice is Claude, Off, or another server."""
    mode = config.OLLAMA_BOOT
    if mode in ("0", "off", "false", "no", "never"):
        return False
    if mode in ("1", "on", "true", "yes", "always"):
        return True
    s = settings.load()
    p = (s.get("provider") or "auto").lower()
    if p in ("anthropic", "off", "none"):
        return False
    if p == "openai":
        base = (s.get("openai_base") or "").lower()
        return "11434" in base or "ollama" in base
    return True


def boot_async(force: bool = False) -> dict:
    """Start the check in the background (once at a time) and return at once."""
    global _thread
    if not force and not wanted():
        _set("disabled", "Ollama is not started: written answers use another choice in Settings.")
        return status()
    with _lock:
        if _thread and _thread.is_alive():
            return dict(_state)
        _thread = threading.Thread(target=boot, name="ollama-boot", daemon=True)
    _set("checking", "Looking for Ollama…")
    _thread.start()
    return status()


def stop_own_server() -> None:
    """Stop the Ollama server only if this program started it (an Ollama that was already running is left alone)."""
    global _server
    if _server and _server.poll() is None:
        try:
            _server.terminate()
            _server.wait(5)
        except Exception:
            try:
                _server.kill()
            except Exception:
                pass
    _server = None


atexit.register(stop_own_server)
