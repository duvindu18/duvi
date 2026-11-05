/* Studio Morfis — admin panel behaviour (vanilla JS) */
(function () {
  "use strict";

  /* Repeatable rows: add / remove / move */
  document.querySelectorAll("[data-repeater], [data-figures]").forEach(function (box) {
    var rows = box.querySelector("[data-rows]");
    var tpl = box.querySelector("template[data-template]");
    var add = box.querySelector("[data-add]");
    if (add && tpl) {
      add.addEventListener("click", function () {
        var key = "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        var html = tpl.innerHTML.replace(/__KEY__/g, key);
        var holder = document.createElement("div");
        holder.innerHTML = html.trim();
        var row = holder.firstElementChild;
        rows.appendChild(row);
        var first = row.querySelector("input, textarea");
        if (first) first.focus();
        markDirty();
      });
    }
    box.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-up], [data-down], [data-remove]");
      if (!btn) return;
      var row = btn.closest("[data-row]");
      if (!row) return;
      if (btn.hasAttribute("data-remove")) row.remove();
      else if (btn.hasAttribute("data-up") && row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling);
      else if (btn.hasAttribute("data-down") && row.nextElementSibling) row.parentNode.insertBefore(row.nextElementSibling, row);
      relabelCover(box);
      markDirty();
    });
    box.addEventListener("change", function (e) {
      if (e.target.matches('input[type="checkbox"][name$="[remove]"]')) {
        e.target.closest("[data-row]").classList.toggle("is-removing", e.target.checked);
      }
    });
  });

  /* Keep the "cover image" note on the first figure */
  function relabelCover(box) {
    if (!box.hasAttribute("data-figures")) return;
    box.querySelectorAll(".fig-row").forEach(function (row, i) {
      var span = row.querySelector(".rep-cell > span");
      if (span) span.textContent = "Caption" + (i === 0 ? " · cover image" : "");
    });
  }

  /* Thumbnails for chosen files before upload */
  document.querySelectorAll("[data-file-preview]").forEach(function (input) {
    input.addEventListener("change", function () {
      var preview = input.closest(".drop").nextElementSibling;
      if (!preview || !preview.hasAttribute("data-preview")) return;
      preview.innerHTML = "";
      Array.prototype.forEach.call(input.files || [], function (file) {
        if (!/^image\//.test(file.type)) return;
        var img = document.createElement("img");
        img.alt = file.name;
        img.src = URL.createObjectURL(file);
        preview.appendChild(img);
      });
    });
  });

  /* Web address follows the title until it is edited by hand */
  var title = document.querySelector("[data-slug-source]");
  var slug = document.querySelector("[data-slug-target]");
  var preview = document.querySelector("[data-slug-preview]");
  function slugify(s) {
    return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  if (title && slug) {
    var manual = slug.value !== "" && slug.value !== slugify(title.value);
    title.addEventListener("input", function () {
      if (!manual) slug.value = slugify(title.value);
      if (preview) preview.textContent = slug.value || slugify(title.value);
    });
    slug.addEventListener("input", function () {
      manual = slug.value !== "";
      slug.value = slug.value.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      if (preview) preview.textContent = slug.value || slugify(title.value);
    });
  }

  /* Confirm destructive actions */
  document.querySelectorAll("form[data-confirm]").forEach(function (form) {
    form.addEventListener("submit", function (e) {
      if (!window.confirm(form.getAttribute("data-confirm"))) e.preventDefault();
    });
  });

  /* Warn before leaving a form with unsaved changes */
  var dirty = false;
  function markDirty() { dirty = true; }
  document.querySelectorAll("form[data-dirty-guard]").forEach(function (form) {
    form.addEventListener("input", markDirty);
    form.addEventListener("change", markDirty);
    form.addEventListener("submit", function () {
      dirty = false;
      var btns = form.querySelectorAll('button[type="submit"]');
      btns.forEach(function (b) { b.textContent = "Saving…"; });
      setTimeout(function () { btns.forEach(function (b) { b.disabled = true; }); }, 0);
    });
  });
  window.addEventListener("beforeunload", function (e) {
    if (dirty) { e.preventDefault(); e.returnValue = ""; }
  });

  /* Mobile menu */
  var menuBtn = document.querySelector("[data-adm-menu]");
  var nav = document.getElementById("adm-nav");
  if (menuBtn && nav) {
    menuBtn.addEventListener("click", function () {
      var open = nav.classList.toggle("is-open");
      menuBtn.setAttribute("aria-expanded", String(open));
      var end = document.querySelector(".adm-top__end");
      if (end) end.classList.toggle("is-open", open);
    });
  }
})();
