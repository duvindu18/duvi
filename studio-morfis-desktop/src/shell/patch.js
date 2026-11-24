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
  '<button type="button" class="wside" id="wbarSide" tabindex="-1" aria-label="Collapse the sidebar" title="Collapse the sidebar (Ctrl+B)"></button>' +
  '<div class="wbrand"><span class="wbrand-logo" role="img" aria-label="Seedform"><svg class="sf-mark" viewBox="0 0 64 64" aria-hidden="true"><rect x="4.5" y="4.5" width="55" height="55" rx="2" fill="none" stroke="currentColor" stroke-width="5"/><rect x="29.5" y="6" width="5" height="31" fill="currentColor"/><circle class="sf-seed" cx="32" cy="44" r="8"/></svg><span class="sf-word">seedform</span></span><span class="wbrand-ic" id="wbarIcon" aria-hidden="true"></span><span class="wbrand-name" id="wbarName"></span><span class="wcrumb" id="wbarCrumb"></span></div>' +
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
  '  brandName: brandName, brandIcon: brandIcon, rescanProject: rescanProject, projDir: projDir, subDir: subDir, dirNameOf: dirNameOf, planArrangement: planArrangement, makeProject: makeProject, nextProjectCode: nextProjectCode, projectProgress: projectProgress, makeFoldersNow: makeFoldersNow, retainOn: retainOn, uid: uid, removeProject: removeProject,',
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
  /* a change saved on another page (the phone, or the computer when this is the phone): take it in and redraw.
     A change this page is still writing wins, so nothing typed here is lost. */
  'window.__morfisPage.applyRemote = function (ev) {',
  '  if (!ev || !S.ready) return;',
  '  if (DW.queue.has((ev.t === "s" ? "s" : "p") + ":" + ev.id)) return;',
  '  if (ev.t === "p") { if (ev.value === null) delete S.projects[ev.id]; else S.projects[ev.id] = normProject(ev.value); }',
  '  else if (ev.t === "s" && ev.value) { S.settings = normSettings(withLook(ev.value)); applyLook(); }',
  '  else return;',
  '  renderAll(true);',
  '};',
  /* everything again, after the phone was asleep or lost the connection */
  'window.__morfisPage.applyAll = function (d) {',
  '  if (!d || !S.ready || DW.queue.size) return;',
  '  Object.keys(S.projects).forEach(function (id) { if (!d.projects[id]) delete S.projects[id]; });',
  '  Object.keys(d.projects).forEach(function (id) { S.projects[id] = normProject(d.projects[id]); });',
  '  if (d.settings) { S.settings = normSettings(withLook(d.settings)); applyLook(); }',
  '  renderAll(true);',
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
    /* project cards on Home and Projects: the same folder art as Files and File Explorer, in place of the plan sketch */
    ["coverEl('pc-cover', p.cover) + planSvg(tone) +", "coverEl('pc-cover', p.cover) + (window.MorfisCardArt && !p.cover ? window.MorfisCardArt(p) : planSvg(tone)) +", true],
    /* no icon of their own: the studio's icon, not the first letter of the name */
    ["return icon ? '<img src=\"' + esc(icon) + '\" alt=\"\" width=\"' + size + '\" height=\"' + size + '\" draggable=\"false\">' : esc(brandName().charAt(0).toUpperCase() || 'M');",
      "return '<img src=\"' + esc(icon || 'app-icon.png') + '\" alt=\"\" width=\"' + size + '\" height=\"' + size + '\" draggable=\"false\">';", true],
    ["'<div class=\"brand-row\"><span class=\"brand-prev' + (has ? ' has-img' : '') + '\" aria-hidden=\"true\">'", "'<div class=\"brand-row\"><span class=\"brand-prev has-img\" aria-hidden=\"true\">'", true],
    /* Timeline: freelance jobs get a row too, a bar from the day the brief came in to the due date */
    ["function viewTimeline() {\n  if (!Object.keys(S.projects).length) return emptyAll();\n  const list = tlList();\n  if (!list.length) return tlHead(list, 'Nothing to show for this filter.') + noMatch();\n  let s0 = TODAY, s1 = TODAY;\n  list.forEach((p) => { if (p.stages[0].start < s0) s0 = p.stages[0].start; if (p.stages[6].end > s1) s1 = p.stages[6].end; });",
     "function viewTimeline() {\n  const FLJ = (window.MorfisFreelance && window.MorfisFreelance.timeline) ? window.MorfisFreelance.timeline(S.ui.status) : [];\n  if (!Object.keys(S.projects).length && !FLJ.length) return emptyAll();\n  const list = tlList();\n  if (!list.length && !FLJ.length) return tlHead(list, 'Nothing to show for this filter.') + noMatch();\n  let s0 = TODAY, s1 = TODAY;\n  list.forEach((p) => { if (p.stages[0].start < s0) s0 = p.stages[0].start; if (p.stages[6].end > s1) s1 = p.stages[6].end; });\n  FLJ.forEach((j) => { if (j.start < s0) s0 = j.start; if (j.end > s1) s1 = j.end; });", true],
    ["  }).join('');\n  const guides = ticks.map((t) => '<i class=\"tl-g\"",
     "  }).join('') + FLJ.map((j) => {\n    const left = X(j.start), w = Math.max(6, (diffDays(j.start, j.end) + 1) * ppd - 2);\n    return '<div class=\"tl-row tl-fl\" role=\"button\" tabindex=\"0\" data-fl-tl=\"' + esc(j.id) + '\" aria-label=\"Open ' + esc(j.title) + '\">' +\n      '<div class=\"tl-label\"><b title=\"' + esc(j.title) + '\">' + esc(j.title) + '</b><span class=\"mono\">' + esc(j.code) + '</span><span class=\"tl-st\">Freelance</span></div>' +\n      '<div class=\"tl-track\"><i class=\"tl-seg ' + j.state + '\" style=\"left:' + left.toFixed(1) + 'px;width:' + w.toFixed(1) + 'px\" title=\"' + esc(j.title + ': ' + fd(j.start) + ' to ' + fd(j.end) + ', ' + j.done + ' of ' + j.of + ' delivered') + '\">' + (j.state === 'cur' ? '<em style=\"width:' + j.pct + '%\"></em>' : '') + (w >= 104 ? '<span>' + esc(j.label) + '</span>' : '') + '</i></div></div>';\n  }).join('');\n  const guides = ticks.map((t) => '<i class=\"tl-g\"", true],
    ["  return tlHead(list, list.length + ' project' + (list.length === 1 ? '' : 's') + ', ' + fd(first) + ' to ' + fd(last) + '. Click a row to open it.') +",
     "  return tlHead(list, list.length + ' project' + (list.length === 1 ? '' : 's') + (FLJ.length ? ' and ' + FLJ.length + ' freelance job' + (FLJ.length === 1 ? '' : 's') : '') + ', ' + fd(s0 < first ? s0 : first) + ' to ' + fd(last) + '. Click a row to open it.') +", true],
    ['/* ----- start ----- */\n(function boot() {', '/* ----- start ----- */\n' + HOOK + '(function boot() {', true],
    ["(HOST ? ' The installed program file and its desktop shortcut keep the original icon.' : '')",
      "(HOST ? ' The Start menu entry, desktop and taskbar shortcuts and the Apps list follow it too.' : '')", false],
    ['Desktop alerts in this browser', 'Windows notifications for reminders', false],
    /* the rebrand: Seedform */
    ["<title>Studio Morfis Practice Dashboard</title>", "<title>Seedform</title>", true],
    ["  studio: 'Studio Morfis',", "  studio: 'Seedform',", true],
    ["const brandName = () => String((S.settings && S.settings.appName) || '').trim() || 'Studio Morfis';", "const brandName = () => String((S.settings && S.settings.appName) || '').trim() || 'Seedform';", true],
    ["/Creator (Studio Morfis Practice Dashboard) /Producer (Studio Morfis)", "/Creator (Seedform) /Producer (Seedform)", true],
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

