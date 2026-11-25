/* Files: every project folder on this computer in one place.
   Left, the folder structure (projects, their six standard folders, and any folders inside). Right, folder cards
   with the project's status and stage, and a table of the files. Replaces the dashboard's Folder Hub. */
(function () {
  'use strict';
  var M = window.Morfis, A = window.MorfisArt;
  if (!M || !A) return;
  var H = M.H, esc = M.esc, ic = M.ic;
  var F = { pid: null, fid: null, sub: '', job: null, jrel: '', filter: 'all', view: 'grid', q: '', open: {}, list: null, listKey: '', busy: false };
  try { var saved = JSON.parse(localStorage.getItem('morfis:files') || '{}'); if (saved.view) F.view = saved.view; if (saved.filter) F.filter = saved.filter; } catch (e) { /* ignore */ }
  var keep = function () { try { localStorage.setItem('morfis:files', JSON.stringify({ view: F.view, filter: F.filter })); } catch (e) { /* ignore */ } };
  var pg = M.page;
  /* join a folder and a relative path with the separator the folder already uses */
  function jn(base, rel) { var sep = /\\/.test(base) || /^[A-Za-z]:/.test(base) ? '\\' : '/'; return String(base || '').replace(/[\\/]+$/, '') + (rel ? sep + String(rel).replace(/[\\/]+/g, sep) : ''); }
  M.jn = jn;

  /* ----- a small menu, shared with the other desktop views ----- */
  var MENU = null;
  function closeMenu() { if (MENU) { MENU.remove(); MENU = null; } }
  function menu(anchor, items, onPick) {
    closeMenu();
    var m = document.createElement('div');
    m.className = 'menu dk-menu'; m.setAttribute('role', 'menu');
    m.innerHTML = items.map(function (it, i) {
      if (it.sep) return '<div class="dk-menu-sep" role="separator"></div>';
      if (it.head) return '<div class="dk-menu-head">' + esc(it.head) + '</div>';
      return '<button type="button" role="menuitem" data-i="' + i + '" class="' + (it.danger ? 'danger' : '') + (it.on ? ' on' : '') + '">' + (it.html || ((it.icon ? ic(it.icon, 15) : '') + '<span>' + esc(it.label) + '</span>')) + (it.on ? '<span class="dk-menu-on">' + ic('check', 14) + '</span>' : '') + '</button>';
    }).join('');
    document.body.appendChild(m);
    var r = anchor.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
    var x = Math.min(window.innerWidth - w - 8, Math.max(8, r.right - w)), y = r.bottom + 6;
    if (y + h > window.innerHeight - 8) y = Math.max(8, r.top - h - 6);
    m.style.left = x + 'px'; m.style.top = y + 'px';
    m.addEventListener('click', function (e) { var b = e.target.closest('button[data-i]'); if (!b) return; var it = items[+b.dataset.i]; closeMenu(); (it.fn || onPick)(it); });
    MENU = m;
    setTimeout(function () { var f = m.querySelector('button'); if (f) f.focus(); }, 0);
  }
  document.addEventListener('mousedown', function (e) { if (MENU && !MENU.contains(e.target)) closeMenu(); }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && MENU) { e.stopPropagation(); closeMenu(); } }, true);
  window.addEventListener('blur', closeMenu);
  M.menu = menu;

  /* a menu of the five statuses, used here and on project pages */
  function statusMenu(anchor, pid) {
    var p = pg().P(pid), cur = A.statusOf(p, pg().today());
    menu(anchor, [{ head: 'Project status' }].concat(A.ORDER.map(function (st) {
      return { st: st, on: st === cur, html: A.statusDot(st, 14) + '<span>' + A.STATUS[st].label + '</span><span class="dk-menu-hint">' + esc(A.STATUS[st].hint) + '</span>' };
    })), function (it) { M.setWorkStatus(pid, it.st); M.toast(p.name + ' is now ' + A.STATUS[it.st].label + '.'); });
  }
  M.statusMenu = statusMenu;

  /* ----- data ----- */
  function projects() {
    var S = pg().S, today = pg().today(), q = F.q.trim().toLowerCase();
    return Object.values(S.projects).filter(function (p) {
      var st = A.statusOf(p, today);
      if (F.filter === 'active' && (st === 'completed' || st === 'cancelled')) return false;
      if (F.filter !== 'active' && F.filter !== 'all' && st !== F.filter) return false;
      return !q || (p.name + ' ' + p.code + ' ' + ((p.client && p.client.name) || '')).toLowerCase().indexOf(q) !== -1;
    }).sort(function (a, b) { return String(b.code).localeCompare(String(a.code), undefined, { numeric: true }); });
  }
  /* freelance jobs: their folders are browsed here the same way (node 'fl:<id>|<path inside the job folder>') */
  var FL = function () { return window.MorfisFreelance; };
  function jobs() {
    if (!FL()) return [];
    var today = pg().today(), q = F.q.trim().toLowerCase();
    return FL().all().filter(function (j) {
      var st = FL().statusOf(j);
      if (F.filter === 'active' && (st === 'completed' || st === 'cancelled')) return false;
      if (F.filter !== 'active' && F.filter !== 'all' && st !== F.filter) return false;
      return !q || [j.code, j.title, j.client, j.platform].join(' ').toLowerCase().indexOf(q) !== -1;
    }).sort(function (a, b) { return String(b.code).localeCompare(String(a.code), undefined, { numeric: true }); });
  }
  var numOf = function (name) { var m = /^(\d\d)[_ .\-]/.exec(name || ''); return m ? m[1] : ''; };
  function fstat(p, fid) { var f = (p.folders || {})[fid] || {}; return { count: f.count != null ? f.count : (f.files || []).length, files: f.files || [], exists: !!f.exists }; }
  function totalFiles(p) { return pg().FOLDER_TEMPLATES.reduce(function (a, t) { return a + fstat(p, t.id).count; }, 0) + (p.looseCount || 0); }
  var kindsOf = A.kindsOf;
  function tmpl(fid) { return pg().FOLDER_TEMPLATES.find(function (t) { return t.id === fid; }); }
  function onDisk(p) { return !!(p.foldersCreated && !p.dirMissing); }

  /* ----- tree ----- */
  function tree() {
    var list = projects(), S = pg().S, today = pg().today();
    var rows = list.map(function (p) {
      var open = !!F.open[p.id], sel = F.pid === p.id && !F.fid;
      var kids = open ? pg().FOLDER_TEMPLATES.map(function (t) {
        var s = fstat(p, t.id), on = F.pid === p.id && F.fid === t.id;
        return '<button type="button" class="fx-node d1' + (on && !F.sub ? ' on' : '') + (on && F.sub ? ' in' : '') + '" data-go-node="' + p.id + '|' + t.id + '"><i class="fx-tw"></i>' + ic('files', 15) + '<span>' + esc(t.label) + '</span><em>' + (s.count || '') + '</em></button>';
      }).join('') : '';
      var st = A.statusOf(p, today);
      return '<div class="fx-branch"><button type="button" class="fx-node d0' + (sel ? ' on' : '') + (F.pid === p.id && F.fid ? ' in' : '') + '" data-go-node="' + p.id + '">' +
        '<span class="fx-tw' + (open ? ' open' : '') + '" data-twist="' + p.id + '">' + ic('chevR', 12) + '</span>' + A.statusDot(st, 13) +
        '<span title="' + esc(p.code + ' · ' + p.name) + '">' + esc(p.name) + '</span><em>' + (totalFiles(p) || '') + '</em></button>' + kids + '</div>';
    }).join('');
    var jl = jobs(), jrows = jl.map(function (j) {
      var key = 'fl:' + j.id, open = !!F.open[key], here = F.job === j.id;
      var kids = open && j.folderMade ? FL().templates.map(function (t) {
        var on = here && (F.jrel === t.name || F.jrel.indexOf(t.name + '/') === 0);
        return '<button type="button" class="fx-node d1' + (on && F.jrel === t.name ? ' on' : '') + (on && F.jrel !== t.name ? ' in' : '') + '" data-go-node="fl:' + esc(j.id) + '|' + esc(t.name) + '"><i class="fx-tw"></i>' + ic('files', 15) + '<span>' + esc(t.label) + '</span><em></em></button>';
      }).join('') : '';
      return '<div class="fx-branch"><button type="button" class="fx-node d0' + (here && !F.jrel ? ' on' : '') + (here && F.jrel ? ' in' : '') + '" data-go-node="fl:' + esc(j.id) + '|">' +
        '<span class="fx-tw' + (open ? ' open' : '') + '" data-twist="' + esc(key) + '">' + ic('chevR', 12) + '</span>' + A.statusDot(FL().statusOf(j), 13) +
        '<span title="' + esc(j.code + ' · ' + j.title) + '">' + esc(j.title || j.code) + '</span><em></em></button>' + kids + '</div>';
    }).join('');
    var counts = {}, all = Object.values(S.projects), alljobs = FL() ? FL().all() : [];
    A.ORDER.forEach(function (st) { counts[st] = all.filter(function (p) { return A.statusOf(p, today) === st; }).length + alljobs.filter(function (j) { return FL().statusOf(j) === st; }).length; });
    var total = all.length + alljobs.length, activeN = total - counts.completed - counts.cancelled;
    var opt = function (k, label, n) { return '<button type="button" class="fx-filt' + (F.filter === k ? ' on' : '') + '" data-filter="' + k + '">' + label + '<em>' + n + '</em></button>'; };
    return '<aside class="fx-tree"><div class="fx-tree-h"><b>Structure</b><span class="muted small">' + esc(rootLabel()) + '</span></div>' +
      '<div class="fx-filts" role="group" aria-label="Show">' + opt('active', 'Active', activeN) + opt('in_progress', 'In progress', counts.in_progress) + opt('on_hold', 'On hold', counts.on_hold) +
      opt('not_started', 'Not started', counts.not_started) + opt('completed', 'Completed', counts.completed) + opt('all', 'All', total) + '</div>' +
      '<button type="button" class="fx-node root' + (!F.pid && !F.job ? ' on' : '') + '" data-go-node="">' + ic('files', 15) + '<span>All projects</span><em>' + (list.length + jl.length) + '</em></button>' +
      '<div class="fx-nodes"><div class="fx-group"><span>Direct projects</span><em>' + list.length + '</em></div>' + (rows || '<p class="muted small" style="padding:6px 12px">None in this filter.</p>') +
      (FL() ? '<div class="fx-group"><span>Freelance projects</span><em>' + jl.length + '</em></div>' + (jrows || '<p class="muted small" style="padding:6px 12px">None in this filter.</p>') : '') + '</div></aside>';
  }
  function mainRoot() { var st = pg().S.settings; return st.mainRoot || st.root || ''; }
  function rootLabel() { var r = mainRoot(); return r.split(/[\\/]/).filter(Boolean).slice(-2).join(' / '); }

  /* ----- right side ----- */
  function crumbs() {
    var p = F.pid && pg().P(F.pid), parts = ['<button type="button" class="fx-cr" data-go-node="">All projects</button>'];
    var j = F.job && FL() && FL().get(F.job);
    if (j) {
      parts.push('<span class="fx-cr-t">Freelance projects</span>', '<button type="button" class="fx-cr" data-go-node="fl:' + esc(j.id) + '|">' + esc(j.title || j.code) + '</button>');
      if (F.jrel) F.jrel.split('/').forEach(function (seg, i, arr) { parts.push('<button type="button" class="fx-cr" data-go-node="fl:' + esc(j.id) + '|' + esc(arr.slice(0, i + 1).join('/')) + '">' + esc(seg) + '</button>'); });
      return '<nav class="fx-crumbs" aria-label="Where you are">' + parts.join('<span class="fx-sep">' + ic('chevR', 12) + '</span>') + '</nav>';
    }
    if (p) parts.push('<button type="button" class="fx-cr" data-go-node="' + p.id + '">' + esc(p.name) + '</button>');
    if (p && F.fid) parts.push('<button type="button" class="fx-cr" data-go-node="' + p.id + '|' + F.fid + '">' + esc(tmpl(F.fid).label) + '</button>');
    if (F.sub) F.sub.split('/').forEach(function (seg, i, arr) { parts.push('<button type="button" class="fx-cr" data-go-node="' + p.id + '|' + F.fid + '|' + esc(arr.slice(0, i + 1).join('/')) + '">' + esc(seg) + '</button>'); });
    return '<nav class="fx-crumbs" aria-label="Where you are">' + parts.join('<span class="fx-sep">' + ic('chevR', 12) + '</span>') + '</nav>';
  }
  function viewToggle() {
    return '<div class="seg-ctl fx-vt" role="group" aria-label="Layout"><button type="button" class="' + (F.view === 'grid' ? 'on' : '') + '" data-layout="grid" title="Cards">' + ic('grid', 15) + '</button><button type="button" class="' + (F.view === 'list' ? 'on' : '') + '" data-layout="list" title="List">' + ic('list', 15) + '</button></div>';
  }
  function stageTag(p) { var s = pg().STAGES[Math.min(7, p.currentStage) - 1]; return '<span class="stg-tag" title="' + esc(s.name) + '"><b>' + p.currentStage + '</b>' + esc(s.short) + '</span>'; }

  function projectCard(p) {
    var st = A.statusOf(p, pg().today()), n = totalFiles(p), files = [];
    pg().FOLDER_TEMPLATES.forEach(function (t) { files = files.concat(fstat(p, t.id).files); });
    return '<div class="fx-card" role="button" tabindex="0" data-go-node="' + p.id + '">' +
      '<div class="fx-art">' + A.folder({ count: n, kinds: kindsOf(files), status: st }) + '</div>' +
      '<div class="fx-name" title="' + esc(p.name) + '">' + esc(p.name) + '</div>' +
      '<div class="fx-meta"><span class="mono">' + esc(p.code) + '</span> · ' + (onDisk(p) ? n + ' file' + (n === 1 ? '' : 's') : 'No folder yet') + '</div>' +
      '<div class="fx-tags">' + A.statusTag(st) + stageTag(p) + '</div>' +
      '<button type="button" class="fx-more" data-card-menu="' + 'p:' + p.id + '" aria-label="Folder options for ' + esc(p.name) + '" title="Folder options">' + ic('dots', 16) + '</button>' + '</div>';
  }
  function folderCard(p, t) {
    var s = fstat(p, t.id);
    return '<div class="fx-card" role="button" tabindex="0" data-go-node="' + p.id + '|' + t.id + '" data-dropzone data-pid="' + p.id + '" data-fid="' + t.id + '" title="Open ' + esc(t.label) + '. Drop files here to copy them in.">' +
      '<div class="fx-art">' + A.folder({ num: /^\d+$/.test(t.id) ? t.id : '', count: s.count, kinds: kindsOf(s.files) }) + '</div>' +
      '<div class="fx-name">' + esc(t.label) + '</div>' +
      '<div class="fx-meta"><span class="mono">' + t.id + '</span> · ' + (s.exists ? s.count + ' file' + (s.count === 1 ? '' : 's') : 'Not created') + '</div>' +
      '<button type="button" class="fx-more" data-card-menu="' + 'f:' + p.id + '|' + t.id + '" aria-label="Folder options for ' + esc(t.label) + '" title="Folder options">' + ic('dots', 16) + '</button>' + '</div>';
  }
  function subCard(p, e) {
    var sub = (F.sub ? F.sub + '/' : '') + e.name;
    return '<div class="fx-card" role="button" tabindex="0" data-go-node="' + p.id + '|' + F.fid + '|' + esc(sub) + '" data-dropzone data-pid="' + p.id + '" data-fid="' + F.fid + '" data-sub="' + esc(sub) + '">' +
      '<div class="fx-art">' + A.folder({ count: e.count }) + '</div><div class="fx-name" title="' + esc(e.name) + '">' + esc(e.name) + '</div><div class="fx-meta">' + e.count + ' item' + (e.count === 1 ? '' : 's') + '</div>' +
      '<button type="button" class="fx-more" data-card-menu="' + 's:' + p.id + '|' + F.fid + '|' + esc(sub) + '" aria-label="Folder options for ' + esc(e.name) + '" title="Folder options">' + ic('dots', 16) + '</button>' + '</div>';
  }
  function fmtBytes(n) { n = +n || 0; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB'; if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'; return (n / 1073741824).toFixed(1) + ' GB'; }
  function fileRows(rows, empty) {
    if (!rows.length) return '<div class="fx-empty">' + empty + '</div>';
    return '<div class="fx-table" role="table"><div class="fx-tr fx-th" role="row"><span>Name</span><span>Folder</span><span>Size</span><span>Modified</span><span></span></div>' +
      rows.map(function (r) {
        return '<div class="fx-tr" role="row" tabindex="0" data-file="' + esc(r.abs) + '" title="Click to preview, double-click to open"><span class="fx-fn">' + A.fileIcon(r.name, 28) + '<span><b title="' + esc(r.name) + '">' + esc(r.name) + '</b>' + (r.sub ? '<em>' + esc(r.sub) + '</em>' : '') + '</span></span>' +
          '<span class="muted">' + esc(r.folder) + '</span><span class="muted mono">' + esc(r.size) + '</span><span class="muted">' + esc(r.date) + '</span>' +
          '<span class="fx-acts"><button type="button" class="icon-btn" data-file-act="open" title="Open in its own program">' + ic('ext', 15) + '</button><button type="button" class="icon-btn" data-file-act="menu" title="More">' + ic('dots', 15) + '</button></span></div>';
      }).join('') + '</div>';
  }

  function jobCard(j) {
    var st = FL().statusOf(j), d = FL().done(j);
    return '<div class="fx-card" role="button" tabindex="0" data-go-node="fl:' + esc(j.id) + '|">' +
      '<div class="fx-art">' + A.folder({ count: d.of, status: st }) + '</div>' +
      '<div class="fx-name" title="' + esc(j.title) + '">' + esc(j.title || 'Untitled job') + '</div>' +
      '<div class="fx-meta"><span class="mono">' + esc(j.code) + '</span> · ' + (j.folderMade ? esc(j.platform || 'Freelance') : 'No folder yet') + '</div>' +
      '<div class="fx-tags">' + A.statusTag(st) + '<span class="stg-tag">' + d.n + '/' + d.of + ' delivered</span></div>' +
      '<button type="button" class="fx-more" data-card-menu="j:' + esc(j.id) + '" aria-label="Folder options for ' + esc(j.title) + '" title="Folder options">' + ic('dots', 16) + '</button></div>';
  }
  function jobSubCard(j, e) {
    var rel = (F.jrel ? F.jrel + '/' : '') + e.name, n = F.jrel ? '' : numOf(e.name);
    return '<div class="fx-card" role="button" tabindex="0" data-go-node="fl:' + esc(j.id) + '|' + esc(rel) + '">' +
      '<div class="fx-art">' + A.folder({ num: n, count: e.count }) + '</div><div class="fx-name" title="' + esc(e.name) + '">' + esc(e.name) + '</div><div class="fx-meta">' + e.count + ' item' + (e.count === 1 ? '' : 's') + '</div>' +
      '<button type="button" class="fx-more" data-card-menu="k:' + esc(j.id) + '|' + esc(rel) + '" aria-label="Folder options for ' + esc(e.name) + '" title="Folder options">' + ic('dots', 16) + '</button></div>';
  }
  function jobView(j) {
    var dir = FL().dirOf(j), st = FL().statusOf(j), base = jn(dir, F.jrel), title = F.jrel ? F.jrel.split('/').pop() : (j.title || j.code);
    var head = '<div class="fx-head"><div class="fx-ptitle">' + (F.jrel ? '' : '<div class="fx-ptitle-art">' + A.folder({ count: FL().done(j).of, status: st }) + '</div>') + '<div style="min-width:0"><h1>' + esc(title) + '</h1>' +
      (F.jrel ? '' : '<div class="fx-pmeta"><span class="mono">' + esc(j.code) + '</span>' + A.statusTag(st) + '<span class="muted">' + esc([j.client, j.platform].filter(Boolean).join(' · ')) + '</span><span class="muted">' + esc(FL().dueText(j)) + '</span></div>') +
      '<div class="fx-path mono" title="' + esc(base) + '">' + esc(base) + '</div></div></div>' +
      '<div class="toolbar">' + (j.folderMade ? viewToggle() + '<button type="button" class="btn" data-fx-act="newDir">' + ic('plus', 15) + 'New folder</button><button type="button" class="btn" data-fx-act="addFiles">' + ic('upload', 15) + 'Add files</button><button type="button" class="btn" data-fx-act="openHere">' + ic('ext', 15) + 'Open in Explorer</button>' : '') +
      (F.jrel ? '' : '<button type="button" class="btn" data-fx-act="jobPage">Job page</button>') + '</div></div>';
    if (!j.folderMade) return head + '<div class="fx-empty fx-empty-col"><b>No folder yet</b><span>Create the job’s folder with its five folders: ' + FL().templates.map(function (t) { return esc(t.name); }).join(', ') + '.</span><span class="toolbar"><button type="button" class="btn primary" data-fx-act="jobMkdir">Create the folder' + ic('plus', 15) + '</button></span></div>';
    var key = 'fl:' + j.id + '|' + F.jrel;
    if (F.listKey !== key) { F.listKey = key; F.list = null; loadJob(j); }
    var dirs = F.list ? F.list.entries.filter(function (e) { return e.dir; }).sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); }) : [];
    var files = F.list ? F.list.entries.filter(function (e) { return !e.dir; }).sort(function (a, b) { return (b.mtimeMs - a.mtimeMs) || a.name.localeCompare(b.name, undefined, { numeric: true }); }) : [];
    var q = F.q.trim().toLowerCase();
    if (q) { dirs = dirs.filter(function (e) { return e.name.toLowerCase().indexOf(q) !== -1; }); files = files.filter(function (e) { return e.name.toLowerCase().indexOf(q) !== -1; }); }
    var rows = files.map(function (e) { return { name: e.name, folder: F.jrel ? F.jrel.split('/').pop() : (j.title || j.code), size: fmtBytes(e.size), date: M.fdate(ymdOf(e.mtimeMs)), abs: jn(base, e.name) }; });
    return head + (F.list === null ? '<div class="fx-empty"><i class="spin"></i> Reading the folder…</div>' : F.list.err ? '<div class="fx-empty">' + esc(F.list.err) + '</div>' :
      (dirs.length ? '<section><div class="fx-sec-h"><h2>Folders</h2><span class="count">' + dirs.length + '</span></div><div class="fx-grid">' + dirs.map(function (e) { return jobSubCard(j, e); }).join('') + '</div></section>' : '') +
      '<section><div class="fx-sec-h"><h2>Files</h2><span class="count">' + files.length + '</span></div>' + (F.view === 'grid' && rows.length ? fileCards(rows) : fileRows(rows, 'Empty. Use Add files, or drop files in File Explorer.')) + '</section>');
  }
  function loadJob(j) {
    var key = F.listKey;
    H.listDir(FL().dirOf(j), F.jrel).then(function (r) { if (F.listKey !== key) return; F.list = { entries: r.entries }; draw(); },
      function (e) { if (F.listKey !== key) return; F.list = { entries: [], err: e && e.code === 'ENOENT' ? 'This folder is not on the disk.' : (e && e.message) || 'Could not read the folder.' }; draw(); });
  }
  /* the one-off split of the main folder, offered until it is done; Undo afterwards */
  function reorgNote() {
    var R = window.MorfisReorg, L = window.MorfisLog, sus = L ? L.suspects() : [];
    var notes = sus.length ? '<div class="fl-note card"><div><b>' + sus.length + ' folder' + (sus.length === 1 ? ' is' : 's are') + ' not named like a project</b><span class="muted small">' + esc(sus.slice(0, 6).map(function (p) { return p.name; }).join(', ') + (sus.length > 6 ? '…' : '')) + '. If they are not projects, the app can take back what it did to them: icons, the standard folders and the files it sorted.</span></div><button type="button" class="btn sm" data-fx-act="notProjects">Review…</button></div>' : '';
    if (!R) return notes;
    if (sus.length) return notes;
    if (R.needed()) return '<div class="fl-note card"><div><b>Split the projects folder</b><span class="muted small">Direct projects go to <span class="mono">Direct Projects</span>, freelance jobs to <span class="mono">Freelance Projects</span>. Completed projects become freelance jobs, renamed and sorted into the freelance folders. You can undo it.</span></div><button type="button" class="btn sm primary" data-fx-act="reorg">Reorganise…</button></div>';
    return '';
  }

  function rootView() {
    var list = projects(), recent = [];
    list.forEach(function (p) {
      pg().FOLDER_TEMPLATES.forEach(function (t) {
        fstat(p, t.id).files.slice(0, 12).forEach(function (f) { recent.push({ p: p, t: t, f: f }); });
      });
    });
    recent.sort(function (a, b) { return String(b.f.added).localeCompare(String(a.f.added)); });
    var rows = recent.slice(0, 14).map(function (x) {
      var parts = String(x.f.name).split('/');
      return { name: parts.pop(), sub: x.p.name + (parts.length ? ' / ' + parts.join(' / ') : ''), folder: x.t.label, size: x.f.size || '', date: M.fdate(x.f.added), abs: jn(pg().subDir(x.p, x.t.id), x.f.name) };
    });
    var jl = jobs(), R = window.MorfisReorg;
    return '<div class="fx-head"><div><h1>Files</h1><p class="muted">Project folders in <span class="mono">' + esc(mainRoot()) + '</span>. Drop files onto a folder to copy them in.</p></div>' +
      '<div class="toolbar">' + viewToggle() + '<button type="button" class="btn" data-fx-act="import">' + ic('upload', 15) + 'Import folders</button><button type="button" class="btn" data-fx-act="openRoot">' + ic('ext', 15) + 'Open in Explorer</button>' +
      '<button type="button" class="btn" data-fx-act="more" aria-label="More">' + ic('dots', 15) + 'More</button></div></div>' + reorgNote() +
      '<section><div class="fx-sec-h"><h2>Direct projects</h2><span class="count">' + list.length + '</span></div>' +
      (list.length ? (F.view === 'grid' ? '<div class="fx-grid">' + list.map(projectCard).join('') + '</div>' : projectTable(list)) : emptyRoot()) + '</section>' +
      (FL() ? '<section><div class="fx-sec-h"><h2>Freelance projects</h2><span class="count">' + jl.length + '</span></div>' +
        (jl.length ? '<div class="fx-grid">' + jl.map(jobCard).join('') + '</div>' : '<div class="fx-empty">' + (FL().all().length ? 'No freelance jobs in this filter.' : 'No freelance jobs yet. Add them under Freelance.') + '</div>') + '</section>' : '') +
      '<section><div class="fx-sec-h"><h2>Recently changed files</h2></div>' + fileRows(rows, 'Files you add to project folders show up here.') + '</section>';
  }
  /* nothing in this filter: say why, and offer the way to the projects that are there */
  function emptyRoot() {
    var n = Object.keys(pg().S.projects).length;
    if (!n) return '<div class="fx-empty fx-empty-col"><b>No projects yet</b><span>Import the project folders you already have, or create a project. Its folders appear here.</span><span class="toolbar"><button type="button" class="btn primary" data-fx-act="import">' + ic('upload', 15) + 'Import folders</button><button type="button" class="btn" data-fx-act="newProject">' + ic('plus', 15) + 'New project</button></span></div>';
    if (F.q.trim()) return '<div class="fx-empty">No project matches “' + esc(F.q.trim()) + '”.</div>';
    return '<div class="fx-empty fx-empty-col"><b>No projects in this filter</b><span>' + n + ' project' + (n === 1 ? ' is' : 's are') + ' under other statuses. Imported folders come in as Completed unless you pick another status.</span><span class="toolbar"><button type="button" class="btn primary" data-filter="all">Show all ' + n + '</button></span></div>';
  }
  function projectTable(list) {
    return '<div class="fx-table fx-ptable" role="table"><div class="fx-tr fx-th" role="row"><span>Project</span><span>Status</span><span>Stage</span><span>Files</span><span></span></div>' +
      list.map(function (p) {
        var st = A.statusOf(p, pg().today());
        return '<div class="fx-tr" role="row" data-go-node="' + p.id + '"><span class="fx-fn"><span class="fx-mini">' + A.folder({ status: st, count: totalFiles(p) }) + '</span><span><b>' + esc(p.name) + '</b><em class="mono">' + esc(p.code) + '</em></span></span>' +
          '<span>' + A.statusTag(st) + '</span><span>' + stageTag(p) + '</span><span class="muted mono">' + totalFiles(p) + '</span>' +
          '<span class="fx-acts"><button type="button" class="icon-btn" data-card-menu="p:' + p.id + '" title="Folder options">' + ic('dots', 15) + '</button></span></div>';
      }).join('') + '</div>';
  }

  function projectView(p) {
    var st = A.statusOf(p, pg().today()), dir = pg().projDir(p), disk = onDisk(p);
    var loose = (p.loose || []).slice(0, 40).map(function (rel) { var parts = rel.split('/'); return { name: parts.pop(), sub: parts.join(' / '), folder: 'Not sorted', size: '', date: '', abs: jn(dir, rel) }; });
    var recent = [];
    pg().FOLDER_TEMPLATES.forEach(function (t) { fstat(p, t.id).files.slice(0, 20).forEach(function (f) { var parts = String(f.name).split('/'); recent.push({ name: parts.pop(), sub: parts.join(' / '), folder: t.label, size: f.size || '', date: M.fdate(f.added), added: f.added, abs: jn(pg().subDir(p, t.id), f.name) }); }); });
    recent.sort(function (a, b) { return String(b.added).localeCompare(String(a.added)); });
    return '<div class="fx-head"><div class="fx-ptitle"><div class="fx-ptitle-art">' + A.folder({ count: totalFiles(p), status: st, kinds: kindsOf(pg().FOLDER_TEMPLATES.reduce(function (acc, t) { return acc.concat(fstat(p, t.id).files); }, [])) }) + '</div><div style="min-width:0"><h1>' + esc(p.name) + '</h1>' +
      '<div class="fx-pmeta"><span class="mono">' + esc(p.code) + '</span><button type="button" class="st-pick" data-status-menu="' + p.id + '" title="Change the status">' + A.statusTag(st, ic('chev', 12)) + '</button>' + stageTag(p) +
      (p.client && p.client.name ? '<span class="muted">' + esc(p.client.name) + '</span>' : '') + '</div>' +
      '<div class="fx-path mono" title="' + esc(dir) + '">' + esc(dir) + '</div></div></div>' +
      '<div class="toolbar">' + (disk ? '<button type="button" class="btn" data-fx-act="openDir">' + ic('ext', 15) + 'Open in Explorer</button><button type="button" class="btn" data-fx-act="rescan">' + ic('refresh', 15) + 'Read again</button>' +
        ((p.looseCount || 0) ? '<button type="button" class="btn" data-fx-act="sort">' + ic('sort', 15) + 'Sort ' + p.looseCount + ' loose file' + (p.looseCount === 1 ? '' : 's') + '</button>' : '') : '<button type="button" class="btn primary" data-fx-act="create">' + ic('plus', 15) + 'Create the folders</button>') +
      '<button type="button" class="btn" data-fx-act="openProject">Project page</button></div></div>' +
      '<section><div class="fx-sec-h"><h2>Folders</h2>' + viewToggle() + '</div>' +
      (F.view === 'grid' ? '<div class="fx-grid">' + pg().FOLDER_TEMPLATES.map(function (t) { return folderCard(p, t); }).join('') + '</div>' :
        fileRowsFolders(p)) + '</section>' +
      (loose.length ? '<section><div class="fx-sec-h"><h2>Not in a standard folder</h2><span class="count">' + p.looseCount + '</span>' + (window.MorfisAuto ? '<button type="button" class="btn sm" data-fx-act="aiSort" style="margin-left:auto">' + ic('sparkle', 14) + 'Sort with AI</button>' : '') + '</div>' + fileRows(loose, '') + '</section>' : '') +
      '<section><div class="fx-sec-h"><h2>Recent files</h2></div>' + fileRows(recent.slice(0, 16), disk ? 'No files yet. Drop files onto a folder above.' : 'Create the folders to start adding files.') + '</section>';
  }
  function fileRowsFolders(p) {
    return '<div class="fx-table" role="table"><div class="fx-tr fx-th" role="row"><span>Folder</span><span>Name on disk</span><span>Files</span><span></span><span></span></div>' +
      pg().FOLDER_TEMPLATES.map(function (t) {
        var s = fstat(p, t.id);
        return '<div class="fx-tr" role="row" data-go-node="' + p.id + '|' + t.id + '" data-dropzone data-pid="' + p.id + '" data-fid="' + t.id + '"><span class="fx-fn"><span class="fx-mini">' + A.folder({ num: /^\d+$/.test(t.id) ? t.id : '', count: s.count, kinds: kindsOf(s.files) }) + '</span><b>' + esc(t.label) + '</b></span>' +
          '<span class="muted mono">' + esc(t.name) + '</span><span class="muted mono">' + (s.exists ? s.count : '–') + '</span><span></span><span></span></div>';
      }).join('') + '</div>';
  }

  function folderView(p) {
    var t = tmpl(F.fid), key = p.id + '|' + F.fid + '|' + F.sub;
    if (F.listKey !== key) { F.listKey = key; F.list = null; load(p); }
    var dirs = F.list ? F.list.entries.filter(function (e) { return e.dir; }) : [];
    var files = F.list ? F.list.entries.filter(function (e) { return !e.dir; }).sort(function (a, b) { return (b.mtimeMs - a.mtimeMs) || a.name.localeCompare(b.name, undefined, { numeric: true }); }) : [];
    var q = F.q.trim().toLowerCase();
    if (q) { dirs = dirs.filter(function (e) { return e.name.toLowerCase().indexOf(q) !== -1; }); files = files.filter(function (e) { return e.name.toLowerCase().indexOf(q) !== -1; }); }
    var base = jn(pg().subDir(p, F.fid), F.sub);
    var rows = files.map(function (e) { return { name: e.name, folder: F.sub ? F.sub.split('/').pop() : t.label, size: fmtBytes(e.size), date: M.fdate(ymdOf(e.mtimeMs)), abs: jn(base, e.name) }; });
    return '<div class="fx-head"><div><h1>' + esc(F.sub ? F.sub.split('/').pop() : t.label) + '</h1><p class="muted mono fx-path" title="' + esc(base) + '">' + esc(base) + '</p></div>' +
      '<div class="toolbar">' + viewToggle() + '<button type="button" class="btn" data-fx-act="newDir">' + ic('plus', 15) + 'New folder</button><button type="button" class="btn" data-fx-act="addFiles">' + ic('upload', 15) + 'Add files</button><button type="button" class="btn" data-fx-act="openHere">' + ic('ext', 15) + 'Open in Explorer</button></div></div>' +
      (F.list === null ? '<div class="fx-empty"><i class="spin"></i> Reading the folder…</div>' : F.list.err ? '<div class="fx-empty">' + esc(F.list.err) + '</div>' :
        (dirs.length ? '<section><div class="fx-sec-h"><h2>Folders</h2><span class="count">' + dirs.length + '</span></div><div class="fx-grid">' + dirs.map(function (e) { return subCard(p, e); }).join('') + '</div></section>' : '') +
        '<section data-dropzone data-pid="' + p.id + '" data-fid="' + F.fid + '" data-sub="' + esc(F.sub) + '"><div class="fx-sec-h"><h2>Files</h2><span class="count">' + files.length + '</span></div>' + (F.view === 'grid' && rows.length ? fileCards(rows) : fileRows(rows, 'Empty. Drop files here or use Add files.')) + '</section>');
  }
  function ymdOf(ms) { return M.ymd(new Date(ms)); }
  /* files as cards with the thumbnail Windows makes for them, loaded as they scroll into view */
  function fileCards(rows) {
    return '<div class="fx-files">' + rows.map(function (r) {
      return '<div class="fx-fcard" role="button" tabindex="0" data-file="' + esc(r.abs) + '" title="' + esc(r.name) + '"><div class="fx-thumb" data-thumb="' + esc(r.abs) + '">' + A.fileIcon(r.name, 46) + '</div>' +
        '<div class="fx-fname">' + esc(r.name) + '</div><div class="fx-meta">' + esc(r.size) + ' · ' + esc(r.date) + '</div>' +
        '<button type="button" class="fx-more" data-file-act="menu" aria-label="More">' + ic('dots', 16) + '</button></div>';
    }).join('') + '</div>';
  }
  var THUMBS = {}, thumbIO = null;
  function loadThumbs(scope) {
    if (thumbIO) thumbIO.disconnect();
    thumbIO = new IntersectionObserver(function (list) {
      list.forEach(function (en) {
        if (!en.isIntersecting) return;
        var box = en.target, abs = box.dataset.thumb;
        thumbIO.unobserve(box);
        var got = THUMBS[abs] ? Promise.resolve(THUMBS[abs]) : H.thumb(abs, 256).then(function (u) {
          if (u) return u;
          return window.MorfisPreview && window.MorfisPreview.kindOf(abs) === 'image' ? H.preview(abs).then(function (r) { return r.url; }) : '';
        });
        got.then(function (u) { if (!u) return; THUMBS[abs] = u; box.innerHTML = '<img src="' + esc(u) + '" alt="" draggable="false">'; box.classList.add('has-img'); }, function () {});
      });
    }, { root: scope.querySelector('.fx-main'), rootMargin: '200px' });
    scope.querySelectorAll('[data-thumb]').forEach(function (b) { if (THUMBS[b.dataset.thumb]) { b.innerHTML = '<img src="' + esc(THUMBS[b.dataset.thumb]) + '" alt="" draggable="false">'; b.classList.add('has-img'); } else thumbIO.observe(b); });
  }
  /* look at a file in the built-in preview; the arrows move through the files on screen */
  function preview(abs) {
    var list = [];
    EL.querySelectorAll('.fx-main [data-file]').forEach(function (r) { if (list.indexOf(r.dataset.file) === -1) list.push(r.dataset.file); });
    if (window.MorfisPreview) window.MorfisPreview.open(abs, list); else openApp(abs);
  }
  function openApp(abs) { (H.openPathDirect || H.openPath)(abs).catch(function () { M.toast('That file is no longer there, or Windows has no program for it.'); }); }
  function load(p) {
    var key = F.listKey;
    H.listDir(pg().projDir(p), tmpl(F.fid).name + (F.sub ? '/' + F.sub : '')).then(function (r) {
      if (F.listKey !== key) return;
      F.list = { entries: r.entries };
      draw();
    }, function (e) { if (F.listKey !== key) return; F.list = { entries: [], err: e && e.code === 'ENOENT' ? 'This folder is not on the disk yet. Create the project folders first.' : (e && e.message) || 'Could not read the folder.' }; draw(); });
  }

  /* ----- drawing ----- */
  var EL = null, lastHtml = '';
  function draw() {
    if (!EL || M.current() !== 'files') return;
    var p = F.pid && pg().P(F.pid), j = F.job && FL() && FL().get(F.job);
    if (F.pid && !p) { F.pid = null; F.fid = null; F.sub = ''; }
    if (F.job && !j) { F.job = null; F.jrel = ''; }
    var html = '<div class="fx">' + tree() + '<div class="fx-main' + (!j && !p ? ' fx-rootv' : '') + '">' + crumbs() + (j ? jobView(j) : p ? (F.fid ? folderView(p) : projectView(p)) : rootView()) + '</div></div>';
    /* the page redraws often (every save); when nothing here changed, leave the DOM, its scroll and its thumbnails alone */
    if (html === lastHtml && EL.querySelector('.fx')) { M.crumb(); return; }
    lastHtml = html;
    var y = EL.querySelector('.fx-main') ? EL.querySelector('.fx-main').scrollTop : 0, ty = EL.querySelector('.fx-nodes') ? EL.querySelector('.fx-nodes').scrollTop : 0;
    EL.innerHTML = html;
    var m = EL.querySelector('.fx-main'); if (m) m.scrollTop = y;
    if (F.swap && m) { F.swap = false; m.classList.add('fx-swap'); setTimeout(function () { m.classList.remove('fx-swap'); }, 160); }
    var n = EL.querySelector('.fx-nodes'); if (n) n.scrollTop = ty;
    loadThumbs(EL);
    M.crumb();
  }
  function open(node) {
    node = String(node || '');
    if (node.indexOf('fl:') === 0) {
      var cut = node.indexOf('|'), id = cut === -1 ? node.slice(3) : node.slice(3, cut), rel = cut === -1 ? '' : node.slice(cut + 1);
      var same = F.job === id && F.jrel === rel;
      F.pid = null; F.fid = null; F.sub = ''; F.job = id; F.jrel = rel; F.open['fl:' + id] = true;
      if (!same) { F.swap = true; F.listKey = ''; var mm = EL && EL.querySelector('.fx-main'); if (mm) mm.scrollTop = 0; }
      draw(); return;
    }
    F.job = null; F.jrel = '';
    var parts = node.split('|');
    var samePlace = F.pid === (parts[0] || null) && F.fid === (parts[1] || null) && F.sub === (parts[2] || '');
    F.pid = parts[0] || null; F.fid = parts[1] || null; F.sub = parts[2] || '';
    if (F.pid) F.open[F.pid] = true;
    if (!samePlace) { F.swap = true; F.listKey = ''; var m = EL && EL.querySelector('.fx-main'); if (m) m.scrollTop = 0; }
    var p = F.pid && pg().P(F.pid);
    if (p && !F.fid) pg().rescanProject(p, { quiet: true }).then(function (changed) { if (changed) draw(); });
    draw();
  }

  /* ----- actions ----- */
  function fileMenu(btn) {
    var row = btn.closest('[data-file]'), abs = row.dataset.file, name = abs.split(/[\\/]/).pop();
    menu(btn, [
      { label: 'Preview', icon: 'search', fn: function () { preview(abs); } },
      { label: 'Open in its own program', icon: 'ext', fn: function () { openApp(abs); } },
      { label: 'Show in Explorer', icon: 'files', fn: function () { H.reveal(abs).catch(function () { M.toast('That file is no longer there.'); }); } },
      { label: 'Copy path', icon: 'copy', fn: function () { navigator.clipboard.writeText(abs).then(function () { M.toast('Path copied.'); }); } },
      { sep: true },
      { label: 'Move to the Recycle Bin', icon: 'trash', danger: true, fn: function () {
        if (!window.confirm('Move ' + name + ' to the Recycle Bin?')) return;
        H.trashPath(abs).then(function () { M.toast(name + ' is in the Recycle Bin.'); afterChange(); }, function (e) { M.toast('Could not remove it: ' + (e && e.message ? e.message : 'unknown error')); });
      } }
    ]);
  }
  /* a name typed into a small dialog (Electron has no prompt box) */
  function ask(title, label, value, okLabel) {
    return new Promise(function (resolve) {
      var done = false, finish = function (v) { if (done) return; done = true; pg().closeModal(); resolve(v); };
      M.modal(title, '<div class="field"><label for="fxAsk">' + esc(label) + '</label><input class="in" id="fxAsk" value="' + esc(value || '') + '" maxlength="150" autocomplete="off" spellcheck="false"></div>' +
        '<p class="err" id="fxAskErr"></p><div class="dlg-foot"><button type="button" class="btn" id="fxAskNo">Cancel</button><button type="button" class="btn primary" id="fxAskOk">' + esc(okLabel || 'OK') + '</button></div>');
      var inp = document.getElementById('fxAsk'), ok = function () { var v = inp.value.trim(); if (!v) { document.getElementById('fxAskErr').textContent = 'Type a name.'; return; } finish(v); };
      document.getElementById('fxAskOk').addEventListener('click', ok);
      document.getElementById('fxAskNo').addEventListener('click', function () { finish(null); });
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
      new MutationObserver(function (m, o) { var ov = document.getElementById('overlay'); if (!ov || ov.hidden) { o.disconnect(); if (!done) { done = true; resolve(null); } } }).observe(document.getElementById('overlay'), { attributes: true, attributeFilter: ['hidden'] });
      setTimeout(function () { inp.focus(); var dot = inp.value.lastIndexOf('.'); inp.setSelectionRange(0, dot > 0 ? dot : inp.value.length); }, 30);
    });
  }
  M.ask = ask;
  var openDir = function (dir) { H.openPath(dir).catch(function () { M.toast('The folder is not there yet.'); }); };
  var copyPath = function (dir) { navigator.clipboard.writeText(dir).then(function () { M.toast('Path copied.'); }); };
  var refreshIcons = function (pid) { if (window.MorfisAuto && window.MorfisAuto.refreshIcons) window.MorfisAuto.refreshIcons(pid).then(function (n) { M.toast(n ? 'Folder icons redrawn in File Explorer.' : 'Folder icons are a Windows feature, turned on in Automations.'); }); };
  function pageAct(act, data) { var b = document.createElement('button'); b.dataset.act = act; Object.keys(data).forEach(function (k) { b.dataset[k] = data[k]; }); b.hidden = true; document.body.appendChild(b); b.click(); b.remove(); }
  /* the three dots on a folder card: what can be done with that folder */
  function cardMenu(btn) {
    var key = btn.dataset.cardMenu, kind = key.slice(0, 1), parts = key.slice(2).split('|'), p = pg().P(parts[0]);
    if (kind === 'j' || kind === 'k') { jobMenu(btn, kind, parts[0], parts.slice(1).join('|')); return; }
    if (!p) return;
    var disk = onDisk(p), items;
    if (kind === 'p') {
      var dir = pg().projDir(p);
      items = [{ head: p.code + ' · ' + p.name },
        { label: 'Open', icon: 'files', fn: function () { open(p.id); } },
        { label: 'Change status…', icon: 'check', fn: function () { statusMenu(btn, p.id); } }];
      if (disk) items.push(
        { label: 'Open in File Explorer', icon: 'ext', fn: function () { openDir(dir); } },
        { label: 'Rename folder on disk…', icon: 'documents', fn: function () { pageAct('renameProjDir', { pid: p.id }); } },
        { label: 'Copy folder path', icon: 'copy', fn: function () { copyPath(dir); } },
        { label: 'Read the folder again', icon: 'refresh', fn: function () { pg().rescanProject(p, { force: true, quiet: true }).then(function () { draw(); M.toast('Folder read again.'); }); } },
        { label: 'Redraw folder icons', icon: 'grid', fn: function () { refreshIcons(p.id); } });
      else items.push({ label: 'Create the folders', icon: 'plus', fn: function () { F.pid = p.id; ACT.create(); } });
      if ((p.looseCount || 0) && disk) items.push({ label: 'Sort ' + p.looseCount + ' loose file' + (p.looseCount === 1 ? '' : 's') + '…', icon: 'sort', fn: function () { pageAct('arrangeProject', { pid: p.id }); } });
      items.push({ sep: true }, { label: 'Project folder setup…', icon: 'settings', fn: function () { ACT.setup(); } },
        { label: 'Project page', icon: 'projects', fn: function () { M.go('project', { id: p.id }); } });
      if (window.MorfisFreelance) items.push({ label: 'Move to Freelance…', icon: 'briefcase', fn: function () { window.MorfisFreelance.fromProject(p.id); } });
      items.push({ sep: true });
      if (disk && window.MorfisLog) items.push({ label: 'This is not a project…', icon: 'refresh', fn: function () { window.MorfisLog.notProjects(p.id); } }, { label: 'Change log for this folder', icon: 'list', fn: function () { window.MorfisLog.open(pg().projDir(p)); } });
      if (disk) items.push({ label: 'Delete the project folder…', icon: 'trash', danger: true, fn: function () { window.MorfisFolders.deleteProjectFolder(p.id); } });
      items.push({ label: 'Delete the project…', icon: 'trash', danger: true, fn: function () { pageAct('deleteProject', { id: p.id }); } });
    } else if (kind === 'f') {
      var t = tmpl(parts[1]), fdir = pg().subDir(p, t.id), exists = fstat(p, t.id).exists;
      items = [{ head: t.id + ' · ' + t.label },
        { label: 'Open', icon: 'files', fn: function () { open(p.id + '|' + t.id); } }];
      if (exists) items.push(
        { label: 'Open in File Explorer', icon: 'ext', fn: function () { openDir(fdir); } },
        { label: 'Add files…', icon: 'upload', fn: function () { F.pid = p.id; F.fid = t.id; F.sub = ''; ACT.addFiles(); } },
        { label: 'New folder inside…', icon: 'plus', fn: function () { F.pid = p.id; F.fid = t.id; F.sub = ''; ACT.newDir(); } },
        { label: 'Copy folder path', icon: 'copy', fn: function () { copyPath(fdir); } },
        { label: 'Redraw folder icon', icon: 'grid', fn: function () { refreshIcons(p.id); } });
      else items.push({ label: 'Create the folders', icon: 'plus', fn: function () { F.pid = p.id; ACT.create(); } });
      items.push({ sep: true },
        { label: 'Rename (in every project)…', icon: 'documents', fn: function () { window.MorfisFolders.renameStandard(t.id); } },
        { label: 'Project folder setup…', icon: 'settings', fn: function () { ACT.setup(); } });
      if (exists) items.push({ label: 'Delete this folder…', icon: 'trash', danger: true, fn: function () { window.MorfisFolders.deleteStandard(p.id, t.id); } });
    } else {
      var fid = parts[1], sub = parts.slice(2).join('|'), sdir = jn(pg().subDir(p, fid), sub), name = sub.split('/').pop();
      items = [{ head: name },
        { label: 'Open', icon: 'files', fn: function () { open(p.id + '|' + fid + '|' + sub); } },
        { label: 'Open in File Explorer', icon: 'ext', fn: function () { openDir(sdir); } },
        { label: 'Rename…', icon: 'documents', fn: function () {
          ask('Rename folder', 'New name', name, 'Rename').then(function (nm) {
            if (!nm || nm === name) return;
            H.renameItem(pg().projDir(p), tmpl(fid).name + '/' + sub, nm).then(function (r) {
              M.toast('Renamed to ' + nm + '.', r.id ? { label: 'Undo', fn: function () { H.undo(r.id).then(afterChange); } } : undefined); afterChange();
            }, function (e) { M.toast(e && e.message ? e.message : 'Could not rename it.'); });
          });
        } },
        { label: 'Copy folder path', icon: 'copy', fn: function () { copyPath(sdir); } },
        { sep: true },
        { label: 'Delete (to the Recycle Bin)…', icon: 'trash', danger: true, fn: function () {
          if (!window.confirm('Move the folder ' + name + ' and everything in it to the Recycle Bin?')) return;
          H.trashPath(sdir).then(function () { M.toast(name + ' is in the Recycle Bin.'); afterChange(); }, function (e) { M.toast('Could not remove it: ' + (e && e.message ? e.message : 'unknown error')); });
        } }];
    }
    menu(btn, items);
  }
  function jobMenu(btn, kind, id, rel) {
    var j = FL() && FL().get(id); if (!j) return;
    var dir = FL().dirOf(j), items;
    if (kind === 'j') {
      items = [{ head: j.code + ' · ' + (j.title || '') }, { label: 'Open', icon: 'files', fn: function () { open('fl:' + j.id + '|'); } },
        { label: 'Job page', icon: 'briefcase', fn: function () { FL().open(j.id); } }];
      items.push({ label: 'Move to Direct projects…', icon: 'layers', fn: function () { FL().toDirect(j.id); } });
      if (j.folderMade) items.push({ label: 'Open in File Explorer', icon: 'ext', fn: function () { openDir(dir); } }, { label: 'Copy folder path', icon: 'copy', fn: function () { copyPath(dir); } });
      else items.push({ label: 'Create the folder', icon: 'plus', fn: function () { FL().makeFolder(j); setTimeout(afterChange, 600); } });
    } else {
      var sdir = jn(dir, rel), name = rel.split('/').pop();
      items = [{ head: name }, { label: 'Open', icon: 'files', fn: function () { open('fl:' + j.id + '|' + rel); } },
        { label: 'Open in File Explorer', icon: 'ext', fn: function () { openDir(sdir); } },
        { label: 'Rename…', icon: 'documents', fn: function () {
          ask('Rename folder', 'New name', name, 'Rename').then(function (nm) {
            if (!nm || nm === name) return;
            H.renameItem(dir, rel, nm).then(function (r) { M.toast('Renamed to ' + nm + '.', r.id ? { label: 'Undo', fn: function () { H.undo(r.id).then(afterChange); } } : undefined); afterChange(); }, function (e) { M.toast(e && e.message ? e.message : 'Could not rename it.'); });
          });
        } },
        { label: 'Copy folder path', icon: 'copy', fn: function () { copyPath(sdir); } }, { sep: true },
        { label: 'Delete (to the Recycle Bin)…', icon: 'trash', danger: true, fn: function () {
          if (!window.confirm('Move the folder ' + name + ' and everything in it to the Recycle Bin?')) return;
          H.trashPath(sdir).then(function () { M.toast(name + ' is in the Recycle Bin.'); afterChange(); }, function (e) { M.toast('Could not remove it: ' + (e && e.message ? e.message : 'unknown error')); });
        } }];
    }
    menu(btn, items);
  }
  function afterChange() {
    var p = F.pid && pg().P(F.pid);
    F.listKey = '';
    if (p) pg().rescanProject(p, { force: true, quiet: true }).then(draw); else draw();
  }
  var ACT = {
    setup: function () { if (window.MorfisFolders) window.MorfisFolders.openSetup().then(function (r) { if (r) draw(); }); },
    import: function () { var b = document.createElement('button'); b.dataset.act = 'openImport'; b.hidden = true; document.body.appendChild(b); b.click(); b.remove(); },
    newProject: function () { if (M.newProject) M.newProject(); else { var pgx = pg(); if (pgx) pgx.newProject(); } },
    /* the less used tools of the main folder, in one menu */
    more: function () {
      var R = window.MorfisReorg, L = window.MorfisLog, btn = EL.querySelector('[data-fx-act="more"]'), items = [];
      items.push({ label: 'Project folder setup…', icon: 'settings', fn: function () { ACT.setup(); } });
      if (L) items.push({ label: 'Change log', icon: 'list', fn: function () { L.open(); } }, { label: 'Folders that are not projects…', icon: 'refresh', fn: function () { L.notProjects(); } });
      if (R && pg().S.settings.mainRoot) items.push({ label: 'Main folder names…', icon: 'documents', fn: function () { R.namesDialog(); } });
      if (R && R.needed()) items.push({ label: 'Reorganise into Direct and Freelance…', icon: 'layers', fn: function () { R.open(); } });
      if (R && R.canUndo()) items.push({ sep: true }, { label: 'Undo the reorganisation…', icon: 'refresh', danger: true, fn: function () { R.undo(); } });
      menu(btn, items);
    },
    log: function () { window.MorfisLog.open(); },
    groupNames: function () { window.MorfisReorg.namesDialog(); },
    notProjects: function () { window.MorfisLog.notProjects(); },
    reorg: function () { if (window.MorfisReorg) window.MorfisReorg.open(); },
    reorgUndo: function () { if (window.MorfisReorg) window.MorfisReorg.undo(); },
    jobPage: function () { FL().open(F.job); },
    jobMkdir: function () { var j = FL().get(F.job); if (j) { FL().makeFolder(j); setTimeout(afterChange, 600); } },
    openRoot: function () { H.openPath(mainRoot()).catch(function () { M.toast('That folder is not there yet.'); }); },
    openDir: function () { var p = pg().P(F.pid); H.openPath(pg().projDir(p)).catch(function () { M.toast('The folder is not there yet.'); }); },
    openHere: function () { if (F.job) { H.openPath(jn(FL().dirOf(FL().get(F.job)), F.jrel)).catch(function () { M.toast('The folder is not there.'); }); return; } var p = pg().P(F.pid); H.openPath(jn(pg().subDir(p, F.fid), F.sub)).catch(function () { M.toast('The folder is not there yet.'); }); },
    rescan: function () { afterChange(); M.toast('Folder read again.'); },
    create: function () {
      var p = pg().P(F.pid), base = pg().projDir(p);
      H.mkdirs([base].concat(pg().FOLDER_TEMPLATES.map(function (t) { return jn(base, t.name); }))).then(function (r) {
        var bad = r.filter(function (x) { return !x.ok; });
        if (bad.length) { M.toast('Windows refused: ' + bad[0].error); return; }
        p.folderPath = p.folderPath || base; p.foldersCreated = p.foldersCreated || pg().today(); pg().commit(p);
        M.toast('Folders created for ' + p.code + '.'); afterChange();
        window.dispatchEvent(new CustomEvent('morfis:status', { detail: { pid: p.id, status: A.statusOf(p, pg().today()) } }));
      });
    },
    sort: function () { var b = document.createElement('button'); b.dataset.act = 'arrangeProject'; b.dataset.pid = F.pid; b.hidden = true; document.body.appendChild(b); b.click(); b.remove(); },
    aiSort: function () { if (window.MorfisAuto) window.MorfisAuto.aiSort(F.pid).then(afterChange); },
    openProject: function () { M.go('project', { id: F.pid }); },
    addFiles: function () {
      if (F.job) {
        var jb = FL().get(F.job), to = jn(FL().dirOf(jb), F.jrel);
        H.pickFiles({ title: 'Add files to ' + (F.jrel ? F.jrel.split('/').pop() : jb.title) }).then(function (paths) {
          if (!paths.length) return;
          return H.copyInto(to, paths).then(function (r) { M.toast('Added ' + r.copied + ' file' + (r.copied === 1 ? '' : 's') + '.' + (r.failed.length ? ' ' + r.failed.length + ' could not be copied.' : '')); afterChange(); });
        });
        return;
      }
      var p = pg().P(F.pid), dest = jn(pg().subDir(p, F.fid), F.sub);
      H.pickFiles({ title: 'Add files to ' + tmpl(F.fid).label }).then(function (paths) {
        if (!paths.length) return;
        return H.copyInto(dest, paths).then(function (r) { M.toast('Added ' + r.copied + ' file' + (r.copied === 1 ? '' : 's') + '.' + (r.failed.length ? ' ' + r.failed.length + ' could not be copied.' : '')); afterChange(); });
      });
    },
    newDir: function () {
      if (F.job) {
        var jb = FL().get(F.job), jrel = F.jrel;
        ask('New folder', 'Name of the new folder', 'New folder', 'Create').then(function (name) {
          if (!name) return;
          H.makeDir(FL().dirOf(jb), jrel, name.trim()).then(function () { M.toast('Folder created.'); afterChange(); }, function (e) { M.toast(e && e.message ? e.message : 'Could not create it.'); });
        });
        return;
      }
      var p = pg().P(F.pid), fid = F.fid, sub = F.sub;
      ask('New folder', 'Name of the new folder', 'New folder', 'Create').then(function (name) {
      if (!name) return;
      F.pid = p.id; F.fid = fid; F.sub = sub;
      H.makeDir(pg().projDir(p), tmpl(F.fid).name + (F.sub ? '/' + F.sub : ''), name.trim()).then(function () { M.toast('Folder created.'); afterChange(); }, function (e) { M.toast(e && e.message ? e.message : 'Could not create it.'); });
      });
    }
  };

  function bind(el) {
    if (el.dataset.fxBound) return;
    el.dataset.fxBound = '1';
    el.addEventListener('click', function (e) {
      if (M.current() !== 'files') return;
      var t = e.target;
      var tw = t.closest('[data-twist]'); if (tw) { e.stopPropagation(); F.open[tw.dataset.twist] = !F.open[tw.dataset.twist]; draw(); return; }
      var sm = t.closest('[data-status-menu]'); if (sm) { statusMenu(sm, sm.dataset.statusMenu); return; }
      var cm = t.closest('[data-card-menu]'); if (cm) { e.stopPropagation(); cardMenu(cm); return; }
      var fa = t.closest('[data-file-act]'); if (fa) { e.stopPropagation(); if (fa.dataset.fileAct === 'menu') fileMenu(fa); else openApp(fa.closest('[data-file]').dataset.file); return; }
      var ff = t.closest('[data-filter]'); if (ff) { F.filter = ff.dataset.filter; keep(); draw(); return; }
      var ly = t.closest('[data-layout]'); if (ly) { F.view = ly.dataset.layout; keep(); draw(); return; }
      var ac = t.closest('[data-fx-act]'); if (ac) { ACT[ac.dataset.fxAct](); return; }
      var nd = t.closest('[data-go-node]'); if (nd) { open(nd.dataset.goNode); return; }
      var fr = t.closest('[data-file]'); if (fr && !t.closest('button')) { preview(fr.dataset.file); return; }
    });
    el.addEventListener('dblclick', function (e) { var r = e.target.closest('[data-file]'); if (r && M.current() === 'files') { if (window.MorfisPreview) window.MorfisPreview.close(); openApp(r.dataset.file); } });
    el.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.fx-card[data-go-node]')) { e.preventDefault(); open(e.target.dataset.goNode); return; }
      var f = e.target.closest && e.target.closest('[data-file]');
      if (f && e.key === ' ') { e.preventDefault(); preview(f.dataset.file); } else if (f && e.key === 'Enter') { e.preventDefault(); openApp(f.dataset.file); }
    });
  }

  M.register('files', {
    title: 'Files', placeholder: 'Search projects and files',
    crumb: function () { var j = F.job && FL() && FL().get(F.job); if (j) return 'Files / ' + (j.title || j.code) + (F.jrel ? ' / ' + F.jrel.split('/').pop() : ''); var p = F.pid && pg().P(F.pid); return 'Files' + (p ? ' / ' + p.name : '') + (p && F.fid ? ' / ' + tmpl(F.fid).label : ''); },
    render: function (el, o) { EL = el; lastHtml = ''; el.classList.add('dk-fill'); bind(el); if (o && o.pid) open(o.pid); else draw(); },
    refresh: function () { draw(); },
    search: function (q) { F.q = q; draw(); }
  });
  window.addEventListener('morfis:freelance', function () { if (M.current() === 'files') draw(); });
  /* drops are handled by the dashboard; read the folder again afterwards */
  document.addEventListener('drop', function (e) { if (M.current() === 'files' && e.target.closest && e.target.closest('#dkView [data-dropzone]')) setTimeout(afterChange, 1200); });
  window.MorfisFiles = { open: function (pid) { M.go('files'); open(pid); }, openJob: function (id, rel) { M.go('files'); open('fl:' + id + '|' + (rel || '')); }, redraw: function () { F.listKey = ''; draw(); } };
})();
