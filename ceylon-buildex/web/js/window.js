// Title-bar buttons of the desktop program. The window (desktop/preload.js) provides window.cbDesktop; in a browser it is absent and the buttons stay hidden.
import {$} from "./util.js";

const w = window.cbDesktop;
if (w) {
  const root = document.documentElement, box = $("#winctl"), max = $('[data-win="maximize"]'), use = $("#winMaxUse");
  box.hidden = false;
  box.addEventListener("click", e => {
    const b = e.target.closest("[data-win]");
    if (b) w[b.dataset.win]();
  });
  const paint = s => {
    root.classList.toggle("win-max", !!s.maximized);
    root.classList.toggle("win-blur", !s.focused);
    use.setAttribute("href", s.maximized ? "#i-win-restore" : "#i-win-max");
    const label = s.maximized ? "Restore" : "Maximize";
    max.title = label; max.setAttribute("aria-label", label);
  };
  w.onState(paint);
  w.state().then(paint);
}

/* the window paints these colours before the page is there, so the next start opens in the right theme and accent without a flash */
export const reportTheme = dark => {
  if (w) w.theme(dark, getComputedStyle(document.documentElement).getPropertyValue("--orange").trim());
};
