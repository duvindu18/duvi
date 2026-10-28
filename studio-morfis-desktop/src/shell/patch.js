'use strict';
/* The dashboard file in src/dashboard is the web version, kept byte for byte. This turns it into the desktop page
   when it is served: Windows-style window controls on the right, desktop wording, the map library, and the
   desktop stylesheet and script. To update the dashboard, replace dashboard.html and run `npm run check`. */

const ICON = {
  min: '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M1.5 6.5h9" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>',
  max: '<svg class="g-big" viewBox="0 0 12 12" width="11" height="11" fill="none" aria-hidden="true"><rect x="1.6" y="1.6" width="8.8" height="8.8" rx="2.2" stroke="currentColor" stroke-width="1.25"/></svg>' +
    '<svg class="g-small" viewBox="0 0 12 12" width="11" height="11" fill="none" aria-hidden="true"><rect x="1.4" y="3.4" width="7.2" height="7.2" rx="1.8" stroke="currentColor" stroke-width="1.2"/><path d="M3.6 1.6h5a1.8 1.8 0 0 1 1.8 1.8v5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  close: '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2.2 2.2l7.6 7.6M9.8 2.2l-7.6 7.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'
};

const WBAR =
  '<div class="wbar" id="wbar" hidden>' +
  '<div class="wbrand" aria-hidden="true"><span class="wbrand-ic" id="wbarIcon"></span></div>' +
  '<div class="wtitle" id="wbarTitle"></div>' +
  '<div class="wctl" role="group" aria-label="Window controls">' +
  '<button type="button" class="wc wc-min" data-act="winMin" tabindex="-1" aria-label="Minimize" title="Minimize">' + ICON.min + '</button>' +
  '<button type="button" class="wc wc-max wl-max" data-act="winMax" tabindex="-1" aria-label="Maximize window" title="Maximize">' + ICON.max + '</button>' +
  '<button type="button" class="wc wc-close" data-act="winClose" tabindex="-1" aria-label="Close window" title="Close">' + ICON.close + '</button>' +
  '</div></div>';

/* [find, replace, required]: a required anchor that is missing means the dashboard changed shape and the build should stop */
function rules(o) {
  return [
    [/<html>/, '<html class="' + o.htmlClass + '">', true],
    [/<div class="wbar" id="wbar" hidden>[\s\S]*?<div class="wend"><\/div>\s*<\/div>/, WBAR, true],
    ["const t = st.max ? 'Restore window' : 'Enlarge window'; b.setAttribute('aria-label', t); b.title = st.max ? 'Restore' : 'Enlarge';",
      "const t = st.max ? 'Restore window' : 'Maximize window'; b.setAttribute('aria-label', t); b.title = st.max ? 'Restore down' : 'Maximize';", true],
    ["(HOST ? ' The installed program file and its desktop shortcut keep the original icon.' : '')",
      "(HOST ? ' The Start menu entry, desktop and taskbar shortcuts and the Apps list follow it too.' : '')", false],
    ['Desktop alerts in this browser', 'Windows notifications for reminders', false],
    ['<p class="hint">Alerts need your browser’s permission and may be unavailable inside this page.</p>', '<p class="hint">Reminders also pop up in the Windows notification area.</p>', false],
    [/<\/body><\/html>\s*$/, o.tail + '</body></html>', true]
  ];
}

function build(html, o) {
  const missing = [];
  rules(o).forEach((r) => {
    const hit = typeof r[0] === 'string' ? html.indexOf(r[0]) !== -1 : r[0].test(html);
    if (!hit) { if (r[2]) missing.push(String(r[0]).slice(0, 80)); return; }
    html = typeof r[0] === 'string' ? html.split(r[0]).join(r[1]) : html.replace(r[0], () => r[1]);
  });
  return { html: html, missing: missing };
}

function tail(base) {
  return '<link rel="stylesheet" href="' + base + 'vendor/leaflet/leaflet.css">' +
    '<script src="' + base + 'vendor/leaflet/leaflet.js"></script>' +
    '<link rel="stylesheet" href="' + base + 'desktop.css">' +
    '<script src="' + base + 'desktop.js"></script>\n';
}

/* html classes the desktop stylesheet reads, set before first paint so nothing jumps */
function htmlClass(p) {
  return ['wc-' + p.controls, 'font-' + p.font, p.titleBar === 'none' ? 'no-wtitle' : '', p.reduceMotion ? 'reduce-motion' : '',
    p.pattern ? '' : 'no-pattern', p.glow ? '' : 'no-glow', p.roundCorners ? '' : 'square'].filter(Boolean).join(' ');
}

module.exports = { build, tail, htmlClass };
