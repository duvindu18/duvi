/* Desktop core inside the dashboard page: the sidebar, a small router for the desktop views (Files, Documents,
   Automations), the window bar breadcrumb, the look preferences and Settings > Desktop app.
   Other desktop modules register their views through window.Morfis. Loaded after the dashboard's own scripts. */
(function () {
  'use strict';
  var H = window.morfisDesktop;
  if (!H || !H.getPrefs) return;
  var root = document.documentElement;
  var page = function () { return window.__morfisPage || null; };
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var P = null;

  /* ----- icons (24 px grid, 1.7 stroke, same family as the dashboard's) ----- */
  var PATHS = {
    home: '<path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>',
    projects: '<rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/>',
    timeline: '<path d="M4 6h9M7 12h11M5 18h7"/><circle cx="16" cy="6" r="1.4"/><circle cx="20" cy="12" r="1.4"/><circle cx="14" cy="18" r="1.4"/>',
    payments: '<rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M3.5 10h17M7 14.5h3"/>',
    files: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
    documents: '<path d="M7 3.5h7l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M13.5 3.5V8H18M8.5 12.5h7M8.5 16h5"/>',
    automations: '<path d="M13 3 5.5 13.5H12L11 21l7.5-10.5H12z"/>',
    bell: '<path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
    help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.5a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    chev: '<path d="m6 9 6 6 6-6"/>',
    chevR: '<path d="m9 6 6 6-6 6"/>',
    collapse: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15M15.5 10l-2 2 2 2"/>',
    sparkle: '<path d="M12 3.5 13.8 9 19.5 10.8 13.8 12.6 12 18.5 10.2 12.6 4.5 10.8 10.2 9z"/><path d="M18.5 3.5v3M17 5h3"/>',
    pdf: '<path d="M7 3.5h7l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M12 10v6M9.5 13.5 12 16l2.5-2.5"/>',
    print: '<path d="M7 9V4h10v5M7 17H5a1.5 1.5 0 0 1-1.5-1.5V11A2 2 0 0 1 5.5 9h13a2 2 0 0 1 2 2v4.5A1.5 1.5 0 0 1 19 17h-2"/><rect x="7" y="14" width="10" height="6" rx="1"/>',
    back: '<path d="M15 6l-6 6 6 6"/>',
    trash: '<path d="M4.5 7h15M10 11v6M14 11v6M6 7l1 12a1.5 1.5 0 0 0 1.5 1.4h7a1.5 1.5 0 0 0 1.5-1.4L18 7M9 7V4.5h6V7"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
    send: '<path d="M20.5 3.5 10 14M20.5 3.5 14 20.5l-4-6.5-6.5-4z"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    dots: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
    ext: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
    refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3L19.5 9M19.5 4.5V9H15"/>',
    download: '<path d="M12 4.5v11M7.5 11 12 15.5 16.5 11M4.5 15v3a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-3"/>',
    upload: '<path d="M12 15.5V4.5M7.5 9 12 4.5 16.5 9M4.5 15v3a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-3"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
    mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4 7 8 6 8-6"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3"/>',
    play: '<path d="M8 5.5v13l10.5-6.5z"/>',
    sort: '<path d="M7 4.5v15M4 16.5l3 3 3-3M17 19.5v-15M14 7.5l3-3 3 3"/>'
  };
  function ic(n, s) { return '<svg class="ic" width="' + (s || 16) + '" height="' + (s || 16) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (PATHS[n] || '') + '</svg>'; }

  function toast(msg, action) {
    var pg = page();
    if (pg && pg.toast) { pg.toast(msg, action); return; }
    var t = $('#toast'); if (!t) return;
    t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, 3200);
  }

  /* ===== router: the dashboard's own views, or a desktop view in #dkView ===== */
  var VIEWS = {};       /* name -> { title, render(el), search(q), placeholder } */
  var R = { cur: null, pageKey: '' };
  var PAGE_VIEWS = { home: 'Home', projects: 'Projects', timeline: 'Timeline', payments: 'Payments', settings: 'Settings' };
  function pageView() { var pg = page(); return pg && pg.S ? pg.S.ui.view : 'home'; }
  function win() { return $('.window.col-main'); }
  function go(name, opts) {
    var pg = page();
    if (VIEWS[name]) {
      R.cur = name;
      win().classList.add('dk-mode');
      $('#dkView').classList.remove('dk-fill');
      $('#dkView').hidden = false;
      var q = $('#q'); if (q) { q.value = ''; q.placeholder = VIEWS[name].placeholder || 'Search'; }
      var pw = $('#phaseWrap'); if (pw) pw.hidden = true;
      renderDk(opts);
      $('#dkView').scrollTop = 0;
    } else {
      leaveDk();
      if (pg) { if (name === 'project' && opts && opts.id) pg.openProjectPage(opts.id, opts.tab); else pg.setView(name); }
    }
    drawSide(); crumb();
  }
  function leaveDk() {
    if (!R.cur) return;
    R.cur = null;
    win().classList.remove('dk-mode');
    $('#dkView').hidden = true;
    var q = $('#q'); if (q) q.value = '';
  }
  function renderDk(opts) {
    var v = VIEWS[R.cur], el = $('#dkView');
    if (!v || !el) return;
    el.classList.remove('dk-enter'); void el.offsetWidth; el.classList.add('dk-enter');
    v.render(el, opts || {});
  }
  function refreshDk() { if (R.cur && VIEWS[R.cur] && VIEWS[R.cur].refresh) VIEWS[R.cur].refresh($('#dkView')); }
  function onPageRender() {
    var pg = page(); if (!pg || !pg.S) return;
    var key = [pg.S.ui.view, pg.S.ui.pid, pg.S.ui.tab].join('|');
    var changed = key !== R.pageKey;
    R.pageKey = key;
    /* the dashboard's Folder Hub is replaced by Files */
    if (pg.S.ui.view === 'folders' && R.cur !== 'files' && VIEWS.files) { go('files', { pid: pg.S.ui.folderPid }); return; }
    if (changed && R.cur && pg.S.ui.view !== 'folders') { leaveDk(); }
    drawSide(); crumb(); refreshDk(); decorate();
  }
  /* the work status on the dashboard's own project cards and project page, with a picker on the page */
  function decorate() {
    var pg = page(), A = window.MorfisArt;
    if (!pg || !A || R.cur) return;
    document.querySelectorAll('#view .pcard[data-id]').forEach(function (c) {
      var p = pg.P(c.dataset.id), code = c.querySelector('.pcard-top .code'), st = p && A.statusOf(p, pg.today());
      if (!p || !code) return;
      var old = c.querySelector('.dk-st');
      if (old && old.dataset.st === st) return;
      if (old) old.remove();
      code.insertAdjacentHTML('beforeend', '<span class="dk-st" data-st="' + st + '">' + A.statusTag(st) + '</span>');
    });
    var head = document.querySelector('#view .ph-head .sec-head');
    if (head && pg.S.ui.view === 'project') {
      var p = pg.P(pg.S.ui.pid), st = p && A.statusOf(p, pg.today()), b = head.querySelector('.dk-st-pick');
      if (p && (!b || b.dataset.st !== st)) {
        if (b) b.remove();
        head.insertAdjacentHTML('beforeend', '<button type="button" class="st-pick dk-st-pick" data-st="' + st + '" data-status-menu="' + esc(p.id) + '" title="Change the project status">' + A.statusTag(st, ic('chev', 12)) + '</button>');
      }
    }
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('#view [data-status-menu]');
    if (b && window.Morfis.statusMenu) { e.preventDefault(); e.stopPropagation(); window.Morfis.statusMenu(b, b.dataset.statusMenu); }
  }, true);
  var renderT = 0;
  window.addEventListener('morfis:render', function () { cancelAnimationFrame(renderT); renderT = requestAnimationFrame(onPageRender); });
  document.addEventListener('input', function (e) { if (e.target && e.target.id === 'q' && R.cur && VIEWS[R.cur].search) VIEWS[R.cur].search(e.target.value); }, true);

  /* ===== sidebar ===== */
  var SHUT = {};
  try { SHUT = JSON.parse(localStorage.getItem('morfis:side') || '{}') || {}; } catch (e) { SHUT = {}; }
  function activeKey() {
    if (R.cur) return R.cur;
    var v = pageView();
    return v === 'project' ? 'project:' + page().S.ui.pid : v === 'folders' ? 'files' : v;
  }
  function item(key, label, icon, extra, tip) {
    var on = activeKey() === key || (key === 'projects' && /^project:/.test(activeKey()) && !SIDE_PROJECT_SHOWN);
    return '<button type="button" class="dk-it' + (on ? ' on' : '') + '" data-go="' + key + '" data-tip="' + esc(tip || label) + '"' + (on ? ' aria-current="page"' : '') + '>' + ic(icon, 18) + '<span>' + esc(label) + '</span>' + (extra || '') + '</button>';
  }
  var SIDE_PROJECT_SHOWN = false;
  function grp(id, label, body, add) {
    return '<div class="dk-grp' + (SHUT[id] ? ' shut' : '') + ' dk-grp-' + id + '"><div class="dk-gh"><button type="button" data-shut="' + id + '"><span>' + label + '</span>' + ic('chev', 12).replace('class="ic"', 'class="ic dk-chev"') + '</button>' +
      (add ? '<button type="button" class="dk-add" data-side-act="' + add + '" aria-label="New" title="New">' + ic('plus', 14) + '</button>' : '') + '</div><nav class="dk-nav">' + body + '</nav></div>';
  }
  function logoHtml() {
    var pg = page(), icon = pg && pg.brandIcon ? pg.brandIcon() : '';
    return '<img src="' + esc(icon || 'app-icon.png') + '" alt="">';
  }
  var sideSig = '';
  function drawSide() {
    var el = $('#dkSide'), pg = page();
    if (!el || !pg || !pg.S) return;
    var S = pg.S, today = pg.today(), A = window.MorfisArt;
    var od = 0; try { od = pg.overdueCount(); } catch (e) { od = 0; }
    var bell = $('#bellN'), rem = bell && !bell.hidden ? +bell.textContent || 0 : 0;
    var drafts = window.MorfisDocs ? window.MorfisDocs.attention() : 0, auto = window.MorfisAuto ? window.MorfisAuto.attention() : 0;
    var list = Object.values(S.projects).filter(function (p) { var st = A.statusOf(p, today); return st !== 'completed' && st !== 'cancelled'; })
      .sort(function (a, b) { return String(b.code).localeCompare(String(a.code), undefined, { numeric: true }); });
    var more = SHUT.allProjects ? list.length : 7;
    SIDE_PROJECT_SHOWN = false;
    var projItems = list.slice(0, more).map(function (p) {
      var st = A.statusOf(p, today), key = 'project:' + p.id, on = activeKey() === key;
      if (on) SIDE_PROJECT_SHOWN = true;
      return '<button type="button" class="dk-it' + (on ? ' on' : '') + '" data-go="project" data-id="' + esc(p.id) + '" data-tip="' + esc(p.name) + '" title="' + esc(p.code + ' · ' + A.STATUS[st].label + ' · Stage ' + p.currentStage) + '">' +
        '<span class="dk-sq" style="--st:' + A.STATUS[st].color + '">' + p.currentStage + '</span><span>' + esc(p.name) + '</span></button>';
    }).join('') + (list.length > 7 ? '<button type="button" class="dk-it dk-more" data-side-act="allProjects"><span>' + (SHUT.allProjects ? 'Show fewer' : 'Show all ' + list.length) + '</span></button>' : '') +
      (list.length ? '' : '<div class="dk-it dk-more"><span>No active projects</span></div>');
    var n = function (v, cls) { return v ? '<span class="dk-n' + (cls ? ' ' + cls : '') + '">' + v + '</span>' : ''; };
    var html =
      '<div class="dk-scroll">' +
      grp('ws', 'Workspace', item('home', 'Home', 'home') + item('projects', 'Projects', 'projects') + item('timeline', 'Timeline', 'timeline') + item('payments', 'Payments', 'payments', n(od, 'bad'), 'Payments' + (od ? ', ' + od + ' overdue' : ''))) +
      grp('studio', 'Studio', item('files', 'Files', 'files') + item('documents', 'Invoices & quotes', 'documents', n(drafts)) + item('automations', 'Automations', 'automations', n(auto))) +
      '<div class="dk-grp-p">' + grp('proj', 'Active projects', projItems, 'newProject') + '</div>' +
      '</div>' +
      '<div class="dk-foot">' +
      '<button type="button" class="dk-it" data-side-act="reminders" data-tip="Reminders">' + ic('bell', 18) + '<span>Reminders</span>' + n(rem) + '</button>' +
      item('settings', 'Settings', 'settings') +
      '<button type="button" class="dk-it" data-side-act="help" data-tip="Help and shortcuts">' + ic('help', 18) + '<span>Help</span></button>' +
      '<div class="dk-save"><i></i><span>Saved on this computer</span></div></div>';
    if (html === sideSig) return;
    sideSig = html;
    var sc = el.querySelector('.dk-scroll'), top = sc ? sc.scrollTop : 0;
    el.innerHTML = html;
    sc = el.querySelector('.dk-scroll'); if (sc) sc.scrollTop = top;
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('#dkSide [data-go], #dkSide [data-side-act], #dkSide [data-shut]');
    if (!b) return;
    var pg = page();
    if (b.dataset.shut) { SHUT[b.dataset.shut] = !SHUT[b.dataset.shut]; saveSide(); sideSig = ''; drawSide(); return; }
    if (b.dataset.go) { go(b.dataset.go, { id: b.dataset.id }); return; }
    var a = b.dataset.sideAct;
    if (a === 'collapse') toggleCollapse();
    else if (a === 'newProject' && pg) pg.newProject();
    else if (a === 'reminders' && pg) pg.openReminders();
    else if (a === 'help') { var h = $('#side [data-act=openHelp]'); if (h) h.click(); }
    else if (a === 'allProjects') { SHUT.allProjects = !SHUT.allProjects; saveSide(); sideSig = ''; drawSide(); }
  });
  function saveSide() { try { localStorage.setItem('morfis:side', JSON.stringify(SHUT)); } catch (e) { /* ignore */ } }
  /* the sidebar button lives in the window bar, left of the app name */
  document.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('#wbarSide')) toggleCollapse(); });
  function toggleCollapse() { var v = !root.classList.contains('side-collapsed'); root.classList.toggle('side-collapsed', v); if (P) { P.sideCollapsed = v; H.setPref('sideCollapsed', v).catch(function () {}); } }
  function focusSearch() { var q = $('#q'); if (q) { q.focus(); q.select(); } }
  document.addEventListener('keydown', function (e) {
    var k = (e.key || '').toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'k') { e.preventDefault(); focusSearch(); }
    else if ((e.ctrlKey || e.metaKey) && k === 'b' && !/^(INPUT|TEXTAREA)$/.test((e.target && e.target.tagName) || '')) { e.preventDefault(); toggleCollapse(); }
  });

  /* ===== window bar: app icon, name and where you are ===== */
  function crumb() {
    var pg = page(), el = $('#wbarCrumb'), nm = $('#wbarName'), icn = $('#wbarIcon');
    if (!pg || !el) return;
    if (nm) nm.textContent = pg.brandName ? pg.brandName() : 'Studio Morfis';
    if (icn) { var src = (pg.brandIcon && pg.brandIcon()) || 'app-icon.png'; if (icn.dataset.src !== src) { icn.dataset.src = src; icn.innerHTML = '<img src="' + esc(src) + '" alt="">'; } }
    var t = '';
    if (R.cur) t = VIEWS[R.cur].crumb ? VIEWS[R.cur].crumb() : VIEWS[R.cur].title;
    else if (pageView() === 'project') { var p = pg.P(pg.S.ui.pid); t = 'Projects / ' + (p ? p.name : ''); }
    else t = PAGE_VIEWS[pageView()] || '';
    el.textContent = t;
    root.setAttribute('data-dk-view', R.cur || pageView());
    var tt = $('#wbarTitle'); if (tt) tt.textContent = '';
  }

  /* ===== look: classes on <html>, the same ones the main process sets before first paint ===== */
  var CLASS_PREFS = {
    controls: function (v) { ['windows', 'pill', 'mac'].forEach(function (k) { root.classList.toggle('wc-' + k, k === v); }); },
    font: function (v) { ['inter', 'segoe', 'technical', 'system', 'studio'].forEach(function (k) { root.classList.toggle('font-' + k, k === v); }); },
    density: function (v) { ['comfortable', 'compact'].forEach(function (k) { root.classList.toggle('density-' + k, k === v); }); },
    titleBar: function (v) { root.classList.toggle('no-wtitle', v === 'none'); },
    reduceMotion: function (v) { root.classList.toggle('reduce-motion', !!v); },
    pattern: function (v) { root.classList.toggle('no-pattern', !v); },
    glow: function (v) { root.classList.toggle('no-glow', !v); },
    followGlow: function (v) { root.classList.toggle('no-follow', !v); },
    roundCorners: function (v) { root.classList.toggle('square', !v); },
    sideCollapsed: function (v) { root.classList.toggle('side-collapsed', !!v); }
  };
  function applyLook() { Object.keys(CLASS_PREFS).forEach(function (k) { CLASS_PREFS[k](P[k]); }); }

  /* keep the splash screen in the current accent */
  var lookT = null;
  function syncAccent() {
    clearTimeout(lookT);
    lookT = setTimeout(function () {
      var a = getComputedStyle(root).getPropertyValue('--accent-fill').trim().toUpperCase();
      if (/^#[0-9A-F]{6}$/.test(a) && P && a !== String(P.accent).toUpperCase()) { P.accent = a; H.setPref('accent', a).catch(function () {}); }
    }, 600);
  }

  /* ===== Settings > Desktop app ===== */
  var seg = function (key, opts) {
    return '<div class="seg-ctl" role="group">' + opts.map(function (o) {
      var on = String(P[key]) === String(o[0]);
      return '<button type="button" class="' + (on ? 'on' : '') + '" data-dk="' + key + '" data-v="' + esc(o[0]) + '" aria-pressed="' + on + '">' + esc(o[1]) + '</button>';
    }).join('') + '</div>';
  };
  var sw = function (key, label, sub) {
    return '<label class="switch dk-sw"><input type="checkbox" data-dk-bool="' + key + '"' + (P[key] ? ' checked' : '') + '><span><span class="dk-l">' + label + '</span>' + (sub ? '<span class="small muted dk-s">' + sub + '</span>' : '') + '</span></label>';
  };
  var field = function (label, body) { return '<div class="field"><span class="fl">' + label + '</span>' + body + '</div>'; };
  function cardHtml() {
    return '<section class="card stack dk-card" id="dkCard" aria-labelledby="dkTitle">' +
      '<div class="dk-head"><div><h2 id="dkTitle">Desktop app</h2><p class="muted small" style="margin-top:4px">How the program looks and behaves on this computer. Changes apply straight away.</p></div>' +
      '<span class="chip">Version ' + esc(P.version) + '</span></div>' +
      '<div class="dk-grid">' +
      '<div class="dk-sec"><h3>Window</h3>' +
        field('Window buttons', seg('controls', [['windows', 'Windows'], ['pill', 'Soft pill'], ['mac', 'Round']])) +
        '<div class="dk-prev" aria-hidden="true"><span class="dk-prev-bar"><i class="dk-prev-t"></i><span class="dk-prev-b"><b></b><b></b><b></b></span></span></div>' +
        field('Title bar', seg('titleBar', [['name', 'Show where you are'], ['none', 'Clean']])) +
        sw('sideCollapsed', 'Narrow sidebar', 'Icons only. Ctrl+B switches it') +
        sw('alwaysOnTop', 'Keep on top of other windows') +
        sw('rememberWindow', 'Reopen at the same size and place') +
      '</div>' +
      '<div class="dk-sec"><h3>Look</h3>' +
        field('Font', seg('font', [['inter', 'Inter'], ['segoe', 'Segoe UI'], ['technical', 'Technical'], ['system', 'System'], ['studio', 'Studio classic']])) +
        field('Spacing', seg('density', [['comfortable', 'Comfortable'], ['compact', 'Compact']])) +
        sw('pattern', 'Dot grid background', 'Fine dots behind the content') +
        sw('followGlow', 'Light follows the pointer', 'A soft accent glow under the pointer that lights up the dots') +
        sw('glow', 'Accent wash', 'A faint wash of the accent colour at the top of the page') +
        sw('roundCorners', 'Rounded corners') +
        sw('reduceMotion', 'Reduce motion', 'Turns off animations everywhere') +
      '</div>' +
      '<div class="dk-sec"><h3>Starting and closing</h3>' +
        sw('splash', 'Loading animation', 'The short card shown while the dashboard opens') +
        sw('launchAtLogin', 'Open when Windows starts') +
        sw('startMinimized', 'Start minimised', P.closeToTray ? 'Starts in the notification area' : 'Starts on the taskbar') +
        sw('closeToTray', 'Closing keeps it running', 'The close button hides the window to the notification area, so reminders and automations keep running') +
        sw('confirmQuit', 'Ask before quitting') +
      '</div>' +
      '<div class="dk-sec"><h3>System</h3>' +
        sw('spellcheck', 'Check spelling while typing') +
        sw('globalHotkey', 'Show or hide with ' + esc(P.hotkey), 'Works from any program') +
        sw('hwAccel', 'Graphics acceleration', 'Turn off if the window flickers. Needs a restart') +
        sw('devTools', 'Developer tools', 'Ctrl+Shift+I opens them') +
      '</div>' +
      '<div class="dk-sec"><h3>Automatic backups</h3>' +
        '<p class="small muted">A copy of every project, invoice and quotation is saved each day in <span class="mono" style="overflow-wrap:anywhere">' + esc(P.backups) + '</span>.</p>' +
        field('Keep', seg('backupKeep', P.choices.backupKeep.map(function (x) { return [x, x + ' days']; }))) +
        '<div class="toolbar"><button type="button" class="btn sm" data-dk-act="backupNow">Back up now</button><button type="button" class="btn sm" data-dk-act="openBackups">Open backups folder</button></div>' +
      '</div>' +
      '<div class="dk-sec"><h3>Program</h3>' +
        '<p class="small muted">' + esc(P.name) + ' ' + esc(P.version) + (P.packaged ? '' : ' (development)') + '. Keys: Ctrl+K search, Ctrl+B sidebar, F11 full screen, Ctrl + and Ctrl − to zoom.</p>' +
        '<div class="toolbar"><button type="button" class="btn sm" data-dk-act="refreshShortcuts">Refresh Start menu and shortcuts</button><button type="button" class="btn sm" data-dk-act="relaunch">Restart</button><button type="button" class="btn sm danger ghost" data-dk-act="resetPrefs">Reset these settings</button></div>' +
      '</div>' +
      '</div></section>';
  }
  function placeCard() {
    if (!P) return;
    var brand = document.querySelector('#view .brand-card');
    if (!brand) return;
    var old = document.getElementById('dkCard');
    if (old && old.previousElementSibling === brand) return;
    if (old) old.remove();
    brand.insertAdjacentHTML('afterend', cardHtml());
  }
  function redrawCard() {
    var old = document.getElementById('dkCard');
    if (!old) return;
    var y = $('#view').scrollTop;
    old.outerHTML = cardHtml();
    $('#view').scrollTop = y;
  }
  function setPref(key, value) {
    var prev = P[key];
    P[key] = value;
    if (CLASS_PREFS[key]) CLASS_PREFS[key](value);
    redrawCard();
    return H.setPref(key, value).then(function (r) {
      P[key] = r.value;
      if (r.restart) { if (window.confirm('Restart now to apply this?')) H.relaunch(); else toast('This applies the next time the app starts.'); }
      if (key === 'globalHotkey' && value && r.ok === false) { P[key] = false; H.setPref(key, false); redrawCard(); toast('Another program already uses ' + P.hotkey + '.'); }
      if (key === 'closeToTray' || key === 'startMinimized') redrawCard();
      return r;
    }, function (e) { P[key] = prev; if (CLASS_PREFS[key]) CLASS_PREFS[key](prev); redrawCard(); toast('Could not change that: ' + (e && e.message ? e.message : 'unknown error')); });
  }
  var ACTS = {
    backupNow: function () { H.backupNow().then(function (f) { toast(f ? 'Backup saved.' : 'There is nothing to back up yet.'); }, function () { toast('Could not save the backup.'); }); },
    openBackups: function () { H.openBackups().catch(function () { toast('Could not open the backups folder.'); }); },
    refreshShortcuts: function () { H.refreshShortcuts().then(function (r) { toast(r && r.updated ? 'Updated ' + r.updated + ' shortcut' + (r.updated === 1 ? '' : 's') + '.' : 'Shortcuts are up to date.'); }, function () { toast('Could not update the shortcuts.'); }); },
    relaunch: function () { H.relaunch(); },
    resetPrefs: function () {
      if (!window.confirm('Put every desktop setting back to how it started? Your projects, documents, app name and icon stay as they are.')) return;
      H.resetPrefs().then(function () { return H.getPrefs(); }).then(function (p) { P = p; applyLook(); redrawCard(); toast('Desktop settings reset.'); });
    }
  };
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('#dkCard [data-dk], #dkCard [data-dk-act]');
    if (!b) return;
    if (b.dataset.dkAct) { ACTS[b.dataset.dkAct](); return; }
    var k = b.dataset.dk, v = b.dataset.v;
    setPref(k, typeof P[k] === 'number' ? +v : v);
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.matches || !t.matches('#dkCard [data-dk-bool]')) return;
    setPref(t.dataset.dkBool, t.checked);
  });

  /* ===== shared helpers for the desktop views ===== */
  function modal(title, body, o) {
    var pg = page(); if (!pg) return;
    pg.openModal('<div class="dlg-head"><h2>' + esc(title) + '</h2><button type="button" class="icon-btn" data-act="close" aria-label="Close">' + ic('x', 18) + '</button></div>' + body, Object.assign({ label: title }, o || {}));
  }
  function money(n) { var pg = page(), cur = (pg && pg.S.settings.currency) || 'LKR'; return cur + ' ' + Math.round(+n || 0).toLocaleString('en-US'); }
  function uid(prefix) { return (prefix || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function ymd(d) { d = d || new Date(); var p2 = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function addDays(s, n) { var d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); }
  function fdate(s) { if (!s) return ''; var d = new Date(s + 'T00:00:00'); return isNaN(d) ? s : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
  /* a project's work status, saved with the project; Completed and Cancelled close it in the dashboard too */
  function setWorkStatus(pid, st) {
    var pg = page(), p = pg && pg.P(pid);
    if (!p || !window.MorfisArt.STATUS[st]) return;
    if (p.workStatus !== st) p.workStatusAt = pg.today();
    p.workStatus = st;
    p.status = st === 'completed' || st === 'cancelled' ? 'closed' : 'active';
    pg.commit(p);
    window.dispatchEvent(new CustomEvent('morfis:status', { detail: { pid: pid, status: st } }));
  }

  window.Morfis = {
    H: H, page: page, esc: esc, ic: ic, toast: toast, modal: modal, money: money, uid: uid, ymd: ymd, addDays: addDays, fdate: fdate,
    prefs: function () { return P; }, setPref: setPref, setWorkStatus: setWorkStatus,
    register: function (name, v) { VIEWS[name] = v; }, go: go, current: function () { return R.cur; }, redrawSide: function () { sideSig = ''; drawSide(); }, crumb: crumb
  };

  /* ===== background: a dot grid, and a soft accent light that eases after the pointer =====
     Only transforms change while the pointer moves, so it costs the compositor, not a repaint. */
  function background() {
    var w = win(); if (!w || w.querySelector('.dk-bg')) return;
    w.insertAdjacentHTML('afterbegin', '<div class="dk-bg" aria-hidden="true"><i class="dk-bg-grid"></i><i class="dk-bg-glow"></i><span class="dk-bg-spot"><i class="dk-bg-grid dk-bg-hi"></i></span></div>');
    var bg = w.querySelector('.dk-bg'), glow = bg.querySelector('.dk-bg-glow'), spot = bg.querySelector('.dk-bg-spot'), hi = bg.querySelector('.dk-bg-hi');
    var tx = 0, ty = 0, x = 0, y = 0, raf = 0, box = null, on = false;
    var R2 = 260;
    function frame() {
      x += (tx - x) * 0.18; y += (ty - y) * 0.18;
      glow.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0)';
      spot.style.transform = 'translate3d(' + (x - R2).toFixed(1) + 'px,' + (y - R2).toFixed(1) + 'px,0)';
      hi.style.transform = 'translate3d(' + (R2 - x).toFixed(1) + 'px,' + (R2 - y).toFixed(1) + 'px,0)';
      raf = Math.abs(tx - x) + Math.abs(ty - y) > 0.4 ? requestAnimationFrame(frame) : 0;
    }
    w.addEventListener('pointermove', function (e) {
      if (root.classList.contains('no-follow') || root.classList.contains('reduce-motion')) return;
      if (!box) box = w.getBoundingClientRect();
      tx = e.clientX - box.left; ty = e.clientY - box.top;
      if (!on) { on = true; x = tx; y = ty; bg.classList.add('lit'); }
      if (!raf) raf = requestAnimationFrame(frame);
    }, { passive: true });
    w.addEventListener('pointerleave', function () { on = false; bg.classList.remove('lit'); });
    window.addEventListener('resize', function () { box = null; hi.style.width = w.clientWidth + 'px'; hi.style.height = w.clientHeight + 'px'; });
    hi.style.width = w.clientWidth + 'px'; hi.style.height = w.clientHeight + 'px';
  }

  /* ===== accent colour picker =====
     The page's colour field opens this in-app picker (the system dialog did not always hand the colour back).
     It drives the same field, so the page previews while dragging and saves when the picker closes. */
  var CP = null;
  function hexToHsv(h) {
    var m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return { h: 250, s: 0.55, v: 0.94 };
    var n = parseInt(m[1], 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, hh = 0;
    if (d) hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hh = Math.round(hh * 60); if (hh < 0) hh += 360;
    return { h: hh, s: mx ? d / mx : 0, v: mx };
  }
  function hsvToHex(o) {
    var c = o.v * o.s, xx = c * (1 - Math.abs((o.h / 60) % 2 - 1)), m = o.v - c, rgb = [0, 0, 0], i = Math.floor(o.h / 60) % 6;
    rgb = [[c, xx, 0], [xx, c, 0], [0, c, xx], [0, xx, c], [xx, 0, c], [c, 0, xx]][i];
    return '#' + rgb.map(function (k) { var v = Math.round((k + m) * 255).toString(16); return v.length < 2 ? '0' + v : v; }).join('').toUpperCase();
  }
  function closePicker(save) {
    if (!CP) return;
    var cp = CP; CP = null;
    cp.el.remove();
    document.removeEventListener('pointerdown', cp.outside, true);
    document.removeEventListener('keydown', cp.key, true);
    var f = document.getElementById('lk-pick') || cp.input;
    if (save) { f.value = cp.hex.toLowerCase(); f.dispatchEvent(new Event('change', { bubbles: true })); }
    else { f.value = cp.start.toLowerCase(); f.dispatchEvent(new Event('input', { bubbles: true })); }
  }
  function openPicker(input) {
    closePicker(true);
    var start = String(input.value || '#7C6CF0').toUpperCase(), hsv = hexToHsv(start);
    var el = document.createElement('div');
    el.className = 'dk-cp'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Accent colour');
    el.innerHTML = '<div class="dk-cp-sv"><i class="dk-cp-dot"></i></div>' +
      '<input type="range" class="dk-cp-hue" min="0" max="359" step="1" aria-label="Hue">' +
      '<div class="dk-cp-row"><span class="dk-cp-sw"></span><input class="in mono dk-cp-hex" maxlength="7" spellcheck="false" aria-label="Hex code"><button type="button" class="btn sm" data-cp="cancel">Cancel</button><button type="button" class="btn sm primary" data-cp="ok">Use colour</button></div>';
    document.body.appendChild(el);
    var sv = el.querySelector('.dk-cp-sv'), dot = el.querySelector('.dk-cp-dot'), hue = el.querySelector('.dk-cp-hue'), hex = el.querySelector('.dk-cp-hex'), swc = el.querySelector('.dk-cp-sw');
    var cp = CP = { el: el, input: input, start: start, hex: start };
    var pend = 0;
    function paint(fromHex) {
      cp.hex = hsvToHex(hsv);
      sv.style.setProperty('--h', hsv.h);
      dot.style.left = (hsv.s * 100) + '%'; dot.style.top = ((1 - hsv.v) * 100) + '%';
      hue.value = hsv.h; swc.style.background = cp.hex;
      if (!fromHex && document.activeElement !== hex) hex.value = cp.hex;
      if (!pend) pend = requestAnimationFrame(function () { pend = 0; var f = document.getElementById('lk-pick') || input; f.value = cp.hex.toLowerCase(); f.dispatchEvent(new Event('input', { bubbles: true })); });
    }
    function fromPoint(e) {
      var r = sv.getBoundingClientRect();
      hsv.s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      hsv.v = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
      paint();
    }
    sv.addEventListener('pointerdown', function (e) { sv.setPointerCapture(e.pointerId); fromPoint(e); });
    sv.addEventListener('pointermove', function (e) { if (sv.hasPointerCapture(e.pointerId)) fromPoint(e); });
    hue.addEventListener('input', function () { hsv.h = +hue.value; paint(); });
    hex.addEventListener('input', function () { var v = hex.value.trim(); if (v[0] !== '#') v = '#' + v; if (/^#[0-9a-f]{6}$/i.test(v)) { hsv = hexToHsv(v); paint(true); } });
    hex.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); closePicker(true); } });
    el.addEventListener('click', function (e) { var b = e.target.closest('[data-cp]'); if (b) closePicker(b.dataset.cp === 'ok'); });
    cp.outside = function (e) { if (!el.contains(e.target) && e.target !== input) closePicker(true); };
    cp.key = function (e) { if (e.key === 'Escape') { e.stopPropagation(); closePicker(false); } };
    document.addEventListener('pointerdown', cp.outside, true);
    document.addEventListener('keydown', cp.key, true);
    var r = input.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
    var left = Math.min(window.innerWidth - w - 12, Math.max(12, r.left)), top = r.bottom + 8;
    if (top + h > window.innerHeight - 12) top = Math.max(52, r.top - h - 8);
    el.style.left = left + 'px'; el.style.top = top + 'px';
    paint();
    hex.value = cp.hex;
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.id === 'lk-pick') { e.preventDefault(); if (CP && CP.input === t) closePicker(true); else openPicker(t); }
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.target && e.target.id === 'lk-pick' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openPicker(e.target); }
  }, true);

  /* ===== start ===== */
  H.getPrefs().then(function (p) { P = p; applyLook(); placeCard(); window.dispatchEvent(new CustomEvent('morfis:prefs', { detail: p })); });
  var mo = new MutationObserver(function () { placeCard(); });
  var start = function () {
    var v = $('#view'); if (v) mo.observe(v, { childList: true });
    var bell = $('#bellBtn'); if (bell) new MutationObserver(function () { drawSide(); }).observe(bell, { childList: true, subtree: true, characterData: true, attributes: true });
    new MutationObserver(syncAccent).observe(root, { attributes: true, attributeFilter: ['style', 'data-theme'] });
    var sb = $('#wbarSide'); if (sb) sb.innerHTML = ic('collapse', 16);
    syncAccent(); drawSide(); crumb(); background();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  /* dropping a file anywhere outside a drop zone must never navigate the window away */
  window.addEventListener('dragover', function (e) { if (e.dataTransfer && [].indexOf.call(e.dataTransfer.types || [], 'Files') !== -1) e.preventDefault(); });
  window.addEventListener('drop', function (e) { if (e.dataTransfer && [].indexOf.call(e.dataTransfer.types || [], 'Files') !== -1) e.preventDefault(); });
})();
