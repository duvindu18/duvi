/* ==========================================================================
   Studio Morfis — shared behaviour for every page (vanilla JS, no dependencies)
   - Splash screen (marquee bands + rolling counter, once per session)
   - Page curtain transitions between internal links
   - "Ready" lifecycle that gates entrance animations
   - Line reveals / fade-ins on scroll (IntersectionObserver)
   - Image fade-in on load, scroll parallax
   - Light / dark theme switch, live year values, mobile menu, cursor label
   ========================================================================== */
(function () {
  "use strict";

  var root = document.documentElement;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  var SPLASH_KEY = "morfis:splash";

  /* ---------------------------------------------------------------------
     Ready lifecycle: other scripts call Morfis.onReady(fn). It fires once the
     splash has lifted (or immediately if the splash was already seen).
     ------------------------------------------------------------------- */
  var ready = false;
  var readyQueue = [];
  window.Morfis = {
    onReady: function (fn) {
      if (ready) fn();
      else readyQueue.push(fn);
    },
    reduceMotion: reduceMotion,
    finePointer: finePointer,
  };
  function setReady() {
    if (ready) return;
    ready = true;
    root.classList.add("is-ready");
    readyQueue.splice(0).forEach(function (fn) { fn(); });
  }

  /* --------------------------------------------------------------------- Splash */
  function runSplash() {
    var splash = document.getElementById("splash");
    if (!splash || root.hasAttribute("data-splash-seen")) {
      if (splash) splash.remove();
      setReady();
      return;
    }

    root.style.overflow = "hidden";
    var strips = splash.querySelectorAll(".counter .strip");
    var loaded = document.readyState === "complete";
    window.addEventListener("load", function () { loaded = true; });

    var duration = reduceMotion ? 600 : 2600;
    var start = performance.now();

    function render(value) {
      var digits = String(value).padStart(3, "0").split("");
      strips.forEach(function (strip, i) {
        strip.style.transform = "translateY(-" + Number(digits[i]) + "em)";
      });
    }

    function tick(now) {
      var t = Math.min(1, (now - start) / duration);
      var eased = 1 - Math.pow(1 - t, 3);
      // Hold at 90% until the window has really finished loading.
      var value = Math.round((loaded ? eased : Math.min(eased, 0.9)) * 100);
      render(value);
      if (value < 100) return requestAnimationFrame(tick);

      setTimeout(function () {
        splash.classList.add("is-settle"); // bands part, wordmark resolves
        setTimeout(function () {
          splash.classList.add("is-exit"); // sheet lifts away
          setTimeout(function () {
            splash.remove();
            root.style.overflow = "";
            try { sessionStorage.setItem(SPLASH_KEY, "1"); } catch (e) {}
            setReady();
          }, reduceMotion ? 0 : 1100);
        }, reduceMotion ? 0 : 1100);
      }, 250);
    }
    requestAnimationFrame(tick);
  }

  /* --------------------------------------------------------------------- Curtain */
  function initCurtain() {
    // Lift the curtain on arrival.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { root.classList.add("is-loaded"); });
    });

    // Back/forward cache: make sure the page isn't left covered.
    window.addEventListener("pageshow", function (e) {
      if (e.persisted) root.classList.remove("is-leaving", "is-leaving-go");
    });

    if (reduceMotion) return;

    document.addEventListener("click", function (e) {
      var a = e.target.closest("a[href]");
      if (!a || e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      if (a.target === "_blank" || a.hasAttribute("download")) return;
      var href = a.getAttribute("href");
      if (!href || href.charAt(0) === "#" || /^(mailto|tel):/i.test(href)) return;
      var url = new URL(a.href, location.href);
      if (url.origin !== location.origin && location.protocol !== "file:") return;
      if (url.pathname === location.pathname && url.hash) return;

      e.preventDefault();
      root.classList.add("is-leaving");
      // Force a reflow so the curtain starts from below, then animate it up.
      void document.getElementById("curtain").offsetHeight;
      root.classList.add("is-leaving-go");
      setTimeout(function () { location.href = a.href; }, 650);
    });
  }

  /* --------------------------------------------------------------------- Reveals */
  function initReveals() {
    var targets = document.querySelectorAll("[data-reveal], [data-animate], [data-inview], [data-mosaic]");
    if (!("IntersectionObserver" in window)) {
      targets.forEach(function (el) { el.classList.add("is-in"); });
      return;
    }
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            io.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.01 }
    );
    // Elements already on screen reveal immediately. (A fully clipped element,
    // e.g. the mosaic's clip-path wipe, never reports as intersecting.)
    var vw = window.innerWidth, vh = window.innerHeight;
    targets.forEach(function (el) {
      var r = el.getBoundingClientRect();
      var onScreen = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
      if (onScreen) el.classList.add("is-in");
      else io.observe(el);
    });
    // Panels in the horizontal home track scroll sideways; reveal them as the track moves.
    var track = document.querySelector("[data-track]");
    if (track) {
      track.addEventListener("scroll", function () {
        targets.forEach(function (el) {
          if (el.classList.contains("is-in")) return;
          var r = el.getBoundingClientRect();
          if (r.left < window.innerWidth && r.right > 0) el.classList.add("is-in");
        });
      }, { passive: true });
    }
  }

  /* --------------------------------------------------------------------- Images */
  function initImages() {
    document.querySelectorAll(".frame img").forEach(function (img) {
      if (img.complete && img.naturalWidth) img.classList.add("is-loaded");
      else img.addEventListener("load", function () { img.classList.add("is-loaded"); }, { once: true });
    });
  }

  /* --------------------------------------------------------------------- Parallax */
  function initParallax() {
    var items = Array.prototype.slice.call(document.querySelectorAll("[data-parallax]"));
    if (!items.length || reduceMotion) return;
    var ticking = false;

    function update() {
      ticking = false;
      var vh = window.innerHeight;
      items.forEach(function (el) {
        var box = el.parentElement.getBoundingClientRect();
        if (box.bottom < -100 || box.top > vh + 100) return;
        var progress = (vh - box.top) / (vh + box.height); // 0 → 1 while passing
        var strength = parseFloat(el.getAttribute("data-parallax")) || 9;
        var y = (progress * 2 - 1) * strength;
        el.style.transform = "translate3d(0," + y.toFixed(2) + "%,0)";
      });
    }
    function request() {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }
    window.addEventListener("scroll", request, { passive: true });
    window.addEventListener("resize", request);
    update();
  }

  /* --------------------------------------------------------------------- Years */
  // Keep "current year" and "years of experience" values up to date in pages
  // that were generated earlier (e.g. 2020 — 2026, "6 years").
  function initYears() {
    var y = new Date().getFullYear();
    document.querySelectorAll("[data-now-year]").forEach(function (el) { el.textContent = y; });
    document.querySelectorAll("[data-now-yy]").forEach(function (el) { el.textContent = String(y).slice(-2); });
    var words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
      "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
    document.querySelectorAll("[data-years-since]").forEach(function (el) {
      var from = parseInt(el.getAttribute("data-years-since"), 10);
      if (!from) return;
      var n = Math.max(1, y - from);
      el.textContent = el.hasAttribute("data-words") && words[n] ? words[n] : n;
    });
  }

  /* --------------------------------------------------------------------- Theme */
  // Light / dark switch. With no saved choice the page follows the system
  // (prefers-color-scheme); a click saves an explicit choice in localStorage.
  function initTheme() {
    var toggles = document.querySelectorAll("[data-theme-toggle]");
    if (!toggles.length) return;
    var system = window.matchMedia("(prefers-color-scheme: dark)");

    function isDark() {
      var t = root.getAttribute("data-theme");
      return t ? t === "dark" : system.matches;
    }
    function sync() {
      var dark = isDark();
      toggles.forEach(function (btn) {
        btn.setAttribute("aria-pressed", String(dark));
        var label = btn.querySelector("[data-theme-label]");
        if (label) label.textContent = dark ? "Light mode" : "Dark mode";
      });
    }
    toggles.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var next = isDark() ? "light" : "dark";
        root.setAttribute("data-theme", next);
        try { localStorage.setItem("morfis:theme", next); } catch (e) {}
        sync();
      });
    });
    if (system.addEventListener) system.addEventListener("change", sync);
    // The host page may also set data-theme on the root; keep the labels honest.
    new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    sync();
  }

  /* --------------------------------------------------------------------- Mobile menu */
  function initMenu() {
    var btn = document.querySelector("[data-menu-toggle]");
    var menu = document.getElementById("mobile-menu");
    if (!btn || !menu) return;
    var label = btn.querySelector("[data-menu-label]");
    function set(open) {
      btn.setAttribute("aria-expanded", String(open));
      menu.classList.toggle("is-open", open);
      if (label) label.textContent = open ? "Close" : "Menu";
      root.style.overflow = open ? "hidden" : "";
    }
    btn.addEventListener("click", function () {
      set(btn.getAttribute("aria-expanded") !== "true");
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") set(false);
    });
  }

  /* --------------------------------------------------------------------- Cursor label */
  function initCursor() {
    var el = document.querySelector(".cursor-label");
    if (!el || !finePointer) return;
    var x = -100, y = -100, cx = -100, cy = -100, raf = 0, current = null;

    function loop() {
      cx += (x - cx) * 0.35;
      cy += (y - cy) * 0.35;
      el.style.translate = (cx + 16) + "px " + (cy + 16) + "px";
      raf = Math.abs(x - cx) + Math.abs(y - cy) > 0.3 ? requestAnimationFrame(loop) : 0;
    }
    window.addEventListener("pointermove", function (e) {
      x = e.clientX; y = e.clientY;
      var target = e.target.closest && e.target.closest("[data-cursor]");
      var text = target ? target.getAttribute("data-cursor") : null;
      if (text !== current) {
        current = text;
        if (text) el.textContent = text;
        el.classList.toggle("is-on", !!text);
      }
      if (!raf) raf = requestAnimationFrame(loop);
    }, { passive: true });
    document.addEventListener("pointerleave", function () {
      current = null;
      el.classList.remove("is-on");
    });
  }

  /* --------------------------------------------------------------------- Boot */
  function boot() {
    initCurtain();
    initImages();
    initYears();
    initTheme();
    initMenu();
    initCursor();
    initParallax();
    runSplash();
    // Entrance animations wait until the splash is gone.
    window.Morfis.onReady(initReveals);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
