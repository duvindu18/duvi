import numpy as np

from app.core.config import TrackerConfig
from app.core.engine import Detection
from app.core.tracker import ByteTracker, iou_matrix


def det(x, y, s=0.9, size=60):
    return Detection(np.array([x, y, x + size, y + size], np.float32), s)


def test_iou_matrix():
    a = np.array([[0, 0, 10, 10]], np.float32)
    b = np.array([[0, 0, 10, 10], [5, 0, 15, 10], [20, 20, 30, 30]], np.float32)
    np.testing.assert_allclose(iou_matrix(a, b)[0], [1.0, 1 / 3, 0.0], atol=1e-5)


def test_ids_stable_across_motion():
    tr = ByteTracker(TrackerConfig(), low_threshold=0.2)
    ids = []
    for f in range(30):
        tracks = tr.update([det(10 + f * 3, 50), det(300 - f * 2, 80)])
        ids.append(sorted(t.track_id for t in tracks))
    assert ids[-1] == [1, 2]
    assert all(i == [1, 2] for i in ids[1:])


def test_low_score_detection_keeps_track():
    tr = ByteTracker(TrackerConfig(), low_threshold=0.2)
    for f in range(5):
        tr.update([det(100 + f, 100)])
    tracks = tr.update([det(106, 100, s=0.3)])  # occluded: low confidence
    assert [t.track_id for t in tracks] == [1]


def test_lost_track_recovers_same_id():
    tr = ByteTracker(TrackerConfig(), low_threshold=0.2)
    for f in range(5):
        tr.update([det(100, 100)])
    for _ in range(5):
        assert tr.update([]) == []
    assert len(tr.recently_lost(8)) == 1
    tracks = tr.update([det(101, 100)])
    assert [t.track_id for t in tracks] == [1]


def test_lost_track_expires():
    cfg = TrackerConfig(max_lost_frames=3)
    tr = ByteTracker(cfg, low_threshold=0.2)
    for _ in range(3):
        tr.update([det(100, 100)])
    for _ in range(5):
        tr.update([])
    assert tr.lost == []
