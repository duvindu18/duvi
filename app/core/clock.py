"""Playback clock for file preview.

Video frames are shown when the clock reaches their timestamp. When the file
has audio, the audio device is the master: the clock reads the position of the
samples actually played, so picture and sound cannot drift apart. Otherwise
(or once the audio track ends) a wall clock takes over seamlessly.
"""

from __future__ import annotations

import threading
import time
from typing import Protocol


class AudioClockSource(Protocol):
    def position_ms(self) -> float | None:
        """Current audio position, or None when audio is not driving playback."""


class MediaClock:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._base_ms = 0.0
        self._t0: float | None = None  # wall time when (re)started; None = paused
        self.audio: AudioClockSource | None = None

    def position_ms(self) -> float:
        audio = self.audio
        if audio is not None and self._t0 is not None:
            pos = audio.position_ms()
            if pos is not None:
                with self._lock:
                    # Keep the wall clock aligned so a hand-over is seamless.
                    self._base_ms = pos
                    self._t0 = time.perf_counter()
                return pos
        with self._lock:
            if self._t0 is None:
                return self._base_ms
            return self._base_ms + (time.perf_counter() - self._t0) * 1000.0

    @property
    def running(self) -> bool:
        return self._t0 is not None

    def start(self, at_ms: float | None = None) -> None:
        with self._lock:
            if at_ms is not None:
                self._base_ms = at_ms
            self._t0 = time.perf_counter()

    def pause(self) -> None:
        pos = self.position_ms()
        with self._lock:
            self._base_ms = pos
            self._t0 = None

    def seek(self, at_ms: float) -> None:
        with self._lock:
            self._base_ms = max(0.0, at_ms)
            if self._t0 is not None:
                self._t0 = time.perf_counter()
