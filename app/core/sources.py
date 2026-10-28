"""Frame acquisition: webcams, RTSP/HTTP streams and local video files.

The :class:`CaptureWorker` owns the ``cv2.VideoCapture`` exclusively and runs
in its own thread so blocking reads (network jitter, USB hiccups) never stall
inference or the UI. Live sources use a *drop-oldest* queue so latency stays
bounded; offline exports use a blocking queue so no frame is ever skipped.
"""

from __future__ import annotations

import logging
import os
import queue
import sys
import threading
import time
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Callable

import cv2
import numpy as np

from app.utils.errors import CameraNotFoundError, CorruptVideoError, SourceError, StreamError

log = logging.getLogger(__name__)

VIDEO_EXTENSIONS = {".mp4", ".avi", ".mkv", ".mov", ".m4v", ".wmv", ".webm", ".mpg", ".mpeg", ".ts"}
STREAM_PREFIXES = ("rtsp://", "rtsps://", "rtmp://", "http://", "https://", "udp://", "tcp://")


class SourceKind(str, Enum):
    WEBCAM = "webcam"
    STREAM = "rtsp"
    FILE = "file"


@dataclass(frozen=True)
class SourceSpec:
    kind: SourceKind
    value: str

    @property
    def is_live(self) -> bool:
        return self.kind in (SourceKind.WEBCAM, SourceKind.STREAM)

    def label(self) -> str:
        if self.kind == SourceKind.WEBCAM:
            return f"Webcam {self.value}"
        if self.kind == SourceKind.STREAM:
            return _redact(self.value)
        return Path(self.value).name

    @classmethod
    def parse(cls, text: str) -> "SourceSpec":
        """``0`` / ``webcam:1`` / ``rtsp://...`` / ``C:\\clip.mp4``."""
        t = text.strip().strip('"')
        if t.lower().startswith("webcam:"):
            return cls(SourceKind.WEBCAM, t.split(":", 1)[1] or "0")
        if t.isdigit():
            return cls(SourceKind.WEBCAM, t)
        if t.lower().startswith(STREAM_PREFIXES):
            return cls(SourceKind.STREAM, t)
        return cls(SourceKind.FILE, t)


def _redact(url: str) -> str:
    """Hide credentials in ``rtsp://user:pass@host`` for logs and UI."""
    if "@" in url and "://" in url:
        scheme, rest = url.split("://", 1)
        return f"{scheme}://***@{rest.split('@', 1)[1]}"
    return url


@dataclass
class FramePacket:
    index: int
    frame: np.ndarray
    timestamp: float  # wall clock when captured
    pts_ms: float  # media position (files) or elapsed ms (live)


@dataclass
class SourceInfo:
    width: int
    height: int
    fps: float
    frame_count: int  # 0 for live sources
    backend: str


def _webcam_backends() -> list[int]:
    if sys.platform == "win32":
        # DirectShow opens fast and honours MJPG/resolution requests; MSMF is the fallback.
        return [cv2.CAP_DSHOW, cv2.CAP_MSMF, cv2.CAP_ANY]
    if sys.platform.startswith("linux"):
        return [cv2.CAP_V4L2, cv2.CAP_ANY]
    return [cv2.CAP_ANY]


