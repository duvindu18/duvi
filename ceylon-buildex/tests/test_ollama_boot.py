"""The start-up check for Ollama, against a fake `ollama` program (a small script that speaks the same command line and HTTP API),
so the whole sequence runs for real: find the program, start the server, download the model, run  ollama run <model> "Say ready".
The real Ollama and the real model are not needed (and are not used)."""
import json
import os
import socket
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path
from unittest import mock

from app import config, ollama_boot, server, settings

FAKE = textwrap.dedent('''\
    #!{py}
    import json, os, sys, time
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    D = os.environ["FAKE_OLLAMA_DIR"]
    def log(*a):
        with open(os.path.join(D, "calls.log"), "a") as f: f.write(" ".join(a) + "\\n")
    def models():
        p = os.path.join(D, "models.txt")
        return [l.strip() for l in open(p)] if os.path.exists(p) else []
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "serve":
        log("serve", os.environ.get("OLLAMA_HOST", ""))
        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass
            def _json(self, obj, code=200):
                raw = json.dumps(obj).encode(); self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)
            def do_GET(self):
                if self.path == "/api/version": self._json({{"version": "0.0-fake"}})
                elif self.path == "/api/tags": self._json({{"models": [{{"name": m}} for m in models()]}})
                else: self._json({{}}, 404)
            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0); body = json.loads(self.rfile.read(n) or b"{{}}")
                if self.path == "/api/pull":
                    log("pull", body.get("model", ""))
                    self.send_response(200); self.send_header("Content-Type", "application/x-ndjson"); self.end_headers()
                    for c in (0, 40, 100):
                        self.wfile.write((json.dumps({{"status": "pulling", "total": 100, "completed": c}}) + "\\n").encode()); self.wfile.flush(); time.sleep(0.05)
                    with open(os.path.join(D, "models.txt"), "a") as f: f.write(body.get("model", "") + "\\n")
                    self.wfile.write((json.dumps({{"status": "success"}}) + "\\n").encode())
                else: self._json({{}}, 404)
        host, _, port = os.environ.get("OLLAMA_HOST", "127.0.0.1:11434").partition(":")
        ThreadingHTTPServer((host, int(port)), H).serve_forever()
    elif cmd == "run":
        log("run", sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "")
        if sys.argv[2] not in models():
            sys.stderr.write("Error: model '%s' not found\\n" % sys.argv[2]); sys.exit(1)
        sys.stdout.write(os.environ.get("FAKE_REPLY", "Ready.") + "\\n")
    elif cmd == "pull":
        log("pull-cli", sys.argv[2]); open(os.path.join(D, "models.txt"), "a").write(sys.argv[2] + "\\n")
    else:
        sys.exit(2)
''')


def free_port() -> int:
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


