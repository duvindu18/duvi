"""Audio playback for file preview (PyAV decoding -> sounddevice output).

The decoder thread keeps about two seconds of resampled stereo float audio
buffered. The sound-card callback pulls from that buffer, applies volume and
mute, and counts the samples it consumed: that count is the master clock for
video. Seeking flushes the buffer and restarts decoding at the target time.

Everything here is optional at runtime: if PyAV, PortAudio or an output device
is missing, :func:`open_audio` returns None and playback continues silently.
"""

from __future__ import annotations

import collections
import logging
import threading
import time
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)

RATE = 48000
CHANNELS = 2
BUFFER_S = 2.0


class AudioPlayer:
    def __init__(self, path: str | Path) -> None:
        import av
        import sounddevice as sd

        self._av = av
        self.container = av.open(str(path))
        if not self.container.streams.audio:
            self.container.close()
            raise LookupError("no audio track")
        self.stream = self.container.streams.audio[0]
        self.stream.thread_type = "AUTO"
        self._lock = threading.Lock()
        self._chunks: collections.deque[np.ndarray] = collections.deque()
        self._buffered = 0  # samples in _chunks
        self._head = 0  # read offset into _chunks[0]
        self._played = 0  # samples sent to the device since the last seek
        self._base_ms = 0.0
        self._skip_until_ms = 0.0
        self._eof = False
        self._paused = True
        self._closing = False
        self._seek_to: float | None = 0.0
        self.volume = 1.0
        self.muted = False
        self._wake = threading.Event()
        self._thread = threading.Thread(target=self._decode_loop, name="AudioDecode", daemon=True)
        self._out = sd.OutputStream(
            samplerate=RATE, channels=CHANNELS, dtype="float32", blocksize=1024, latency="low", callback=self._callback
        )
        self._latency_ms = float(self._out.latency) * 1000.0
        self._thread.start()
        self._out.start()

    # ---- clock -----------------------------------------------------------
    def position_ms(self) -> float | None:
        """Position of the sound actually heard; None when audio isn't driving playback."""
        with self._lock:
            if self._paused or (self._eof and self._buffered == 0):
                return None
            return self._base_ms + self._played * 1000.0 / RATE - self._latency_ms

    # ---- control ---------------------------------------------------------
    def set_paused(self, paused: bool) -> None:
        with self._lock:
            self._paused = paused

    def seek(self, ms: float) -> None:
        with self._lock:
            self._seek_to = max(0.0, ms)
            self._chunks.clear()
            self._buffered = self._head = self._played = 0
            self._base_ms = max(0.0, ms)
            self._eof = False
        self._wake.set()

    def close(self) -> None:
        self._closing = True
        self._wake.set()
        try:
            self._out.stop()
            self._out.close()
        except Exception:
            pass
        self._thread.join(timeout=2)
        try:
            self.container.close()
        except Exception:
            pass

    # ---- threads -----------------------------------------------------------
    def _callback(self, outdata: np.ndarray, frames: int, _time, _status) -> None:
        outdata.fill(0)
        with self._lock:
            if self._paused:
                return
            pos = 0
            while pos < frames and self._chunks:
                chunk = self._chunks[0]
                take = min(frames - pos, len(chunk) - self._head)
                outdata[pos : pos + take] = chunk[self._head : self._head + take]
                pos += take
                self._head += take
                if self._head >= len(chunk):
                    self._chunks.popleft()
                    self._head = 0
            self._buffered -= pos
            self._played += pos  # an underrun stalls the clock, so video waits too
            gain = 0.0 if self.muted else self.volume
        if gain != 1.0:
            outdata *= gain
        self._wake.set()

    def _decode_loop(self) -> None:
        av = self._av
        resampler = None
        frames = None
        while not self._closing:
            with self._lock:
                seek, self._seek_to = self._seek_to, None
                full = self._buffered >= RATE * BUFFER_S
            if seek is not None:
                try:
                    ts = int(seek / 1000.0 / float(self.stream.time_base))
                    self.container.seek(ts, stream=self.stream, backward=True, any_frame=False)
                except Exception as exc:
                    log.debug("Audio seek failed: %s", exc)
                resampler = av.AudioResampler(format="flt", layout="stereo", rate=RATE)
                frames = self.container.decode(self.stream)
                self._skip_until_ms = seek
            if full or frames is None:
                self._wake.wait(0.05)
                self._wake.clear()
                continue
            try:
                frame = next(frames)
            except StopIteration:
                with self._lock:
                    self._eof = True
                frames = None
                continue
            except Exception as exc:  # corrupt packet: skip it
                log.debug("Audio decode error: %s", exc)
                continue
            t_ms = float(frame.pts * frame.time_base * 1000.0) if frame.pts is not None else None
            for out in resampler.resample(frame):
                data = out.to_ndarray().reshape(-1, CHANNELS).astype(np.float32, copy=False)
                if t_ms is not None and t_ms < self._skip_until_ms:
                    # Trim the part of the frame before the seek target.
                    cut = int((self._skip_until_ms - t_ms) * RATE / 1000.0)
                    data = data[cut:]
                if len(data):
                    with self._lock:
                        if self._seek_to is None:
                            self._chunks.append(np.ascontiguousarray(data))
                            self._buffered += len(data)


