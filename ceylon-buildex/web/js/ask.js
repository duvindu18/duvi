// Ask view: a conversation. Each question becomes a turn: your words on the right, then the assistant thinking out loud, then the answer.
// The thinking steps come only from events the server really emits on /api/ask/stream (parse -> far -> search -> found -> write -> done);
// each step stays on screen for a short beat so the sequence reads smoothly, and "Thought for" reports the real time the work took.
import {$, $$, esc, fmt, icon, api, md, tags, hl, copyText, toast, announce, reduced, fillCats, farFmt, took, store, CATS} from "./util.js";
import {on, emit} from "./state.js";
import {go} from "./router.js";

const PREF = "ceylon-buildex-search";
const root = $("#view-ask"), form = $("#askForm"), box = $("#q"), btn = $("#askBtn"), sendUse = $("#sendUse"), cat = $("#cat"),
  thread = $("#results"), turns = $("#turns"), cur = $("#cur"), curWrap = $("#curWrap");
const st = {busy: false, ctrl: null, mode: "answer", hist: []};
const BEAT = () => (reduced() ? 0 : 460);              // how long each thinking step stays before the next one replaces it
const sleep = ms => new Promise(r => setTimeout(r, ms));
const smooth = () => (reduced() ? "auto" : "smooth");
const coarse = () => matchMedia("(pointer: coarse)").matches;
const plain = t => String(t || "").replace(/==([^=\n]+?)==/g, "$1");
const plural = (n, w) => `${fmt(n, 0)} ${w}${n === 1 ? "" : "s"}`;
const secs = ms => (ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`);
fillCats(cat);
cat.options[0].textContent = "All sources";

/* ---------- example questions on the empty page ---------- */
const SUGGEST = [
  {t: "Floor area ratio", i: "ruler", q: "What is the maximum FAR for a 20 perch plot on a 40 ft road in the Colombo Mixed Development zone?"},
  {t: "Bid security", i: "book", q: "How much bid security do the procurement guidelines require?"},
  {t: "Open spaces", i: "layers", q: "What rear space is required for a building on a 6 m road?"},
  {t: "Gazette 2235/54", i: "chat", q: "What does Gazette 2235/54 set out for planning and building regulations?"},
];
$("#suggest").innerHTML = SUGGEST.map((s, i) => `<button type="button" class="sug" data-sug="${i}">${icon(s.i)}<span><b>${esc(s.t)}</b>${esc(s.q)}</span></button>`).join("");
$("#suggest").addEventListener("click", e => { const b = e.target.closest("[data-sug]"); if (b) submit(SUGGEST[+b.dataset.sug].q); });

/* ---------- the question box ---------- */
function grow() {
  box.style.height = "auto";
  box.style.height = Math.min(box.scrollHeight, 220) + "px";
  btn.disabled = !st.busy && box.value.trim().length === 0;
}
function setBusy(b) {
  st.busy = b;
  root.dataset.busy = String(b);
  sendUse.setAttribute("href", b ? "#i-stop" : "#i-up");
  btn.setAttribute("aria-label", b ? "Stop" : "Ask");
  btn.title = b ? "Stop (Esc)" : "Ask (Enter)";
  grow();
}
/* the box glides from the middle of the page to the bottom (and back) instead of jumping */
function setState(s) {
  if (root.dataset.state === s) return;
  const before = form.getBoundingClientRect().top;
  root.dataset.state = s;
  const dy = before - form.getBoundingClientRect().top;
  if (dy && !reduced() && form.animate) form.animate([{transform: `translateY(${dy}px)`}, {transform: "none"}], {duration: 560, easing: "cubic-bezier(.2,.7,.2,1)"});
}

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
  if (e.inputType === "insertLineBreak" && !shiftDown) { box.value = box.value.replace(/\n+$/, ""); grow(); if (!st.busy) submit(); return; }
  grow();
});
box.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!st.busy) submit(); } });
form.addEventListener("submit", e => { e.preventDefault(); if (st.busy) stop(); else submit(); });
document.addEventListener("keydown", e => {
  if (e.key !== "Escape" || document.querySelector("dialog[open]")) return;
  if (st.busy) stop();
  else if (document.activeElement === box && box.value) { box.value = ""; grow(); }
});
$("#attachBtn").addEventListener("click", () => { go("ocr"); $("#file").click(); });
on("view", e => { if (e.detail === "ask" && !coarse()) box.focus({preventScroll: true}); });

/* ---------- a new conversation ---------- */
export function newQuestion() {
  if (st.busy) stop();
  turns.replaceChildren(); st.hist = [];
  setState("idle");
  box.value = ""; grow();
  go("ask");
  box.focus();
}
on("ask:new", newQuestion);

/* ---------- running a question ---------- */
function stop() { if (st.ctrl) st.ctrl.abort(); }

async function submit(text) {
  if (st.busy) return;                                // never two requests at once
  const q = String(text ?? box.value).trim();
  if (q.length < 3) { toast("Type a few more words"); box.focus(); return; }
  const mode = st.mode, category = cat.value;
  box.value = ""; setBusy(true);
  setState("active");
  const art = document.createElement("article");
  art.className = "turn"; art.dataset.q = q; art.dataset.mode = mode; art.dataset.cat = category; art.setAttribute("aria-busy", "true");
  art.innerHTML = `<div class="ubub">${esc(q)}</div>
    <div class="reply"><span class="orb sm live" aria-hidden="true"></span><div class="rbody">
      <div class="think" data-state="running"><button type="button" class="think-h" aria-expanded="true"><span class="think-t shim">Thinking</span><span class="think-time"></span>${icon("chev")}</button>
        <div class="steps-w"><div><ol class="steps" aria-live="polite"></ol></div></div></div>
      <div class="abody"></div></div></div>`;
  turns.append(art);
  emit("ask:asked", q);
  follow(true);
  if (coarse()) box.blur();
  const th = thinker(art);
  try {
    if (mode === "answer") await runAnswer(q, art, category, th); else await runPassages(q, art, category, th);
  } catch (e) {
    await th.finish(false, e && e.name === "AbortError" ? "Stopped" : "Something went wrong");
    showError(art, e);
  } finally {
    art.removeAttribute("aria-busy");
    st.ctrl = null; setBusy(false);
  }
}

/* keep the newest step in view while the assistant is thinking, unless you scrolled up to read */
function follow(force) {
  const near = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 160;
  if (force || near) thread.scrollTo({top: thread.scrollHeight, behavior: smooth()});
}

/* the thinking panel: one step per real event, each held for a short beat; the header shows the real elapsed time */
function thinker(art) {
  const th = $(".think", art), ol = $(".steps", art), head = $(".think-t", art), time = $(".think-time", art), orb = $(".reply>.orb", art);
  const t0 = performance.now();
  let chain = Promise.resolve(), cur = null, ended = 0, live = null, dead = false;
  const wait = document.createElement("li");
  wait.className = "step wait"; wait.innerHTML = `<span class="knot" aria-hidden="true"><i></i><i></i><i></i></span><p class="st">Working</p>`;
  ol.append(wait);
  const clock = setInterval(() => { time.textContent = "· " + secs(performance.now() - t0); }, 100);
  const now = (title, detail, chips) => {
    if (dead) return;                                 // stopped or failed: steps still queued are dropped
    if (cur) { cur.classList.remove("active"); cur.classList.add("done"); }
    clearInterval(live);
    const li = document.createElement("li");
    li.className = "step active";
    li.innerHTML = `<span class="knot" aria-hidden="true"></span><div><p class="st">${esc(title)}</p>${detail ? `<p class="sd">${detail}</p>` : ""}${chips && chips.length ? `<div class="schips">${chips.map((c, i) => `<span class="schip" style="--i:${i}" title="${esc(c)}">${esc(c)}</span>`).join("")}</div>` : ""}</div>`;
    ol.insertBefore(li, wait);
    cur = li;
    follow(false);
  };
  return {
    step(title, detail, chips) { chain = chain.then(() => { now(title, detail, chips); return sleep(BEAT()); }); return chain; },
    // a long step (a model on this computer can take a minute) shows a real elapsed counter in its detail line
    timed(base) {
      chain = chain.then(() => {
        const t = performance.now(), sd = cur && $(".sd", cur);
        if (!sd) return;
        live = setInterval(() => { const s = Math.floor((performance.now() - t) / 1000); if (s >= 4) sd.innerHTML = `${base} · ${s} s`; }, 1000);
      });
    },
    async finish(ok, label) {
      if (!ended) ended = performance.now();
      if (ok) await chain; else dead = true;
      clearInterval(clock); clearInterval(live);
      if (cur) { cur.classList.remove("active"); cur.classList.add(ok ? "done" : "bad"); }
      wait.remove();
      orb.classList.remove("live");
      head.classList.remove("shim");
      th.dataset.state = ok ? "done" : "error";
      head.textContent = ok ? "Thought for" : label;
      time.textContent = ok ? secs(ended - t0) : "";
      if (ok) { await sleep(reduced() ? 0 : 180); fold(th, true); }
    },
    mark() { if (!ended) ended = performance.now(); },
  };
}
function fold(th, shut) { th.classList.toggle("shut", shut); $(".think-h", th).setAttribute("aria-expanded", String(!shut)); }

// Reads newline-delimited JSON. `handle` may return "end" (after done/error) to stop at once instead of waiting for the connection to close.
async function readNdjson(res, handle) {
  let over = false;
  const parse = line => { if (over) return; let ev; try { ev = JSON.parse(line); } catch { return; } if (handle(ev) === "end") over = true; };
  if (!res.body || !res.body.getReader) { (await res.text()).split("\n").forEach(l => l.trim() && parse(l)); return; }
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

async function runAnswer(q, art, category, th) {
  const ctrl = st.ctrl = new AbortController();
  const res = await fetch("/api/ask/stream", {method: "POST", headers: {"content-type": "application/json"}, signal: ctrl.signal,
    body: JSON.stringify({question: q, category, history: st.hist.slice(-4)})});
  if (!res.ok) { let j = null; try { j = await res.json(); } catch { /* not JSON */ } throw new Error((j && j.error) || `Request failed (${res.status})`); }
  let result = null, failure = null;
  await readNdjson(res, ev => {
    switch (ev.stage) {
      case "parse": th.step("Reading your question"); break;
      case "far": th.step("Calculating the floor area ratio", "Running the floor area rules on the figures in your question"); break;
      case "search": th.step("Searching the library", `${plural(ev.passages, "passage")} in ${plural(ev.documents, "document")}`); break;
      case "found":
        th.step(ev.passages ? `Found ${plural(ev.passages, "passage")}` : "No matching passages",
          ev.passages ? `in ${plural(ev.documents, "document")}` : (ev.far ? "The floor area was calculated from the rules" : "Nothing in the library matches these words"),
          ev.titles || []); break;
      case "write":
        if (ev.mode === "llm") { th.step("Writing the answer", `with <b>${esc(ev.model)}</b>`); th.timed(`with <b>${esc(ev.model)}</b>`); }
        else th.step("Composing the answer", "Quoting the passages that match, with citations");
        break;
      case "done": th.mark(); result = ev.result; return "end";
      case "error": th.mark(); failure = ev.message; return "end";
    }
  });
  if (failure) throw new Error(failure);
  if (!result) throw new Error("The connection closed before the answer was finished.");
  await th.finish(true);
  finishAnswer(art, q, result);
}

async function runPassages(q, art, category, th) {
  const ctrl = st.ctrl = new AbortController();
  th.step("Searching the passages", category && category !== "all" ? esc((CATS.find(c => c[0] === category) || [0, category])[1]) : "Across every source");
  const j = await api(`/api/search?q=${encodeURIComponent(q)}&category=${encodeURIComponent(category)}&limit=20${cur.checked ? "&current=1" : ""}`, {signal: ctrl.signal});
  const hits = j.results || [], titles = [...new Set(hits.map(h => h.title))];
  th.mark();
  th.step(hits.length ? `Found ${plural(hits.length, "passage")}` : "No matching passages", hits.length ? `in ${plural(titles.length, "document")}` : "Nothing in the library matches these words", titles.slice(0, 6));
  await th.finish(true);
  if (!hits.length) { setBody(art, emptyHTML(art)); announce("No passages found"); return; }
  let i = 0;
  setBody(art, `<ul class="hits">${hits.map(r => `<li class="hit reveal" style="--i:${i++}"><h3>${esc(r.title)}</h3>
      <div class="m"><span>Page ${esc(r.page)}</span>${r.heading ? `<span>${esc(r.heading.slice(0, 80))}</span>` : ""}${r.gazette_no ? `<span>Gazette ${esc(r.gazette_no)}</span>` : ""}${tags(r)}</div>
      <p>${hl(r.text.slice(0, 520), q)}${r.text.length > 520 ? "…" : ""}</p>
      <button type="button" class="link" data-doc="${esc(r.doc_id)}" data-page="${esc(r.page)}">Read in context</button></li>`).join("")}</ul>
    ${actionsHTML([`${plural(hits.length, "passage")}`, `${plural(titles.length, "document")}`])}`);
  announce(`${hits.length} passages found`);
}

/* ---------- rendering results ---------- */
function setBody(art, html) { $(".abody", art).innerHTML = html; }

function actionsHTML(info, extra = "") {
  return `<div class="ameta reveal" style="--i:12">
    <button type="button" class="ract" data-copy aria-label="Copy" title="Copy">${icon("copy")}</button>
    <button type="button" class="ract" data-retry aria-label="Ask again" title="Ask again">${icon("refresh")}</button>
    <button type="button" class="ract" data-edit aria-label="Edit the question" title="Edit the question">${icon("pen")}</button>${extra}
    <div class="info">${info.map(b => `<span>${b}</span>`).join("")}</div></div>`;
}

function emptyHTML(art) {
  const filtered = art.dataset.cat && art.dataset.cat !== "all", ans = art.dataset.mode === "answer";
  const acts = [];
  if (filtered) acts.push(`<button type="button" data-switch="all">Search all sources</button>`);
  if (ans) acts.push(`<button type="button" data-switch="passages">Show passages</button>`);
  acts.push(`<button type="button" data-edit>Edit question</button>`, `<button type="button" data-switch="update">Update the library</button>`);
  return `<div class="empty reveal"><h3>Nothing on record for that</h3>
    <p class="muted">The library has no passage that answers this. Try other words${filtered ? " or search all sources" : ""}.</p>
    <div class="actions">${acts.map((a, i) => a.replace("<button ", `<button class="btn sm ${i ? "quiet" : ""}" `)).join("")}</div></div>`;
}

function errText(e) {
  const m = String((e && e.message) || e);
  return /Failed to fetch|NetworkError|Load failed/i.test(m) ? "Can't reach the server. Check that it is still running, then retry." : m;
}
function showError(art, e) {
  const aborted = e && e.name === "AbortError", msg = errText(e);
  setBody(art, aborted
    ? `<div class="empty reveal"><h3>Stopped</h3><p class="muted">You stopped this before it finished.</p><div class="actions"><button type="button" class="btn sm" data-retry>${icon("refresh", "sm")}Ask again</button><button type="button" class="btn sm quiet" data-edit>Edit question</button></div></div>`
    : `<div class="errbox reveal" role="alert"><h3>${art.dataset.mode === "answer" ? "Couldn't get an answer" : "Search failed"}</h3><p class="muted">${esc(msg)}</p><div class="actions"><button type="button" class="btn sm" data-retry>${icon("refresh", "sm")}Retry</button><button type="button" class="btn sm quiet" data-edit>Edit question</button></div></div>`);
  announce(aborted ? "Stopped" : "Error: " + msg);
}

function farBox(far, inputs) {
  const f = far.far, num = f.unlimited ? "Unlimited" : farFmt(f.value);
  return `<div class="faro reveal" style="--i:0"><div><div class="k">Permissible FAR</div><div class="n"><mark>${esc(num)}</mark></div></div>
    ${far.max_gfa_m2 != null ? `<div><div class="k">Max floor area</div><div class="n2">${fmt(far.max_gfa_m2, 0)} m²<small>on ${fmt(far.inputs.net_area_m2, 1)} m² net site</small></div></div>` : ""}
    <p class="small muted grow">${esc(f.basis)}</p>
    <button type="button" class="btn sm quiet" data-far-open="${esc(JSON.stringify(inputs || {}))}">${icon("ruler", "sm")}Open in calculator</button></div>`;
}

function answerHTML(r) {
  const cites = r.citations || [];
  const srcs = cites.map((c, i) => `<li class="src reveal" style="--i:${4 + Math.min(i, 6)}" data-n="${c.n}" data-status="${esc(c.status || "")}">
      <button type="button" class="main" data-doc="${esc(c.doc_id)}" data-page="${esc(c.page)}"><span class="t"><span class="n">${c.n}</span><span>${esc(c.title)}</span></span>
        <span class="m">Page ${esc(c.page)}${c.gazette_no ? " · Gazette " + esc(c.gazette_no) : ""}</span><span class="m tg">${tags(c)}</span></button>
      <button type="button" class="peek" aria-expanded="false" aria-label="Show the excerpt from source ${c.n}">${icon("chev")}</button>
      <p class="snip" hidden>${esc(c.text.slice(0, 280))}${c.text.length > 280 ? "…" : ""}</p></li>`).join("");
  const farHint = r.far_note && /looks like a FAR question/.test(r.far_note);
  const info = [r.mode === "llm" ? `Written by ${esc(r.model)}` : "Compiled from the passages", ...(cites.length ? [plural(cites.length, "source")] : []), took(r.took_ms)];
  return `${r.llm_error ? `<div class="notice reveal" role="alert" style="margin-bottom:12px">${icon("alert")}<div>The language model didn't answer (${esc(r.llm_error)}). Showing the closest passages. <button type="button" class="link" data-settings>Check settings</button></div></div>` : ""}
    ${r.far ? farBox(r.far, r.far_inputs) : ""}
    <div class="prose">${md(r.answer, cites)}</div>
    ${cites.length ? `<section class="srcs" aria-label="Sources"><h3>Sources <span>${cites.length}</span></h3><ul class="srclist">${srcs}</ul></section>` : ""}
    ${actionsHTML(info, farHint ? `<button type="button" class="ract" data-goto="far" aria-label="Open the floor area calculator" title="Open the floor area calculator">${icon("ruler")}</button>` : "")}`;
}

function finishAnswer(art, q, r) {
  if (r.mode === "none") { setBody(art, emptyHTML(art)); announce("Nothing on record for that question"); return; }
  art._result = r;
  setBody(art, answerHTML(r));
  // the answer appears paragraph by paragraph
  $$(".prose > *", art).forEach((el, i) => { el.classList.add("reveal"); el.style.setProperty("--i", String(1 + Math.min(i, 8))); });
  st.hist.push({role: "user", content: q}, {role: "assistant", content: plain(r.answer).slice(0, 700)});
  const top = art.offsetTop - 12;
  if (art.offsetHeight > thread.clientHeight) thread.scrollTo({top, behavior: smooth()}); else follow(true);
  announce(`Answer ready, ${(r.citations || []).length} sources`);
}

/* ---------- interactions inside the conversation ---------- */
turns.addEventListener("click", e => {
  const t = e.target, art = t.closest(".turn");
  const th = t.closest(".think-h");
  if (th) { const box_ = th.closest(".think"); if (box_.dataset.state !== "running") fold(box_, !box_.classList.contains("shut")); return; }
  const cite = t.closest(".cite");
  if (cite && art) {
    const li = $(`.src[data-n="${cite.dataset.cite}"]`, art);
    if (li) {
      $(".peek", li).setAttribute("aria-expanded", "true"); $(".snip", li).hidden = false;
      li.scrollIntoView({block: "nearest", behavior: smooth()});
      li.classList.add("flash"); setTimeout(() => li.classList.remove("flash"), 1600);
    }
    return;
  }
  const pk = t.closest(".peek");
  if (pk) { const open = pk.getAttribute("aria-expanded") !== "true"; pk.setAttribute("aria-expanded", String(open)); $(".snip", pk.closest(".src")).hidden = !open; return; }
  const rt = t.closest("[data-retry]");
  if ((rt || t.closest("[data-switch]")) && st.busy) { toast("Wait for the current question to finish"); return; }
  if (rt && art) { setMode(art.dataset.mode); cat.value = art.dataset.cat; art.remove(); submit(art.dataset.q); return; }
  if (t.closest("[data-edit]") && art) { box.value = art.dataset.q; grow(); box.focus(); box.setSelectionRange(box.value.length, box.value.length); return; }
  const sw = t.closest("[data-switch]");
  if (sw && art) {
    const k = sw.dataset.switch;
    if (k === "update") { go("update"); return; }
    if (k === "all") { cat.value = "all"; savePrefs(); }
    if (k === "passages") { setMode("passages"); savePrefs(); }
    const q = art.dataset.q; art.remove(); submit(q); return;
  }
  const fo = t.closest("[data-far-open]");
  if (fo) { try { emit("far:fill", JSON.parse(fo.dataset.farOpen)); } catch { /* ignore */ } go("far"); return; }
  if (t.closest("[data-copy]") && art) {
    let text;
    if (art._result) {
      const r = art._result, cites = r.citations || [];
      text = `${art.dataset.q}\n\n${plain(r.answer).replace(/\*\*(.+?)\*\*/g, "$1").replace(/\[S(\d+)\]/g, "[$1]")}\n\n${cites.length ? "Sources:\n" + cites.map(c => `[${c.n}] ${c.title}, page ${c.page}`).join("\n") : ""}`.trim();
    } else text = `${art.dataset.q}\n\n` + $$(".hit", art).map(h => `${$("h3", h).textContent} (${$(".m span", h).textContent})\n${$("p", h).textContent}`).join("\n\n");
    copyText(text).then(ok => toast(ok ? "Copied" : "Couldn't copy"));
  }
});

/* ---------- reacting to other views ---------- */
on("ask:prefill", e => {
  const {text, mode, run} = e.detail || {};
  if (mode) setMode(mode);
  if (run) { submit(text || ""); return; }
  box.value = text || ""; grow(); box.focus(); box.setSelectionRange(box.value.length, box.value.length);
});
on("ask:run", e => { go("ask"); submit(e.detail); });

grow();
