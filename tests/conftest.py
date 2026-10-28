import os
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture(autouse=True)
def _isolated_dirs(tmp_path, monkeypatch):
    monkeypatch.setenv("VEIL_CONFIG_DIR", str(tmp_path / "cfg"))
    monkeypatch.setenv("VEIL_CACHE_DIR", str(tmp_path / "cache"))


class FakeEngine:
    """Detects pure-white squares as 'faces'; embedding = colour of the square's centre dot."""

    tag = "fake"

    def __init__(self, *args, **kwargs):
        pass

    def describe(self):
        return "fake · cpu"

    def detect(self, frame):
        import cv2

        from app.core.engine import Detection

        mask = cv2.inRange(frame, (250, 250, 250), (255, 255, 255))
        n, _, stats, _ = cv2.connectedComponentsWithStats(mask)
        out = []
        for i in range(1, n):
            x, y, w, h, area = stats[i]
            if w < 10 or h < 10:
                continue
            kps = np.array([[x + w * .3, y + h * .4], [x + w * .7, y + h * .4], [x + w * .5, y + h * .6],
                            [x + w * .35, y + h * .8], [x + w * .65, y + h * .8]], np.float32)
            out.append(Detection(np.array([x, y, x + w, y + h], np.float32), 0.9, kps))
        return out

    def embed(self, frame, dets):
        out = []
        for d in dets:
            cx, cy = int((d.bbox[0] + d.bbox[2]) / 2), int((d.bbox[1] + d.bbox[3]) / 2)
            v = frame[cy, cx].astype(np.float32) + 1.0
            out.append(v / np.linalg.norm(v))
        return np.array(out, np.float32).reshape(len(dets), 3)


@pytest.fixture
def fake_engine():
    return FakeEngine()
