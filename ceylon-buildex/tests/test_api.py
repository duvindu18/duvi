"""HTTP API through Flask's test client, plus the LLM path against a mock Anthropic / OpenAI-compatible endpoint."""
import io
import json
import os
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile

from app import config, llm, server, settings
from tests.helpers import make_scanned_pdf, make_text_pdf


class Mock(BaseHTTPRequestHandler):
    seen: list = []
    no_native = False
    thinking_only = False
    native_empty = False
    openai_empty = False

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/api/tags":
            raw = json.dumps({"models": [{"name": "nomic-embed-text:latest"}, {"name": "mistral:7b"}, {"name": "llama3.1:8b"}, {"name": "gemma4:31b-cloud"}]}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)
        else:
            self.send_response(404); self.end_headers()

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        Mock.seen.append({"path": self.path, "headers": dict(self.headers), "body": body})
        if self.headers.get("x-api-key") == "bad-key" or self.headers.get("Authorization") == "Bearer bad-key":
            self.send_response(401); self.end_headers(); self.wfile.write(b'{"error":"invalid x-api-key"}'); return
        if self.path.startswith("/fail"):
            self.send_response(500); self.end_headers(); self.wfile.write(b"boom"); return
        if self.path == "/api/chat":
            if Mock.no_native:
                self.send_response(404); self.end_headers(); self.wfile.write(b"not found"); return
            if Mock.native_empty or (Mock.thinking_only and body["options"]["num_predict"] < 1024):
                out = {"message": {"role": "assistant", "content": "", "thinking": "long reasoning " * 20}, "done_reason": "length" if Mock.thinking_only else "stop"}
            else:
                out = {"message": {"role": "assistant", "content": "<think>working it out</think>Mock Ollama answer [S1]."}, "done_reason": "stop"}
            raw = json.dumps(out).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw); return
        if self.path.endswith("/empty/chat/completions") or (Mock.openai_empty and self.path.endswith("/chat/completions")):
            raw = json.dumps({"choices": [{"message": {"content": "", "reasoning": "thinking..."}}]}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw); return
        if self.path.endswith("/think/chat/completions"):
            raw = json.dumps({"choices": [{"message": {"content": "<think>hmm</think>Visible answer [S1]."}}]}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw); return
        if self.path.endswith("/v1/messages"):
            out = {"content": [{"type": "text", "text": "Mock answer: the figure is in the sources [S1]."}]}
        else:
            out = {"choices": [{"message": {"content": "Mock OpenAI answer [S1]."}}]}
        raw = json.dumps(out).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)


def setUpModule():
    global MOCK, BASE
    MOCK = ThreadingHTTPServer(("127.0.0.1", 0), Mock)
    BASE = f"http://127.0.0.1:{MOCK.server_address[1]}"
    threading.Thread(target=MOCK.serve_forever, daemon=True).start()
    server.create_app()


def tearDownModule():
    MOCK.shutdown()


