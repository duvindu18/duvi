"""Headless-browser test of the Ceylon Buildex interface (desktop, phone, dark and light, reduced motion, a wide screen, the desktop title bar).

The page is a sidebar (places, recent questions), a framed workspace and a status bar. Asking is a conversation: each question becomes
a turn in which the assistant thinks out loud (steps driven only by the server's real events) and then answers with citations.
The library is a matrix of kind x year with an inspector.

    python tests/ui_smoke.py [base_url] [screenshot_dir]

With no base_url it starts its own server on a free port with a throw-away data directory (the shipped seed + rules).
Needs `playwright` + Chromium (optional dependency; the unittest suite does not need it).

The stream test puts a small proxy between the page and the server and feeds /api/ask/stream one event at a time, so it can prove that
what the thinking panel shows is exactly what it has been told, in order, and nothing more.
"""
from __future__ import annotations

import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from playwright.sync_api import sync_playwright  # noqa: E402

from tests.helpers import GatedProxy, MockLLM, make_scanned_pdf  # noqa: E402  (importing tests/ also points LRP_DATA at a temp dir)

BASE = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else None
SHOTS = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(tempfile.mkdtemp())
SHOTS.mkdir(parents=True, exist_ok=True)
results: list[tuple[str, bool, str]] = []
mock = MockLLM()
SERVER = None
STEP_VOCAB = [r"^Reading your question$", r"^Calculating the floor area ratio$", r"^Searching the library$", r"^Found [\d,]+ passages?$", r"^No matching passages$",
              r"^Writing the answer$", r"^Composing the answer$", r"^Searching the passages$"]


def check(name: str, ok: bool, detail: str = ""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f"  -- {detail}" if detail else ""), flush=True)


