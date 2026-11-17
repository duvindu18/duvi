"""Confirm a save really happened by watching file modified times."""
from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Callable, Iterable


@dataclass(frozen=True)
class Stamp:
    mtime_ns: int | None  # None = file missing
    size: int | None


def stamp(path: str, stat: Callable = os.stat) -> Stamp:
    try:
        st = stat(path)
        return Stamp(st.st_mtime_ns, st.st_size)
    except OSError:
        return Stamp(None, None)


def is_newer(before: Stamp, now: Stamp) -> bool:
    if now.mtime_ns is None:
        return False
    return before.mtime_ns is None or now.mtime_ns > before.mtime_ns


@dataclass
class WaitResult:
    saved_path: str | None
    reason: str  # "saved" | "timeout" | "aborted:<why>"
    seconds: float


def wait_for_save(paths: Iterable[str], timeout: float, *, before: dict[str, Stamp] | None = None,
                  stable_for: float = 1.0,
                  poll: float = 0.25, abort: Callable[[], str | None] = lambda: None,
                  stat: Callable = os.stat, clock: Callable[[], float] = time.monotonic,
                  sleep: Callable[[float], None] = time.sleep) -> WaitResult:
    """Wait until any of `paths` gets a newer mtime and then stops changing.

    `before` should be taken *before* the save keys are sent (a fast save can
    finish before this function starts). `abort()` is polled; returning a
    string (e.g. a dialog title) stops the wait.
    """
    paths = list(paths)
    before = dict(before or {})
    for p in paths:
        before.setdefault(p, stamp(p, stat))
    start = clock()
    changed: str | None = None
    last: Stamp | None = None
    last_change_t = 0.0
    while True:
        now_t = clock()
        if changed is None:
            for p in paths:
                s = stamp(p, stat)
                if is_newer(before[p], s):
                    changed, last, last_change_t = p, s, now_t
                    break
        else:
            s = stamp(changed, stat)
            if s != last:
                last, last_change_t = s, now_t
            elif now_t - last_change_t >= stable_for:
                return WaitResult(changed, "saved", now_t - start)
        if changed is None:
            why = abort()
            if why:
                return WaitResult(None, f"aborted:{why}", now_t - start)
        if now_t - start >= timeout:
            if changed is not None:  # still being written; it did save
                return WaitResult(changed, "saved", now_t - start)
            return WaitResult(None, "timeout", now_t - start)
        sleep(poll)
