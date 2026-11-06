import json
import threading
import urllib.request

from seo_agent import web


def fake_turn(client, history):
    yield {"type": "tool", "name": "keyword_ideas", "detail": "exterior"}
    history.append({"role": "assistant", "content": []})
    yield {"type": "text", "text": "## Gig Title\nI will do 3d exterior rendering"}


def _post(port, path, payload):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return [json.loads(l) for l in r.read().decode().splitlines() if l.strip()]


def test_run_and_chat_stream(monkeypatch):
    monkeypatch.setattr(web, "turn_runner", fake_turn)
    monkeypatch.setattr(web, "_get_client", lambda: None)
    httpd = web.serve("127.0.0.1", 0)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/") as r:
            assert b"ArchViz SEO Agent" in r.read()
        evs = _post(port, "/api/run", {"session": "s1", "task": "fiverr", "niche": "exterior"})
        assert [e["type"] for e in evs] == ["tool", "text", "done"]
        assert web._sessions["s1"][0]["role"] == "user"
        evs = _post(port, "/api/chat", {"session": "s1", "message": "shorter title"})
        assert evs[-1]["type"] == "done" and len(web._sessions["s1"]) == 4
    finally:
        httpd.shutdown()
