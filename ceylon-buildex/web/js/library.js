// Library: every source in the dataset as a map (or, if you prefer, a plain list).
// Round nodes are documents, grouped in labelled boxes by kind and joined by a triangle mesh. Lines over the mesh are real relations from the dataset (see matrix.js). Filters dim what does not match.
import {$, $$, esc, api, tags, icon, CAT, CATS, debounce, store, reduced} from "./util.js";
import {on} from "./state.js";
import {current} from "./router.js";
import {layout, links, related, caption, KIND_RANK} from "./matrix.js";
import {openDoc} from "./reader.js";

const wrap = $("#libMatrix"), listWrap = $("#libListWrap"), listEl = $("#libList"), count = $("#libCount"), qIn = $("#libQ"), chips = $("#libChips"),
  card = $("#mxCard"), empty = $("#libEmpty");
const PREF = "ceylon-buildex-library";
const KIND_TEXT = {sup: "supersedes", gaz: "same gazette", auth: "same authority", site: "same website", cat: "same kind"};
const STATUS_CLASS = {current: "s-ok", verify: "s-warn", "check-current": "s-warn", unverified: "s-warn", superseded: "s-bad"};
let docs = [], byId = new Map(), lk = [], adj = new Map(), near = new Map(), lay = null, loaded = false, req = 0;
let category = "all", mode = store.get(PREF) === "list" ? "list" : "matrix", sel = null, hover = null, rove = null, pointer = "mouse", okIds = new Set();
let nodeEl = new Map(), edgeEl = [], boxEl = [], order = [];
const label = c => (CATS.find(x => x[0] === c) || [0, CAT[c] || c || "Other"])[1];

/* ---------- controls ---------- */
chips.innerHTML = CATS.map(([k, v]) => `<button type="button" class="chip" data-lc="${k}" aria-pressed="${k === category}">${esc(v)}</button>`).join("");
chips.addEventListener("click", e => {
  const b = e.target.closest("[data-lc]"); if (!b) return;
  category = b.dataset.lc;
  $$(".chip", chips).forEach(c => c.setAttribute("aria-pressed", String(c.dataset.lc === category)));
  applyFilter();
});
qIn.addEventListener("input", debounce(() => applyFilter(), 160));
$$('input[name="libmode"]').forEach(r => { r.checked = r.value === mode; r.addEventListener("change", () => { mode = r.value; store.set(PREF, mode); showMode(true); }); });
function clearFilter() { category = "all"; qIn.value = ""; $$(".chip", chips).forEach(c => c.setAttribute("aria-pressed", String(c.dataset.lc === "all"))); applyFilter(); }
on("view", e => { if (e.detail === "library") { if (!loaded) load(); else showMode(true); } });
on("docs:changed", () => { if (current() === "library") load(); else loaded = false; });
if (window.ResizeObserver) new ResizeObserver(debounce(() => { if (current() === "library" && mode === "matrix" && loaded) { const w = wrap.clientWidth, h = wrap.clientHeight; if (lay && (Math.abs(w - lay.W) > 2 || Math.abs(h - lay.H) > 2)) draw(false); } }, 140)).observe(wrap);

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
  try {
    const {documents} = await api("/api/docs");
    if (my !== req) return;
    docs = documents; byId = new Map(docs.map(d => [d.id, d])); lk = links(docs);
    adj = new Map(docs.map(d => [d.id, new Set()])); lk.forEach(e => { adj.get(e.a).add(e.b); adj.get(e.b).add(e.a); });
    near = related(docs, lk); loaded = true; sel = hover = null;
    empty.hidden = true;
    showMode(true);
  } catch (e) {
    if (my !== req) return;
    wrap.innerHTML = `<div class="errbox"><h3 class="display">Couldn't load the library</h3><p class="muted">${esc(e.message)}</p><div class="actions"><button type="button" class="btn" data-lib-retry>${icon("refresh")}Retry</button></div></div>`;
  } finally { wrap.removeAttribute("aria-busy"); }
}

function showMode(intro) {
  wrap.hidden = mode !== "matrix"; listWrap.hidden = mode !== "list";
  $(".mxkey").hidden = mode !== "matrix";
  if (mode === "matrix") draw(intro); else hideCard();
  applyFilter(intro);
}

