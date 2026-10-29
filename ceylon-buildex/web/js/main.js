// Entry point: theme, navigation, shortcuts, boot.
import {$, $$, store} from "./util.js";
import {go, start} from "./router.js";
import {on} from "./state.js";
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
const setH = () => {
  root.style.setProperty("--app-h", Math.round(window.visualViewport ? window.visualViewport.height : innerHeight) + "px");
};
setH(); addEventListener("resize", setH); if (window.visualViewport) window.visualViewport.addEventListener("resize", setH);
(() => { // measure this browser's slim scrollbar so content lines up with the header whether or not a bar is showing
  const d = document.createElement("div"); d.style.cssText = "position:absolute;top:-999px;width:100px;height:100px;overflow:scroll;scrollbar-width:thin";
  document.body.append(d); root.style.setProperty("--sbw", (d.offsetWidth - d.clientWidth) + "px"); d.remove();
})();
on("view", () => $(".bar").classList.remove("sep"));   // a page opens scrolled to its top
$("#main").addEventListener("scroll", e => { if (e.target.scrollTop !== undefined) $(".bar").classList.toggle("sep", e.target.scrollTop > 4); }, true);

/* theme: System / Light / Dark, chosen in Settings */
const choice = () => { const t = store.get("ceylon-buildex-theme"); return t === "light" || t === "dark" ? t : "system"; };
function paintTheme() {
  const c = choice();
  if (c === "system") delete root.dataset.theme; else root.dataset.theme = c;
  const r = $(`input[name="theme"][value="${c}"]`); if (r) r.checked = true;
  const dark = c === "dark" || (c === "system" && mq.matches);
  const m = $('meta[name="theme-color"]'); if (m) m.content = dark ? "#0e0e11" : "#f6eee3";
  if (CB) { CB.apply(); paintAccent(); } else reportTheme(dark);
}

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
  reportTheme(root.dataset.theme === "dark" || (!root.dataset.theme && mq.matches));
}
$$('input[name="theme"]').forEach(r => r.addEventListener("change", () => { store.set("ceylon-buildex-theme", r.value); paintTheme(); }));
mq.addEventListener("change", paintTheme);
paintTheme();

/* navigation */
$$(".tabs button[data-view]").forEach(b => b.addEventListener("click", () => go(b.dataset.view)));
document.addEventListener("click", e => { const g = e.target.closest("[data-goto]"); if (g) go(g.dataset.goto); });

/* "/" jumps to the search box from anywhere */
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
