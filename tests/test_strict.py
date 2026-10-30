"""Strict 1/2-face mode: only the strongest plausible faces are anonymized."""

import numpy as np

from app.core.angles import plausible_landmarks
from app.core.engine_types import Detection
from app.core.pipeline import Pipeline
from app.core.tracker import FaceTrack, TrackState

FACE_KPS = np.array([[85, 90], [115, 90], [100, 108], [88, 125], [112, 125]], np.float32)  # in a 60x80 box at 70,60


def det(kps):
    return Detection(np.array([70, 60, 130, 140], np.float32), 0.9, kps)


def test_real_face_layout_is_plausible():
    assert plausible_landmarks(det(FACE_KPS))


def test_rotated_face_layout_is_plausible():
    c = FACE_KPS.mean(axis=0)
    r = np.deg2rad(120)
    rot = np.array([[np.cos(r), -np.sin(r)], [np.sin(r), np.cos(r)]])
    assert plausible_landmarks(det(((FACE_KPS - c) @ rot.T + c).astype(np.float32)))


def test_scrambled_layout_is_rejected():
    mouth_above_eyes = FACE_KPS[[3, 4, 2, 0, 1]].copy()
    mouth_above_eyes[:, 0] = FACE_KPS[:, 0]
    collapsed = np.repeat(FACE_KPS[:1], 5, axis=0) + np.random.default_rng(0).normal(0, 0.5, (5, 2)).astype(np.float32)
    nose_far_below = FACE_KPS.copy()
    nose_far_below[2, 1] = 170
    for kps in (mouth_above_eyes, collapsed, nose_far_below):
        assert not plausible_landmarks(det(kps))


def _track(tid, ema, peak, hits, area=1.0):
    t = FaceTrack(tid, np.zeros(8), np.eye(8), ema, 0, 0)
    t.state = TrackState.TRACKED
    t.score_ema, t.peak_ema, t.hits = ema, peak, hits
    t.last_geom = np.array([0, 0, area, 1, 0, 1.12], np.float32)
    return t


def test_strongest_keeps_n_and_ignores_never_qualified():
    real = _track(1, 0.8, 0.85, 40)
    second = _track(2, 0.7, 0.75, 30)
    tiny_bg = _track(3, 0.42, 0.45, 50)  # never reached 0.5: background face / texture
    flash = _track(4, 0.9, 0.9, 1)  # brand-new strong hit
    kept, _ = Pipeline._strongest([real, second, tiny_bg, flash], [], 2, 0.5)
    assert [t.track_id for t in kept] == [1, 2]  # established faces win over a 1-frame flash
    kept, _ = Pipeline._strongest([real, tiny_bg], [], 2, 0.5)
    assert [t.track_id for t in kept] == [1]


def test_tracked_face_survives_a_confidence_dip():
    dipping = _track(1, 0.33, 0.8, 20)  # turned away / motion blur
    kept, _ = Pipeline._strongest([dipping], [], 1, 0.5)
    assert kept == [dipping]
