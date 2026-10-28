"""Hardware discovery and ONNX Runtime execution-provider selection.

Fallback order for ``Device.AUTO``::

    TensorRT  ->  CUDA  ->  DirectML  ->  OpenVINO  ->  CPU

Only one ONNX Runtime flavour can be installed at a time (``onnxruntime-gpu``,
``onnxruntime-directml`` or ``onnxruntime-openvino``), so the chain simply skips
providers that the installed build does not expose. CPU is always appended as
the final safety net so a session can be created on any machine.
"""

from __future__ import annotations

import logging
import os
import platform
from dataclasses import dataclass, field
from typing import Any

from app.core.config import Device, EngineConfig
from app.utils.paths import trt_cache_dir

log = logging.getLogger(__name__)

_PROVIDER_NAMES = {
    Device.TENSORRT: "TensorrtExecutionProvider",
    Device.CUDA: "CUDAExecutionProvider",
    Device.DIRECTML: "DmlExecutionProvider",
    Device.OPENVINO: "OpenVINOExecutionProvider",
    Device.CPU: "CPUExecutionProvider",
}
_AUTO_ORDER = [Device.TENSORRT, Device.CUDA, Device.DIRECTML, Device.OPENVINO, Device.CPU]


@dataclass
class HardwareReport:
    os: str
    cpu: str
    cpu_cores: int
    ort_version: str | None
    ort_providers: list[str] = field(default_factory=list)
    opencv_version: str | None = None
    opencv_cuda_devices: int = 0
    cuda_device_name: str | None = None

    def lines(self) -> list[str]:
        return [
            f"OS: {self.os}",
            f"CPU: {self.cpu} ({self.cpu_cores} logical cores)",
            f"ONNX Runtime: {self.ort_version or 'not installed'}",
            f"ORT providers: {', '.join(self.ort_providers) or 'none'}",
            f"OpenCV: {self.opencv_version or 'not installed'}",
            f"OpenCV CUDA devices: {self.opencv_cuda_devices}"
            + (f" ({self.cuda_device_name})" if self.cuda_device_name else ""),
        ]


def available_ort_providers() -> list[str]:
    try:
        import onnxruntime as ort

        return list(ort.get_available_providers())
    except Exception as exc:  # ImportError, or DLL load failure on Windows
        log.warning("ONNX Runtime unavailable: %s", exc)
        return []


def opencv_cuda_device_count() -> int:
    try:
        import cv2

        return int(cv2.cuda.getCudaEnabledDeviceCount())
    except Exception:
        return 0


def probe() -> HardwareReport:
    ort_version = None
    try:
        import onnxruntime as ort

        ort_version = ort.__version__
    except Exception:
        pass
    cv_version = None
    cuda_name = None
    try:
        import cv2

        cv_version = cv2.__version__
        if opencv_cuda_device_count() > 0:
            dev = cv2.cuda.DeviceInfo(0)
            cuda_name = dev.name() if hasattr(dev, "name") else None
    except Exception:
        pass
    return HardwareReport(
        os=f"{platform.system()} {platform.release()} ({platform.version()})",
        cpu=platform.processor() or platform.machine(),
        cpu_cores=os.cpu_count() or 1,
        ort_version=ort_version,
        ort_providers=available_ort_providers(),
        opencv_version=cv_version,
        opencv_cuda_devices=opencv_cuda_device_count(),
        cuda_device_name=cuda_name,
    )


def _provider_options(device: Device, cfg: EngineConfig) -> dict[str, Any]:
    if device == Device.TENSORRT:
        return {
            "device_id": cfg.gpu_id,
            "trt_fp16_enable": bool(cfg.tensorrt_fp16),
            "trt_engine_cache_enable": True,
            "trt_engine_cache_path": str(trt_cache_dir()),
            "trt_timing_cache_enable": True,
            "trt_max_workspace_size": 2 * 1024**3,
        }
    if device == Device.CUDA:
        opts: dict[str, Any] = {
            "device_id": cfg.gpu_id,
            "arena_extend_strategy": "kSameAsRequested",
            "cudnn_conv_algo_search": "HEURISTIC",
            "do_copy_in_default_stream": True,
        }
        if cfg.gpu_mem_limit_mb > 0:
            opts["gpu_mem_limit"] = cfg.gpu_mem_limit_mb * 1024 * 1024
        return opts
    if device == Device.DIRECTML:
        return {"device_id": cfg.gpu_id}
    if device == Device.OPENVINO:
        return {"device_type": "GPU" if _openvino_has_gpu() else "CPU"}
    return {}


def _openvino_has_gpu() -> bool:
    try:
        import openvino as ov  # type: ignore[import-not-found]

        return any(d.startswith("GPU") for d in ov.Core().available_devices)
    except Exception:
        return False


def resolve_chain(cfg: EngineConfig) -> list[Device]:
    """Ordered list of devices to try, honouring the user's preference."""
    available = set(available_ort_providers())
    if cfg.device == Device.AUTO:
        wanted = _AUTO_ORDER
    else:
        # Preferred device first, then the remaining auto order as fallback.
        wanted = [cfg.device] + [d for d in _AUTO_ORDER if d != cfg.device]
    chain = [d for d in wanted if _PROVIDER_NAMES[d] in available]
    if Device.CPU not in chain:
        chain.append(Device.CPU)
    return chain


def providers_for(device: Device, cfg: EngineConfig) -> tuple[list[str], list[dict[str, Any]]]:
    """Provider list (with CPU tail) and matching options for ONNX Runtime."""
    providers = [_PROVIDER_NAMES[device]]
    options = [_provider_options(device, cfg)]
    if device == Device.TENSORRT:
        # TensorRT falls back per-node to CUDA for unsupported ops.
        providers.append(_PROVIDER_NAMES[Device.CUDA])
        options.append(_provider_options(Device.CUDA, cfg))
    if device != Device.CPU:
        providers.append(_PROVIDER_NAMES[Device.CPU])
        options.append({})
    return providers, options


def is_gpu(device: Device) -> bool:
    return device in (Device.TENSORRT, Device.CUDA, Device.DIRECTML)


def configure_cpu_threads(cfg: EngineConfig) -> None:
    """Pin OpenCV's worker pool; ONNX Runtime threads are set per session."""
    try:
        import cv2

        cv2.setNumThreads(cfg.cpu_threads if cfg.cpu_threads > 0 else max(1, (os.cpu_count() or 2) - 1))
        cv2.setUseOptimized(True)
    except Exception:
        pass
