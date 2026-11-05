/* ==========================================================================
   Studio Morfis — home page: inertia horizontal track
   Desktop (≥1024px): vertical wheel / trackpad input is mapped to horizontal
   travel, eased with a lerp, and snapped to the nearest [data-snap] panel when
   input settles. Arrow keys / PageUp / PageDown / Space step between panels.
   Below 1024px the page simply scrolls vertically.
   ========================================================================== */
(function () {
  "use strict";

  function init() {
    var track = document.querySelector("[data-track]");
    if (!track) return;

    var desktop = window.matchMedia("(min-width: 1024px)");
    var reduce = window.Morfis && window.Morfis.reduceMotion;
    var bar = document.querySelector("[data-progress]");
    var cols = document.querySelectorAll(".mosaic__col");
    var panels = document.querySelectorAll(".p-panel");

    var target = track.scrollLeft;
    var current = target;
    var raf = 0;
    var idle = 0;
    var driving = false;

    function max() { return track.scrollWidth - track.clientWidth; }
    function clamp(v) { return Math.max(0, Math.min(max(), v)); }

    function snapPoints() {
      var m = max();
      var pts = Array.prototype.map.call(track.querySelectorAll("[data-snap]"), function (el) {
        return Math.min(el.offsetLeft, m);
      });
      pts.push(m);
      return pts.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });
    }

    /* Scroll-linked visuals: progress hairline + mosaic column drift */
    function paint() {
      var m = max();
      var p = m > 0 ? track.scrollLeft / m : 0;
      if (bar) bar.style.transform = "scaleX(" + p.toFixed(4) + ")";
      var local = Math.min(1, p / 0.5);
      cols.forEach(function (col, i) {
        var from = i % 2 ? 4 : -6, to = i % 2 ? -10 : 4;
        col.style.transform = desktop.matches ? "translate3d(0," + (from + (to - from) * local).toFixed(2) + "%,0)" : "";
      });
    }

    function loop() {
      current += (target - current) * (reduce ? 1 : 0.085);
      if (Math.abs(target - current) < 0.5) current = target;
      driving = true;
      track.scrollLeft = current;
      paint();
      if (current !== target) raf = requestAnimationFrame(loop);
      else {
        raf = 0;
        requestAnimationFrame(function () { driving = false; });
      }
    }
    function kick() {
      target = clamp(target);
      if (!raf) raf = requestAnimationFrame(loop);
    }
    function snap() {
      var pts = snapPoints();
      target = pts.reduce(function (a, b) { return Math.abs(b - target) < Math.abs(a - target) ? b : a; }, pts[0]);
      kick();
    }
    function go(dir) {
      var pts = snapPoints();
      var next = dir > 0
        ? pts.find(function (p) { return p > target + 4; })
        : pts.slice().reverse().find(function (p) { return p < target - 4; });
      if (next !== undefined) { target = next; kick(); }
    }

    track.addEventListener("wheel", function (e) {
      if (!desktop.matches || e.ctrlKey) return;
      e.preventDefault();
      var d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      target = clamp(target + d * (e.deltaMode === 1 ? 32 : 1) * 1.15);
      kick();
      clearTimeout(idle);
      idle = setTimeout(snap, 180);
    }, { passive: false });

    // Native scrolling (touch, focus, scrollbar) resyncs the lerp.
    track.addEventListener("scroll", function () {
      if (!driving) current = target = track.scrollLeft;
      paint();
    }, { passive: true });

    window.addEventListener("keydown", function (e) {
      if (!desktop.matches) return;
      var tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowRight" || e.key === "PageDown" || (e.key === " " && !e.shiftKey)) { e.preventDefault(); go(1); }
      else if (e.key === "ArrowLeft" || e.key === "PageUp" || (e.key === " " && e.shiftKey)) { e.preventDefault(); go(-1); }
    });
    window.addEventListener("resize", function () { target = clamp(target); kick(); paint(); });

    var prev = document.querySelector("[data-prev]");
    var next = document.querySelector("[data-next]");
    if (prev) prev.addEventListener("click", function () { go(-1); });
    if (next) next.addEventListener("click", function () { go(1); });

    /* Project panels: hovered / focused panel becomes the active image panel */
    panels.forEach(function (panel) {
      function activate() {
        panels.forEach(function (p) { p.classList.toggle("is-active", p === panel); });
      }
      panel.addEventListener("mouseenter", activate);
      panel.addEventListener("focus", activate);
    });

    paint();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
