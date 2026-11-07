"""Running heavy work (map generation, saving, export) off the UI thread."""
from __future__ import annotations

import traceback
from typing import Any, Callable

from PySide6.QtCore import QObject, QRunnable, QThreadPool, QTimer, Signal, Slot


class _Signals(QObject):
    done = Signal(object, object)       # (token, result)
    failed = Signal(object, str)        # (token, message)
    progress = Signal(object, float, str)


class _Job(QRunnable):
    def __init__(self, token: Any, fn: Callable, args: tuple, kwargs: dict, signals: _Signals, with_progress: bool):
        super().__init__()
        self.setAutoDelete(True)
        self.token, self.fn, self.args, self.kwargs = token, fn, args, kwargs
        self.signals, self.with_progress = signals, with_progress
        self.cancelled = False

    @Slot()
    def run(self):
        try:
            if self.with_progress:
                self.kwargs["progress"] = lambda f, s="": None if self.cancelled else \
                    self.signals.progress.emit(self.token, float(f), str(s))
            result = self.fn(*self.args, **self.kwargs)
            self.signals.done.emit(self.token, result)      # stale results are dropped by the Runner
        except Exception as e:  # report every failure to the UI, never crash the worker thread
            if not self.cancelled:
                traceback.print_exc()
            self.signals.failed.emit(self.token, str(e) or e.__class__.__name__)


class Runner(QObject):
    """Runs callables on a thread pool and calls back on the UI thread.

    Each call has a channel name; starting a new job on a channel makes the previous job's result be ignored
    (latest-wins), which is what live previews need.
    """

    def __init__(self, parent=None, threads: int | None = None):
        super().__init__(parent)
        self.pool = QThreadPool(self)
        if threads:
            self.pool.setMaxThreadCount(threads)
        self.signals = _Signals()
        self.signals.done.connect(self._done)
        self.signals.failed.connect(self._failed)
        self.signals.progress.connect(self._progress)
        self._serial = 0
        self._latest: dict[str, int] = {}
        self._callbacks: dict[int, tuple[str, Callable | None, Callable | None, Callable | None]] = {}
        self._jobs: dict[int, _Job] = {}

    def run(self, channel: str, fn: Callable, *args, on_done: Callable | None = None,
            on_error: Callable | None = None, on_progress: Callable | None = None, **kwargs) -> int:
        self._serial += 1
        token = self._serial
        old = self._latest.get(channel)
        if old in self._jobs:
            self._jobs[old].cancelled = True
        self._latest[channel] = token
        self._callbacks[token] = (channel, on_done, on_error, on_progress)
        job = _Job(token, fn, args, kwargs, self.signals, on_progress is not None)
        self._jobs[token] = job
        self.pool.start(job)
        return token

    def busy(self, channel: str) -> bool:
        t = self._latest.get(channel)
        return t in self._jobs

    def _finish(self, token):
        self._jobs.pop(token, None)
        cb = self._callbacks.pop(token, None)
        if cb is None:
            return None
        channel = cb[0]
        if self._latest.get(channel) != token:
            return None
        return cb

    def _done(self, token, result):
        cb = self._finish(token)
        if cb and cb[1]:
            cb[1](result)

    def _failed(self, token, message):
        cb = self._finish(token)
        if cb and cb[2]:
            cb[2](message)

    def _progress(self, token, f, s):
        cb = self._callbacks.get(token)
        if cb and cb[3] and self._latest.get(cb[0]) == token:
            cb[3](f, s)

    def wait(self, ms: int = 5000) -> bool:
        return self.pool.waitForDone(ms)


class Debouncer(QObject):
    def __init__(self, ms: int, fn: Callable, parent=None):
        super().__init__(parent)
        self.t = QTimer(self)
        self.t.setSingleShot(True)
        self.t.setInterval(ms)
        self.t.timeout.connect(fn)

    def __call__(self, *_):
        self.t.start()
