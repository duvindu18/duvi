"""Component provisioning, run by VeilSetup.exe with the bundled Python.

The NSIS installer extracts the app, a private Python 3.11 and an offline
wheelhouse, then calls this script with the components chosen on the
"Choose Components" page. Output is streamed into the installer's progress
log, so every step prints a short, human-readable line.

Exit codes
    0  everything selected was installed and verified
    2  the app works, but an optional component failed (fell back gracefully)
    1  the core application could not be installed
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent  # %ProgramFiles%\Veil
PY = Path(sys.executable)
APP = ROOT / "app"
WHEELS = ROOT / "wheels"
REQ = ROOT / "requirements"
MODELS = APP / "models"

ORT_FLAVOURS = ["onnxruntime", "onnxruntime-gpu", "onnxruntime-directml", "onnxruntime-openvino"]
VC_REDIST_URL = "https://aka.ms/vs/17/release/vc_redist.x64.exe"
# ONNX Runtime 1.19.x is built against TensorRT 10.2 / CUDA 12.x.
TENSORRT_URL = (
    "https://developer.nvidia.com/downloads/compute/machine-learning/tensorrt/10.2.0/zip/"
    "TensorRT-10.2.0.19.Windows.win10.cuda-12.5.zip"
)

warnings: list[str] = []
_log_file = None


def say(msg: str) -> None:
    """Print to the installer's details list and append to install.log."""
    print(msg, flush=True)
    if _log_file is not None:
        _log_file.write(msg + "\n")
        _log_file.flush()


def step(msg: str) -> None:
    say("")
    say(f"== {msg}")


def pip(*args: str, online: bool = False) -> bool:
    cmd = [str(PY), "-E", "-s", "-m", "pip", "--disable-pip-version-check", "--no-input"]
    cmd += list(args)
    if args and args[0] == "install":
        cmd += ["--no-cache-dir", "--progress-bar", "off", "--no-warn-script-location", "--find-links", str(WHEELS), "-c", str(REQ / "constraints.txt")]
        if not online:
            cmd.append("--no-index")
    say("   pip " + " ".join(a for a in args))
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace")
    for line in proc.stdout.splitlines():
        line = line.strip()
        if line and not line.startswith(("Looking in", "Requirement already satisfied")):
            say("   " + line[:200])
    return proc.returncode == 0


def download(url: str, dest: Path, label: str, retries: int = 3) -> bool:
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "VeilSetup/1.0"})
            with urllib.request.urlopen(req, timeout=60) as resp, dest.open("wb") as out:
                total = int(resp.headers.get("Content-Length") or 0)
                done, last = 0, -1
                while chunk := resp.read(1 << 20):
                    out.write(chunk)
                    done += len(chunk)
                    if total:
                        pct = done * 100 // total
                        if pct // 10 != last:
                            last = pct // 10
                            say(f"   {label}: {pct}% of {total / 1e6:.0f} MB")
            return True
        except Exception as exc:  # network errors, HTTP errors, disk errors
            say(f"   {label}: attempt {attempt}/{retries} failed ({exc})")
            time.sleep(2 * attempt)
    return False


# ---------------------------------------------------------------------------
def install_vc_redist() -> None:
    step("Microsoft Visual C++ 2015-2022 Runtime")
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64") as key:
            if winreg.QueryValueEx(key, "Installed")[0] == 1:
                say("   already installed")
                return
    except OSError:
        pass
    exe = Path(tempfile.gettempdir()) / "vc_redist.x64.exe"
    if not download(VC_REDIST_URL, exe, "vc_redist"):
        warnings.append("Visual C++ Runtime could not be downloaded; install it from https://aka.ms/vs/17/release/vc_redist.x64.exe")
        return
    code = subprocess.call([str(exe), "/install", "/quiet", "/norestart"])
    if code in (0, 1638, 3010):
        say("   installed" + (" (restart recommended)" if code == 3010 else ""))
    else:
        warnings.append(f"Visual C++ Runtime installer exited with code {code}")
    exe.unlink(missing_ok=True)


