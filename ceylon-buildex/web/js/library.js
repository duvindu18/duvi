// Library: every source in the dataset as a matrix of kind x year (or, if you prefer, a plain list), with an inspector beside it.
// Where a document sits is its data (its category and its date); pointing at one draws its real relations from the dataset (see matrix.js)
// and shows its details. Filters dim what does not match.
import {$, $$, esc, api, tags, icon, CAT, CATS, debounce, store, reduced, fmt, fmtTime} from "./util.js";
import {on, S} from "./state.js";
import {current} from "./router.js";
import {grid, links, related, caption, markSize, yearOf, KIND_RANK} from "./matrix.js";
import {openDoc} from "./reader.js";

const wrap = $("#libMatrix"), listWrap = $("#libListWrap"), listEl = $("#libList"), count = $("#libCount"), qIn = $("#libQ"), chips = $("#libChips"),
  card = $("#mxCard"), empty = $("#libEmpty"), stats = $("#libStats");
const PREF = "ceylon-buildex-library";
const KIND_TEXT = {sup: "Supersedes", gaz: "Same gazette", auth: "Same authority", site: "Same website"};
const STATUS_CLASS = {current: "s-ok", verify: "s-warn", "check-current": "s-warn", unverified: "s-warn", superseded: "s-bad"};
const STATUS_TEXT = {current: "Current", verify: "To verify", "check-current": "Check it is current", unverified: "Unverified", superseded: "Superseded", reference: "Reference"};
let docs = [], byId = new Map(), adj = new Map(), near = new Map(), loaded = false, req = 0;
let category = "all", mode = store.get(PREF) === "list" ? "list" : "matrix", sel = null, hover = null, rove = null, pointer = "mouse", okIds = new Set();
let nodeEl = new Map(), order = [];
const label = c => (CATS.find(x => x[0] === c) || [0, CAT[c] || c || "Other"])[1];
const plural = (n, w) => `${fmt(n, 0)} ${w}${n === 1 ? "" : "s"}`;

/* ---------- controls ---------- */
chips.innerHTML = CATS.map(([k, v]) => `<button type="button" class="chip" data-lc="${k}" aria-pressed="${k === category}">${esc(v)}</button>`).join("");
chips.addEventListener("click", e => {
  const b = e.target.closest("[data-lc]"); if (!b) return;
  category = b.dataset.lc;
  $$(".chip", chips).forEach(c => c.setAttribute("aria-pressed", String(c.dataset.lc === category)));
  applyFilter();
});
qIn.addEventListener("input", debounce(() => applyFilter(), 140));
$$('input[name="libmode"]').forEach(r => { r.checked = r.value === mode; r.addEventListener("change", () => { mode = r.value; store.set(PREF, mode); showMode(true); }); });
function clearFilter() { category = "all"; qIn.value = ""; $$(".chip", chips).forEach(c => c.setAttribute("aria-pressed", String(c.dataset.lc === "all"))); applyFilter(); }
on("view", e => { if (e.detail === "library") { if (!loaded) load(); else showMode(false); } });
on("docs:changed", () => { if (current() === "library") load(); else loaded = false; });
on("status", () => { if (loaded) paintStats(); });
if (window.ResizeObserver) new ResizeObserver(debounce(() => { if (loaded && mode === "matrix") drawLinks(); }, 80)).observe(wrap);

const matches = d => {
  if (category !== "all" && (category === "gazette" ? !d.gazette_no : d.category !== category)) return false;
  const q = qIn.value.trim().toLowerCase();
  if (!q) return true;
  const hay = [d.title, d.gazette_no, d.authority, CAT[d.category], d.doc_date].join(" ").toLowerCase();
  return q.split(/\s+/).every(t => hay.includes(t));
};

