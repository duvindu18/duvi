"""The desktop launcher (launcher.py), run for real as a separate process with a stand-in for the browser window:
it must seed its own data folder, serve the portal, open exactly one window, hold the "one copy" lock, and quit when the window closes.
(Windows-only parts - Edge, CREATE_NO_WINDOW, message boxes, the .exe itself - cannot be exercised here; see README.)"""
import json
import os
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import launcher                      # noqa: E402
from app import winquiet             # noqa: E402

FAKE_BROWSER = '''#!{py}
import os, sys, time
open(os.environ["FAKE_LOG"], "a").write(" ".join(sys.argv[1:]) + "\\n")
time.sleep(float(os.environ.get("FAKE_SLEEP", "1")))
'''


def free_port() -> int:
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def get(url, timeout=3):
    return urllib.request.build_opener(urllib.request.ProxyHandler({})).open(url, timeout=timeout).read()


@unittest.skipIf(os.name == "nt", "uses a stand-in executable script (a Unix shebang)")
class Run(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.home = Path(self.tmp.name) / "home"
        self.browser = Path(self.tmp.name) / "fakebrowser"; self.browser.write_text(FAKE_BROWSER.format(py=sys.executable)); self.browser.chmod(self.browser.stat().st_mode | stat.S_IEXEC)
        self.log = Path(self.tmp.name) / "browser.log"
        self.env = dict(os.environ, LRP_HOME=str(self.home), LRP_BROWSER=str(self.browser), FAKE_LOG=str(self.log), FAKE_SLEEP="2", LRP_OLLAMA_BOOT="0",
                        UPDATE_ON_START="0", PORT=str(free_port()), LRP_GUARD_PORT=str(free_port()), NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost",
                        LRP_BYE_GRACE="1", LRP_HANDOFF_SECS="1", LLM_PROVIDER="none", OLLAMA_URL="http://127.0.0.1:9", PYTHONPATH=str(ROOT))
        self.env.pop("LRP_DATA", None)
        self.procs = []

    def tearDown(self):
        for p in self.procs:
            if p.poll() is None:
                p.kill()
        self.tmp.cleanup()

    def start(self, **env) -> subprocess.Popen:
        p = subprocess.Popen([sys.executable, str(ROOT / "launcher.py")], env=dict(self.env, **env), cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.procs.append(p); return p

    def wait_running(self, timeout=40) -> str:
        end = time.time() + timeout
        while time.time() < end:
            try:
                return json.loads((self.home / "running.json").read_text())["url"]
            except Exception:
                time.sleep(0.2)
        self.fail("the launcher never became ready: " + (self.home / "logs" / "launcher.log").read_text() if (self.home / "logs" / "launcher.log").exists() else "no log")

    def test_runs_seeds_serves_opens_one_window_and_quits_when_it_closes(self):
        p = self.start()
        url = self.wait_running()
        st = json.loads(get(url + "/api/status"))
        self.assertTrue(st["heartbeat"]); self.assertEqual(st["version"], launcher.read_version())
        data = self.home / "data"
        self.assertTrue((data / "seed" / "seed_documents.json").exists()); self.assertTrue((data / "rules" / "far_rules.json").exists())
        self.assertEqual((data / ".bundle-version").read_text().strip(), launcher.read_version())
        self.assertFalse((data / "settings.json").exists())                                   # nothing secret is ever shipped or pre-created
        self.assertGreater(st["dataset"]["documents"] if "documents" in st["dataset"] else 1, 0)
        self.assertIn(b"Ceylon Buildex", get(url + "/"))
        for _ in range(50):                                                                    # the window was opened once, in app mode, with its own profile
            if self.log.exists():
                break
            time.sleep(0.1)
        lines = self.log.read_text().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertIn(f"--app={url}", lines[0]); self.assertIn(f"--user-data-dir={self.home / 'window'}", lines[0])
        self.assertEqual(p.wait(timeout=30), 0)                                                # the fake window ended -> the program quits
        self.assertFalse((self.home / "running.json").exists())
        self.assertIn("serving on " + url, (self.home / "logs" / "launcher.log").read_text())

    def test_second_start_opens_a_window_on_the_running_copy_instead_of_a_second_server(self):
        first = self.start(FAKE_SLEEP="12")
        url = self.wait_running()
        second = self.start(FAKE_SLEEP="1")
        self.assertEqual(second.wait(timeout=30), 0)
        for _ in range(50):
            if len(self.log.read_text().splitlines()) >= 2:
                break
            time.sleep(0.1)
        lines = self.log.read_text().splitlines()
        self.assertEqual(len(lines), 2); self.assertTrue(all(f"--app={url}" in l for l in lines))
        self.assertIsNone(first.poll())                                                        # the first one is still serving
        self.assertEqual(json.loads(get(url + "/api/status"))["heartbeat"], True)

    def test_without_a_window_process_the_pages_own_bye_ends_it(self):
        p = self.start(LRP_BROWSER="none")
        url = self.wait_running()
        def post(path):
            return urllib.request.build_opener(urllib.request.ProxyHandler({})).open(urllib.request.Request(url + path, method="POST", data=b""), timeout=3).status
        self.assertEqual(post("/api/ping"), 204)
        time.sleep(1.5)
        self.assertIsNone(p.poll())                                                            # pinging keeps it alive
        self.assertEqual(post("/api/bye"), 204)
        self.assertEqual(p.wait(timeout=30), 0)

    def test_pings_from_another_site_are_refused(self):
        self.start(FAKE_SLEEP="6")
        url = self.wait_running()
        req = urllib.request.Request(url + "/api/bye", method="POST", data=b"", headers={"Origin": "https://evil.example"})
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=3)
        self.assertEqual(cm.exception.code, 403)

    # ---- the back end of the desktop window (launcher.py --desktop)
    def start_desktop(self, **env) -> tuple[subprocess.Popen, str]:
        port = free_port()
        p = subprocess.Popen([sys.executable, str(ROOT / "launcher.py"), "--desktop"], env=dict(self.env, PORT=str(port), **env), cwd=ROOT,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.procs.append(p)
        url, end = f"http://127.0.0.1:{port}", time.time() + 40
        while time.time() < end:
            try:
                get(url + "/api/status"); return p, url
            except Exception:
                if p.poll() is not None:
                    break
                time.sleep(0.2)
        self.fail("the desktop back end never served: " + ((self.home / "logs" / "launcher.log").read_text() if (self.home / "logs" / "launcher.log").exists() else "no log"))

    def quit_request(self, url, token):
        req = urllib.request.Request(url + "/api/desktop/quit", method="POST", data=b"", headers={"X-Desktop-Token": token})
        return urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=3).status

    def test_desktop_back_end_serves_on_the_given_port_without_heartbeat_or_browser_and_quits_on_the_token(self):
        p, url = self.start_desktop(LRP_DESKTOP_TOKEN="s3cret")
        st = json.loads(get(url + "/api/status"))
        self.assertFalse(st["heartbeat"])                                                      # the window owns its life: the page does not ping
        self.assertFalse(self.log.exists())                                                    # and no browser was opened
        with self.assertRaises(urllib.error.HTTPError) as cm:
            self.quit_request(url, "wrong")
        self.assertEqual(cm.exception.code, 403)
        self.assertIsNone(p.poll())
        self.assertEqual(self.quit_request(url, "s3cret"), 204)
        self.assertEqual(p.wait(timeout=30), 0)
        self.assertIn("asked by the window", (self.home / "logs" / "launcher.log").read_text())

    def test_desktop_back_end_without_a_token_cannot_be_told_to_quit(self):
        p, url = self.start_desktop(LRP_DESKTOP_TOKEN="")
        with self.assertRaises(urllib.error.HTTPError) as cm:
            self.quit_request(url, "")
        self.assertEqual(cm.exception.code, 403)
        self.assertIsNone(p.poll())

    def test_desktop_back_end_quits_when_the_window_process_is_gone(self):
        parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"]); self.procs.append(parent)
        p, url = self.start_desktop(LRP_PARENT_PID=str(parent.pid), LRP_DESKTOP_TOKEN="t")
        time.sleep(1.2)
        self.assertIsNone(p.poll())
        parent.kill(); parent.wait()
        self.assertEqual(p.wait(timeout=30), 0)
        self.assertIn("the window's process ended", (self.home / "logs" / "launcher.log").read_text())

    def test_desktop_back_end_does_not_take_another_port_when_its_port_is_busy(self):
        s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(1); port = s.getsockname()[1]
        try:
            p = subprocess.Popen([sys.executable, str(ROOT / "launcher.py"), "--desktop"], env=dict(self.env, PORT=str(port)), cwd=ROOT,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            self.procs.append(p)
            self.assertEqual(p.wait(timeout=40), 1)                                           # the window chose that port: fail, so it can pick another
        finally:
            s.close()


class Pieces(unittest.TestCase):
    def test_no_console_flag_is_added_on_windows_only(self):
        self.assertEqual(winquiet.patched({"a": 1}, nt=False), {"a": 1})
        self.assertEqual(winquiet.patched({}, nt=True)["creationflags"], 0x08000000)
        self.assertEqual(winquiet.patched({"creationflags": 0x200}, nt=True)["creationflags"], 0x08000200)
        self.assertEqual(winquiet.patched({"creationflags": 0x08000000}, nt=True)["creationflags"], 0x08000000)

    def test_data_seed_is_refreshed_on_a_new_version_but_user_files_are_kept(self):
        with tempfile.TemporaryDirectory() as t:
            t = Path(t); bundle = t / "bundle"; (bundle / "data" / "seed").mkdir(parents=True); (bundle / "data" / "rules").mkdir(parents=True)
            (bundle / "data" / "seed" / "seed_documents.json").write_text("[1]"); (bundle / "data" / "rules" / "far_rules.json").write_text("{}"); (bundle / "VERSION").write_text("1")
            with mock.patch.object(launcher, "BUNDLE", bundle):
                d = launcher.seed_data(t / "home")
                (d / "dataset.sqlite").write_text("mine"); (d / "seed" / "seed_documents.json").write_text("edited")
                launcher.seed_data(t / "home")                                                  # same version: the data is left alone
                self.assertEqual((d / "seed" / "seed_documents.json").read_text(), "edited")
                (bundle / "VERSION").write_text("2"); (bundle / "data" / "seed" / "seed_documents.json").write_text("[2]")
                launcher.seed_data(t / "home")                                                  # new version: reference data refreshed
                self.assertEqual((d / "seed" / "seed_documents.json").read_text(), "[2]")
                self.assertEqual((d / "dataset.sqlite").read_text(), "mine")                    # the person's own data is never touched

    def test_browser_override_and_none(self):
        with mock.patch.dict(os.environ, {"LRP_BROWSER": "none"}):
            self.assertIsNone(launcher.find_browser())
        with mock.patch.dict(os.environ, {"LRP_BROWSER": "/x/edge"}):
            self.assertEqual(launcher.find_browser(), "/x/edge")

    def test_watch_reasons(self):
        class P:
            def __init__(self, rc): self.rc = rc
            def poll(self): return self.rc
        beat = {"last": 0.0, "bye": 0.0, "n": 0}
        self.assertEqual(launcher.watch(P(0), dict(beat, n=3), poll=0.01), "window closed")
        self.assertEqual(launcher.watch(None, {"last": time.time() - 500, "bye": 0.0, "n": 4}, poll=0.01, lost_after=1), "page stopped pinging")
        self.assertEqual(launcher.watch(None, {"last": time.time() - 5, "bye": time.time() - 3, "n": 4}, poll=0.01, bye_grace=1), "page closed")
        # a browser that hands its window to another process and exits at once must not end the session
        t = {"last": 0.0, "bye": 0.0, "n": 0}
        out = []
        threading_t = __import__("threading").Thread(target=lambda: out.append(launcher.watch(P(0), t, poll=0.01, lost_after=0.3)))
        threading_t.start(); time.sleep(0.1); t.update(n=1, last=time.time()); threading_t.join(5)
        self.assertEqual(out, ["page stopped pinging"])
        # and with no window and no page at all it does not linger invisibly
        self.assertEqual(launcher.watch(None, {"last": 0.0, "bye": 0.0, "n": 0}, poll=0.01, no_window_after=0.2), "no window opened")


if __name__ == "__main__":
    unittest.main()
