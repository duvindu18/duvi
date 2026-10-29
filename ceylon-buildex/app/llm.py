"""Answer service. The dataset is always consulted first; the LLM only writes the answer from retrieved passages.

Which model writes the answer (first match wins):
  1. the choice saved on the portal's Settings screen (Claude, or any OpenAI-compatible server such as OpenAI / Ollama / vLLM)
  2. environment: ANTHROPIC_API_KEY (model ANTHROPIC_MODEL, default claude-sonnet-5-5), or OPENAI_API_KEY / LLM_BASE_URL
  3. a running Ollama on this computer (picked up automatically, no key)
  4. none -> a composed answer built from the best-matching passages, quoted with citations (no generated text)
"""
from __future__ import annotations

import json
import os
import re
import time

import requests

from . import config, highlight, settings

SYSTEM = """You are Ceylon Buildex, a research assistant answering questions about Sri Lankan building and planning regulations, gazette notifications and public procurement / Standard Bidding Documents (SBDs).

Rules:
1. Answer ONLY from the numbered SOURCES (and the FAR CALCULATION block when present). If they do not contain the answer, say plainly that the dataset does not cover it and suggest what to add or check. Never fill gaps from memory.
2. Lead with the answer in the first sentence. Then give the supporting detail. Keep it concise and practical.
3. Cite every factual statement with its source tag like [S1] or [S2][S3]. Quote regulation, section, form and gazette numbers exactly as the sources give them.
4. Some sources are marked status 'superseded', 'verify' or 'unverified', or origin 'seed-extract' (a verified summary rather than the full text). Say so when it affects the answer, and prefer current sources.
5. When a FAR CALCULATION is given, use its numbers verbatim, show the formula (permissible floor area = FAR x net site area), state the table row used, and list the assumptions and warnings it contains.
6. This is information, not legal or professional advice: for decisions on a real parcel, tell the reader to confirm with the Urban Development Authority, the local authority or the procuring entity.
7. Land is often quoted in perches (1 perch = 25.29 m2); convert when helpful.
8. Mark the one to four facts the reader must not miss (a limit, a value, a date, a condition) by wrapping each, 2 to 8 words long, in double equals signs, for example: ==maximum FAR of 5.0==. Never mark a citation tag, never nest or overlap markers, and mark nothing else."""


# ------------------------------------------------------------------ which model answers?
_ollama_cache: dict = {"t": 0.0, "val": None}
PREFERRED_LOCAL = ("qwen3.5", "qwen2.5", "qwen3", "llama3.3", "llama3.2", "llama3.1", "llama3", "mistral", "gemma3", "gemma2", "phi4", "phi3")


def forget_ollama() -> None:
    """Drop the cached Ollama lookup (called when the start-up check has just made the model ready)."""
    _ollama_cache.update(t=0.0, val=None)


def detect_ollama() -> dict | None:
    """A running Ollama (default http://127.0.0.1:11434) is used automatically: written answers without any API key."""
    if time.time() - _ollama_cache["t"] < 20:
        return _ollama_cache["val"]
    val = None
    try:
        r = requests.get(config.OLLAMA_URL.rstrip("/") + "/api/tags", timeout=0.6)
        if r.status_code == 200:
            names = [m.get("name", "") for m in r.json().get("models", []) if m.get("name") and "embed" not in m.get("name", "")]
            local = [n for n in names if "cloud" not in n.lower()]          # cloud models need an Ollama sign-in: use them only if nothing local is installed
            names = local or names
            if names:
                want = config.OLLAMA_MODEL.lower()
                pick = next((n for n in names if n.lower() == want or n.lower() == want + ":latest"), None) or \
                    next((n for pref in PREFERRED_LOCAL for n in names if n.lower().startswith(pref)), names[0])
                val = {"base": config.OLLAMA_URL.rstrip("/") + "/v1", "model": pick}
    except Exception:
        val = None
    _ollama_cache.update(t=time.time(), val=val)
    return val


