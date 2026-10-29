// Hash routing between the five views. Back/forward work; the old #search link maps to Ask.
import {$, $$} from "./util.js";
import {emit} from "./state.js";

export const VIEWS = ["ask", "far", "library", "ocr", "update"];
const TITLES = {ask: "Ask", far: "Floor area ratio", library: "Library", ocr: "Scan", update: "Update"};
let cur = null;
export const current = () => cur;

const fromHash = () => {
  const v = (location.hash || "#ask").slice(1);
  return VIEWS.includes(v) ? v : "ask";
};

function show(view, focus) {
  if (view === cur) return;
  cur = view;
  $$(".view").forEach(v => v.classList.toggle("on", v.id === "view-" + view));
  $$(".tabs button[data-view]").forEach(b => { if (b.dataset.view === view) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  const brand = ($(".brand-name") || {}).textContent || "Ceylon Buildex";
  document.title = (view === "ask" ? brand : TITLES[view] + " · " + brand);
  const pane = $("#view-" + view); if (pane) pane.scrollTop = 0;
  $$("#view-" + view + " .col").forEach(c => { c.scrollTop = 0; });
  emit("view", view);
  if (focus) { const h = $("#view-" + view + " h1"); if (h) h.focus({preventScroll: true}); }
}

export function go(view) {
  if (!VIEWS.includes(view)) view = "ask";
  if (location.hash !== "#" + view) location.hash = view; // hashchange does the rest
  else show(view, true);
}
window.addEventListener("hashchange", () => show(fromHash(), true));
export const start = () => show(fromHash(), false);