def open_capture(spec: SourceSpec, width: int = 1280, height: int = 720) -> cv2.VideoCapture:
    if spec.kind == SourceKind.WEBCAM:
        try:
            index = int(spec.value)
        except ValueError as exc:
            raise CameraNotFoundError(f"Invalid webcam index '{spec.value}'.") from exc
        for api in _webcam_backends():
            cap = cv2.VideoCapture(index, api)
            if not cap.isOpened():
                cap.release()
                continue
            cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
            cap.set(cv2.CAP_PROP_FPS, 30)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            ok, _ = cap.read()
            if ok:
                log.info("Webcam %d opened via %s", index, cap.getBackendName())
                return cap
            cap.release()
        raise CameraNotFoundError(
            f"Webcam {index} is not available. It may be disconnected, disabled in Windows privacy "
            "settings (Settings > Privacy & security > Camera), or in use by another application."
        )

    if spec.kind == SourceKind.STREAM:
        # TCP avoids the smeared/grey frames UDP produces on lossy Wi-Fi.
        os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp|max_delay;500000")
        params = []
        if hasattr(cv2, "CAP_PROP_OPEN_TIMEOUT_MSEC"):
            params = [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 8000, cv2.CAP_PROP_READ_TIMEOUT_MSEC, 5000]
        cap = cv2.VideoCapture(spec.value, cv2.CAP_FFMPEG, params)
        if not cap.isOpened():
            cap.release()
            raise StreamError(f"Could not connect to {_redact(spec.value)}. Check the URL, credentials and network.")
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        return cap

    path = Path(spec.value)
    if not path.is_file():
        raise SourceError(f"Video file not found: {path}")
    if path.suffix.lower() not in VIDEO_EXTENSIONS:
        log.warning("Unusual video extension %s; attempting to open anyway.", path.suffix)
    cap = cv2.VideoCapture(str(path), cv2.CAP_FFMPEG)
    if not cap.isOpened():
        cap.release()
        cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise CorruptVideoError(f"Cannot decode {path.name}: the file is corrupted or the codec is unsupported.")
    ok, _ = cap.read()
    if not ok:
        cap.release()
        raise CorruptVideoError(f"{path.name} contains no decodable frames.")
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    return cap


def describe(cap: cv2.VideoCapture, spec: SourceSpec) -> SourceInfo:
    fps = cap.get(cv2.CAP_PROP_FPS)
    if not fps or fps != fps or fps > 240 or fps < 1:  # NaN / bogus container values
        fps = 25.0 if spec.kind == SourceKind.FILE else 30.0
    count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) if spec.kind == SourceKind.FILE else 0
    return SourceInfo(
        width=int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
        height=int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
        fps=float(fps),
        frame_count=max(0, count),
        backend=cap.getBackendName() if hasattr(cap, "getBackendName") else "?",
    )


def probe_webcams(max_index: int = 6) -> list[int]:
    """Indices of webcams that open (slow - call from a worker thread)."""
    found = []
    for i in range(max_index):
        api = cv2.CAP_DSHOW if sys.platform == "win32" else cv2.CAP_ANY
        cap = cv2.VideoCapture(i, api)
        if cap.isOpened():
            found.append(i)
        cap.release()
    return found


def put_drop_oldest(q: queue.Queue, item) -> bool:
    """Non-blocking put that evicts the oldest item. Returns True if one was dropped."""
    dropped = False
    while True:
        try:
            q.put_nowait(item)
            return dropped
        except queue.Full:
            try:
                q.get_nowait()
                dropped = True
            except queue.Empty:
                pass


