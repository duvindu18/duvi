// Ask view: the search-first experience.
// The progress shown while a question runs is driven only by events the server really emits on /api/ask/stream
// (parse -> far -> search -> found -> write -> done). Nothing here is timed or simulated.
import {$, $$, esc, fmt, icon, api, md, tags, hl, copyText, toast, announce, reduced, fillCats, farFmt, took, store} from "./util.js";
import {on, emit} from "./state.js";
import {go} from "./router.js";

const PH = "Find the rule...";
const PREF = "ceylon-buildex-search";
const root = $("#view-ask"), form = $("#askForm"), box = $("#q"), field = $("#askField"), mirror = $("#mirror"), clr = $("#qClear"),
  btn = $("#askBtn"), sendTxt = $("#sendTxt"), cat = $("#cat"), results = $("#results"), cur = $("#cur"), curWrap = $("#curWrap");
const st = {busy: false, ctrl: null, mode: "answer", hist: []};
fillCats(cat);
const coarse = () => matchMedia("(pointer: coarse)").matches;
const smooth = () => (reduced() ? "auto" : "smooth");
const plain = t => String(t || "").replace(/==([^=\n]+?)==/g, "$1");

/* ---------- the line you type fills the screen ----------
   A hidden twin of the textarea (same font, same width) is measured to find the largest size at which the text still fits, so the
   words stay as big as the page allows and shrink only as you keep typing. */
let fitRaf = 0;
function fit() { cancelAnimationFrame(fitRaf); fitRaf = requestAnimationFrame(fitNow); }
function fitNow() {
  const w = field.clientWidth;
  if (!w) return;                                   // the view is hidden
  const active = root.dataset.state === "active", LH = 0.94, typed = !!box.value;
  const rr = root.getBoundingClientRect(), fr = field.getBoundingClientRect();
  const room = active ? Math.max(120, rr.bottom - fr.top - 24) : Math.max(120, rr.height - 24);   // idle: the line is centred, so the whole pane is its room
  const small = window.innerWidth < 700;
  // At the start the line is modest and centred: one line for the prompt, a few lines for what you type. Once asked it becomes a compact heading.
  const lines = active ? (small ? 4 : 3) : (typed ? (small ? 6 : 4) : 1);
  const minFs = active ? 24 : (small ? 26 : 30);
  const maxFs = active ? (small ? 34 : 44) : (small ? 56 : 88);   // fixed ceilings: bold capitals in the accent colour, but modest, shrinking only to fit longer questions
  const text = box.value || PH;
  mirror.textContent = text.endsWith("\n") ? text + "\u200b" : text;
  const cap = fs => Math.min(room, fs * LH * lines + fs * 0.1);
  // offsetHeight is the height of the lines themselves; scrollHeight also counts the glyph box of the display face, which is taller than its line
  const fits = fs => { mirror.style.fontSize = fs + "px"; return mirror.offsetHeight <= cap(fs); };
  let best = minFs;
  if (fits(maxFs)) best = maxFs;
  else { let lo = minFs, hi = maxFs - 1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (fits(mid)) { best = mid; lo = mid + 1; } else hi = mid - 1; } }
  mirror.style.fontSize = best + "px";
  const lineH = mirror.offsetHeight, full = mirror.scrollHeight, limit = cap(best), over = lineH > limit + 1;
  root.style.setProperty("--fs", best + "px");
  // the box is as tall as the text's glyph box (so the textarea never scrolls by itself while you type); only too much text scrolls
  box.style.height = Math.ceil(over ? limit + best * 0.3 : full) + "px";
  box.style.overflowY = over ? "auto" : "hidden";
  if (document.activeElement !== box || st.busy) box.scrollTop = 0;   // show the start of a long question, not its tail
}
function syncField() {
  field.classList.toggle("filled", !!box.value);
  clr.hidden = !(root.dataset.state === "active" && box.value && !st.busy);
  fit();
}
function setBusy(b) {
  st.busy = b;
  root.dataset.busy = String(b);
  sendTxt.textContent = b ? "Stop" : "Ask";
  btn.setAttribute("aria-label", b ? "Stop" : "Ask");
  btn.title = b ? "Stop (Esc)" : "Ask (Enter)";
  syncField();
}