def install_core() -> bool:
    step("Core application packages (offline)")
    return pip("install", "-r", str(REQ / "core.txt"))


def install_runtime(accel: str) -> str:
    """Install one ONNX Runtime flavour; returns the flavour actually installed."""
    step(f"Inference runtime: {accel}")
    pip("uninstall", "-y", *ORT_FLAVOURS)
    if accel == "cuda":
        if not Path(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "nvcuda.dll").exists():
            warnings.append("No NVIDIA driver found (nvcuda.dll). Install driver >= 551.61 from nvidia.com for CUDA.")
        say("   downloading ONNX Runtime GPU + CUDA 12 / cuDNN 9 libraries (about 1.3 GB)...")
        if pip("install", "-r", str(REQ / "cuda.txt"), online=True):
            return "cuda"
        warnings.append("CUDA runtime download failed - installed DirectML instead (re-run setup to retry).")
        accel = "directml"
    if accel == "openvino":
        say("   downloading ONNX Runtime OpenVINO (about 70 MB)...")
        if pip("install", "-r", str(REQ / "openvino.txt"), online=True):
            return "openvino"
        warnings.append("OpenVINO download failed - installed DirectML instead (re-run setup to retry).")
        accel = "directml"
    if accel == "directml":
        if pip("install", "onnxruntime-directml"):
            return "directml"
        warnings.append("DirectML runtime failed to install - using CPU runtime.")
    if pip("install", "onnxruntime"):
        return "cpu"
    raise RuntimeError("No ONNX Runtime package could be installed.")


def install_tensorrt() -> None:
    step("NVIDIA TensorRT 10.2 (optional)")
    if os.environ.get("TENSORRT_PATH") and Path(os.environ["TENSORRT_PATH"], "lib").is_dir():
        say(f"   using existing TensorRT at {os.environ['TENSORRT_PATH']}")
        return
    target = ROOT / "runtimes"
    if any(target.glob("TensorRT*/lib/nvinfer_10.dll")):
        say("   already installed")
        return
    archive = Path(tempfile.gettempdir()) / "tensorrt.zip"
    if not download(TENSORRT_URL, archive, "TensorRT"):
        warnings.append(
            "TensorRT could not be downloaded (NVIDIA may require sign-in). CUDA acceleration is still active. "
            "To add TensorRT later, unzip TensorRT 10.x for CUDA 12 and set TENSORRT_PATH."
        )
        return
    try:
        with zipfile.ZipFile(archive) as zf:
            for member in zf.namelist():
                parts = Path(member).parts
                if len(parts) >= 3 and parts[1] == "lib" and member.lower().endswith(".dll"):
                    dest = target / parts[0] / "lib" / parts[-1]
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    with zf.open(member) as src, dest.open("wb") as out:
                        shutil.copyfileobj(src, out)
        say("   installed")
    except zipfile.BadZipFile:
        warnings.append("TensorRT download was corrupted; CUDA acceleration is still active.")
    finally:
        archive.unlink(missing_ok=True)


def install_models(names: list[str]) -> None:
    step("Face models")
    os.environ["VEIL_MODELS_DIR"] = str(MODELS)
    os.environ["VEIL_CACHE_DIR"] = str(Path(tempfile.gettempdir()) / "veil-setup-cache")
    sys.path.insert(0, str(APP))
    from app.core import models  # stdlib-only module

    def progress(name: str, done: int, total: int, _state={"last": ("", -1)}) -> None:
        if total:
            decile = done * 10 // total
            if _state["last"] != (name, decile):
                _state["last"] = (name, decile)
                say(f"   {name}: {decile * 10}% of {total / 1e6:.0f} MB")

    for name in names:
        try:
            if name in models.INSIGHTFACE_PACKS:
                models.ensure_pack(name, progress)
            elif name == "yunet":
                models.ensure_model(models.YUNET, progress)
                models.ensure_model(models.SFACE, progress)
            say(f"   {name}: ready")
        except Exception as exc:
            warnings.append(f"Model '{name}' could not be downloaded ({exc}). The app will retry on first use.")


