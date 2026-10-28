"""Background video writer with codec fallback and disk-space protection."""

from __future__ import annotations

import logging
import queue
import shutil
import threading
from pathlib import Path
from typing import Callable

import cv2
import numpy as np

from app.utils.errors import WriterError
from app.utils.rate import RateMeter

log = logging.getLogger(__name__)

_CODECS_BY_EXT = {
    ".mp4": ["mp4v", "avc1"],  # avc1 needs openh264 on Windows; mp4v is universally available
    ".m4v": ["mp4v", "avc1"],
    ".mov": ["mp4v", "avc1"],
    ".avi": ["XVID", "MJPG"],
    ".mkv": ["XVID", "mp4v", "MJPG"],
}
_MIN_FREE_BYTES = 300 * 1024 * 1024
_STOP = object()


def open_writer(path: Path, fps: float, size: tuple[int, int], codec: str = "auto") -> tuple[cv2.VideoWriter, str]:
    path.parent.mkdir(parents=True, exist_ok=True)
    ext = path.suffix.lower()
    candidates = _CODECS_BY_EXT.get(ext, ["mp4v", "MJPG"]) if codec == "auto" else [codec]
    for fourcc in candidates:
        writer = cv2.VideoWriter(str(path), cv2.CAP_FFMPEG, cv2.VideoWriter_fourcc(*fourcc), fps, size)
        if not writer.isOpened():
            writer.release()
            writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*fourcc), fps, size)
        if writer.isOpened():
            log.info("Writing %s with %s @ %.2f fps %dx%d", path, fourcc, fps, *size)
            return writer, fourcc
        writer.release()
    raise WriterError(f"No working video codec for '{ext}' (tried {', '.join(candidates)}). Try .avi or .mp4.")


class WriterWorker(threading.Thread):
    """Consumes frames from a bounded queue so encoding never blocks inference."""

    def __init__(
        self,
        path: Path,
        fps: float,
        size: tuple[int, int],
        codec: str,
        on_error: Callable[[Exception], None],
        maxsize: int = 64,
    ) -> None:
        super().__init__(name="Writer", daemon=True)
        self.path = Path(path)
        self.fps = fps
        self.size = size
        self.codec = codec
        self.on_error = on_error
        self.q: queue.Queue = queue.Queue(maxsize=maxsize)
        self.rate = RateMeter()
        self.frames_written = 0
        self.failed = threading.Event()
        # Open synchronously so codec errors surface immediately to the caller.
        self._writer, self.fourcc = open_writer(self.path, fps, size, codec)

    def submit(self, frame: np.ndarray, stop_event: threading.Event | None = None, block: bool = True) -> bool:
        """Queue a frame. Blocks (export) or drops (live) when the encoder lags."""
        if self.failed.is_set():
            return False
        if not block:
            try:
                self.q.put_nowait(frame)
                return True
            except queue.Full:
                return False
        while stop_event is None or not stop_event.is_set():
            try:
                self.q.put(frame, timeout=0.2)
                return True
            except queue.Full:
                if self.failed.is_set():
                    return False
        return False

    def close(self) -> None:
        """Flush remaining frames and finalise the container."""
        while True:
            try:
                self.q.put(_STOP, timeout=0.5)
                break
            except queue.Full:
                if not self.is_alive():
                    break
        self.join(timeout=30)

    def run(self) -> None:
        try:
            while True:
                item = self.q.get()
                if item is _STOP:
                    break
                if self.failed.is_set():
                    continue
                frame = item
                if (frame.shape[1], frame.shape[0]) != self.size:
                    frame = cv2.resize(frame, self.size, interpolation=cv2.INTER_AREA)
                self._writer.write(frame)
                self.frames_written += 1
                self.rate.tick()
                if self.frames_written % 300 == 0:
                    free = shutil.disk_usage(self.path.parent).free
                    if free < _MIN_FREE_BYTES:
                        raise WriterError(f"Disk almost full ({free // (1024 * 1024)} MB free); recording stopped.")
        except Exception as exc:
            self.failed.set()
            log.exception("Writer failed")
            self.on_error(exc if isinstance(exc, WriterError) else WriterError(f"Video writing failed: {exc}"))
            # Keep draining so producers never deadlock on a full queue.
            while True:
                try:
                    if self.q.get(timeout=1.0) is _STOP:
                        break
                except queue.Empty:
                    break
        finally:
            self._writer.release()
            log.info("Writer closed: %s (%d frames)", self.path, self.frames_written)