/* ---------- drawing the matrix ---------- */
const TAB_W = 6.9;       // width of one character of the mono tab text (10px, tracked), used until the real text can be measured
function draw(intro) {
  if (mode !== "matrix" || !loaded) return;
  const W = Math.floor(wrap.clientWidth), H = Math.floor(wrap.clientHeight);
  if (W < 60 || H < 60) return;
  lay = layout(docs, W, H); lay.W = W; lay.H = H;
  const animate = intro && !reduced(), out = [], Hh = Math.ceil(lay.height), f = v => v.toFixed(1);
  out.push(`<svg class="mx${animate ? "" : " still"}" width="${W}" height="${Hh}" viewBox="0 0 ${W} ${Hh}" role="group" aria-label="Map of ${docs.length} sources in ${lay.boxes.length} groups. Arrow keys move between sources; Enter opens one.">`);
  out.push(`<defs><pattern id="mxdots" width="24" height="24" patternUnits="userSpaceOnUse"><circle class="dotc" cx="1.5" cy="1.5" r="1"/></pattern></defs><rect class="grid" width="${W}" height="${Hh}" fill="url(#mxdots)"/>`);
  lay.boxes.forEach((b, i) => {
    let name = label(b.cat).toUpperCase();
    const room = Math.max(4, Math.floor((b.w - 28 - 30 - String(b.count).length * TAB_W) / TAB_W));     // a tab never sticks out of its box
    if (name.length > room) name = name.slice(0, Math.max(3, room - 1)).trimEnd() + "…";
    const tw = Math.round(name.length * TAB_W + String(b.count).length * TAB_W + 30);
    out.push(`<g class="box" data-box="${i}" style="--b:${i}" aria-hidden="true"><rect class="bx" x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}" rx="3"/>
      <g class="tab" transform="translate(${f(b.x + 14)} ${f(b.y - 9)})"><rect class="tb" width="${tw}" height="18" rx="2"/><text class="tt" x="9" y="12.7">${esc(name)}</text><text class="tc" x="${tw - 9}" y="12.7" text-anchor="end">${b.count}</text></g></g>`);
  });
  // the mesh only says "same kind of document" (it is what the box is); the lines over it are the real relations in the dataset
  out.push(`<g class="mesh" aria-hidden="true">`);
  lay.mesh.forEach((e, i) => {
    const a = lay.nodes.get(e.a), b = lay.nodes.get(e.b);
    out.push(`<line class="m" data-a="${esc(e.a)}" data-b="${esc(e.b)}" x1="${f(a.x)}" y1="${f(a.y)}" x2="${f(b.x)}" y2="${f(b.y)}" pathLength="1" style="--d:${Math.min(1300, 300 + e.box * 140 + i * 12)}ms"/>`);
  });
  out.push(`</g><g class="rel" aria-hidden="true">`);
  const edges = lk.filter(e => e.kind !== "cat").sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
  edges.forEach((e, i) => {
    const a = lay.nodes.get(e.a), b = lay.nodes.get(e.b); if (!a || !b) return;
    const same = a.box === b.box, quiet = same && (e.kind === "auth" || e.kind === "site");   // inside one box these are everywhere: show them only when you point at a document
    const g = `x1="${f(a.x)}" y1="${f(a.y)}" x2="${f(b.x)}" y2="${f(b.y)}" pathLength="1"`;
    out.push(`<line class="e ${e.kind}${quiet ? " hov" : ""}" data-a="${esc(e.a)}" data-b="${esc(e.b)}" ${g} style="--d:${Math.min(1700, 700 + i * 20)}ms"/>`);
    if (!quiet && e.kind !== "site") out.push(`<line class="p ${e.kind}" data-a="${esc(e.a)}" data-b="${esc(e.b)}" ${g} style="--d:${(i * 370) % 2400}ms"/>`);
  });
  out.push(`</g><g class="nodes">`);
  order = lay.order.slice();
  order.forEach((id, k) => {
    const n = lay.nodes.get(id), d = n.doc, r = n.r, q = r * 0.7;
    const seed = d.origin === "seed-extract", st = STATUS_CLASS[d.status] || "s-ref", cap = caption(d);
    const name = `${d.title}. ${label(d.category)}. ${(d.status || "").replace("-", " ")}. ${d.pages} page${d.pages === 1 ? "" : "s"}.`;
    out.push(`<g transform="translate(${f(n.x)} ${f(n.y)})"><g class="node ${st}${seed ? " seed" : ""}" data-id="${esc(d.id)}" tabindex="-1" role="button" aria-label="${esc(name)}" style="--k:${k};--b:${n.box}">
      <circle class="halo" r="${f(r + 6)}"/><circle class="dot" r="${f(r)}"/><circle class="in" r="${f(r * 0.46)}"/><path class="strike" d="M${f(-q)} ${f(q)}L${f(q)} ${f(-q)}"/>
      ${lay.labels && cap ? `<text class="nl" y="${f(r + 12.5)}">${esc(cap.length > 11 ? cap.slice(0, 10) + "…" : cap)}</text>` : ""}
      <circle class="hit" r="${f(Math.max(r + 9, 22))}"/></g></g>`);
  });
  out.push(`</g></svg>`);
  wrap.innerHTML = out.join("");
  const svg = $("svg.mx", wrap);
  $$(".tab", svg).forEach(t => {   // fit each tab to its real text
    try { const tt = $(".tt", t), tc = $(".tc", t), w = Math.ceil(tt.getBBox().width + tc.getBBox().width + 30); $(".tb", t).setAttribute("width", w); tc.setAttribute("x", w - 9); } catch (e) { /* keep the estimate */ }
  });
  nodeEl = new Map($$(".node", svg).map(n => [n.dataset.id, n]));
  edgeEl = $$(".e, .p, .m", svg);
  boxEl = $$(".box", svg);
  if (animate) setTimeout(() => { if (svg.isConnected) svg.classList.add("flow"); }, 2000); else svg.classList.add("flow");
  if (sel && nodeEl.has(sel)) nodeEl.get(sel).classList.add("sel");
  applyFilter();
  if (sel || hover) { light(hover || sel); showCard(hover || sel); }
}