const STYLES = ['vendor/leaflet/leaflet.css', 'theme.css', 'desktop.css', 'views.css', 'mono.css', 'seedform.css', 'paint.css'];
const SCRIPTS = ['vendor/leaflet/leaflet.js', 'folder-art.js', 'desktop.js', 'preview.js', 'files.js', 'folder-log.js', 'folder-setup.js', 'docs.js', 'browser.js', 'freelance.js', 'direct.js', 'reorganise.js', 'automations.js', 'agent.js', 'voice.js'];
/* the phone page adds its own layout and controls after the desktop ones */
const REMOTE_STYLES = ['remote.css'], REMOTE_SCRIPTS = ['remote.js'];
function tail(base, remote) {
  return STYLES.concat(remote ? REMOTE_STYLES : []).map((s) => '<link rel="stylesheet" href="' + base + s + '">').join('') +
    SCRIPTS.concat(remote ? REMOTE_SCRIPTS : []).map((s) => '<script src="' + base + s + '"></script>').join('') + '\n';
}

/* html classes the desktop stylesheet reads, set before first paint so nothing jumps */
function htmlClass(p) {
  var paint = p.style === 'red' || p.style === 'green', st = p.style || 'seedform';
  return [paint ? 'style-mono paint paint-' + st : st === 'seedform' ? 'style-mono style-seedform' : 'style-' + st, 'wc-' + p.controls, 'font-' + p.font, 'density-' + p.density, p.titleBar === 'none' ? 'no-wtitle' : '', p.reduceMotion ? 'reduce-motion' : '',
    p.pattern ? '' : 'no-pattern', p.glow ? '' : 'no-glow', p.followGlow ? '' : 'no-follow', p.roundCorners ? '' : 'square', p.sideCollapsed ? 'side-collapsed' : ''].filter(Boolean).join(' ');
}

module.exports = { build, tail, htmlClass, STYLES, SCRIPTS, REMOTE_STYLES, REMOTE_SCRIPTS };
