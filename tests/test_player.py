"""File preview: seeking, end-of-file hold, smooth compositing and audio."""

import shutil
import subprocess
import threading
import time

import numpy as np
import pytest

from app.core.config import AppConfig
from app.core.pipeline import Pipeline, PipelineCallbacks
from app.core.sources import SourceKind, SourceSpec
from tests.conftest import FakeEngine
from tests.test_pipeline import N, make_video


def _preview(tmp_path, **cb):
    src = tmp_path / "in.avi"
    make_video(src)
    cfg = AppConfig()
    cfg.recognition.enabled = False
    frames = []
    p = Pipeline(
        cfg, SourceSpec(SourceKind.FILE, str(src)),
        PipelineCallbacks(on_frame=lambda r, pkt: frames.append(pkt), **cb),
        display=True, realtime=True, renderer=lambda pkt: None,
        engine_factory=lambda c, on_warning: FakeEngine(),
    )
    return p, frames


def _until(pred, timeout=10.0):
    end = time.time() + timeout
    while time.time() < end and not pred():
        time.sleep(0.02)
    return pred()


def test_holds_at_end_then_seeks_back(tmp_path):
    ended = threading.Event()
    p, frames = _preview(tmp_path, on_ended=ended.set)
    p.start()
    assert _until(ended.is_set, 15), "playback should reach the end and hold"
    assert not p.finished.is_set()  # still alive: the user can seek back
    assert frames[-1].index == N - 1
    p.seek(500)  # 20 fps -> frame 10
    assert _until(lambda: any(f.index == 10 for f in frames[-5:]))
    p.stop()
    assert p.wait(10)


def test_every_shown_frame_is_anonymized_in_smooth_mode(tmp_path):
    """Frames are shown without waiting for detection, but faces stay hidden."""
    p, frames = _preview(tmp_path)
    p.start()
    assert _until(lambda: len(frames) >= 20, 15)
    p.stop()
    p.wait(10)
    for pkt in frames[1:]:
        f = pkt.frame
        stranger = f[70:130, 445:515]
        assert (stranger.min(axis=2) > 240).mean() < 0.3, pkt.index


def test_step_pauses_and_moves_one_frame(tmp_path):
    p, frames = _preview(tmp_path)
    p.start()
    assert _until(lambda: len(frames) >= 5)
    p.step(1)
    assert _until(lambda: p.paused)
    time.sleep(0.4)
    before = frames[-1].index
    p.step(1)
    assert _until(lambda: frames[-1].index == before + 1)
    p.stop()
    p.wait(10)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg needed to build a clip with audio")
def test_audio_player_decodes_seeks_and_applies_volume(tmp_path, monkeypatch):
    av = pytest.importorskip("av")
    sd = pytest.importorskip("sounddevice")
    clip = tmp_path / "tone.mp4"
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
         "-c:a", "aac", "-y", str(clip)], check=True,
    )

    class FakeStream:  # stands in for the sound card
        latency = 0.0

        def __init__(self, callback=None, **_kw):
            self.cb = callback

        def start(self):
            pass

        def stop(self):
            pass

        def close(self):
            pass

    monkeypatch.setattr(sd, "OutputStream", FakeStream)
    from app.core.audio import AudioPlayer

    player = AudioPlayer(clip)
    try:
        out = np.zeros((4800, 2), np.float32)
        assert player.position_ms() is None  # paused: not driving the clock
        player.set_paused(False)
        assert _until(lambda: player._buffered > 48000)
        player._out.cb(out, len(out), None, None)
        assert abs(player.position_ms() - 100.0) < 1.0  # 4800 samples @ 48 kHz
        assert out.max() > 0.05 and out.min() < -0.05  # a real tone (both half-waves) came out
        player.volume = 0.25
        loud = np.abs(out).max()
        player._out.cb(out, len(out), None, None)
        assert np.abs(out).max() < loud * 0.3
        player.seek(2000)
        assert _until(lambda: player._buffered > 4800)
        player._out.cb(out, len(out), None, None)
        assert abs(player.position_ms() - 2100.0) < 1.0
    finally:
        player.close()


def test_mediamtx_urls_and_config():
    from app.core import mediamtx

    urls = mediamtx.publish_urls("192.168.1.50")
    assert urls["rtmp_server"] == "rtmp://192.168.1.50:1935/live"
    assert urls["rtmp_key"] == "phone"
    assert urls["srt"].startswith("srt://192.168.1.50:8890?streamid=publish:live/phone")
    assert mediamtx.read_url() == "rtsp://127.0.0.1:8554/live/phone"
    assert "rtspAddress: 127.0.0.1:8554" in mediamtx.CONFIG  # RTSP never exposed to the LAN


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg as a stand-in phone")
def test_mediamtx_end_to_end(monkeypatch):
    from app.core import mediamtx

    if mediamtx.find_executable() is None:
        pytest.skip("MediaMTX binary not available (set VEIL_MEDIAMTX)")
    import cv2

    srv = mediamtx.MediaMTXServer()
    srv.start()
    pub = subprocess.Popen(
        ["ffmpeg", "-loglevel", "quiet", "-re", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25",
         "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-g", "25", "-f", "flv",
         "rtmp://127.0.0.1:1935/live/phone"]
    )
    try:
        assert _until(lambda: (srv.status() or mediamtx.StreamStatus(False, [], "", 0)).ready, 15)
        cap = cv2.VideoCapture(mediamtx.read_url(), cv2.CAP_FFMPEG)
        ok, frame = cap.read()
        cap.release()
        assert ok and frame.shape == (360, 640, 3)
    finally:
        pub.terminate()
        srv.stop()


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg needed to build a clip with audio")
@pytest.mark.parametrize("acodec,ext", [("aac", ".mp4"), ("pcm_s16le", ".mov")])
def test_export_keeps_original_audio(tmp_path, acodec, ext):
    av = pytest.importorskip("av")
    src = tmp_path / f"in{ext}"
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=20:duration=2",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "mjpeg", "-c:a", acodec, "-shortest",
         "-y", str(src)], check=True,
    )
    out = tmp_path / "out.mp4"
    cfg = AppConfig()
    cfg.recognition.enabled = False
    p = Pipeline(cfg, SourceSpec(SourceKind.FILE, str(src)), PipelineCallbacks(), display=False, realtime=False,
                 output_path=out, engine_factory=lambda c, on_warning: FakeEngine())
    p.start()
    assert p.wait(60) and p.finish_reason == "completed"
    with av.open(str(out)) as c:
        assert len(c.streams.video) == 1 and len(c.streams.audio) == 1
        assert c.streams.audio[0].codec_context.name == "aac"  # PCM was re-encoded for MP4
        frames = sum(1 for _ in c.decode(video=0))
    assert frames == 40