/* ---------- loading ---------- */
async function load() {
  const my = ++req;
  wrap.setAttribute("aria-busy", "true");
  if (!loaded) wrap.innerHTML = `<div class="mx-load" aria-hidden="true">${Array.from({length: 4}, () => `<i class="sk"></i>`).join("")}</div>`;
  try {
    const {documents} = await api("/api/docs");
    if (my !== req) return;
    docs = documents; byId = new Map(docs.map(d => [d.id, d]));
    const lk = links(docs).filter(e => e.kind !== "cat");
    adj = new Map(docs.map(d => [d.id, new Set()])); lk.forEach(e => { adj.get(e.a).add(e.b); adj.get(e.b).add(e.a); });
    near = related(docs, lk); loaded = true; sel = hover = null;
    empty.hidden = true;
    paintStats();
    showMode(true);
  } catch (e) {
    if (my !== req) return;
    wrap.innerHTML = `<div class="errbox"><h3>Couldn't load the library</h3><p class="muted">${esc(e.message)}</p><div class="actions"><button type="button" class="btn" data-lib-retry>${icon("refresh")}Retry</button></div></div>`;
  } finally { wrap.removeAttribute("aria-busy"); }
}

/* ---------- the numbers above the matrix ---------- */
function paintStats() {
  const n = docs.length, pages = docs.reduce((t, d) => t + (d.pages || 0), 0);
  const by = k => docs.filter(d => (STATUS_CLASS[d.status] || "s-ref") === k).length;
  const full = docs.filter(d => d.origin && d.origin !== "seed-extract").length, kinds = new Set(docs.map(d => d.category || "other")).size;
  const seg = [["s-ok", by("s-ok")], ["s-warn", by("s-warn")], ["s-bad", by("s-bad")], ["s-ref", by("s-ref")]].filter(x => x[1]);
  const last = S.status && S.status.dataset && S.status.dataset.last_update;
  stats.innerHTML = `
    <div class="stat"><div class="l">Documents</div><div class="v">${fmt(n, 0)}</div>
      <div class="bar" role="img" aria-label="${seg.map(([k, v]) => `${v} ${({"s-ok": "current", "s-warn": "to verify", "s-bad": "superseded", "s-ref": "reference"})[k]}`).join(", ")}">${seg.map(([k, v]) => `<i class="${k}" style="flex:${v}"></i>`).join("")}</div></div>
    <div class="stat"><div class="l">Pages</div><div class="v">${fmt(pages, 0)}</div><div class="h">${plural(kinds, "kind")} of document</div></div>
    <div class="stat"><div class="l">Full text</div><div class="v">${fmt(full, 0)}<small>/${fmt(n, 0)}</small></div><div class="h">${n - full ? `${n - full} ${n - full === 1 ? "is a summary" : "are summaries"} until updated` : "every document in full"}</div></div>
    <div class="stat"><div class="l">Last update</div><div class="v sm">${last ? esc(fmtTime(last)) : "Never"}</div><div class="h">${last ? "Update to fetch what changed" : "Showing the shipped extracts"}</div></div>`;
}

function showMode(intro) {
  wrap.hidden = mode !== "matrix"; card.hidden = mode !== "matrix"; listWrap.hidden = mode !== "list";
  $(".mxkey").hidden = mode !== "matrix";
  $("#view-library .libbody").dataset.mode = mode;
  if (mode === "matrix") draw(intro);
  applyFilter(intro);
}

