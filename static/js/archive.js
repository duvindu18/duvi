/* ==========================================================================
   Halde — Index page: filter, sort, hover-dim and floating image preview
   ========================================================================== */
(function () {
  "use strict";

  function init() {
    var list = document.querySelector("[data-rows]");
    if (!list) return;
    var items = Array.prototype.slice.call(list.children);
    var count = document.querySelector("[data-count]");
    var total = items.length;
    var filter = "";
    var sort = "year";

    /* ---- filter + sort -------------------------------------------------- */
    function apply() {
      var shown = 0;
      items.forEach(function (li) {
        var match = !filter || li.getAttribute("data-typology") === filter;
        li.hidden = !match;
        if (match) shown++;
      });
      var sorted = items.slice().sort(function (a, b) {
        if (sort === "year") return Number(b.dataset.year) - Number(a.dataset.year);
        return a.dataset[sort].localeCompare(b.dataset[sort]);
      });
      sorted.forEach(function (li, i) {
        li.style.setProperty("--i", i);
        li.style.animation = "none";
        void li.offsetHeight; // restart the row-in animation
        li.style.animation = "";
        li.style.animationDelay = i * 0.03 + "s";
        list.appendChild(li);
      });
      if (count) {
        count.textContent = String(shown).padStart(2, "0") + " / " + String(total).padStart(2, "0") + " entries";
      }
    }

    function press(group, btn) {
      document.querySelectorAll(group).forEach(function (b) { b.setAttribute("aria-pressed", String(b === btn)); });
    }

    document.querySelectorAll("[data-filter]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        filter = btn.getAttribute("data-filter");
        press("[data-filter]", btn);
        apply();
      });
    });
    document.querySelectorAll("[data-sort]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        sort = btn.getAttribute("data-sort");
        press("[data-sort]", btn);
        apply();
      });
    });

    /* ---- hover dim + floating preview ---------------------------------- */
    var box = document.querySelector("[data-preview-box]");
    var tag = document.querySelector("[data-preview-tag]");
    var imgs = box ? Array.prototype.slice.call(box.querySelectorAll("img")) : [];
    var fine = window.Halde && window.Halde.finePointer;

    var x = 0, y = 0, px = 0, py = 0, raf = 0, placed = false;
    function loop() {
      // Soft spring toward the pointer.
      px += (x - px) * 0.18;
      py += (y - py) * 0.18;
      var h = box.offsetHeight;
      box.style.transform = "translate3d(" + (px + 32) + "px," + (py - h / 2) + "px,0)";
      raf = Math.abs(x - px) + Math.abs(y - py) > 0.2 ? requestAnimationFrame(loop) : 0;
    }

    function show(slug) {
      list.classList.add("has-hover");
      list.querySelectorAll(".row").forEach(function (r) {
        r.classList.toggle("is-hover", r.getAttribute("data-preview") === slug);
      });
      if (!box || !fine) return;
      imgs.forEach(function (img) {
        var on = img.getAttribute("data-slug") === slug;
        img.classList.toggle("is-current", on);
        if (on && tag) tag.textContent = img.getAttribute("data-tag");
      });
      box.classList.add("is-on");
    }
    function hide() {
      list.classList.remove("has-hover");
      list.querySelectorAll(".row.is-hover").forEach(function (r) { r.classList.remove("is-hover"); });
      if (box) box.classList.remove("is-on");
    }

    list.querySelectorAll(".row").forEach(function (row) {
      var slug = row.getAttribute("data-preview");
      row.addEventListener("pointerenter", function () { show(slug); });
      row.addEventListener("focus", function () { show(slug); });
      row.addEventListener("blur", hide);
    });
    list.addEventListener("pointerleave", hide);

    if (box && fine) {
      window.addEventListener("pointermove", function (e) {
        x = e.clientX; y = e.clientY;
        if (!placed) { px = x; py = y; placed = true; } // first move: no fly-in from 0,0
        if (!raf) raf = requestAnimationFrame(loop);
      }, { passive: true });
      // Warm the cache so swaps are instant.
      imgs.forEach(function (img) { img.loading = "eager"; });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
