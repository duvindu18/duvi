// Entry point: theme, the sidebar (places, recent questions), the status bar, shortcuts, boot.
import {$, $$, esc, store, fmt, fmtTime, toast} from "./util.js";
import {go, start} from "./router.js";
import {on, emit, S} from "./state.js";
import {loadStatus} from "./status.js";
import "./reader.js";
import "./ask.js";
import "./far.js";
import "./library.js";
import "./ocr.js";
import "./update.js";
import "./settings.js";
import {reportTheme} from "./window.js";

const root = document.documentElement, mq = matchMedia("(prefers-color-scheme: dark)"), CB = window.CBAccent;

/* the page is a fixed frame: its height follows the visible window (so a phone keyboard shrinks it), and panes scroll inside it */
const setH = () => root.style.setProperty("--app-h", Math.floor(window.visualViewport ? window.visualViewport.height : innerHeight) + "px");
setH(); addEventListener("resize", setH); if (window.visualViewport) window.visualViewport.addEventListener("resize", setH);

/* ---------- theme: Dark (the default), Light or System ---------- */
const choice = () => { const t = store.get("ceylon-buildex-theme"); return t === "light" || t === "system" ? t : "dark"; };
const isDark = () => { const c = choice(); return c === "dark" || (c === "system" && mq.matches); };
function paintTheme() {
  const c = choice();
  if (c === "system") delete root.dataset.theme; else root.dataset.theme = c;
  const r = $(`input[name="theme"][value="${c}"]`); if (r) r.checked = true;
  const dark = isDark();
  const m = $('meta[name="theme-color"]'); if (m) m.content = dark ? "#0b0b0d" : "#f3f3f1";
  $("#themeUse").setAttribute("href", dark ? "#i-sun" : "#i-moon");
  $("#themeBtn").setAttribute("aria-label", dark ? "Switch to the light theme" : "Switch to the dark theme");
  if (CB) { CB.apply(); paintAccent(); } else reportTheme(dark);
}
const setTheme = v => { store.set("ceylon-buildex-theme", v); paintTheme(); };
$("#themeBtn").addEventListener("click", () => setTheme(isDark() ? "light" : "dark"));

/* accent colour, chosen in Settings and remembered in this browser */
const sw = $("#accentSw");
if (CB && sw) {
  sw.innerHTML = Object.entries(CB.presets).map(([k, v]) => `<label class="sw" title="${v.n}"><input type="radio" name="accent" value="${k}"><span class="sr">${v.n}</span></label>`).join("") +
    `<label class="sw custom" title="Pick your own"><input type="color" id="accentCustom" value="#f4481f" aria-label="Custom accent colour"></label>`;
  $$('input[name="accent"]', sw).forEach(r => r.addEventListener("change", () => { CB.save(r.value); paintAccent(); }));
  $("#accentCustom").addEventListener("input", e => { CB.save(e.target.value); paintAccent(); });
}
function paintAccent() {
  if (!CB || !sw) return;
  const v = CB.get(), custom = CB.isCustom(v);
  $$(".sw", sw).forEach(l => { const r = $("input[name=accent]", l); if (r) { l.style.setProperty("--c", CB.hex(r.value)); r.checked = r.value === v; } });
  const cl = $(".sw.custom", sw); cl.classList.toggle("on", custom); cl.style.setProperty("--c", custom ? v : "#f4481f");
  if (custom) $("#accentCustom").value = v;
  reportTheme(isDark());
}
$$('input[name="theme"]').forEach(r => r.addEventListener("change", () => setTheme(r.value)));
mq.addEventListener("change", paintTheme);
paintTheme();

/* ---------- sidebar ---------- */
const side = $("#side"), scrim = $("#scrim"), menu = $("#menuBtn"), narrow = matchMedia("(max-width: 860px)");
function drawer(open) {
  side.classList.toggle("open", open); scrim.hidden = !open; menu.setAttribute("aria-expanded", String(open));
  if (open) { const b = $(".nav button[aria-current]", side) || $(".nav button", side); b.focus({preventScroll: true}); }
}
menu.addEventListener("click", () => drawer(!side.classList.contains("open")));
scrim.addEventListener("click", () => drawer(false));
document.addEventListener("keydown", e => { if (e.key === "Escape" && side.classList.contains("open")) { drawer(false); menu.focus(); } });
narrow.addEventListener("change", () => drawer(false));
function collapse(min) {
  root.classList.toggle("side-min", min); store.set("ceylon-buildex-side", min ? "1" : "0");
  const t = min ? "Expand the sidebar" : "Collapse the sidebar"; $("#sideToggle").setAttribute("aria-label", t); $("#sideToggle").title = t;
}
$("#sideToggle").addEventListener("click", () => collapse(!root.classList.contains("side-min")));
collapse(root.classList.contains("side-min"));
$$(".nav button[data-view]").forEach(b => b.addEventListener("click", () => { go(b.dataset.view); if (narrow.matches) drawer(false); }));
document.addEventListener("click", e => { const g = e.target.closest("[data-goto]"); if (g) { go(g.dataset.goto); if (narrow.matches) drawer(false); } });
const fresh = () => { emit("ask:new"); if (narrow.matches) drawer(false); };
$("#newQ").addEventListener("click", fresh);
$("#topNew").addEventListener("click", fresh);

