/* Accent colour. A classic script, loaded in <head> so the saved colour is on screen from the first paint.
   The choice is kept in this browser (localStorage). Presets have a deeper variant for light pages and a brighter one for dark pages;
   a custom colour is used as picked. Text on top of the accent switches between ink and white, whichever reads better. */
(function () {
  var KEY = "ceylon-buildex-accent";
  var P = {
    vermilion: {n: "Vermilion", l: "#f4481f", d: "#ff5a2d"},
    amber: {n: "Amber", l: "#c76a00", d: "#ffb020"},
    green: {n: "Green", l: "#1a7f35", d: "#4ade80"},
    teal: {n: "Teal", l: "#007a70", d: "#2fd4c2"},
    cobalt: {n: "Cobalt", l: "#2b4dff", d: "#7a96ff"},
    violet: {n: "Violet", l: "#7a3cff", d: "#a98bff"},
    magenta: {n: "Magenta", l: "#d6246e", d: "#ff5c9d"}
  };
  var HEX = /^#[0-9a-f]{6}$/i;
  function get() { try { var v = localStorage.getItem(KEY); return v && (P[v] || HEX.test(v)) ? v : "vermilion"; } catch (e) { return "vermilion"; } }
  function dark() { var t = document.documentElement.dataset.theme; return t === "dark" || (t !== "light" && window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches); }
  function lum(h) {
    var c = [1, 3, 5].map(function (i) { var v = parseInt(h.substr(i, 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function onColour(h) { var L = lum(h); return (L + 0.05) / (lum("#15162a") + 0.05) >= 1.05 / (L + 0.05) ? "#15162a" : "#ffffff"; }   // ink or white, the higher contrast
  function hexOf(v) { return P[v] ? (dark() ? P[v].d : P[v].l) : v; }
  function apply(v) {
    var st = document.documentElement.style;
    v = v || get();
    if (v === "vermilion") { st.removeProperty("--orange"); st.removeProperty("--on-orange"); return; }
    var h = hexOf(v);
    st.setProperty("--orange", h); st.setProperty("--on-orange", onColour(h));
  }
  function save(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* storage blocked: the colour applies until the page is closed */ } apply(v); }
  window.CBAccent = {presets: P, get: get, save: save, apply: apply, hex: hexOf, isCustom: function (v) { return !P[v || get()]; }};
  apply();
})();