/* search preferences live in the settings dialog and are remembered */
function savePrefs() { store.set(PREF, JSON.stringify({mode: st.mode, cat: cat.value, cur: cur.checked})); }
function setMode(m) {
  st.mode = m;
  const r = $(`input[name="mode"][value="${m}"]`); if (r) r.checked = true;
  curWrap.hidden = m !== "passages";
}
try {
  const p = JSON.parse(store.get(PREF) || "{}");
  if (p.mode === "answer" || p.mode === "passages") st.mode = p.mode;
  if (p.cat && [...cat.options].some(o => o.value === p.cat)) cat.value = p.cat;
  cur.checked = !!p.cur;
} catch { /* ignore a damaged preference */ }
setMode(st.mode);
$$('input[name="mode"]').forEach(r => r.addEventListener("change", () => { setMode(r.value); savePrefs(); }));
cat.addEventListener("change", savePrefs);
cur.addEventListener("change", savePrefs);

let shiftDown = false;
document.addEventListener("keydown", e => { if (e.key === "Shift") shiftDown = true; });
document.addEventListener("keyup", e => { if (e.key === "Shift") shiftDown = false; });
box.addEventListener("input", e => {
  // some phone keyboards report Enter only as a line break being inserted
  if (e.inputType === "insertLineBreak" && !shiftDown) { box.value = box.value.replace(/\n+$/, ""); syncField(); if (!st.busy) submit(); return; }
  syncField();
});
box.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!st.busy) submit(); }
});
clr.addEventListener("click", () => { box.value = ""; syncField(); box.focus(); });
form.addEventListener("submit", e => { e.preventDefault(); if (st.busy) stop(); else submit(); });
document.addEventListener("keydown", e => {
  if (e.key !== "Escape" || document.querySelector("dialog[open]")) return;
  if (st.busy) stop();
  else if (document.activeElement === box && box.value) { box.value = ""; syncField(); }
});
window.addEventListener("resize", fit);
if (window.visualViewport) window.visualViewport.addEventListener("resize", fit);
if (window.ResizeObserver) new ResizeObserver(fit).observe(field);
if (document.fonts) { document.fonts.ready.then(fit); document.fonts.addEventListener("loadingdone", fit); }
on("view", e => { if (e.detail === "ask") { fit(); if (!coarse() && root.dataset.state === "idle") box.focus({preventScroll: true}); } });

/* ---------- running a question ---------- */
function stop() { if (st.ctrl) st.ctrl.abort(); }

async function submit(text) {
  if (st.busy) return; // never two requests at once
  const q = (text ?? box.value).trim();
  if (q.length < 3) { toast("Type a few more words"); box.focus(); return; }
  if (text != null) { box.value = text; }
  syncField();
  const mode = st.mode, category = cat.value;
  setBusy(true);
  form.classList.remove("sent"); void form.offsetWidth; form.classList.add("sent");
  root.dataset.state = "active";
  fit();
  $$(".answer", results).forEach(a => setCollapsed(a, true));
  const art = document.createElement("article");
  art.className = "answer"; art.dataset.q = q; art.dataset.mode = mode; art.dataset.cat = category; art.setAttribute("aria-busy", "true");
  art.innerHTML = `<div class="ahead"><h2 class="display">${esc(q)}</h2><button type="button" class="icon-btn fold-btn" aria-label="Collapse" aria-expanded="true">${icon("chev")}</button></div><div class="abody"></div>`;
  results.prepend(art);
  syncClear();
  results.scrollTo({top: 0, behavior: smooth()});
  if (coarse()) box.blur();
  try {
    if (mode === "answer") await runAnswer(q, art, category); else await runPassages(q, art, category);
  } catch (e) {
    showError(art, e);
  } finally {
    art.removeAttribute("aria-busy");
    st.ctrl = null; setBusy(false);
  }
}

