import cv2
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


def _painted(frame_shape, region, **kw):
    cfg = AnonymizeConfig(style=Style.BLACK_BOX, box_color=(7, 200, 9), **kw)
    frame = np.full(frame_shape, 128, np.uint8)
    Anonymizer(cfg).apply(frame, [region])
    return np.all(frame == (7, 200, 9), axis=2)


@pytest.mark.parametrize("shape", list(Shape))
@pytest.mark.parametrize("feather", [True, False])
@pytest.mark.parametrize("padding", [0.0, 0.2, 0.6])
def test_face_oval_always_fully_covered(shape, feather, padding):
    """At every coverage setting - including 0 % - the face itself (the oval
    inscribed in the detector box: brows, eyes, nose, mouth, cheeks, chin) is
    completely replaced, also when the frame border cuts the face."""
    rng = np.random.default_rng(1)
    for _ in range(60):
        w, h = int(rng.integers(16, 240)), int(rng.integers(20, 280))
        x, y = int(rng.integers(-w // 2, 640 - w // 2)), int(rng.integers(-h // 2, 360 - h // 2))
        hit = _painted((360, 640, 3), np.array([x, y, x + w, y + h], np.float32),
                       shape=shape, feather=feather, padding=padding)
        oval = np.zeros((360, 640), np.uint8)
        cv2.ellipse(oval, (x + w // 2, y + h // 2), (max(1, w // 2 - 1), max(1, h // 2 - 1)), 0, 0, 360, 1, -1)
        assert hit[oval > 0].all(), (shape, feather, padding, (x, y, w, h))


def test_zero_coverage_hugs_the_face():
    box = np.array([200, 100, 300, 230], np.float32)  # 100 x 130 face
    area0 = _painted((480, 640, 3), box, padding=0.0, feather=False).sum()
    face = 100 * 130
    assert area0 < 1.1 * face  # previously ~2.9x the face box
    sizes = [_painted((480, 640, 3), box, padding=p, feather=False).sum() for p in (0.0, 0.2, 0.4, 0.8)]
    assert sizes == sorted(sizes) and sizes[-1] > 2.5 * sizes[0]  # the slider really scales it


def test_tilted_face_gets_tilted_ellipse():
    upright = _painted((400, 400, 3), np.array([200, 200, 80, 140, 0], np.float32), padding=0.0, feather=False)
    tilted = _painted((400, 400, 3), np.array([200, 200, 80, 140, 60], np.float32), padding=0.0, feather=False)
    assert abs(int(upright.sum()) - int(tilted.sum())) < 0.03 * upright.sum()  # same size, just rotated
    ys, xs = np.nonzero(tilted)
    ux = np.nonzero(upright)[1]
    assert (xs.max() - xs.min()) > (ux.max() - ux.min()) * 1.2  # leaning, so wider


def test_duplicate_regions_drawn_once():
    a = np.array([200, 200, 100, 120, 0], np.float32)
    b = np.array([205, 203, 96, 118, 0], np.float32)  # same face from another pass / held track
    far = np.array([500, 200, 100, 120, 0], np.float32)
    kept = Anonymizer.dedupe([a, b, far])
    assert len(kept) == 2
