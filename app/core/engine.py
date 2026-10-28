"""Face detection + embedding engines with automatic hardware fallback.

Two backends implement the same small interface:

* :class:`InsightFaceBackend` - SCRFD detector and ArcFace recognizer from the
  InsightFace ``buffalo_*`` packs, run directly by ONNX Runtime (no insightface
  package needed) on TensorRT, CUDA, DirectML, OpenVINO or CPU.
* :class:`YuNetBackend` - OpenCV's YuNet detector and SFace recognizer. Tiny,
  dependency-free and fast on CPU; uses the OpenCV DNN CUDA backend when OpenCV
  was compiled with CUDA.

:class:`FaceEngine` wraps a backend and transparently rebuilds it on the next
device of the fallback chain when the GPU runs out of memory or a provider fails
at runtime, so the processing thread never dies because of the accelerator.
"""

from __future__ import annotations

import logging
import threading
from abc import ABC, abstractmethod
from typing import Callable

import cv2
import numpy as np

from app.core import hardware
from app.core.angles import COVERAGE_PRESETS, MultiAngleDetector
from app.core.config import Backend, Device, EngineConfig
from app.core.engine_types import Detection
from app.core.models import SFACE, YUNET, ensure_model, ensure_pack
from app.core.scrfd_arcface import SCRFD, ArcFace, make_session
from app.utils.errors import ModelError, is_gpu_oom

log = logging.getLogger(__name__)

# ArcFace canonical 112x112 landmark template (used for alignment).
_ARCFACE_DST = np.array(
    [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]],
    dtype=np.float32,
)


