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


def test_merge_takes_union():
    a = Detection(np.array([0, 0, 10, 10], np.float32), 0.9)
    b = Detection(np.array([2, 2, 14, 12], np.float32), 0.5)
    c = Detection(np.array([50, 50, 60, 60], np.float32), 0.4)
    out = merge_detections([[a], [b, c]])
    assert len(out) == 2
    np.testing.assert_array_equal(out[0].bbox, [0, 0, 14, 12])


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
