// Shared helpers: DOM, formatting, API access, small UI utilities. No dependencies.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
export const fmt = (n, d = 2) => n == null ? "—" : Number(n).toLocaleString("en-GB", {maximumFractionDigits: d});
export const farFmt = v => v == null ? "—" : Number(v).toLocaleString("en-GB", {minimumFractionDigits: 1, maximumFractionDigits: 3});
export const took = ms => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
export const icon = (name, cls = "") => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
export const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
export const BRAND = () => ($(".brand-name") || {}).textContent || "Ceylon Buildex";

export const CATS = [
  ["all", "All sources"], ["building-regulations", "Building regulations"], ["development-plans", "Development plans"],
  ["gazette", "Gazettes"], ["procurement-sbd", "Bidding documents (SBD)"], ["procurement-policy", "Procurement guidelines"], ["legislation", "Legislation"],
];
export const CAT = {"building-regulations": "Building regulations", "development-plans": "Development plans", "procurement-sbd": "SBD",
  "procurement-policy": "Procurement guidelines", "legislation": "Legislation", "gazette": "Gazette", "other": "Other"};
export const fillCats = (sel, first) => { sel.innerHTML = (first ? `<option value="">${esc(first)}</option>` : "") + CATS.filter(c => first ? c[0] !== "all" : true).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join(""); };

export class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
export async function api(path, opt = {}) {
  let r;
  try { r = await fetch(path, opt); }
  catch (e) { if (e.name === "AbortError") throw e; throw new ApiError("Can't reach the server. Check that it is still running.", 0); }
  let j = null; try { j = await r.json(); } catch { /* non-JSON body */ }
  if (!r.ok) throw new ApiError((j && j.error) || `Request failed (${r.status})`, r.status);
  return j;
}
export const post = (p, body, opt = {}) => api(p, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body), ...opt});
export async function pollTask(id, onProgress, every = 700) {
  for (;;) {
    const t = await api("/api/task/" + id);
    if (onProgress) onProgress(t);
    if (t.status !== "running") return t;
    await new Promise(r => setTimeout(r, every));
  }
}

export const debounce = (fn, ms) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.cancel = () => clearTimeout(t); return d; };
export const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};
export async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; }
  catch {
    const ta = document.createElement("textarea"); ta.value = t; ta.style.cssText = "position:fixed;opacity:0"; document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch { /* ignore */ }
    ta.remove(); return ok;
  }
}
let toastT;
export function toast(msg) { const el = $("#toast"); el.textContent = msg; el.classList.add("on"); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("on"), 2200); }
export function announce(msg) { const el = $("#announce"); el.textContent = ""; setTimeout(() => { el.textContent = msg; }, 40); }

export function tags(d) {
  let h = "";
  if (d.status) h += `<span class="tag ${esc(d.status)}">${esc(d.status.replace("-", " "))}</span>`;
  if (d.origin === "seed-extract") h += `<span class="tag seed" title="A verified summary, not the full text">seed extract</span>`;
  else if (d.origin) h += `<span class="tag full">${d.origin === "upload" ? "uploaded" : "full text"}</span>`;
  return h;
}
export function hl(text, q) {
  let h = esc(text); if (!q) return h;
  q.split(/\s+/).filter(w => w.length > 1).forEach(w => { h = h.replace(new RegExp("(" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi"), "<mark>$1</mark>"); });
  return h;
}
// Small, safe markdown subset used by the answer writer: **bold**, ==key fact==, `code`, lists, ### headings, [S#] citations.
export function md(text, cites) {
  let t = esc(text);
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/`([^`\n]+)`/g, "<code>$1</code>");
  let k = 0;                                   // ==key facts== become highlighter marks, swept in one after another
  t = t.replace(/==([^=\n]+?)==/g, (m, x) => `<mark class="hl" style="--k:${k++}">${x}</mark>`);
  const bullet = l => /^\s*[-*•]\s+/.test(l), strip = l => l.replace(/^\s*[-*•]\s+/, "");
  const blocks = t.split(/\n{2,}/).map(b => {
    if (/^#{1,3}\s/.test(b)) return "<h3>" + b.replace(/^#{1,3}\s*/, "") + "</h3>";
    const out = []; let para = [], items = [];
    const flushP = () => { if (para.length) out.push("<p>" + para.join("<br>") + "</p>"); para = []; };
    const flushL = () => { if (items.length) out.push("<ul>" + items.map(i => "<li>" + i + "</li>").join("") + "</ul>"); items = []; };
    b.split("\n").forEach(l => { if (bullet(l)) { flushP(); items.push(strip(l)); } else { flushL(); para.push(l); } });
    flushP(); flushL();
    return out.join("");
  }).join("");
  return blocks.replace(/\[S(\d+)\]/g, (m, n) => {
    const c = cites && cites[+n - 1];
    return c ? `<button type="button" class="cite" data-cite="${n}" title="${esc(c.title)}" aria-label="Source ${n}: ${esc(c.title)}">${n}</button>` : "";
  });
}
export const fmtDate = iso => { try { return new Date(iso).toLocaleDateString("en-GB", {day: "numeric", month: "short", year: "numeric"}); } catch { return ""; } };
export const fmtTime = iso => { try { return new Date(iso).toLocaleString("en-GB", {day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"}); } catch { return ""; } };