def _resolve(secret: bool = False, candidate: dict | None = None) -> dict:
    """Decide the answering model. Order: settings saved in the portal, then environment variables, then a local Ollama, else none."""
    s = candidate if candidate is not None else settings.load()
    prov = (s.get("provider") or "").lower()
    if prov == "off":
        return {"provider": "none", "model": None, "source": "settings"}
    if prov == "anthropic":
        key = s.get("anthropic_key") or os.environ.get("ANTHROPIC_API_KEY") or ""
        if key:
            return {"provider": "anthropic", "model": s.get("anthropic_model") or config.ANTHROPIC_MODEL, "source": "settings",
                    "url": config.ANTHROPIC_URL, **({"key": key} if secret else {})}
    elif prov == "openai":
        base = s.get("openai_base") or config.OPENAI_BASE
        return {"provider": "openai", "model": s.get("openai_model") or config.OPENAI_MODEL, "source": "settings", "base": base,
                **({"key": s.get("openai_key") or os.environ.get("OPENAI_API_KEY") or "none"} if secret else {})}
    p = config.LLM_PROVIDER.lower()
    if p == "none":
        return {"provider": "none", "model": None, "source": "environment"}
    if p in ("auto", "anthropic") and os.environ.get("ANTHROPIC_API_KEY"):
        return {"provider": "anthropic", "model": config.ANTHROPIC_MODEL, "source": "environment", "url": config.ANTHROPIC_URL,
                **({"key": os.environ["ANTHROPIC_API_KEY"]} if secret else {})}
    if p in ("auto", "openai") and (os.environ.get("OPENAI_API_KEY") or os.environ.get("LLM_BASE_URL")):
        return {"provider": "openai", "model": config.OPENAI_MODEL, "source": "environment", "base": config.OPENAI_BASE,
                **({"key": os.environ.get("OPENAI_API_KEY", "ollama")} if secret else {})}
    if p == "auto":
        o = detect_ollama()
        if o:
            return {"provider": "openai", "model": o["model"], "source": "ollama", "base": o["base"], **({"key": "ollama"} if secret else {})}
    return {"provider": "none", "model": None, "source": "none"}


def resolve_provider() -> dict:
    """Safe to send to the browser (no key)."""
    r = _resolve()
    return {k: r.get(k) for k in ("provider", "model", "source")}


def test_connection(candidate: dict | None = None) -> dict:
    """Send one tiny request to the configured (or candidate) model and report whether it answers."""
    cfg = _resolve(secret=True, candidate=candidate)
    if cfg["provider"] == "none":
        return {"ok": False, "error": "No model is configured."}
    t0 = time.time()
    try:
        out = _call(cfg, "Reply with the single word: ready", "Say ready.", max_tokens=512)
        return {"ok": bool(out), "provider": cfg["provider"], "model": cfg["model"], "ms": int((time.time() - t0) * 1000), "reply": out[:60],
                **({} if out else {"error": "The model answered with no text."})}
    except Exception as e:
        return {"ok": False, "provider": cfg["provider"], "model": cfg["model"], "error": _friendly(e)}


def _friendly(e: Exception) -> str:
    m = f"{type(e).__name__}: {e}"
    if "401" in m or "authentication" in m.lower() or "invalid x-api-key" in m.lower() or "Incorrect API key" in m:
        return "The provider rejected the API key (401). Check that it was copied completely."
    if "not found" in m.lower() and "pull" in m.lower():
        return "Ollama does not have that model yet. Open Command Prompt and run: ollama pull <model name>  (see `ollama list` for what is installed)."
    if "404" in m and "model" in m.lower():
        return "The provider does not know that model name. Check the model field."
    if "429" in m:
        return "Rate limit or no credit on this key (429)."
    if "Connection" in m or "Max retries" in m or "NameResolution" in m:
        return "Could not reach the server. If this is Ollama, make sure it is running (look for its icon in the system tray) and the address is right."
    return m[:300]


def build_prompt(question: str, passages: list[dict], far: dict | None, far_note: str | None, history: list[dict] | None, compact: bool = False) -> str:
    parts = []
    if history:
        h = "\n".join(f"{m['role'].upper()}: {highlight.strip(m['content'])[:600]}" for m in history[-4:])
        parts.append(f"EARLIER IN THIS CONVERSATION:\n{h}\n")
    parts.append(f"QUESTION: {question}\n")
    if far:
        keep = {k: far.get(k) for k in ("regime_name", "citation", "status_note", "zone", "inputs", "far", "max_gfa_m2", "coverage", "spaces",
                                        "floors_limit", "indicative", "design", "checks", "warnings", "notes") if k in far}
        parts.append("FAR CALCULATION (computed by the portal's rules engine from the gazette tables):\n" + json.dumps(keep, ensure_ascii=False, default=str)[:(3000 if compact else 6000)] + "\n")
    elif far_note:
        parts.append(f"FAR NOTE: {far_note}\n")
    parts.append("SOURCES:")
    for i, p in enumerate(passages, start=1):
        meta = f"[S{i}] {p['title']} | {p.get('category') or ''} | gazette {p.get('gazette_no') or '-'} | status {p.get('status') or '-'} | origin {p.get('origin')} | page {p.get('page')}"
        if p.get("heading"):
            meta += f" | {p['heading'][:90]}"
        parts.append(f"{meta}\n{p['text'][:(1000 if compact else 1800)]}\n")
    return "\n".join(parts)


def _strip_think(t: str) -> str:
    return re.sub(r"<think>.*?</think>", "", t or "", flags=re.S).strip()