function light(id) {
  const svg = $("svg.mx", wrap); if (!svg) return;
  svg.classList.toggle("hot", !!id);
  const nb = id ? new Set([id, ...(adj.get(id) || [])]) : null, home = id && lay && lay.nodes.get(id) ? lay.nodes.get(id).box : -1;
  nodeEl.forEach((el, nid) => el.classList.toggle("on", !!nb && nb.has(nid)));
  edgeEl.forEach(e => e.classList.toggle("on", !!id && (e.dataset.a === id || e.dataset.b === id)));
  boxEl.forEach((b, i) => b.classList.toggle("on", i === home));
}

function applyFilter(animateList = false) {
  okIds = new Set(docs.filter(matches).map(d => d.id));
  const total = docs.length, n = okIds.size;
  count.textContent = total ? (n === total ? `${total} document${total === 1 ? "" : "s"}` : `${n} of ${total} documents`) : "";
  if (!rove || !okIds.has(rove)) rove = order.find(id => okIds.has(id)) || null;
  nodeEl.forEach((el, id) => { const ok = okIds.has(id); el.classList.toggle("off", !ok); el.setAttribute("aria-hidden", String(!ok)); el.tabIndex = ok && id === rove ? 0 : -1; });
  edgeEl.forEach(e => e.classList.toggle("off", !(okIds.has(e.dataset.a) && okIds.has(e.dataset.b))));
  boxEl.forEach((b, i) => b.classList.toggle("off", !!lay && !lay.boxes[i].ids.some(id => okIds.has(id))));
  empty.hidden = !loaded || n > 0;
  if (sel && !okIds.has(sel)) { select(null); }
  if (mode === "list") renderList(animateList);
}

/* ---------- the detail card ---------- */
function showCard(id) {
  const d = byId.get(id), n = lay && lay.nodes.get(id);
  if (!d || !n) { hideCard(); return; }
  const rl = (near.get(id) || []).slice(0, 6);
  card.dataset.side = n.x > lay.W * 0.5 ? "left" : "right";
  card.dataset.pinned = String(sel === id);
  const key = id + "|" + (sel === id);
  if (!card.hidden && cardKey === key) return;      // already showing this: rebuilding it would swallow a click in progress on its buttons
  cardKey = key;
  card.innerHTML = `<div class="mxc-top"><span class="mxc-cat">${esc(label(d.category))}</span>${sel === id ? `<button type="button" class="icon-btn sm" data-mx-close aria-label="Close details">${icon("x", "sm")}</button>` : ""}</div>
    <h3>${esc(d.title)}</h3>
    <div class="meta">${d.authority ? `<span>${esc(d.authority)}</span>` : ""}${d.gazette_no ? `<span>Gazette ${esc(d.gazette_no)}</span>` : ""}${d.doc_date ? `<span>${esc(d.doc_date)}</span>` : ""}<span>${d.pages} page${d.pages === 1 ? "" : "s"}</span></div>
    <div class="mxc-tags">${tags(d)}</div>
    ${rl.length ? `<ul class="mxc-links">${rl.map(r => { const o = byId.get(r.id); return o ? `<li><span>${KIND_TEXT[r.kind]}</span> <button type="button" class="link" data-mx-go="${esc(o.id)}">${esc(o.title.length > 64 ? o.title.slice(0, 62) + "…" : o.title)}</button></li>` : ""; }).join("")}</ul>` : ""}
    <div class="actions"><button type="button" class="btn sm" data-doc="${esc(id)}">Read</button></div>`;
  card.hidden = false;
}
let cardKey = "";
function hideCard() { card.hidden = true; cardKey = ""; }
function settle() { const id = hover || sel; light(id); if (id) showCard(id); else hideCard(); }
function select(id) {
  if (sel && nodeEl.has(sel)) nodeEl.get(sel).classList.remove("sel");
  sel = id;
  if (id && nodeEl.has(id)) nodeEl.get(id).classList.add("sel");
  settle();
}
function focusNode(id) { const el = nodeEl.get(id); if (!el) return; rove = id; nodeEl.forEach((e, k) => { e.tabIndex = k === id ? 0 : -1; }); el.focus({preventScroll: true}); }

