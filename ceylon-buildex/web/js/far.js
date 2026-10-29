// Floor area ratio calculator. Results update as the inputs become valid; the printed table row used is always available.
import {$, $$, esc, fmt, icon, api, post, copyText, toast, debounce, reduced, BRAND, farFmt} from "./util.js";
import {on, emit} from "./state.js";
import {go, current} from "./router.js";

const form = $("#farForm"), out = $("#farOut"), mini = $("#farMini");
let FAR = null, loading = null, reqId = 0, ctrl = null, last = null;

const EXAMPLES = [
  {label: "20 perches · 40 ft road · Mixed Development", i: {regime: "cmc2008", zone: "MD", land_extent: 20, land_unit: "perch", street_type: "public", road_width: 40, road_unit: "ft"}},
  {label: "1,800 m² · 24 m street · Concentrated Development", i: {regime: "cmc2008", zone: "CD", land_extent: 1800, land_unit: "m2", street_type: "public", road_width: 24, road_unit: "m"}},
  {label: "600 m² · 12 m road · zone factor 1.10", i: {regime: "uda2021", zone_factor: 1.1, land_extent: 600, land_unit: "m2", road_width: 12, road_unit: "m"}},
  {label: "10 perches · medium density · 6 m road", i: {regime: "uda2021", density: "medium", land_extent: 10, land_unit: "perch", road_width: 6, road_unit: "m"}},
  {label: "8 perches · 4.5 m road (floors, not FAR)", i: {regime: "uda2021", zone_factor: 1.0, land_extent: 8, land_unit: "perch", road_width: 4.5, road_unit: "m"}},
];
const num = id => { const v = $(id).value; return v === "" ? null : Number(v); };
const regime = () => form.elements.regime.value;

function ensure() {
  if (FAR) return Promise.resolve(FAR);
  loading ??= api("/api/far/options").then(j => { FAR = j; fillOptions(); return j; }).catch(e => { loading = null; throw e; });
  return loading;
}

function fillOptions() {
  $("#zone").innerHTML = FAR.cmc_zones.map(z => `<option value="${esc(z.id)}">${esc(z.name)}</option>`).join("");
  $("#zone").value = "MD";
  $("#useSel").innerHTML = `<option value="">Not checked</option>` + Object.entries(FAR.uses).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("");
  $("#farExamples").innerHTML = EXAMPLES.map((x, i) => `<button type="button" class="chip" data-ex="${i}">${esc(x.label)}</button>`).join("");
  syncRegime(); zoneNote();
}

function syncRegime() {
  const r = regime(), info = FAR && FAR.regimes.find(x => x.id === r);
  $("#cmcFields").hidden = r !== "cmc2008"; $("#udaFields").hidden = r !== "uda2021";
  $("#streetTypeBox").hidden = r !== "cmc2008"; $("#resBox").hidden = r !== "uda2021"; $("#slopeBox").hidden = r !== "uda2021";
  $("#roadLabel").textContent = r === "cmc2008" ? "Width between building lines" : "Road width";
  if (info) $("#farRegimeNote").innerHTML = `<b>${esc(info.name)}</b><br>${esc(info.citation)}<br><span class="muted">${esc(info.status_note)}</span>`;
}
function zoneNote() { const z = FAR && FAR.cmc_zones.find(x => x.id === $("#zone").value); $("#zoneNote").textContent = z ? z.far_note : ""; }
function landEcho() {
  const v = parseFloat($("#land").value);
  if (!(v > 0) || !FAR) { $("#landEcho").textContent = ""; return; }
  const c = FAR.unit_conversions, u = $("#landU").value;
  const m2 = u === "perch" ? v * c.perch_to_m2 : u === "sqft" ? v * c.sqft_to_m2 : u === "acre" ? v * c.acre_to_m2 : u === "hectare" ? v * c.hectare_to_m2 : v;
  $("#landEcho").textContent = `= ${fmt(m2, 1)} m² = ${fmt(m2 / c.perch_to_m2, 2)} perches`;
}

