'use strict';
/* The dashboard file in src/dashboard is the web version, kept byte for byte. This turns it into the desktop page
   when it is served: the window bar, the wide sidebar and a second view area for the desktop views, a small hook
   that lets the desktop modules use the dashboard's own data and functions, and the desktop styles and scripts.
   To update the dashboard, replace dashboard.html and run `npm run check`. */

/* Windows glyphs at 10 px, drawn on a 10 px grid so they stay crisp at 100 % and 150 % scaling */
const ICON = {
  min: '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M0 5.5h10" stroke="currentColor" stroke-width="1"/></svg>',
  max: '<svg class="g-big" viewBox="0 0 10 10" width="10" height="10" fill="none" aria-hidden="true"><rect x=".5" y=".5" width="9" height="9" rx="1.5" stroke="currentColor"/></svg>' +
    '<svg class="g-small" viewBox="0 0 10 10" width="10" height="10" fill="none" aria-hidden="true"><rect x=".5" y="2.5" width="7" height="7" rx="1.2" stroke="currentColor"/><path d="M2.5 .5h5.3a1.7 1.7 0 0 1 1.7 1.7v5.3" stroke="currentColor"/></svg>',
  close: '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M.6.6l8.8 8.8M9.4.6L.6 9.4" stroke="currentColor" stroke-width="1"/></svg>'
};

const WBAR =
  '<div class="wbar" id="wbar" hidden>' +
  '<div class="wbrand"><span class="wbrand-ic" id="wbarIcon" aria-hidden="true"></span><span class="wbrand-name" id="wbarName"></span><span class="wcrumb" id="wbarCrumb"></span></div>' +
  '<div class="wtitle" id="wbarTitle"></div>' +
  '<div class="wctl" role="group" aria-label="Window controls">' +
  '<button type="button" class="wc wc-min" data-act="winMin" tabindex="-1" aria-label="Minimize" title="Minimize">' + ICON.min + '</button>' +
  '<button type="button" class="wc wc-max wl-max" data-act="winMax" tabindex="-1" aria-label="Maximize window" title="Maximize">' + ICON.max + '</button>' +
  '<button type="button" class="wc wc-close" data-act="winClose" tabindex="-1" aria-label="Close window" title="Close">' + ICON.close + '</button>' +
  '</div></div>';

/* Runs inside the dashboard's own scope, just before it starts: hands the desktop modules a handle on its state and
   functions, and announces every redraw so the sidebar and desktop views can follow. */
const HOOK = [
  'window.__morfisPage = {',
  '  S: S, P: P, commit: commit, queueWrite: queueWrite, commitSettings: commitSettings, toast: toast,',
  '  setView: setView, openProjectPage: openProjectPage, openInvoice: openInvoice, openModal: openModal, closeModal: closeModal,',
  '  renderAll: function () { renderAll(); }, today: function () { return TODAY; },',
  '  money: money, fd: fd, esc: esc, icon: icon, member: member, invoiceInfo: invoiceInfo, invoiceModel: invoiceModel, invoiceNo: invoiceNo,',
  '  milestoneAmount: milestoneAmount, projectFinance: projectFinance, stageProgress: stageProgress, overdueCount: overdueCount, normProject: normProject,',
  '  brandName: brandName, brandIcon: brandIcon, rescanProject: rescanProject, projDir: projDir, subDir: subDir, planArrangement: planArrangement,',
  '  STAGES: STAGES, FOLDER_TEMPLATES: FOLDER_TEMPLATES, openReminders: function () { A.openReminders(); }, newProject: function () { A.newProject(); }',
  '};',
  '(function () {',
  '  var ping = function () { try { window.dispatchEvent(new CustomEvent("morfis:render")); } catch (e) { /* ignore */ } };',
  '  var ra = renderAll, rv = renderView;',
  '  renderAll = function () { var r = ra.apply(this, arguments); ping(); return r; };',
  '  renderView = function () { var r = rv.apply(this, arguments); ping(); return r; };',
  '})();',
  /* Reminder settings in the reminders panel: close the panel, then open Settings at the Reminders card */
  'A.remSettings = function () {',
  '  closeModal(); setView("settings");',
  '  setTimeout(function () { var c = document.getElementById("remCard"); if (!c) return; c.scrollIntoView({ block: "start", behavior: "smooth" }); c.classList.add("dk-flash"); setTimeout(function () { c.classList.remove("dk-flash"); }, 1600); }, 60);',
  '};',
  /* an empty Projects page explains where the projects are when they are all closed (imported folders come in as completed) */
  'function dkNoProjects() {',
  '  var closed = Object.values(S.projects).filter(function (p) { return p.status === "closed"; }).length;',
  '  if (S.ui.status !== "active" || S.ui.q.trim() || S.ui.phase || !closed) return noMatch();',
  '  return \'<div class="empty"><h2>No active projects</h2><p>\' + closed + (closed === 1 ? " project is" : " projects are") + " completed or closed, so " + (closed === 1 ? "it is" : "they are") + " hidden here. Imported folders are added as completed unless you choose another status.</p>" +',
  '    \'<div class="toolbar" style="justify-content:center"><button type="button" class="btn primary" data-act="setStatus" data-v="all">Show all projects</button><button type="button" class="btn" data-act="newProject">New project</button></div></div>\';',
  '}',
  ''
].join('\n');