/* progress: ticks + one status line. Only ever set from a real event. */
function makeProgress(art, labels) {
  const trace = document.createElement("div");
  trace.className = "trace";
  trace.innerHTML = `<ol class="ticks" style="grid-template-columns:repeat(${labels.length},1fr)">${labels.map(l => `<li>${esc(l)}</li>`).join("")}</ol><div class="status" role="status" aria-live="polite"></div>`;
  const body = $(".abody", art);
  body.replaceChildren(trace);
  body.insertAdjacentHTML("beforeend", `<div class="skel flat" aria-hidden="true"><i class="sk w90"></i><i class="sk"></i><i class="sk w75"></i><i class="sk w50"></i></div>`);
  const lis = $$("li", trace), statusEl = $(".status", trace);
  let timer = null;
  const say = t => { const p = document.createElement("p"); p.className = "st-in"; p.textContent = t; statusEl.replaceChildren(p); };
  return {
    step(i, text) { lis.forEach((li, k) => { li.classList.toggle("done", k < i); li.classList.toggle("active", k === i); }); say(text); },
    plain(text) { lis.forEach(li => li.classList.remove("active", "done")); say(text); },
    mark(i, label) { lis[i].classList.add("done"); lis[i].classList.remove("active"); if (label) lis[i].textContent = label; },
    note: say,
    // A real elapsed-time counter for a long step (a model on this computer can take a minute).
    timed(base, after = 6) {
      clearInterval(timer);
      const t0 = performance.now();
      timer = setInterval(() => { const s = Math.floor((performance.now() - t0) / 1000); const p = $("p", statusEl); if (p && s >= after) p.textContent = `${base} · ${s} s`; }, 1000);
    },
    stop() { clearInterval(timer); },
  };
}

// Reads newline-delimited JSON. `handle` may return "end" (after done/error) to stop at once instead of waiting for the connection to close.
async function readNdjson(res, handle, noStream) {
  let over = false;
  const parse = line => { if (over) return; let ev; try { ev = JSON.parse(line); } catch { return; } if (handle(ev) === "end") over = true; };
  if (!res.body || !res.body.getReader) { noStream(); (await res.text()).split("\n").forEach(l => l.trim() && parse(l)); return; }
  const rd = res.body.getReader(), dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const {done, value} = await rd.read();
    if (done) break;
    buf += dec.decode(value, {stream: true});
    let i;
    while (!over && (i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) parse(l); }
    if (over) { rd.cancel().catch(() => {}); return; }
  }
  buf += dec.decode();
  if (buf.trim()) parse(buf.trim());
}

async function runAnswer(q, art, category) {
  const ctrl = st.ctrl = new AbortController();
  const prog = makeProgress(art, ["Question", "Sources", "Answer"]);
  prog.step(0, "Sending your question");
  try {
    const res = await fetch("/api/ask/stream", {method: "POST", headers: {"content-type": "application/json"}, signal: ctrl.signal,
      body: JSON.stringify({question: q, category, history: st.hist.slice(-4)})});
    if (!res.ok) { let j = null; try { j = await res.json(); } catch { /* not JSON */ } throw new Error((j && j.error) || `Request failed (${res.status})`); }
    let result = null, failure = null;
    await readNdjson(res, ev => {
      switch (ev.stage) {
        case "parse": prog.step(0, "Reading your question"); break;
        case "far": prog.step(0, "Calculating floor area ratio"); break;
        case "search":
          prog.mark(0);
          prog.step(1, `Searching ${fmt(ev.passages, 0)} passages in ${fmt(ev.documents, 0)} documents`); break;
        case "found":
          prog.mark(1, ev.passages ? `${ev.passages} passage${ev.passages === 1 ? "" : "s"}` : "No match");
          prog.note(ev.passages
            ? `Found ${ev.passages} passage${ev.passages === 1 ? "" : "s"} in ${ev.documents} document${ev.documents === 1 ? "" : "s"}`
            : (ev.far ? "Floor area calculated; no matching passages" : "No matching passages")); break;
        case "write": {
          const t = ev.mode === "llm" ? `Writing the answer with ${ev.model}` : "Composing the answer from the passages";
          prog.step(2, t); if (ev.mode === "llm") prog.timed(t); break;
        }
        case "done": result = ev.result; return "end";
        case "error": failure = ev.message; return "end";
      }
    }, () => prog.plain("Working on your question"));
    if (failure) throw new Error(failure);
    if (!result) throw new Error("The connection closed before the answer was finished.");
    prog.stop();
    finishAnswer(art, q, result);
  } finally { prog.stop(); }
}