def _is_ollama(cfg: dict) -> bool:
    return cfg.get("provider") == "openai" and (cfg.get("source") == "ollama" or ":11434" in (cfg.get("base") or ""))


def _ollama_chat(cfg: dict, system: str, user: str, max_tokens: int | None = None) -> str:
    """Ollama's own chat API: lets us switch off 'thinking' (which would eat the answer budget on reasoning models such as Qwen3)
    and ask for a context window big enough for the retrieved passages. A model that ignores think=false and spends its whole budget
    reasoning gets one retry with a much larger budget."""
    base = re.sub(r"/v1/?$", "", cfg["base"].rstrip("/"))

    def once(n: int):
        r = requests.post(base + "/api/chat", timeout=600, json={
            "model": cfg["model"], "stream": False, "think": False,
            "options": {"num_ctx": 8192, "num_predict": n, "temperature": 0.2},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]})
        if r.status_code != 200:
            raise RuntimeError(f"Ollama {r.status_code}: {r.text[:300]}")
        j = r.json()
        m = j.get("message") or {}
        return _strip_think(m.get("content") or ""), (m.get("thinking") or ""), j.get("done_reason")

    n = max_tokens or config.LLM_MAX_TOKENS
    text, thinking, why = once(n)
    if not text and thinking and why == "length":
        text, thinking, why = once(max(n * 4, 2048))
    if not text:
        raise RuntimeError(f"Ollama ({cfg['model']}) returned no answer text (stopped: {why or 'unknown'}; reasoning text: {len(thinking)} characters). "
                           "Try another model, or raise LLM_MAX_TOKENS.")
    return text


def _call(cfg: dict, system: str, user: str, max_tokens: int | None = None) -> str:
    if cfg["provider"] == "anthropic":
        return _anthropic(cfg, system, user, max_tokens)
    if _is_ollama(cfg):
        try:
            return _ollama_chat(cfg, system, user, max_tokens)
        except Exception as first:
            try:
                out = _openai(cfg, system, user, max_tokens)
                if out:
                    return out
            except Exception:
                pass
            raise first                                      # report the native API's reason: it is the more informative one
    out = _openai(cfg, system, user, max_tokens)
    if not out:
        raise RuntimeError(f"{cfg['model']} returned an empty answer (a reasoning model may have used its whole token budget; try another model or raise LLM_MAX_TOKENS).")
    return out


def _anthropic(cfg: dict, system: str, user: str, max_tokens: int | None = None) -> str:
    r = requests.post(cfg["url"], timeout=90, headers={"x-api-key": cfg["key"], "anthropic-version": "2023-06-01", "content-type": "application/json"},
                      json={"model": cfg["model"], "max_tokens": max_tokens or config.LLM_MAX_TOKENS, "system": system,
                            "messages": [{"role": "user", "content": user}]})
    if r.status_code != 200:
        raise RuntimeError(f"Anthropic API {r.status_code}: {r.text[:300]}")
    data = r.json()
    return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()


def _openai(cfg: dict, system: str, user: str, max_tokens: int | None = None) -> str:
    r = requests.post(cfg["base"].rstrip("/") + "/chat/completions", timeout=180,
                      headers={"Authorization": f"Bearer {cfg.get('key') or 'none'}", "content-type": "application/json"},
                      json={"model": cfg["model"], "max_tokens": max_tokens or config.LLM_MAX_TOKENS,
                            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]})
    if r.status_code != 200:
        raise RuntimeError(f"LLM endpoint {r.status_code}: {r.text[:300]}")
    return _strip_think(r.json()["choices"][0]["message"].get("content") or "")


# ------------------------------------------------------------------ extractive fallback
def _sentences(text: str) -> list[str]:
    flat = re.sub(r"[ \t]+", " ", text)
    parts = re.split(r"(?<=[.;:])\s+|\n{2,}|\n(?=[-*•]|\d+\.)", flat)
    return [s.strip() for s in parts if len(s.strip()) > 25]


def _short_title(t: str) -> str:
    t = re.sub(r"\s+", " ", t or "the source").strip()
    return t if len(t) <= 72 else t[:69].rstrip() + "..."


def _lcfirst_ok(s: str) -> str:
    return s