class API(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = server.app.test_client()

    def ask(self, q, **kw):
        r = self.c.post("/api/ask", json={"question": q, **kw})
        self.assertEqual(r.status_code, 200, r.data)
        return r.get_json()

    def test_home_page_and_status(self):
        r = self.c.get("/")
        self.assertEqual(r.status_code, 200); self.assertIn(b"Ceylon Buildex", r.data)
        s = self.c.get("/api/status").get_json()
        self.assertGreaterEqual(s["dataset"]["documents"], 16)
        self.assertTrue(s["ocr"]["available"])

    def test_ask_cites_sources_from_the_dataset(self):
        a = self.ask("What is the bid security requirement in the national competitive bidding goods document?")
        self.assertIn(a["mode"], ("extractive", "llm"))
        self.assertTrue(a["citations"])
        self.assertIn("[S1]", a["answer"])
        self.assertTrue(all({"doc_id", "title", "page", "text", "status", "origin"} <= set(c) for c in a["citations"]))

    def stream(self, q, **kw):
        r = self.c.post("/api/ask/stream", json={"question": q, **kw})
        self.assertEqual(r.status_code, 200); self.assertEqual(r.mimetype, "application/x-ndjson")
        return [json.loads(l) for l in r.data.decode().splitlines() if l.strip()]

    def test_stream_emits_only_real_stages_in_order(self):
        ev = self.stream("What is the bid security requirement in the national competitive bidding goods document?")
        self.assertEqual([e["stage"] for e in ev], ["parse", "search", "found", "write", "done"])
        by = {e["stage"]: e for e in ev}
        self.assertGreater(by["search"]["passages"], 20); self.assertEqual(by["write"]["mode"], "compose")
        self.assertEqual(by["found"]["passages"], len(by["done"]["result"]["citations"]))
        self.assertEqual(by["done"]["result"]["answer"], self.ask("What is the bid security requirement in the national competitive bidding goods document?")["answer"])

    def test_stream_far_stage_only_for_far_questions(self):
        ev = self.stream("What is the maximum FAR for a 20 perch plot on a 40 ft road in the Colombo Municipal Council area, Mixed Development zone?")
        self.assertEqual([e["stage"] for e in ev], ["parse", "far", "search", "found", "write", "done"])
        self.assertEqual(ev[-1]["result"]["far"]["far"]["value"], 5.0)

    def test_stream_no_match_skips_the_write_stage(self):
        ev = self.stream("quantum chromodynamics lattice gauge theory")
        self.assertEqual([e["stage"] for e in ev], ["parse", "search", "found", "done"])
        self.assertEqual(ev[-1]["result"]["mode"], "none")

    def test_stream_validation_and_errors(self):
        self.assertEqual(self.c.post("/api/ask/stream", json={"question": "a"}).status_code, 400)
        from app import retrieval
        real = retrieval.search
        retrieval.search = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("index broken"))
        try:
            ev = self.stream("What is the bid security requirement?")
        finally:
            retrieval.search = real
        self.assertEqual(ev[-1]["stage"], "error"); self.assertIn("index broken", ev[-1]["message"])

    def test_ask_far_question_uses_rules_engine(self):
        a = self.ask("What is the maximum FAR for a 20 perch plot on a 40 ft road in the Colombo Municipal Council area, Mixed Development zone?")
        self.assertEqual(a["far"]["far"]["value"], 5.0)
        self.assertIn("5", a["answer"])
        self.assertTrue(a["far"]["status_note"])

    def test_ask_far_missing_inputs_is_explained_not_guessed(self):
        a = self.ask("What FAR can I get for a 10 perch plot?")
        self.assertIsNone(a["far"])
        self.assertTrue(a["far_note"])

    def test_unanswerable_question_says_so(self):
        a = self.ask("quantum chromodynamics lattice gauge theory")
        self.assertEqual(a["mode"], "none")
        self.assertEqual(a["citations"], [])
        self.assertIn("does not contain", a["answer"])

    def test_validation(self):
        self.assertEqual(self.c.post("/api/ask", json={"question": "a"}).status_code, 400)
        self.assertEqual(self.c.post("/api/ask", json={"question": "x" * 2000}).status_code, 400)
        self.assertEqual(self.c.get("/api/search").status_code, 400)
        self.assertEqual(self.c.get("/api/doc/nope").status_code, 404)
        self.assertEqual(self.c.post("/api/far/calc", json={"regime": "uda2021", "land_extent": 0, "road_width": 9, "zone_factor": 1}).status_code, 400)

    def test_search_docs_and_doc_endpoints(self):
        r = self.c.get("/api/search?q=building+line&category=building-regulations").get_json()
        self.assertTrue(r["results"])
        docs = self.c.get("/api/docs?category=procurement-sbd").get_json()["documents"]
        self.assertTrue(docs and all(d["category"] == "procurement-sbd" for d in docs))
        d = self.c.get(f"/api/doc/{docs[0]['id']}").get_json()
        self.assertTrue(d["chunks"]); self.assertNotIn("local_path", d["document"])
        self.assertEqual(self.c.get(f"/api/doc/{docs[0]['id']}/file").status_code, 404)        # seed extract: no stored original

    def test_far_endpoints(self):
        o = self.c.get("/api/far/options").get_json()
        self.assertGreaterEqual(len(o["cmc_zones"]), 14)
        r = self.c.post("/api/far/calc", json={"regime": "cmc2008", "zone": "CD", "land_extent": 1800, "land_unit": "m2", "road_width": 24, "road_unit": "m", "street_type": "public"}).get_json()
        self.assertEqual(r["far"]["value"], 11.0)
        r = self.c.post("/api/far/calc", json={"regime": "uda2021", "zone_factor": 1.1, "land_extent": 600, "land_unit": "m2", "road_width": 12, "road_unit": "m",
                                                  "proposed": {"floors": 6, "footprint_m2": 300, "gfa_m2": 1800, "parking_m2": 300, "residential": True}}).get_json()
        self.assertEqual(r["far"]["value"], 2.7)
        self.assertEqual(r["design"]["counted_area_m2"], 1500)
        self.assertAlmostEqual(r["design"]["far_used"], 2.5, places=3)
        p = self.c.post("/api/far/parse", json={"text": "FAR for 800 sq m zone factor 2.0 on a 12 m road"}).get_json()
        self.assertTrue(p["looks_like_far"])

    def _wait(self, tid, timeout=90):
        t0 = time.time()
        while time.time() - t0 < timeout:
            t = self.c.get(f"/api/task/{tid}").get_json()
            if t["status"] != "running":
                return t
            time.sleep(0.3)
        self.fail("task timed out")

    def test_ocr_upload_and_add_to_dataset(self):
        pdf = make_scanned_pdf(Path(tempfile.mkdtemp()) / "up.pdf", text="NOTICE TO BIDDERS 4242/9\nAddendum: the pre-bid meeting is moved to 3 November at the Treasury auditorium.")
        r = self.c.post("/api/ocr", data={"file": (io.BytesIO(pdf.read_bytes()), "notice.pdf"), "mode": "fast", "add": "1", "title": "Notice to bidders 4242/9",
                                           "category": "procurement-policy"}, content_type="multipart/form-data")
        self.assertEqual(r.status_code, 202, r.data)
        t = self._wait(r.get_json()["task"])
        self.assertEqual(t["status"], "done", t)
        res = t["result"]
        self.assertEqual(res["ocr_pages"], 1)
        self.assertIn("pre-bid meeting", res["text"])
        self.assertTrue(res["added"]["chunks"] >= 1)
        a = self.ask("When is the pre-bid meeting moved to?")
        self.assertTrue(any(c["title"] == "Notice to bidders 4242/9" for c in a["citations"]), [c["title"] for c in a["citations"]])
        # bad uploads
        self.assertEqual(self.c.post("/api/ocr", data={}, content_type="multipart/form-data").status_code, 400)
        self.assertEqual(self.c.post("/api/ocr", data={"file": (io.BytesIO(b"MZ"), "x.exe")}, content_type="multipart/form-data").status_code, 400)

    def test_add_url_blocks_private_addresses(self):
        for u in ("http://127.0.0.1:8080/secret.pdf", "http://169.254.169.254/latest/meta-data", "file:///etc/passwd", "ftp://example.com/a.pdf", "http://localhost/a.pdf"):
            self.assertEqual(self.c.post("/api/sources/add-url", json={"url": u}).status_code, 400, u)

    def test_sources_and_update_status(self):
        s = self.c.get("/api/sources").get_json()
        self.assertGreaterEqual(len(s["sources"]), 25); self.assertGreaterEqual(len(s["listings"]), 5)
        u = self.c.get("/api/update/status").get_json()
        self.assertIn("running", u)

    def test_export(self):
        r = self.c.get("/api/export/dataset.jsonl")
        self.assertEqual(r.status_code, 200)
        first = json.loads(r.data.decode().splitlines()[0]); self.assertIn("text", first)
        r.close()