def l2_normalize(v: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.maximum(norm, 1e-12)


def align_face(frame: np.ndarray, kps: np.ndarray, size: int = 112) -> np.ndarray:
    """Similarity-transform a face onto the ArcFace template."""
    dst = _ARCFACE_DST * (size / 112.0)
    matrix, _ = cv2.estimateAffinePartial2D(kps.astype(np.float32), dst, method=cv2.LMEDS)
    if matrix is None:
        raise ValueError("Degenerate landmarks")
    return cv2.warpAffine(frame, matrix, (size, size), borderValue=0.0)


def _aligned_crops(frame: np.ndarray, detections: list[Detection]) -> tuple[list[np.ndarray], list[int]]:
    """Aligned crops plus their indices; faces without usable landmarks are skipped
    and keep an all-zero embedding (similarity 0 = never matches anyone)."""
    crops: list[np.ndarray] = []
    slots: list[int] = []
    for i, det in enumerate(detections):
        if det.kps is None:
            continue
        try:
            crops.append(align_face(frame, det.kps, 112))
            slots.append(i)
        except (ValueError, cv2.error):
            continue
    return crops, slots


def auto_det_size(cfg: EngineConfig, device: Device) -> int:
    """Detector input resolution. ``0`` (default) picks 960 on GPUs, which finds
    faces down to ~10 px in 1080p, and 640 on CPU to keep the preview real-time."""
    if cfg.det_size > 0:
        return int(cfg.det_size) // 32 * 32
    return 960 if hardware.is_gpu(device) else 640


class BaseBackend(ABC):
    backend: Backend
    embedding_dim: int
    recommended_threshold: float

    def __init__(self, cfg: EngineConfig, device: Device) -> None:
        self.cfg = cfg
        self.device = device

    @abstractmethod
    def detect(self, frame: np.ndarray, scale: float = 1.0) -> list[Detection]:
        """``scale`` > 1 enlarges the detector input proportionally (used for the
        larger canvases of rotated passes so small faces keep their resolution)."""

    @abstractmethod
    def embed(self, frame: np.ndarray, detections: list[Detection]) -> np.ndarray: ...

    @property
    def tag(self) -> str:
        """Identifies the embedding space; caches are invalid across tags."""
        return self.backend.value

    def close(self) -> None:  # pragma: no cover - backends free memory on GC
        pass


class InsightFaceBackend(BaseBackend):
    backend = Backend.INSIGHTFACE
    embedding_dim = 512
    recommended_threshold = 0.40

    def __init__(self, cfg: EngineConfig, device: Device) -> None:
        super().__init__(cfg, device)
        try:
            import onnxruntime  # noqa: F401
        except Exception as exc:  # ImportError or a DLL load failure on Windows
            raise ModelError(f"ONNX Runtime is not installed or failed to load: {exc}") from exc
        det_path, rec_path = ensure_pack(cfg.insightface_pack)
        providers, options = hardware.providers_for(device, cfg)
        log.info("Loading %s on %s", cfg.insightface_pack, providers)
        try:
            det_session = make_session(det_path, providers, options, cfg.cpu_threads)
            rec_session = make_session(rec_path, providers, options, cfg.cpu_threads)
            self._det = SCRFD(det_session, auto_det_size(cfg, device))
            self._rec = ArcFace(rec_session)
        except Exception as exc:
            raise ModelError(f"Failed to initialise {cfg.insightface_pack} on {device.value}: {exc}") from exc
        active = det_session.get_providers()
        log.info("Active providers: %s", active)
        if device != Device.CPU and active and active[0] == "CPUExecutionProvider":
            # ONNX Runtime silently falls back when CUDA/cuDNN DLLs are missing.
            raise ModelError(f"{device.value} provider could not be initialised (missing runtime DLLs?)")

    @property
    def tag(self) -> str:
        return f"insightface-{self.cfg.insightface_pack}"

    def detect(self, frame: np.ndarray, scale: float = 1.0) -> list[Detection]:
        size = None
        if scale > 1.01:
            side = int(round(self._det.input_size[0] * min(scale, 2.0) / 32)) * 32
            size = (side, side)
        bboxes, kpss = self._det.detect(frame, self.cfg.det_low_threshold, size)
        out: list[Detection] = []
        min_px = self.cfg.min_face_px
        for i, row in enumerate(bboxes):
            box = row[:4].astype(np.float32)
            if (box[2] - box[0]) < min_px or (box[3] - box[1]) < min_px:
                continue
            kps = kpss[i] if kpss is not None else None
            out.append(Detection(bbox=box, score=float(row[4]), kps=kps))
        return out

    def embed(self, frame: np.ndarray, detections: list[Detection]) -> np.ndarray:
        out = np.zeros((len(detections), self.embedding_dim), dtype=np.float32)
        crops, slots = _aligned_crops(frame, detections)
        if crops:
            feats = np.asarray(self._rec.embed(crops), dtype=np.float32).reshape(len(crops), -1)
            out[slots] = l2_normalize(feats)
        return out


class YuNetBackend(BaseBackend):
    backend = Backend.YUNET
    embedding_dim = 128
    recommended_threshold = 0.363

    def __init__(self, cfg: EngineConfig, device: Device) -> None:
        super().__init__(cfg, device)
        if not hasattr(cv2, "FaceDetectorYN"):
            raise ModelError("This OpenCV build lacks FaceDetectorYN (need OpenCV >= 4.8).")
        det_path = ensure_model(YUNET)
        rec_path = ensure_model(SFACE)
        use_cuda = hardware.is_gpu(device) and hardware.opencv_cuda_device_count() > 0
        backend_id = cv2.dnn.DNN_BACKEND_CUDA if use_cuda else cv2.dnn.DNN_BACKEND_OPENCV
        target_id = cv2.dnn.DNN_TARGET_CUDA_FP16 if use_cuda else cv2.dnn.DNN_TARGET_CPU
        if hardware.is_gpu(device) and not use_cuda:
            log.info("OpenCV was built without CUDA; YuNet runs on CPU.")
            self.device = Device.CPU
        try:
            self._det = cv2.FaceDetectorYN.create(
                str(det_path), "", (320, 320), cfg.det_low_threshold, 0.3, 5000, backend_id, target_id
            )
            self._rec = cv2.FaceRecognizerSF.create(str(rec_path), "", backend_id, target_id)
        except cv2.error as exc:
            raise ModelError(f"Failed to load YuNet/SFace: {exc}") from exc
        self._input_size: tuple[int, int] | None = None

    def detect(self, frame: np.ndarray, scale: float = 1.0) -> list[Detection]:
        h, w = frame.shape[:2]
        scale = min(1.0, max(320, self.cfg.det_size or 960) * min(scale, 2.0) / max(h, w))
        img = cv2.resize(frame, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA) if scale < 1 else frame
        size = (img.shape[1], img.shape[0])
        if size != self._input_size:
            self._det.setInputSize(size)
            self._input_size = size
        _, faces = self._det.detect(img)
        out: list[Detection] = []
        if faces is None:
            return out
        inv = 1.0 / scale
        for row in faces:
            x, y, bw, bh = row[:4] * inv
            if bw < self.cfg.min_face_px or bh < self.cfg.min_face_px:
                continue
            kps = (row[4:14].reshape(5, 2) * inv).astype(np.float32)
            box = np.array([x, y, x + bw, y + bh], dtype=np.float32)
            out.append(Detection(bbox=box, score=float(row[14]), kps=kps))
        return out

    def embed(self, frame: np.ndarray, detections: list[Detection]) -> np.ndarray:
        out = np.zeros((len(detections), self.embedding_dim), dtype=np.float32)
        # SFace uses the same 112x112 template as FaceRecognizerSF.alignCrop.
        crops, slots = _aligned_crops(frame, detections)
        for crop, slot in zip(crops, slots):
            out[slot] = l2_normalize(self._rec.feature(crop).reshape(-1).astype(np.float32))
        return out


_BACKENDS: dict[Backend, type[BaseBackend]] = {
    Backend.INSIGHTFACE: InsightFaceBackend,
    Backend.YUNET: YuNetBackend,
}

WarningFn = Callable[[str], None]


class FaceEngine:
    """Thread-safe facade with GPU out-of-memory recovery.

    Calls are serialised with a lock: ONNX Runtime sessions are thread-safe, but
    a rebuild after an OOM must never race with an in-flight inference.
    """

    def __init__(self, cfg: EngineConfig, on_warning: WarningFn | None = None) -> None:
        self.cfg = cfg
        self._on_warning = on_warning or (lambda msg: log.warning(msg))
        self._lock = threading.RLock()
        hardware.configure_cpu_threads(cfg)
        self._chain = hardware.resolve_chain(cfg)
        self._backend: BaseBackend = self._build_from(0)
        angles = COVERAGE_PRESETS.get(cfg.rotation_coverage, COVERAGE_PRESETS["full"])
        self._multi = MultiAngleDetector(
            lambda f, k=1.0: self._run("detect", f, k), angles, self._passes_per_frame(), cfg.det_threshold
        )

    # ---- construction ------------------------------------------------
    def _build_from(self, start: int) -> BaseBackend:
        errors: list[str] = []
        backend_cls = _BACKENDS[self.cfg.backend]
        for idx in range(start, len(self._chain)):
            device = self._chain[idx]
            try:
                backend = backend_cls(self.cfg, device)
                self._chain_pos = idx
                log.info("Engine ready: %s on %s", self.cfg.backend.value, backend.device.value)
                return backend
            except Exception as exc:
                errors.append(f"{device.value}: {exc}")
                log.warning("Backend %s failed on %s: %s", self.cfg.backend.value, device.value, exc)
        if self.cfg.backend != Backend.YUNET:
            # Last resort: the lightweight OpenCV models work everywhere.
            self._on_warning("InsightFace could not be loaded; falling back to OpenCV YuNet/SFace on CPU.")
            try:
                backend = YuNetBackend(self.cfg, Device.CPU)
                self._chain = [Device.CPU]
                self._chain_pos = 0
                return backend
            except Exception as exc:
                errors.append(f"yunet/cpu: {exc}")
        raise ModelError("No face engine could be initialised:\n" + "\n".join(errors))

    def _fallback(self, exc: BaseException) -> None:
        current = self._backend.device
        log.error("Inference failure on %s: %s", current.value, exc)
        if self._chain_pos + 1 >= len(self._chain):
            raise ModelError(f"Inference failed on the last available device ({current.value}): {exc}") from exc
        self._backend.close()
        del self._backend
        self._backend = self._build_from(self._chain_pos + 1)
        reason = "GPU out of memory" if is_gpu_oom(exc) else "runtime error"
        self._on_warning(f"{reason} on {current.value}; switched to {self._backend.device.value}.")

    def _run(self, fn_name: str, *args):
        with self._lock:
            for _ in range(len(self._chain) + 1):
                try:
                    return getattr(self._backend, fn_name)(*args)
                except (ValueError, cv2.error) as exc:
                    # Bad geometry / degenerate input is a data problem, not a device problem.
                    if is_gpu_oom(exc):
                        self._fallback(exc)
                        continue
                    raise
                except ModelError:
                    raise
                except Exception as exc:
                    if is_gpu_oom(exc) or hardware.is_gpu(self._backend.device):
                        self._fallback(exc)
                        continue
                    raise
            raise ModelError("Exhausted all devices")

    # ---- public API --------------------------------------------------
    def _passes_per_frame(self) -> int:
        if self.cfg.rotation_passes > 0:
            return self.cfg.rotation_passes
        return 2 if hardware.is_gpu(self._backend.device) else 1

    def detect(self, frame: np.ndarray, exhaustive: bool = False) -> list[Detection]:
        """Upright pass plus scheduled rotated passes (``exhaustive``: all angles)."""
        self._multi.scheduler.per_frame = self._passes_per_frame()  # device may have changed
        return self._multi.detect(frame, exhaustive)

    def embed(self, frame: np.ndarray, detections: list[Detection]) -> np.ndarray:
        if not detections:
            return np.zeros((0, self._backend.embedding_dim), dtype=np.float32)
        return self._run("embed", frame, detections)

    @property
    def device(self) -> Device:
        return self._backend.device

    @property
    def tag(self) -> str:
        return self._backend.tag

    @property
    def recommended_threshold(self) -> float:
        return self._backend.recommended_threshold

    def describe(self) -> str:
        return f"{self._backend.backend.value} · {self._backend.device.value}"