async function runPassages(q, art, category) {
  const ctrl = st.ctrl = new AbortController();
  const prog = makeProgress(art, ["Search"]);
  prog.step(0, "Searching the passages");
  const j = await api(`/api/search?q=${encodeURIComponent(q)}&category=${encodeURIComponent(category)}&limit=20${cur.checked ? "&current=1" : ""}`, {signal: ctrl.signal});
  const hits = j.results || [];
  if (!hits.length) { setBody(art, emptyHTML(art)); announce("No passages found"); return; }
  const docs = new Set(hits.map(h => h.doc_id)).size;
  let i = 0;
  setBody(art, `<div class="meta reveal" style="--i:0"><span>${hits.length} passage${hits.length === 1 ? "" : "s"}</span><span>${docs} document${docs === 1 ? "" : "s"}</span></div>
    <ul class="hits">${hits.map(r => `<li class="hit reveal" style="--i:${++i}"><h3>${esc(r.title)}</h3>
      <div class="m"><span>Page ${esc(r.page)}</span>${r.heading ? `<span>${esc(r.heading.slice(0, 80))}</span>` : ""}${r.gazette_no ? `<span>Gazette ${esc(r.gazette_no)}</span>` : ""}${tags(r)}</div>
      <p>${hl(r.text.slice(0, 520), q)}${r.text.length > 520 ? "…" : ""}</p>
      <button type="button" class="link" data-doc="${esc(r.doc_id)}" data-page="${esc(r.page)}">Read in context</button></li>`).join("")}</ul>`);
  announce(`${hits.length} passages found`);
}

/* ---------- rendering results ---------- */
function setBody(art, html) { $(".abody", art).innerHTML = html; }
function setCollapsed(a, on_) {
  a.classList.toggle("collapsed", on_);
  const b = $(".fold-btn", a); if (b) { b.setAttribute("aria-expanded", String(!on_)); b.setAttribute("aria-label", on_ ? "Expand" : "Collapse"); }
}

function emptyHTML(art) {
  const filtered = art.dataset.cat && art.dataset.cat !== "all", ans = art.dataset.mode === "answer";
  const acts = [];
  if (filtered) acts.push(`<button type="button" data-switch="all">Search all sources</button>`);
  if (ans) acts.push(`<button type="button" data-switch="passages">Try passages</button>`);
  acts.push(`<button type="button" data-edit>Edit question</button>`, `<button type="button" data-switch="update">Update library</button>`);
  return `<div class="empty reveal"><svg class="art" viewBox="0 0 120 44" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 32h108M6 25v14M114 25v14"/><rect x="30" y="6" width="60" height="14" rx="3" stroke-dasharray="3 5"/></svg>
    <h3 class="display">Nothing on record for that</h3>
    <p class="muted">Try different words${filtered ? " or search all sources" : ""}.</p>
    <div class="actions">${acts.map((a, i) => a.replace("<button ", `<button class="btn ${i ? "quiet" : ""}" `)).join("")}</div></div>`;
}