def open_audio(path: str | Path) -> AudioPlayer | None:
    try:
        return AudioPlayer(path)
    except LookupError:
        return None  # silent video
    except Exception as exc:  # PyAV / PortAudio missing, no output device, ...
        log.warning("Audio playback unavailable: %s", exc)
        return None


def wait_until(predicate, timeout: float) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


def _add_stream_like(out, stream):
    """PyAV 12 uses add_stream(template=...); PyAV 14+ add_stream_from_template."""
    if hasattr(out, "add_stream_from_template"):
        return out.add_stream_from_template(stream)
    return out.add_stream(template=stream)


def mux_audio(source: str | Path, video: str | Path) -> bool:
    """Copy the soundtrack of ``source`` into the (silent) anonymized ``video``.

    Packets are interleaved by timestamp so memory stays flat on long files.
    Audio is stream-copied; if the container cannot hold that codec (e.g. PCM
    into MP4) it is re-encoded to AAC. Returns False when there is no audio or
    muxing failed - the silent video is then left untouched.
    """
    import av

    video = Path(video)
    tmp = video.with_name(video.stem + ".mux" + video.suffix)
    try:
        with av.open(str(source)) as a_in:
            if not a_in.streams.audio:
                return False
            codec = a_in.streams.audio[0].codec_context.name
        # PCM inside MP4 is legal but unplayable in many Windows players/editors.
        pcm_in_mp4 = codec.startswith("pcm_") and video.suffix.lower() in (".mp4", ".m4v")
        for transcode in ((True,) if pcm_in_mp4 else (False, True)):
            try:
                _mux(av, Path(source), video, tmp, transcode)
                tmp.replace(video)
                return True
            except Exception as exc:
                tmp.unlink(missing_ok=True)
                if transcode:
                    log.warning("Could not add audio to %s: %s", video.name, exc)
                    return False
                else:
                    log.info("Audio stream copy not possible (%s); re-encoding to AAC.", exc)
    except Exception as exc:
        log.warning("Could not read audio from %s: %s", source, exc)
    return False


def _mux(av, source: Path, video: Path, out_path: Path, transcode: bool) -> None:
    with av.open(str(video)) as v_in, av.open(str(source)) as a_in, av.open(str(out_path), "w") as out:
        vs = v_in.streams.video[0]
        as_ = a_in.streams.audio[0]
        out_v = _add_stream_like(out, vs)
        if transcode:
            out_a = out.add_stream("aac", rate=48000)
            out_a.layout = "stereo"
            resampler = av.AudioResampler(format="fltp", layout="stereo", rate=48000)
        else:
            out_a = _add_stream_like(out, as_)

        def packets(container, stream, target):
            for pkt in container.demux(stream):
                if pkt.dts is None:
                    continue
                yield float(pkt.dts * pkt.time_base), pkt, target

        def audio_frames():
            for frame in a_in.decode(as_):
                for rf in resampler.resample(frame):
                    for pkt in out_a.encode(rf):
                        yield float(pkt.pts * pkt.time_base) if pkt.pts is not None else 0.0, pkt, None
            for pkt in out_a.encode(None):
                yield float(pkt.pts * pkt.time_base) if pkt.pts is not None else 0.0, pkt, None

        vid = packets(v_in, vs, out_v)
        aud = audio_frames() if transcode else packets(a_in, as_, out_a)
        nv, na = next(vid, None), next(aud, None)
        while nv is not None or na is not None:
            if na is None or (nv is not None and nv[0] <= na[0]):
                _, pkt, target = nv
                pkt.stream = target
                out.mux(pkt)
                nv = next(vid, None)
            else:
                _, pkt, target = na
                if target is not None:
                    pkt.stream = target
                out.mux(pkt)
                na = next(aud, None)
