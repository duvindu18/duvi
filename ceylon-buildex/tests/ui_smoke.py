"""Headless-browser test of the Ceylon Buildex interface (desktop, phone, dark mode, reduced motion).

The query page is one giant line to type into; the other pages are links top-right; every preference lives in Settings; answers carry highlighter marks.

    python tests/ui_smoke.py [base_url] [screenshot_dir]

With no base_url it starts its own server on a free port with a throw-away data directory (the shipped seed + rules).
Needs `playwright` + Chromium (optional dependency; the unittest suite does not need it).

The progress test puts a small proxy between the page and the server and feeds /api/ask/stream one event at a time, so it can
prove that what the page shows at every moment is what it has really been told - and that loaders stop the instant the answer lands.
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

BASE = sys.argv[1] if len(sys.argv) > 1 else None
SHOTS = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(tempfile.mkdtemp())
SHOTS.mkdir(parents=True, exist_ok=True)
results: list[tuple[str, bool, str]] = []
mock = MockLLM()
SERVER = None


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
SEEN_JS = """() => { window.__seen = []; new MutationObserver(() => { const s = document.querySelector('.trace .status'); if (!s) return;
  const t = s.textContent.trim(); if (t && window.__seen[window.__seen.length - 1] !== t) window.__seen.push(t); })
  .observe(document.body, {subtree: true, childList: true, characterData: true}); }"""
REAL_STATUS = [r"^Sending your question$", r"^Reading your question$", r"^Calculating floor area ratio$", r"^Searching [\d,]+ passages in [\d,]+ documents$",
               r"^Found \d+ passages? in \d+ documents?$", r"^No matching passages$", r"^Floor area calculated; no matching passages$",
               r"^Writing the answer with .+?( · \d+ s)?$", r"^Composing the answer from the passages$", r"^Searching the passages$", r"^Working on your question$"]


def real_only(seen):
    return [t for t in seen if not any(re.match(p, t) for p in REAL_STATUS)]


def status(page):
    return page.locator(".trace .status").inner_text().strip() if page.locator(".trace .status").count() else None


def wait_status(page, text, timeout=4000):
    page.wait_for_function("t => { const s = document.querySelector('.trace .status'); return s && s.textContent.trim() === t; }", arg=text, timeout=timeout)


def ticks(page):
    return page.eval_on_selector_all(".trace .ticks li", "els => els.map(e => (e.classList.contains('done') ? 'done' : e.classList.contains('active') ? 'active' : 'idle') + ':' + e.textContent)")


def ask(page, q, wait=True):
    page.fill("#q", q); page.press("#q", "Enter")
    if wait:
        answer_ready(page)


def answer_ready(page):
    page.wait_for_function("() => { const a = document.querySelector('#results .answer'); return a && !a.hasAttribute('aria-busy') && a.querySelector('.abody > *') && !a.querySelector('.trace'); }", timeout=25000)


def new_page(br, base, vp, **kw):
    ctx = br.new_context(viewport=vp, **kw)
    page = ctx.new_page(); errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text and "ERR_" not in m.text else None)
    page.goto(base + "/#ask", wait_until="domcontentloaded")
    page.wait_for_function("document.documentElement.dataset.ready === '1'", timeout=15000)
    page.evaluate("document.fonts.ready.then(() => true)")
    return ctx, page, errors


def open_settings(page):
    page.click("#settingsBtn"); page.wait_for_selector("#settings[open]", timeout=5000)


def close_settings(page):
    page.click("#stClose"); page.wait_for_function("!document.querySelector('#settings').open", timeout=5000)


def set_search(page, mode=None, cat=None):
    """Search options live in the Settings dialog only."""
    open_settings(page)
    if mode:
        page.click(f'#settings label:has(input[name="mode"][value="{mode}"])')
    if cat:
        page.select_option("#cat", cat)
    close_settings(page)


def visible_controls(page):
    return page.evaluate("""() => [...document.querySelectorAll('#view-ask button, #view-ask a, #view-ask select, #view-ask input, #view-ask textarea')]
      .filter(e => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none'; })
      .map(e => e.id || e.tagName)""")


def marks_painted(page):
    return page.evaluate("""() => [...document.querySelectorAll('#results .answer:first-child .prose mark')].every(m => getComputedStyle(m).backgroundSize === '100% 100%')""")


# ---------------------------------------------------------------- scenarios
def basics(page, label, phone):
    check(f"[{label}] title and brand", "ceylon buildex" in page.title().lower() and "ceylon buildex" in page.inner_text(".bar .brand").lower(), page.title())
    sw, cw = page.evaluate("document.documentElement.scrollWidth"), page.evaluate("document.documentElement.clientWidth")
    check(f"[{label}] no horizontal page scroll", sw <= cw + 1, f"{sw} vs {cw}")
    ctl = visible_controls(page)
    check(f"[{label}] the query page holds only the search line (no buttons, chips, examples, toggles)", ctl == ["q"] and page.locator("#examples, #llmHint, #view-ask .chip").count() == 0, str(ctl))
    check(f"[{label}] no footer anywhere on the page", page.locator("footer, .foot").count() == 0)
    ph = " ".join((page.text_content("#ph") or "").split()).lower()
    check(f"[{label}] placeholder reads 'Find the rule' followed by '...'", ph == "find the rule...", ph)
    d = page.evaluate("getComputedStyle(document.querySelector('#ph .dots')).animationName")
    check(f"[{label}] the dots after the placeholder blink", d != "none", d)
    fs = page.evaluate("parseFloat(getComputedStyle(document.querySelector('#q')).fontSize)")
    check(f"[{label}] the start line is set in the bundled display face at a fixed, modest size", page.evaluate("[...document.fonts].some(f => f.family.replace(/\"/g, '') === 'Anton' && f.status === 'loaded')") and (26 if phone else 30) <= fs <= (56 if phone else 88), f"{fs:.0f}px")
    st = page.evaluate("""() => { const q = getComputedStyle(document.querySelector('#q')), root = getComputedStyle(document.documentElement); return {up: q.textTransform, w: q.fontWeight, c: q.color, accent: root.getPropertyValue('--orange').trim()}; }""")
    check(f"[{label}] the start line keeps the bold capitals in the accent colour", st["up"] == "uppercase" and int(st["w"]) == 400 and st["c"] != "rgb(0, 0, 0)", str(st))
    c = page.evaluate("""() => { const t = document.querySelector('#ph').firstChild, r = document.createRange(); r.selectNodeContents(t); const b = r.getBoundingClientRect(), p = document.querySelector('#view-ask').getBoundingClientRect();
      return {dx: (b.left + b.right) / 2 - innerWidth / 2, dy: (b.top + b.bottom) / 2 - (p.top + p.bottom) / 2}; }""")
    check(f"[{label}] the start line sits in the centre of the page", abs(c["dx"]) <= 3 and abs(c["dy"]) <= 0.12 * page.viewport_size["height"], f"off by {c['dx']:.0f}px across, {c['dy']:.0f}px down")
    ph_box = page.locator("#ph").bounding_box(); vh = page.viewport_size["height"]
    check(f"[{label}] the placeholder fits on one screen", ph_box["y"] + ph_box["height"] <= vh, f"bottom {ph_box['y'] + ph_box['height']:.0f}/{vh}")
    labels = page.eval_on_selector_all(".tabs button", "els => els.map(e => e.textContent.trim())")
    check(f"[{label}] other pages are plain links in the top bar", labels == ["Floor area", "Library", "Scan", "Update", "Settings"], str(labels))
    tabs, vw = page.locator(".tabs").bounding_box(), page.viewport_size["width"]
    check(f"[{label}] links sit in the top-right corner", tabs["x"] + tabs["width"] >= vw - 44 and tabs["y"] < (150 if phone else 70), f"right edge {tabs['x'] + tabs['width']:.0f}/{vw}, y={tabs['y']:.0f}")
    page.screenshot(path=str(SHOTS / f"{label}-1-idle.png"))


def typing_fit(page, label):
    fs = lambda: page.evaluate("parseFloat(getComputedStyle(document.querySelector('#q')).fontSize)")  # noqa: E731
    page.click("#q"); page.keyboard.type("Parking")
    big = fs()
    page.keyboard.press("Escape")
    check(f"[{label}] Escape clears the line and the placeholder returns", page.input_value("#q") == "" and page.locator("#askField.filled").count() == 0)
    page.fill("#q", "What is the maximum permitted building height and plot coverage for a mixed development site on a 12 m road in the Colombo Municipal Council area?")
    page.wait_for_timeout(150)
    small = fs(); box = page.locator("#q").bounding_box(); vh = page.viewport_size["height"]
    fits = page.evaluate("document.querySelector('#q').scrollHeight <= document.querySelector('#q').clientHeight + 1")
    check(f"[{label}] typed words stay huge, then shrink to keep fitting the screen", small < big and fits and box["y"] + box["height"] <= vh, f"{big:.0f}px -> {small:.0f}px, bottom {box['y'] + box['height']:.0f}/{vh}")
    page.screenshot(path=str(SHOTS / f"{label}-1b-typing.png"))
    page.keyboard.press("Escape")


def ask_compose(page, label):
    page.evaluate(SEEN_JS)
    q = "How much bid security do the procurement guidelines require?"
    ask(page, q)
    check(f"[{label}] ask returns a cited answer", page.locator("#results .answer .prose").count() == 1 and page.locator("#results .answer .cite").count() > 0,
          page.inner_text("#results .answer .prose")[:90].replace("\n", " "))
    check(f"[{label}] loaders are gone when the answer is shown", page.locator("#results .trace, #results .skel").count() == 0 and page.get_attribute("#view-ask", "data-busy") == "false")
    check(f"[{label}] search box keeps the query and offers 'Ask' again", page.input_value("#q") == q and page.get_attribute("#askBtn", "aria-label") == "Ask")
    seen = page.evaluate("window.__seen")
    check(f"[{label}] every status line shown was a real stage", not real_only(seen), " | ".join(seen) or "(all stages arrived within one frame)")
    check(f"[{label}] 'Writing the answer with ...' is never shown when no language model is set", not any(t.startswith("Writing the answer") for t in seen), " | ".join(seen))
    check(f"[{label}] the page switches to the compact answer layout with a Clear button", page.get_attribute("#view-ask", "data-state") == "active" and page.locator("#qClear:visible").count() == 1)
    marks = page.eval_on_selector_all("#results .answer:first-child .prose mark.hl", "els => els.map(e => e.textContent.trim())")
    prose = " ".join(page.inner_text("#results .answer:first-child .prose").split())
    check(f"[{label}] key facts in the answer are highlighted", len(marks) >= 1 and all(" ".join(m.split()) in prose for m in marks) and "==" not in prose and page.locator("#results .prose mark .cite").count() == 0, str(marks))
    page.wait_for_function("() => [...document.querySelectorAll('#results .answer:first-child .prose mark')].every(m => getComputedStyle(m).backgroundSize === '100% 100%')", timeout=6000)
    check(f"[{label}] the highlighter finishes painting (marker stroke completes)", marks_painted(page))
    page.screenshot(path=str(SHOTS / f"{label}-2-answer.png"))
    lay = page.evaluate("""() => { const pr = document.querySelector('#results .answer:first-child .prose').getBoundingClientRect(), sr = document.querySelector('#results .srcs'), tabs = document.querySelector('.tabs').getBoundingClientRect(),
      rs = document.querySelector('#results'); const sb = sr.getBoundingClientRect();
      return {gap: Math.round(sb.left - pr.right), right: Math.round(sb.right - tabs.right), sticky: getComputedStyle(sr).position, stacked: sb.top >= document.querySelector('#results .answer:first-child .prose').getBoundingClientRect().bottom - 2, scrolls: rs.scrollHeight >= rs.clientHeight, page: document.documentElement.scrollHeight - innerHeight}; }""")
    if label == "phone":
        check(f"[{label}] sources sit below the answer on a phone", lay["stacked"] and lay["page"] <= 1, str(lay))
    else:
        check(f"[{label}] sources sit right beside the answer (no wide gap), lined up with the right edge of the links", lay["gap"] <= 110 and abs(lay["right"]) <= 3 and lay["sticky"] == "sticky" and lay["page"] <= 1, str(lay))
    page.click("#results .answer:first-child [data-copy]")
    page.wait_for_selector("#toast.on", timeout=3000)
    clip = page.evaluate("navigator.clipboard.readText()")
    check(f"[{label}] Copy answer gives plain text without highlight markers", page.inner_text("#toast") == "Copied" and "==" not in clip and "**" not in clip and "[1]" in clip, clip[:80].replace("\n", " "))
    page.locator("#results .answer .cite").first.click()
    check(f"[{label}] citation highlights its source", page.locator("#results .src.flash").count() == 1 or page.locator("#results .src .snip:not([hidden])").count() >= 1)
    page.locator("#results .answer .src .peek").first.click()
    page.locator("#results .answer .src .main").first.click()
    page.wait_for_selector("#reader[open] .chunk", timeout=8000)
    check(f"[{label}] source opens the reader at its passages", page.locator("#reader .chunk").count() > 0)
    page.fill("#rdQ", "security"); page.wait_for_timeout(500)
    check(f"[{label}] reader search highlights words", page.locator("#reader mark").count() > 0 or "No passages match" in page.inner_text("#rdBody"))
    page.keyboard.press("Escape")                       # a search field clears itself on the first Esc
    if page.locator("#reader[open]").count():
        page.keyboard.press("Escape")
    check(f"[{label}] Escape closes the reader", page.locator("#reader[open]").count() == 0)
    # second question collapses the first
    ask(page, "What is the plot coverage for a 15 storey building in Colombo?")
    check(f"[{label}] older answers collapse, newest stays open", page.locator("#results .answer").count() == 2 and page.locator("#results .answer.collapsed").count() == 1)
    page.locator("#results .answer.collapsed .ahead").click()
    check(f"[{label}] a collapsed answer expands on click", page.locator("#results .answer.collapsed").count() == 0)
    page.click("#qClear")
    check(f"[{label}] Clear empties the line", page.input_value("#q") == "" and page.locator("#qClear:visible").count() == 0)


def ask_far(page, label):
    ask(page, "What is the maximum FAR for a 20 perch plot on a 40 ft road in the Colombo Municipal Council area, Mixed Development zone?")
    page.wait_for_selector("#results .answer:first-child .faro .n", timeout=10000)
    n = page.inner_text("#results .answer:first-child .faro .n").strip()
    check(f"[{label}] FAR question runs the rules engine (20 perch / 40 ft / MD -> 5.0)", n == "5.0", n)
    check(f"[{label}] a long question is shown from its first word, not its tail", page.evaluate("document.querySelector('#q').scrollTop") == 0)
    page.wait_for_timeout(400)
    first = page.eval_on_selector_all("#results .answer:first-child .prose mark.hl", "els => els.map(e => e.textContent.trim())")
    check(f"[{label}] FAR answer highlights the ratio and its conditions", any("FAR" in m for m in first) and len(first) >= 2, str(first))


def passages_mode(page, label):
    open_settings(page)
    check(f"[{label}] 'Hide superseded' appears only in Passages mode", page.locator("#curWrap:visible").count() == 0)
    page.click('#settings label:has(input[value="passages"])')
    check(f"[{label}] choosing Passages in Settings reveals 'Hide superseded'", page.locator("#curWrap:visible").count() == 1)
    close_settings(page)
    ask(page, "building line")
    check(f"[{label}] passages mode lists matching passages with highlights", page.locator("#results .answer:first-child .hit").count() > 0 and page.locator("#results .answer:first-child .hit mark").count() > 0,
          str(page.locator("#results .answer:first-child .hit").count()))
    page.reload(wait_until="domcontentloaded"); page.wait_for_function("document.documentElement.dataset.ready === '1'", timeout=15000)
    open_settings(page)
    check(f"[{label}] search choices are remembered after a reload", page.locator('#settings input[name="mode"][value="passages"]:checked').count() == 1)
    close_settings(page)
    set_search(page, mode="answer")


def empty_and_error(page, label, base):
    ask(page, "xyzzy plugh quux frobnicate")
    check(f"[{label}] unknown topic shows a helpful empty state", "nothing on record" in page.inner_text("#results .answer:first-child").lower() and page.locator("#results .answer:first-child [data-edit]").count() == 1,
          page.inner_text("#results .answer:first-child")[:80].replace("\n", " "))
    page.locator("#results .answer:first-child [data-edit]").click()
    check(f"[{label}] 'Edit question' puts the query back in the box", page.input_value("#q") == "xyzzy plugh quux frobnicate")
    # network failure -> error state with retry, query preserved
    page.route("**/api/ask/stream", lambda r: r.abort("failed"))
    page.fill("#q", "How much bid security do the procurement guidelines require?"); page.press("#q", "Enter")
    page.wait_for_selector("#results .answer:first-child .errbox", timeout=8000)
    txt = page.inner_text("#results .answer:first-child .errbox")
    check(f"[{label}] failed request shows an error with Retry", "Retry" in txt and "Can't reach the server" in txt, txt[:90].replace("\n", " "))
    check(f"[{label}] query is preserved after a failure and the box is usable again", page.input_value("#q").startswith("How much bid") and page.get_attribute("#view-ask", "data-busy") == "false")
    page.screenshot(path=str(SHOTS / f"{label}-3-error.png"))
    page.unroute("**/api/ask/stream")
    page.locator("#results .answer:first-child [data-retry]").click()
    answer_ready(page)
    check(f"[{label}] Retry recovers", page.locator("#results .answer:first-child .prose").count() == 1)
    # filtered empty state offers to widen
    set_search(page, cat="gazette")
    ask(page, "xyzzy plugh quux frobnicate")
    check(f"[{label}] empty state under a filter offers 'Search all sources'", page.locator('#results .answer:first-child [data-switch="all"]').count() == 1)
    set_search(page, cat="all")


def far_view(page, label, phone):
    page.click('.tabs button[data-view="far"]')
    page.wait_for_function("document.querySelector('#zone').options.length > 5", timeout=8000)
    check(f"[{label}] calculator waits with a clear prompt before inputs are valid", "Enter the land extent" in page.inner_text("#farOut"))
    page.click('#farExamples [data-ex="0"]')
    page.wait_for_function("document.querySelector('#farOut .num') && document.querySelector('#farOut .num').textContent.trim() === '5.0'", timeout=8000)
    check(f"[{label}] calculator: CMC 20 perch / 40 ft -> FAR 5.0", True)
    check(f"[{label}] result states the regime caveat and floor area", "m²" in page.inner_text("#farOut") and "Confirm with" in page.inner_text("#farOut"))
    page.locator("#farOut details summary", has_text="Printed table row").click()
    check(f"[{label}] printed table row is available and highlighted", page.locator("#farOut table.t td.hl, #farOut table.t tr.hlr").count() > 0)
    sw, cw = page.evaluate("document.documentElement.scrollWidth"), page.evaluate("document.documentElement.clientWidth")
    check(f"[{label}] opening the wide table does not widen the page", sw <= cw + 1 and page.evaluate("innerWidth") == page.viewport_size["width"], f"{sw} vs {cw}")
    page.screenshot(path=str(SHOTS / f"{label}-4-far-cmc.png"))
    # auto-calculation when an input changes, no button press
    page.click('label:has(input[value="uda2021"])')
    page.fill("#zf", "1.1"); page.fill("#land", "600"); page.select_option("#landU", "m2"); page.fill("#road", "12"); page.select_option("#roadU", "m")
    page.wait_for_function("document.querySelector('#farOut .num') && document.querySelector('#farOut .num').textContent.trim() === '2.7'", timeout=8000)
    check(f"[{label}] calculator updates by itself: UDA zone factor 1.1 / 600 m2 / 12 m -> 2.7", True)
    page.fill("#land", "")
    page.wait_for_function("document.querySelector('#farOut').textContent.includes('Enter the land extent')", timeout=5000)
    check(f"[{label}] clearing an input returns to the prompt (no stale number)", page.locator("#farOut.pending").count() == 1)
    page.fill("#land", "600")
    page.wait_for_function("document.querySelector('#farOut .num') && document.querySelector('#farOut .num').textContent.trim() === '2.7'", timeout=8000)
    if phone:
        page.evaluate("(() => { const v = document.querySelector('#view-far'); v.scrollTo(0, v.scrollTop + document.querySelector('#farOut').getBoundingClientRect().top - innerHeight - 20); })()"); page.wait_for_timeout(700)
        check(f"[{label}] phone shows a floating result bar while editing", page.locator("#farMini.on").count() == 1 and "2.7" in page.inner_text("#farMini"), page.inner_text("#farMini"))
        page.evaluate("document.querySelector('#view-far').scrollTo(0, 0)")
    page.screenshot(path=str(SHOTS / f"{label}-5-far-uda.png"))
    page.click("#farOut [data-act='ask']")
    check(f"[{label}] 'Ask about this' moves the result into the search box", page.input_value("#q").startswith("Explain this FAR result"))


def library_view(page, label, phone=False):
    page.click('.tabs button[data-view="library"]')
    page.wait_for_selector("#libMatrix .node", timeout=8000)
    page.wait_for_timeout(2300)                          # the squares pop in and the lines draw themselves
    nodes = page.locator("#libMatrix .node").count()
    boxes = page.locator("#libMatrix .box").count()
    check(f"[{label}] library opens as a map: labelled boxes, one round node per source", nodes >= 10 and boxes >= 2 and page.locator("#libMatrix .node .dot").count() == nodes and page.get_attribute("#libMatrix svg", "class").split()[0] == "mx", f"{nodes} nodes, {boxes} boxes")
    g = page.evaluate("""() => {
      const wrap = document.querySelector('#libMatrix'), wr = wrap.getBoundingClientRect(), svg = wrap.querySelector('svg');
      const ids = new Set([...svg.querySelectorAll('.node')].map(n => n.dataset.id)), lines = [...svg.querySelectorAll('.m, .e')];
      const boxRect = i => svg.querySelector(`.box[data-box="${i}"] .bx`).getBoundingClientRect();
      const nd = [...svg.querySelectorAll('.node')].map(n => { const r = n.querySelector('.dot').getBoundingClientRect(); return {id: n.dataset.id, b: +getComputedStyle(n).getPropertyValue('--b'), x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2, r: r.width / 2}; });
      let overlap = 0, outside = 0, off = 0;
      for (let i = 0; i < nd.length; i++) { const a = nd[i], bx = boxRect(a.b); if (a.x - a.r < bx.left - 0.5 || a.x + a.r > bx.right + 0.5 || a.y - a.r < bx.top - 0.5 || a.y + a.r > bx.bottom + 0.5) outside++;
        if (a.x - a.r < wr.left - 1 || a.x + a.r > wr.right + 1) off++;
        for (let j = i + 1; j < nd.length; j++) if (Math.hypot(a.x - nd[j].x, a.y - nd[j].y) < a.r + nd[j].r) overlap++; }
      const tabsOut = [...svg.querySelectorAll('.box')].filter(b => { const t = b.querySelector('.tb').getBoundingClientRect(), r = b.querySelector('.bx').getBoundingClientRect(); return t.right > r.right + 1 || t.left < r.left; }).length;
      const mesh = [...svg.querySelectorAll('.m')], seg = e => ({x1: +e.getAttribute('x1'), y1: +e.getAttribute('y1'), x2: +e.getAttribute('x2'), y2: +e.getAttribute('y2'), a: e.dataset.a, b: e.dataset.b});
      const o = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
      let cross = 0; const S = mesh.map(seg);
      for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) { const u = S[i], v = S[j]; if ([u.a, u.b].some(x => x === v.a || x === v.b)) continue;
        const A = {x: u.x1, y: u.y1}, B = {x: u.x2, y: u.y2}, C = {x: v.x1, y: v.y1}, D = {x: v.x2, y: v.y2}; if (o(A, B, C) * o(A, B, D) < -1e-6 && o(C, D, A) * o(C, D, B) < -1e-6) cross++; }
      const perBox = new Map(); nd.forEach(n => perBox.set(n.b, (perBox.get(n.b) || 0) + 1));
      const meshBox = new Map(); mesh.forEach(e => { const b = nd.find(n => n.id === e.dataset.a).b; meshBox.set(b, (meshBox.get(b) || 0) + 1); });
      const triangulated = [...perBox].filter(([b, n]) => n >= 3).every(([b, n]) => (meshBox.get(b) || 0) >= 2 * n - 3 && (meshBox.get(b) || 0) <= 3 * n - 6);
      return {lines: lines.length, mesh: mesh.length, bad: lines.filter(e => !ids.has(e.dataset.a) || !ids.has(e.dataset.b)).length, overlap, outside, off, tabsOut, cross, triangulated,
              kinds: [...new Set([...svg.querySelectorAll('.e')].map(e => e.getAttribute('class').split(' ').find(c => ['site','auth','gaz','sup'].includes(c))))]}; }""")
    check(f"[{label}] every line joins two real sources; nodes never overlap, stay inside their box and on screen; box labels fit their box", g["lines"] > 0 and g["bad"] == 0 and g["overlap"] == 0 and g["outside"] == 0 and g["off"] == 0 and g["tabsOut"] == 0, str(g))
    check(f"[{label}] inside each box the nodes are joined by a mesh of triangles whose lines never cross", g["mesh"] >= 8 and g["cross"] == 0 and g["triangulated"], str(g))
    anim = page.evaluate("""() => { const e = document.querySelector('#libMatrix .m'), n = document.querySelector('#libMatrix .node'), b = document.querySelector('#libMatrix .box'); return [getComputedStyle(e).animationName, getComputedStyle(n).animationName, getComputedStyle(b).animationName, document.querySelector('#libMatrix svg').classList.contains('flow')]; }""")
    check(f"[{label}] the matrix is animated: boxes rise, nodes pop in, lines draw, signals flow along real links", anim == ["mx-draw", "mx-pop", "bx-in", True], str(anim))
    full = page.evaluate("(() => { const m = document.querySelector('#libMatrix'), b = m.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height), innerWidth, innerHeight]; })()")
    hdr = page.evaluate("(() => { const t = document.querySelector('.tabs').getBoundingClientRect(), b = document.querySelector('#libMatrix').getBoundingClientRect(); return Math.round(Math.abs(b.right - t.right)) })()")
    check(f"[{label}] the matrix fills the frame (no big empty areas) and lines up with the header", full[0] >= min(full[2] - 120, 1500) and hdr <= 3 and (phone or full[1] >= 0.45 * full[3]), str(full) + f" right-edge diff {hdr}")
    if not phone:
        box = page.locator("#libMatrix .node:not(.off) .dot").nth(2).bounding_box()
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2); page.wait_for_timeout(500)
        hot = page.evaluate("[document.querySelector('#libMatrix svg').classList.contains('hot'), document.querySelectorAll('#libMatrix .node.on').length, document.querySelector('#mxCard').hidden, document.querySelectorAll('#libMatrix .box.on').length]")
        check(f"[{label}] pointing at a node lights its real relations, outlines its box and shows its card", hot[0] and hot[1] >= 1 and hot[2] is False and hot[3] == 1, str(hot))
        cb = page.locator("#mxCard").bounding_box()
        page.mouse.move(cb["x"] + cb["width"] / 2, cb["y"] + cb["height"] / 2); page.wait_for_timeout(500)
        check(f"[{label}] the card stays while the pointer moves onto it", page.evaluate("document.querySelector('#mxCard').hidden") is False)
        page.mouse.move(2, 400); page.wait_for_timeout(700)
        check(f"[{label}] the card goes when the pointer leaves", page.evaluate("document.querySelector('#mxCard').hidden") is True)
        page.screenshot(path=str(SHOTS / f"{label}-6-library-matrix.png"))
    # filters act on the matrix
    page.click('#libChips [data-lc="procurement-sbd"]'); page.wait_for_timeout(500)
    on = page.locator("#libMatrix .node:not(.off)").count()
    dimmed = page.locator("#libMatrix .box.off").count()
    check(f"[{label}] category filter dims the other nodes and any box left empty", 0 < on < nodes and dimmed >= 1, f"{on}/{nodes}, {dimmed} boxes dimmed")
    page.click('#libChips [data-lc="all"]'); page.fill("#libQ", "2235"); page.wait_for_timeout(500)
    on = page.locator("#libMatrix .node:not(.off)").count()
    check(f"[{label}] text filter (gazette number) dims non-matching nodes", 0 < on < 6, str(on))
    page.fill("#libQ", "zzzzzz"); page.wait_for_selector("#libEmpty:not([hidden])", timeout=5000)
    check(f"[{label}] empty filter offers 'Clear filter'", page.locator("[data-lib-clear]").count() == 1)
    page.click("[data-lib-clear]"); page.wait_for_timeout(400)
    # keyboard
    page.locator("#libMatrix .node[tabindex='0']").focus(); first = page.evaluate("document.activeElement.dataset.id")
    page.keyboard.press("ArrowRight"); page.keyboard.press("ArrowDown")
    check(f"[{label}] arrow keys move between nodes", page.evaluate("document.activeElement.classList.contains('node') && document.activeElement.dataset.id") not in (False, first))
    # open from the matrix (leave the keyboard focus first, so its card is not in the way)
    page.evaluate("document.activeElement.blur()"); page.mouse.move(2, 400); page.wait_for_timeout(500)
    node = page.locator("#libMatrix .node:not(.off)").first
    if phone:
        node.locator(".hit").tap(); page.wait_for_timeout(300)
        check(f"[{label}] first tap shows the card, the Read button opens the document", page.evaluate("document.querySelector('#mxCard').hidden") is False)
        page.click("#mxCard [data-doc]")
    else:
        node.locator(".hit").click()
    page.wait_for_selector("#reader[open] .chunk", timeout=8000)
    check(f"[{label}] a node opens the document in the reader", page.locator("#reader .chunk").count() > 0)
    page.keyboard.press("Escape")
    # list view
    page.click("label:has(input[name=libmode][value=list])"); page.wait_for_selector("#libList .row-doc", timeout=8000)
    n = page.locator("#libList .row-doc").count()
    check(f"[{label}] list view shows every document", n == nodes, f"{n}/{nodes}")
    page.click('#libChips [data-lc="procurement-sbd"]')
    page.wait_for_function("() => { const n = document.querySelectorAll('#libList .row-doc').length; return n > 0 && n < 8; }", timeout=8000)
    check(f"[{label}] list filter works", True, str(page.locator("#libList .row-doc").count()))
    page.click('#libChips [data-lc="all"]')
    page.locator("#libList .row-doc").first.click()
    page.wait_for_selector("#reader[open] .chunk", timeout=8000)
    check(f"[{label}] a list row opens the reader", page.locator("#reader .chunk").count() > 0)
    page.keyboard.press("Escape")
    page.screenshot(path=str(SHOTS / f"{label}-6-library-list.png"))
    page.click("label:has(input[name=libmode][value=matrix])")


def ocr_view(page, label):
    page.click('.tabs button[data-view="ocr"]')
    tmp = Path(tempfile.mkdtemp()); pdf = make_scanned_pdf(tmp / "scan.pdf")
    page.set_input_files("#file", str(pdf))
    page.wait_for_function("() => !document.querySelector('#ocrOut').hidden", timeout=60000)
    txt = page.input_value("#ocrText").lower()
    check(f"[{label}] Scan reads a scanned PDF", "floor area ratio" in txt and "12.2" in txt and "5.0" in txt, txt[:90].replace("\n", " "))
    check(f"[{label}] Scan shows finished progress and stats", "Done" in page.inner_text("#ocrMsg") and "page" in page.inner_text("#ocrStats"), page.inner_text("#ocrStats")[:80])
    page.wait_for_function("() => { const i = document.querySelector('#ocrProg > i'); return Math.round(i.getBoundingClientRect().width) >= Math.round(i.parentElement.getBoundingClientRect().width) - 1; }", timeout=3000)
    check(f"[{label}] the Scan progress bar is full once it says Done", True)
    page.screenshot(path=str(SHOTS / f"{label}-7-scan.png"))


def update_view(page, label):
    page.click('.tabs button[data-view="update"]')
    page.wait_for_selector("#srcList li", timeout=8000)
    check(f"[{label}] registered sources are listed in the open, next to the update controls", page.locator("#h-src").is_visible())
    n = page.locator("#srcList li").count()
    check(f"[{label}] Update lists registered sources", n >= 20, str(n))
    check(f"[{label}] Update button idle and no progress bar when nothing is running", page.locator("#updBtn:not([disabled])").count() == 1 and page.locator("#updProg:visible").count() == 0)
    page.screenshot(path=str(SHOTS / f"{label}-8-update.png"))


def shell_checks(page, label, phone):
    """The page is a fixed frame: the browser never scrolls, each page scrolls inside it, and content lines up with the header."""
    for view in ("ask", "far", "library", "ocr", "update"):
        page.click(f'.tabs button[data-view="{view}"]') if view != "ask" else page.goto(page.url.split("#")[0] + "#ask")
        page.wait_for_timeout(450)
        page.evaluate("window.scrollTo(0, 800)")
        st = page.evaluate("""(view) => {
          const de = document.documentElement, bar = document.querySelector('.bar').getBoundingClientRect(), brand = document.querySelector('.brand').getBoundingClientRect(), tabs = document.querySelector('.tabs').getBoundingClientRect();
          const v = document.querySelector('#view-' + view), vb = v.getBoundingClientRect();
          const h = v.querySelector('h1.display:not(.sr), .libhead h1'), hb = h && h.getBoundingClientRect();
          return {page: de.scrollHeight - innerHeight, y: scrollY, hx: de.scrollWidth - de.clientWidth, barTop: Math.round(bar.top), viewBottom: Math.round(vb.bottom) - innerHeight,
                  left: hb ? Math.round(hb.left - brand.left) : 0, right: Math.round(tabs.right)};
        }""", view)
        check(f"[{label}] {view}: the browser itself never scrolls (fixed frame, header stays put)", st["page"] <= 1 and st["y"] == 0 and st["hx"] <= 1 and st["barTop"] == 0 and st["viewBottom"] <= 1, str(st))
        check(f"[{label}] {view}: heading lines up with the brand on the left", abs(st["left"]) <= 3, str(st["left"]))
    # long pages scroll inside their own pane, with the bar inside the frame
    page.click('.tabs button[data-view="update"]'); page.wait_for_timeout(300)
    sc = page.evaluate("""() => { const cols = [...document.querySelectorAll('#view-update .card, #view-update')].filter(e => e.scrollHeight > e.clientHeight + 20);
      const e = cols[0]; if (!e) return null; e.scrollTo(0, 400); const r = e.getBoundingClientRect();
      return {moved: e.scrollTop > 0, right: Math.round(r.right), vw: innerWidth, bottom: Math.round(r.bottom), vh: innerHeight, pageY: scrollY}; }""")
    check(f"[{label}] Update: a long list scrolls inside its own pane, not the browser", bool(sc) and sc["moved"] and sc["pageY"] == 0 and sc["right"] <= sc["vw"] + 1 and sc["bottom"] <= sc["vh"] + 1, str(sc))
    if not phone:
        for view in ("far", "ocr", "update"):
            page.click(f'.tabs button[data-view="{view}"]'); page.wait_for_timeout(300)
            r = page.evaluate("""(view) => { const cols = [...document.querySelectorAll('#view-' + view + ' .split > .card, #view-' + view + ' .split > .farout')];
              const tabs = document.querySelector('.tabs').getBoundingClientRect(), a = cols[0].getBoundingClientRect(), b = cols[cols.length - 1].getBoundingClientRect(), h = document.querySelector('#view-' + view + ' h1').getBoundingClientRect();
              return {n: cols.length, right: Math.round(b.right - tabs.right), gap: Math.round(b.left - a.right), dTop: Math.round(Math.abs(a.top - b.top)), dH: Math.round(Math.abs(a.height - b.height)), dBottom: Math.round(Math.abs(a.bottom - b.bottom)),
                      below: Math.round(a.top - h.bottom), end: Math.round(innerHeight - a.bottom)}; }""", view)
            check(f"[{label}] {view}: two panels share the page, right edge lines up with the links", r["n"] == 2 and abs(r["right"]) <= 3 and r["gap"] <= 60, str(r))
            check(f"[{label}] {view}: the two panels have the same top, the same height and the same bottom", r["dTop"] <= 1 and r["dH"] <= 1 and r["dBottom"] <= 1, str(r))
            check(f"[{label}] {view}: the panels sit clear of the title and of the bottom edge", r["below"] >= 10 and 12 <= r["end"] <= 48, str(r))
        page.click('.tabs button[data-view="library"]'); page.wait_for_timeout(300)
        r = page.evaluate("Math.round(document.querySelector('.libtools').getBoundingClientRect().right - document.querySelector('.tabs').getBoundingClientRect().right)")
        check(f"[{label}] library: search and toggle line up with the links", abs(r) <= 3, str(r))
    else:
        page.click('.tabs button[data-view="far"]'); page.wait_for_timeout(300)
        cols = page.evaluate("document.querySelectorAll('#view-far .split > .card').length && getComputedStyle(document.querySelector('#view-far .split')).gridTemplateColumns.split(' ').length")
        check(f"[{label}] far: columns stack into one on a phone", cols == 1, str(cols))


def accent_checks(page, label):
    open_settings(page)
    check(f"[{label}] Settings offers an accent colour (presets and a custom colour)", page.locator("#accentSw input[name=accent]").count() >= 6 and page.locator("#accentCustom").count() == 1)
    css = lambda: page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--orange').trim()")  # noqa: E731
    before = css()
    page.click('#accentSw label[title="Cobalt"]'); page.wait_for_timeout(250)
    after = css()
    check(f"[{label}] choosing Cobalt recolours the page straight away and saves it", after != before and page.evaluate("localStorage.getItem('ceylon-buildex-accent')") == "cobalt", f"{before} -> {after}")
    close_settings(page)
    page.reload(wait_until="domcontentloaded"); page.wait_for_function("document.documentElement.dataset.ready === '1'", timeout=15000)
    check(f"[{label}] the accent survives a reload", css() == after, css())
    q = page.evaluate("getComputedStyle(document.querySelector('#q')).caretColor")
    check(f"[{label}] the start line uses the accent", q.replace(" ", "") == page.evaluate("(() => { const d = document.createElement('i'); d.style.color = getComputedStyle(document.documentElement).getPropertyValue('--orange'); document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; })()").replace(" ", ""), q)
    # text on the accent stays readable for every preset, light and dark
    bad = page.evaluate("""() => {
      const lum = h => { const c = [1,3,5].map(i => { const v = parseInt(h.substr(i,2),16)/255; return v <= .03928 ? v/12.92 : Math.pow((v+.055)/1.055, 2.4); }); return .2126*c[0] + .7152*c[1] + .0722*c[2]; };
      const out = [], root = document.documentElement;
      for (const th of ['light', 'dark']) { root.dataset.theme = th;
        for (const k of Object.keys(CBAccent.presets)) { CBAccent.save(k); const a = getComputedStyle(root).getPropertyValue('--orange').trim() || CBAccent.hex('vermilion'), b = (getComputedStyle(root).getPropertyValue('--on-orange').trim() || '#15162a');
          const A = lum(a.length === 7 ? a : '#f4481f'), B = lum(b.length === 7 ? b : '#15162a'), r = (Math.max(A, B) + .05) / (Math.min(A, B) + .05); if (r < 4.5) out.push(th + ':' + k + ' ' + r.toFixed(1)); } }
      delete root.dataset.theme; return out; }""")
    check(f"[{label}] text on the accent is readable (contrast 4.5:1) for every preset, light and dark", not bad, str(bad))
    open_settings(page)
    page.evaluate("""() => { const i = document.querySelector('#accentCustom'); i.value = '#118833'; i.dispatchEvent(new Event('input', {bubbles: true})); }""")
    page.wait_for_timeout(200)
    check(f"[{label}] a custom colour can be picked and is saved", css().lower() == "#118833" and page.evaluate("localStorage.getItem('ceylon-buildex-accent')") == "#118833", css())
    page.click('#accentSw label[title="Vermilion"]'); page.wait_for_timeout(200)
    check(f"[{label}] Vermilion restores the default", page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--orange').trim()") in ("", "#f4481f", "#ff5a2d"))
    close_settings(page)
    page.goto(page.url.split("#")[0] + "#ask")


def settings_layout(page, label, phone):
    open_settings(page)
    names = page.eval_on_selector_all("#settings legend", "els => els.map(e => e.textContent.trim())")
    check(f"[{label}] Settings holds Search, Appearance and Written answers", names == ["Search", "Appearance", "Written answers"], str(names))
    box = page.evaluate("(() => { const r = document.querySelector('#settings').getBoundingClientRect(); return [r.left, r.right, r.height, innerWidth, innerHeight]; })()")
    check(f"[{label}] Settings fits the screen" + (" as a bottom sheet" if phone else ""), box[0] >= -1 and box[1] <= box[3] + 1 and box[2] <= box[4] + 1, str([round(x) for x in box]))
    page.screenshot(path=str(SHOTS / f"{label}-9a-settings.png"))
    page.keyboard.press("Escape")
    check(f"[{label}] Escape closes Settings", page.locator("#settings[open]").count() == 0)


def settings_flow(page, label):
    page.click(".bar .brand")
    check(f"[{label}] the Settings link shows a dot while no model writes answers", page.locator("#setDot:not(.off)").count() == 1)
    open_settings(page)
    check(f"[{label}] Settings says answers are quoted passages while no model is set", "off" in page.inner_text("#stSaved").lower())
    page.check('input[name="prov"][value="openai"]', force=True)
    page.fill("#stBase", mock.base); page.fill("#stModelO", "mock-model")
    page.screenshot(path=str(SHOTS / f"{label}-9-settings.png"))
    page.click("#stSave"); page.wait_for_selector("#stMsg .notice.ok", timeout=15000)
    check(f"[{label}] settings: save and test succeeds", "Saved." in page.inner_text("#stMsg"), page.inner_text("#stMsg")[:80])
    page.click("#stClose")
    page.wait_for_function("document.querySelector('#setDot').classList.contains('off')", timeout=5000)
    open_settings(page)
    page.wait_for_function("document.querySelector('#stSaved').textContent.includes('mock-model')", timeout=5000)
    check(f"[{label}] the dot clears and Settings names the model", page.locator("#setDot.off").count() == 1 and "mock-model" in page.inner_text("#stSaved"))
    close_settings(page)
    mock.delay = 1.5
    page.evaluate(SEEN_JS)
    ask(page, "How much bid security do the procurement guidelines require?")
    seen = page.evaluate("window.__seen")
    check(f"[{label}] real model wait is shown as 'Writing the answer with mock-model'", "Writing the answer with mock-model" in seen, " | ".join(seen))
    check(f"[{label}] ask now returns a model-written answer", "Mock written answer" in page.inner_text("#results .answer:first-child .prose") and "Written by mock-model" in page.inner_text("#results .answer:first-child .meta"))
    marks = page.eval_on_selector_all("#results .answer:first-child .prose mark.hl", "els => els.map(e => e.textContent.trim())")
    check(f"[{label}] the model's own highlight markers become highlights", marks == ["set out in the cited passage"], str(marks))
    mock.delay = 0
    page.wait_for_timeout(1500)
    page.screenshot(path=str(SHOTS / f"{label}-10-written.png"))
    # back to off, through the UI
    open_settings(page)
    page.check('input[name="prov"][value="off"]', force=True); page.click("#stSave"); page.wait_for_selector("#stMsg .notice.ok", timeout=8000)
    page.click("#stClose")
    page.wait_for_function("!document.querySelector('#setDot').classList.contains('off')", timeout=5000)
    check(f"[{label}] switching answers off works", page.locator("#setDot:not(.off)").count() == 1)


def stream_sync(br, label):
    """Feed /api/ask/stream event by event; the page must show exactly what has happened, and nothing more."""
    gp = GatedProxy(BASE_URL)
    ctx, page, errors = new_page(br, gp.base, {"width": 1280, "height": 860})
    try:
        page.evaluate(SEEN_JS)
        page.fill("#q", "What is the maximum FAR for a 20 perch plot on a 40 ft road?"); page.press("#q", "Enter")
        page.wait_for_selector(".trace")
        check(f"[{label}] before the server says anything: 'Sending your question', nothing marked done", status(page) == "Sending your question" and not any(t.startswith("done") for t in ticks(page)), str(ticks(page)))
        sb = page.locator("#askBtn").bounding_box()
        check(f"[{label}] a Stop button appears while busy", page.get_attribute("#askBtn", "aria-label") == "Stop" and page.get_attribute("#view-ask", "data-busy") == "true" and sb["width"] > 30)
        for _ in range(4):
            page.press("#q", "Enter")
        page.wait_for_timeout(300)
        check(f"[{label}] repeated Enter does not send a second request", gp.requests == 1, f"{gp.requests} request(s)")
        gp.send({"stage": "parse"}); wait_status(page, "Reading your question")
        check(f"[{label}] 'parse' -> Reading your question (Question active)", ticks(page)[0].startswith("active"), str(ticks(page)))
        gp.send({"stage": "far"}); wait_status(page, "Calculating floor area ratio")
        check(f"[{label}] 'far' -> Calculating floor area ratio", True)
        gp.send({"stage": "search", "passages": 340, "documents": 16}); wait_status(page, "Searching 340 passages in 16 documents")
        t = ticks(page)
        check(f"[{label}] 'search' -> Searching 340 passages in 16 documents (Question done, Sources active)", t[0].startswith("done") and t[1].startswith("active") and t[2].startswith("idle"), str(t))
        gp.send({"stage": "found", "passages": 7, "documents": 3, "far": True}); wait_status(page, "Found 7 passages in 3 documents")
        t = ticks(page)
        check(f"[{label}] 'found' -> Found 7 passages in 3 documents (Sources done, Answer not started)", t[1].startswith("done") and "7 passages" in t[1] and t[2].startswith("idle"), str(t))
        page.screenshot(path=str(SHOTS / f"{label}-11-progress-found.png"))
        gp.send({"stage": "write", "mode": "llm", "model": "gated-model"}); wait_status(page, "Writing the answer with gated-model")
        t = ticks(page)
        check(f"[{label}] 'write' -> Writing the answer with gated-model (Answer active)", t[2].startswith("active"), str(t))
        page.wait_for_timeout(7200)
        check(f"[{label}] a long model wait shows a real elapsed counter", re.search(r"gated-model · [6-9] s$", status(page) or "") is not None, status(page))
        check(f"[{label}] still loading, nothing shown as finished before 'done'", page.locator(".trace").count() == 1 and page.locator(".skel").count() == 1 and page.locator("#results .prose").count() == 0)
        page.screenshot(path=str(SHOTS / f"{label}-12-progress-writing.png"))
        cite = {"n": 1, "chunk_id": "c1", "doc_id": "d1", "title": "Gated test document", "page": 3, "heading": "", "url": None, "status": "current", "origin": "full-text", "gazette_no": None, "category": "gazette", "score": 1.0, "text": "A passage."}
        gp.send({"stage": "done", "result": {"answer": "Gated answer [S1].", "mode": "llm", "model": "gated-model", "citations": [cite], "far": None, "far_inputs": None, "far_note": None, "took_ms": 7300}})
        t0 = time.time(); page.wait_for_selector("#results .prose", timeout=3000)
        gone = page.locator(".trace, .skel").count() == 0 and page.get_attribute("#view-ask", "data-busy") == "false"
        check(f"[{label}] the instant 'done' arrives the loaders stop and the answer shows", gone, f"{(time.time() - t0) * 1000:.0f} ms")
        gp.end()
        seen = page.evaluate("window.__seen")
        check(f"[{label}] no status line outside the real vocabulary was ever shown", not real_only(seen), " | ".join(seen))

        # server-reported error
        page.fill("#q", "second question"); page.press("#q", "Enter"); page.wait_for_selector(".trace")
        gp.send({"stage": "parse"}); gp.send({"stage": "error", "message": "RuntimeError: boom"}); gp.end()
        page.wait_for_selector("#results .answer:first-child .errbox", timeout=5000)
        check(f"[{label}] server error event -> error state with the message and Retry", "boom" in page.inner_text(".errbox") and page.locator("[data-retry]").count() == 1 and page.locator(".trace").count() == 0)
        # connection dropped before 'done'
        page.locator("[data-retry]").click(); page.wait_for_selector(".trace")
        gp.send({"stage": "parse"}); gp.end()
        page.wait_for_selector("#results .answer:first-child .errbox", timeout=5000)
        check(f"[{label}] stream ending without 'done' is reported, not shown as success", "closed before" in page.inner_text(".errbox"), page.inner_text(".errbox")[:100].replace("\n", " "))
        # Stop
        page.locator("[data-retry]").click(); page.wait_for_selector(".trace")
        gp.send({"stage": "parse"}); wait_status(page, "Reading your question")
        page.click("#askBtn")
        page.wait_for_selector("#results .answer:first-child .errbox", timeout=5000)
        check(f"[{label}] Stop cancels the request and says so", "stopped" in page.inner_text(".errbox").lower() and page.get_attribute("#view-ask", "data-busy") == "false")
        gp.end()
        # no language model: composed answer
        page.locator("[data-retry]").click(); page.wait_for_selector(".trace")
        gp.send({"stage": "parse"}); gp.send({"stage": "search", "passages": 56, "documents": 16}); gp.send({"stage": "found", "passages": 2, "documents": 1, "far": False})
        gp.send({"stage": "write", "mode": "compose", "model": None}); wait_status(page, "Composing the answer from the passages")
        check(f"[{label}] without a model the page says 'Composing', not 'Writing'", True)
        gp.send({"stage": "done", "result": {"answer": "Composed.", "mode": "extractive", "model": None, "citations": [], "far": None, "far_note": None, "took_ms": 9}}); gp.end()
        page.wait_for_selector("#results .answer:first-child .prose", timeout=5000)
        check(f"[{label}] composed answer is labelled as compiled from the passages", "Compiled from the passages" in page.inner_text("#results .answer:first-child .meta"))
        # empty
        page.fill("#q", "third question"); page.press("#q", "Enter"); page.wait_for_selector(".trace")
        gp.send({"stage": "parse"}); gp.send({"stage": "search", "passages": 56, "documents": 16}); gp.send({"stage": "found", "passages": 0, "documents": 0, "far": False})
        wait_status(page, "No matching passages")
        gp.send({"stage": "done", "result": {"answer": "none", "mode": "none", "model": None, "citations": [], "far": None, "far_note": None, "took_ms": 5}}); gp.end()
        page.wait_for_selector("#results .answer:first-child .empty", timeout=5000)
        check(f"[{label}] 'found 0' is shown as 'No matching passages', then the empty state", page.locator(".trace").count() == 0)
        ib = page.locator("#askBtn").bounding_box()
        check(f"[{label}] the Stop button is hidden again when idle", ib is None or ib["width"] <= 2, str(ib))
        check(f"[{label}] no JavaScript errors during the stream tests", not errors, "; ".join(errors[:3]))
    finally:
        gp.close(); ctx.close()


def a11y(page, label, phone):
    bad = page.evaluate("""() => [...document.querySelectorAll('button, a[href], summary, [role=button]')].filter(e => e.offsetParent !== null)
      .filter(e => !(e.textContent || '').trim() && !e.getAttribute('aria-label') && !e.getAttribute('title')).map(e => e.outerHTML.slice(0, 80))""")
    check(f"[{label}] every icon-only button has an accessible name", not bad, "; ".join(bad[:3]))
    check(f"[{label}] skip link, main landmark and one h1 per view", page.locator("a.skip").count() == 1 and page.locator("main#main").count() == 1 and page.locator(".view.on h1").count() == 1)
    if phone:
        small = page.evaluate("""() => [...document.querySelectorAll('.tabs button, .slot, .send, .icon-btn:not(.clear), .btn, .chip, .seg label span, select, .input')]
          .filter(e => e.offsetParent !== null).map(e => [e.className || e.tagName, e.getBoundingClientRect().height]).filter(x => x[1] < 40).map(x => x[0] + ':' + Math.round(x[1]))""")
        check(f"[{label}] touch targets are at least 40px tall", not small, ", ".join(small[:5]))


def reduced_motion(br, base):
    ctx, page, errors = new_page(br, base, {"width": 1280, "height": 860}, reduced_motion="reduce")
    try:
        d = page.evaluate("getComputedStyle(document.querySelector('.btn')).transitionDuration")
        check("[reduced-motion] transitions are effectively off", d in ("0.001s", "1e-06s", "0s"), d)
        dots = page.evaluate("getComputedStyle(document.querySelector('#ph .dots')).animationName")
        check("[reduced-motion] the dots after the placeholder stay still", dots == "none", dots)
        ask(page, "Parking required for a hotel with 60 rooms on a 9 m road")
        a = page.evaluate("getComputedStyle(document.querySelector('#results .reveal')).animationDuration")
        check("[reduced-motion] reveal animations are effectively off, content still appears", a in ("0.001s", "1e-06s", "0s") and page.locator("#results .prose").count() == 1, a)
        check("[reduced-motion] highlights are painted at once, with no sweep", page.locator("#results .answer:first-child .prose mark.hl").count() >= 1 and marks_painted(page))
        page.click('.tabs button[data-view="library"]'); page.wait_for_selector("#libMatrix .node", timeout=8000); page.wait_for_timeout(300)
        m = page.evaluate("""() => { const s = document.querySelector('#libMatrix svg'); return [s.classList.contains('still'), getComputedStyle(document.querySelector('#libMatrix .e')).animationName, getComputedStyle(document.querySelector('#libMatrix .node')).animationName,
          getComputedStyle(document.querySelector('#libMatrix .e')).strokeDashoffset, [...document.querySelectorAll('#libMatrix .p')].every(p => getComputedStyle(p).display === 'none'), getComputedStyle(document.querySelector('#libMatrix .m')).animationName, getComputedStyle(document.querySelector('#libMatrix .box')).animationName]; }""")
        check("[reduced-motion] the matrix is drawn complete at once: no pop, no drawing, no travelling signals", m[0] and m[1] == "none" and m[2] == "none" and m[3] in ("0px", "0") and m[4] and m[5] == "none" and m[6] == "none", str(m))
        check("[reduced-motion] no JavaScript errors", not errors, "; ".join(errors[:3]))
    finally:
        ctx.close()


def wide_screen(br, base):
    """A big monitor: nothing floats in empty space and everything still lines up with the header."""
    ctx, page, errors = new_page(br, base, {"width": 2000, "height": 980})
    try:
        c = page.evaluate("""() => { const t = document.querySelector('#ph').firstChild, r = document.createRange(); r.selectNodeContents(t); const b = r.getBoundingClientRect(), p = document.querySelector('#view-ask').getBoundingClientRect();
          return {dx: (b.left + b.right) / 2 - innerWidth / 2, dy: (b.top + b.bottom) / 2 - (p.top + p.bottom) / 2, fs: parseFloat(getComputedStyle(document.querySelector('#q')).fontSize)}; }""")
        check("[wide] the start line is centred and no larger than 88px", abs(c["dx"]) <= 3 and abs(c["dy"]) <= 100 and 30 <= c["fs"] <= 88, str(c))
        ask(page, "Parking required for a hotel with 60 rooms on a 9 m road"); page.wait_for_timeout(1800)
        lay = page.evaluate("""() => { const pr = document.querySelector('#results .answer:first-child .prose').getBoundingClientRect(), sb = document.querySelector('#results .srcs').getBoundingClientRect(), tabs = document.querySelector('.tabs').getBoundingClientRect();
          return {gap: Math.round(sb.left - pr.right), right: Math.round(sb.right - tabs.right), z: getComputedStyle(document.documentElement).getPropertyValue('--z').trim(), body: parseFloat(getComputedStyle(document.body).fontSize)}; }""")
        check("[wide] type is fixed (it does not grow with the screen); sources sit beside the answer and line up with the links", lay["body"] == 15 and lay["z"] == "" and lay["gap"] <= 130 and abs(lay["right"]) <= 3, str(lay))
        page.screenshot(path=str(SHOTS / "wide-answer.png"))
        shell_checks(page, "wide", False)
        library_view(page, "wide", False)
        page.screenshot(path=str(SHOTS / "wide-library.png"))
        check("[wide] no JavaScript errors", not errors, "; ".join(errors[:3]))
    finally:
        ctx.close()


def dark_mode(br, base):
    ctx, page, errors = new_page(br, base, {"width": 1280, "height": 860}, color_scheme="dark")
    lum = lambda: (lambda c: sum(c) / 3)([int(x) for x in re.findall(r"\d+", page.evaluate("getComputedStyle(document.body).backgroundColor"))[:3]])  # noqa: E731
    try:
        check("[dark] follows the system dark theme", lum() < 60, str(lum()))
        ask(page, "Parking required for a hotel with 60 rooms on a 9 m road")
        page.wait_for_timeout(1800)
        page.screenshot(path=str(SHOTS / "dark-answer.png"))
        open_settings(page)
        page.click('#settings label:has(input[name="theme"][value="light"])')
        check("[dark] choosing Light in Settings switches the theme and remembers it", lum() > 200 and page.evaluate("localStorage.getItem('ceylon-buildex-theme')") == "light", str(lum()))
        close_settings(page)
        page.reload(wait_until="domcontentloaded"); page.wait_for_function("document.documentElement.dataset.ready === '1'", timeout=15000)
        check("[dark] the chosen theme survives a reload", lum() > 200 and page.locator('#settings input[name="theme"][value="light"]:checked').count() == 1)
        open_settings(page)
        page.click('#settings label:has(input[name="theme"][value="system"])')
        check("[dark] choosing System follows the computer again", lum() < 60, str(lum()))
        close_settings(page)
        check("[dark] no JavaScript errors", not errors, "; ".join(errors[:3]))
    finally:
        ctx.close()


FAKE_DESKTOP = """(() => { const s = {maximized: false, fullscreen: false, focused: true}; let fn = null; window.__wc = [];
  window.cbDesktop = {platform: "win32", minimize() { __wc.push("minimize"); }, close() { __wc.push("close"); },
    maximize() { __wc.push("maximize"); s.maximized = !s.maximized; fn && fn({...s}); }, state: () => Promise.resolve({...s}),
    onState(f) { fn = f; }, theme(d, a) { window.__theme = [d, a]; }, __set(x) { Object.assign(s, x); fn && fn({...s}); }}; })()"""

BAR_JS = """() => { const r = e => e.getBoundingClientRect(), $ = s => document.querySelector(s), b = [...document.querySelectorAll('#winctl .wc')].map(r),
  ctl = r($('#winctl')), tabs = r($('.tabs')), brand = r($('.brand')), bar = r($('.bar')), cs = e => getComputedStyle(e),
  region = e => cs(e).getPropertyValue('app-region') || cs(e).getPropertyValue('-webkit-app-region');
  return {desktop: document.documentElement.classList.contains('desktop'), shown: cs($('#winctl')).display !== 'none', n: b.length,
    sizes: b.map(x => [Math.round(x.width), Math.round(x.height)]), gaps: b.slice(1).map((x, i) => Math.round(x.left - b[i].right)),
    rightGap: Math.round(innerWidth - b[2].right), dyTabs: Math.round((b[0].top + b[0].bottom) / 2 - (tabs.top + tabs.bottom) / 2),
    dyBrand: Math.round((b[0].top + b[0].bottom) / 2 - (brand.top + brand.bottom) / 2), tabsToCtl: Math.round(ctl.left - tabs.right),
    inBar: ctl.top >= bar.top && ctl.bottom <= bar.bottom, barH: Math.round(bar.height),
    drag: region($('.bar')), noDrag: [region($('.brand')), region($('.tabs button')), region($('#winctl .wc'))]}; }"""


def desktop_window(br, base):
    """The page as the desktop program shows it: its top bar is the window's title bar, with minimize / maximize / close in the page's own style."""
    for label, vp, scheme in (("window", {"width": 1280, "height": 860}, "light"), ("window-min", {"width": 820, "height": 560}, "light"),
                              ("window-dark", {"width": 1280, "height": 860}, "dark")):
        ctx = br.new_context(viewport=vp, color_scheme=scheme)
        ctx.add_init_script(FAKE_DESKTOP)
        page = ctx.new_page(); errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(base + "/#ask", wait_until="domcontentloaded")
        page.wait_for_function("document.documentElement.dataset.ready === '1'", timeout=15000)
        page.evaluate("document.fonts.ready.then(() => true)")
        try:
            g = page.evaluate(BAR_JS)
            check(f"[{label}] the window buttons show in the title bar", g["desktop"] and g["shown"] and g["n"] == 3 and g["inBar"], str(g))
            check(f"[{label}] the buttons are 36 px circles, 4 px apart, 12 px from the window edge",
                  all(x == [36, 36] for x in g["sizes"]) and g["gaps"] == [4, 4] and g["rightGap"] == 12, str(g))
            check(f"[{label}] they line up with the links and the wordmark", abs(g["dyTabs"]) <= 1 and abs(g["dyBrand"]) <= 2, str(g))
            check(f"[{label}] the links keep clear of them (at least 24 px)", g["tabsToCtl"] >= 24, str(g))
            check(f"[{label}] the bar drags the window; the wordmark, links and buttons stay clickable",
                  g["drag"] == "drag" and g["noDrag"] == ["no-drag"] * 3, str(g))
            box = page.locator('#winctl .close').bounding_box()
            page.mouse.move(box["x"] + 18, box["y"] + 18); page.wait_for_timeout(250)
            hov = page.evaluate("""() => [getComputedStyle(document.querySelector('#winctl .close')).backgroundColor,
              getComputedStyle(document.documentElement).getPropertyValue('--orange').trim()]""")
            rgb = tuple(int(hov[1][i:i + 2], 16) for i in (1, 3, 5)) if hov[1].startswith("#") else None
            check(f"[{label}] close turns the accent colour on hover", rgb is not None and hov[0] == f"rgb({rgb[0]}, {rgb[1]}, {rgb[2]})", str(hov))
            page.screenshot(path=str(SHOTS / f"{label}-titlebar.png"), clip={"x": 0, "y": 0, "width": vp["width"], "height": 90})
            page.screenshot(path=str(SHOTS / f"{label}.png"))
            page.click('#winctl [data-win="minimize"]'); page.click('#winctl [data-win="maximize"]')
            st = page.evaluate("""() => [document.querySelector('#winMaxUse').getAttribute('href'), document.querySelector('[data-win="maximize"]').getAttribute('aria-label'),
              document.documentElement.classList.contains('win-max')]""")
            check(f"[{label}] minimize and maximize reach the window; maximized shows Restore", page.evaluate("__wc") == ["minimize", "maximize"] and st == ["#i-win-restore", "Restore", True], str(st))
            page.click('#winctl [data-win="maximize"]')
            check(f"[{label}] and restoring swaps it back", page.evaluate("document.querySelector('#winMaxUse').getAttribute('href')") == "#i-win-max")
            page.evaluate("cbDesktop.__set({focused: false})")
            check(f"[{label}] an inactive window dims its buttons", page.evaluate("document.documentElement.classList.contains('win-blur')"))
            page.evaluate("cbDesktop.__set({focused: true})")
            th = page.evaluate("window.__theme")
            check(f"[{label}] the page tells the window its theme and accent", th and th[0] == (scheme == "dark") and re.match(r"^#[0-9a-f]{6}$", th[1] or "", re.I), str(th))
            open_settings(page)
            check(f"[{label}] with a dialog open the bar stops dragging (the dialog gets its clicks)",
                  page.evaluate("(e => getComputedStyle(e).getPropertyValue('app-region') || getComputedStyle(e).getPropertyValue('-webkit-app-region'))(document.querySelector('.bar'))") == "no-drag")
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
        for label, vp, kw in (("desktop", {"width": 1280, "height": 860}, clip), ("phone", {"width": 390, "height": 800}, {"has_touch": True, "is_mobile": True, "device_scale_factor": 2, **clip})):
            ctx, page, errors = new_page(br, BASE_URL, vp, **kw)
            phone = label == "phone"
            basics(page, label, phone)
            typing_fit(page, label)
            ask_compose(page, label)
            ask_far(page, label)
            passages_mode(page, label)
            empty_and_error(page, label, BASE_URL)
            a11y(page, label, phone)
            settings_layout(page, label, phone)
            accent_checks(page, label)
            far_view(page, label, phone)
            library_view(page, label, phone)
            ocr_view(page, label)
            update_view(page, label)
            shell_checks(page, label, phone)
            if not phone:
                settings_flow(page, label)
            check(f"[{label}] no JavaScript errors", not errors, "; ".join(errors[:3]))
            ctx.close()
        stream_sync(br, "desktop")
        desktop_window(br, BASE_URL)
        reduced_motion(br, BASE_URL)
        dark_mode(br, BASE_URL)
        wide_screen(br, BASE_URL)
        br.close()
finally:
    if SERVER:
        SERVER.terminate()
    mock.close()

bad = [r for r in results if not r[1]]
print(f"\n{len(results) - len(bad)}/{len(results)} checks passed; screenshots in {SHOTS}")
sys.exit(1 if bad else 0)
