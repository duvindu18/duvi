import cv2
import numpy as np

from app.core.config import AppConfig, Policy
from app.core.face_db import FaceDatabase
from app.core.pipeline import Pipeline, PipelineCallbacks
from app.core.sources import SourceKind, SourceSpec
from app.utils.imageio import imwrite
from tests.conftest import FakeEngine

N = 40


def make_video(path):
    w = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), 20, (560, 240))
    for i in range(N):
        f = np.full((240, 560, 3), 60, np.uint8)
        f[60:140, 20 + i * 2:100 + i * 2] = 255           # "Alice" (red dot)
        f[95:105, 55 + i * 2:65 + i * 2] = (0, 0, 255)
        f[60:140, 440:520] = 255                            # stranger (green dot)
        f[95:105, 475:485] = (0, 255, 0)
        w.write(f)
    w.release()


def run(tmp_path, policy, whitelist=()):
    src = tmp_path / "in.avi"
    make_video(src)
    faces = tmp_path / "faces"
    img = np.zeros((200, 200, 3), np.uint8); img[50:150, 50:150] = 255; img[95:105, 95:105] = (0, 0, 255)
    imwrite(faces / "Alice" / "a.png", img)
    cfg = AppConfig()
    cfg.anonymize.policy = policy
    cfg.anonymize.persist_lost_frames = 0
    cfg.recognition.match_threshold = 0.95
    cfg.recognition.whitelist = list(whitelist)
    cfg.recognition.recognize_every_n = 1
    events = {"progress": [], "errors": []}
    cb = PipelineCallbacks(on_progress=lambda d, t: events["progress"].append((d, t)),
                           on_error=lambda m: events["errors"].append(m))
    out = tmp_path / "out.avi"
    p = Pipeline(cfg, SourceSpec(SourceKind.FILE, str(src)), cb, display=False, realtime=False,
                 output_path=out, face_db=FaceDatabase(faces), engine_factory=lambda c, on_warning: FakeEngine())
    p.start()
    assert p.wait(30)
    assert p.finish_reason == "completed", events
    cap = cv2.VideoCapture(str(out))
    frames = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        frames.append(f)
    return frames, events


def white_fraction(f, x1, x2):
    return (f[70:130, x1:x2].min(axis=2) > 240).mean()


def test_export_blurs_everyone(tmp_path):
    frames, ev = run(tmp_path, Policy.ALL)
    assert len(frames) == N
    assert ev["progress"][-1] == (N, N)
    last = frames[-1]
    assert white_fraction(last, 445, 515) < 0.3   # stranger hidden
    assert white_fraction(last, 20 + 39 * 2 + 5, 100 + 39 * 2 - 5) < 0.3


def test_whitelist_keeps_alice_visible(tmp_path):
    frames, _ = run(tmp_path, Policy.ALL_EXCEPT_WHITELIST, whitelist=["Alice"])
    last = frames[-1]
    assert white_fraction(last, 445, 515) < 0.3   # stranger hidden
    assert white_fraction(last, 20 + 39 * 2 + 5, 100 + 39 * 2 - 5) > 0.8   # Alice visible


def test_missing_file_reports_error(tmp_path):
    errors, done = [], []
    p = Pipeline(AppConfig(), SourceSpec(SourceKind.FILE, str(tmp_path / "nope.mp4")),
                 PipelineCallbacks(on_error=errors.append, on_finished=done.append),
                 display=False, realtime=False, engine_factory=lambda c, on_warning: FakeEngine())
    p.start()
    assert p.wait(10)
    assert done == ["error"] and "not found" in errors[0]


def test_missing_webcam_reports_error():
    errors = []
    p = Pipeline(AppConfig(), SourceSpec(SourceKind.WEBCAM, "9"), PipelineCallbacks(on_error=errors.append),
                 display=False, engine_factory=lambda c, on_warning: FakeEngine())
    p.start()
    assert p.wait(20)
    assert p.finish_reason == "error" and "Webcam 9" in errors[0]
