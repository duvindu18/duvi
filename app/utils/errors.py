"""Typed exceptions so the GUI can show precise, actionable messages."""

from __future__ import annotations


class VeilError(Exception):
    """Base class for all application errors."""

    user_message: str = "An unexpected error occurred."

    def __init__(self, message: str | None = None) -> None:
        super().__init__(message or self.user_message)
        self.user_message = message or self.user_message


class SourceError(VeilError):
    """The input source could not be opened or failed permanently."""

    user_message = "The video source could not be opened."


class CameraNotFoundError(SourceError):
    user_message = "No webcam was found at the selected index. Check that it is connected and not used by another app."


class StreamError(SourceError):
    user_message = "The network stream could not be reached or stopped responding."


class CorruptVideoError(SourceError):
    user_message = "The video file is corrupted or uses an unsupported codec."


class WriterError(VeilError):
    user_message = "The output video could not be written."


class ModelError(VeilError):
    user_message = "A face model could not be loaded."


class GpuOutOfMemoryError(VeilError):
    user_message = "The GPU ran out of memory."


_OOM_MARKERS = (
    "out of memory",
    "cudaerrormemoryallocation",
    "cudnn_status_alloc_failed",
    "cublas_status_alloc_failed",
    "cuda_error_out_of_memory",
    "failed to allocate memory",
    "bfcarena",
    "insufficient memory",
    "e_outofmemory",
)


def is_gpu_oom(exc: BaseException) -> bool:
    """Best-effort detection of CUDA / TensorRT / DirectML out-of-memory failures.

    ONNX Runtime and OpenCV surface these as generic runtime errors, so the
    message text is the only reliable signal.
    """
    if isinstance(exc, (GpuOutOfMemoryError, MemoryError)):
        return True
    text = str(exc).lower()
    return any(marker in text for marker in _OOM_MARKERS)
