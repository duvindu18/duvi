"""Face detection + embedding engines with automatic hardware fallback.

Two backends implement the same small interface:

* :class:`InsightFaceBackend` - SCRFD detector and ArcFace recognizer from the
  InsightFace ``buffalo_*`` packs, executed by ONNX Runtime on TensorRT, CUDA,
  DirectML, OpenVINO or CPU.
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
from dataclasses import dataclass
from typing import Callable

import cv2
import numpy as np

from app.core import hardware
from app.core.config import Backend, Device, EngineConfig
from app.core.models import SFACE, YUNET, ensure_model
from app.utils.errors import ModelError, is_gpu_oom
from app.utils.paths import models_dir

log = logging.getLogger(__name__)

# ArcFace canonical 112x112 landmark template (used for alignment).
_ARCFACE_DST = np.array(
    [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]],
    dtype=np.float32,
)


@dataclass
class Detection:
    bbox: np.ndarray  # (4,) float32 x1, y1, x2, y2 in frame pixels
    score: float
    kps: np.ndarray | None = None  # (5, 2) eyes, nose, mouth corners

    @property
    def width(self) -> float:
        return float(self.bbox[2] - self.bbox[0])

    @property
    def height(self) -> float:
        return float(self.bbox[3] - self.bbox[1])


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


class BaseBackend(ABC):
    backend: Backend
    embedding_dim: int
    recommended_threshold: float

    def __init__(self, cfg: EngineConfig, device: Device) -> None:
        self.cfg = cfg
        self.device = device

    @abstractmethod
    def detect(self, frame: np.ndarray) -> list[Detection]: ...

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
            from insightface.app import FaceAnalysis
        except Exception as exc:  # ImportError or a broken native extension
            raise ModelError(f"InsightFace is not installed or failed to import: {exc}") from exc

        providers, options = hardware.providers_for(device, cfg)
        log.info("Loading InsightFace '%s' on %s", cfg.insightface_pack, providers)
        try:
            app = FaceAnalysis(
                name=cfg.insightface_pack,
                root=str(models_dir() / "insightface"),
                allowed_modules=["detection", "recognition"],
                providers=providers,
                provider_options=options,
            )
            app.prepare(
                ctx_id=-1 if device == Device.CPU else cfg.gpu_id,
                det_thresh=cfg.det_low_threshold,
                det_size=(cfg.det_size, cfg.det_size),
            )
        except Exception as exc:
            raise ModelError(f"Failed to initialise InsightFace on {device.value}: {exc}") from exc
        self._det = app.det_model
        self._rec = app.models.get("recognition")
        if self._rec is None:
            raise ModelError(f"Model pack '{cfg.insightface_pack}' has no recognition model.")
        self._app = app
        active = self._det.session.get_providers()
        log.info("InsightFace active providers: %s", active)

    @property
    def tag(self) -> str:
        return f"insightface-{self.cfg.insightface_pack}"

    def detect(self, frame: np.ndarray) -> list[Detection]:
        bboxes, kpss = self._det.detect(frame, max_num=0, metric="default")
        out: list[Detection] = []
        if bboxes is None or len(bboxes) == 0:
            return out
        min_px = self.cfg.min_face_px
        for i, row in enumerate(bboxes):
            box = row[:4].astype(np.float32)
            if (box[2] - box[0]) < min_px or (box[3] - box[1]) < min_px:
                continue
            kps = kpss[i].astype(np.float32) if kpss is not None else None
            out.append(Detection(bbox=box, score=float(row[4]), kps=kps))
        return out

    def embed(self, frame: np.ndarray, detections: list[Detection]) -> np.ndarray:
        out = np.zeros((len(detections), self.embedding_dim), dtype=np.float32)
        crops, slots = _aligned_crops(frame, detections)
        if crops:
            feats = np.asarray(self._rec.get_feat(crops), dtype=np.float32).reshape(len(crops), -1)
            out[slots] = l2_normalize(feats)
        return out


class YuNetBackend(BaseBackend):
    backend = Backend.YUNET
    embedding_dim = 128
    recommended_threshold = 0.363
    _MAX_SIDE = 640

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

    def detect(self, frame: np.ndarray) -> list[Detection]:
        h, w = frame.shape[:2]
        scale = min(1.0, self._MAX_SIDE / max(h, w))
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
    def detect(self, frame: np.ndarray) -> list[Detection]:
        return self._run("detect", frame)

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
