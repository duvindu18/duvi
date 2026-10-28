import numpy as np
import pytest

from app.core.angles import AngleScheduler, MultiAngleDetector, map_detection, merge_detections, rotate_frame
from app.core.engine_types import Detection


@pytest.mark.parametrize("angle", [40, -40, 90, -90, 135, 180, 23])
def test_rotation_round_trip(angle):
    frame = np.zeros((240, 320, 3), np.uint8)
    rotated, inv = rotate_frame(frame, angle)
    h, w = frame.shape[:2]
    # The canvas must contain the whole rotated frame.
    a = np.deg2rad(angle)
    assert rotated.shape[1] >= int(abs(w * np.cos(a)) + abs(h * np.sin(a))) - 1
    # A point maps back to where it came from.
    import cv2

    m = cv2.invertAffineTransform(inv)
    p = np.array([100.0, 50.0, 1.0])
    q = m @ p
    back = inv @ np.array([q[0], q[1], 1.0])
    np.testing.assert_allclose(back, p[:2], atol=1e-6)


def test_mapped_box_contains_rotated_face():
    frame = np.zeros((300, 400, 3), np.uint8)
    rotated, inv = rotate_frame(frame, 60)
    det = Detection(np.array([150, 120, 210, 200], np.float32), 0.9, np.zeros((5, 2), np.float32) + 160)
    mapped = map_detection(det, inv, frame.shape[:2])
    corners = np.array([[150, 120, 1], [210, 120, 1], [210, 200, 1], [150, 200, 1]], float) @ inv.T
    for x, y in corners:
        if 0 <= x <= 400 and 0 <= y <= 300:
            assert mapped.bbox[0] - 1e-3 <= x <= mapped.bbox[2] + 1e-3
            assert mapped.bbox[1] - 1e-3 <= y <= mapped.bbox[3] + 1e-3
    assert mapped.kps.shape == (5, 2)


def test_merge_keeps_best_hit_per_face():
    a = Detection(np.array([0, 0, 10, 10], np.float32), 0.9)
    b = Detection(np.array([1, 1, 11, 11], np.float32), 0.5)
    c = Detection(np.array([50, 50, 60, 60], np.float32), 0.4)
    out = merge_detections([[b], [a, c]])
    assert len(out) == 2
    np.testing.assert_array_equal(out[0].bbox, [0, 0, 10, 10])  # no union inflation


def test_mapped_geometry_keeps_face_size_and_tilt():
    frame = np.zeros((300, 400, 3), np.uint8)
    rotated, inv = rotate_frame(frame, 30)
    det = Detection(np.array([150, 120, 210, 200], np.float32), 0.9)
    m = map_detection(det, inv, frame.shape[:2])
    cx, cy, w, h, ang, _margin = m.geom
    assert (w, h) == (60, 80)  # true face size, not an inflated box
    assert abs(abs(ang) - 30) < 1e-3


def test_scheduler_never_starves_the_sweep():
    s = AngleScheduler([40, -40, 90, -90, 180], per_frame=1)
    seen = set()
    for _ in range(20):
        plan = s.plan()
        s.tick()
        s.report(40, 1)  # 40 deg keeps finding a face
        seen.update(plan)
    assert seen == {40, -40, 90, -90, 180}


def test_tilted_face_found_on_first_frame():
    """A detector that only sees 'faces' when they are upright in its input."""
    import cv2

    def upright_only(img, _scale=1.0):
        mask = cv2.inRange(img, (250, 250, 250), (255, 255, 255))
        n, _, stats, _ = cv2.connectedComponentsWithStats(mask)
        out = []
        for i in range(1, n):
            x, y, w, h, area = stats[i]
            if area > 0.95 * w * h and h > w * 1.3:  # an axis-aligned tall rectangle
                out.append(Detection(np.array([x, y, x + w, y + h], np.float32), 0.9))
        return out

    frame = np.zeros((400, 400, 3), np.uint8)
    face = np.zeros((400, 400, 3), np.uint8)
    face[150:250, 170:230] = 255  # 60x100 upright "face"
    tilted, _ = rotate_frame(face, 90)  # lying on its side
    frame[:] = tilted[: 400, : 400]
    assert upright_only(frame) == []
    det = MultiAngleDetector(upright_only, [40, -40, 90, -90, 180], per_frame=1)
    found = det.detect(frame)
    assert len(found) == 1
    x1, y1, x2, y2 = found[0].bbox
    assert (x2 - x1) > (y2 - y1)  # box follows the sideways face
    assert abs(abs(found[0].geom[4]) - 90) < 1e-3  # and the geometry knows it is rotated


@pytest.mark.parametrize("roll", [0, 20, -35, 90, 170])
def test_landmark_roll(roll):
    from app.core.angles import landmark_roll

    base = np.array([[-15, -10], [15, -10], [0, 5], [-10, 20], [10, 20]], np.float64)
    r = np.deg2rad(roll)
    rot = np.array([[np.cos(r), -np.sin(r)], [np.sin(r), np.cos(r)]])
    kps = (base @ rot.T + 100).astype(np.float32)
    assert abs(((landmark_roll(kps) - roll) + 180) % 360 - 180) < 1e-3


def test_refine_margin_grows_with_tilt():
    from app.core.angles import refine_geometry

    def kps_at(deg):
        r = np.deg2rad(deg)
        rot = np.array([[np.cos(r), -np.sin(r)], [np.sin(r), np.cos(r)]])
        return (np.array([[-15, -10], [15, -10], [0, 5], [-10, 20], [10, 20]], float) @ rot.T + 200).astype(np.float32)

    box = np.array([160, 140, 240, 260], np.float32)
    margins = [refine_geometry(Detection(box, 0.9, kps_at(d))).geom[5] for d in (0, 10, 25)]
    assert margins == sorted(margins) and 1.09 < margins[0] < 1.13 and margins[-1] > 1.19


def test_refine_handles_sideways_face_in_upright_box():
    """Upright pass detects a face lying at ~-80°: the geometry must turn with it."""
    from app.core.angles import refine_geometry

    r = np.deg2rad(-80)
    rot = np.array([[np.cos(r), -np.sin(r)], [np.sin(r), np.cos(r)]])
    kps = (np.array([[-15, -10], [15, -10], [0, 5], [-10, 20], [10, 20]], float) @ rot.T + 200).astype(np.float32)
    c, s_ = abs(np.cos(r)), abs(np.sin(r))
    hw, hh = np.hypot(30 * c, 45 * s_), np.hypot(30 * s_, 45 * c)  # 60x90 face, tilted -80°
    box = np.array([200 - hw, 200 - hh, 200 + hw, 200 + hh], np.float32)
    out = refine_geometry(Detection(box, 0.9, kps))
    assert abs(((out.geom[4] + 90) + 180) % 360 - 180) < 1e-3  # box turned by a quarter
    assert out.geom[5] > 1.12  # 10° residual still tilted inside the turned box
