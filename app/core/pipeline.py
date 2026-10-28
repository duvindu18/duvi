"""Multi-threaded processing pipeline.

::

    ┌──────────┐  q_in   ┌────────────────────────────┐  q_render  ┌──────────┐  latest-frame  ┌─────┐
    │ Capture  │───────▶│ Inference                   │──────────▶│ Render   │──────────────▶│ GUI │
    │ thread   │ (drop/ │ detect → track → recognise  │ (drop      │ thread   │   (coalesced  └─────┘
    └──────────┘ block) │ → decide → anonymize        │  oldest)   └──────────┘    signal)
                        └────────────┬───────────────┘
                                     │ writer.q (blocking for export, drop for live)
                                     ▼
                                ┌──────────┐
                                │ Writer   │ → MP4 / AVI / MKV
                                └──────────┘

A supervisor thread owns the lifecycle: it starts the workers, waits for them
to finish (end of file, stop request or fatal error) and reports the outcome
exactly once. ``stop()`` therefore never blocks the caller, which keeps the UI
responsive even while a stalled RTSP read is timing out.

The pipeline is Qt-agnostic: the GUI injects a ``renderer`` (runs on the render
thread) and receives results through plain callbacks.
"""

from __future__ import annotations

import logging
import math
import queue
import threading
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import numpy as np

from app.core.anonymizer import Anonymizer, should_anonymize
from app.core.config import AppConfig, Policy
from app.core.engine import FaceEngine
from app.core.face_db import FaceDatabase
from app.core.sources import CaptureWorker, SourceInfo, SourceSpec, put_drop_oldest
from app.core.tracker import ByteTracker, FaceTrack
from app.core.writer import WriterWorker
from app.utils.errors import VeilError
from app.utils.rate import LatencyMeter, RateMeter

log = logging.getLogger(__name__)


@dataclass
class TrackView:
    """Immutable per-face result handed to the render/UI layer."""

    track_id: int
    bbox: np.ndarray
    identity: str | None
    similarity: float
    recognized: bool
    anonymized: bool
    lost: bool
    role: str  # "whitelist" | "target" | "known" | "unknown" | "pending"


@dataclass
class ProcessedFrame:
    index: int
    frame: np.ndarray  # anonymized BGR frame
    faces: list[TrackView]
    timestamp: float
    pts_ms: float


@dataclass
class Snapshot:
    frame: np.ndarray  # original (NOT anonymized) frame - used for enrolment only
    faces: list[TrackView]


@dataclass
class PipelineStats:
    capture_fps: float = 0.0
    inference_fps: float = 0.0
    render_fps: float = 0.0
    write_fps: float = 0.0
    latency_ms: float = 0.0
    faces: int = 0
    anonymized: int = 0
    dropped: int = 0
    device: str = ""
    identities: int = 0
    frame_index: int = 0
    frame_count: int = 0
    recording: bool = False
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class PipelineCallbacks:
    on_frame: Callable[[Any, ProcessedFrame], None] = lambda rendered, pkt: None
    on_stats: Callable[[PipelineStats], None] = lambda s: None
    on_status: Callable[[str], None] = lambda s: None
    on_warning: Callable[[str], None] = lambda s: None
    on_error: Callable[[str], None] = lambda s: None
    on_progress: Callable[[int, int], None] = lambda done, total: None
    on_source_info: Callable[[SourceInfo], None] = lambda info: None
    on_finished: Callable[[str], None] = lambda reason: None


