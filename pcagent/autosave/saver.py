"""Find open documents, press their save shortcut and verify the file on disk changed."""
from __future__ import annotations

import logging
import time
from dataclasses import asdict, dataclass, field
from typing import Iterable, Protocol

from . import keys, locate
from .config import AppProfile, Config
from .verify import stamp, wait_for_save

log = logging.getLogger("autosave")

# status -> does it block an automatic shutdown?
STATUSES = {
    "SAVED": False,            # file on disk got a newer modified time
    "UNCHANGED": False,        # file known, not rewritten: nothing to save (or save ignored)
    "SENT_UNVERIFIED": False,  # Ctrl+S sent but no file found to check
    "UNTITLED": True,          # never-saved document: needs a name, skipped
    "DIALOG": True,            # Ctrl+S opened a prompt (Save As, read-only, ...)
    "BUSY": True,              # app hung or a modal dialog was already open
    "FOCUS_FAILED": True,      # Windows would not let us switch to the window
    "ERROR": True,
}


@dataclass
class Result:
    app: str
    title: str
    status: str
    file: str | None = None
    detail: str = ""
    seconds: float = 0.0

    @property
    def blocking(self) -> bool:
        return STATUSES.get(self.status, True)


@dataclass
class DocWindow:
    hwnd: int
    title: str
    pid: int
    exe: str
    profile: AppProfile
    doc: str | None = None
    candidates: list[str] = field(default_factory=list)


class Desktop(Protocol):
    def list_windows(self) -> list: ...
    def exists(self, hwnd: int) -> bool: ...
    def is_hung(self, hwnd: int) -> bool: ...
    def is_minimized(self, hwnd: int) -> bool: ...
    def foreground(self) -> int: ...
    def focus(self, hwnd: int) -> bool: ...
    def minimize(self, hwnd: int) -> None: ...
    def release_modifiers(self) -> None: ...
    def press(self, codes: list[int]) -> None: ...
    def close(self, hwnd: int) -> None: ...
    def exe_name(self, pid: int) -> str | None: ...
    def open_files(self, pid: int) -> list[str]: ...


