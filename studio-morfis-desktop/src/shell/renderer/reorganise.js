/* Reorganise: split the main projects folder into Direct Projects and Freelance Projects, once.
   Direct projects (every status but Completed) move to <main>/Direct Projects under the app's folder naming, and new
   projects are made there from then on. Completed projects were freelance work: each becomes a freelance job (its
   project record kept inside the job), its folder moves to <main>/Freelance Projects as "FL I 26 I 046 I Title", and
   what is inside is sorted into the freelance folders (brief, 3D models, drawings, renders, delivered). Freelance jobs
   made before move there too. Every move goes through the journal, and the app records are kept, so Undo puts the
   folders, the projects, the jobs and the settings back as they were. */
(function () {
  'use strict';
  var M = window.Morfis, A = window.MorfisArt;
  if (!M || !A) return;
  var H = M.H, esc = M.esc, pg = M.page;
  var KEY = 'reorg:last', LOG = null;
  var FL = function () { return window.MorfisFreelance; };
  var DIRECT = 'Direct Projects', FREE = 'Freelance Projects';
  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  /* a project record without its file lists (reading the folder again fills them), to keep the saved copies small */
  var lite = function (p) { var c = clone(p); Object.keys(c.folders || {}).forEach(function (k) { if (c.folders[k]) c.folders[k].files = []; }); c.loose = []; return c; };
  var base = function (p) { return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop(); };
  var same = function (a, b) { return String(a || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase() === String(b || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase(); };
  var onDisk = function (p) { return !!(p.foldersCreated && !p.dirMissing); };

  H.kvGet(KEY).then(function (v) { LOG = v && typeof v === 'object' ? v : null; redraw(); }, function () {});
  function redraw() { if (window.MorfisFiles && window.MorfisFiles.redraw) window.MorfisFiles.redraw(); if (FL() && FL().reload) FL().reload(); }

  /* ----- what goes where ----- */
  /* "MRF - 26 - 046 - Remodel" or "MRF I 26 I 046 I Remodel" → "Remodel" */
  function titleOf(p) {
    var t = String(p.name || '').replace(/^\s*[A-Za-z]{1,5}\s*[-_I|.]\s*\d{2}\s*[-_I|.]\s*\d{1,4}\s*(?:[-_I|.:]\s*)?/, '').trim();
    return t || p.name || p.code;
  }
  function flCode(code) { return /^[A-Za-z]+(\s*I\s*\d{2}\s*I\s*\d+)/.test(code || '') ? String(code).replace(/^[A-Za-z]+/, 'FL') : code; }
  function plan(o) {
    var S = pg().S, today = pg().today(), main = S.settings.root || '';
    var direct = [], free = [], jobs = (FL() ? FL().all() : []).filter(function (j) { return j.folderMade && j.folder; });
    var L = window.MorfisLog, skipped = [];
    Object.values(S.projects).forEach(function (p) {
      /* a folder not named like a project (a library, documentation) is never moved or sorted */
      if (L && onDisk(p) && !L.looksLikeProject(p)) { skipped.push(p); return; }
      if (A.statusOf(p, today) === 'completed') free.push(p); else direct.push(p);
    });
    direct.sort(function (a, b) { return String(a.code).localeCompare(String(b.code), undefined, { numeric: true }); });
    free.sort(function (a, b) { return String(a.code).localeCompare(String(b.code), undefined, { numeric: true }); });
    return {
      skipped: skipped, main: main, directRoot: M.jn(main, DIRECT), freeRoot: M.jn(main, FREE), direct: direct, free: free, jobs: jobs,
      directMoves: direct.filter(onDisk).map(function (p) { return { p: p, from: pg().projDir(p), to: M.jn(M.jn(main, DIRECT), pg().dirNameOf(p)) }; }),
      freeNames: free.map(function (p) { var code = o && o.keepCodes ? p.code : flCode(p.code); return { p: p, code: code, title: titleOf(p), from: onDisk(p) ? pg().projDir(p) : '' }; })
    };
  }

  /* ----- sorting what is inside a job folder into the five freelance folders ----- */
  var EXT = {
    '02': /\.(max|3ds|skp|fbx|obj|blend|c4d|rvt|rfa|dae|stl|gltf|glb|ma|mb|3dm|ifc|usdz?|lwo|abc|vrmesh|vrscene|lmp|ls\d*|d5a)$/i,
    '03': /\.(dwg|dxf|dwf|dgn|pln|plt|ctb|bak_dwg)$/i,
    '04': /\.(jpe?g|png|tiff?|exr|hdr|psd|bmp|webp|tga|gif|heic|mp4|mov|avi|mkv)$/i
  };
  var NAME = [
    ['05', /deliver|final|output|export|submission|submitted|handover|for[ _-]?client|to[ _-]?client/i],
    ['04', /render|visual|image|img|\bviews?\b|photoreal|perspective|animation|walk[ _-]?through|\bjpe?g\b|\bpng\b/i],
    ['02', /3d|model|\bmax\b|skp|sketch[ _-]?up|scene|texture|material|\bmaps?\b|revit|\brvt\b|blend|lumion|enscape|vray|v-ray|corona|\bd5\b|twinmotion/i],
    ['03', /draw|dwg|\bcad\b|plan|elevation|section|detail|layout|schematic|boq|schedule|autocad|\bpdf\b/i],
    ['01', /brief|ref|requirement|inspiration|site|survey|photo|minute|contract|financ|invoice|quot|\bdocs?\b|mail|info|client/i]
  ];
  function fileCat(name) {
    if (EXT['02'].test(name)) return '02';
    if (EXT['03'].test(name)) return '03';
    if (EXT['04'].test(name)) return /deliver|final/i.test(name) ? '05' : '04';
    if (/\.pdf$/i.test(name)) return /brief|ref|requirement|quot|invoice|contract/i.test(name) ? '01' : '03';
    if (/\.(zip|rar|7z)$/i.test(name) && /deliver|final/i.test(name)) return '05';
    return '01';
  }
  function dirCat(name, entries) {
    var plain = name.replace(/^\d\d[_ .\-]+/, '');
    for (var i = 0; i < NAME.length; i++) if (NAME[i][1].test(plain)) return NAME[i][0];
    var votes = {};
    (entries || []).forEach(function (e) { if (!e.dir) { var c = fileCat(e.name); votes[c] = (votes[c] || 0) + 1; } });
    var best = '01', n = 0;
    Object.keys(votes).forEach(function (c) { if (votes[c] > n && c !== '01') { best = c; n = votes[c]; } });
    return n ? best : '01';
  }
  function sortInside(dir, label) {
    var T = FL().templates, names = T.map(function (t) { return t.name.toLowerCase(); }), to = {};
    T.forEach(function (t) { to[t.id] = t.name; });
    return H.mkdirs(T.map(function (t) { return M.jn(dir, t.name); })).then(function () { return H.listDir(dir, ''); }).then(function (r) {
      var ops = [], empty = [];
      return r.entries.reduce(function (c, e) {
        return c.then(function () {
          if (names.indexOf(e.name.toLowerCase()) !== -1) return;
          if (!e.dir) { ops.push({ from: e.name, to: to[fileCat(e.name)] + '/' + e.name }); return; }
          return H.listDir(dir, e.name).then(function (inner) {
            var cat = dirCat(e.name, inner.entries), num = (/^(\d\d)[_ .\-]/.exec(e.name) || [])[1];
            /* a standard 01, 02 or 03 folder pours into its freelance twin; anything else goes in whole, without its number */
            if (num && num === cat && /^0[123]$/.test(num)) { if (!inner.entries.length) empty.push(e.name); inner.entries.forEach(function (x) { ops.push({ from: e.name + '/' + x.name, to: to[cat] + '/' + x.name }); }); }
            else ops.push({ from: e.name, to: to[cat] + '/' + (e.name.replace(/^\d\d[_ .\-]+/, '') || e.name) });
          }, function () { ops.push({ from: e.name, to: to['01'] + '/' + e.name }); });
        });
      }, Promise.resolve()).then(function () {
        /* an empty standard folder has nothing to pour in: it just goes */
        var gone = empty.length ? H.trashItems(dir, empty).catch(function () {}) : Promise.resolve();
        return gone.then(function () { return ops.length ? H.applyOps(dir, ops, 'move', label) : { id: '', moved: 0, failed: [] }; });
      });
    });
  }

  /* ----- the dialog ----- */
  function open() {
    if (window.MORFIS_REMOTE) { M.toast('Reorganise the folders on the computer.'); return; }
    var S = pg().S;
    if (!S.settings.root) { M.toast('Choose the projects folder in Settings first.'); return; }
    FL().ready().then(function () {
      var P = plan({}), sample = P.freeNames.slice(0, 6);
      var row = function (a, b) { return '<div class="ro-row"><span class="mono" title="' + esc(a) + '">' + esc(a) + '</span><span class="ro-arrow">→</span><span class="mono" title="' + esc(b) + '">' + esc(b) + '</span></div>'; };
      M.modal('Reorganise the projects folder',
        '<div class="ro">' +
        '<p class="muted">Inside <span class="mono">' + esc(P.main) + '</span> two folders are made, and every project folder moves into one of them:</p>' +
        '<div class="ro-cols"><div class="ro-col"><b>' + DIRECT + '</b><span class="muted small">' + P.direct.length + ' project' + (P.direct.length === 1 ? '' : 's') + ' that are not completed, ' + P.directMoves.length + ' with a folder. Folder names follow the project naming. New projects are made here.</span></div>' +
        '<div class="ro-col"><b>' + FREE + '</b><span class="muted small">' + P.free.length + ' completed project' + (P.free.length === 1 ? '' : 's') + ' become freelance jobs' + (P.jobs.length ? ', and ' + P.jobs.length + ' freelance job folder' + (P.jobs.length === 1 ? '' : 's') + ' move here' : '') + '. Inside, files go into ' + FL().templates.map(function (t) { return t.name; }).join(', ') + '.</span></div></div>' +
        (sample.length ? '<div class="ro-sample"><span class="lbl-up">Freelance names</span>' + sample.map(function (x) { return row(x.from ? base(x.from) : x.p.name, x.code + ' I ' + x.title); }).join('') + (P.freeNames.length > sample.length ? '<span class="muted small">and ' + (P.freeNames.length - sample.length) + ' more</span>' : '') + '</div>' : '') +
        (P.skipped.length ? '<p class="small">Left where they are, because they are not named like projects: <b>' + esc(P.skipped.map(function (p) { return base(pg().projDir(p)); }).join(', ')) + '</b>. If they are not projects, use <b>Folders that are not projects</b> in Files first.</p>' : '') +
        '<label class="check-row"><input type="checkbox" id="roFl" checked><span>Give the converted jobs freelance codes (<span class="mono">MRF I 26 I 046</span> becomes <span class="mono">FL I 26 I 046</span>)</span></label>' +
        '<label class="check-row"><input type="checkbox" id="roSort" checked><span>Sort what is inside each freelance folder into the five freelance folders</span></label>' +
        '<p class="muted small">Moving within the same drive is quick. Every move is recorded: <b>Undo the reorganisation</b> in Files puts it all back.</p>' +
        '<div class="ro-prog" id="roProg" hidden><i class="spin"></i><span id="roProgT">Starting…</span></div>' +
        '<p class="err" id="roErr"></p></div>' +
        '<div class="dlg-foot"><button type="button" class="btn" id="roNo">Cancel</button><button type="button" class="btn primary" id="roGo">Reorganise</button></div>', { wide: true });
      document.getElementById('roNo').addEventListener('click', function () { pg().closeModal(); });
      document.getElementById('roGo').addEventListener('click', function () {
        var go = this; go.disabled = true; document.getElementById('roNo').disabled = true;
        document.getElementById('roProg').hidden = false;
        run({ keepCodes: !document.getElementById('roFl').checked, sort: document.getElementById('roSort').checked }, function (t) { var e = document.getElementById('roProgT'); if (e) e.textContent = t; })
          .then(function (r) {
            pg().closeModal();
            M.toast('Reorganised: ' + r.direct + ' direct, ' + r.free + ' freelance.' + (r.failed.length ? ' ' + r.failed.length + ' could not be moved.' : ''), { label: 'Undo', fn: undo });
            if (r.failed.length) setTimeout(function () { window.alert('These could not be moved and stay where they were:\n\n' + r.failed.slice(0, 20).join('\n')); }, 300);
          }, function (e) { var x = document.getElementById('roErr'); if (x) x.textContent = (e && e.message) || 'Something went wrong.'; go.disabled = false; document.getElementById('roNo').disabled = false; });
      });
    });
  }

  /* ----- doing it ----- */
  function run(o, say) {
    var S = pg().S, P = plan(o), log = { at: new Date().toISOString(), main: P.main, root: S.settings.root, journals: [], projects: {}, jobsBefore: clone(FL().all()), undone: false };
    var failed = [], step = 0, total = P.directMoves.length + P.free.length + P.jobs.length;
    var note = function (t) { step++; say(step + ' of ' + total + ': ' + t); };
    var keepJournal = function (id) { if (id) log.journals.push(id); };
    var saveLog = function () { return H.kvSet(KEY, log).catch(function () {}); };
    return H.mkdirs([P.directRoot, P.freeRoot]).then(function (r) {
      var bad = r.filter(function (x) { return !x.ok; });
      if (bad.length) throw new Error('Windows refused to make ' + base(bad[0].path) + ': ' + bad[0].error);
      return saveLog();
    }).then(function () {
      /* direct projects */
      return P.directMoves.reduce(function (c, m) {
        return c.then(function () {
          note(m.p.name);
          log.projects[m.p.id] = lite(m.p);
          if (same(m.from, m.to)) return;
          return H.movePath(m.from, m.to, 'Reorganise ' + m.p.code).then(function (r) { keepJournal(r.id); m.p.folderPath = r.to; pg().queueWrite('p', m.p.id, m.p); },
            function (e) { delete log.projects[m.p.id]; failed.push(base(m.from) + ' (' + ((e && e.message) || 'error') + ')'); });
        });
      }, Promise.resolve());
    }).then(saveLog).then(function () {
      /* completed projects become freelance jobs */
      return P.freeNames.reduce(function (c, x) {
        return c.then(function () {
          var p = x.p, st = A.statusOf(p, pg().today());
          note(p.name);
          log.projects[p.id] = lite(p);
          var end = (p.stages && p.stages.length && p.stages[p.stages.length - 1].end) || '';
          var j = FL().add({ code: x.code, title: x.title, client: (p.client && p.client.name) || '', contact: (p.client && (p.client.email || p.client.contact)) || '', platform: 'Other',
            brief: [p.type, p.location, p.notes].filter(Boolean).join(' · '), received: p.startDate || pg().today(), due: end || pg().today(), status: st,
            fee: +p.budget || 0, paid: 0, delivered: end || pg().today(), deliverables: [], folder: '', folderMade: false, project: lite(p), fromReorg: log.at });
          var moved = !x.from ? Promise.resolve() : H.movePath(x.from, M.jn(P.freeRoot, FL().folderName(j)), 'Reorganise ' + p.code).then(function (r) {
            keepJournal(r.id); j.folder = r.to; j.folderMade = true;
            if (o.sort) return sortInside(r.to, 'Sort ' + j.code).then(function (s) { keepJournal(s.id); (s.failed || []).forEach(function (f) { failed.push(j.code + ': ' + f.from); }); });
          }, function (e) { failed.push(base(x.from) + ' (' + ((e && e.message) || 'error') + ')'); j.folder = x.from; j.folderMade = true; });
          return moved.then(function () { delete S.projects[p.id]; pg().queueWrite('p', p.id, null); });
        });
      }, Promise.resolve());
    }).then(function () { FL().save(); return saveLog(); }).then(function () {
      /* freelance jobs made before */
      return P.jobs.reduce(function (c, j) {
        return c.then(function () {
          note(j.title || j.code);
          var to = M.jn(P.freeRoot, FL().folderName(j));
          if (same(j.folder, to)) return o.sort ? sortInside(j.folder, 'Sort ' + j.code).then(function (s) { keepJournal(s.id); }) : null;
          return H.movePath(j.folder, to, 'Reorganise ' + j.code).then(function (r) {
            keepJournal(r.id); j.folder = r.to;
            if (o.sort) return sortInside(r.to, 'Sort ' + j.code).then(function (s) { keepJournal(s.id); });
          }, function (e) { failed.push(base(j.folder) + ' (' + ((e && e.message) || 'error') + ')'); });
        });
      }, Promise.resolve());
    }).then(function () {
      /* the Freelance folder of version 1.8, once its jobs have moved out */
      return H.removeIfEmpty([M.jn(P.main, 'Freelance')], 'Remove the empty Freelance folder').catch(function () {});
    }).then(function () {
      S.settings.mainRoot = P.main;
      S.settings.root = P.directRoot;
      pg().commitSettings(true);
      FL().save();
      LOG = log;
      return saveLog();
    }).then(function () {
      say('Reading the folders again…');
      pg().renderAll();
      return Object.values(S.projects).filter(onDisk).reduce(function (c, p) { return c.then(function () { return pg().rescanProject(p, { force: true, quiet: true }); }); }, Promise.resolve());
    }).then(function () {
      if (window.MorfisAuto && window.MorfisAuto.refreshIcons) window.MorfisAuto.refreshIcons().catch(function () {});
      redraw();
      return { direct: P.direct.length, free: P.free.length + P.jobs.length, failed: failed };
    });
  }

  function undo() {
    if (!LOG || LOG.undone) { M.toast('There is no reorganisation to undo.'); return Promise.resolve(); }
    if (!window.confirm('Undo the reorganisation of ' + M.fdate(LOG.at.slice(0, 10)) + '? Folders move back where they were, completed projects come back to Projects, and freelance jobs go back to how they were then. Changes made to those jobs since are lost.')) return Promise.resolve();
    var S = pg().S, log = LOG, failed = 0;
    M.toast('Putting the folders back…');
    return log.journals.slice().reverse().reduce(function (c, id) {
      return c.then(function () { return H.undo(id).then(function (r) { failed += (r.failed || []).length; }, function () { failed++; }); });
    }, Promise.resolve()).then(function () {
      S.settings.root = log.root;
      delete S.settings.mainRoot;
      pg().commitSettings(true);
      Object.keys(log.projects).forEach(function (pid) { S.projects[pid] = log.projects[pid]; pg().queueWrite('p', pid, log.projects[pid]); });
      FL().replaceAll(log.jobsBefore || []);
      log.undone = true; LOG = log;
      return H.kvSet(KEY, log).catch(function () {});
    }).then(function () {
      pg().renderAll();
      return Object.values(S.projects).filter(onDisk).reduce(function (c, p) { return c.then(function () { return pg().rescanProject(p, { force: true, quiet: true }); }); }, Promise.resolve());
    }).then(function () {
      if (window.MorfisAuto && window.MorfisAuto.refreshIcons) window.MorfisAuto.refreshIcons().catch(function () {});
      redraw();
      M.toast(failed ? 'Put back, but ' + failed + ' item' + (failed === 1 ? '' : 's') + ' could not be moved.' : 'The folders are back as they were.');
    });
  }

  window.MorfisReorg = {
    needed: function () { var s = pg() && pg().S.settings; return !window.MORFIS_REMOTE && !!(s && s.root && !s.mainRoot) && !!FL(); },
    canUndo: function () { return !window.MORFIS_REMOTE && !!(LOG && !LOG.undone && LOG.at && Date.now() - new Date(LOG.at).getTime() < 60 * 864e5); },
    open: open, undo: undo, plan: plan, run: run, sortInside: sortInside, fileCat: fileCat, dirCat: dirCat, titleOf: titleOf
  };
})();