class Pipeline:
    def __init__(
        self,
        cfg: AppConfig,
        source: SourceSpec,
        callbacks: PipelineCallbacks,
        *,
        display: bool = True,
        realtime: bool = True,
        output_path: str | Path | None = None,
        renderer: Callable[[ProcessedFrame], Any] | None = None,
        face_db: FaceDatabase | None = None,
        engine_factory: Callable[..., Any] | None = None,
    ) -> None:
        self.cfg = cfg.snapshot()
        self.source = source
        self.cb = callbacks
        self.display = display
        self.realtime = realtime
        self.renderer = renderer or (lambda pkt: pkt.frame)
        self.face_db = face_db
        self._engine_factory = engine_factory or (lambda c, on_warning: FaceEngine(c, on_warning=on_warning))

        self._stop = threading.Event()
        self._cfg_lock = threading.Lock()
        self._pending_cfg: AppConfig | None = None
        self._db_reload = threading.Event()
        self._record_lock = threading.Lock()
        self._record_request: tuple[bool, Path | None] | None = (True, Path(output_path)) if output_path else None
        self._writer: WriterWorker | None = None
        self._writer_blocking = not realtime
        self._snapshot: Snapshot | None = None
        self._snapshot_lock = threading.Lock()
        self._error: str | None = None
        self._error_lock = threading.Lock()
        self._eof = False

        live = source.is_live or realtime
        self.q_in: queue.Queue = queue.Queue(maxsize=3 if live else 16)
        self.q_render: queue.Queue = queue.Queue(maxsize=2)

        self.capture = CaptureWorker(
            source, self.q_in, self._stop, realtime=realtime, on_error=self._fail, on_warning=self._warn
        )
        self._inference = threading.Thread(target=self._inference_loop, name="Inference", daemon=True)
        self._render = threading.Thread(target=self._render_loop, name="Render", daemon=True)
        self._supervisor = threading.Thread(target=self._supervise, name="Supervisor", daemon=True)

        self.capture_rate = RateMeter()
        self.infer_rate = RateMeter()
        self.render_rate = RateMeter()
        self.latency = LatencyMeter()
        self.engine: Any = None
        self.finished = threading.Event()
        self.finish_reason = ""

    # ---- public control API (any thread) ---------------------------------
    def start(self) -> None:
        self._supervisor.start()

    def stop(self) -> None:
        self._stop.set()
        self.capture.paused.clear()

    def wait(self, timeout: float | None = None) -> bool:
        return self.finished.wait(timeout)

    def set_paused(self, paused: bool) -> None:
        if paused:
            self.capture.paused.set()
        else:
            self.capture.paused.clear()

    @property
    def paused(self) -> bool:
        return self.capture.paused.is_set()

    def update_config(self, cfg: AppConfig) -> None:
        """Hot-apply anonymization / recognition / tracker settings."""
        with self._cfg_lock:
            self._pending_cfg = cfg.snapshot()

    def reload_face_db(self) -> None:
        self._db_reload.set()

    def start_recording(self, path: str | Path) -> None:
        with self._record_lock:
            self._record_request = (True, Path(path))

    def stop_recording(self) -> None:
        with self._record_lock:
            self._record_request = (False, None)

    @property
    def recording(self) -> bool:
        return self._writer is not None

    def snapshot(self) -> Snapshot | None:
        with self._snapshot_lock:
            return self._snapshot

    # ---- internals ---------------------------------------------------------
    def _warn(self, msg: str) -> None:
        log.warning(msg)
        self.cb.on_warning(msg)

    def _fail(self, exc: Exception | str) -> None:
        if isinstance(exc, VeilError):
            msg = exc.user_message
        else:
            msg = str(exc)
        with self._error_lock:
            if self._error is None:
                self._error = msg
                log.error("Pipeline error: %s", msg)
        self._stop.set()

    def _supervise(self) -> None:
        reason = "stopped"
        try:
            self.cb.on_status("Opening source…")
            self.capture.start()
            while not self.capture.ready.wait(0.1):
                if self._stop.is_set() and not self.capture.is_alive():
                    break
            if self.capture.info is not None:
                self.cb.on_source_info(self.capture.info)
            if self.capture.open_error is None and not self._stop.is_set():
                self._inference.start()
                if self.display:
                    self._render.start()
            for t in (self.capture, self._inference, self._render):
                if t.is_alive() or t.ident is not None:
                    t.join()
        except Exception as exc:  # pragma: no cover - defensive
            log.exception("Supervisor failure")
            self._fail(exc)
        finally:
            self._close_writer()
            if self._error:
                reason = "error"
                self.cb.on_error(self._error)
            elif self._eof:
                reason = "completed"
            self.finish_reason = reason
            self.finished.set()
            self.cb.on_finished(reason)

    # -- writer management (inference thread only) ---------------------------
    def _apply_record_request(self, frame: np.ndarray) -> None:
        with self._record_lock:
            req, self._record_request = self._record_request, None
        if req is None:
            return
        want, path = req
        if not want:
            self._close_writer()
            self.cb.on_status("Recording stopped")
            return
        if self._writer is not None:
            return
        info = self.capture.info
        fps = info.fps if info else 30.0
        try:
            self._writer = WriterWorker(path, fps, (frame.shape[1], frame.shape[0]), self.cfg.output.codec, self._writer_failed)
            self._writer.start()
            self.cb.on_status(f"Recording to {path.name}")
        except VeilError as exc:
            if self._writer_blocking:
                self._fail(exc)  # export without an output file is pointless
            else:
                self._warn(exc.user_message)

    def _writer_failed(self, exc: Exception) -> None:
        if self._writer_blocking:
            self._fail(exc)
        else:
            self._warn(str(exc))

    def _close_writer(self) -> None:
        writer, self._writer = self._writer, None
        if writer is not None:
            writer.close()

    # -- inference -------------------------------------------------------------
    def _build_engine(self) -> bool:
        self.cb.on_status("Loading face models…")
        try:
            self.engine = self._engine_factory(self.cfg.engine, on_warning=self._warn)
        except Exception as exc:
            self._fail(exc)
            return False
        self.cb.on_status(f"Engine: {self.engine.describe()}")
        return True

    def _sync_db(self) -> None:
        if self.face_db is None or not self.cfg.recognition.enabled:
            return
        self.cb.on_status("Indexing known faces…")
        try:
            n = self.face_db.sync(self.engine, cancel=self._stop)
            self.cb.on_status(f"{n} known identit{'y' if n == 1 else 'ies'} loaded")
        except Exception as exc:
            log.exception("Face database sync failed")
            self._warn(f"Face database could not be indexed: {exc}")

    def _role(self, t: FaceTrack) -> str:
        rec = self.cfg.recognition
        if not t.recognized and rec.enabled:
            return "pending"
        if t.identity is None:
            return "unknown"
        if t.identity in rec.whitelist:
            return "whitelist"
        if t.identity in rec.targets:
            return "target"
        return "known"

    def _recognize(self, frame: np.ndarray, tracks: list[FaceTrack], frame_id: int) -> None:
        rec = self.cfg.recognition
        if not rec.enabled or self.face_db is None:
            return
        due: list[FaceTrack] = []
        for t in tracks:
            if t.detection is None or t.detection.kps is None:
                continue
            interval = rec.recognize_every_n if t.identity is None else rec.reverify_every_n
            if frame_id - t.last_rec_frame >= interval:
                due.append(t)
        if not due:
            return
        due.sort(key=lambda t: (t.recognized, -(t.detection.width * t.detection.height)))  # type: ignore[union-attr]
        due = due[: max(1, rec.max_per_frame)]
        embeddings = self.engine.embed(frame, [t.detection for t in due])
        results = self.face_db.match(embeddings, rec.match_threshold)
        strong = rec.match_threshold + 0.12
        for t, (name, sim) in zip(due, results):
            if t.votes.maxlen != rec.vote_window:
                t.votes = type(t.votes)(t.votes, maxlen=rec.vote_window)
            t.votes.append((name, sim))
            t.last_rec_frame = frame_id
            t.recognized = True
            counts = Counter(n for n, _ in t.votes)
            top, top_n = counts.most_common(1)[0]
            if top is not None and (top_n >= 2 or sim >= strong):
                t.identity = top
                t.identity_sim = max(s for n, s in t.votes if n == top)
            elif top is None and top_n >= math.ceil(len(t.votes) / 2):
                t.identity, t.identity_sim = None, sim

    def _take_config(self, tracker: ByteTracker, anonymizer: Anonymizer) -> None:
        with self._cfg_lock:
            cfg, self._pending_cfg = self._pending_cfg, None
        if cfg is None:
            return
        cfg.engine = self.cfg.engine  # engine changes need a restart
        self.cfg = cfg
        tracker.cfg = cfg.tracker
        anonymizer.set_config(cfg.anonymize)

    def _inference_loop(self) -> None:
        try:
            if not self._build_engine():
                return
            self._sync_db()
            tracker = ByteTracker(self.cfg.tracker, self.cfg.engine.det_low_threshold)
            anonymizer = Anonymizer(self.cfg.anonymize)
            info = self.capture.info
            total = info.frame_count if info else 0
            last_stats = 0.0
            self.cb.on_status("Running")
            while True:
                try:
                    packet = self.q_in.get(timeout=0.25)
                except queue.Empty:
                    if self._stop.is_set():
                        break
                    continue
                if packet is None:
                    self._eof = not self._stop.is_set() and self._error is None
                    break
                if self._stop.is_set():
                    break
                t0 = time.perf_counter()
                self.capture_rate.tick()
                self._take_config(tracker, anonymizer)
                if self._db_reload.is_set() or (
                    self.face_db is not None and self.face_db.tag not in (None, self.engine.tag)
                ):
                    self._db_reload.clear()
                    self._sync_db()

                frame = packet.frame
                detections = self.engine.detect(frame)
                tracks = tracker.update(detections)
                self._recognize(frame, tracks, tracker.frame_id)
                lingering = tracker.recently_lost(self.cfg.anonymize.persist_lost_frames)

                views: list[TrackView] = []
                to_hide: list[np.ndarray] = []
                for t, lost in [(t, False) for t in tracks] + [(t, True) for t in lingering]:
                    hide = should_anonymize(t.identity, t.recognized, self.cfg.anonymize, self.cfg.recognition)
                    bbox = t.bbox.copy()
                    if hide:
                        to_hide.append(bbox)
                    views.append(
                        TrackView(t.track_id, bbox, t.identity, t.identity_sim, t.recognized, hide, lost, self._role(t))
                    )
                # Unconfirmed new faces are hidden too when failing closed: a face
                # must never flash un-anonymized for the frame(s) before confirmation.
                if self.cfg.anonymize.fail_closed and self.cfg.anonymize.policy != Policy.NONE:
                    confirmed = {id(t) for t in tracks}
                    for t in tracker.tracked:
                        if not t.activated and id(t) not in confirmed:
                            to_hide.append(t.bbox.copy())

                with self._snapshot_lock:
                    self._snapshot = Snapshot(frame, views)
                out = frame.copy()
                anonymizer.apply(out, to_hide)
                processed = ProcessedFrame(packet.index, out, views, packet.timestamp, packet.pts_ms)

                self._apply_record_request(out)
                if self._writer is not None:
                    self._writer.submit(out, self._stop, block=self._writer_blocking)
                if self.display:
                    put_drop_oldest(self.q_render, processed)

                self.latency.add(time.perf_counter() - t0)
                self.infer_rate.tick()
                now = time.perf_counter()
                if now - last_stats > 0.5 or (total and packet.index + 1 >= total):
                    last_stats = now
                    self._emit_stats(packet.index + 1, total, len(views), len(to_hide))
                    if total:
                        self.cb.on_progress(packet.index + 1, total)
        except Exception as exc:
            log.exception("Inference loop crashed")
            self._fail(exc)
        finally:
            self._stop_if_eof()
            put_drop_oldest(self.q_render, None)

    def _stop_if_eof(self) -> None:
        # Signal capture to stop if we exited for any reason other than EOF.
        if not self._eof:
            self._stop.set()

    def _emit_stats(self, index: int, total: int, faces: int, hidden: int) -> None:
        writer = self._writer
        self.cb.on_stats(
            PipelineStats(
                capture_fps=self.capture_rate.rate(),
                inference_fps=self.infer_rate.rate(),
                render_fps=self.render_rate.rate(),
                write_fps=writer.rate.rate() if writer else 0.0,
                latency_ms=self.latency.value(),
                faces=faces,
                anonymized=hidden,
                dropped=self.capture.dropped,
                device=self.engine.describe() if self.engine else "",
                identities=self.face_db.identity_count if self.face_db else 0,
                frame_index=index,
                frame_count=total,
                recording=writer is not None,
            )
        )

    # -- render ------------------------------------------------------------
    def _render_loop(self) -> None:
        while True:
            try:
                pkt = self.q_render.get(timeout=0.25)
            except queue.Empty:
                if self._stop.is_set() and not self._inference.is_alive():
                    return
                continue
            if pkt is None:
                return
            try:
                rendered = self.renderer(pkt)
                self.render_rate.tick()
                self.cb.on_frame(rendered, pkt)
            except Exception as exc:  # a broken overlay must not kill the pipeline
                log.exception("Render failure: %s", exc)
