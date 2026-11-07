import json
import threading
import urllib.error
import urllib.request

import pytest

from seo_agent import web


def fake_claude(client, history):
    yield {"type": "tool", "name": "keyword_ideas", "detail": "exterior"}
    history.append({"role": "assistant", "content": []})
    yield {"type": "text", "text": "## Gig Title\nI will do 3d exterior rendering"}


def fake_ollama(model, history):
    yield {"type": "tool", "name": "local_ai", "detail": model}
    for piece in ("## Polished", " gig"):
        yield {"type": "delta", "text": piece}
    history.append({"role": "assistant", "content": "## Polished gig"})


@pytest.fixture
def server(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    monkeypatch.setenv("APPDATA", str(tmp_path))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(web, "turn_runner", fake_claude)
    monkeypatch.setattr(web, "_get_client", lambda: None)
    monkeypatch.setattr(web.local_llm, "run_ollama", fake_ollama)
    monkeypatch.setattr(web.local_llm, "ollama_models", lambda timeout=0.6: ["llama3.1:8b"])
    httpd = web.serve("127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield httpd.server_address[1]
    httpd.shutdown()
    web._client = None


def _post(port, path, payload, headers=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json", **(headers or {})})
    with urllib.request.urlopen(req) as r:
        return [json.loads(l) for l in r.read().decode().splitlines() if l.strip()]


def test_builtin_is_default_and_free(server):
    with urllib.request.urlopen(f"http://127.0.0.1:{server}/") as r:
        assert b"ArchViz SEO Agent" in r.read()
    evs = _post(server, "/api/run", {"session": "b", "task": "full", "niche": "exterior rendering"})
    assert evs[-1]["type"] == "done"
    md = evs[-1]["markdown"]
    assert "Fiverr Gig Optimization Package" in md and "Upwork" in md
    follow = _post(server, "/api/chat", {"session": "b", "message": "shorter"})
    assert follow[0]["type"] == "notice"


def test_ollama_engine_streams_deltas(server):
    evs = _post(server, "/api/run", {"session": "o", "engine": "ollama", "task": "fiverr", "niche": "interior"})
    assert [e["type"] for e in evs] == ["tool", "delta", "delta", "done"]
    assert evs[-1]["markdown"] == "## Polished gig"
    hist = web._sessions["o"]["history"]
    assert hist[0]["role"] == "user" and "DRAFT FROM THE BUILT-IN ENGINE" in hist[0]["content"]
    _post(server, "/api/chat", {"session": "o", "message": "punchier title"})
    assert len(web._sessions["o"]["history"]) == 4


def test_claude_engine_still_works(server):
    evs = _post(server, "/api/run", {"session": "c", "engine": "claude", "task": "fiverr", "niche": "exterior"})
    assert [e["type"] for e in evs] == ["tool", "text", "done"]


def test_prompt_for_free_chatbot(server):
    r = _post(server, "/api/prompt", {"task": "proposal", "text": "Need 3 dusk renders of a modern villa from Revit."})
    assert "villa" in r[0]["prompt"] and "Return the improved" in r[0]["prompt"]


def test_status_key_and_origin(server):
    with urllib.request.urlopen(f"http://127.0.0.1:{server}/api/status") as r:
        st = json.loads(r.read())
    assert st["has_key"] is False and st["ollama"] == ["llama3.1:8b"]
    assert _post(server, "/api/key", {"key": "nope"})[0]["ok"] is False
    assert _post(server, "/api/key", {"key": "sk-ant-test123"})[0]["ok"] is True
    with pytest.raises(urllib.error.HTTPError) as e:
        _post(server, "/api/key", {"key": "sk-ant-x"}, {"Origin": "http://evil.example"})
    assert e.value.code == 403
