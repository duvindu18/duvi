/* Freelance: online jobs that do not follow the studio's project pattern.
   A client sends requirements (often through a marketplace such as Fiverr or Upwork), and the studio delivers 3D
   models, drawings and renderings by a deadline, for a fixed fee, with a set number of revisions. So a job has no
   seven stages, no task timeline, no milestone invoices and no six standard folders. It keeps what this work needs:
   the brief, a checklist of deliverables, the revisions used, the dates, the fee and what is paid, a status, and a
   small folder of its own (Freelance\<code I title> in the projects folder) with the folder icons in File Explorer.
   Jobs are kept in the app's own records (the same store the automations use), so the phone sees them too. */
(function () {
  'use strict';
  var M = window.Morfis, A = window.MorfisArt;
  if (!M || !A) return;
  var H = M.H, esc = M.esc, ic = M.ic, pg = M.page;
  var KEY = 'freelance:jobs';
  var JOBS = [], loaded = false, F = { open: null, filter: 'open', q: '' };
  var PLATFORMS = ['Fiverr', 'Upwork', 'Freelancer', 'Direct client', 'Other'];
  var KINDS = { model: '3D model', drawing: 'Drawings', render: 'Renderings', other: 'Other' };
  /* the job's folder, inside Freelance in the projects folder */
  var TEMPLATES = [
    { id: '01', name: '01_Brief_and_References', label: 'Brief & references' },
    { id: '02', name: '02_3D_Models', label: '3D models' },
    { id: '03', name: '03_Drawings', label: 'Drawings' },
    { id: '04', name: '04_Renders', label: 'Renders' },
    { id: '05', name: '05_Delivered', label: 'Delivered' }
  ];

  /* ----- records ----- */
  function load() { return H.kvGet(KEY).then(function (v) { JOBS = Array.isArray(v) ? v : []; var first = !loaded; loaded = true; M.redrawSide(); if (first && pg() && pg().S.ready && pg().S.ui.view === 'timeline') pg().renderAll(); return JOBS; }, function () { loaded = true; return JOBS; }); }
  var saveT = 0;
  function save(now) { clearTimeout(saveT); var go = function () { H.kvSet(KEY, JOBS).catch(function () { M.toast('Could not save the freelance jobs.'); }); M.redrawSide(); }; if (now) go(); else saveT = setTimeout(go, 400); }
  var byId = function (id) { return JOBS.find(function (j) { return j.id === id; }); };
  var today = function () { return pg().today(); };
  var statusOf = function (j) { return A.STATUS[j.status] ? j.status : 'in_progress'; };
  var isOpen = function (j) { var s = statusOf(j); return s !== 'completed' && s !== 'cancelled'; };
  /* after the main folder is split (Files > Reorganise), jobs live in <main>/Freelance Projects; before, in <projects>/Freelance */
  var root = function () { var st = pg().S.settings, m = st.mainRoot || ''; if (m) return M.jn(m, (st.groupNames && st.groupNames.free) || 'Freelance Projects'); var r = st.root || ''; return r ? M.jn(r, 'Freelance') : ''; };
  var safeName = function (s) { return String(s || '').replace(/[<>:"\/\\|?*\u0000-\u001F]/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim(); };
  var folderName = function (j) { return safeName(j.code + ' I ' + (j.title || 'Untitled job')); };
  var dirOf = function (j) { return j.folder || (root() ? M.jn(root(), folderName(j)) : ''); };
  function nextCode() {
    var yy = String(new Date().getFullYear()).slice(2), n = 0;
    JOBS.forEach(function (j) { var m = /^FL I (\d\d) I (\d+)/.exec(j.code || ''); if (m && m[1] === yy) n = Math.max(n, +m[2]); });
    return 'FL I ' + yy + ' I ' + String(n + 1).padStart(3, '0');
  }
  function blankJob(o) {
    o = o || {};
    var cur = (pg().S.settings.currency) || 'LKR';
    return Object.assign({
      id: M.uid('fl'), code: nextCode(), title: '', client: '', contact: '', platform: 'Fiverr', brief: '',
      deliverables: [{ id: M.uid('d'), kind: 'model', label: '3D model', qty: 1, done: false }, { id: M.uid('d'), kind: 'render', label: 'Renderings', qty: 4, done: false }],
      revisions: { included: 2, used: 0 }, received: today(), due: M.addDays(today(), 7), status: 'in_progress',
      fee: 0, currency: cur, paid: 0, delivered: '', folder: '', created: new Date().toISOString(), updated: ''
    }, o);
  }
  var done = function (j) { var d = j.deliverables || []; return { n: d.filter(function (x) { return x.done; }).length, of: d.length }; };
  function dueText(j) {
    if (!j.due) return '';
    if (statusOf(j) === 'completed') return 'Delivered' + (j.delivered ? ' ' + M.fdate(j.delivered) : '');
    var d = Math.round((new Date(j.due + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 864e5);
    return d < 0 ? (-d) + ' day' + (d === -1 ? '' : 's') + ' late' : d === 0 ? 'Due today' : d === 1 ? 'Due tomorrow' : 'Due in ' + d + ' days';
  }
  var late = function (j) { return isOpen(j) && j.due && j.due < today(); };
  var money = function (n, cur) { return (cur || 'LKR') + ' ' + Math.round(+n || 0).toLocaleString('en-US'); };

  /* ----- the list ----- */
  function list() {
    var q = F.q.trim().toLowerCase();
    return JOBS.filter(function (j) {
      if (F.filter === 'open' && !isOpen(j)) return false;
      if (F.filter === 'done' && isOpen(j)) return false;
      return !q || [j.code, j.title, j.client, j.platform].join(' ').toLowerCase().indexOf(q) !== -1;
    }).sort(function (a, b) { return isOpen(b) - isOpen(a) || String(a.due || '9').localeCompare(String(b.due || '9')) || String(b.code).localeCompare(String(a.code)); });
  }
  function card(j) {
    var st = statusOf(j), d = done(j);
    return '<div class="fl-card" role="button" tabindex="0" data-fl-open="' + esc(j.id) + '">' +
      '<div class="fx-art">' + A.folder({ status: st, count: d.of }) + '</div>' +
      '<div class="fl-c-body"><span class="fl-code mono">' + esc(j.code) + '</span><b class="fl-title">' + esc(j.title || 'Untitled job') + '</b>' +
      '<span class="fl-sub">' + esc([j.client, j.platform].filter(Boolean).join(' · ')) + '</span>' +
      '<div class="fl-prog"><i style="width:' + (d.of ? Math.round(d.n * 100 / d.of) : 0) + '%"></i></div>' +
      '<div class="fl-c-foot"><span class="' + (late(j) ? 'fl-late' : '') + '">' + esc(dueText(j)) + '</span><span>' + d.n + ' of ' + d.of + ' delivered</span></div>' +
      '<div class="fl-c-foot"><span class="mono">' + esc(money(j.fee, j.currency)) + '</span>' + (j.fee && (+j.paid || 0) >= +j.fee ? '<span class="chip">Paid</span>' : (+j.paid ? '<span class="chip">' + esc(money(j.paid, j.currency)) + ' paid</span>' : '<span class="muted">Not paid</span>')) + '</div></div></div>';
  }
  function listView() {
    var open = JOBS.filter(isOpen), week = open.filter(function (j) { return j.due && j.due <= M.addDays(today(), 7); }).length;
    var unpaid = {};
    JOBS.forEach(function (j) { var left = Math.max(0, (+j.fee || 0) - (+j.paid || 0)); if (left && statusOf(j) !== 'cancelled') unpaid[j.currency || 'LKR'] = (unpaid[j.currency || 'LKR'] || 0) + left; });
    var seg = [['open', 'Open'], ['done', 'Delivered & closed'], ['all', 'All']];
    var rows = list();
    return '<div class="fx-head"><div><h1>Freelance <span class="mono-g">jobs</span></h1><p class="muted">Online jobs from a client’s brief to 3D models, drawings and renderings: the deliverables, the deadline and the fee. No stages or task timelines.</p></div>' +
      '<div class="toolbar"><button type="button" class="btn" data-fl-act="root">' + ic('ext', 15) + 'Open the Freelance folder</button><button type="button" class="btn primary" data-fl-act="new">New job' + ic('plus', 15) + '</button></div></div>' +
      reorgNote() + '<div class="fl-kpis"><div class="kpi"><span class="lbl">Open jobs</span><span class="val">' + open.length + '</span></div><div class="kpi"><span class="lbl">Due in the next 7 days</span><span class="val">' + week + '</span><span class="small ' + (open.some(late) ? 'bad-t' : 'muted') + '">' + (open.filter(late).length ? open.filter(late).length + ' late' : 'None late') + '</span></div>' +
      '<div class="kpi"><span class="lbl">Still to be paid</span><span class="val">' + (Object.keys(unpaid).length ? Object.keys(unpaid).map(function (c) { return esc(money(unpaid[c], c)); }).join('<br>') : '0') + '</span></div></div>' +
      '<div class="fx-sec-h"><div class="seg-ctl" role="group">' + seg.map(function (s) { return '<button type="button" class="' + (F.filter === s[0] ? 'on' : '') + '" data-fl-filter="' + s[0] + '">' + s[1] + '</button>'; }).join('') + '</div><span class="count">' + rows.length + '</span></div>' +
      (rows.length ? '<div class="fl-grid">' + rows.map(card).join('') + '</div>' :
        '<div class="fx-empty fx-empty-col"><b>' + (JOBS.length ? 'No jobs in this list' : 'No freelance jobs yet') + '</b><span>Add a job when a client’s brief comes in. A studio project that is really a freelance job can be moved here from its folder’s menu in Files.</span><span class="toolbar"><button type="button" class="btn primary" data-fl-act="new">New job' + ic('plus', 15) + '</button></span></div>');
  }

  /* until the main folder is split, offer it: completed projects so far are freelance work */
  function reorgNote() {
    if (!window.MorfisReorg || !window.MorfisReorg.needed()) return '';
    return '<div class="fl-note card"><div><b>Split the projects folder</b><span class="muted small">Put direct projects in <span class="mono">Direct Projects</span> and freelance jobs in <span class="mono">Freelance Projects</span>. Completed projects become freelance jobs with the freelance folders. You can undo it.</span></div><button type="button" class="btn sm primary" data-fl-reorg>Reorganise…</button></div>';
  }

  /* ----- one job ----- */
  var sel = function (name, opts, v) { return '<select class="in" data-fl-f="' + name + '">' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(v) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>'; };
  var inp = function (name, v, type, extra) { return '<input class="in" data-fl-f="' + name + '" type="' + (type || 'text') + '" value="' + esc(v == null ? '' : v) + '"' + (extra || '') + '>'; };
  var fld = function (label, body) { return '<label class="field"><span class="fl">' + label + '</span>' + body + '</label>'; };
  function deliverable(x) {
    return '<div class="fl-del' + (x.done ? ' done' : '') + '" data-fl-del="' + esc(x.id) + '"><input type="checkbox" data-fl-d="done"' + (x.done ? ' checked' : '') + ' aria-label="Delivered">' +
      '<select class="in" data-fl-d="kind">' + Object.keys(KINDS).map(function (k) { return '<option value="' + k + '"' + (x.kind === k ? ' selected' : '') + '>' + KINDS[k] + '</option>'; }).join('') + '</select>' +
      '<input class="in" data-fl-d="label" value="' + esc(x.label || '') + '" placeholder="What is delivered">' +
      '<input class="in mono" data-fl-d="qty" type="number" min="1" value="' + esc(x.qty || 1) + '" aria-label="How many">' +
      '<button type="button" class="icon-btn" data-fl-d-x title="Remove">' + ic('x', 15) + '</button></div>';
  }
  function jobView(j) {
    var d = done(j), dir = dirOf(j), st = statusOf(j);
    return '<div class="fx-crumbs"><button type="button" class="fx-cr" data-fl-act="back">Freelance</button><span class="fx-sep">' + ic('chevR', 12) + '</span><span>' + esc(j.code) + '</span></div>' +
      '<div class="fx-head"><div class="fx-ptitle"><div class="fx-ptitle-art">' + A.folder({ status: st, count: d.of }) + '</div><div style="min-width:0;flex:1">' +
      '<input class="fl-h1" data-fl-f="title" value="' + esc(j.title) + '" placeholder="Name of the job">' +
      '<div class="fx-pmeta"><span class="mono">' + esc(j.code) + '</span>' + A.statusTag(st) + '<span class="' + (late(j) ? 'fl-late' : 'muted') + '">' + esc(dueText(j)) + '</span><span class="muted">' + d.n + ' of ' + d.of + ' delivered</span></div></div></div>' +
      '<div class="toolbar"><button type="button" class="btn" data-fl-act="invoice">' + ic('documents', 15) + 'Make the invoice</button><button type="button" class="btn" data-fl-act="toDirect">' + ic('layers', 15) + 'Move to Direct projects</button><button type="button" class="btn danger ghost" data-fl-act="delete">Delete</button></div></div>' +
      '<div class="fl-cols"><div class="fl-main">' +
        '<section class="card stack"><div class="fx-sec-h" style="margin:0"><h2>Client’s brief</h2></div><textarea class="in" data-fl-f="brief" rows="7"' + (briefH() ? ' style="height:' + briefH() + 'px"' : '') + ' placeholder="Paste the client’s requirements: what to model, drawings needed, render views, sizes, styles, references, file formats.">' + esc(j.brief) + '</textarea></section>' +
        '<section class="card stack"><div class="fx-sec-h" style="margin:0"><h2>Deliverables</h2><span class="count">' + d.n + ' / ' + d.of + '</span></div>' +
          '<div class="fl-dels">' + (j.deliverables || []).map(deliverable).join('') + '</div>' +
          '<div class="au-presets" style="justify-content:flex-start">' + Object.keys(KINDS).map(function (k) { return '<button type="button" class="chip-btn" data-fl-add="' + k + '">' + ic('plus', 12) + esc(KINDS[k]) + '</button>'; }).join('') + '</div></section>' +
        '<section class="card stack"><div class="fx-sec-h" style="margin:0"><h2>Folder</h2></div>' + folderBox(j, dir) + '</section>' +
      '</div><aside class="fl-side card stack">' +
        fld('Status', sel('status', A.ORDER.map(function (k) { return [k, k === 'not_started' ? 'Upcoming' : k === 'completed' ? 'Completed (delivered)' : A.STATUS[k].label]; }), st)) +
        fld('Client', inp('client', j.client)) + fld('Contact (email or profile)', inp('contact', j.contact)) +
        fld('Platform', sel('platform', PLATFORMS.map(function (p) { return [p, p]; }), j.platform)) +
        '<div class="fl-two">' + fld('Received', inp('received', j.received, 'date')) + fld('Due', inp('due', j.due, 'date')) + '</div>' +
        '<div class="fl-two">' + fld('Fee', inp('fee', j.fee || '', 'number', ' min="0" step="1"')) + fld('Currency', inp('currency', j.currency, 'text', ' maxlength="4"')) + '</div>' +
        fld('Paid so far', inp('paid', j.paid || '', 'number', ' min="0" step="1"')) +
        '<div class="field"><span class="fl">Revisions</span><div class="fl-rev"><button type="button" class="icon-btn" data-fl-rev="-1" aria-label="One fewer">−</button><b>' + ((j.revisions || {}).used || 0) + '</b><span class="muted">of</span>' +
          '<input class="in mono" data-fl-f="revisions.included" type="number" min="0" value="' + esc((j.revisions || {}).included || 0) + '" aria-label="Revisions included"><span class="muted">included</span><button type="button" class="icon-btn" data-fl-rev="1" aria-label="One more">+</button></div>' +
          ((j.revisions || {}).used > (j.revisions || {}).included ? '<span class="small fl-late">More revisions than the fee covers.</span>' : '') + '</div>' +
        (st === 'completed' ? fld('Delivered on', inp('delivered', j.delivered, 'date')) : '') +
      '</aside></div>';
  }
  var briefH = function () { try { return +localStorage.getItem('morfis:fl:briefH') || 0; } catch (e) { return 0; } };
  var COUNTS = {};
  /* the job's folder, browsed right here */
  var BR = null, brFor = '';
  function browser(j) {
    if (!BR || brFor !== j.id) {
      brFor = j.id;
      BR = window.MorfisBrowser ? window.MorfisBrowser.make({ dir: function () { var x = byId(brFor); return x && x.folderMade ? dirOf(x) : ''; }, label: function () { var x = byId(brFor); return x ? x.code : 'Folder'; }, onChange: function () { lastHtml = ''; draw(); } }) : null;
    }
    return BR;
  }
  function folderBox(j, dir) {
    if (!dir) return '<p class="muted small">Choose the projects folder in Settings first.</p>';
    var made = !!j.folderMade, b = made && browser(j);
    return '<div class="fx-path mono" title="' + esc(dir) + '">' + esc(dir) + '</div>' +
      (made ? (b ? b.html() : '<div class="toolbar"><button type="button" class="btn sm" data-fl-act="openDir">' + ic('ext', 14) + 'Open in File Explorer</button></div>') :
        '<p class="small muted">A folder for the job with five folders inside: ' + TEMPLATES.map(function (t) { return esc(t.name); }).join(', ') + '.</p><div class="toolbar"><button type="button" class="btn sm primary" data-fl-act="mkdir">Create the folder' + ic('plus', 14) + '</button></div>');
  }
  function countFiles(j, dir) {
    COUNTS[j.id] = {};
    TEMPLATES.reduce(function (c, t) {
      return c.then(function () { return H.listDir(dir, t.name).then(function (r) { COUNTS[j.id][t.id] = r.entries.filter(function (e) { return !e.dir; }).length; }, function () { COUNTS[j.id][t.id] = 0; }); });
    }, Promise.resolve()).then(function () { if (F.open === j.id) draw(); });
  }

  /* ----- drawing ----- */
  var EL = null, lastHtml = '', drawn = null;
  function draw() {
    if (!EL || M.current() !== 'freelance') return;
    if (!loaded) { EL.innerHTML = '<div class="fx-empty"><i class="spin"></i> Loading…</div>'; load().then(draw); return; }
    var j = F.open && byId(F.open);
    if (F.open && !j) F.open = null;
    var html = j ? jobView(j) : listView();
    if (html === lastHtml) return;
    /* keep what is being typed: redraw only when the focus is not in a field of this view */
    /* (only while staying on the same page: moving to another job or the list always draws) */
    var a = document.activeElement, place = F.open || '';
    if (place === drawn && a && EL.contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|number|search|email)$/.test(a.type)))) return;
    drawn = place;
    lastHtml = html; var y = EL.scrollTop; EL.innerHTML = html; EL.scrollTop = y;
    if (j && BR && brFor === j.id) BR.mount(EL);
    M.crumb();
  }
  function touch(j, redraw) { M.redrawSide(); j.updated = new Date().toISOString(); save(); if (redraw) { lastHtml = ''; draw(); } window.dispatchEvent(new CustomEvent('morfis:freelance', { detail: { id: j.id } })); }

  /* ----- actions ----- */
  function newJob(o) {
    var j = blankJob(o);
    JOBS.push(j); save(true);
    F.open = j.id; lastHtml = '';
    if (M.current() === 'freelance') draw(); else M.go('freelance', { id: j.id });
    setTimeout(function () { var t = EL && EL.querySelector('.fl-h1'); if (t && !j.title) t.focus(); }, 80);
    return j;
  }
  function makeFolder(j) {
    var dir = dirOf(j);
    if (!dir) { M.toast('Choose the projects folder in Settings first.'); return; }
    H.mkdirs([dir].concat(TEMPLATES.map(function (t) { return M.jn(dir, t.name); }))).then(function (r) {
      var bad = r.filter(function (x) { return !x.ok; });
      if (bad.length) { M.toast('Windows refused: ' + bad[0].error); return; }
      j.folder = dir; j.folderMade = true; delete COUNTS[j.id]; touch(j, true);
      M.toast('Folder created for ' + j.code + '.');
    });
  }
  function invoice(j) {
    if (!window.MorfisDocs) return;
    var d = window.MorfisDocs.blank('invoice', null);
    d.title = j.title; d.projectName = j.code + ' · ' + j.title; d.clientName = j.client; d.clientContact = j.contact; d.currency = j.currency || d.currency;
    d.items = [{ id: M.uid('l'), desc: j.title || 'Freelance job', detail: (j.deliverables || []).map(function (x) { return (x.qty > 1 ? x.qty + ' × ' : '') + (x.label || KINDS[x.kind]); }).join(', '), qty: 1, unit: 'lump sum', rate: Math.max(0, (+j.fee || 0) - (+j.paid || 0)) || +j.fee || 0 }];
    d.notes = j.platform && j.platform !== 'Direct client' ? 'Job through ' + j.platform + '.' : '';
    d.fl = j.id;
    window.MorfisDocs.save(d, true);
    window.MorfisDocs.open(d.id);
  }
  /* a studio project that is really a freelance job: it becomes one, keeping its folder */
  function fromProject(pid) {
    var p = pg().P(pid); if (!p) return;
    if (!window.confirm('Move ' + p.name + ' to Freelance? It leaves Projects, with its stages, tasks and milestone invoices, and becomes a freelance job that keeps its folder, client, fee and status.')) return;
    var st = A.statusOf(p, today());
    var j = newJob({ code: p.code, title: p.name, client: (p.client && p.client.name) || '', contact: (p.client && p.client.contact) || '', platform: 'Direct client',
      brief: [p.type, p.location, p.notes].filter(Boolean).join(' · '), received: p.startDate || today(), due: (p.stages && p.stages.length ? p.stages[p.stages.length - 1].end : '') || M.addDays(today(), 7),
      status: st, fee: +p.budget || 0, folder: pg().projDir(p), folderMade: !!(p.foldersCreated && !p.dirMissing), delivered: st === 'completed' ? today() : '', project: JSON.parse(JSON.stringify(p)) });
    delete pg().S.projects[pid];
    H.storeSet('p', pid, null).then(function () { pg().renderAll(); }, function () { M.toast('Could not remove the project record.'); });
    /* once the main folder is split, its folder goes to Freelance Projects and is sorted into the freelance folders */
    if (j.folderMade && pg().S.settings.mainRoot) {
      H.movePath(j.folder, M.jn(root(), folderName(j)), 'Move ' + j.code + ' to Freelance Projects').then(function (r) {
        j.folder = r.to; touch(j, true);
        return window.MorfisReorg ? window.MorfisReorg.sortInside(r.to, 'Sort ' + j.code) : null;
      }).then(function () { if (BR) BR.reload(); M.toast(p.name + ' is now a freelance job, in Freelance Projects.'); }, function (e) { M.toast('It is a freelance job, but its folder could not be moved: ' + ((e && e.message) || 'error')); });
    } else M.toast(p.name + ' is now a freelance job.');
    return j;
  }
  /* back the other way: a freelance job that turned into a full project */
  function toDirect(id) {
    var j = byId(id); if (!j) return;
    if (!window.confirm('Move ' + (j.title || j.code) + ' to Direct projects? It becomes a project with stages, tasks and milestone invoices' + (j.folderMade && pg().S.settings.mainRoot ? ', and its folder moves to Direct Projects' : '') + '. The files inside stay as they are.')) return;
    var S = pg().S, p;
    if (j.project && j.project.id && j.project.stages) p = JSON.parse(JSON.stringify(j.project));
    else {
      var codes = Object.values(S.projects).map(function (x) { return x.code; });
      p = pg().makeProject({ code: pg().nextProjectCode(codes, +today().slice(0, 4), S.settings.codeFormat), name: j.title || j.code, clientName: j.client, clientContact: j.contact,
        location: '', budget: +j.fee || 0, retainPct: S.settings.retainPct, startDate: j.received || today(), team: [] }, S.settings.team);
    }
    p.name = j.title || p.name; p.client = p.client || {}; p.client.name = j.client || p.client.name || ''; p.budget = +j.fee || p.budget || 0;
    if (S.projects[p.id]) p.id = M.uid('p');
    p.workStatus = statusOf(j);
    p.status = statusOf(j) === 'completed' || statusOf(j) === 'cancelled' ? 'closed' : 'active';
    var move = Promise.resolve();
    if (j.folderMade && j.folder) {
      if (S.settings.mainRoot) move = H.movePath(j.folder, M.jn(S.settings.root, pg().dirNameOf(p)), 'Move ' + p.code + ' to Direct Projects').then(function (r) { p.folderPath = r.to; });
      else p.folderPath = j.folder;
      move = move.then(function () { p.foldersCreated = p.foldersCreated || today(); p.dirMissing = false; return H.mkdirs(pg().FOLDER_TEMPLATES.map(function (t) { return M.jn(p.folderPath, t.name); }), 'Standard folders for ' + p.code); });
    } else { p.folderPath = ''; p.foldersCreated = ''; }
    return move.then(function () {
      S.projects[p.id] = p; pg().commit(p);
      JOBS = JOBS.filter(function (x) { return x !== j; }); F.open = null; save(true); lastHtml = ''; draw();
      M.toast((j.title || j.code) + ' is now a direct project.', { label: 'Open', fn: function () { if (window.MorfisDirect) window.MorfisDirect.open(p.id); else M.go('project', { id: p.id }); } });
      pg().rescanProject(p, { force: true, quiet: true }).then(function () { pg().renderAll(); });
      return p;
    }, function (e) { M.toast('Could not move the folder: ' + ((e && e.message) || 'error') + '. Nothing was changed.'); });
  }

  function bind(el) {
    if (el.dataset.flBound) return;
    el.dataset.flBound = '1';
    el.addEventListener('click', function (e) {
      if (M.current() !== 'freelance') return;
      var t = e.target, b, j = F.open && byId(F.open);
      if (j && BR && brFor === j.id && BR.handle(e)) return;
      if ((b = t.closest('[data-fl-open]'))) { F.open = b.dataset.flOpen; lastHtml = ''; draw(); EL.scrollTop = 0; M.crumb(); return; }
      if ((b = t.closest('[data-fl-filter]'))) { F.filter = b.dataset.flFilter; draw(); return; }
      if ((b = t.closest('[data-fl-add]')) && j) { j.deliverables = (j.deliverables || []).concat([{ id: M.uid('d'), kind: b.dataset.flAdd, label: KINDS[b.dataset.flAdd], qty: 1, done: false }]); touch(j, true); return; }
      if ((b = t.closest('[data-fl-d-x]')) && j) { var id = b.closest('[data-fl-del]').dataset.flDel; j.deliverables = j.deliverables.filter(function (x) { return x.id !== id; }); touch(j, true); return; }
      if ((b = t.closest('[data-fl-rev]')) && j) { j.revisions = j.revisions || { included: 0, used: 0 }; j.revisions.used = Math.max(0, (j.revisions.used || 0) + (+b.dataset.flRev)); touch(j, true); return; }
      if ((b = t.closest('[data-fl-dir]')) && j) { if (window.MorfisFiles && window.MorfisFiles.openJob) window.MorfisFiles.openJob(j.id, b.dataset.flDir); else H.openPath(M.jn(dirOf(j), b.dataset.flDir)).catch(function () { M.toast('That folder is not there.'); }); return; }
      if ((b = t.closest('[data-fl-reorg]'))) { if (window.MorfisReorg) window.MorfisReorg.open(); return; }
      if (!(b = t.closest('[data-fl-act]'))) return;
      var a = b.dataset.flAct;
      if (a === 'new') newJob();
      else if (a === 'back') { F.open = null; lastHtml = ''; draw(); M.crumb(); }
      else if (a === 'root') { var r = root(); if (!r) { M.toast('Choose the projects folder in Settings first.'); return; } H.mkdirs([r]).then(function () { return H.openPath(r); }).catch(function () { M.toast('Could not open the Freelance folder.'); }); }
      else if (a === 'mkdir' && j) makeFolder(j);
      else if (a === 'browse' && j) { if (window.MorfisFiles) window.MorfisFiles.openJob(j.id, ''); }
      else if (a === 'openDir' && j) H.openPath(dirOf(j)).catch(function () { M.toast('The folder is not there.'); });
      else if (a === 'recount' && j) { delete COUNTS[j.id]; lastHtml = ''; draw(); }
      else if (a === 'invoice' && j) invoice(j);
      else if (a === 'toDirect' && j) toDirect(j.id);
      else if (a === 'delete' && j) { if (!window.confirm('Delete the job ' + (j.title || j.code) + '? Its folder on the computer stays.')) return; JOBS = JOBS.filter(function (x) { return x !== j; }); F.open = null; save(true); lastHtml = ''; draw(); }
    });
    var field = function (e, final) {
      var t = e.target, j = F.open && byId(F.open); if (!j) return;
      if (t.dataset.flF) {
        var k = t.dataset.flF, v = t.type === 'number' ? (t.value === '' ? 0 : +t.value) : t.value;
        if (k === 'revisions.included') { j.revisions = j.revisions || { used: 0 }; j.revisions.included = Math.max(0, +v || 0); }
        else j[k] = v;
        if (k === 'status' && v === 'completed' && !j.delivered) j.delivered = today();
        touch(j, final && (t.tagName === 'SELECT' || k === 'due' || k === 'fee' || k === 'paid'));
        return;
      }
      var row = t.closest('[data-fl-del]'); if (!row || !t.dataset.flD) return;
      var x = j.deliverables.find(function (y) { return y.id === row.dataset.flDel; }); if (!x) return;
      var f = t.dataset.flD;
      x[f] = f === 'done' ? t.checked : f === 'qty' ? Math.max(1, +t.value || 1) : t.value;
      if (f === 'kind' && (!x.label || Object.keys(KINDS).some(function (k) { return KINDS[k] === x.label; }))) x.label = KINDS[t.value];
      touch(j, final && (f === 'done' || f === 'kind'));
    };
    el.addEventListener('input', function (e) { if (M.current() === 'freelance' && e.target.type !== 'checkbox' && e.target.tagName !== 'SELECT') field(e, false); });
    el.addEventListener('change', function (e) { if (M.current() === 'freelance') field(e, true); });
    /* leaving a text field applies it; but a dropdown being opened must not be redrawn under the pointer (its list
       would then belong to a select that is no longer on the page, and the choice would be lost) */
    el.addEventListener('focusout', function (e) {
      if (!/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      setTimeout(function () {
        var a = document.activeElement;
        if (document.querySelector('.dd-pop') || (a && a.closest && a.closest('.sel,.dd-btn,.dd-pop'))) return;
        if (!EL.contains(a) || !/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) { lastHtml = ''; draw(); }
      }, 0);
    });
    /* the brief keeps the height it is dragged to */
    el.addEventListener('mouseup', function (e) {
      var t = e.target; if (!t.matches || !t.matches('textarea[data-fl-f="brief"]')) return;
      var h = Math.round(t.offsetHeight); if (Math.abs(h - briefH()) < 2) return;
      try { localStorage.setItem('morfis:fl:briefH', String(h)); } catch (x) { /* ignore */ }
    });
    el.addEventListener('dblclick', function (e) { if (M.current() === 'freelance' && BR) BR.dbl(e); });
    el.addEventListener('keydown', function (e) {
      if (M.current() === 'freelance' && BR && BR.key2(e)) return; if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-fl-open]')) { e.preventDefault(); e.target.click(); } });
  }

  M.register('freelance', {
    title: 'Freelance', placeholder: 'Search freelance jobs',
    crumb: function () { var j = F.open && byId(F.open); return 'Freelance' + (j ? ' / ' + (j.title || j.code) : ''); },
    render: function (el, o) { EL = el; lastHtml = ''; bind(el); F.open = o && o.id ? o.id : null; draw(); },
    refresh: function () { draw(); },
    search: function (q) { F.q = q; draw(); }
  });

  /* ----- for the rest of the app: the sidebar count, File Explorer icons, deadline reminders ----- */
  window.MorfisFreelance = {
    all: function () { return JOBS; },
    open: function (id) { M.go('freelance', { id: id }); },
    newJob: newJob,
    fromProject: fromProject, toDirect: toDirect, invoice: function (id) { var j = byId(id); if (j) invoice(j); },
    /* rows for the Timeline: the dashboard's Active / Closed / All filter applies */
    timeline: function (filter) {
      return JOBS.filter(function (j) { return filter === 'all' || (filter === 'closed' ? !isOpen(j) : isOpen(j)); }).filter(function (j) { return j.received || j.due; }).map(function (j) {
        var d = done(j), st = statusOf(j), start = j.received || j.due, end = j.due && j.due >= start ? j.due : start;
        return { id: j.id, title: j.title || 'Untitled job', code: j.code, start: start, end: end, state: st === 'completed' || st === 'cancelled' ? 'done' : start > today() ? 'next' : 'cur', pct: d.of ? Math.round(d.n * 100 / d.of) : 0, done: d.n, of: d.of, label: dueText(j) || 'Freelance' };
      }).sort(function (a, b) { return a.start.localeCompare(b.start); });
    },
    get: byId, dirOf: dirOf, root: root, folderName: folderName, statusOf: statusOf, done: done, dueText: dueText, templates: TEMPLATES, platforms: PLATFORMS,
    makeFolder: function (j) { makeFolder(j); },
    /* a job record from another part of the app (the reorganisation): added without opening it */
    add: function (o) { var j = blankJob(o); JOBS.push(j); return j; },
    replaceAll: function (list) { JOBS = Array.isArray(list) ? list : []; save(true); lastHtml = ''; draw(); },
    save: function () { save(true); lastHtml = ''; draw(); },
    ready: function () { return loaded ? Promise.resolve(JOBS) : load(); },
    attention: function () { return JOBS.filter(function (j) { return isOpen(j) && j.due && j.due <= M.addDays(today(), 2); }).length; },
    reload: function () { return load().then(function () { lastHtml = ''; draw(); }); },
    /* the folders that get icons in File Explorer: the job's folder (status) and its five folders (number) */
    iconJobs: function () {
      var out = [];
      JOBS.forEach(function (j) {
        if (!j.folderMade) return;
        var dir = dirOf(j), d = done(j), st = statusOf(j);
        out.push({ dir: dir, v: A.variant({ status: st, count: d.of }), tip: A.STATUS[st].label + ' · ' + j.code + ' · ' + (dueText(j) || 'Freelance') });
        TEMPLATES.forEach(function (t) { out.push({ dir: M.jn(dir, t.name), v: A.variant({ num: t.id, count: (COUNTS[j.id] || {})[t.id] || 0 }), tip: t.label + ' · ' + j.code }); });
      });
      return out;
    }
  };
  /* Home and Projects show the dashboard's projects; the freelance jobs under way are shown there too */
  function overview() {
    var pgx = pg(); if (!pgx || !pgx.S.ready || !loaded) return;
    var v = pgx.S.ui.view, view = document.getElementById('view');
    if (!view || (v !== 'home' && v !== 'projects' && v !== undefined && v !== '' && v !== 'dashboard')) return;
    if (view.querySelector('.fl-over')) return;
    var open = JOBS.filter(isOpen).sort(function (a, b) { return String(a.due || '9').localeCompare(String(b.due || '9')); });
    if (!open.length) return;
    var html = '<section class="fl-over"><div class="sec-head"><h2>Freelance jobs under way</h2><span class="count">' + open.length + '</span><button type="button" class="btn sm" data-fl-over="all" style="margin-left:auto">All freelance jobs</button></div>' +
      '<div class="fl-grid" style="margin-top:16px">' + open.slice(0, 8).map(card).join('') + '</div></section>';
    var empty = view.querySelector(':scope > .empty');
    if (empty) { empty.insertAdjacentHTML('beforebegin', html); empty.classList.add('fl-empty-small'); return; }
    /* Projects: below the project cards; Home: after the cash flow and the week ahead */
    var after = v === 'projects' ? view.lastElementChild : (view.querySelector(':scope > .split') || view.querySelector(':scope > .hero'));
    if (after) after.insertAdjacentHTML('afterend', html); else view.insertAdjacentHTML('beforeend', html);
  }
  window.addEventListener('morfis:render', function () { setTimeout(overview, 0); });
  document.addEventListener('click', function (e) { var r = e.target.closest && e.target.closest('#view [data-fl-tl]'); if (r) M.go('freelance', { id: r.dataset.flTl }); });
  document.addEventListener('keydown', function (e) { var r = e.target.closest && e.target.closest('#view [data-fl-tl]'); if (r && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); M.go('freelance', { id: r.dataset.flTl }); } });
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('#view .fl-over [data-fl-open], #view [data-fl-over]');
    if (!b) return;
    if (b.dataset.flOpen) M.go('freelance', { id: b.dataset.flOpen }); else M.go('freelance');
  });

  /* New project: a direct project (stages, tasks, invoices) or a freelance job (brief, deliverables, fee) */
  var CHOOSING = false;
  function choose(kind) {
    if (kind === 'freelance') { newJob(); return; }
    if (kind === 'direct') { CHOOSING = true; try { pg().newProject(); } finally { CHOOSING = false; } return; }
    M.modal('New project',
      '<div class="np-pick">' +
      '<button type="button" class="np-opt" data-np-kind="direct">' + ic('layers', 22) + '<b>Direct project</b><span class="muted small">The studio’s own project: seven stages, the task checklist, milestone invoices and the six folders, in Direct Projects.</span></button>' +
      '<button type="button" class="np-opt" data-np-kind="freelance">' + ic('briefcase', 22) + '<b>Freelance job</b><span class="muted small">An online job from a client’s brief: deliverables (3D, drawings, renders), deadline, fee and revisions, in Freelance Projects.</span></button>' +
      '</div>');
    document.querySelectorAll('#overlay [data-np-kind]').forEach(function (b) { b.addEventListener('click', function () { var k = b.dataset.npKind; pg().closeModal(); setTimeout(function () { choose(k); }, 30); }); });
  }
  M.newProject = choose;
  document.addEventListener('click', function (e) {
    if (CHOOSING) return;
    var b = e.target.closest && e.target.closest('[data-act="newProject"]');
    if (!b || window.MORFIS_REMOTE && !pg()) return;
    e.stopImmediatePropagation(); e.preventDefault();
    choose();
  }, true);

  /* records changed on the phone (or, on the phone, on the computer) */
  if (H.onStore) H.onStore(function (ev) { if (ev && ev.t === 'kv' && ev.key === KEY) window.MorfisFreelance.reload(); });
  load();
})();