class Composed(unittest.TestCase):
    """Without any model the portal still writes a cited answer - and never says 'no language model' inside the answer text."""

    def test_composed_answer_is_cited_prose(self):
        from app import retrieval
        q = "Which gazette replaced the 2006 procurement guidelines?"
        a = llm.extractive_answer(q, retrieval.relevant(retrieval.search(q, limit=8))[:6], None)
        self.assertNotIn("language model", a); self.assertNotIn("extractive mode", a)
        self.assertIn("says:", a); self.assertRegex(a, r"\[S\d\]")
        self.assertEqual(a.count("Check before relying"), 1)


class Settings(unittest.TestCase):
    H = {"Host": "127.0.0.1:8080"}

    def setUp(self):
        self.c = server.app.test_client()
        self._env = {k: os.environ.get(k) for k in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "LLM_BASE_URL")}
        for k in self._env:
            os.environ.pop(k, None)
        self._cfg = (config.LLM_PROVIDER, config.ANTHROPIC_URL, config.OLLAMA_URL)
        config.LLM_PROVIDER = "auto"; config.ANTHROPIC_URL = BASE + "/v1/messages"
        settings.PATH.unlink(missing_ok=True); llm._ollama_cache.update(t=0.0, val=None); Mock.seen.clear()

    def tearDown(self):
        settings.PATH.unlink(missing_ok=True)
        for k, v in self._env.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v
        config.LLM_PROVIDER, config.ANTHROPIC_URL, config.OLLAMA_URL = self._cfg
        llm._ollama_cache.update(t=0.0, val=None)

    def post(self, body, **kw):
        return self.c.post("/api/settings", json=body, headers=kw.get("headers", self.H))

    def test_save_claude_key_then_answers_are_written(self):
        q = "What is the bid security requirement in the national competitive bidding goods document?"
        self.assertEqual(self.c.post("/api/ask", json={"question": q}).get_json()["mode"], "extractive")
        r = self.post({"provider": "anthropic", "api_key": "sk-ant-secret-1234", "model": "claude-sonnet-5-5"}).get_json()
        self.assertTrue(r["saved"], r); self.assertTrue(r["test"]["ok"])
        self.assertEqual(r["llm"]["provider"], "anthropic")
        a = self.c.post("/api/ask", json={"question": q}).get_json()
        self.assertEqual(a["mode"], "llm"); self.assertIn("Mock answer", a["answer"])
        self.assertEqual(Mock.seen[-1]["headers"]["x-api-key"], "sk-ant-secret-1234")

    def test_key_is_never_sent_back_and_file_is_private(self):
        self.post({"provider": "anthropic", "api_key": "sk-ant-secret-1234"})
        for resp in (self.c.get("/api/settings", headers=self.H), self.c.get("/api/status", headers=self.H), self.post({"provider": "auto"})):
            self.assertNotIn(b"secret", resp.data)
        self.post({"provider": "anthropic", "api_key": "sk-ant-secret-1234"})
        g = self.c.get("/api/settings", headers=self.H).get_json()
        self.assertTrue(g["settings"]["anthropic_key"].endswith("1234")); self.assertNotIn("secret", g["settings"]["anthropic_key"])
        self.assertEqual(oct(settings.PATH.stat().st_mode & 0o777), "0o600")

    def test_failed_test_is_not_saved_unless_forced(self):
        r = self.post({"provider": "anthropic", "api_key": "bad-key"}).get_json()
        self.assertFalse(r["saved"]); self.assertIn("rejected the API key", r["test"]["error"])
        self.assertEqual(settings.load(), {})
        r = self.post({"provider": "anthropic", "api_key": "bad-key", "force": True}).get_json()
        self.assertTrue(r["saved"])

    def test_validation(self):
        self.assertEqual(self.post({"provider": "anthropic"}).status_code, 400)                      # no key anywhere
        self.assertEqual(self.post({"provider": "openai", "base_url": "ftp://x", "model": "m"}).status_code, 400)
        self.assertEqual(self.post({"provider": "openai", "base_url": BASE + "/v1"}).status_code, 400)  # no model
        self.assertEqual(self.post({"provider": "nonsense"}).status_code, 400)

    def test_changing_server_address_drops_the_old_key(self):
        self.post({"provider": "openai", "base_url": BASE + "/v1", "model": "m", "api_key": "first-key"})
        self.assertEqual(settings.load()["openai_key"], "first-key")
        self.post({"provider": "openai", "base_url": BASE + "/other/v1", "model": "m"})
        self.assertNotIn("openai_key", settings.load())                                              # a key must not follow a new address

    def test_only_this_computers_own_page_can_change_settings(self):
        body = {"provider": "anthropic", "api_key": "sk-ant-x"}
        self.assertEqual(self.post(body, headers={"Host": "evil.example.com"}).status_code, 403)       # DNS rebinding
        self.assertEqual(self.post(body, headers={"Host": "127.0.0.1:8080", "Origin": "https://evil.example.com"}).status_code, 403)   # other site
        self.assertEqual(self.c.post("/api/settings", data="provider=off", headers=self.H, content_type="text/plain").status_code, 415)
        self.assertEqual(self.c.get("/api/settings", headers={"Host": "evil.example.com"}).status_code, 403)
        self.assertEqual(settings.load(), {})

    def test_off_and_auto(self):
        os.environ["ANTHROPIC_API_KEY"] = "env-key"
        self.assertEqual(llm.resolve_provider()["source"], "environment")
        self.post({"provider": "off"}); self.assertEqual(llm.resolve_provider()["provider"], "none")
        self.post({"provider": "auto"}); self.assertEqual(llm.resolve_provider()["provider"], "anthropic")

    def test_saved_choice_beats_environment(self):
        os.environ["ANTHROPIC_API_KEY"] = "env-key"
        self.post({"provider": "openai", "base_url": BASE + "/v1", "model": "my-model"})
        self.assertEqual(llm.resolve_provider(), {"provider": "openai", "model": "my-model", "source": "settings"})

    def test_ollama_is_picked_up_automatically(self):
        config.OLLAMA_URL = BASE
        r = llm.resolve_provider()
        self.assertEqual((r["provider"], r["source"], r["model"]), ("openai", "ollama", "llama3.1:8b"))      # skips embedding models; prefers local over ':cloud' models
        a = self.c.post("/api/ask", json={"question": "What is the bid security requirement in the national competitive bidding goods document?"}).get_json()
        self.assertEqual(a["mode"], "llm"); self.assertEqual(a["answer"], "Mock Ollama answer [S1].")        # <think> block removed
        req = Mock.seen[-1]
        self.assertEqual(req["path"], "/api/chat")
        self.assertIs(req["body"]["think"], False)                                                          # thinking off: it would eat the answer budget
        self.assertGreaterEqual(req["body"]["options"]["num_ctx"], 8192)
        prompt = req["body"]["messages"][1]["content"]
        self.assertLessEqual(prompt.count("[S"), 5)                                                         # compact prompt for small local models
        self.assertTrue(all(len(line) < 1400 for line in prompt.splitlines()))

    def test_ollama_falls_back_to_openai_route_if_native_api_missing(self):
        config.OLLAMA_URL = BASE; Mock.no_native = True
        try:
            a = self.c.post("/api/ask", json={"question": "What is the bid security requirement in the national competitive bidding goods document?"}).get_json()
        finally:
            Mock.no_native = False
        self.assertEqual(a["mode"], "llm"); self.assertIn("Mock OpenAI answer", a["answer"])

    def test_reasoning_model_that_ignores_think_false_gets_a_bigger_budget(self):
        config.OLLAMA_URL = BASE; Mock.thinking_only = True
        try:
            t = llm.test_connection()
            self.assertTrue(t["ok"], t)
            sizes = [m["body"]["options"]["num_predict"] for m in Mock.seen if m["path"] == "/api/chat"]
            self.assertEqual(sizes, [512, 2048])                  # first try too small for a thinking model, retried with room to finish
        finally:
            Mock.thinking_only = False

    def test_empty_answers_are_reported_with_a_reason(self):
        config.OLLAMA_URL = BASE; Mock.native_empty = True; Mock.openai_empty = True
        try:
            t = llm.test_connection()
        finally:
            Mock.native_empty = False; Mock.openai_empty = False
        self.assertFalse(t["ok"]); self.assertIn("returned no answer text", t["error"]); self.assertIn("llama3.1:8b", t["error"])
        t = llm.test_connection({"provider": "openai", "openai_base": BASE + "/empty", "openai_model": "m"})
        self.assertFalse(t["ok"]); self.assertIn("empty answer", t["error"])
        r = self.post({"provider": "openai", "base_url": BASE + "/empty", "model": "m"}).get_json()                 # what the Settings screen shows
        self.assertFalse(r["saved"]); self.assertIn("empty answer", r["test"]["error"])

    def test_think_blocks_are_stripped_on_the_openai_route(self):
        self.assertEqual(llm._call({"provider": "openai", "base": BASE + "/think", "model": "m", "key": "k"}, "s", "u"), "Visible answer [S1].")
        self.assertTrue(llm._is_ollama({"provider": "openai", "base": "http://127.0.0.1:11434/v1"}))
        self.assertFalse(llm._is_ollama({"provider": "openai", "base": "https://api.openai.com/v1"}))