/* ---------- drawing the matrix ---------- */
function draw(intro) {
  if (mode !== "matrix" || !loaded) return;
  const g = grid(docs), maxPages = Math.max(1, ...docs.map(d => d.pages || 1)), animate = intro && !reduced();
  const colName = c => c || "Undated";
  const counts = g.cols.map((c, j) => g.rows.reduce((t, r) => t + r.cells[j].length, 0));
  let k = 0;
  const out = [`<div class="mx${animate ? " intro" : ""}" role="grid" aria-label="${docs.length} documents by kind and year. Arrow keys move between them; Enter opens one." style="--cols:${g.cols.length}">`];
  out.push(`<div class="mx-corner" role="columnheader"><span>Kind</span><span>Year</span></div>`);
  g.cols.forEach((c, j) => out.push(`<div class="mx-h" role="columnheader" data-col="${j}"><b>${esc(colName(c))}</b><span>${counts[j]}</span></div>`));
  g.rows.forEach((r, i) => {
    out.push(`<div class="mx-rh" role="rowheader" data-row="${i}" style="--r:${i}"><b>${esc(label(r.cat))}</b><span>${plural(r.docs.length, "document")}</span><i class="share" style="--w:${(r.docs.length / Math.max(1, docs.length) * 100).toFixed(1)}%"></i></div>`);
    r.cells.forEach((cell, j) => {
      out.push(`<div class="mx-c" role="gridcell" data-row="${i}" data-col="${j}"${cell.length ? "" : ' aria-label="none"'}>`);
      cell.forEach(d => {
        const st = STATUS_CLASS[d.status] || "s-ref", seed = d.origin === "seed-extract";
        const name = `${d.title}. ${label(d.category)}, ${colName(yearOf(d))}. ${STATUS_TEXT[d.status] || d.status || ""}. ${plural(d.pages || 0, "page")}${seed ? ", summary only" : ""}.`;
        out.push(`<button type="button" class="mxn ${st}${seed ? " seed" : ""}" data-id="${esc(d.id)}" data-row="${i}" data-col="${j}" tabindex="-1" aria-label="${esc(name)}" style="--k:${k++};--gs:${markSize(d.pages, maxPages)}px"><i class="g" aria-hidden="true"></i><span class="lb">${esc(caption(d))}</span></button>`);
      });
      out.push(`</div>`);
    });
  });
  out.push(`</div><svg class="mx-links" aria-hidden="true"></svg>`);
  wrap.innerHTML = out.join("");
  nodeEl = new Map($$(".mxn", wrap).map(n => [n.dataset.id, n]));
  order = [...nodeEl.keys()];
  if (sel && nodeEl.has(sel)) nodeEl.get(sel).classList.add("sel");
  applyFilter();
  settle();
}

/* lines from the document in focus to each related one: smooth curves, drawn on top of the grid */
function drawLinks() {
  const svg = $("svg.mx-links", wrap), mx = $(".mx", wrap); if (!svg || !mx) return;
  const id = hover || sel, me = id && nodeEl.get(id);
  const W = mx.scrollWidth, H = mx.scrollHeight;
  svg.setAttribute("width", W); svg.setAttribute("height", H); svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  if (!me || me.classList.contains("off")) { svg.innerHTML = ""; return; }
  const base = mx.getBoundingClientRect(), c = el => { const r = el.getBoundingClientRect(); return {x: r.left - base.left + r.width / 2, y: r.top - base.top + r.height / 2, r}; };
  const a = c(me), rows = [], rank = new Map((near.get(id) || []).map(x => [x.id, x.kind]));
  [...rank].sort((p, q) => KIND_RANK[q[1]] - KIND_RANK[p[1]]).forEach(([oid, kind], i) => {
    const el = nodeEl.get(oid); if (!el || el.classList.contains("off")) return;
    const b = c(el), dx = b.x - a.x, dy = b.y - a.y, bend = Math.min(80, Math.hypot(dx, dy) * 0.28) * (i % 2 ? -1 : 1);
    const mxp = (a.x + b.x) / 2 - dy / Math.max(1, Math.hypot(dx, dy)) * bend, myp = (a.y + b.y) / 2 + dx / Math.max(1, Math.hypot(dx, dy)) * bend;
    rows.push(`<path class="ln ${kind}" d="M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${mxp.toFixed(1)} ${myp.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}" pathLength="1" style="--d:${i * 60}ms"/>`,
      `<circle class="end ${kind}" cx="${b.x.toFixed(1)}" cy="${b.y.toFixed(1)}" r="2.5"/>`);
  });
  svg.innerHTML = rows.join("") + `<circle class="end me" cx="${a.x.toFixed(1)}" cy="${a.y.toFixed(1)}" r="3"/>`;
}