/* recent questions: kept in this browser, newest first */
const RKEY = "ceylon-buildex-recent", rlist = $("#recentList");
const recent = () => { try { const a = JSON.parse(store.get(RKEY) || "[]"); return Array.isArray(a) ? a.filter(x => typeof x === "string").slice(0, 12) : []; } catch { return []; } };
function paintRecent() {
  const r = recent();
  rlist.innerHTML = r.map((q, i) => `<li><button type="button" data-recent="${i}" title="${esc(q)}"><svg class="i sm" aria-hidden="true"><use href="#i-history"/></svg><span>${esc(q)}</span></button></li>`).join("");
  $("#recentEmpty").hidden = r.length > 0; $("#recentClear").hidden = r.length === 0;
}
on("ask:asked", e => { const q = String(e.detail || "").trim(); if (!q) return; store.set(RKEY, JSON.stringify([q, ...recent().filter(x => x !== q)].slice(0, 12))); paintRecent(); });
rlist.addEventListener("click", e => { const b = e.target.closest("[data-recent]"); if (!b) return; const q = recent()[+b.dataset.recent]; if (q) { emit("ask:run", q); if (narrow.matches) drawer(false); } });
$("#recentClear").addEventListener("click", () => { store.set(RKEY, "[]"); paintRecent(); toast("Recent questions cleared"); });
paintRecent();

/* ---------- status bar: what the program knows right now ---------- */
on("status", () => {
  const s = S.status; if (!s) return;
  const d = s.dataset || {}, o = s.ocr || {}, l = s.llm || {};
  $("#sbDataTxt").textContent = `${fmt(d.documents || 0, 0)} documents · ${fmt(d.chunks || 0, 0)} passages`;
  $("#sbOcrTxt").textContent = o.available ? `OCR · ${(o.languages || []).join(", ") || "eng"}` : "OCR not installed";
  $("#sbOcr").classList.toggle("warn", !o.available);
  $("#sbModelTxt").textContent = l.provider === "none" ? "Quoting passages" : String(l.model || "Language model");
  $("#sbModel").classList.toggle("ok", l.provider !== "none");
  $("#sbModel").title = l.provider === "none" ? "No language model writes the answers: open Settings to add one" : `Answers are written by ${l.model}`;
  if (!($("#sbUpd").classList.contains("busy"))) $("#sbUpdTxt").textContent = d.last_update ? `Updated ${fmtTime(d.last_update)}` : "Never updated";
  $("#sbVer").textContent = "v" + (s.version || "");
});
on("status:error", () => { $("#sbDataTxt").textContent = "Server not reachable"; $("#sbData").classList.add("warn"); });
on("update:running", e => {
  const run = !!e.detail; $("#sbUpd").classList.toggle("busy", run);
  if (run) $("#sbUpdTxt").textContent = "Updating…";
  else { const d = S.status && S.status.dataset; $("#sbUpdTxt").textContent = d && d.last_update ? `Updated ${fmtTime(d.last_update)}` : "Never updated"; }
});

/* "/" jumps to the question box from anywhere */
document.addEventListener("keydown", e => {
  if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
  const a = document.activeElement;
  if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return;
  if (document.querySelector("dialog[open]")) return;
  e.preventDefault(); go("ask"); $("#q").focus();
});

start();
loadStatus().then(st => {
  // when this page is the window of the desktop program, tell it we are here, so it can close itself when the window is gone
  if (!st || !st.heartbeat) return;
  const ping = () => fetch("/api/ping", {method: "POST", keepalive: true}).catch(() => {});
  ping(); setInterval(ping, 15000);
  addEventListener("pagehide", () => { try { navigator.sendBeacon("/api/bye"); } catch (e) { /* closing anyway */ } });
});