class UpdateOnStart(unittest.TestCase):
    def test_first_start_only(self):
        marker = config.DATA / ".first_update_started"
        marker.unlink(missing_ok=True)
        calls = []
        real, old = server.ingest.JOB.start, config.UPDATE_ON_START
        server.ingest.JOB.start = lambda **kw: calls.append(kw) or True
        try:
            config.UPDATE_ON_START = "0"; server._update_on_start(); self.assertEqual(calls, [])
            config.UPDATE_ON_START = "first"; server._update_on_start(); server._update_on_start()
            self.assertEqual(len(calls), 1)                       # only the first start downloads
            config.UPDATE_ON_START = "always"; server._update_on_start()
            self.assertEqual(len(calls), 2)
        finally:
            server.ingest.JOB.start, config.UPDATE_ON_START = real, old
            marker.unlink(missing_ok=True)


class LLMPath(unittest.TestCase):
    def setUp(self):
        self._env = {k: os.environ.get(k) for k in ("ANTHROPIC_API_KEY", "LLM_PROVIDER", "OPENAI_API_KEY", "LLM_BASE_URL")}
        self._cfg = (config.LLM_PROVIDER, config.ANTHROPIC_URL, config.OPENAI_BASE)
        Mock.seen.clear()
        self.c = server.app.test_client()

    def tearDown(self):
        for k, v in self._env.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v
        config.LLM_PROVIDER, config.ANTHROPIC_URL, config.OPENAI_BASE = self._cfg

    def test_anthropic_request_shape_and_grounding(self):
        config.LLM_PROVIDER = "auto"; os.environ["ANTHROPIC_API_KEY"] = "test-key"; config.ANTHROPIC_URL = BASE + "/v1/messages"
        r = self.c.post("/api/ask", json={"question": "What is the maximum FAR for a 20 perch plot on a 40 ft road in the Colombo Municipal Council area, Mixed Development zone?"}).get_json()
        self.assertEqual(r["mode"], "llm"); self.assertEqual(r["model"], config.ANTHROPIC_MODEL)
        self.assertIn("Mock answer", r["answer"])
        req = Mock.seen[-1]
        self.assertEqual(req["headers"]["x-api-key"], "test-key"); self.assertEqual(req["headers"]["anthropic-version"], "2023-06-01")
        self.assertEqual(req["body"]["model"], config.ANTHROPIC_MODEL)
        prompt = req["body"]["messages"][0]["content"]
        self.assertIn("SOURCES:", prompt); self.assertIn("[S1]", prompt)
        self.assertIn("FAR CALCULATION", prompt); self.assertIn('"value": 5.0', prompt)               # the engine's number goes to the model verbatim
        self.assertIn("ONLY from the numbered SOURCES", req["body"]["system"])
        self.assertTrue(r["citations"])

    def test_no_llm_call_when_nothing_relevant(self):
        config.LLM_PROVIDER = "auto"; os.environ["ANTHROPIC_API_KEY"] = "test-key"; config.ANTHROPIC_URL = BASE + "/v1/messages"
        r = self.c.post("/api/ask", json={"question": "quantum chromodynamics lattice gauge theory"}).get_json()
        self.assertEqual(r["mode"], "none"); self.assertEqual(Mock.seen, [])

    def test_openai_compatible_endpoint(self):
        config.LLM_PROVIDER = "auto"; os.environ.pop("ANTHROPIC_API_KEY", None); os.environ["LLM_BASE_URL"] = BASE + "/v1"; config.OPENAI_BASE = BASE + "/v1"
        r = self.c.post("/api/ask", json={"question": "What is the bid security requirement in the national competitive bidding goods document?"}).get_json()
        self.assertEqual(r["mode"], "llm"); self.assertIn("Mock OpenAI answer", r["answer"])
        self.assertTrue(Mock.seen[-1]["path"].endswith("/chat/completions"))

    def test_llm_failure_falls_back_to_extractive(self):
        config.LLM_PROVIDER = "auto"; os.environ["ANTHROPIC_API_KEY"] = "test-key"; config.ANTHROPIC_URL = BASE + "/fail/v1/messages"
        r = self.c.post("/api/ask", json={"question": "What is the bid security requirement in the national competitive bidding goods document?"}).get_json()
        self.assertEqual(r["mode"], "extractive"); self.assertIn("llm_error", r); self.assertTrue(r["citations"]); self.assertIn("[S1]", r["answer"])


if __name__ == "__main__":
    unittest.main()
