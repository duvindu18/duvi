"""Run blocking work (model loading, indexing, probing) off the GUI thread."""

from __future__ import annotations

import inspect
import logging
import traceback
from typing import Any, Callable

from PySide6.QtCore import QObject, QRunnable, QThreadPool, Signal

log = logging.getLogger(__name__)
_ALIVE: set["_Task"] = set()


class _Signals(QObject):
    done = Signal(object)
    failed = Signal(str)
    progress = Signal(int, int, str)


class _Task(QRunnable):
    def __init__(self, fn: Callable[..., Any], args: tuple, kwargs: dict) -> None:
        super().__init__()
        self.setAutoDelete(False)
        self.fn, self.args, self.kwargs = fn, args, kwargs
        self.signals = _Signals()

    def run(self) -> None:
        try:
            if "progress" in inspect.signature(self.fn).parameters:
                self.kwargs["progress"] = lambda done, total, text="": self.signals.progress.emit(done, total, text)
            result = self.fn(*self.args, **self.kwargs)
        except Exception as exc:
            log.error("Background task failed:\n%s", traceback.format_exc())
            msg = getattr(exc, "user_message", None) or str(exc) or exc.__class__.__name__
            self.signals.failed.emit(msg)
        else:
            self.signals.done.emit(result)


def run_task(
    fn: Callable[..., Any],
    *args: Any,
    on_done: Callable[[Any], None] | None = None,
    on_error: Callable[[str], None] | None = None,
    on_progress: Callable[[int, int, str], None] | None = None,
    **kwargs: Any,
) -> None:
    task = _Task(fn, args, kwargs)
    _ALIVE.add(task)

    def _cleanup(*_a: Any) -> None:
        _ALIVE.discard(task)

    if on_done:
        task.signals.done.connect(on_done)
    if on_error:
        task.signals.failed.connect(on_error)
    if on_progress:
        task.signals.progress.connect(on_progress)
    task.signals.done.connect(_cleanup)
    task.signals.failed.connect(_cleanup)
    QThreadPool.globalInstance().start(task)