def extractive_answer(question: str, passages: list[dict], far: dict | None) -> str:
    """No-model fallback: composes a short written answer from the sentences that best match the question. Every sentence is quoted
    from a source and cited; nothing is paraphrased or added."""
    from .retrieval import tokens, SYN
    qt = tokens(question)
    q = set(qt)
    for t in list(q):
        for ex in SYN.get(t, []):
            q.update(w for w in ex.lower().split() if len(w) > 2)
    bigrams = [f"{a} {b}" for a, b in zip(qt, qt[1:])]
    numeric_intent = bool(re.search(r"percent|percentage|how much|how many|maximum|minimum|limit|ratio|fee|period|days|width|height", question.lower()))

    def score(sent: str) -> float:
        low = sent.lower()
        sc = sum(1 + len(t) / 6 for t in q if t in low)
        sc += 2.5 * sum(1 for bg in bigrams if bg in low)
        if numeric_intent and re.search(r"\d", sent):
            sc += 1.5
        return sc

    parts: list[str] = []
    if far:
        parts.append(far_summary(far))
    picks: list[tuple[int, str]] = []
    used: set[str] = set()
    for i, p in enumerate(passages[:5], start=1):
        sents = [s for s in _sentences(p["text"]) if s not in used]
        ranked = [s for s in sorted(sents, key=lambda s: -score(s)) if score(s) > 0][:2] or sents[:1]
        for s in ranked:
            used.add(s)
            picks.append((i, s))
    picks.sort(key=lambda x: (-score(x[1]), x[0]))
    picks = picks[:4]
    if picks:
        best_i, best = picks[0]
        t = passages[best_i - 1]
        lead = f"**{_short_title(t['title'])}** (page {t.get('page')}) says: \u201c{best[:480].strip()}\u201d [S{best_i}]"
        parts.append(lead)
        rest = picks[1:]
        if rest:
            bits = []
            for i, s in rest:
                src = passages[i - 1]
                bits.append(f"- {_short_title(src['title'])}: \u201c{s[:360].strip()}\u201d [S{i}]")
            parts.append("Related passages:\n" + "\n".join(bits))
        used_idx = sorted({i for i, _ in picks})
        tag = lambda idx: "".join(f"[S{i}]" for i in idx)
        notes, by_status = [], {}
        for i in used_idx:
            st = (passages[i - 1].get("status") or "")
            if st in ("superseded", "verify", "unverified", "check-current"):
                by_status.setdefault(st.replace("-", " "), []).append(i)
        for st, idx in by_status.items():
            notes.append(f"{tag(idx)} {'is' if len(idx) == 1 else 'are'} marked {st}")
        seed = [i for i in used_idx if passages[i - 1].get("origin") == "seed-extract"]
        if seed:
            notes.append(f"{tag(seed)} {'is an extract' if len(seed) == 1 else 'are extracts'} of the document, not the full text")
        if notes:
            parts.append("Check before relying on this: " + "; ".join(notes) + ".")
    if not parts:
        return "The dataset has no passage that answers this."
    return "\n\n".join(parts)


def far_summary(far: dict) -> str:
    f = far["far"]
    zone = f" in the {far['zone']['name']} zone (s.{far['zone']['section']})" if far.get("zone") else ""
    net = far["inputs"]["net_area_m2"]
    if f.get("unlimited"):
        head = f"**FAR: unlimited**{zone} - {f['basis']}."
    elif f.get("value") is not None:
        gfa = far.get("max_gfa_m2")
        head = (f"**Permissible FAR: {f['value']:g}**{zone} - {f['basis']}. On a net site of {net:g} m2 that allows up to "
                f"{gfa:,.0f} m2 of floor area (FAR x net area).")
    else:
        head = f"**No FAR result**{zone}: {f.get('basis') or 'see warnings'}"
    bits = [head]
    if far.get("coverage"):
        bits.append(f"Plot coverage up to {far['coverage']['max_pct']}% ({far['coverage']['max_footprint_m2']:,.0f} m2) - {far['coverage']['basis']}.")
    for c in far.get("checks", []):
        bits.append(f"{c['name']}: {c['status'].upper()} - {c['detail']}")
    for w in far.get("warnings", [])[:3]:
        bits.append(f"Note: {w}")
    bits.append(f"Regime: {far['regime_name']}. {far['status_note']}")
    return "\n\n".join(bits)


def answer(question: str, passages: list[dict], far: dict | None = None, far_note: str | None = None, history: list[dict] | None = None) -> dict:
    cfg = _resolve(secret=True)
    if cfg["provider"] == "none":
        return {"answer": extractive_answer(question, passages, far), "mode": "extractive", "model": None}
    local = _is_ollama(cfg)                                   # small local models: fewer, shorter passages keep the prompt inside their context window
    prompt = build_prompt(question, passages[:4] if local else passages, far, far_note, history, compact=local)
    try:
        text = _call(cfg, SYSTEM, prompt)
        if not text:
            raise RuntimeError("empty response")
        return {"answer": text, "mode": "llm", "model": cfg["model"], "source": cfg["source"]}
    except Exception as e:  # never leave the reader without an answer
        return {"answer": extractive_answer(question, passages, far), "mode": "extractive", "model": None,
                "llm_error": _friendly(e)}
