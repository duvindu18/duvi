"""Manual blur edits: remove a false blur, add a missed face that keeps being tracked."""

import cv2
import numpy as np

from app.core.config import AppConfig, Policy
from app.core.edits import ADD, REMOVE, RESTORE, EditStore, FaceEdit, normalize_box
from app.core.pipeline import Pipeline, PipelineCallbacks
from app.core.sources import SourceKind, SourceSpec
from tests.conftest import FakeEngine

W, H, N = 560, 240, 40
rng = np.random.default_rng(3)
TEXTURE = rng.integers(0, 200, (60, 60, 3), dtype=np.uint8)  # an undetected "face"


def make_video(path):
    w = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), 20, (W, H))
    for i in range(N):
        f = np.full((H, W, 3), 60, np.uint8)
        f[60:140, 440:520] = 255  # detected "face" (a false positive in this story)
        x = 40 + i * 3
        f[90:150, x:x + 60] = TEXTURE  # moving face the detector misses
        w.write(f)
    w.release()


def export(tmp_path, edits, max_faces=0):
    src, out = tmp_path / "in.avi", tmp_path / "out.avi"
    make_video(src)
    cfg = AppConfig()
    cfg.anonymize.policy = Policy.ALL
    cfg.anonymize.max_faces = max_faces
    cfg.anonymize.persist_lost_frames = 0
    p = Pipeline(cfg, SourceSpec(SourceKind.FILE, str(src)), PipelineCallbacks(), display=False, realtime=False,
                 output_path=out, engine_factory=lambda c, on_warning: FakeEngine(), edits=edits)
    p.start()
    assert p.wait(30) and p.finish_reason == "completed"
    cap = cv2.VideoCapture(str(out))
    frames = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        frames.append(f)
    return frames


def white(f):
    return (f[70:130, 445:515].min(axis=2) > 240).mean()


def texture_std(f, i):
    x = 40 + i * 3
    return float(f[95:145, x + 5:x + 55].std())


def test_without_edits_detected_box_is_blurred_and_texture_is_not(tmp_path):
    frames = export(tmp_path, [])
    assert white(frames[-1]) < 0.3
    assert texture_std(frames[-1], N - 1) > 40


def test_remove_edit_keeps_false_blur_off(tmp_path):
    e = FaceEdit(REMOVE, 0.0, normalize_box((440, 60, 520, 140), W, H))
    frames = export(tmp_path, [e])
    assert all(white(f) > 0.9 for f in frames[1:])


def test_restore_undoes_remove(tmp_path):
    box = normalize_box((440, 60, 520, 140), W, H)
    frames = export(tmp_path, [FaceEdit(REMOVE, 0.0, box), FaceEdit(RESTORE, 500.0, box)])
    assert white(frames[2]) > 0.9 and white(frames[-1]) < 0.3


def test_added_box_follows_the_missed_face(tmp_path):
    e = FaceEdit(ADD, 0.0, normalize_box((38, 88, 102, 152), W, H))
    frames = export(tmp_path, [e])
    for i in (5, 20, N - 1):  # still covered while it moves 117 px
        assert texture_std(frames[i], i) < 25, i


def test_edits_survive_strict_mode(tmp_path):
    e = FaceEdit(ADD, 0.0, normalize_box((38, 88, 102, 152), W, H))
    frames = export(tmp_path, [e], max_faces=1)
    assert texture_std(frames[-1], N - 1) < 25  # manual tracks never use up a face slot


def test_store_roundtrip(tmp_path):
    store = EditStore(tmp_path / "edits.json")
    store.set(str(tmp_path / "a.mp4"), [FaceEdit(ADD, 10.0, (0.1, 0.1, 0.2, 0.2), group=3)])
    again = EditStore(tmp_path / "edits.json").get(str(tmp_path / "a.mp4"))
    assert len(again) == 1 and again[0].kind == ADD and again[0].group == 3
