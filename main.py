"""Veil - real-time face detection, recognition and anonymization.

Usage
-----
GUI (default)::

    python main.py

Headless export (no window, all frames processed, progress on stdout)::

    python main.py --headless -i input.mp4 -o output.mp4 --policy all --style gaussian

Live headless recording from a webcam / RTSP stream (Ctrl+C to stop)::

    python main.py --headless -i webcam:0 -o recording.mp4
    python main.py --headless -i rtsp://user:pass@camera/stream -o cam.mp4

Hardware report::

    python main.py --hardware
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
import time

# Must be set before cv2 is imported anywhere: prefer TCP for RTSP and keep
# FFmpeg quiet about recoverable stream glitches.
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp|max_delay;500000")
os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")
os.environ.setdefault("OPENCV_VIDEOIO_PRIORITY_MSMF", "0")  # DirectShow first: faster webcam start-up


def _register_windows_dll_dirs() -> None:
    """Expose CUDA / cuDNN / TensorRT DLLs to ONNX Runtime and OpenCV.

    Since Python 3.8, extension modules ignore PATH when resolving dependent
    DLLs, so the directories are registered explicitly as well.
    """
    if sys.platform != "win32":
        return
    import glob

    candidates: list[str] = []
    for var, subdirs in (("CUDA_PATH", ["bin"]), ("CUDNN_PATH", ["bin", "bin/12.*"]), ("TENSORRT_PATH", ["lib"])):
        base = os.environ.get(var)
        if base:
            for sub in subdirs:
                candidates.extend(glob.glob(os.path.join(base, sub)))
    # CUDA / cuDNN shipped as pip wheels (nvidia-*-cu12) by the installer, and
    # TensorRT unpacked next to the app.
    import sysconfig

    site = sysconfig.get_paths()["purelib"]
    candidates.extend(glob.glob(os.path.join(site, "nvidia", "*", "bin")))
    here = os.path.dirname(os.path.abspath(__file__))
    candidates.extend(glob.glob(os.path.join(here, "..", "runtimes", "TensorRT*", "lib")))
    for d in candidates:
        if os.path.isdir(d):
            try:
                os.add_dll_directory(d)
            except OSError:
                continue
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


_register_windows_dll_dirs()


def _register_openvino() -> None:
    """onnxruntime-openvino on Windows needs the OpenVINO runtime DLLs on the path."""
    if sys.platform != "win32":
        return
    try:
        import onnxruntime.tools.add_openvino_win_libs as ov_libs  # type: ignore[import-not-found]

        ov_libs.add_openvino_libs_to_path()
    except Exception:
        pass


_register_openvino()

from app import __app_name__, __version__  # noqa: E402
from app.utils.logging_setup import setup_logging  # noqa: E402


def _parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="veil", description=f"{__app_name__} {__version__}")
    p.add_argument("--headless", action="store_true", help="run without the GUI")
    p.add_argument("-i", "--input", help="video file, webcam index (0 / webcam:0) or stream URL")
    p.add_argument("-o", "--output", help="output video path (.mp4 / .avi / .mkv)")
    p.add_argument("--policy", choices=["all", "unknown", "targets", "whitelist", "none"])
    p.add_argument("--style", choices=["gaussian", "pixelate", "blackbox", "mask"])
    p.add_argument("--intensity", type=int, help="1-100")
    p.add_argument("--mask", help="PNG used by --style mask")
    p.add_argument("--whitelist", nargs="*", help="identities that stay visible (policy whitelist)")
    p.add_argument("--targets", nargs="*", help="identities to hide (policy targets)")
    p.add_argument("--faces", help="identity folder (one sub-folder per person)")
    p.add_argument("--backend", choices=["insightface", "yunet"])
    p.add_argument("--device", choices=["auto", "tensorrt", "cuda", "directml", "openvino", "cpu"])
    p.add_argument("--no-recognition", action="store_true")
    p.add_argument("--hardware", action="store_true", help="print the hardware / provider report and exit")
    p.add_argument("-v", "--verbose", action="store_true")
    return p.parse_args(argv)


def _apply_overrides(cfg, args: argparse.Namespace) -> None:
    from app.core.config import Backend, Device, Policy, Style

    if args.policy:
        cfg.anonymize.policy = Policy(args.policy)
    if args.style:
        cfg.anonymize.style = Style(args.style)
    if args.intensity is not None:
        cfg.anonymize.intensity = max(1, min(100, args.intensity))
    if args.mask:
        cfg.anonymize.mask_path = args.mask
    if args.whitelist is not None:
        cfg.recognition.whitelist = args.whitelist
    if args.targets is not None:
        cfg.recognition.targets = args.targets
    if args.faces:
        cfg.recognition.faces_dir = args.faces
    if args.backend:
        cfg.engine.backend = Backend(args.backend)
    if args.device:
        cfg.engine.device = Device(args.device)
    if args.no_recognition:
        cfg.recognition.enabled = False


def run_headless(args: argparse.Namespace) -> int:
    from app.core.config import AppConfig
    from app.core.face_db import FaceDatabase
    from app.core.pipeline import Pipeline, PipelineCallbacks
    from app.core.sources import SourceSpec

    if not args.input or not args.output:
        print("error: --headless needs --input and --output", file=sys.stderr)
        return 2
    cfg = AppConfig.load()
    _apply_overrides(cfg, args)
    spec = SourceSpec.parse(args.input)
    state = {"last": 0.0, "error": None}
    t0 = time.monotonic()

    def progress(done: int, total: int) -> None:
        now = time.monotonic()
        if now - state["last"] < 0.5 and done < total:
            return
        state["last"] = now
        rate = done / max(1e-6, now - t0)
        eta = (total - done) / rate if rate > 0 else 0
        bar = "#" * int(30 * done / total)
        sys.stdout.write(f"\r[{bar:<30}] {done}/{total}  {rate:5.1f} fps  ETA {int(eta) // 60}:{int(eta) % 60:02d} ")
        sys.stdout.flush()

    def stats(s) -> None:
        if s.frame_count == 0:  # live source: no total to show
            sys.stdout.write(f"\r{s.frame_index} frames  {s.inference_fps:5.1f} fps  faces {s.faces}  [{s.device}]   ")
            sys.stdout.flush()

    callbacks = PipelineCallbacks(
        on_progress=progress,
        on_stats=stats,
        on_status=lambda m: logging.getLogger("veil").info(m),
        on_warning=lambda m: logging.getLogger("veil").warning(m),
        on_error=lambda m: state.update(error=m),
    )
    pipeline = Pipeline(
        cfg,
        spec,
        callbacks,
        display=False,
        realtime=spec.is_live,
        output_path=args.output,
        face_db=FaceDatabase(cfg.recognition.faces_dir) if cfg.recognition.enabled else None,
    )
    signal.signal(signal.SIGINT, lambda *_: pipeline.stop())
    pipeline.start()
    while not pipeline.wait(0.2):
        pass
    print()
    if state["error"]:
        print(f"error: {state['error']}", file=sys.stderr)
        return 1
    print(f"{pipeline.finish_reason}: {args.output}  ({time.monotonic() - t0:.1f}s)")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    setup_logging(logging.DEBUG if args.verbose else logging.INFO)
    if args.hardware:
        from app.core.hardware import probe

        print("\n".join(probe().lines()))
        return 0
    if args.headless:
        return run_headless(args)
    try:
        from app.gui.app import run_gui
    except Exception as exc:  # e.g. a missing DLL - pythonw.exe has no console to show it
        logging.getLogger("veil").exception("GUI failed to start")
        if sys.platform == "win32":
            import ctypes

            ctypes.windll.user32.MessageBoxW(
                None,
                f"Veil could not start:\n\n{exc}\n\nRun VeilSetup.exe again to repair the installation.",
                "Veil",
                0x10,
            )
        raise
    return run_gui(sys.argv[:1])


if __name__ == "__main__":
    sys.exit(main())