/* ---------- interaction ---------- */
const nodeOf = t => t.closest && t.closest(".node");
wrap.addEventListener("pointerdown", e => { pointer = e.pointerType || "mouse"; });
// the card stays for a moment after the pointer leaves a square, so you can move onto the card and use its links
let hideT = 0;
const keepCard = () => { clearTimeout(hideT); hideT = 0; };
const dropCard = ms => { keepCard(); hideT = setTimeout(() => { hover = null; settle(); }, ms); };
wrap.addEventListener("pointerover", e => { const n = nodeOf(e.target); if (n && pointer === "mouse" && !n.classList.contains("off")) { keepCard(); hover = n.dataset.id; settle(); } });
wrap.addEventListener("pointerout", e => { const n = nodeOf(e.target); if (n && hover === n.dataset.id && !(e.relatedTarget && n.contains(e.relatedTarget))) dropCard(260); });
card.addEventListener("pointerenter", keepCard);
card.addEventListener("pointerleave", () => { if (hover && pointer === "mouse") dropCard(200); });
wrap.addEventListener("focusin", e => { const n = nodeOf(e.target); if (n) { rove = n.dataset.id; hover = n.dataset.id; settle(); } });
wrap.addEventListener("focusout", e => { if (nodeOf(e.target)) { hover = null; settle(); } });
wrap.addEventListener("click", e => {
  if (e.target.closest("[data-lib-retry]")) { load(); return; }
  const n = nodeOf(e.target);
  if (!n) { if (sel) select(null); return; }
  if (n.classList.contains("off")) return;
  const id = n.dataset.id;
  if (pointer !== "mouse" && sel !== id) { select(id); return; }   // touch: first tap shows the details, the Read button opens it
  select(id);
  openDoc(id);
});
card.addEventListener("click", e => {
  if (e.target.closest("[data-mx-close]")) { select(null); return; }
  const g = e.target.closest("[data-mx-go]"); if (g) { const id = g.dataset.mxGo; if (okIds.has(id)) { select(id); focusNode(id); } }
});
wrap.addEventListener("keydown", e => {
  const n = nodeOf(e.target); if (!n) return;
  const id = n.dataset.id, ids = order.filter(x => okIds.has(x)), me = lay.nodes.get(id);
  let to = null;
  const arrows = {ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1]};
  if (arrows[e.key]) {
    // the nearest source in that direction (a narrow cone first), else the next one in reading order
    const [dx, dy] = arrows[e.key]; let best = Infinity;
    ids.forEach(x => {
      if (x === id) return; const c = lay.nodes.get(x), ax = (c.x - me.x) * dx + (c.y - me.y) * dy, perp = Math.abs((c.x - me.x) * dy - (c.y - me.y) * dx);
      if (ax < 4) return; const score = ax + perp * 2.2; if (score < best) { best = score; to = x; }
    });
    if (!to) { const i = ids.indexOf(id); to = ids[Math.max(0, Math.min(ids.length - 1, i + dx + dy))]; }
  } else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(id); openDoc(id); return; }
  else if (e.key === "Escape" && sel) { e.stopPropagation(); select(null); return; }
  else return;
  e.preventDefault();
  if (to) focusNode(to);
});

/* ---------- list mode ---------- */
const rank = s => (s === "current" ? 0 : s === "verify" ? 1 : 2);
const row = (d, i, animate) => `<li${animate ? ` class="reveal" style="--i:${Math.min(i, 12)}"` : ""}><button type="button" class="row-doc" data-doc="${esc(d.id)}" data-status="${esc(d.status || "")}">
  <div><div class="t">${esc(d.title)}</div><div class="m"><span>${esc(CAT[d.category] || d.category || "")}</span>${d.authority ? `<span>${esc(d.authority)}</span>` : ""}${d.gazette_no ? `<span>Gazette ${esc(d.gazette_no)}</span>` : ""}${d.doc_date ? `<span>${esc(d.doc_date)}</span>` : ""}<span>${d.pages} page${d.pages === 1 ? "" : "s"}</span></div></div>
  <div class="side">${tags(d)}</div></button></li>`;
function renderList(animate) {
  const rows = docs.filter(d => okIds.has(d.id)).sort((a, b) => rank(a.status) - rank(b.status) || String(b.doc_date || "").localeCompare(String(a.doc_date || "")) || String(a.title).localeCompare(String(b.title)));
  listEl.innerHTML = rows.map((d, i) => row(d, i, animate)).join("");
}

document.addEventListener("click", e => { if (e.target.closest("[data-lib-clear]")) clearFilter(); });
