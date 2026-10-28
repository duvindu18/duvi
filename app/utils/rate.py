"""Thread-safe throughput and latency meters used for the live statistics panel."""

from __future__ import annotations

import threading
import time
from collections import deque


class RateMeter:
    """Events-per-second over a sliding time window."""

    def __init__(self, window_s: float = 2.0) -> None:
        self._window = window_s
        self._stamps: deque[float] = deque()
        self._lock = threading.Lock()

    def tick(self) -> None:
        now = time.perf_counter()
        with self._lock:
            self._stamps.append(now)
            self._trim(now)

    def rate(self) -> float:
        now = time.perf_counter()
        with self._lock:
            self._trim(now)
            if len(self._stamps) < 2:
                return 0.0
            span = self._stamps[-1] - self._stamps[0]
            return (len(self._stamps) - 1) / span if span > 0 else 0.0

    def _trim(self, now: float) -> None:
        cutoff = now - self._window
        while self._stamps and self._stamps[0] < cutoff:
            self._stamps.popleft()


class LatencyMeter:
    """Exponential moving average of a duration in milliseconds."""

    def __init__(self, alpha: float = 0.1) -> None:
        self._alpha = alpha
        self._value: float | None = None
        self._lock = threading.Lock()

    def add(self, seconds: float) -> None:
        ms = seconds * 1000.0
        with self._lock:
            self._value = ms if self._value is None else (1 - self._alpha) * self._value + self._alpha * ms

    def value(self) -> float:
        with self._lock:
            return self._value or 0.0