function errText(e) {
  const m = String((e && e.message) || e);
  return /Failed to fetch|NetworkError|Load failed/i.test(m) ? "Can't reach the server. Check that it is still running, then retry." : m;
}
function showError(art, e) {
  const aborted = e && e.name === "AbortError";
  const msg = errText(e);
  setBody(art, aborted
    ? `<div class="errbox reveal"><h3 class="display">Stopped</h3><p class="muted">You stopped this before it finished.</p><div class="actions"><button type="button" class="btn" data-retry>${icon("refresh")}Ask again</button><button type="button" class="btn quiet" data-edit>Edit question</button></div></div>`
    : `<div class="errbox reveal" role="alert"><h3 class="display">${art.dataset.mode === "answer" ? "Couldn't get an answer" : "Search failed"}</h3><p class="muted">${esc(msg)}</p><div class="actions"><button type="button" class="btn" data-retry>${icon("refresh")}Retry</button><button type="button" class="btn quiet" data-edit>Edit question</button></div></div>`);
  announce(aborted ? "Stopped" : "Error: " + msg);
}

function farBox(far, inputs, rv) {
  const f = far.far;
  const num = f.unlimited ? "Unlimited" : farFmt(f.value);
  return `<div ${rv("faro")}><div><div class="k">Permissible FAR</div><div class="n"><mark>${esc(num)}</mark></div></div>
    ${far.max_gfa_m2 != null ? `<div><div class="k">Max floor area</div><div class="n2">${fmt(far.max_gfa_m2, 0)} m²<small>on ${fmt(far.inputs.net_area_m2, 1)} m² net</small></div></div>` : ""}
    <p class="small muted grow">${esc(f.basis)}</p>
    <button type="button" class="btn sm" data-far-open="${esc(JSON.stringify(inputs || {}))}">${icon("ruler", "sm")}Open in calculator</button></div>`;
}

