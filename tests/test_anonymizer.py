import numpy as np
import pytest

from app.core.anonymizer import Anonymizer, should_anonymize
from app.core.config import AnonymizeConfig, Policy, RecognitionConfig, Shape, Style


def textured(h=240, w=320):
    rng = np.random.default_rng(0)
    return rng.integers(0, 255, (h, w, 3), dtype=np.uint8)


@pytest.mark.parametrize("style", list(Style))
@pytest.mark.parametrize("shape", list(Shape))
def test_effect_changes_only_roi(style, shape):
    frame = textured()
    orig = frame.copy()
    an = Anonymizer(AnonymizeConfig(style=style, shape=shape, padding=0.0))
    an.apply(frame, [np.array([100, 80, 180, 160], np.float32)])
    roi_before = orig[95:145, 115:165].astype(int)
    roi_after = frame[95:145, 115:165].astype(int)
    assert np.abs(roi_before - roi_after).mean() > 20
    np.testing.assert_array_equal(frame[:15], orig[:15])
    np.testing.assert_array_equal(frame[:, 280:], orig[:, 280:])


def test_boxes_outside_frame_are_clipped():
    frame = textured()
    Anonymizer(AnonymizeConfig()).apply(frame, [np.array([-50, -50, 20, 20], np.float32),
                                                 np.array([310, 230, 400, 400], np.float32)])


def test_policies():
    rec = RecognitionConfig(whitelist=["alice"], targets=["bob"])
    a = AnonymizeConfig
    assert should_anonymize("alice", True, a(policy=Policy.ALL), rec)
    assert not should_anonymize(None, True, a(policy=Policy.NONE), rec)
    assert should_anonymize(None, True, a(policy=Policy.UNKNOWN), rec)
    assert not should_anonymize("carol", True, a(policy=Policy.UNKNOWN), rec)
    assert should_anonymize("bob", True, a(policy=Policy.TARGETS), rec)
    assert not should_anonymize("alice", True, a(policy=Policy.TARGETS), rec)
    assert not should_anonymize("alice", True, a(policy=Policy.ALL_EXCEPT_WHITELIST), rec)
    assert should_anonymize("carol", True, a(policy=Policy.ALL_EXCEPT_WHITELIST), rec)
    assert should_anonymize(None, True, a(policy=Policy.ALL_EXCEPT_WHITELIST), rec)
    # Pending recognition: privacy-safe default hides, fail-open shows.
    assert should_anonymize(None, False, a(policy=Policy.ALL_EXCEPT_WHITELIST, fail_closed=True), rec)
    assert not should_anonymize(None, False, a(policy=Policy.ALL_EXCEPT_WHITELIST, fail_closed=False), rec)
    # Recognition disabled: everyone is a stranger.
    off = RecognitionConfig(enabled=False, whitelist=["alice"])
    assert should_anonymize("alice", False, a(policy=Policy.ALL_EXCEPT_WHITELIST), off)


@pytest.mark.parametrize("shape", list(Shape))
@pytest.mark.parametrize("feather", [True, False])
@pytest.mark.parametrize("padding", [0.0, 0.15])
def test_entire_face_box_is_covered(shape, feather, padding):
    """Every pixel of the detected face box must be fully replaced, including
    the corners and faces cut by the frame border."""
    rng = np.random.default_rng(1)
    cfg = AnonymizeConfig(style=Style.BLACK_BOX, box_color=(7, 200, 9), shape=shape, feather=feather, padding=padding)
    an = Anonymizer(cfg)
    for _ in range(150):
        frame = rng.integers(0, 255, (360, 640, 3), dtype=np.uint8)
        w, h = rng.integers(12, 260), rng.integers(12, 300)
        x, y = rng.integers(-w // 2, 640 - w // 2), rng.integers(-h // 2, 360 - h // 2)
        box = np.array([x, y, x + w, y + h], np.float32)
        an.apply(frame, [box])
        x1, y1, x2, y2 = max(0, x), max(0, y), min(640, x + w), min(360, y + h)
        region = frame[y1:y2, x1:x2].reshape(-1, 3)
        assert np.all(region == (7, 200, 9)), (shape, feather, box)