class Saver:
    def __init__(self, cfg: Config, desktop: Desktop, *, sleep=time.sleep, wall=time.time):
        self.cfg = cfg
        self.d = desktop
        self.sleep = sleep
        self.wall = wall

    # ---------------------------------------------------------- discovery
    def find_documents(self) -> list[DocWindow]:
        docs: list[DocWindow] = []
        exe_cache: dict[int, str | None] = {}
        files_cache: dict[int, list[str]] = {}
        for w in self.d.list_windows():
            if w.owned or not w.title.strip():
                continue
            if w.pid not in exe_cache:
                exe_cache[w.pid] = self.d.exe_name(w.pid)
            exe = exe_cache[w.pid]
            prof = self.cfg.profile_for(exe) if exe else None
            if prof is None:
                continue
            if w.pid not in files_cache:
                files_cache[w.pid] = self.d.open_files(w.pid)
            dw = DocWindow(w.hwnd, w.title, w.pid, exe, prof)
            dw.doc = locate.doc_name_from_title(w.title, prof.extensions)
            dw.candidates = self._resolve(dw, files_cache[w.pid])
            docs.append(dw)
        return docs

    def _resolve(self, dw: DocWindow, open_files: list[str]) -> list[str]:
        prof = dw.profile
        if dw.doc and len(dw.doc) > 3 and dw.doc[1:3] == ":\\":
            return [dw.doc]
        hits = locate.candidates_from_open_files(dw.doc, open_files, prof.extensions)
        if hits:
            return hits
        if dw.doc and not prof.is_untitled(dw.doc):
            return locate.search_dirs(dw.doc, self.cfg.general.search_paths(), prof.extensions,
                                      self.cfg.general.search_depth)
        return []

    # --------------------------------------------------------------- save
    def save_all(self, docs: Iterable[DocWindow] | None = None) -> list[Result]:
        docs = list(self.find_documents() if docs is None else docs)
        original_fg = self.d.foreground()
        results = []
        for dw in docs:
            was_min = self.d.is_minimized(dw.hwnd)
            try:
                r = self.save_one(dw)
            except Exception as e:  # keep going with the other windows
                log.exception("saving %s failed", dw.title)
                r = Result(dw.profile.name, dw.title, "ERROR", detail=repr(e))
            if was_min and self.d.exists(dw.hwnd):
                self.d.minimize(dw.hwnd)
            log.info("%-15s %-11s %s %s", r.app, r.status, r.title, r.file or r.detail)
            results.append(r)
            self.sleep(self.cfg.general.between_windows_seconds)
        if original_fg and self.d.exists(original_fg):
            self.d.focus(original_fg)
        return results

    def save_one(self, dw: DocWindow) -> Result:
        prof = dw.profile
        res = Result(prof.name, dw.title, "ERROR", file=(dw.candidates[0] if dw.candidates else None))
        if prof.is_untitled(dw.doc):
            res.status, res.detail = "UNTITLED", "never saved - give it a name once with Save As"
            return res
        if self.d.is_hung(dw.hwnd):
            res.status, res.detail = "BUSY", "application is not responding"
            return res
        wins = self.d.list_windows()
        before = {w.hwnd for w in wins if w.pid == dw.pid}
        me = next((w for w in wins if w.hwnd == dw.hwnd), None)
        if me is None:
            res.status, res.detail = "ERROR", "window closed before it could be saved"
            return res
        if not me.enabled:  # a modal dialog is sitting on top of it
            res.status, res.detail = "BUSY", "a dialog is already open in this app"
            return res
        if not self.d.focus(dw.hwnd):
            res.status, res.detail = "FOCUS_FAILED", "could not bring window to front"
            return res

        self.d.release_modifiers()
        for combo in prof.pre_keys:
            self.d.press(keys.parse(combo))
            self.sleep(0.15)
        before_stamps = {p: stamp(p) for p in dw.candidates}
        sent_at = self.wall()
        for combo in prof.save_keys:
            self.d.press(keys.parse(combo))

        first_seen: dict[int, float] = {}

        def dialog_check() -> str | None:
            if not prof.detect_dialogs:
                return None
            now = self.wall()
            for w in self.d.list_windows():
                if w.pid == dw.pid and w.hwnd not in before and w.title.strip():
                    t0 = first_seen.setdefault(w.hwnd, now)
                    if now - t0 >= 2.0:
                        return w.title
            return None

        watch = dw.candidates
        wr = wait_for_save(watch, prof.timeout_seconds, before=before_stamps,
                                abort=dialog_check) if watch else None

        if wr is None:  # no known file: watch the project folders for a fresh one
            return self._verify_by_scan(res, dw, sent_at, dialog_check)

        res.seconds = round(wr.seconds, 2)
        if wr.reason == "saved":
            res.status, res.file = "SAVED", wr.saved_path
        elif wr.reason.startswith("aborted:"):
            self._dialog(res, wr.reason, dw)
        else:
            res.status = "UNCHANGED"
            res.detail = "file not rewritten - no unsaved changes, or the app ignored Ctrl+S"
        return res

    def _verify_by_scan(self, res: Result, dw: DocWindow, sent_at: float, dialog_check) -> Result:
        prof, g = dw.profile, self.cfg.general
        dirs = g.search_paths()
        end = sent_at + prof.timeout_seconds
        while self.wall() < end:
            fresh = locate.recently_modified(dirs, prof.extensions, sent_at - 1, g.search_depth)
            if dw.doc:  # prefer the file named like the window title
                named = [f for f in fresh if locate.name_matches(dw.doc, f, prof.extensions)]
                fresh = named or fresh
            if fresh:
                res.status, res.file, res.detail = "SAVED", fresh[0], "found by folder scan"
                self._wait_stable(fresh[0], end)
                break
            why = dialog_check()
            if why:
                self._dialog(res, "aborted:" + why, dw)
                break
            if not any(d.is_dir() for d in dirs):
                break
            self.sleep(2.0)
        if res.status == "ERROR":  # neither a fresh file nor a prompt
            res.status = "SENT_UNVERIFIED"
            res.detail = "file not found - add its folder to search_dirs to verify"
        res.seconds = round(self.wall() - sent_at, 2)
        return res

    def _wait_stable(self, path: str, end: float) -> None:
        last = stamp(path)
        while self.wall() < end:
            self.sleep(1.0)
            now = stamp(path)
            if now == last:
                return
            last = now

    def _dialog(self, res: Result, reason: str, dw: DocWindow) -> None:
        title = reason.split(":", 1)[1]
        res.status, res.detail = "DIALOG", f"prompt appeared: {title!r}"
        if self.cfg.general.cancel_unexpected_dialogs:
            self.d.press(keys.parse("esc"))
            res.detail += " (closed with Esc)"

    # -------------------------------------------------------------- close
    def close_all(self, docs: Iterable[DocWindow], timeout: float = 20.0) -> list[Result]:
        """Ask each window to close. A 'save changes?' prompt means unsaved work: cancel it."""
        out = []
        for dw in docs:
            if not self.d.exists(dw.hwnd):
                continue
            before = {w.hwnd for w in self.d.list_windows() if w.pid == dw.pid}
            self.d.close(dw.hwnd)
            end = self.wall() + timeout
            status, detail = "ERROR", "window did not close"
            while self.wall() < end:
                if not self.d.exists(dw.hwnd):
                    status, detail = "SAVED", "closed"
                    break
                prompts = [w for w in self.d.list_windows()
                           if w.pid == dw.pid and w.hwnd not in before and w.title.strip()]
                if prompts:
                    self.d.focus(prompts[0].hwnd)
                    self.d.press(keys.parse("esc"))
                    status, detail = "DIALOG", f"close asked {prompts[0].title!r} - unsaved changes, left open"
                    break
                self.sleep(0.25)
            out.append(Result(dw.profile.name, dw.title, status, detail=detail))
        return out


def summarize(results: list[Result]) -> dict:
    counts: dict[str, int] = {}
    for r in results:
        counts[r.status] = counts.get(r.status, 0) + 1
    return {
        "time": time.strftime("%Y-%m-%d %H:%M:%S"),
        "counts": counts,
        "safe_to_shutdown": not any(r.blocking for r in results),
        "results": [asdict(r) for r in results],
    }