def start_server() -> str:
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    env = dict(os.environ, PORT=str(port), HOST="127.0.0.1", LLM_PROVIDER="none", OLLAMA_URL="http://127.0.0.1:9", LRP_OLLAMA_BOOT="0", LRP_DELAY="0",
               NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost")
    global SERVER
    SERVER = subprocess.Popen([sys.executable, "-m", "app.server"], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(80):
        try:
            opener.open(base + "/api/status", timeout=1).read(); return base
        except Exception:
            time.sleep(0.25)
    raise RuntimeError("server did not start")


# ---------------------------------------------------------------- helpers
STEPS_JS = """() => { window.__steps = []; window.__stepT = []; new MutationObserver(() => {
  document.querySelectorAll('.turn:last-child .steps .step:not(.wait) .st').forEach(el => { if (!el.__seen) { el.__seen = 1; window.__steps.push(el.textContent.trim()); window.__stepT.push(performance.now()); } }); })
  .observe(document.body, {subtree: true, childList: true}); }"""


def steps_now(page):
    return page.eval_on_selector_all(".turn:last-child .steps .step:not(.wait) .st", "els => els.map(e => e.textContent.trim())")


def wait_steps(page, n, timeout=6000):
    page.wait_for_function("n => document.querySelectorAll('.turn:last-child .steps .step:not(.wait)').length >= n", arg=n, timeout=timeout)


def ask(page, q, wait=True):
    page.fill("#q", q); page.press("#q", "Enter")
    if wait:
        answer_ready(page)


def answer_ready(page, timeout=30000):
    page.wait_for_function("""() => { const a = document.querySelector('.turn:last-child'); return a && !a.hasAttribute('aria-busy') && a.querySelector('.abody > *')
      && a.querySelector('.think').dataset.state !== 'running'; }""", timeout=timeout)


def new_page(br, base, vp, **kw):
    ctx = br.new_context(viewport=vp, **kw)
    page = ctx.new_page(); errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text and "ERR_" not in m.text else None)
    page.goto(base + "/#ask", wait_until="domcontentloaded")
    page.wait_for_function("document.documentElement.dataset.ready === '1'", timeout=15000)
    page.evaluate("document.fonts.ready.then(() => true)")
    return ctx, page, errors


def nav(page, view, phone=False):
    if phone:
        page.click("#menuBtn"); page.wait_for_selector(".sidebar.open", timeout=3000); page.wait_for_timeout(350)
    page.click(f'.nav button[data-view="{view}"]')
    page.wait_for_function("v => document.querySelector('#view-' + v).classList.contains('on')", arg=view, timeout=3000)
    page.wait_for_timeout(250)


def open_settings(page):
    page.evaluate("document.querySelector('#settingsBtn').click()"); page.wait_for_selector("#settings[open][data-ready]", timeout=5000)


def close_settings(page):
    page.click("#stClose"); page.wait_for_function("!document.querySelector('#settings').open", timeout=5000)


def lum(page, sel="body"):
    c = [int(x) for x in re.findall(r"\d+", page.evaluate(f"getComputedStyle(document.querySelector('{sel}')).backgroundColor"))[:3]]
    return sum(c) / 3


def marks_painted(page):
    return page.evaluate("""() => [...document.querySelectorAll('.turn:last-child .prose mark.hl')].every(m => getComputedStyle(m).backgroundSize === '100% 100%')""")


def no_hscroll(page):
    return page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 && document.body.scrollWidth <= document.body.clientWidth + 1")


# ---------------------------------------------------------------- scenarios
def basics(page, label, phone):
    check(f"[{label}] title and brand", "ceylon buildex" in page.title().lower() and "ceylon buildex" in page.inner_text(".brand").lower(), page.title())
    check(f"[{label}] opens in the dark theme by default", lum(page) < 30 and page.evaluate("document.documentElement.dataset.theme") == "dark", str(lum(page)))
    check(f"[{label}] no horizontal page scroll", no_hscroll(page))
    hero = page.evaluate("""() => { const h = document.querySelector('#hero'), c = document.querySelector('.cbox').getBoundingClientRect(), v = document.querySelector('#view-ask').getBoundingClientRect();
      return {h1: h.querySelector('h1').textContent, sug: [...h.querySelectorAll('.sug')].filter(s => s.offsetParent).length, below: c.top > h.getBoundingClientRect().bottom - 1,
              mid: Math.abs((h.getBoundingClientRect().top + c.bottom) / 2 - (v.top + v.bottom) / 2) < v.height * 0.2}; }""")
    check(f"[{label}] the empty page greets you, offers example questions and holds the question box in the middle", hero["h1"].startswith("What rule") and hero["sug"] == (2 if phone else 4) and hero["below"] and hero["mid"], str(hero))
    check(f"[{label}] the send button waits for words", page.locator("#askBtn[disabled]").count() == 1)
    page.fill("#q", "abc")
    check(f"[{label}] ...and wakes up when you type", page.locator("#askBtn:not([disabled])").count() == 1)
    page.fill("#q", "")
    page.wait_for_function("document.querySelector('#sbDataTxt').textContent.includes('documents')", timeout=5000)
    sb = page.inner_text("#statusbar")
    check(f"[{label}] the status bar names the dataset" + ("" if phone else ", OCR, the answer writer and the last update"), "16 documents" in sb and ("Quoting passages" in sb or phone) and (phone or ("OCR" in sb and "updated" in sb.lower())), sb.replace("\n", " | "))
    r = page.evaluate("(() => { const s = document.querySelector('#statusbar').getBoundingClientRect(); return [Math.round(s.bottom), innerHeight, Math.round(s.height)]; })()")
    check(f"[{label}] the status bar sits at the bottom edge", abs(r[0] - r[1]) <= 1 and 28 <= r[2] <= 36, str(r))
    check(f"[{label}] the Settings item carries a dot while no model writes the answers", page.locator("#setDot:not(.off)").count() == 1)
    page.screenshot(path=str(SHOTS / f"{label}-1-start.png"))


def layout_desktop(page, label):
    g = page.evaluate("""() => { const s = document.querySelector('.sidebar').getBoundingClientRect(), f = document.querySelector('.frame'), fr = f.getBoundingClientRect(), cs = getComputedStyle(f);
      return {side: Math.round(s.width), frameLeft: Math.round(fr.left), radius: cs.borderTopLeftRadius, current: document.querySelector('.nav [aria-current=page]').dataset.view,
              crumb: document.querySelector('#crumbText').textContent, menu: getComputedStyle(document.querySelector('#menuBtn')).display}; }""")
    check(f"[{label}] sidebar 256 px, framed workspace with rounded corners beside it, no menu button", g["side"] == 256 and g["frameLeft"] >= 256 and g["radius"] == "16px" and g["menu"] == "none", str(g))
    check(f"[{label}] the sidebar marks the page you are on and the top bar names it", g["current"] == "ask" and g["crumb"] == "Ask", str(g))
    page.click("#sideToggle"); page.wait_for_timeout(500)
    c = page.evaluate("[Math.round(document.querySelector('.sidebar').getBoundingClientRect().width), [...document.querySelectorAll('.nav .lbl')].every(l => l.offsetParent === null), document.querySelector('#sideToggle').getAttribute('aria-label')]")
    check(f"[{label}] the sidebar collapses to icons", c[0] == 64 and c[1] and c[2] == "Expand the sidebar", str(c))
    page.screenshot(path=str(SHOTS / f"{label}-1b-collapsed.png"))
    page.reload(wait_until="domcontentloaded"); page.wait_for_function("document.documentElement.dataset.ready === '1'", timeout=15000)
    check(f"[{label}] ...and stays collapsed after a reload", page.evaluate("document.documentElement.classList.contains('side-min')"))
    page.click("#sideToggle"); page.wait_for_timeout(450)
    check(f"[{label}] ...and expands again", page.evaluate("Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)") == 256)


def ask_compose(page, label, phone):
    page.evaluate(STEPS_JS)
    q = "How much bid security do the procurement guidelines require?"
    ask(page, q)
    turn = ".turn:last-child"
    check(f"[{label}] your question shows as a bubble on the right, the box is cleared for the next one",
          page.inner_text(f"{turn} .ubub") == q and page.input_value("#q") == "" and page.get_attribute("#view-ask", "data-state") == "active" and not page.locator("#hero").is_visible(),
          page.inner_text(f"{turn} .ubub"))
    steps, ts = page.evaluate("[window.__steps, window.__stepT]")
    check(f"[{label}] the assistant thinks out loud: read, search, found, compose, in that order", len(steps) == 4 and steps[0] == "Reading your question" and steps[1] == "Searching the library"
          and re.match(r"^Found \d+ passages?$", steps[2]) is not None and steps[3] == "Composing the answer", " | ".join(steps))
    check(f"[{label}] every step shown is one the server really reported", all(any(re.match(p, s) for p in STEP_VOCAB) for s in steps), " | ".join(steps))
    gaps = [round(b - a) for a, b in zip(ts, ts[1:])]
    check(f"[{label}] each thinking step stays on screen for a beat (smooth, not a flash)", all(g >= 400 for g in gaps), str(gaps))
    th = page.evaluate(f"""() => {{ const t = document.querySelector('{turn} .think'); return {{state: t.dataset.state, shut: t.classList.contains('shut'), head: t.querySelector('.think-t').textContent, time: t.querySelector('.think-time').textContent,
      live: document.querySelector('{turn} .reply > .orb').classList.contains('live'), wait: t.querySelectorAll('.step.wait').length, active: t.querySelectorAll('.step.active').length,
      chips: [...t.querySelectorAll('.schip')].map(c => c.textContent), cited: [...new Set([...document.querySelectorAll('{turn} .src .t > span:last-child')].map(s => s.textContent))]}}; }}""")
    check(f"[{label}] when the answer lands the thinking folds into 'Thought for <real time>', and everything stops moving",
          th["state"] == "done" and th["shut"] and th["head"] == "Thought for" and re.match(r"^\d+(\.\d)? (ms|s)$", th["time"]) and not th["live"] and th["wait"] == 0 and th["active"] == 0, str(th))
    check(f"[{label}] the 'found' step names the documents the answer then cites", th["chips"] and th["chips"] == th["cited"][:6], str(th["chips"]) + " vs " + str(th["cited"]))
    page.click(f"{turn} .think-h"); page.wait_for_timeout(500)
    check(f"[{label}] the folded thinking opens again on click", page.evaluate(f"!document.querySelector('{turn} .think').classList.contains('shut') && document.querySelectorAll('{turn} .steps .step').length === 4"))
    page.click(f"{turn} .think-h")
    check(f"[{label}] the answer is cited and has its sources below it", page.locator(f"{turn} .prose").count() == 1 and page.locator(f"{turn} .cite").count() > 0
          and page.locator(f"{turn} .src").count() == int(page.inner_text(f"{turn} .srcs h3 span")), page.inner_text(f"{turn} .prose")[:80].replace("\n", " "))
    info = page.inner_text(f"{turn} .ameta .info")
    check(f"[{label}] the answer says how it was made", "Compiled from the passages" in info and "sources" in info, info.replace("\n", " "))
    marks = page.eval_on_selector_all(f"{turn} .prose mark.hl", "els => els.map(e => e.textContent.trim())")
    prose = " ".join(page.inner_text(f"{turn} .prose").split())
    check(f"[{label}] key facts are highlighted with words that really are in the answer", len(marks) >= 1 and all(" ".join(m.split()) in prose for m in marks) and "==" not in prose and page.locator(f"{turn} .prose mark .cite").count() == 0, str(marks))
    page.wait_for_function("() => [...document.querySelectorAll('.turn:last-child .prose mark.hl')].every(m => getComputedStyle(m).backgroundSize === '100% 100%')", timeout=6000)
    check(f"[{label}] the highlighter finishes its stroke", marks_painted(page))
    page.screenshot(path=str(SHOTS / f"{label}-2-answer.png"))
    page.click(f"{turn} [data-copy]"); page.wait_for_selector("#toast.on", timeout=3000)
    clip = page.evaluate("navigator.clipboard.readText()")
    check(f"[{label}] Copy gives plain text with the sources, no markers", page.inner_text("#toast") == "Copied" and clip.startswith(q) and "==" not in clip and "**" not in clip and "[1]" in clip, clip[:80].replace("\n", " "))
    page.locator(f"{turn} .cite").first.click()
    check(f"[{label}] a citation lights up its source card and shows its excerpt", page.locator(f"{turn} .src.flash").count() == 1 and page.locator(f"{turn} .src .snip:not([hidden])").count() >= 1)
    page.locator(f"{turn} .src .main").first.click()
    page.wait_for_selector("#reader[open] .chunk", timeout=8000)
    check(f"[{label}] a source opens the reader at its passages", page.locator("#reader .chunk").count() > 0)
    page.fill("#rdQ", "security"); page.wait_for_timeout(500)
    check(f"[{label}] reader search highlights words", page.locator("#reader mark").count() > 0 or "No passages match" in page.inner_text("#rdBody"))
    page.keyboard.press("Escape")
    if page.locator("#reader[open]").count():
        page.keyboard.press("Escape")
    check(f"[{label}] Escape closes the reader", page.locator("#reader[open]").count() == 0)
    # the recent list
    if phone:
        page.click("#menuBtn"); page.wait_for_selector(".sidebar.open")
    check(f"[{label}] the question is listed under Recent", page.locator("#recentList button").first.inner_text().strip() == q)
    page.locator("#recentList button").first.click()
    answer_ready(page)
    check(f"[{label}] a recent question can be asked again in one click", page.locator(".turn").count() == 2 and page.inner_text(".turn:last-child .ubub") == q)
    # edit
    page.click(".turn:last-child [data-edit]")
    check(f"[{label}] 'Edit the question' puts it back in the box", page.input_value("#q") == q)
    # a new conversation
    page.click("#topNew" if not phone else "#topNew")
    check(f"[{label}] New question clears the conversation and brings back the start page", page.locator(".turn").count() == 0 and page.get_attribute("#view-ask", "data-state") == "idle" and page.locator("#hero").is_visible())


def ask_far(page, label):
    page.evaluate(STEPS_JS)
    ask(page, "What is the maximum FAR for a 20 perch plot on a 40 ft road in the Colombo Municipal Council area, Mixed Development zone?")
    n = page.inner_text(".turn:last-child .faro .n").strip()
    check(f"[{label}] a FAR question runs the rules engine (20 perch / 40 ft / MD -> 5.0)", n == "5.0", n)
    steps = page.evaluate("window.__steps")
    check(f"[{label}] ...and the thinking shows the calculation as its own step", steps[:2] == ["Reading your question", "Calculating the floor area ratio"], " | ".join(steps))
    first = page.eval_on_selector_all(".turn:last-child .prose mark.hl", "els => els.map(e => e.textContent.trim())")
    check(f"[{label}] the FAR answer highlights the ratio and its conditions", any("FAR" in m for m in first) and len(first) >= 2, str(first))
    page.click(".turn:last-child [data-far-open]")
    page.wait_for_function("document.querySelector('#farOut .num') && document.querySelector('#farOut .num').textContent.trim() === '5.0'", timeout=8000)
    check(f"[{label}] 'Open in calculator' fills the calculator with the same inputs", page.input_value("#land") == "20")
    nav(page, "ask", label == "phone")
    page.click("#topNew")


def passages_mode(page, label):
    check(f"[{label}] 'Hide superseded' shows only in Passages mode", page.locator("#curWrap:visible").count() == 0)
    page.click('.composer label:has(input[value="passages"])')
    check(f"[{label}] choosing Passages in the question box reveals 'Hide superseded'", page.locator("#curWrap:visible").count() == 1)
    page.evaluate(STEPS_JS)
    ask(page, "building line")
    check(f"[{label}] passages mode lists matching passages with the words highlighted", page.locator(".turn:last-child .hit").count() > 0 and page.locator(".turn:last-child .hit mark").count() > 0,
          str(page.locator(".turn:last-child .hit").count()))
    steps = page.evaluate("window.__steps")
    check(f"[{label}] ...after thinking 'Searching the passages' then 'Found ...'", steps[0] == "Searching the passages" and steps[1].startswith("Found"), " | ".join(steps))
    page.reload(wait_until="domcontentloaded"); page.wait_for_function("document.documentElement.dataset.ready === '1'", timeout=15000)
    check(f"[{label}] the choice is remembered after a reload", page.locator('.composer input[name="mode"][value="passages"]:checked').count() == 1)
    page.click('.composer label:has(input[value="answer"])')


def empty_and_error(page, label):
    ask(page, "xyzzy plugh quux frobnicate")
    t = page.inner_text(".turn:last-child .abody").lower()
    check(f"[{label}] an unknown topic gives a helpful empty state", "nothing on record" in t and page.locator(".turn:last-child .empty [data-edit]").count() == 1, t[:80].replace("\n", " "))
    check(f"[{label}] ...after thinking 'No matching passages'", "No matching passages" in page.evaluate("[...document.querySelectorAll('.turn:last-child .steps .st')].map(e => e.textContent)"))
    page.locator(".turn:last-child .empty [data-edit]").click()
    check(f"[{label}] 'Edit question' puts the query back in the box", page.input_value("#q") == "xyzzy plugh quux frobnicate")
    page.route("**/api/ask/stream", lambda r: r.abort("failed"))
    page.fill("#q", "How much bid security do the procurement guidelines require?"); page.press("#q", "Enter")
    page.wait_for_selector(".turn:last-child .errbox", timeout=8000)
    txt = page.inner_text(".turn:last-child .errbox")
    check(f"[{label}] a failed request shows an error with Retry", "Retry" in txt and "Can't reach the server" in txt and page.inner_text(".turn:last-child .think-t") == "Something went wrong", txt[:90].replace("\n", " "))
    check(f"[{label}] the box is usable again after a failure", page.get_attribute("#view-ask", "data-busy") == "false")
    page.screenshot(path=str(SHOTS / f"{label}-3-error.png"))
    page.unroute("**/api/ask/stream")
    page.locator(".turn:last-child .errbox [data-retry]").click()
    answer_ready(page)
    check(f"[{label}] Retry recovers", page.locator(".turn:last-child .prose").count() == 1)
    page.select_option("#cat", "gazette")
    ask(page, "xyzzy plugh quux frobnicate")
    check(f"[{label}] the empty state under a filter offers 'Search all sources'", page.locator('.turn:last-child [data-switch="all"]').count() == 1)
    page.locator('.turn:last-child [data-switch="all"]').click(); answer_ready(page)
    check(f"[{label}] ...which widens the search", page.input_value("#cat") == "all")
    page.click("#topNew")


def stream_sync(br, label):
    """Feed /api/ask/stream event by event; the thinking panel must show exactly what has happened, in order, and nothing more."""
    gp = GatedProxy(BASE_URL)
    ctx, page, errors = new_page(br, gp.base, {"width": 1280, "height": 860})
    try:
        page.fill("#q", "What is the maximum FAR for a 20 perch plot on a 40 ft road?"); page.press("#q", "Enter")
        page.wait_for_selector(".turn .think")
        check(f"[{label}] before the server says anything: 'Thinking', a working row, no step", steps_now(page) == [] and page.locator(".turn .step.wait").count() == 1
              and page.inner_text(".turn .think-t") == "Thinking" and page.locator(".turn .reply > .orb.live").count() == 1)
        check(f"[{label}] the send button turns into Stop while busy", page.get_attribute("#askBtn", "aria-label") == "Stop" and page.get_attribute("#sendUse", "href") == "#i-stop")
        for _ in range(4):
            page.press("#q", "Enter")
        page.wait_for_timeout(300)
        check(f"[{label}] repeated Enter does not send a second request", gp.requests == 1, f"{gp.requests} request(s)")
        gp.send({"stage": "parse"}); wait_steps(page, 1)
        check(f"[{label}] 'parse' -> Reading your question (the one active step)", steps_now(page) == ["Reading your question"] and page.locator(".turn .step.active").count() == 1)
        gp.send({"stage": "far"}); wait_steps(page, 2)
        gp.send({"stage": "search", "passages": 340, "documents": 16}); wait_steps(page, 3)
        d = page.inner_text(".turn .step:nth-child(3) .sd")
        check(f"[{label}] 'search' -> Searching the library, 340 passages in 16 documents (earlier steps done)", steps_now(page)[1:] == ["Calculating the floor area ratio", "Searching the library"] and d == "340 passages in 16 documents"
              and page.locator(".turn .step.done").count() == 2, d)
        gp.send({"stage": "found", "passages": 7, "documents": 3, "far": True, "titles": ["Doc A", "Doc B", "Doc C"]}); wait_steps(page, 4)
        chips = page.eval_on_selector_all(".turn .step:nth-child(4) .schip", "els => els.map(e => e.textContent)")
        check(f"[{label}] 'found' -> Found 7 passages, in 3 documents, naming them", steps_now(page)[3] == "Found 7 passages" and chips == ["Doc A", "Doc B", "Doc C"], str(chips))
        page.screenshot(path=str(SHOTS / f"{label}-11-thinking-found.png"))
        gp.send({"stage": "write", "mode": "llm", "model": "gated-model"}); wait_steps(page, 5)
        check(f"[{label}] 'write' -> Writing the answer with gated-model", steps_now(page)[4] == "Writing the answer" and "gated-model" in page.inner_text(".turn .step:nth-child(5) .sd"))
        page.wait_for_timeout(5600)
        sd = page.inner_text(".turn .step:nth-child(5) .sd")
        check(f"[{label}] a long model wait shows a real elapsed counter", re.search(r"gated-model · [4-7] s$", sd) is not None, sd)
        check(f"[{label}] nothing is shown as finished before 'done'", page.locator(".turn .prose").count() == 0 and page.inner_text(".turn .think-t") == "Thinking" and page.locator(".turn .step.wait").count() == 1)
        page.screenshot(path=str(SHOTS / f"{label}-12-thinking-writing.png"))
        cite = {"n": 1, "chunk_id": "c1", "doc_id": "d1", "title": "Gated test document", "page": 3, "heading": "", "url": None, "status": "current", "origin": "full-text", "gazette_no": None, "category": "gazette", "score": 1.0, "text": "A passage."}
        t0 = time.time()
        gp.send({"stage": "done", "result": {"answer": "Gated answer [S1].", "mode": "llm", "model": "gated-model", "citations": [cite], "far": None, "far_inputs": None, "far_note": None, "took_ms": 7300}})
        page.wait_for_selector(".turn .prose", timeout=4000)
        ms = (time.time() - t0) * 1000
        th = page.evaluate("[document.querySelector('.turn .think-t').textContent, document.querySelector('.turn .think-time').textContent, document.querySelectorAll('.turn .step.wait, .turn .step.active').length, document.querySelector('#view-ask').dataset.busy]")
        check(f"[{label}] when 'done' arrives the thinking settles and the answer shows within a beat", ms < 1500 and th[0] == "Thought for" and re.match(r"^\d+(\.\d)? s$", th[1]) and th[2] == 0 and th[3] == "false", f"{ms:.0f} ms {th}")
        check(f"[{label}] a model-written answer says who wrote it", "Written by gated-model" in page.inner_text(".turn .ameta .info"))
        gp.end()
        # server-reported error
        page.fill("#q", "second question"); page.press("#q", "Enter"); page.wait_for_selector(".turn:last-child .think")
        gp.send({"stage": "parse"}); gp.send({"stage": "error", "message": "RuntimeError: boom"}); gp.end()
        page.wait_for_selector(".turn:last-child .errbox", timeout=5000)
        check(f"[{label}] a server error event -> error state with the message and Retry; the thinking says so", "boom" in page.inner_text(".turn:last-child .errbox") and page.locator(".turn:last-child [data-retry]").count() >= 1
              and page.inner_text(".turn:last-child .think-t") == "Something went wrong" and page.locator(".turn:last-child .step.bad").count() == 1)
        # connection dropped before 'done'
        page.locator(".turn:last-child .errbox [data-retry]").click(); page.wait_for_selector(".turn:last-child .think[data-state=running]")
        gp.send({"stage": "parse"}); gp.end()
        page.wait_for_selector(".turn:last-child .errbox", timeout=5000)
        check(f"[{label}] a stream ending without 'done' is reported, not shown as success", "closed before" in page.inner_text(".turn:last-child .errbox"))
        # Stop
        page.locator(".turn:last-child .errbox [data-retry]").click(); page.wait_for_selector(".turn:last-child .think[data-state=running]")
        gp.send({"stage": "parse"}); wait_steps(page, 1)
        page.click("#askBtn")
        page.wait_for_selector(".turn:last-child .abody .empty", timeout=5000)
        check(f"[{label}] Stop cancels the request and says so", "stopped" in page.inner_text(".turn:last-child .abody").lower() and page.inner_text(".turn:last-child .think-t") == "Stopped" and page.get_attribute("#view-ask", "data-busy") == "false")
        gp.end()
        # no language model: composed answer
        page.locator(".turn:last-child [data-retry]").first.click(); page.wait_for_selector(".turn:last-child .think[data-state=running]")
        gp.send({"stage": "parse"}); gp.send({"stage": "search", "passages": 56, "documents": 16}); gp.send({"stage": "found", "passages": 2, "documents": 1, "far": False, "titles": ["Doc A"]})
        gp.send({"stage": "write", "mode": "compose", "model": None}); wait_steps(page, 4)
        check(f"[{label}] without a model the step says 'Composing the answer', not 'Writing'", steps_now(page)[3] == "Composing the answer")
        gp.send({"stage": "done", "result": {"answer": "Composed.", "mode": "extractive", "model": None, "citations": [], "far": None, "far_note": None, "took_ms": 9}}); gp.end()
        page.wait_for_selector(".turn:last-child .prose", timeout=5000)
        check(f"[{label}] a composed answer is labelled as compiled from the passages", "Compiled from the passages" in page.inner_text(".turn:last-child .ameta .info"))
        # empty
        page.fill("#q", "third question"); page.press("#q", "Enter"); page.wait_for_selector(".turn:last-child .think[data-state=running]")
        gp.send({"stage": "parse"}); gp.send({"stage": "search", "passages": 56, "documents": 16}); gp.send({"stage": "found", "passages": 0, "documents": 0, "far": False, "titles": []})
        wait_steps(page, 3)
        gp.send({"stage": "done", "result": {"answer": "none", "mode": "none", "model": None, "citations": [], "far": None, "far_note": None, "took_ms": 5}}); gp.end()
        page.wait_for_selector(".turn:last-child .empty", timeout=5000)
        check(f"[{label}] 'found 0' is shown as 'No matching passages', then the empty state", steps_now(page)[2] == "No matching passages")
        check(f"[{label}] the button is Ask again when idle", page.get_attribute("#askBtn", "aria-label") == "Ask")
        check(f"[{label}] no JavaScript errors during the stream tests", not errors, "; ".join(errors[:3]))
    finally:
        gp.close(); ctx.close()


def far_view(page, label, phone):
    nav(page, "far", phone)
    page.wait_for_function("document.querySelector('#zone').options.length > 5", timeout=8000)
    check(f"[{label}] the calculator waits with a clear prompt", "Enter the land extent" in page.inner_text("#farOut"))
    page.click('#farExamples [data-ex="0"]')
    page.wait_for_function("document.querySelector('#farOut .num') && document.querySelector('#farOut .num').textContent.trim() === '5.0'", timeout=8000)
    check(f"[{label}] calculator: CMC 20 perch / 40 ft -> FAR 5.0 with floor area and the caveat", "m²" in page.inner_text("#farOut") and "Confirm with" in page.inner_text("#farOut"))
    page.locator("#farOut details summary", has_text="Printed table row").click()
    check(f"[{label}] the printed table row is there and highlighted", page.locator("#farOut table.t td.hl, #farOut table.t tr.hlr").count() > 0)
    check(f"[{label}] opening the wide table does not widen the page", no_hscroll(page))
    page.screenshot(path=str(SHOTS / f"{label}-4-far.png"))
    page.click('label:has(input[value="uda2021"])')
    page.fill("#zf", "1.1"); page.fill("#land", "600"); page.select_option("#landU", "m2"); page.fill("#road", "12"); page.select_option("#roadU", "m")
    page.wait_for_function("document.querySelector('#farOut .num') && document.querySelector('#farOut .num').textContent.trim() === '2.7'", timeout=8000)
    check(f"[{label}] it recalculates by itself: UDA zone factor 1.1 / 600 m2 / 12 m -> 2.7", True)
    page.fill("#land", "")
    page.wait_for_function("document.querySelector('#farOut').textContent.includes('Enter the land extent')", timeout=5000)
    check(f"[{label}] clearing an input returns to the prompt (no stale number)", page.locator("#farOut.pending").count() == 1)
    page.fill("#land", "600")
    page.wait_for_function("document.querySelector('#farOut .num') && document.querySelector('#farOut .num').textContent.trim() === '2.7'", timeout=8000)
    if phone:
        page.evaluate("(() => { const v = document.querySelector('#view-far'); v.scrollTo(0, v.scrollTop + document.querySelector('#farOut').getBoundingClientRect().top - innerHeight - 20); })()"); page.wait_for_timeout(700)
        check(f"[{label}] a phone shows a floating result bar while editing", page.locator("#farMini.on").count() == 1 and "2.7" in page.inner_text("#farMini"), page.inner_text("#farMini"))
        page.evaluate("document.querySelector('#view-far').scrollTo(0, 0)")
    page.click("#farOut [data-act='ask']")
    check(f"[{label}] 'Ask about this' moves the result into the question box", page.input_value("#q").startswith("Explain this FAR result"))
    page.fill("#q", "")


def library_view(page, label, phone=False):
    nav(page, "library", phone)
    page.wait_for_selector("#libMatrix .mxn", timeout=8000)
    page.wait_for_timeout(1200)
    g = page.evaluate("""async () => {
      const docs = (await (await fetch('/api/docs')).json()).documents, yr = d => (/^(\\d{4})/.exec(d.doc_date || '') || [0, ''])[1];
      const cols = [...document.querySelectorAll('.mx-h b')].map(b => b.textContent), rows = [...document.querySelectorAll('.mx-rh b')].map(b => b.textContent);
      const CAT = {'building-regulations': 'Building regulations', 'development-plans': 'Development plans', 'procurement-sbd': 'Bidding documents (SBD)', 'procurement-policy': 'Procurement guidelines', 'legislation': 'Legislation'};
      let wrong = [], outside = 0;
      for (const n of document.querySelectorAll('.mxn')) { const d = docs.find(x => x.id === n.dataset.id), col = cols[+n.dataset.col], row = rows[+n.dataset.row];
        if (!d || (yr(d) || 'Undated') !== col || (CAT[d.category] || d.category) !== row) wrong.push(n.dataset.id);
        const c = n.closest('.mx-c').getBoundingClientRect(), r = n.getBoundingClientRect(); if (r.left < c.left - .5 || r.right > c.right + .5) outside++; }
      const years = [...new Set(docs.map(yr).filter(Boolean))].sort();
      return {n: document.querySelectorAll('.mxn').length, docs: docs.length, cols, wrongCols: JSON.stringify(cols) !== JSON.stringify([...years, ...(docs.some(d => !yr(d)) ? ['Undated'] : [])]), wrong, outside,
              rows: rows.length, kinds: new Set(docs.map(d => d.category)).size}; }""")
    check(f"[{label}] the library is a matrix: one row per kind, one column per year (+ Undated), one chip per document", g["n"] == g["docs"] and g["rows"] == g["kinds"] and not g["wrongCols"], str({k: g[k] for k in ("n", "docs", "rows", "kinds", "cols")}))
    check(f"[{label}] every document sits in the cell of its own kind and year, inside the cell", not g["wrong"] and g["outside"] == 0, str(g["wrong"]) + f" outside={g['outside']}")
    st = page.inner_text("#libStats")
    check(f"[{label}] the numbers above the matrix are the dataset's", "16" in st and "46" in st and "Full text" in st, st.replace("\n", " | "))
    if not phone:
        vis = page.evaluate("(() => { const w = document.querySelector('#libMatrix'); return [w.scrollWidth <= w.clientWidth + 1, [...document.querySelectorAll('.mxn .lb')].filter(l => l.scrollWidth > l.clientWidth + 1).length]; })()")
        check(f"[{label}] every column fits without sideways scrolling and no chip label is cut off", vis[0] and vis[1] == 0, str(vis))
        page.screenshot(path=str(SHOTS / f"{label}-6-library.png"))
        el = page.locator('.mxn[data-id="uda-pdr-2021-en"]'); b = el.bounding_box()
        page.mouse.move(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2); page.wait_for_timeout(700)
        hot = page.evaluate("""() => ({hot: document.querySelector('.mx').classList.contains('hot'), on: [...document.querySelectorAll('.mxn.on')].map(n => n.dataset.id), lines: document.querySelectorAll('.mx-links .ln').length,
          gaz: document.querySelectorAll('.mx-links .ln.gaz').length, card: document.querySelector('#mxCard').dataset.state, title: (document.querySelector('#mxCard h3') || {}).textContent || '',
          cross: [...document.querySelectorAll('.mx-h.x, .mx-rh.x')].map(e => e.querySelector('b').textContent)})""")
        check(f"[{label}] pointing at a document lights its real relations, draws a line to each, and fills the inspector", hot["hot"] and "kotte-pnbr-schedules-2021" in hot["on"] and hot["lines"] == len(hot["on"]) and hot["gaz"] >= 1
              and hot["card"] == "doc" and "2235/54" in hot["title"], str(hot))
        check(f"[{label}] ...and marks its row and column", sorted(hot["cross"]) == ["2021", "Building regulations"], str(hot["cross"]))
        page.screenshot(path=str(SHOTS / f"{label}-6b-library-hover.png"))
        cb = page.locator("#mxCard").bounding_box()
        page.mouse.move(cb["x"] + cb["width"] / 2, cb["y"] + 30, steps=4); page.wait_for_timeout(500)
        check(f"[{label}] the inspector stays while the pointer moves onto it", page.get_attribute("#mxCard", "data-state") == "doc")
        page.mouse.move(5, 5); page.wait_for_timeout(600)
        check(f"[{label}] ...and goes when the pointer leaves", page.get_attribute("#mxCard", "data-state") == "blank" and not page.evaluate("document.querySelector('.mx').classList.contains('hot')"))
        el.click(); page.mouse.move(5, 5); page.wait_for_timeout(500)
        check(f"[{label}] a click keeps a document in the inspector", page.get_attribute("#mxCard", "data-pinned") == "true" and page.locator(".mxn.sel").count() == 1)
        page.click("#mxCard [data-mx-go]")
        check(f"[{label}] a related document in the inspector can be followed", page.evaluate("document.activeElement.classList.contains('mxn') && document.activeElement.dataset.id !== 'uda-pdr-2021-en'"))
        page.click("#mxCard [data-mx-close]")
        check(f"[{label}] the kept document can be let go", page.locator(".mxn.sel").count() == 0)
    page.click('#libChips [data-lc="procurement-sbd"]'); page.wait_for_timeout(400)
    on = page.locator("#libMatrix .mxn:not(.off)").count()
    check(f"[{label}] a category filter dims the other documents and empty rows", 0 < on < g["n"] and page.locator(".mx-rh.off").count() >= 1, f"{on}/{g['n']}")
    page.click('#libChips [data-lc="all"]'); page.fill("#libQ", "2235"); page.wait_for_timeout(400)
    on = page.locator("#libMatrix .mxn:not(.off)").count()
    check(f"[{label}] a text filter (gazette number) dims what does not match", 0 < on < 6 and "match" in page.inner_text("#libCount"), str(on))
    page.fill("#libQ", "zzzzzz"); page.wait_for_selector("#libEmpty:not([hidden])", timeout=5000)
    check(f"[{label}] an empty filter offers 'Clear filter'", page.locator("[data-lib-clear]").count() == 1)
    page.click("[data-lib-clear]"); page.wait_for_timeout(300)
    page.locator("#libMatrix .mxn[tabindex='0']").focus(); first = page.evaluate("document.activeElement.dataset.id")
    page.keyboard.press("ArrowRight"); page.keyboard.press("ArrowDown")
    moved = page.evaluate("document.activeElement.classList.contains('mxn') && document.activeElement.dataset.id")
    check(f"[{label}] arrow keys move between documents", moved not in (False, first), str(moved))
    page.keyboard.press("Enter")
    page.wait_for_selector("#reader[open] .chunk", timeout=8000)
    check(f"[{label}] Enter opens the document in the reader", page.locator("#reader .chunk").count() > 0)
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    page.evaluate("document.activeElement && document.activeElement.blur()")
    if not phone:
        page.locator('.mxn[data-id="ccdp-2008-colombo"]').dblclick()
        page.wait_for_selector("#reader[open] .chunk", timeout=8000)
        check(f"[{label}] a double click opens a document", "Colombo" in page.inner_text("#rdTitle"))
        page.keyboard.press("Escape")
    page.click("label:has(input[name=libmode][value=list])"); page.wait_for_selector("#libList .row-doc", timeout=8000)
    n = page.locator("#libList .row-doc").count()
    check(f"[{label}] the list view shows every document", n == g["n"], f"{n}/{g['n']}")
    page.click('#libChips [data-lc="procurement-sbd"]')
    page.wait_for_function("() => { const n = document.querySelectorAll('#libList .row-doc').length; return n > 0 && n < 8; }", timeout=8000)
    check(f"[{label}] the list filter works", True)
    page.click('#libChips [data-lc="all"]')
    page.locator("#libList .row-doc").first.click()
    page.wait_for_selector("#reader[open] .chunk", timeout=8000)
    check(f"[{label}] a list row opens the reader", page.locator("#reader .chunk").count() > 0)
    page.keyboard.press("Escape")
    page.click("label:has(input[name=libmode][value=matrix])")


def ocr_view(page, label, phone):
    nav(page, "ocr", phone)
    tmp = Path(tempfile.mkdtemp()); pdf = make_scanned_pdf(tmp / "scan.pdf")
    page.set_input_files("#file", str(pdf))
    page.wait_for_function("() => !document.querySelector('#ocrOut').hidden", timeout=60000)
    txt = page.input_value("#ocrText").lower()
    check(f"[{label}] Scan reads a scanned PDF", "floor area ratio" in txt and "12.2" in txt and "5.0" in txt, txt[:90].replace("\n", " "))
    check(f"[{label}] Scan shows finished progress and stats", "Done" in page.inner_text("#ocrMsg") and "page" in page.inner_text("#ocrStats"), page.inner_text("#ocrStats")[:80])
    page.screenshot(path=str(SHOTS / f"{label}-7-scan.png"))


def update_view(page, label, phone):
    nav(page, "update", phone)
    page.wait_for_selector("#srcList li", timeout=8000)
    n = page.locator("#srcList li").count()
    check(f"[{label}] Update lists the registered sources", n >= 20, str(n))
    if not phone:
        r = page.evaluate("(() => { const row = document.querySelector('#srcList .row-doc'), t = row.querySelector('.t').getBoundingClientRect(), s = row.querySelector('.side').getBoundingClientRect(); return [s.left >= t.right - 1, getComputedStyle(row.querySelector('.side')).position]; })()")
        check(f"[{label}] each source's tags sit to the right of its title", r[0] and r[1] == "static", str(r))
    check(f"[{label}] the Update button is idle with no progress bar when nothing runs", page.locator("#updBtn:not([disabled])").count() == 1 and page.locator("#updProg:visible").count() == 0)
    page.screenshot(path=str(SHOTS / f"{label}-8-update.png"))


def shell_checks(page, label, phone):
    """The page is a fixed frame: the browser never scrolls; each page scrolls inside its own pane."""
    for view in ("ask", "far", "library", "ocr", "update"):
        nav(page, view, phone)
        page.evaluate("window.scrollTo(0, 800)")
        st = page.evaluate("""(view) => { const de = document.documentElement, v = document.querySelector('#view-' + view).getBoundingClientRect(), top = document.querySelector('.top').getBoundingClientRect(), sb = document.querySelector('#statusbar').getBoundingClientRect();
          return {page: de.scrollHeight - innerHeight, y: scrollY, hx: de.scrollWidth - de.clientWidth, top: Math.round(top.top), below: Math.round(v.bottom - sb.top), sb: Math.round(sb.bottom - innerHeight),
                  h1: (document.querySelector('#view-' + view + ' h1') || {}).textContent || '', crumb: document.querySelector('#crumbText').textContent}; }""", view)
        check(f"[{label}] {view}: the browser never scrolls; the top bar, the pane and the status bar stay in place", st["page"] <= 1 and st["y"] == 0 and st["hx"] <= 1 and st["top"] <= 9 and st["below"] <= 1 and abs(st["sb"]) <= 1, str(st))
        check(f"[{label}] {view}: the top bar names the page", st["crumb"] in ("Ask", "Floor area ratio", "Library", "Scan", "Update"), st["crumb"])
    nav(page, "update", phone)
    sc = page.evaluate("""() => { const cols = [...document.querySelectorAll('#view-update .card, #view-update')].filter(e => e.scrollHeight > e.clientHeight + 20);
      const e = cols[0]; if (!e) return null; e.scrollTo(0, 400); return {moved: e.scrollTop > 0, pageY: scrollY}; }""")
    check(f"[{label}] Update: a long list scrolls inside its own pane", bool(sc) and sc["moved"] and sc["pageY"] == 0, str(sc))
    if not phone:
        for view in ("far", "ocr", "update"):
            nav(page, view)
            r = page.evaluate("""(view) => { const cols = [...document.querySelectorAll('#view-' + view + ' .split > .card, #view-' + view + ' .split > .farout')], a = cols[0].getBoundingClientRect(), b = cols[cols.length - 1].getBoundingClientRect();
              return {n: cols.length, dTop: Math.round(Math.abs(a.top - b.top)), dH: Math.round(Math.abs(a.height - b.height))}; }""", view)
            check(f"[{label}] {view}: two panels with the same top and height", r["n"] == 2 and r["dTop"] <= 1 and r["dH"] <= 1, str(r))
    nav(page, "ask", phone)


def themes(page, label):
    check(f"[{label}] the theme button in the status bar offers the light theme", page.get_attribute("#themeBtn", "aria-label") == "Switch to the light theme")
    page.click("#themeBtn"); page.wait_for_timeout(250)
    check(f"[{label}] ...switches to light at once", lum(page) > 225 and page.get_attribute("#themeBtn", "aria-label") == "Switch to the dark theme", str(lum(page)))
    page.screenshot(path=str(SHOTS / f"{label}-9-light.png"))
    page.reload(wait_until="domcontentloaded"); page.wait_for_function("document.documentElement.dataset.ready === '1'", timeout=15000)
    check(f"[{label}] ...and remembers it", lum(page) > 225)
    open_settings(page)
    check(f"[{label}] Settings shows the same choice", page.locator('#settings input[name="theme"][value="light"]:checked').count() == 1)
    page.click('#settings label:has(input[name="theme"][value="dark"])')
    check(f"[{label}] choosing Dark in Settings switches back", lum(page) < 30)
    close_settings(page)


def accent_checks(page, label):
    open_settings(page)
    check(f"[{label}] Settings offers accent colours (presets and a custom one)", page.locator("#accentSw input[name=accent]").count() >= 6 and page.locator("#accentCustom").count() == 1)
    css = lambda: page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--orange').trim()")  # noqa: E731
    before = css()
    page.click('#accentSw label[title="Cobalt"]'); page.wait_for_timeout(250)
    after = css()
    check(f"[{label}] Cobalt recolours the page straight away and is saved", after != before and page.evaluate("localStorage.getItem('ceylon-buildex-accent')") == "cobalt", f"{before} -> {after}")
    close_settings(page)
    page.reload(wait_until="domcontentloaded"); page.wait_for_function("document.documentElement.dataset.ready === '1'", timeout=15000)
    check(f"[{label}] the accent survives a reload", css() == after, css())
    cur = page.evaluate("(() => { const d = document.createElement('i'); d.style.color = getComputedStyle(document.documentElement).getPropertyValue('--orange'); document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; })()")
    check(f"[{label}] the current page in the sidebar uses the accent", page.evaluate("getComputedStyle(document.querySelector('.nav [aria-current=page] .i')).color") == cur)
    bad = page.evaluate("""() => {
      const lum = h => { const c = [1,3,5].map(i => { const v = parseInt(h.substr(i,2),16)/255; return v <= .03928 ? v/12.92 : Math.pow((v+.055)/1.055, 2.4); }); return .2126*c[0] + .7152*c[1] + .0722*c[2]; };
      const out = [], root = document.documentElement, keep = root.dataset.theme;
      for (const th of ['light', 'dark']) { root.dataset.theme = th;
        for (const k of Object.keys(CBAccent.presets)) { CBAccent.save(k); const a = getComputedStyle(root).getPropertyValue('--orange').trim(), b = getComputedStyle(root).getPropertyValue('--on-orange').trim();
          const r = (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05); if (r < 4.5) out.push(th + ':' + k + ' ' + r.toFixed(1)); } }
      root.dataset.theme = keep; return out; }""")
    check(f"[{label}] text on the accent is readable (4.5:1) for every preset, light and dark", not bad, str(bad))
    open_settings(page)
    page.evaluate("""() => { const i = document.querySelector('#accentCustom'); i.value = '#118833'; i.dispatchEvent(new Event('input', {bubbles: true})); }""")
    page.wait_for_timeout(200)
    check(f"[{label}] a custom colour can be picked and is saved", css().lower() == "#118833" and page.evaluate("localStorage.getItem('ceylon-buildex-accent')") == "#118833", css())
    page.click('#accentSw label[title="Vermilion"]'); page.wait_for_timeout(200)
    check(f"[{label}] Vermilion restores the default", css() in ("#f4481f", "#ff5a2d"), css())
    close_settings(page)


def settings_layout(page, label, phone):
    open_settings(page)
    names = page.eval_on_selector_all("#settings legend", "els => els.map(e => e.textContent.trim())")
    check(f"[{label}] Settings holds Appearance and Written answers (search choices live in the question box)", names == ["Appearance", "Written answers"], str(names))
    box = page.evaluate("(() => { const r = document.querySelector('#settings').getBoundingClientRect(); return [r.left, r.right, r.height, innerWidth, innerHeight]; })()")
    check(f"[{label}] Settings fits the screen" + (" as a bottom sheet" if phone else ""), box[0] >= -1 and box[1] <= box[3] + 1 and box[2] <= box[4] + 1, str([round(x) for x in box]))
    page.screenshot(path=str(SHOTS / f"{label}-10-settings.png"))
    page.keyboard.press("Escape")
    check(f"[{label}] Escape closes Settings", page.locator("#settings[open]").count() == 0)


def settings_flow(page, label):
    check(f"[{label}] the status bar says answers quote passages while no model is set", "Quoting passages" in page.inner_text("#sbModelTxt"))
    page.click("#sbModel"); page.wait_for_selector("#settings[open][data-ready]", timeout=5000)
    check(f"[{label}] the answer item in the status bar opens Settings", "off" in page.inner_text("#stSaved").lower())
    page.check('input[name="prov"][value="openai"]', force=True)
    page.fill("#stBase", mock.base); page.fill("#stModelO", "mock-model")
    page.click("#stSave"); page.wait_for_selector("#stMsg .notice.ok", timeout=15000)
    check(f"[{label}] settings: save and test succeeds", "Saved." in page.inner_text("#stMsg"), page.inner_text("#stMsg")[:80])
    page.click("#stClose")
    page.wait_for_function("document.querySelector('#setDot').classList.contains('off') && document.querySelector('#sbModelTxt').textContent === 'mock-model'", timeout=5000)
    check(f"[{label}] the dot clears and the status bar names the model", True)
    mock.delay = 1.2
    page.evaluate(STEPS_JS)
    ask(page, "How much bid security do the procurement guidelines require?")
    steps = page.evaluate("window.__steps")
    check(f"[{label}] the thinking says 'Writing the answer' with the real model", "Writing the answer" in steps and "mock-model" in page.inner_text(".turn:last-child .steps"), " | ".join(steps))
    check(f"[{label}] the answer is the model's and says so", "Mock written answer" in page.inner_text(".turn:last-child .prose") and "Written by mock-model" in page.inner_text(".turn:last-child .ameta .info"))
    marks = page.eval_on_selector_all(".turn:last-child .prose mark.hl", "els => els.map(e => e.textContent.trim())")
    check(f"[{label}] the model's own highlight markers become highlights", marks == ["set out in the cited passage"], str(marks))
    mock.delay = 0
    page.wait_for_timeout(1200)
    page.screenshot(path=str(SHOTS / f"{label}-10b-written.png"))
    open_settings(page)
    page.check('input[name="prov"][value="off"]', force=True); page.click("#stSave"); page.wait_for_selector("#stMsg .notice.ok", timeout=8000)
    page.click("#stClose")
    page.wait_for_function("!document.querySelector('#setDot').classList.contains('off')", timeout=5000)
    check(f"[{label}] switching answers off works", "Quoting passages" in page.inner_text("#sbModelTxt"))
    page.click("#topNew")


def a11y(page, label, phone):
    bad = page.evaluate("""() => [...document.querySelectorAll('button, a[href], summary, [role=button]')].filter(e => e.offsetParent !== null)
      .filter(e => !(e.textContent || '').trim() && !e.getAttribute('aria-label') && !e.getAttribute('title')).map(e => e.outerHTML.slice(0, 80))""")
    check(f"[{label}] every icon-only button has an accessible name", not bad, "; ".join(bad[:3]))
    check(f"[{label}] skip link, sidebar, main and status landmarks, one h1 per view", page.locator("a.skip").count() == 1 and page.locator("aside#side").count() == 1 and page.locator("main#main").count() == 1
          and page.locator("footer#statusbar").count() == 1 and page.locator(".view.on h1").count() == 1)
    if phone:
        small = page.evaluate("""() => [...document.querySelectorAll('.top .icon-btn, .send, .cbtn, .btn, .chip, select, .input')]
          .filter(e => e.offsetParent !== null).map(e => [e.id || e.className || e.tagName, e.getBoundingClientRect().height]).filter(x => x[1] < 30).map(x => x[0] + ':' + Math.round(x[1]))""")
        check(f"[{label}] touch targets are at least 30 px", not small, ", ".join(small[:5]))


def phone_shell(page, label):
    g = page.evaluate("""() => { const s = document.querySelector('.sidebar').getBoundingClientRect(); return {menu: getComputedStyle(document.querySelector('#menuBtn')).display, sideRight: Math.round(s.right), frame: Math.round(document.querySelector('.frame').getBoundingClientRect().width), vw: innerWidth}; }""")
    check(f"[{label}] the sidebar is a drawer, out of sight; a menu button opens it", g["menu"] != "none" and g["sideRight"] <= 1 and g["frame"] == g["vw"], str(g))
    page.click("#menuBtn"); page.wait_for_timeout(450)
    o = page.evaluate("[Math.round(document.querySelector('.sidebar').getBoundingClientRect().left), !document.querySelector('#scrim').hidden, document.querySelector('#menuBtn').getAttribute('aria-expanded')]")
    check(f"[{label}] the drawer slides in over a dimmed page", o[0] == 0 and o[1] and o[2] == "true", str(o))
    page.screenshot(path=str(SHOTS / f"{label}-0-drawer.png"))
    page.click("#scrim", position={"x": 370, "y": 300}); page.wait_for_timeout(450)
    check(f"[{label}] tapping outside closes it", page.evaluate("document.querySelector('#scrim').hidden && document.querySelector('.sidebar').getBoundingClientRect().right <= 1"))


def reduced_motion(br, base):
    ctx, page, errors = new_page(br, base, {"width": 1280, "height": 860}, reduced_motion="reduce")
    try:
        d = page.evaluate("getComputedStyle(document.querySelector('.btn, .newq')).transitionDuration")
        check("[reduced-motion] transitions are effectively off", d in ("0.001s", "1e-06s", "0s"), d)
        page.evaluate(STEPS_JS)
        t0 = time.time(); ask(page, "Parking required for a hotel with 60 rooms on a 9 m road"); took_s = time.time() - t0
        check("[reduced-motion] the thinking steps are still listed, without the pause between them", len(page.evaluate("window.__steps")) >= 3 and took_s < 2.5, f"{took_s:.1f} s")
        a = page.evaluate("getComputedStyle(document.querySelector('.turn .reveal')).animationDuration")
        check("[reduced-motion] reveal animations are effectively off, the answer still appears", a in ("0.001s", "1e-06s", "0s") and page.locator(".turn .prose").count() == 1, a)
        check("[reduced-motion] highlights are painted at once", page.locator(".turn:last-child .prose mark.hl").count() >= 1 and marks_painted(page))
        nav(page, "library"); page.wait_for_selector(".mxn", timeout=8000)
        m = page.evaluate("[document.querySelector('.mx').classList.contains('intro'), getComputedStyle(document.querySelector('.mxn')).animationName]")
        check("[reduced-motion] the matrix appears complete at once", m[0] is False and m[1] == "none", str(m))
        check("[reduced-motion] no JavaScript errors", not errors, "; ".join(errors[:3]))
    finally:
        ctx.close()


def wide_screen(br, base):
    ctx, page, errors = new_page(br, base, {"width": 2000, "height": 1000})
    try:
        c = page.evaluate("(() => { const b = document.querySelector('.cbox').getBoundingClientRect(), t = document.querySelector('.thread').getBoundingClientRect(); return [Math.round(b.width), Math.round((b.left + b.right) / 2 - (t.left + t.right) / 2)]; })()")
        check("[wide] the question box keeps a reading width and stays centred", c[0] <= 762 and abs(c[1]) <= 2, str(c))
        ask(page, "Parking required for a hotel with 60 rooms on a 9 m road")
        w = page.evaluate("Math.round(document.querySelector('.turn .prose').getBoundingClientRect().width)")
        check("[wide] answers keep a readable line length", w <= 760, str(w))
        nav(page, "library"); page.wait_for_selector(".mxn"); page.wait_for_timeout(600)
        d = page.evaluate("(() => { const i = document.querySelector('#mxCard'), m = document.querySelector('#libMatrix').getBoundingClientRect(), r = i.getBoundingClientRect(); return [getComputedStyle(i).position, r.left >= m.right, Math.round(r.top - m.top), i.dataset.state]; })()")
        check("[wide] on a big screen the inspector is docked beside the matrix, with its legend", d[0] == "sticky" and d[1] and abs(d[2]) <= 1 and d[3] == "blank", str(d))
        page.screenshot(path=str(SHOTS / "wide-library.png"))
        check("[wide] no JavaScript errors", not errors, "; ".join(errors[:3]))
    finally:
        ctx.close()


FAKE_DESKTOP = """(() => { const s = {maximized: false, fullscreen: false, focused: true}; let fn = null; window.__wc = [];
  window.cbDesktop = {platform: "win32", minimize() { __wc.push("minimize"); }, close() { __wc.push("close"); },
    maximize() { __wc.push("maximize"); s.maximized = !s.maximized; fn && fn({...s}); }, state: () => Promise.resolve({...s}),
    onState(f) { fn = f; }, theme(d, a) { window.__theme = [d, a]; }, __set(x) { Object.assign(s, x); fn && fn({...s}); }}; })()"""

BAR_JS = """() => { const r = e => e.getBoundingClientRect(), $ = s => document.querySelector(s), b = [...document.querySelectorAll('#winctl .wc')].map(r),
  ctl = r($('#winctl')), top = r($('.top')), act = r($('#topActions')), crumb = r($('.crumb')), cs = e => getComputedStyle(e),
  region = e => cs(e).getPropertyValue('app-region') || cs(e).getPropertyValue('-webkit-app-region');
  return {desktop: document.documentElement.classList.contains('desktop'), shown: cs($('#winctl')).display !== 'none', n: b.length,
    sizes: b.map(x => [Math.round(x.width), Math.round(x.height)]), gaps: b.slice(1).map((x, i) => Math.round(x.left - b[i].right)),
    rightGap: Math.round(top.right - b[2].right), dy: Math.round((b[0].top + b[0].bottom) / 2 - (top.top + top.bottom) / 2), dyCrumb: Math.round((b[0].top + b[0].bottom) / 2 - (crumb.top + crumb.bottom) / 2),
    afterActions: ctl.left >= act.right, drag: region($('.top')), dragSide: region($('.side-top')),
    noDrag: [region($('.crumb')) === 'drag' ? 'drag' : 'ok', region($('#topNew')), region($('#winctl .wc')), region($('.brand'))]}; }"""


def desktop_window(br, base):
    """The page as the desktop program shows it: the workspace's top bar is the window's title bar, with minimize / maximize / close in the app's own style."""
    for label, vp, scheme in (("window", {"width": 1280, "height": 860}, "dark"), ("window-min", {"width": 820, "height": 560}, "dark"), ("window-light", {"width": 1280, "height": 860}, "light")):
        ctx = br.new_context(viewport=vp)
        ctx.add_init_script(FAKE_DESKTOP)
        if scheme == "light":
            ctx.add_init_script("try { localStorage.setItem('ceylon-buildex-theme', 'light') } catch (e) {}")
        page = ctx.new_page(); errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(base + "/#ask", wait_until="domcontentloaded")
        page.wait_for_function("document.documentElement.dataset.ready === '1'", timeout=15000)
        page.evaluate("document.fonts.ready.then(() => true)")
        try:
            g = page.evaluate(BAR_JS)
            check(f"[{label}] the window buttons sit in the top bar, after its own actions", g["desktop"] and g["shown"] and g["n"] == 3 and g["afterActions"], str(g))
            check(f"[{label}] they are 32 px rounded squares, 4 px apart, 12 px from the window edge, centred in the bar",
                  all(x == [32, 32] for x in g["sizes"]) and g["gaps"] == [4, 4] and g["rightGap"] == 12 and abs(g["dy"]) <= 1 and abs(g["dyCrumb"]) <= 1, str(g))
            check(f"[{label}] the top bar and the sidebar head drag the window; the controls in them stay clickable", g["drag"] == "drag" and g["dragSide"] == "drag" and g["noDrag"][1:] == ["no-drag"] * 3, str(g))
            box = page.locator('#winctl .close').bounding_box()
            page.mouse.move(box["x"] + 16, box["y"] + 16); page.wait_for_timeout(250)
            hov = page.evaluate("""() => { const d = document.createElement('i'); d.style.color = getComputedStyle(document.documentElement).getPropertyValue('--orange'); document.body.append(d); const c = getComputedStyle(d).color; d.remove();
              return [getComputedStyle(document.querySelector('#winctl .close')).backgroundColor, c]; }""")
            check(f"[{label}] close turns the accent colour on hover", hov[0] == hov[1], str(hov))
            page.screenshot(path=str(SHOTS / f"{label}-titlebar.png"), clip={"x": 0, "y": 0, "width": vp["width"], "height": 80})
            page.screenshot(path=str(SHOTS / f"{label}.png"))
            page.click('#winctl [data-win="minimize"]'); page.click('#winctl [data-win="maximize"]')
            st = page.evaluate("""() => [document.querySelector('#winMaxUse').getAttribute('href'), document.querySelector('[data-win="maximize"]').getAttribute('aria-label'), document.documentElement.classList.contains('win-max')]""")
            check(f"[{label}] minimize and maximize reach the window; maximized shows Restore", page.evaluate("__wc") == ["minimize", "maximize"] and st == ["#i-win-restore", "Restore", True], str(st))
            page.click('#winctl [data-win="maximize"]')
            check(f"[{label}] restoring swaps it back", page.evaluate("document.querySelector('#winMaxUse').getAttribute('href')") == "#i-win-max")
            page.evaluate("cbDesktop.__set({focused: false})")
            check(f"[{label}] an inactive window dims its buttons", page.evaluate("document.documentElement.classList.contains('win-blur')"))
            page.evaluate("cbDesktop.__set({focused: true})")
            th = page.evaluate("window.__theme")
            check(f"[{label}] the page tells the window its theme and accent (for the start-up screen)", th and th[0] == (scheme == "dark") and re.match(r"^#[0-9a-f]{6}$", th[1] or "", re.I), str(th))
            open_settings(page)
            check(f"[{label}] with a dialog open the bars stop dragging (the dialog gets its clicks)",
                  page.evaluate("['.top', '.side-top'].every(s => { const e = document.querySelector(s), c = getComputedStyle(e); return (c.getPropertyValue('app-region') || c.getPropertyValue('-webkit-app-region')) === 'no-drag'; })"))
            close_settings(page)
            page.click('#winctl [data-win="close"]')
            check(f"[{label}] close reaches the window", page.evaluate("__wc").count("close") == 1)
            check(f"[{label}] no JavaScript errors", not errors, "; ".join(errors[:3]))
        finally:
            ctx.close()
    ctx, page, errors = new_page(br, base, {"width": 1280, "height": 860})
    try:
        check("[browser] in a plain browser there are no window buttons", not page.evaluate("document.documentElement.classList.contains('desktop')") and not page.locator("#winctl").is_visible())
    finally:
        ctx.close()


# ---------------------------------------------------------------- run
BASE_URL = BASE or start_server()
try:
    with sync_playwright() as p:
        br = p.chromium.launch()
        clip = {"permissions": ["clipboard-read", "clipboard-write"]}
        for label, vp, kw in (("desktop", {"width": 1440, "height": 900}, clip), ("phone", {"width": 390, "height": 820}, {"has_touch": True, "is_mobile": True, "device_scale_factor": 2, **clip})):
            ctx, page, errors = new_page(br, BASE_URL, vp, **kw)
            phone = label == "phone"
            basics(page, label, phone)
            if phone:
                phone_shell(page, label)
            else:
                layout_desktop(page, label)
            ask_compose(page, label, phone)
            ask_far(page, label)
            passages_mode(page, label)
            empty_and_error(page, label)
            a11y(page, label, phone)
            settings_layout(page, label, phone)
            far_view(page, label, phone)
            library_view(page, label, phone)
            ocr_view(page, label, phone)
            update_view(page, label, phone)
            shell_checks(page, label, phone)
            if not phone:
                themes(page, label)
                accent_checks(page, label)
                settings_flow(page, label)
            check(f"[{label}] no JavaScript errors", not errors, "; ".join(errors[:3]))
            ctx.close()
        stream_sync(br, "desktop")
        desktop_window(br, BASE_URL)
        reduced_motion(br, BASE_URL)
        wide_screen(br, BASE_URL)
        br.close()
finally:
    if SERVER:
        SERVER.terminate()
    mock.close()

bad = [r for r in results if not r[1]]
print(f"\n{len(results) - len(bad)}/{len(results)} checks passed; screenshots in {SHOTS}")
sys.exit(1 if bad else 0)
