/* Direct projects: the studio's own projects (stages, tasks, milestone invoices), shown the way Freelance shows jobs.
   A list with the numbers that matter, cards with the folder, and a page per project with its status, its
   progress, its money and its folder browsed right there. The full project page (timeline, tasks, invoices) is one
   click away. */
(function () {
  'use strict';
  var M = window.Morfis, A = window.MorfisArt;
  if (!M || !A) return;
  var H = M.H, esc = M.esc, ic = M.ic, pg = M.page;
  var F = { open: null, filter: 'open', q: '' };
  var today = function () { return pg().today(); };
  var statusOf = function (p) { return A.statusOf(p, today()); };
  var isOpen = function (p) { var s = statusOf(p); return s !== 'completed' && s !== 'cancelled'; };
  var onDisk = function (p) { return !!(p.foldersCreated && !p.dirMissing); };
  var money = function (n) { return M.money(n); };
  function stage(p) { var n = Math.min(7, Math.max(1, p.currentStage || 1)); return { n: n, s: pg().STAGES[n - 1], d: (p.stages || [])[n - 1] || {} }; }
  function fin(p) { try { return pg().projectFinance(p, today()); } catch (e) { return { contract: +p.budget || 0, received: 0, overdue: 0 }; } }
  function prog(p) { try { return pg().projectProgress(p); } catch (e) { return { pct: 0, done: 0, total: 0 }; } }
  function nextTask(p) { return (p.tasks || []).filter(function (t) { return t.status !== 'done' && t.due; }).sort(function (a, b) { return a.due.localeCompare(b.due); })[0]; }
  function dueText(p) {
    var st = stage(p), end = st.d.end;
    if (!isOpen(p)) return A.STATUS[statusOf(p)].label;
    if (!end) return st.s.short;
    var d = Math.round((new Date(end + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 864e5);
    return st.s.short + ' · ' + (d < 0 ? (-d) + ' day' + (d === -1 ? '' : 's') + ' over' : d === 0 ? 'ends today' : 'ends in ' + d + ' day' + (d === 1 ? '' : 's'));
  }
  var late = function (p) { var e = stage(p).d.end; return isOpen(p) && e && e < today(); };

  function list() {
    var q = F.q.trim().toLowerCase();
    return Object.values(pg().S.projects).filter(function (p) {
      if (F.filter === 'open' && !isOpen(p)) return false;
      if (F.filter === 'done' && isOpen(p)) return false;
      return !q || [p.code, p.name, p.client && p.client.name, p.location].join(' ').toLowerCase().indexOf(q) !== -1;
    }).sort(function (a, b) { return isOpen(b) - isOpen(a) || String(b.code).localeCompare(String(a.code), undefined, { numeric: true }); });
  }
  function card(p) {
    var st = statusOf(p), g = prog(p), f = fin(p);
    return '<div class="fl-card" role="button" tabindex="0" data-dp-open="' + esc(p.id) + '">' +
      '<div class="fx-art">' + A.folder({ status: st, count: g.total }) + '</div>' +
      '<div class="fl-c-body"><span class="fl-code mono">' + esc(p.code) + '</span><b class="fl-title">' + esc(p.name) + '</b>' +
      '<span class="fl-sub">' + esc([p.client && p.client.name, p.location].filter(Boolean).join(' · ')) + '</span>' +
      '<div class="fl-prog"><i style="width:' + g.pct + '%"></i></div>' +
      '<div class="fl-c-foot"><span class="' + (late(p) ? 'fl-late' : '') + '">' + esc(dueText(p)) + '</span><span>' + g.pct + '% of checklist</span></div>' +
      '<div class="fl-c-foot"><span class="mono">' + esc(money(f.contract)) + '</span>' + (f.overdue ? '<span class="chip fl-late">' + esc(money(f.overdue)) + ' overdue</span>' : f.received ? '<span class="chip">' + esc(money(f.received)) + ' received</span>' : '<span class="muted">Nothing received</span>') + '</div></div></div>';
  }
  function listView() {
    var all = Object.values(pg().S.projects), open = all.filter(isOpen);
    var week = open.filter(function (p) { var e = stage(p).d.end; return e && e >= today() && e <= M.addDays(today(), 7); }).length;
    var toGet = all.reduce(function (a, p) { var f = fin(p); return a + Math.max(0, (f.contract || 0) - (f.received || 0)); }, 0);
    var overdue = all.reduce(function (a, p) { return a + (fin(p).overdue || 0); }, 0);
    var rows = list(), seg = [['open', 'Open'], ['done', 'Completed & closed'], ['all', 'All']];
    return '<div class="fx-head"><div><h1>Direct <span class="mono-g">projects</span></h1><p class="muted">The studio’s own projects: stages, tasks, milestone invoices and the six project folders.</p></div>' +
      '<div class="toolbar"><button type="button" class="btn" data-dp-act="root">' + ic('ext', 15) + 'Open the Direct Projects folder</button><button type="button" class="btn primary" data-dp-act="new">New project' + ic('plus', 15) + '</button></div></div>' +
      '<div class="fl-kpis"><div class="kpi"><span class="lbl">Open projects</span><span class="val">' + open.length + '</span><span class="small ' + (open.some(late) ? 'bad-t' : 'muted') + '">' + (open.filter(late).length ? open.filter(late).length + ' past their stage' : 'All on time') + '</span></div>' +
      '<div class="kpi"><span class="lbl">Stages ending in 7 days</span><span class="val">' + week + '</span></div>' +
      '<div class="kpi"><span class="lbl">Still to be received</span><span class="val">' + esc(money(toGet)) + '</span><span class="small ' + (overdue ? 'bad-t' : 'muted') + '">' + (overdue ? esc(money(overdue)) + ' overdue' : 'Nothing overdue') + '</span></div></div>' +
      '<div class="fx-sec-h"><div class="seg-ctl" role="group">' + seg.map(function (s) { return '<button type="button" class="' + (F.filter === s[0] ? 'on' : '') + '" data-dp-filter="' + s[0] + '">' + s[1] + '</button>'; }).join('') + '</div><span class="count">' + rows.length + '</span></div>' +
      (rows.length ? '<div class="fl-grid">' + rows.map(card).join('') + '</div>' :
        '<div class="fx-empty fx-empty-col"><b>' + (all.length ? 'No projects in this list' : 'No direct projects yet') + '</b><span>A freelance job that grows into a full project can be moved here from its page or its folder’s menu in Files.</span><span class="toolbar"><button type="button" class="btn primary" data-dp-act="new">New project' + ic('plus', 15) + '</button></span></div>');
  }

  /* ----- one project ----- */
  var BR = null, brFor = '';
  function browser(p) {
    if (!BR || brFor !== p.id) {
      brFor = p.id;
      BR = window.MorfisBrowser ? window.MorfisBrowser.make({ dir: function () { var x = pg().P(brFor); return x && onDisk(x) ? pg().projDir(x) : ''; }, label: function () { var x = pg().P(brFor); return x ? x.code : 'Folder'; }, onChange: function () { lastHtml = ''; draw(); } }) : null;
    }
    return BR;
  }
  var kv = function (k, v) { return '<div class="dp-kv"><span class="muted small">' + esc(k) + '</span><b>' + v + '</b></div>'; };
  function projectView(p) {
    var st = statusOf(p), g = prog(p), f = fin(p), sg = stage(p), nt = nextTask(p), dir = pg().projDir(p), b = onDisk(p) && browser(p);
    return '<div class="fx-crumbs"><button type="button" class="fx-cr" data-dp-act="back">Direct projects</button><span class="fx-sep">' + ic('chevR', 12) + '</span><span>' + esc(p.code) + '</span></div>' +
      '<div class="fx-head"><div class="fx-ptitle"><div class="fx-ptitle-art">' + A.folder({ status: st, count: g.total }) + '</div><div style="min-width:0;flex:1"><h1>' + esc(p.name) + '</h1>' +
      '<div class="fx-pmeta"><span class="mono">' + esc(p.code) + '</span><button type="button" class="st-pick" data-dp-status title="Change the status">' + A.statusTag(st, ic('chev', 12)) + '</button><span class="stg-tag"><b>' + sg.n + '</b>' + esc(sg.s.short) + '</span>' +
      '<span class="' + (late(p) ? 'fl-late' : 'muted') + '">' + esc(dueText(p)) + '</span></div></div></div>' +
      '<div class="toolbar"><button type="button" class="btn primary" data-dp-act="page">Project page' + ic('chevR', 15) + '</button><button type="button" class="btn" data-dp-act="toFreelance">' + ic('briefcase', 15) + 'Move to Freelance</button></div></div>' +
      '<div class="fl-cols"><div class="fl-main">' +
        '<section class="card stack"><div class="fx-sec-h" style="margin:0"><h2>Progress</h2><span class="count">' + g.done + ' / ' + g.total + '</span></div>' +
          '<div class="fl-prog dp-prog"><i style="width:' + g.pct + '%"></i></div>' +
          '<div class="dp-grid">' + kv('Stage', esc(sg.n + ' · ' + sg.s.name)) + kv('Stage dates', esc((sg.d.start ? M.fdate(sg.d.start) : '–') + ' to ' + (sg.d.end ? M.fdate(sg.d.end) : '–'))) +
          kv('Next task', nt ? esc(nt.title || nt.name || 'Task') + ' <span class="muted small">' + esc(M.fdate(nt.due)) + '</span>' : '<span class="muted">None open</span>') + kv('Checklist', g.pct + '%') + '</div></section>' +
        '<section class="card stack"><div class="fx-sec-h" style="margin:0"><h2>Folder</h2></div><div class="fx-path mono" title="' + esc(dir) + '">' + esc(dir) + '</div>' +
          (b ? b.html() : '<p class="small muted">The project’s six folders are not on this computer yet.</p><div class="toolbar"><button type="button" class="btn sm primary" data-dp-act="mkdir">Create the folders' + ic('plus', 14) + '</button></div>') + '</section>' +
      '</div><aside class="fl-side card stack">' +
        '<label class="field"><span class="fl">Status</span><select class="in" data-dp-f="status">' + A.ORDER.map(function (k) { return '<option value="' + k + '"' + (k === st ? ' selected' : '') + '>' + esc(k === 'not_started' ? 'Upcoming' : A.STATUS[k].label) + '</option>'; }).join('') + '</select></label>' +
        kv('Client', esc((p.client && p.client.name) || '–')) + kv('Contact', esc((p.client && p.client.contact) || '–')) + kv('Location', esc(p.location || '–')) + kv('Type', esc(p.type || '–')) +
        kv('Fee', esc(money(f.contract))) + kv('Received', esc(money(f.received))) + (f.overdue ? kv('Overdue', '<span class="fl-late">' + esc(money(f.overdue)) + '</span>') : '') +
        '<p class="small muted">Client, fee, stages and invoices are edited on the project page.</p>' +
      '</aside></div>';
  }

  var EL = null, lastHtml = '';
  function draw() {
    if (!EL || M.current() !== 'direct' || !pg() || !pg().S.ready) return;
    var p = F.open && pg().P(F.open);
    if (F.open && !p) F.open = null;
    var html = p ? projectView(p) : listView();
    if (html === lastHtml) return;
    if (document.querySelector('.dd-pop')) return;   /* a dropdown is open: redraw after it closes */
    lastHtml = html; var y = EL.scrollTop; EL.innerHTML = html; EL.scrollTop = y;
    if (p && BR && brFor === p.id) BR.mount(EL);
    M.crumb();
  }
  function bind(el) {
    if (el.dataset.dpBound) return;
    el.dataset.dpBound = '1';
    el.addEventListener('click', function (e) {
      if (M.current() !== 'direct') return;
      var t = e.target, b, p = F.open && pg().P(F.open);
      if (p && BR && brFor === p.id && BR.handle(e)) return;
      if ((b = t.closest('[data-dp-open]'))) { F.open = b.dataset.dpOpen; lastHtml = ''; draw(); EL.scrollTop = 0; return; }
      if ((b = t.closest('[data-dp-filter]'))) { F.filter = b.dataset.dpFilter; draw(); return; }
      if ((b = t.closest('[data-dp-status]')) && p) { M.statusMenu(b, p.id); return; }
      if (!(b = t.closest('[data-dp-act]'))) return;
      var a = b.dataset.dpAct;
      if (a === 'new') { if (M.newProject) M.newProject('direct'); else pg().newProject(); }
      else if (a === 'back') { F.open = null; lastHtml = ''; draw(); M.crumb(); }
      else if (a === 'root') { var r = pg().S.settings.root; H.mkdirs([r]).then(function () { return H.openPath(r); }).catch(function () { M.toast('Could not open the folder.'); }); }
      else if (a === 'page' && p) M.go('project', { id: p.id });
      else if (a === 'toFreelance' && p && window.MorfisFreelance) window.MorfisFreelance.fromProject(p.id);
      else if (a === 'mkdir' && p) { var base = pg().projDir(p); H.mkdirs([base].concat(pg().FOLDER_TEMPLATES.map(function (x) { return M.jn(base, x.name); })), 'Folders for ' + p.code).then(function (r) { var bad = r.filter(function (x) { return !x.ok; }); if (bad.length) { M.toast('Windows refused: ' + bad[0].error); return; } p.folderPath = p.folderPath || base; p.foldersCreated = p.foldersCreated || today(); p.dirMissing = false; pg().commit(p); lastHtml = ''; draw(); }); }
    });
    el.addEventListener('change', function (e) { var p = F.open && pg().P(F.open); if (M.current() === 'direct' && p && e.target.dataset.dpF === 'status') { M.setWorkStatus(p.id, e.target.value); M.toast(p.name + ' is now ' + A.STATUS[e.target.value].label + '.'); lastHtml = ''; setTimeout(draw, 0); } });
    el.addEventListener('dblclick', function (e) { if (M.current() === 'direct' && BR) BR.dbl(e); });
    el.addEventListener('keydown', function (e) {
      if (M.current() !== 'direct') return;
      if (BR && BR.key2(e)) return;
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-dp-open]')) { e.preventDefault(); e.target.click(); }
    });
  }
  document.addEventListener('click', function () { if (M.current() === 'direct' && !document.querySelector('.dd-pop')) setTimeout(draw, 160); }, true);

  M.register('direct', {
    title: 'Direct projects', placeholder: 'Search direct projects',
    crumb: function () { var p = F.open && pg().P(F.open); return 'Direct projects' + (p ? ' / ' + p.name : ''); },
    render: function (el, o) { EL = el; lastHtml = ''; bind(el); F.open = o && o.id ? o.id : null; draw(); },
    refresh: function () { draw(); },
    search: function (q) { F.q = q; draw(); }
  });
  window.MorfisDirect = { open: function (id) { M.go('direct', { id: id }); }, attention: function () { var p = pg(); if (!p || !p.S.ready) return 0; return Object.values(p.S.projects).filter(late).length; } };
})();