def verify(accel: str) -> None:
    step("Verifying installation")
    code = (
        "import sys; sys.path.insert(0, r'%s');"
        "import cv2, numpy, onnxruntime as ort;"
        "from PySide6 import QtWidgets;"
        "print('   OpenCV', cv2.__version__, '| NumPy', numpy.__version__, '| ONNX Runtime', ort.__version__);"
        "print('   providers:', ', '.join(ort.get_available_providers()))"
    ) % APP
    env = dict(os.environ, VEIL_MODELS_DIR=str(MODELS))
    out = subprocess.run([str(PY), "-E", "-s", "-c", code], capture_output=True, text=True, env=env)
    say(out.stdout.rstrip() or "   (no output)")
    if out.returncode != 0:
        say(out.stderr[-1500:])
        raise RuntimeError("The application packages failed to import.")
    sys.path.insert(0, str(APP))
    from app.core import models

    pack = next((p for p in ("buffalo_l", "buffalo_s") if models.pack_ready(p)), None)
    if accel != "cpu" and pack:
        probe = (
            "import sys; sys.path.insert(0, r'%s'); import main;"
            "from app.core.config import EngineConfig, Device;"
            "from app.core.engine import FaceEngine;"
            "e = FaceEngine(EngineConfig(device=Device('%s'), insightface_pack='%s')); print('   engine:', e.describe())"
        ) % (APP, accel, pack)
        res = subprocess.run([str(PY), "-E", "-s", "-c", probe], capture_output=True, text=True, env=env, cwd=str(APP))
        say(res.stdout.rstrip() or res.stderr.strip()[-600:])
        if res.returncode != 0 or (accel not in res.stdout and "tensorrt" not in res.stdout):
            warnings.append(f"{accel} acceleration could not be verified; the app will fall back automatically.")


def set_path(add: bool) -> None:
    import ctypes
    import winreg

    key_path = r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key_path, 0, winreg.KEY_READ | winreg.KEY_WRITE) as key:
        value, kind = winreg.QueryValueEx(key, "Path")
        parts = [p for p in value.split(";") if p and os.path.normcase(p.rstrip("\\")) != os.path.normcase(str(ROOT))]
        if add:
            parts.append(str(ROOT))
        winreg.SetValueEx(key, "Path", 0, kind, ";".join(parts))
    HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG = 0xFFFF, 0x1A, 0x2
    ctypes.windll.user32.SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, "Environment", SMTO_ABORTIFHUNG, 3000, None)


# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--accel", choices=["cuda", "directml", "openvino", "cpu"], default="cpu")
    ap.add_argument("--tensorrt", action="store_true")
    ap.add_argument("--vcredist", action="store_true")
    ap.add_argument("--models", default="", help="comma list: buffalo_l,buffalo_s,yunet")
    ap.add_argument("--add-path", action="store_true")
    ap.add_argument("--remove-path", action="store_true")
    ap.add_argument("--keep-wheels", action="store_true")
    args = ap.parse_args()

    if args.remove_path:
        set_path(False)
        return 0

    global _log_file
    _log_file = (ROOT / "install.log").open("w", encoding="utf-8")
    say(f"Veil {time.strftime('%Y-%m-%d %H:%M')} component setup: accel={args.accel} models={args.models or '-'}")
    say(f"Veil component setup - Python {sys.version.split()[0]} at {PY.parent}")
    try:
        if args.vcredist:
            install_vc_redist()
        if not install_core():
            say("!! Core packages failed to install.")
            return 1
        accel = install_runtime(args.accel)
        if args.tensorrt and accel == "cuda":
            install_tensorrt()
        models = [m for m in args.models.split(",") if m]
        if models:
            install_models(models)
        verify(accel)
        if args.add_path:
            set_path(True)
    except Exception as exc:
        say(f"!! {exc}")
        return 1
    finally:
        if not args.keep_wheels:
            shutil.rmtree(WHEELS, ignore_errors=True)

    if warnings:
        step("Finished with warnings")
        for w in warnings:
            say(f"   - {w}")
        return 2
    step("All components installed successfully")
    return 0


if __name__ == "__main__":
    sys.exit(main())
