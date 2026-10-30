"""Multi-threaded processing pipeline.

Export (frame-exact)::

    Capture ──q_in (blocking)──▶ Inference: detect → track → recognise → decide → anonymize ──▶ Writer

Preview (smooth)::

                 ┌─────────────── latest frame (mailbox) ───────────────┐
                 │                                                      ▼
    Capture ──q_in──▶ Compositor ──q_render──▶ Render ──▶ GUI     Detector: detect → track →
    (paced by the      │   shows EVERY frame; blurs each face          recognise → decide
     media clock;      │   at its predicted position from the          (as fast as the GPU allows)
     audio = master)   │   latest detection result  ◀──── result ───────┘
                       └──▶ Writer (recording)

In preview the picture never waits for the detector, so playback is fluid at
the source frame rate even when detection runs slower. Faces are carried
forward with their measured velocity between detections. After a start or a
seek the compositor waits for one fresh detection, so a frame is never shown
before its faces are known. "Exact" preview mode waits for every frame.

A supervisor thread owns the lifecycle: it starts the workers, waits for them
to finish (end of file, stop request or fatal error) and reports the outcome
exactly once. ``stop()`` never blocks the caller.

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

from app.core.angles import plausible_landmarks
from app.core.anonymizer import Anonymizer, should_anonymize
from app.core.audio import AudioPlayer, mux_audio, open_audio
from app.core.clock import MediaClock
from app.core.config import AppConfig, Policy
from app.core.engine import FaceEngine
from app.core.face_db import FaceDatabase
from app.core.sources import CaptureWorker, FramePacket, SeekMarker, SourceInfo, SourceKind, SourceSpec, put_drop_oldest
from app.core.tracker import ByteTracker, FaceTrack
from app.core.writer import WriterWorker
from app.utils.errors import VeilError
from app.utils.rate import LatencyMeter, RateMeter

log = logging.getLogger(__name__)

MAX_EXTRAPOLATE_FRAMES = 12


@dataclass
class TrackView:
    """Per-face result handed to the render/UI layer."""

    track_id: int
    bbox: np.ndarray  # axis-aligned box
    identity: str | None
    similarity: float
    recognized: bool
    anonymized: bool
    lost: bool
    role: str  # "whitelist" | "target" | "known" | "unknown" | "pending"
    geom: np.ndarray | None = None  # oriented face [cx, cy, w, h, angle]
    velocity: tuple[float, float] = (0.0, 0.0)  # px per frame

    def shifted(self, frames: float) -> "TrackView":
        if frames <= 0 or self.velocity == (0.0, 0.0):
            return self
        dx, dy = self.velocity[0] * frames, self.velocity[1] * frames
        geom = None
        if self.geom is not None:
            geom = self.geom.copy()
            geom[0] += dx
            geom[1] += dy
        bbox = self.bbox + np.array([dx, dy, dx, dy], np.float32)
        return TrackView(
            self.track_id, bbox, self.identity, self.similarity, self.recognized, self.anonymized,
            self.lost, self.role, geom, self.velocity,
        )


@dataclass
class Analysis:
    index: int
    views: list[TrackView]
    hidden: list[TrackView]  # faces to anonymize (views + unconfirmed tracks)


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
    on_position: Callable[[float, float], None] = lambda pos_ms, dur_ms: None
    on_ended: Callable[[], None] = lambda: None


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
        self._cfg_version = 0
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
        self.q_in: queue.Queue = queue.Queue(maxsize=4 if live else 16)
        self.q_render: queue.Queue = queue.Queue(maxsize=2)

        self.capture = CaptureWorker(
            source, self.q_in, self._stop, realtime=realtime, on_error=self._fail, on_warning=self._warn
        )
        self._inference = threading.Thread(target=self._inference_loop, name="Inference", daemon=True)
        self._detector = threading.Thread(target=self._detector_loop, name="Detector", daemon=True)
        self._render = threading.Thread(target=self._render_loop, name="Render", daemon=True)
        self._supervisor = threading.Thread(target=self._supervise, name="Supervisor", daemon=True)

        # Smooth-preview state shared by compositor and detector.
        self._mail_cond = threading.Condition()
        self._mailbox: FramePacket | None = None
        self._latest: Analysis | None = None
        self._scene_reset = False

        # File preview: clock, audio, end-of-file hold, seeking.
        self.clock: MediaClock | None = None
        self.audio: AudioPlayer | None = None
        self.loop = cfg.loop
        self._volume = cfg.volume
        self._muted = cfg.muted
        self._shown_index = 0
        self._prev_geoms: dict[int, tuple[float, float, int]] = {}

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
        with self._mail_cond:
            self._mail_cond.notify_all()

    def wait(self, timeout: float | None = None) -> bool:
        return self.finished.wait(timeout)

    def set_paused(self, paused: bool) -> None:
        if paused:
            self.capture.paused.set()
            if self.clock:
                self.clock.pause()
        else:
            if self.capture.ended.is_set():
                self.seek(0)  # play again from the start
            self.capture.paused.clear()
            if self.clock:
                self.clock.start()
        if self.audio:
            self.audio.set_paused(paused)

    @property
    def paused(self) -> bool:
        return self.capture.paused.is_set()

    @property
    def seekable(self) -> bool:
        return self.source.kind == SourceKind.FILE and self.realtime

    @property
    def has_audio(self) -> bool:
        return self.audio is not None

    @property
    def duration_ms(self) -> float:
        info = self.capture.info
        return info.frame_count * 1000.0 / info.fps if info and info.frame_count else 0.0

    def seek(self, ms: float) -> None:
        if not self.seekable:
            return
        self.capture.request_seek(ms)
        if self.audio:
            self.audio.seek(ms)

    def step(self, frames: int) -> None:
        """Frame step (pauses playback)."""
        info = self.capture.info
        if not self.seekable or not info:
            return
        if not self.paused:
            self.set_paused(True)
        target = max(0, self._shown_index + frames)
        self.capture.request_seek(target * 1000.0 / info.fps)

    def set_volume(self, volume: float) -> None:
        self._volume = max(0.0, min(1.0, volume))
        if self.audio:
            self.audio.volume = self._volume

    def set_muted(self, muted: bool) -> None:
        self._muted = muted
        if self.audio:
            self.audio.muted = muted

    def update_config(self, cfg: AppConfig) -> None:
        """Hot-apply anonymization / recognition / tracker settings."""
        snap = cfg.snapshot()
        with self._cfg_lock:
            snap.engine = self.cfg.engine  # engine changes need a restart
            self.cfg = snap
            self._cfg_version += 1
        self.loop = snap.loop

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
        msg = exc.user_message if isinstance(exc, VeilError) else str(exc)
        with self._error_lock:
            if self._error is None:
                self._error = msg
                log.error("Pipeline error: %s", msg)
        self.stop()

    @property
    def _smooth(self) -> bool:
        return self.realtime and self.display

    def _supervise(self) -> None:
        reason = "stopped"
        try:
            self.cb.on_status("Opening source…")
            if self.seekable and self.display:
                self.clock = MediaClock()
                self.capture.clock = self.clock
                self.capture.hold_at_end = True
                self.capture.on_ended = self._on_capture_ended
                self.capture.paused.clear()
            self.capture.start()
            while not self.capture.ready.wait(0.1):
                if self._stop.is_set() and not self.capture.is_alive():
                    break
            if self.capture.info is not None:
                self.cb.on_source_info(self.capture.info)
                if self.clock is not None:
                    self.audio = open_audio(self.source.value)
                    if self.audio:
                        self.audio.volume = self._volume
                        self.audio.muted = self._muted
                        self.clock.audio = self.audio
            if self.capture.open_error is None and not self._stop.is_set():
                self._inference.start()
                if self.display:
                    self._render.start()
            for t in (self.capture, self._inference, self._detector, self._render):
                if t.ident is not None:
                    t.join()
        except Exception as exc:  # pragma: no cover - defensive
            log.exception("Supervisor failure")
            self._fail(exc)
        finally:
            writer_path = self._writer.path if self._writer is not None else None
            self._close_writer()
            if self.audio:
                self.audio.close()
            if (
                writer_path is not None and self._eof and not self._error
                and self.source.kind == SourceKind.FILE and not self.realtime
            ):
                self.cb.on_status("Adding the original audio…")
                if mux_audio(self.source.value, writer_path):
                    log.info("Audio copied into %s", writer_path.name)
            if self._error:
                reason = "error"
                self.cb.on_error(self._error)
            elif self._eof:
                reason = "completed"
            self.finish_reason = reason
            self.finished.set()
            self.cb.on_finished(reason)

    def _on_capture_ended(self) -> None:
        if self.loop:
            self.seek(0)
            return
        if self.clock:
            self.clock.pause()
        if self.audio:
            self.audio.set_paused(True)
        self.capture.paused.set()
        self.cb.on_ended()

    # -- writer management ---------------------------------------------------
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

    # -- engine / recognition -----------------------------------------------
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

    def _maybe_resync(self) -> None:
        if self._db_reload.is_set() or (self.face_db is not None and self.face_db.tag not in (None, self.engine.tag)):
            self._db_reload.clear()
            self._sync_db()

    def _role(self, t: FaceTrack, cfg: AppConfig) -> str:
        rec = cfg.recognition
        if not t.recognized and rec.enabled:
            return "pending"
        if t.identity is None:
            return "unknown"
        if t.identity in rec.whitelist:
            return "whitelist"
        if t.identity in rec.targets:
            return "target"
        return "known"

    def _recognize(self, frame: np.ndarray, tracks: list[FaceTrack], frame_id: int, cfg: AppConfig) -> None:
        rec = cfg.recognition
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

    def _analyze(self, frame: np.ndarray, index: int, tracker: ByteTracker, cfg: AppConfig) -> Analysis:
        """Detect, track, recognise and decide for one frame."""
        tracker.cfg = cfg.tracker
        detections = self.engine.detect(frame)
        max_faces = cfg.anonymize.max_faces
        if max_faces > 0:
            # Strict mode: anatomically implausible detections never start or feed a track.
            detections = [d for d in detections if plausible_landmarks(d)]
        tracks = tracker.update(detections)
        self._recognize(frame, tracks, tracker.frame_id, cfg)
        lingering = tracker.recently_lost(cfg.anonymize.persist_lost_frames)
        if max_faces > 0:
            tracks, lingering = self._strongest(tracks, lingering, max_faces, cfg.anonymize.strict_score)

        views: list[TrackView] = []
        hidden: list[TrackView] = []
        seen: dict[int, tuple[float, float, int]] = {}
        for t, lost in [(t, False) for t in tracks] + [(t, True) for t in lingering]:
            geom = t.geom.copy()
            vel = (0.0, 0.0)
            prev = self._prev_geoms.get(t.track_id)
            if prev is not None and index > prev[2]:
                n = index - prev[2]
                vel = ((geom[0] - prev[0]) / n, (geom[1] - prev[1]) / n)
            seen[t.track_id] = (float(geom[0]), float(geom[1]), index)
            hide = should_anonymize(t.identity, t.recognized, cfg.anonymize, cfg.recognition)
            view = TrackView(
                t.track_id, t.bbox.copy(), t.identity, t.identity_sim, t.recognized, hide, lost,
                self._role(t, cfg), geom, vel,
            )
            views.append(view)
            if hide:
                hidden.append(view)
        self._prev_geoms = seen
        # Unconfirmed new faces are hidden too when failing closed (not in strict
        # mode, where only the ranked faces above count).
        if cfg.anonymize.fail_closed and cfg.anonymize.policy != Policy.NONE and max_faces == 0:
            active = {id(t) for t in tracks}
            for t in tracker.tracked:
                if not t.activated and id(t) not in active:
                    hidden.append(TrackView(t.track_id, t.bbox.copy(), None, 0.0, False, True, False, "pending", t.geom.copy()))
        with self._snapshot_lock:
            self._snapshot = Snapshot(frame, views)
        return Analysis(index, views, hidden)

    @staticmethod
    def _strongest(
        tracks: list[FaceTrack], lingering: list[FaceTrack], n: int, min_score: float
    ) -> tuple[list[FaceTrack], list[FaceTrack]]:
        """Keep the ``n`` most credible faces (1/2-face mode).

        A face qualifies when its smoothed confidence reaches ``min_score``;
        once it has, it keeps qualifying while it dips (motion blur, partial
        occlusion, turning away) down to 60 % of that. Faces that never reached
        the bar - tiny background faces, logos, textures - never count. The
        strongest qualified faces win, so a brief false positive can never
        displace a face that is already tracked.
        """
        def qualifies(t: FaceTrack) -> bool:
            return t.score_ema >= min_score or (t.peak_ema >= min_score and t.score_ema >= 0.6 * min_score)

        pool = [(t, False) for t in tracks] + [(t, True) for t in lingering]
        pool = [(t, lost) for t, lost in pool if qualifies(t)]
        pool.sort(key=lambda p: (min(p[0].hits, 10), p[0].score_ema, p[0].last_geom[2] * p[0].last_geom[3]), reverse=True)
        keep = pool[:n]
        return [t for t, lost in keep if not lost], [t for t, lost in keep if lost]

    def _compose(self, packet: FramePacket, analysis: Analysis, anonymizer: Anonymizer) -> ProcessedFrame:
        frames_ahead = min(MAX_EXTRAPOLATE_FRAMES, max(0, packet.index - analysis.index))
        hidden = [v.shifted(frames_ahead) for v in analysis.hidden]
        views = [v.shifted(frames_ahead) for v in analysis.views]
        out = packet.frame.copy()
        anonymizer.apply(out, [v.geom if v.geom is not None else v.bbox for v in hidden])
        return ProcessedFrame(packet.index, out, views, packet.timestamp, packet.pts_ms)

    def _output(self, processed: ProcessedFrame) -> None:
        self._apply_record_request(processed.frame)
        if self._writer is not None:
            self._writer.submit(processed.frame, self._stop, block=self._writer_blocking)
        if self.display:
            put_drop_oldest(self.q_render, processed)

    def _current_cfg(self, version: int) -> tuple[AppConfig, int]:
        with self._cfg_lock:
            return self.cfg, self._cfg_version

    # -- export path: every frame analysed, in order ---------------------------
    def _inference_loop(self) -> None:
        try:
            if not self._build_engine():
                return
            self._sync_db()
            if self._smooth:
                self._compositor_loop()
                return
            cfg, version = self._current_cfg(-1)
            tracker = ByteTracker(cfg.tracker, cfg.engine.det_low_threshold)
            anonymizer = Anonymizer(cfg.anonymize)
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
                if isinstance(packet, SeekMarker):
                    continue
                t0 = time.perf_counter()
                self.capture_rate.tick()
                new_cfg, new_version = self._current_cfg(version)
                if new_version != version:
                    cfg, version = new_cfg, new_version
                    anonymizer.set_config(cfg.anonymize)
                self._maybe_resync()
                analysis = self._analyze(packet.frame, packet.index, tracker, cfg)
                processed = self._compose(packet, analysis, anonymizer)
                self._output(processed)
                self.latency.add(time.perf_counter() - t0)
                self.infer_rate.tick()
                now = time.perf_counter()
                if now - last_stats > 0.5 or (total and packet.index + 1 >= total):
                    last_stats = now
                    self._emit_stats(packet.index + 1, total, len(analysis.views), len(analysis.hidden))
                    if total:
                        self.cb.on_progress(packet.index + 1, total)
        except Exception as exc:
            log.exception("Inference loop crashed")
            self._fail(exc)
        finally:
            if not self._eof:
                self.stop()
            put_drop_oldest(self.q_render, None)

    # -- smooth preview: compositor + asynchronous detector -------------------
    def _compositor_loop(self) -> None:
        cfg, version = self._current_cfg(-1)
        anonymizer = Anonymizer(cfg.anonymize)
        self._detector.start()
        need_sync = True
        last_stats = last_pos = 0.0
        clock_started = False
        self.cb.on_status("Running")
        while not self._stop.is_set():
            try:
                packet = self.q_in.get(timeout=0.25)
            except queue.Empty:
                continue
            if packet is None:
                self._eof = not self._stop.is_set() and self._error is None
                break
            if isinstance(packet, SeekMarker):
                with self._mail_cond:
                    self._latest = None
                    self._mailbox = None
                    self._scene_reset = True
                need_sync = True
                continue
            self.capture_rate.tick()
            new_cfg, new_version = self._current_cfg(version)
            if new_version != version:
                cfg, version = new_cfg, new_version
                anonymizer.set_config(cfg.anonymize)
            with self._mail_cond:
                self._mailbox = packet
                self._mail_cond.notify_all()
                exact = cfg.preview_mode == "exact"
                if need_sync or exact or self._latest is None:
                    # Never show a frame before its faces are known (start / seek / exact mode).
                    while not self._stop.is_set() and (self._latest is None or self._latest.index < packet.index):
                        self._mail_cond.wait(0.1)
                    need_sync = False
                analysis = self._latest
            if analysis is None or self._stop.is_set():
                break
            processed = self._compose(packet, analysis, anonymizer)
            self._shown_index = packet.index
            self._output(processed)
            if not clock_started and self.clock is not None:
                clock_started = True
                if not self.capture.paused.is_set():
                    self.clock.start()
                    if self.audio:
                        self.audio.set_paused(False)
            now = time.perf_counter()
            if self.clock is not None and now - last_pos > 0.1:
                last_pos = now
                self.cb.on_position(packet.pts_ms, self.duration_ms)
            if now - last_stats > 0.5:
                last_stats = now
                info = self.capture.info
                self._emit_stats(packet.index + 1, info.frame_count if info else 0, len(analysis.views), len(analysis.hidden))

    def _detector_loop(self) -> None:
        try:
            cfg, version = self._current_cfg(-1)
            tracker = ByteTracker(cfg.tracker, cfg.engine.det_low_threshold)
            while not self._stop.is_set():
                with self._mail_cond:
                    while self._mailbox is None and not self._stop.is_set():
                        self._mail_cond.wait(0.1)
                    packet, self._mailbox = self._mailbox, None
                    reset, self._scene_reset = self._scene_reset, False
                if packet is None:
                    break
                if reset:
                    tracker.reset()
                    self._prev_geoms.clear()
                    reset_scene = getattr(self.engine, "reset_scene", None)
                    if reset_scene:
                        reset_scene()
                cfg, version = self._current_cfg(version)
                self._maybe_resync()
                t0 = time.perf_counter()
                analysis = self._analyze(packet.frame, packet.index, tracker, cfg)
                self.latency.add(time.perf_counter() - t0)
                self.infer_rate.tick()
                with self._mail_cond:
                    if not self._scene_reset:  # discard results from before a seek
                        self._latest = analysis
                    self._mail_cond.notify_all()
        except Exception as exc:
            log.exception("Detector crashed")
            self._fail(exc)

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