function light(id) {
  const mx = $(".mx", wrap); if (!mx) return;
  mx.classList.toggle("hot", !!id);
  const nb = id ? adj.get(id) || new Set() : null, me = id && nodeEl.get(id);
  nodeEl.forEach((el, nid) => { el.classList.toggle("on", !!nb && nb.has(nid)); el.classList.toggle("me", nid === id); });
  $$(".mx-h, .mx-rh, .mx-c", mx).forEach(el => el.classList.toggle("x", !!me && ((el.dataset.row != null && el.dataset.row === me.dataset.row && !el.classList.contains("mx-c")) || (el.dataset.col != null && el.dataset.col === me.dataset.col && !el.classList.contains("mx-c")) || (el.classList.contains("mx-c") && el.dataset.row === me.dataset.row && el.dataset.col === me.dataset.col))));
  drawLinks();
}

function applyFilter(animateList = false) {
  okIds = new Set(docs.filter(matches).map(d => d.id));
  const total = docs.length, n = okIds.size;
  count.textContent = total ? (n === total ? `${plural(total, "document")} by kind and year` : `${n} of ${plural(total, "document")} match`) : "";
  if (!rove || !okIds.has(rove)) rove = order.find(id => okIds.has(id)) || null;
  nodeEl.forEach((el, id) => { const ok = okIds.has(id); el.classList.toggle("off", !ok); el.setAttribute("aria-hidden", String(!ok)); el.tabIndex = ok && id === rove ? 0 : -1; });
  $$(".mx-rh", wrap).forEach(h => h.classList.toggle("off", ![...nodeEl.values()].some(el => el.dataset.row === h.dataset.row && okIds.has(el.dataset.id))));
  empty.hidden = !loaded || n > 0;
  if (sel && !okIds.has(sel)) select(null);
  if (mode === "list") renderList(animateList); else drawLinks();
}

