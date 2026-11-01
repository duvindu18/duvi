"""Short, quiet interface sounds, synthesised once into WAV files.

Played with QSoundEffect (low latency, mixes with video audio). If the
multimedia backend is unavailable the app simply stays silent.
"""

from __future__ import annotations

import logging
import math
import struct
import wave
from pathlib import Path

from PySide6.QtCore import QObject, QUrl

from app.utils.paths import cache_dir

log = logging.getLogger(__name__)

RATE = 44100


def _tone(freqs: list[tuple[float, float, float]], noise: float = 0.0) -> list[float]:
    """freqs: (start_s, frequency_hz, duration_s) notes with a soft bell envelope."""
    total = max(max(s + d for s, _, d in freqs), 0.08 if noise else 0.0) + 0.02
    out = [0.0] * int(total * RATE)
    for start, f, dur in freqs:
        i0, n = int(start * RATE), int(dur * RATE)
        for i in range(n):
            t = i / RATE
            env = min(1.0, t / 0.004) * math.exp(-t * 6.0 / dur)
            v = math.sin(2 * math.pi * f * t) + 0.25 * math.sin(4 * math.pi * f * t)
            out[i0 + i] += v * env * 0.45
    if noise:
        import random

        rnd = random.Random(7)
        prev = 0.0
        for i in range(int(0.07 * RATE)):
            t = i / RATE
            prev = 0.6 * prev + 0.4 * rnd.uniform(-1, 1)  # softened click
            out[i] += prev * noise * math.exp(-t * 60)
    return out


SOUNDS = {
    "start": lambda: _tone([(0, 660, 0.09), (0.07, 990, 0.14)]),
    "stop": lambda: _tone([(0, 880, 0.09), (0.07, 587, 0.14)]),
    "record": lambda: _tone([(0, 1046, 0.07), (0.11, 1046, 0.07)]),
    "shutter": lambda: _tone([(0.0, 1800, 0.03)], noise=1.0),
    "tap": lambda: _tone([(0, 1320, 0.05)]),
    "done": lambda: _tone([(0, 1046, 0.35), (0.09, 1318, 0.35), (0.18, 1568, 0.5)]),
    "connect": lambda: _tone([(0, 784, 0.18), (0.1, 1175, 0.3)]),
    "error": lambda: _tone([(0, 247, 0.16), (0.18, 220, 0.22)]),
}


def _write(path: Path, samples: list[float]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", int(max(-1.0, min(1.0, s)) * 32000)) for s in samples))


class Sounds(QObject):
    VERSION = 1

    def __init__(self, enabled: bool = True, volume: float = 0.35, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self.enabled = enabled
        self.volume = volume
        self._effects: dict = {}
        self._ready = False

    def _load(self) -> None:
        self._ready = True
        try:
            from PySide6.QtMultimedia import QSoundEffect
        except Exception as exc:  # pragma: no cover - backend missing
            log.info("Sound effects unavailable: %s", exc)
            return
        folder = cache_dir() / f"sounds-v{self.VERSION}"
        for name, make in SOUNDS.items():
            path = folder / f"{name}.wav"
            try:
                if not path.exists():
                    _write(path, make())
                fx = QSoundEffect(self)
                fx.setSource(QUrl.fromLocalFile(str(path)))
                fx.setVolume(self.volume)
                self._effects[name] = fx
            except Exception as exc:  # pragma: no cover
                log.info("Sound %s unavailable: %s", name, exc)

    def play(self, name: str) -> None:
        if not self.enabled:
            return
        if not self._ready:
            self._load()
        fx = self._effects.get(name)
        if fx is not None:
            fx.play()
