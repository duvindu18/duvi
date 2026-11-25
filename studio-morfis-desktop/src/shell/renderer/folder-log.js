/* The folder change log, and folders that are not projects.
   Every change the app makes to real folders (folders made, files copied, sorted, moved or renamed, items recycled)
   is written to the journal first. The Change log lists them, newest first, each with Undo.
   A main folder often holds folders that are not projects (a library, documentation, games). If one came in through
   Import folders, the app gave it the standard folders, sorted its loose files into them and drew its icons. "Not a
   project" takes all of that back: the app's icons come off (the folder's own icon returns), every logged change
   inside it is undone newest first (files go back where they were, a rename is reversed), the empty standard folders
   go, and the project record is removed. The folder is remembered, so Import and Reorganise leave it alone. */
(function () {
  'use strict';
  var M = window.Morfis;
  if (!M) return;
  var H = M.H, esc = M.esc, ic = M.ic, pg = M.page;
  var PHONE = !!window.MORFIS_REMOTE;
  var STD_NAMES = ['01_Brief_and_Site_Data', '02_Schematics_and_3D', '03_Working_Drawings', '04_Schedules_BOQ', '05_Financials_and_Contracts', '06_Site_Photos_and_Minutes',
    '01_Brief_and_References', '02_3D_Models', '03_Drawings', '04_Renders', '05_Delivered'];
  var norm = function (p) { return String(p || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase(); };
  var base = function (p) { return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop(); };
  var onDisk = function (p) { return !!(p.foldersCreated && !p.dirMissing); };
  var when = function (ms) { var d = new Date(ms); return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); };

  /* ----- which folders are not projects ----- */
  function notList() { var s = pg() && pg().S.settings; return (s && Array.isArray(s.notProjects)) ? s.notProjects : []; }
  function isNot(dir) { var n = norm(dir); return notList().some(function (x) { return norm(x) === n; }); }
  /* project folders are named after a code: "MRF I 26 I 014 …", "MRF - 26 - 014 …"; anything else may not be a project */
  var CODE = /^[A-Za-z]{2,5}\s*[I|\-_.]\s*\d{2}\s*[I|\-_.]\s*\d{1,4}\b/;
  function looksLikeProject(p) { return CODE.test(base(pg().projDir(p))) || CODE.test(String(p.name || '')); }
  function suspects() { return Object.values(pg().S.projects).filter(function (p) { return onDisk(p) && !looksLikeProject(p); }); }

  /* Import folders never offers a folder marked as not a project */
  if (H.scanRoot && !H.scanRootPlain) {
    var scanRoot = H.scanRoot;
    H.scanRootPlain = scanRoot;
    H.scanRoot = function (root) { return scanRoot(root).then(function (r) { if (r && Array.isArray(r.rows)) r.rows = r.rows.filter(function (x) { return !isNot(x.path); }); return r; }); };
  }

  /* ----- undoing the app's changes in one folder ----- */
  function revert(p) {
    var dir = pg().projDir(p), now = dir, out = { name: p.name, undone: 0, failed: [], removed: 0, icons: 0 };
    return H.folderIconClearTree(dir, 4).then(function (r) { out.icons = (r && r.cleared) || 0; }, function () {})
      .then(function () { return H.journalList({ under: dir, limit: 1000 }); })
      .then(function (list) {
        list = (list || []).filter(function (j) { return !j.undone; });
        return list.reduce(function (c, j) {
          return c.then(function () {
            return H.undo(j.id).then(function (r) {
              out.undone++;
              (r.failed || []).forEach(function (f) { out.failed.push(base(f.path) + ': ' + f.error); });
              /* the folder itself renamed back (Import names folders after their code) */
              (j.sample || []).forEach(function (x) { if (x.kind === 'move' && norm(x.to) === norm(now) && x.from) now = x.from; });
            }, function (e) { out.failed.push(j.label + ': ' + ((e && e.message) || 'could not be undone')); });
          });
        }, Promise.resolve());
      })
      .then(function () {
        var names = STD_NAMES.concat((window.FOLDER_TEMPLATES || []).map(function (t) { return t.name; }));
        return H.removeIfEmpty(names.filter(function (n, i) { return names.indexOf(n) === i; }).map(function (n) { return M.jn(now, n); }), 'Remove the standard folders from ' + base(now));
      })
      .then(function (r) { out.removed = r.removed; out.kept = r.kept; })
      .then(function () {
        var S = pg().S;
        S.settings.notProjects = notList().filter(function (x) { return norm(x) !== norm(now) && norm(x) !== norm(dir); }).concat([now]);
        delete S.projects[p.id]; pg().queueWrite('p', p.id, null);
        if (H.folderIconRefresh) H.folderIconRefresh([now]).catch(function () {});
        return out;
      });
  }

  function notProjects(preselect) {
    if (PHONE) { M.toast('Do this on the computer.'); return; }
    var all = Object.values(pg().S.projects).filter(onDisk).sort(function (a, b) { return looksLikeProject(a) - looksLikeProject(b) || base(pg().projDir(a)).localeCompare(base(pg().projDir(b))); });
    var pick = function (p) { return preselect ? preselect === p.id : !looksLikeProject(p); };
    M.modal('Folders that are not projects',
      '<p class="muted">Tick the folders that are not projects. For each one the app takes back what it did: its folder icons come off (the folder’s own icon returns), every logged change inside it is undone (files go back where they were, a rename is reversed), the empty standard folders it made are removed, and it leaves Projects. Nothing of yours is deleted. Import and Reorganise leave it alone afterwards.</p>' +
      '<div class="np-list">' + all.map(function (p) {
        var d = pg().projDir(p);
        return '<label class="check-row np-row"><input type="checkbox" data-np="' + esc(p.id) + '"' + (pick(p) ? ' checked' : '') + '><span><b>' + esc(base(d)) + '</b>' + (looksLikeProject(p) ? '' : '<em class="np-tag">not named like a project</em>') + '<br><span class="small muted mono">' + esc(d) + '</span></span></label>';
      }).join('') + '</div>' +
      '<div class="ro-prog" id="npProg" hidden><i class="spin"></i><span id="npProgT"></span></div><p class="err" id="npErr"></p>' +
      '<div class="dlg-foot"><button type="button" class="btn" id="npNo">Cancel</button><button type="button" class="btn primary" id="npGo">Put these folders back</button></div>', { wide: true });
    document.getElementById('npNo').addEventListener('click', function () { pg().closeModal(); });
    document.getElementById('npGo').addEventListener('click', function () {
      var ids = Array.from(document.querySelectorAll('#overlay [data-np]:checked')).map(function (x) { return x.dataset.np; });
      if (!ids.length) { document.getElementById('npErr').textContent = 'Tick at least one folder.'; return; }
      this.disabled = true; document.getElementById('npNo').disabled = true; document.getElementById('npProg').hidden = false;
      var results = [];
      ids.reduce(function (c, id, i) {
        return c.then(function () { var p = pg().P(id); if (!p) return; document.getElementById('npProgT').textContent = (i + 1) + ' of ' + ids.length + ': ' + p.name; return revert(p).then(function (r) { results.push(r); }); });
      }, Promise.resolve()).then(function () {
        pg().commitSettings(true);
        pg().closeModal(); pg().renderAll();
        if (window.MorfisFiles) window.MorfisFiles.redraw();
        var failed = [].concat.apply([], results.map(function (r) { return r.failed.map(function (f) { return r.name + ': ' + f; }); }));
        M.toast(results.length + ' folder' + (results.length === 1 ? ' is' : 's are') + ' no longer projects. ' + results.reduce(function (a, r) { return a + r.undone; }, 0) + ' logged changes undone.');
        if (failed.length) setTimeout(function () { window.alert('Some things could not be put back:\n\n' + failed.slice(0, 25).join('\n')); }, 300);
      });
    });
  }

  /* ----- the change log ----- */
  var KIND = { move: 'moved', copy: 'copied', mkdir: 'folder made', rmdir: 'folder removed', trash: 'to the Recycle Bin' };
  function openLog(under) {
    if (PHONE) { M.toast('The change log is on the computer.'); return; }
    H.journalList({ under: under || '', limit: 300 }).then(function (list) {
      var row = function (j) {
        return '<div class="lg-row' + (j.undone ? ' undone' : '') + '"><div class="lg-main"><b>' + esc(j.label || 'Change') + '</b><span class="small muted">' + esc(when(j.at)) + ' · ' + j.n + ' item' + (j.n === 1 ? '' : 's') + ' · ' + j.kinds.map(function (k) { return KIND[k] || k; }).join(', ') + (j.undone ? ' · undone' : '') + '</span>' +
          '<div class="lg-paths">' + j.sample.slice(0, 3).map(function (x) { return '<span class="mono small" title="' + esc((x.from ? x.from : '') + (x.to ? ' → ' + x.to : '')) + '">' + esc(x.from && x.to ? base(x.from) + ' → ' + x.to : (x.to || x.from)) + '</span>'; }).join('') + (j.n > 3 ? '<span class="small muted">and ' + (j.n - 3) + ' more</span>' : '') + '</div></div>' +
          (j.undone || j.kinds.every(function (k) { return k === 'trash'; }) ? '' : '<button type="button" class="btn sm" data-lg-undo="' + esc(j.id) + '">Undo</button>') + '</div>';
      };
      M.modal('Change log',
        '<p class="muted small">Every change the app made to your folders in the last 90 days' + (under ? ' inside <span class="mono">' + esc(under) + '</span>' : '') + ', newest first. Undo puts that change back; a folder the app made is removed only while it is empty.</p>' +
        '<div class="lg-list">' + (list.length ? list.map(row).join('') : '<div class="fx-empty">No changes logged yet.</div>') + '</div>' +
        '<div class="dlg-foot">' + (suspects().length ? '<button type="button" class="btn" id="lgNot">Folders that are not projects…</button>' : '') + '<button type="button" class="btn primary" data-act="close">Close</button></div>', { wide: true });
      var box = document.querySelector('#overlay .lg-list');
      if (box) box.addEventListener('click', function (e) {
        var b = e.target.closest('[data-lg-undo]'); if (!b) return;
        b.disabled = true;
        H.undo(b.dataset.lgUndo).then(function (r) {
          M.toast(r.already ? 'That was already undone.' : 'Put back ' + r.restored + ' item' + (r.restored === 1 ? '' : 's') + '.' + (r.failed.length ? ' ' + r.failed.length + ' could not be: ' + r.failed[0].error : ''));
          var rw = b.closest('.lg-row'); if (rw) rw.classList.add('undone'); b.remove();
          if (window.MorfisFiles) window.MorfisFiles.redraw();
          Object.values(pg().S.projects).filter(onDisk).forEach(function (p) { pg().rescanProject(p, { quiet: true }); });
        }, function (e) { b.disabled = false; M.toast((e && e.message) || 'Could not undo it.'); });
      });
      var np = document.getElementById('lgNot'); if (np) np.addEventListener('click', function () { notProjects(); });
    });
  }

  window.MorfisLog = { open: openLog, notProjects: notProjects, suspects: suspects, looksLikeProject: looksLikeProject, isNot: isNot, revert: revert };
})();