class CaptureWorker(threading.Thread):
    """Reads frames into ``out_queue``; ``None`` is pushed as end-of-stream marker."""

    MAX_FILE_CORRUPT_FRAMES = 120
    MAX_STREAM_RECONNECTS = 8
    MAX_WEBCAM_REOPENS = 3

    def __init__(
        self,
        spec: SourceSpec,
        out_queue: queue.Queue,
        stop_event: threading.Event,
        *,
        realtime: bool,
        on_error: Callable[[Exception], None],
        on_warning: Callable[[str], None],
    ) -> None:
        super().__init__(name="Capture", daemon=True)
        self.spec = spec
        self.q = out_queue
        self.stop_event = stop_event
        self.realtime = realtime
        self.on_error = on_error
        self.on_warning = on_warning
        self.paused = threading.Event()
        self.ready = threading.Event()
        self.info: SourceInfo | None = None
        self.open_error: Exception | None = None
        self.dropped = 0
        self.frames_read = 0
        self._cap: cv2.VideoCapture | None = None

    # ------------------------------------------------------------------
    def run(self) -> None:
        try:
            self._cap = open_capture(self.spec)
            self.info = describe(self._cap, self.spec)
            log.info(
                "Source %s: %dx%d @ %.2f fps, %d frames (%s)",
                self.spec.label(), self.info.width, self.info.height, self.info.fps, self.info.frame_count, self.info.backend,
            )
        except Exception as exc:
            self.open_error = exc
            self.ready.set()
            self.on_error(exc)
            self._finish()
            return
        self.ready.set()
        try:
            if self.spec.kind == SourceKind.FILE:
                self._run_file()
            else:
                self._run_live()
        except Exception as exc:  # pragma: no cover - defensive
            log.exception("Capture crashed")
            self.on_error(exc)
        finally:
            self._finish()

    def _finish(self) -> None:
        if self._cap is not None:
            self._cap.release()
        # Always deliver the end marker, even when stopping, so consumers unblock.
        try:
            self.q.put(None, timeout=1.0)
        except queue.Full:
            put_drop_oldest(self.q, None)

    def _emit(self, packet: FramePacket) -> bool:
        if self.realtime or self.spec.is_live:
            if put_drop_oldest(self.q, packet):
                self.dropped += 1
            return True
        while not self.stop_event.is_set():
            try:
                self.q.put(packet, timeout=0.2)
                return True
            except queue.Full:
                continue
        return False

    def _run_file(self) -> None:
        assert self._cap is not None and self.info is not None
        cap, info = self._cap, self.info
        frame_period = 1.0 / info.fps
        index = 0
        corrupt = 0
        next_due = time.perf_counter()
        while not self.stop_event.is_set():
            if self.paused.is_set():
                time.sleep(0.05)
                next_due = time.perf_counter()
                continue
            ok, frame = cap.read()
            if not ok or frame is None:
                pos = int(cap.get(cv2.CAP_PROP_POS_FRAMES))
                if info.frame_count and pos < info.frame_count - 1 and corrupt < self.MAX_FILE_CORRUPT_FRAMES:
                    corrupt += 1
                    cap.set(cv2.CAP_PROP_POS_FRAMES, pos + 1)  # skip the damaged frame
                    continue
                if corrupt:
                    self.on_warning(f"Skipped {corrupt} undecodable frame(s) in {self.spec.label()}.")
                return  # end of file
            pts = cap.get(cv2.CAP_PROP_POS_MSEC)
            if not self._emit(FramePacket(index, frame, time.time(), pts)):
                return
            index += 1
            self.frames_read = index
            if self.realtime:
                next_due += frame_period
                delay = next_due - time.perf_counter()
                if delay > 0:
                    time.sleep(delay)
                elif delay < -1.0:
                    next_due = time.perf_counter()  # fell far behind; resync instead of bursting

    def _reopen(self) -> bool:
        if self._cap is not None:
            self._cap.release()
        try:
            self._cap = open_capture(self.spec)
            return True
        except SourceError:
            return False

    def _run_live(self) -> None:
        start = time.perf_counter()
        index = 0
        failures = 0
        reconnects = 0
        limit = self.MAX_STREAM_RECONNECTS if self.spec.kind == SourceKind.STREAM else self.MAX_WEBCAM_REOPENS
        while not self.stop_event.is_set():
            assert self._cap is not None
            ok, frame = self._cap.read()
            if not ok or frame is None:
                failures += 1
                if failures < 15:
                    time.sleep(0.02)
                    continue
                reconnects += 1
                if reconnects > limit:
                    err_cls = StreamError if self.spec.kind == SourceKind.STREAM else CameraNotFoundError
                    raise err_cls(f"{self.spec.label()} stopped delivering frames and could not be recovered.")
                backoff = min(16.0, 2.0 ** (reconnects - 1))
                self.on_warning(f"{self.spec.label()} lost - reconnecting in {backoff:.0f}s ({reconnects}/{limit})")
                if self.stop_event.wait(backoff):
                    return
                if self._reopen():
                    self.on_warning(f"{self.spec.label()} reconnected.")
                    failures = 0
                continue
            failures = 0
            reconnects = 0
            if self.paused.is_set():
                continue  # keep draining the device buffer so resume is instant
            self._emit(FramePacket(index, frame, time.time(), (time.perf_counter() - start) * 1000.0))
            index += 1
            self.frames_read = index