@unittest.skipIf(os.name == "nt", "uses a stand-in executable script (a Unix shebang)")
class Boot(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.dir = Path(self.tmp.name)
        self.exe = self.dir / "ollama"; self.exe.write_text(FAKE.format(py=sys.executable)); self.exe.chmod(self.exe.stat().st_mode | stat.S_IEXEC)
        self.port = free_port()
        env = {"FAKE_OLLAMA_DIR": str(self.dir), "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"}
        self.patches = [mock.patch.dict(os.environ, env), mock.patch.object(config, "OLLAMA_URL", f"http://127.0.0.1:{self.port}"),
                        mock.patch.object(config, "OLLAMA_BIN", str(self.exe)), mock.patch.object(config, "OLLAMA_MODEL", "qwen3.5:4b"),
                        mock.patch.object(config, "OLLAMA_AUTOPULL", True), mock.patch.object(config, "OLLAMA_CHECK_PROMPT", "Say ready")]
        for p in self.patches:
            p.start()
        ollama_boot._set("idle", "", progress=None, reply="", started_server=False)

    def tearDown(self):
        ollama_boot.stop_own_server()
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def calls(self) -> list[str]:
        f = self.dir / "calls.log"
        return f.read_text().splitlines() if f.exists() else []

    def test_starts_the_server_downloads_the_model_and_runs_the_check(self):
        r = ollama_boot.boot()
        self.assertEqual(r["state"], "ready", r)
        self.assertTrue(r["started_server"])
        c = self.calls()
        self.assertTrue(c[0].startswith("serve 127.0.0.1:" + str(self.port)))              # started by us, on the configured address
        self.assertIn("pull qwen3.5:4b", c)                                              # the model was missing, so it was downloaded
        self.assertEqual(c[-1], "run qwen3.5:4b Say ready")                              # and the literal check command was run
        self.assertIn("ready", r["reply"].lower())
        self.assertTrue(ollama_boot.has_model("qwen3.5:4b"))

    def test_a_server_that_is_already_running_is_left_alone(self):
        (self.dir / "models.txt").write_text("qwen3.5:4b\n")
        srv = subprocess.Popen([str(self.exe), "serve"], env=dict(os.environ, OLLAMA_HOST=f"127.0.0.1:{self.port}"))
        try:
            for _ in range(60):
                if ollama_boot.server_up():
                    break
                time.sleep(0.1)
            r = ollama_boot.boot()
        finally:
            srv.terminate(); srv.wait(5)
        self.assertEqual(r["state"], "ready", r)
        self.assertFalse(r["started_server"])
        self.assertEqual([c for c in self.calls() if not c.startswith("serve")], ["run qwen3.5:4b Say ready"])      # no second server, no download

    def test_missing_program_is_reported_not_raised(self):
        with mock.patch.object(ollama_boot, "find_binary", return_value=None):
            r = ollama_boot.boot()
        self.assertEqual(r["state"], "missing")
        self.assertIn("ollama.com", r["message"])

    def test_a_reply_without_ready_is_reported_honestly(self):
        with mock.patch.dict(os.environ, {"FAKE_REPLY": "Hello there"}):
            r = ollama_boot.boot()
        self.assertEqual(r["state"], "ready")
        self.assertIn("not with", r["message"])

    def test_autopull_off_explains_what_to_run(self):
        with mock.patch.object(config, "OLLAMA_AUTOPULL", False):
            r = ollama_boot.boot()
        self.assertEqual(r["state"], "error")
        self.assertIn("ollama pull qwen3.5:4b", r["message"])
        self.assertNotIn("pull qwen3.5:4b", self.calls())

    def test_a_failing_check_becomes_an_error_state(self):
        (self.dir / "models.txt").write_text("other-model:1b\n")
        with mock.patch.object(ollama_boot, "has_model", side_effect=[False, True]), mock.patch.object(ollama_boot, "pull"):
            r = ollama_boot.boot()                      # the model "installed" is a different one, so `ollama run` fails
        self.assertEqual(r["state"], "error")
        self.assertIn("not found", r["message"])

    def test_background_start_returns_at_once_and_finishes(self):
        t0 = time.time(); first = ollama_boot.boot_async(force=True)
        self.assertLess(time.time() - t0, 1.0)
        self.assertIn(first["state"], ollama_boot.BUSY)
        for _ in range(100):
            if ollama_boot.status()["state"] not in ollama_boot.BUSY:
                break
            time.sleep(0.1)
        self.assertEqual(ollama_boot.status()["state"], "ready")

    def test_when_it_should_start(self):
        with mock.patch.object(settings, "load", return_value={}):
            with mock.patch.object(config, "OLLAMA_BOOT", "auto"):
                self.assertTrue(ollama_boot.wanted())
            with mock.patch.object(config, "OLLAMA_BOOT", "0"):
                self.assertFalse(ollama_boot.wanted())
            with mock.patch.object(config, "OLLAMA_BOOT", "1"):
                self.assertTrue(ollama_boot.wanted())
        with mock.patch.object(config, "OLLAMA_BOOT", "auto"):
            for saved, want in (({"provider": "anthropic"}, False), ({"provider": "off"}, False), ({"provider": "auto"}, True),
                                ({"provider": "openai", "openai_base": "https://api.openai.com/v1"}, False),
                                ({"provider": "openai", "openai_base": "http://127.0.0.1:11434/v1"}, True)):
                with mock.patch.object(settings, "load", return_value=saved):
                    self.assertEqual(ollama_boot.wanted(), want, saved)

    def test_disabled_state_is_reported(self):
        with mock.patch.object(config, "OLLAMA_BOOT", "0"):
            r = ollama_boot.boot_async()
        self.assertEqual(r["state"], "disabled")

    def test_api_exposes_the_state_and_settings_carry_it(self):
        c = server.app.test_client()
        r = c.get("/api/ollama").get_json()
        self.assertIn("state", r); self.assertEqual(r["command"], 'ollama run qwen3.5:4b "Say ready"')
        s = c.get("/api/settings", headers={"Host": "127.0.0.1"}).get_json()
        self.assertIn("ollama_boot", s)
        self.assertIn("ollama_boot", c.get("/api/status").get_json())
        # re-checking is only allowed from this computer's own page
        self.assertEqual(c.post("/api/ollama/check", json={}, headers={"Host": "evil.example"}).status_code, 403)


if __name__ == "__main__":
    unittest.main()