/* ---------- the inspector ---------- */
let cardKey = "";
const floating = matchMedia("(max-width: 1559px) and (min-width: 701px)");
/* next to the document, on whichever side has room, kept inside the library body */
function place(id) {
  if (!floating.matches) { card.style.left = card.style.top = ""; return; }
  const el = nodeEl.get(id), body = card.parentElement; if (!el) return;
  const b = body.getBoundingClientRect(), r = el.getBoundingClientRect(), w = card.offsetWidth, h = card.offsetHeight, gap = 12;
  let x = r.right - b.left + gap;
  if (x + w > b.width) x = r.left - b.left - w - gap;
  x = Math.max(0, Math.min(x, b.width - w));
  const y = Math.max(0, Math.min(r.top - b.top - 16, Math.max(0, wrap.offsetTop + wrap.offsetHeight - h)));
  card.style.left = Math.round(x) + "px"; card.style.top = Math.round(y) + "px";
}
function showCard(id) {
  const d = byId.get(id);
  if (!d) { blankCard(); return; }
  const key = id + "|" + (sel === id);
  if (cardKey === key) { place(id); return; }      // already showing this: rebuilding it would swallow a click in progress on its buttons
  cardKey = key;
  const rl = (near.get(id) || []).slice().sort((a, b) => KIND_RANK[b.kind] - KIND_RANK[a.kind]).slice(0, 6);
  const st = STATUS_CLASS[d.status] || "s-ref";
  card.dataset.state = "doc"; card.dataset.pinned = String(sel === id);
  card.innerHTML = `<div class="ins-top"><span class="ins-cat"><i class="g ${st}"></i>${esc(label(d.category))}</span>${sel === id ? `<button type="button" class="icon-btn sm" data-mx-close aria-label="Close details">${icon("x", "sm")}</button>` : `<span class="ins-hint">Click to keep</span>`}</div>
    <h3>${esc(d.title)}</h3>
    <dl class="ins-kv">${d.authority ? `<dt>Authority</dt><dd>${esc(d.authority)}</dd>` : ""}${d.gazette_no ? `<dt>Gazette</dt><dd>${esc(d.gazette_no)}</dd>` : ""}
      <dt>Date</dt><dd>${esc(d.doc_date || "Undated")}</dd><dt>Pages</dt><dd>${fmt(d.pages || 0, 0)}</dd><dt>Status</dt><dd>${esc(STATUS_TEXT[d.status] || d.status || "—")}</dd></dl>
    <div class="ins-tags">${tags(d)}</div>
    ${rl.length ? `<div class="ins-rel"><div class="ins-h">Related</div><ul>${rl.map(r => { const o = byId.get(r.id); return o ? `<li><span class="k ${r.kind}">${KIND_TEXT[r.kind]}</span><button type="button" class="link" data-mx-go="${esc(o.id)}">${esc(o.title.length > 70 ? o.title.slice(0, 68) + "…" : o.title)}</button></li>` : ""; }).join("")}</ul></div>` : `<p class="ins-none">No recorded relation to another document.</p>`}
    <div class="actions"><button type="button" class="btn sm" data-doc="${esc(id)}">${icon("book", "sm")}Read</button>${d.url ? `<a class="btn sm quiet" href="${esc(d.url)}" target="_blank" rel="noopener">${icon("ext", "sm")}Original</a>` : ""}</div>`;
  place(id);
}
function blankCard() {
  if (cardKey === "blank") return;
  cardKey = "blank"; card.dataset.state = "blank";
  card.innerHTML = `<div class="ins-blank"><svg class="i" aria-hidden="true"><use href="#i-grid"/></svg><p><b>Point at a document</b> to see what it is, where it comes from and how it relates to the others.</p>
    <ul class="ins-legend"><li><i class="ln gaz"></i>Same gazette or supersedes</li><li><i class="ln auth"></i>Same authority or website</li><li><i class="pill-k seed"></i>Summary only, not full text</li><li><i class="g-sz"></i>Mark size follows the page count</li></ul></div>`;
}
function settle() { const id = hover || sel; light(id); if (id) showCard(id); else blankCard(); }
function select(id) {
  if (sel && nodeEl.has(sel)) nodeEl.get(sel).classList.remove("sel");
  sel = id;
  if (id && nodeEl.has(id)) nodeEl.get(id).classList.add("sel");
  settle();
}
function focusNode(id) { const el = nodeEl.get(id); if (!el) return; rove = id; nodeEl.forEach((e, k) => { e.tabIndex = k === id ? 0 : -1; }); el.focus({preventScroll: false}); }