function answerHTML(r) {
  const cites = r.citations || [];
  let i = 0;
  const rv = (cls = "") => `class="${cls} reveal" style="--i:${i++}"`;
  const bits = [];
  if (cites.length) bits.push(`${cites.length} source${cites.length === 1 ? "" : "s"}`);
  bits.push(r.mode === "llm" ? `Written by ${esc(r.model)}` : "Compiled from the passages");
  bits.push(took(r.took_ms));
  const srcs = cites.map(c => `<li ${rv("src")} data-n="${c.n}" data-status="${esc(c.status || "")}">
      <div class="row"><button type="button" class="main" data-doc="${esc(c.doc_id)}" data-page="${esc(c.page)}"><span class="t"><span class="n">${c.n}</span>${esc(c.title)}</span>
        <span class="m">Page ${esc(c.page)}${c.gazette_no ? " · Gazette " + esc(c.gazette_no) : ""}</span><span class="m tg">${tags(c)}</span></button>
        <button type="button" class="peek" aria-expanded="false" aria-label="Show excerpt from source ${c.n}">${icon("chev", "sm")}</button></div>
      <p class="snip" hidden>${esc(c.text.slice(0, 280))}${c.text.length > 280 ? "…" : ""}</p></li>`).join("");
  const farHint = r.far_note && /looks like a FAR question/.test(r.far_note);
  return `<div ${rv("meta")}>${bits.map(b => `<span>${b}</span>`).join("")}</div>
    ${r.llm_error ? `<div ${rv("notice")} role="alert">${icon("alert")}<div>The language model didn't answer (${esc(r.llm_error)}). Showing the closest passages. <button type="button" class="link" data-settings>Check settings</button></div></div>` : ""}
    ${r.far ? farBox(r.far, r.far_inputs, rv) : ""}
    <div class="cols${cites.length ? "" : " solo"}">
      <div ${rv("prose" + (plain((r.answer || "").split(/\n{2,}/)[0]).length > 240 ? " long" : ""))}>${md(r.answer, cites)}</div>
      ${cites.length ? `<aside class="srcs" aria-label="Sources"><h3>Sources</h3><ul class="srclist">${srcs}</ul></aside>` : ""}
    </div>
    <div class="actions" style="margin-top:14px"><button type="button" class="chip" data-copy>${icon("copy", "sm")}Copy answer</button>${farHint ? `<button type="button" class="chip" data-goto="far">${icon("ruler", "sm")}Open the FAR calculator</button>` : ""}</div>`;
}

function finishAnswer(art, q, r) {
  if (r.mode === "none") { setBody(art, emptyHTML(art)); announce("Nothing on record for that question"); return; }
  art._result = r;
  setBody(art, answerHTML(r));
  st.hist.push({role: "user", content: q}, {role: "assistant", content: plain(r.answer).slice(0, 700)});
  announce(`Answer ready, ${(r.citations || []).length} sources`);
}

function syncClear() {
  let row = $("#clearRow");
  const n = $$(".answer", results).length;
  if (n < 2) { if (row) row.remove(); return; }
  if (!row) { row = document.createElement("p"); row.id = "clearRow"; row.className = "small"; row.style.marginTop = "12px"; row.innerHTML = `<button type="button" class="link" data-clear>Clear history</button>`; results.append(row); }
}

/* ---------- interactions inside results ---------- */
results.addEventListener("click", e => {
  const t = e.target;
  const art = t.closest(".answer");
  const cite = t.closest(".cite");
  if (cite && art) {
    const li = $(`.src[data-n="${cite.dataset.cite}"]`, art);
    if (li) {
      const pk = $(".peek", li); pk.setAttribute("aria-expanded", "true"); $(".snip", li).hidden = false;
      li.scrollIntoView({block: "nearest", behavior: smooth()});
      li.classList.add("flash"); setTimeout(() => li.classList.remove("flash"), 1500);
    }
    return;
  }
  const pk = t.closest(".peek");
  if (pk) { const open = pk.getAttribute("aria-expanded") !== "true"; pk.setAttribute("aria-expanded", String(open)); $(".snip", pk.closest(".src")).hidden = !open; return; }
  const fb = t.closest(".fold-btn");
  if (fb && art) { setCollapsed(art, !art.classList.contains("collapsed")); return; }
  if (art && art.classList.contains("collapsed") && t.closest(".ahead")) { setCollapsed(art, false); return; }
  const rt = t.closest("[data-retry]");
  if ((rt || t.closest("[data-switch]")) && st.busy) { toast("Wait for the current question to finish"); return; }
  if (rt && art) { setMode(art.dataset.mode); cat.value = art.dataset.cat; art.remove(); syncClear(); submit(art.dataset.q); return; }
  const ed = t.closest("[data-edit]");
  if (ed && art) { box.value = art.dataset.q; syncField(); box.focus(); box.setSelectionRange(box.value.length, box.value.length); results.scrollTo({top: 0, behavior: smooth()}); return; }
  const sw = t.closest("[data-switch]");
  if (sw && art) {
    const k = sw.dataset.switch;
    if (k === "update") { go("update"); return; }
    if (k === "all") { cat.value = "all"; savePrefs(); }
    if (k === "passages") { setMode("passages"); savePrefs(); }
    const q = art.dataset.q; art.remove(); syncClear(); submit(q); return;
  }
  const fo = t.closest("[data-far-open]");
  if (fo) { try { emit("far:fill", JSON.parse(fo.dataset.farOpen)); } catch { /* ignore */ } go("far"); return; }
  if (t.closest("[data-copy]") && art && art._result) {
    const r = art._result, cites = r.citations || [];
    const text = `${art.dataset.q}\n\n${plain(r.answer).replace(/\*\*(.+?)\*\*/g, "$1").replace(/\[S(\d+)\]/g, "[$1]")}\n\n${cites.length ? "Sources:\n" + cites.map(c => `[${c.n}] ${c.title}, page ${c.page}`).join("\n") : ""}`.trim();
    copyText(text).then(ok => toast(ok ? "Copied" : "Couldn't copy"));
    return;
  }
  if (t.closest("[data-clear]")) { results.replaceChildren(); st.hist = []; root.dataset.state = "idle"; syncField(); box.focus(); }
});

/* ---------- reacting to other views ---------- */
on("ask:prefill", e => {
  const {text, mode, run} = e.detail || {};
  if (mode) setMode(mode);
  box.value = text || ""; syncField();
  if (run) submit(); else { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
});

syncField();
