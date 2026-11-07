"""Free engines that need no paid API:

* Ollama - a free app that runs open AI models on your own PC (https://ollama.com).
  If it is running, the agent sends it the built-in engine's draft and research data and
  streams back a polished version. Nothing leaves your computer and nothing is billed.
* Prompt builder - a ready-to-paste prompt (instructions + research + draft) for any free
  chatbot (claude.ai, ChatGPT, Gemini free tiers).
Standard library only.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Iterator

from . import core, offline

OLLAMA_URL = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
if not OLLAMA_URL.startswith("http"):
    OLLAMA_URL = "http://" + OLLAMA_URL
SUGGESTED_MODELS = ["llama3.1:8b", "qwen2.5:7b", "gemma2:9b", "mistral:7b"]

LOCAL_SYSTEM = (
    core.SYSTEM_PROMPT.split("## Quality gate")[0]
    .replace("Use keyword_ideas and web_search; never invent search-volume numbers.",
             "Never invent search-volume numbers.")
    + """## How to work here
You have no tools and no internet. You receive the seller's request plus a DRAFT made by a rule-based
engine that already follows the platform limits and scored well on SEO checks. Rewrite and improve the
draft: make the copy sharper and more persuasive, fix anything awkward, keep every section, keep the
Markdown tables, and keep these hard limits: Fiverr title <= 80 characters starting with "I will",
exactly 5 tags of <= 20 characters, description <= 1200 characters with the primary keyword in the
first sentence, Upwork title <= 70 characters. Keep any [bracketed] placeholders for the seller to fill.
Output only the final Markdown."""
)


def ollama_models(timeout: float = 0.6) -> list[str] | None:
    """Installed Ollama models, or None if Ollama isn't running."""
    try:
        with urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=timeout) as r:
            data = json.loads(r.read())
        return [m.get("name", "") for m in data.get("models", []) if m.get("name")]
    except (OSError, ValueError):
        return None


def draft_markdown(task: str, niche: str, about: str, text: str, platform: str, seed: int | None = None) -> str:
    return "\n\n".join(e["text"] for e in offline.run(task, niche, about, text, platform, seed)
                       if e["type"] == "text")


def first_prompt(task: str, niche: str, about: str, text: str, platform: str) -> str:
    request = core.build_task_prompt(task, niche, about, text, platform)
    draft = draft_markdown(task, niche, about, text, platform)
    return f"{request}\n\n=== DRAFT FROM THE BUILT-IN ENGINE (improve this) ===\n\n{draft}"


def chatbot_prompt(task: str, niche: str, about: str, text: str, platform: str) -> str:
    """One self-contained prompt to paste into a free chatbot."""
    return (f"{LOCAL_SYSTEM}\n\n---\n\n{first_prompt(task, niche, about, text, platform)}\n\n---\n"
            "Return the improved, ready-to-publish version in Markdown.")


def run_ollama(model: str, history: list[dict]) -> Iterator[dict]:
    """Stream a chat turn from Ollama. `history` holds {"role","content"} dicts and gets the reply appended."""
    body = json.dumps({
        "model": model,
        "stream": True,
        "messages": [{"role": "system", "content": LOCAL_SYSTEM}, *history],
        "options": {"num_ctx": 8192, "temperature": 0.6},
    }).encode()
    req = urllib.request.Request(f"{OLLAMA_URL}/api/chat", data=body,
                                 headers={"Content-Type": "application/json"})
    yield {"type": "tool", "name": "local_ai", "detail": f"writing with {model} on your PC"}
    reply = []
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            for raw in r:
                if not raw.strip():
                    continue
                chunk = json.loads(raw)
                if chunk.get("error"):
                    raise RuntimeError(chunk["error"])
                piece = (chunk.get("message") or {}).get("content", "")
                if piece:
                    reply.append(piece)
                    yield {"type": "delta", "text": piece}
                if chunk.get("done"):
                    break
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:300]
        raise RuntimeError(f"Ollama error {e.code}: {detail}") from None
    except urllib.error.URLError:
        raise RuntimeError("Can't reach Ollama. Start the Ollama app, or switch to the Built-in engine.") from None
    history.append({"role": "assistant", "content": "".join(reply)})