/* ---------- interaction ---------- */
const nodeOf = t => t.closest && t.closest(".mxn");
wrap.addEventListener("pointerdown", e => { pointer = e.pointerType || "mouse"; });
let hideT = 0;
const keep = () => { clearTimeout(hideT); hideT = 0; };
wrap.addEventListener("pointerover", e => { const n = nodeOf(e.target); if (n && pointer === "mouse" && !n.classList.contains("off")) { keep(); hover = n.dataset.id; settle(); } });
wrap.addEventListener("pointerout", e => { const n = nodeOf(e.target); if (n && hover === n.dataset.id && !(e.relatedTarget && n.contains(e.relatedTarget))) { keep(); hideT = setTimeout(() => { hover = null; settle(); }, 260); } });
wrap.addEventListener("scroll", () => { drawLinks(); const id = hover || sel; if (id) place(id); }, {passive: true});
card.addEventListener("pointerenter", keep);                       // the card stays while the pointer moves onto it
card.addEventListener("pointerleave", () => { if (hover && pointer === "mouse") { keep(); hideT = setTimeout(() => { hover = null; settle(); }, 200); } });
wrap.addEventListener("focusin", e => { const n = nodeOf(e.target); if (n) { rove = n.dataset.id; hover = n.dataset.id; settle(); } });
wrap.addEventListener("focusout", e => { if (nodeOf(e.target)) { hover = null; settle(); } });
wrap.addEventListener("click", e => {
  if (e.target.closest("[data-lib-retry]")) { load(); return; }
  const n = nodeOf(e.target);
  if (!n) { if (sel && e.target.closest(".mx-c, .mx-rh, .mx-h")) select(null); return; }
  if (n.classList.contains("off")) return;
  const id = n.dataset.id;
  if (sel === id && pointer === "mouse") { openDoc(id); return; }   // a second click on the kept document opens it
  select(id);
});
wrap.addEventListener("dblclick", e => { const n = nodeOf(e.target); if (n && !n.classList.contains("off")) openDoc(n.dataset.id); });
card.addEventListener("click", e => {
  if (e.target.closest("[data-mx-close]")) { select(null); return; }
  const g = e.target.closest("[data-mx-go]"); if (g) { const id = g.dataset.mxGo; if (okIds.has(id)) { select(id); focusNode(id); } }
});
wrap.addEventListener("keydown", e => {
  const n = nodeOf(e.target); if (!n) return;
  const id = n.dataset.id, ids = order.filter(x => okIds.has(x)), r0 = n.getBoundingClientRect(), me = {x: r0.left + r0.width / 2, y: r0.top + r0.height / 2};
  let to = null;
  const arrows = {ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1]};
  if (arrows[e.key]) {
    // the nearest document in that direction (a narrow cone first), else the next one in reading order
    const [dx, dy] = arrows[e.key]; let best = Infinity;
    ids.forEach(x => {
      if (x === id) return; const r = nodeEl.get(x).getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const ax = (cx - me.x) * dx + (cy - me.y) * dy, perp = Math.abs((cx - me.x) * dy - (cy - me.y) * dx);
      if (ax < 4) return; const score = ax + perp * 2.2; if (score < best) { best = score; to = x; }
    });
    if (!to) { const i = ids.indexOf(id); to = ids[Math.max(0, Math.min(ids.length - 1, i + dx + dy))]; }
  } else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(id); openDoc(id); return; }
  else if (e.key === "Escape" && sel) { e.stopPropagation(); select(null); return; }
  else return;
  e.preventDefault();
  if (to && to !== id) focusNode(to);
});

/* ---------- list mode ---------- */
const rank = s => (s === "current" ? 0 : s === "verify" ? 1 : 2);
const row = (d, i, animate) => `<li${animate ? ` class="reveal" style="--i:${Math.min(i, 12)}"` : ""}><button type="button" class="row-doc" data-doc="${esc(d.id)}" data-status="${esc(d.status || "")}">
  <div><div class="t">${esc(d.title)}</div><div class="m"><span>${esc(CAT[d.category] || d.category || "")}</span>${d.authority ? `<span>${esc(d.authority)}</span>` : ""}${d.gazette_no ? `<span>Gazette ${esc(d.gazette_no)}</span>` : ""}${d.doc_date ? `<span>${esc(d.doc_date)}</span>` : ""}<span>${plural(d.pages || 0, "page")}</span></div></div>
  <div class="side">${tags(d)}</div></button></li>`;
function renderList(animate) {
  const rows = docs.filter(d => okIds.has(d.id)).sort((a, b) => rank(a.status) - rank(b.status) || String(b.doc_date || "").localeCompare(String(a.doc_date || "")) || String(a.title).localeCompare(String(b.title)));
  listEl.innerHTML = rows.map((d, i) => row(d, i, animate)).join("");
}

document.addEventListener("click", e => { if (e.target.closest("[data-lib-clear]")) clearFilter(); });