function collect() {
  const r = regime();
  const b = {regime: r, land_extent: num("#land"), land_unit: $("#landU").value, reserve_area: num("#reserve") || 0, road_width: num("#road"), road_unit: $("#roadU").value,
    proposed: {floors: num("#pFloors"), height_m: num("#pHeight"), frontage_m: num("#pFront"), footprint_m2: num("#pFoot"), gfa_m2: num("#pGfa"), parking_m2: num("#pPark") || 0,
      residential: $("#pRes").checked, use: $("#useSel").value || null}};
  if (r === "cmc2008") { b.zone = $("#zone").value; b.street_type = $("#streetType").value; }
  else { b.zone_factor = num("#zf"); b.density = $("#dens").value || null; b.has_building_line = $("#hasBL").checked; b.slope_deg = num("#slope"); if (b.zone_factor != null) b.density = null; }
  return b;
}
function missing(b) {
  if (!(b.land_extent > 0)) return "Enter the land extent";
  if (!(b.road_width > 0)) return "Enter the road width";
  if (b.regime === "uda2021" && b.zone_factor == null && !b.density) return "Enter a zone factor or pick a density";
  return null;
}

function pending(msg) {
  last = null; mini.classList.remove("on");
  out.className = "farout pending";
  out.innerHTML = `<div class="big"><div class="num">—</div></div><div class="dim"></div><p class="muted">${esc(msg)}</p>`;
}

async function calc({scroll = false} = {}) {
  await ensure().catch(e => { out.innerHTML = `<div class="notice bad">${icon("alert")}<div>${esc(e.message)}</div></div>`; throw e; });
  const b = collect(), miss = missing(b);
  if (ctrl) ctrl.abort();
  if (miss) { reqId++; pending(miss); return; }
  const my = ++reqId; ctrl = new AbortController();
  out.setAttribute("aria-busy", "true");
  try {
    const r = await post("/api/far/calc", b, {signal: ctrl.signal});
    if (my !== reqId) return;
    last = r; render(r);
    if (scroll && matchMedia("(max-width: 899px)").matches) out.scrollIntoView({block: "start", behavior: reduced() ? "auto" : "smooth"});
  } catch (e) {
    if (e.name === "AbortError" || my !== reqId) return;
    last = null; mini.classList.remove("on");
    out.className = "farout";
    out.innerHTML = `<div class="notice bad">${icon("alert")}<div>${esc(e.message)}</div></div>`;
  } finally { if (my === reqId) out.removeAttribute("aria-busy"); }
}
const calcSoon = debounce(() => calc().catch(() => {}), 320);