/* [find, replace, required]: a required anchor that is missing means the dashboard changed shape and the build should stop */
function rules(o) {
  return [
    [/<html>/, '<html class="' + o.htmlClass + '">', true],
    [/<div class="wbar" id="wbar" hidden>[\s\S]*?<div class="wend"><\/div>\s*<\/div>/, WBAR, true],
    ['<div class="shell" id="app">', '<div class="shell" id="app"><nav class="dk-side" id="dkSide" aria-label="Main"></nav>', true],
    ['<main id="view" class="content main" aria-live="polite"></main>', '<main id="view" class="content main" aria-live="polite"></main><section id="dkView" class="content dk-view" aria-live="polite" hidden></section>', true],
    ["const t = st.max ? 'Restore window' : 'Enlarge window'; b.setAttribute('aria-label', t); b.title = st.max ? 'Restore' : 'Enlarge';",
      "const t = st.max ? 'Restore window' : 'Maximize window'; b.setAttribute('aria-label', t); b.title = st.max ? 'Restore down' : 'Maximize';", true],
    /* the project folders can be changed in Files > Folder setup: a file headed for a folder that is switched off stays where it is */
    ['var ft0 = FOLDER_TEMPLATES.filter(function (f) { return f.id === t0; })[0];', 'var ft0 = FOLDER_TEMPLATES.filter(function (f) { return f.id === t0; })[0]; if (!ft0) { plan.loose.push(e.rel); return; }', true],
    ['var ft = FOLDER_TEMPLATES.filter(function (f) { return f.id === cat; })[0];', 'var ft = FOLDER_TEMPLATES.filter(function (f) { return f.id === cat; })[0]; if (!ft) { plan.loose.push(e.rel); return; }', true],
    ['const ft = FOLDER_TEMPLATES.find((f) => f.id === DELIVERABLES[type]);', "const ft = FOLDER_TEMPLATES.find((f) => f.id === DELIVERABLES[type]) || { id: '', label: 'No folder' };", true],
    ["data-act=\"go\" data-v=\"settings\">' + icon('gear', 15) + 'Reminder settings", "data-act=\"remSettings\">' + icon('gear', 15) + 'Reminder settings", true],
    ["'<section class=\"card stack\"><div><h2>Reminders</h2>", "'<section class=\"card stack\" id=\"remCard\"><div><h2>Reminders</h2>", true],
    ["(S.ui.status !== 'closed' ? newCard() : '') + '</div>' : noMatch());", "(S.ui.status !== 'closed' ? newCard() : '') + '</div>' : dkNoProjects());", true],
    ['/* ----- start ----- */\n(function boot() {', '/* ----- start ----- */\n' + HOOK + '(function boot() {', true],
    ["(HOST ? ' The installed program file and its desktop shortcut keep the original icon.' : '')",
      "(HOST ? ' The Start menu entry, desktop and taskbar shortcuts and the Apps list follow it too.' : '')", false],
    ['Desktop alerts in this browser', 'Windows notifications for reminders', false],
    ['<p class="hint">Alerts need your browser’s permission and may be unavailable inside this page.</p>', '<p class="hint">Reminders also pop up in the Windows notification area.</p>', false],
    [/<\/body><\/html>\s*$/, o.tail + '</body></html>', true]
  ];
}

function build(html, o) {
  const missing = [];
  /* a Windows checkout may have turned line ends into CRLF; the anchors are written with LF */
  html = html.replace(/\r\n/g, '\n');
  rules(o).forEach((r) => {
    const hit = typeof r[0] === 'string' ? html.indexOf(r[0]) !== -1 : r[0].test(html);
    if (!hit) { if (r[2]) missing.push(String(r[0]).slice(0, 80)); return; }
    html = typeof r[0] === 'string' ? html.split(r[0]).join(r[1]) : html.replace(r[0], () => r[1]);
  });
  return { html: html, missing: missing };
}

const STYLES = ['vendor/leaflet/leaflet.css', 'theme.css', 'desktop.css', 'views.css'];
const SCRIPTS = ['vendor/leaflet/leaflet.js', 'folder-art.js', 'desktop.js', 'preview.js', 'files.js', 'folder-setup.js', 'docs.js', 'automations.js'];
function tail(base) {
  return STYLES.map((s) => '<link rel="stylesheet" href="' + base + s + '">').join('') +
    SCRIPTS.map((s) => '<script src="' + base + s + '"></script>').join('') + '\n';
}

/* html classes the desktop stylesheet reads, set before first paint so nothing jumps */
function htmlClass(p) {
  return ['wc-' + p.controls, 'font-' + p.font, 'density-' + p.density, p.titleBar === 'none' ? 'no-wtitle' : '', p.reduceMotion ? 'reduce-motion' : '',
    p.pattern ? '' : 'no-pattern', p.glow ? '' : 'no-glow', p.followGlow ? '' : 'no-follow', p.roundCorners ? '' : 'square', p.sideCollapsed ? 'side-collapsed' : ''].filter(Boolean).join(' ');
}

module.exports = { build, tail, htmlClass, STYLES, SCRIPTS };