/* ---------- result rendering ---------- */
const NL = v => v == null ? "—" : (typeof v === "object" ? `${v.no_nlv == null ? "—" : v.no_nlv} m / ${v.nlv == null ? "—" : v.nlv} m (without / with NLV)` : fmt(v) + " m");
function spaces(s) {
  if (!s) return "";
  let h = `<dt>Category</dt><dd>${esc(s.category)}</dd>`;
  if (s.min_frontage_m != null) h += `<dt>Min. frontage</dt><dd>${fmt(s.min_frontage_m)} m</dd>`;
  if (s.min_rear_m != null) h += `<dt>Min. rear space</dt><dd>${fmt(s.min_rear_m)} m</dd>`;
  if (s.min_one_side_m) h += `<dt>One-side space</dt><dd>${fmt(s.min_one_side_m)} m</dd>`;
  if (s.min_each_side_m) h += `<dt>Space each side</dt><dd>${fmt(s.min_each_side_m)} m</dd>`;
  if (s.rear_m) h += `<dt>Rear space</dt><dd>${NL(s.rear_m)}</dd>`;
  if (s.side_m) h += `<dt>Side space</dt><dd>${NL(s.side_m)}</dd>`;
  return `<dl class="kv">${h}</dl><p class="small muted">${esc(s.basis || "")}</p>`;
}
function table(t) {
  if (!t) return "";
  return `<div class="tblwrap"><p class="small"><b>${esc(t.name)}</b></p><table class="t"><thead><tr>${t.columns.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${t.rows.map((r, i) =>
    `<tr class="${i === t.highlight_row && t.highlight_col == null ? "hlr" : ""}">${r.map((c, j) => `<td class="${i === t.highlight_row && t.highlight_col != null && j === t.highlight_col ? "hl" : ""}">${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
const CHK = {pass: "check-c", fail: "x-c", warn: "alert", info: "info"};
const more = (title, html, open = false) => `<details class="more"${open ? " open" : ""}><summary>${title}${icon("chev")}</summary><div class="body">${html}</div></details>`;

function render(r) {
  const f = r.far, val = f.unlimited ? "Unlimited" : farFmt(f.value);
  const inp = r.inputs;
  let h = `<div class="big"><div><div class="k small muted">Permissible FAR</div><div class="num"><mark>${esc(val)}</mark></div></div>
    ${r.max_gfa_m2 != null ? `<div><div class="k small muted">Max floor area</div><div class="display">${fmt(r.max_gfa_m2, 0)} m²</div></div>` : ""}</div>
    <div class="dim"></div><p class="small muted">${esc(f.basis)}</p>`;
  h += `<dl class="kv">${r.zone ? `<dt>Zone</dt><dd>${esc(r.zone.name)}</dd>` : ""}<dt>Land</dt><dd>${fmt(inp.gross_area_m2, 1)} m² (${fmt(inp.gross_area_m2 / FAR.unit_conversions.perch_to_m2, 2)} perches)</dd>
    ${inp.reserve_area_m2 ? `<dt>Within street lines</dt><dd>− ${fmt(inp.reserve_area_m2, 1)} m²</dd>` : ""}<dt>Net site</dt><dd>${fmt(inp.net_area_m2, 1)} m²</dd>
    <dt>Road</dt><dd>${fmt(inp.road_width_m, 2)} m${inp.street_type ? " · " + esc(inp.street_type) + " street" : ""}</dd>${inp.zone_basis ? `<dt>Zone basis</dt><dd>${esc(inp.zone_basis)}</dd>` : ""}
    ${r.coverage ? `<dt>Coverage</dt><dd>Up to ${r.coverage.max_pct}% · ${fmt(r.coverage.max_footprint_m2, 0)} m² footprint</dd>` : ""}
    ${r.floors_limit ? `<dt>Floors limit</dt><dd>${r.floors_limit.max_floors}</dd>` : ""}</dl>`;
  if (r.indicative) h += `<p class="small"><i>${esc(r.indicative.text)}</i></p>`;
  (r.warnings || []).forEach(w => { h += `<div class="notice">${icon("alert")}<div>${esc(w)}</div></div>`; });
  h += `<p class="small muted caveat">Confirm with the UDA or your local authority which rules govern this parcel.</p>`;
  if (r.design) {
    h += more("Your proposal", `<dl class="kv"><dt>Total floor area</dt><dd>${fmt(r.design.gfa_m2, 1)} m²</dd><dt>Parking excluded</dt><dd>${fmt(r.design.parking_excluded_m2, 1)} m²</dd><dt>Counted area</dt><dd>${fmt(r.design.counted_area_m2, 1)} m²</dd><dt>FAR used</dt><dd>${fmt(r.design.far_used, 3)}</dd></dl>` +
      ((r.checks || []).length ? `<ul class="checks">${r.checks.map(c => `<li class="${esc(c.status)}">${icon(CHK[c.status] || "info")}<span><b>${esc(c.name)}.</b> ${esc(c.detail)}</span></li>`).join("")}</ul>` : ""), true);
  } else if ((r.checks || []).length) {
    h += `<ul class="checks">${r.checks.map(c => `<li class="${esc(c.status)}">${icon(CHK[c.status] || "info")}<span><b>${esc(c.name)}.</b> ${esc(c.detail)}</span></li>`).join("")}</ul>`;
  }
  if (r.spaces) h += more("Setbacks and spaces", spaces(r.spaces));
  if (r.table) h += more("Printed table row used", table(r.table));
  const why = [r.coverage && r.coverage.basis, r.floors_limit && r.floors_limit.basis, ...(r.notes || [])].filter(Boolean);
  if (why.length) h += more(`Rules and assumptions`, `<ul class="small">${why.map(n => `<li>${esc(n)}</li>`).join("")}</ul>`);
  h += more("Status of these rules", `<p class="small"><b>${esc(r.regime_name)}.</b> ${esc(r.status_note)}</p>`);
  if ((r.citations || []).length) h += more(`Sources (${r.citations.length})`, `<ul class="small">${r.citations.map(c => `<li><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.doc)}</a> · ${esc(c.locator)}</li>`).join("")}</ul><p class="small muted">${esc(r.citation)}</p>`);
  h += `<div class="actions stack-top"><button type="button" class="chip" data-act="copy">${icon("copy", "sm")}Copy summary</button><button type="button" class="chip" data-act="print">${icon("print", "sm")}Print</button><button type="button" class="chip" data-act="ask">${icon("search", "sm")}Ask about this</button></div>`;
  out.className = "farout";
  out.innerHTML = h;
  $("#farMiniTxt").textContent = `FAR ${val}${r.max_gfa_m2 != null ? " · " + fmt(r.max_gfa_m2, 0) + " m²" : ""}`;
  io.takeRecords(); io.unobserve(out); io.observe(out);
}

/* ---------- wiring ---------- */
const io = new IntersectionObserver(([en]) => { mini.classList.toggle("on", !!last && !en.isIntersecting && current() === "far"); }, {rootMargin: "-60px 0px 0px 0px"});
on("view", e => { if (e.detail === "far") ensure().then(() => { if (!last) calc().catch(() => {}); }).catch(err => { out.innerHTML = `<div class="notice bad">${icon("alert")}<div>${esc(err.message)}</div></div>`; }); else mini.classList.remove("on"); });
mini.addEventListener("click", () => out.scrollIntoView({block: "start", behavior: reduced() ? "auto" : "smooth"}));

form.addEventListener("input", e => { if (e.target.name === "regime") return; if (e.target.id === "land" || e.target.id === "landU") landEcho(); if (e.target.id === "zone") zoneNote(); calcSoon(); });
form.addEventListener("change", e => { if (e.target.name === "regime") { syncRegime(); calcSoon(); } else if (e.target.tagName === "SELECT" || e.target.type === "checkbox") { if (e.target.id === "zone") zoneNote(); calcSoon(); } });
form.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.matches("input[type=number]")) { e.preventDefault(); calcSoon.cancel(); calc({scroll: true}).catch(() => {}); } });
form.addEventListener("submit", e => { e.preventDefault(); calcSoon.cancel(); calc({scroll: true}).catch(() => {}); });

async function fill(i) {
  await ensure();
  if (!i) return;
  form.elements.regime.value = i.regime === "uda2021" ? "uda2021" : "cmc2008"; syncRegime();
  if (i.zone) { $("#zone").value = i.zone; zoneNote(); }
  $("#zf").value = i.zone_factor ?? ""; $("#dens").value = i.density ?? "";
  $("#land").value = i.land_extent ?? ""; $("#landU").value = i.land_unit || "perch"; $("#road").value = i.road_width ?? ""; $("#roadU").value = i.road_unit || "m";
  $("#streetType").value = i.street_type || "public"; $("#hasBL").checked = i.has_building_line !== false; landEcho();
  calcSoon.cancel(); await calc({scroll: true});
}
on("far:fill", e => { fill(e.detail).catch(() => {}); });
$("#farExamples").addEventListener("click", e => { const b = e.target.closest("[data-ex]"); if (b) fill(EXAMPLES[+b.dataset.ex].i).catch(() => {}); });
$("#farReset").addEventListener("click", () => {
  form.reset(); if (FAR) $("#zone").value = "MD";
  syncRegime(); zoneNote(); landEcho(); calcSoon.cancel(); if (ctrl) ctrl.abort(); reqId++; pending("Enter the land extent and road width"); $("#land").focus();
});

out.addEventListener("click", e => {
  const a = e.target.closest("[data-act]"); if (!a || !last) return;
  const r = last, f = r.far;
  if (a.dataset.act === "copy") {
    const t = `FAR ${f.unlimited ? "unlimited" : farFmt(f.value)}${r.max_gfa_m2 != null ? ` - max floor area ${fmt(r.max_gfa_m2, 0)} m2 on ${fmt(r.inputs.net_area_m2, 1)} m2 net` : ""}\n${f.basis}\nRules: ${r.regime_name} (${r.citation})\n${r.status_note}\nGenerated ${new Date().toLocaleString("en-GB")} by ${BRAND()}. Confirm with the UDA or the local authority.`;
    copyText(t).then(ok => toast(ok ? "Copied" : "Couldn't copy"));
  }
  if (a.dataset.act === "print") window.print();
  if (a.dataset.act === "ask") { go("ask"); emit("ask:prefill", {text: `Explain this FAR result: ${f.basis}. What else should I check?`, mode: "answer"}); }
});

pending("Enter the land extent and road width");
