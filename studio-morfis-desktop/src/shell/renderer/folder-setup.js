/* Project folder setup: which folders every project root gets, what they are called, and in what order.
   The six standard folders (01 to 06) are the ones automatic sorting knows; each can be switched off or renamed, and
   studios can add their own. Kept in the studio settings (so it travels with backups) and applied to the dashboard's
   own folder list, so creating, scanning, sorting and the folder icons all follow it. */
(function () {
  'use strict';
  var M = window.Morfis;
  if (!M) return;
  var H = M.H, esc = M.esc, ic = M.ic, pg = M.page;
  var STD = null;   /* the dashboard's original six, kept for their colours, roles and sorting meaning */

  function std() {
    if (!STD && window.FOLDER_TEMPLATES) STD = JSON.parse(JSON.stringify(window.FOLDER_TEMPLATES));
    return STD || [];
  }
  var isStd = function (id) { return std().some(function (t) { return t.id === id; }); };
  /* the full list, switched-off folders included */
  function current() {
    var s = pg() && pg().S.settings, set = s && Array.isArray(s.folderSet) && s.folderSet.length ? s.folderSet : null;
    return set ? set.map(function (x) { return Object.assign({}, x); }) : std().map(function (t) { return { id: t.id, name: t.name, label: t.label, on: true }; });
  }
  /* rebuild the dashboard's folder list in place, so every part of it sees the same array */
  var applied = '';
  function apply() {
    var T = window.FOLDER_TEMPLATES, base = std();
    if (!T || !base.length || !pg() || !pg().S.ready) return;
    var set = current(), sig = JSON.stringify(set);
    if (sig === applied) return;
    applied = sig;
    var next = set.filter(function (x) { return x.on; }).map(function (x) {
      var s0 = base.find(function (t) { return t.id === x.id; });
      return Object.assign({ tone: 'blue', roles: [] }, s0 || {}, { id: x.id, name: x.name, label: x.label });
    });
    T.length = 0;
    next.forEach(function (t) { T.push(t); });
  }
  window.addEventListener('morfis:render', apply);

  /* scanning reads the folders in use, not a fixed six */
  if (H.scanProject && !H.scanProjectFixed) {
    var scan = H.scanProject;
    H.scanProjectFixed = scan;
    H.scanProject = function (dir) { apply(); return scan(dir, (window.FOLDER_TEMPLATES || []).map(function (t) { return { id: t.id, name: t.name }; })); };
  }

  /* ----- small dialogs ----- */
  function dialog(title, body, okLabel, danger, onOpen) {
    return new Promise(function (resolve) {
      var done = false, finish = function (v) { if (done) return; done = true; pg().closeModal(); resolve(v); };
      M.modal(title, body + '<p class="err" id="fsErr"></p><div class="dlg-foot"><button type="button" class="btn" id="fsNo">Cancel</button><button type="button" class="btn ' + (danger ? 'danger' : 'primary') + '" id="fsOk">' + esc(okLabel) + '</button></div>', { wide: !!(onOpen && onOpen.wide) });
      var root = document.querySelector('#overlay .dialog');
      document.getElementById('fsNo').addEventListener('click', function () { finish(null); });
      document.getElementById('fsOk').addEventListener('click', function () {
        var r = onOpen && onOpen.check ? onOpen.check(root) : true;
        if (r === true || (r && typeof r === 'object')) finish(r === true ? root : r); else document.getElementById('fsErr').textContent = r || '';
      });
      new MutationObserver(function (m, o) { var ov = document.getElementById('overlay'); if (!ov || ov.hidden) { o.disconnect(); if (!done) { done = true; resolve(null); } } }).observe(document.getElementById('overlay'), { attributes: true, attributeFilter: ['hidden'] });
      if (onOpen && onOpen.ready) onOpen.ready(root);
    });
  }
  var BAD = /[<>:"\/\\|?*\u0000-\u001F]/;
  function nameProblem(n) {
    if (!n) return 'Every folder needs a name.';
    if (BAD.test(n)) return 'A folder name cannot contain \\ / : * ? " < > |';
    if (/[. ]$/.test(n)) return 'A folder name cannot end with a dot or a space.';
    return '';
  }
  var onDisk = function (p) { return !!(p.foldersCreated && !p.dirMissing); };

  /* ----- applying changes to the folders already on disk ----- */
  function renameOnDisk(renames) {
    var projects = Object.values(pg().S.projects).filter(onDisk), done = 0, failed = 0;
    return projects.reduce(function (c, p) {
      return c.then(function () {
        return renames.reduce(function (c2, r) {
          return c2.then(function () { return H.renameItem(pg().projDir(p), r.from, r.to).then(function (x) { if (!x.same) done++; }, function () { failed++; }); });
        }, Promise.resolve());
      });
    }, Promise.resolve()).then(function () { return { done: done, failed: failed }; });
  }
  function createMissing() {
    var projects = Object.values(pg().S.projects).filter(onDisk), made = 0;
    return projects.reduce(function (c, p) {
      return c.then(function () {
        var base = pg().projDir(p);
        return H.mkdirs((window.FOLDER_TEMPLATES || []).map(function (t) { return M.jn(base, t.name); })).then(function (r) { made += r.filter(function (x) { return x.ok && !x.existed; }).length; });
      });
    }, Promise.resolve()).then(function () { return made; });
  }
  function rescanAll() {
    return Object.values(pg().S.projects).filter(onDisk).reduce(function (c, p) { return c.then(function () { return pg().rescanProject(p, { force: true, quiet: true }); }); }, Promise.resolve())
      .then(function () { pg().renderAll(); if (window.MorfisFiles && window.MorfisFiles.redraw) window.MorfisFiles.redraw(); });
  }
  function save(set, opts) {
    var before = current(), renames = [];
    set.forEach(function (x) { var b = before.find(function (y) { return y.id === x.id; }); if (b && b.name !== x.name && x.on) renames.push({ from: b.name, to: x.name }); });
    pg().S.settings.folderSet = set;
    pg().commitSettings(true);
    apply();
    var chain = Promise.resolve({ done: 0 }), out = {};
    if (opts.rename && renames.length) chain = renameOnDisk(renames);
    return chain.then(function (r) { out.renamed = r.done; out.renameFailed = r.failed || 0; return opts.create ? createMissing() : 0; })
      .then(function (n) { out.created = n; return rescanAll(); }).then(function () { return out; });
  }

  /* ===== Folder setup ===== */
  function rowHtml(x, i, n) {
    var s = isStd(x.id);
    return '<div class="fs-row' + (x.on ? '' : ' off') + '" data-i="' + i + '">' +
      '<label class="switch" title="' + (x.on ? 'Created in every project' : 'Not created') + '"><input type="checkbox" data-fs="on"' + (x.on ? ' checked' : '') + ' aria-label="Create ' + esc(x.label) + '"></label>' +
      '<span class="fs-id mono" title="' + (s ? 'Standard folder: automatic sorting puts matching files here' : 'Your own folder') + '">' + esc(x.id) + '</span>' +
      '<input class="in" data-fs="label" value="' + esc(x.label) + '" placeholder="Name shown in the app" aria-label="Name shown in the app">' +
      '<input class="in mono" data-fs="name" value="' + esc(x.name) + '" placeholder="Folder name on disk" aria-label="Folder name on disk" spellcheck="false">' +
      '<span class="fs-move"><button type="button" class="icon-btn" data-fs-move="-1" title="Move up"' + (i ? '' : ' disabled') + '>' + ic('chev', 15).replace('class="ic"', 'class="ic" style="transform:rotate(180deg)"') + '</button>' +
      '<button type="button" class="icon-btn" data-fs-move="1" title="Move down"' + (i < n - 1 ? '' : ' disabled') + '>' + ic('chev', 15) + '</button>' +
      (s ? '<span class="fs-std" title="Standard folder">Std</span>' : '<button type="button" class="icon-btn" data-fs-del title="Remove this folder from the setup">' + ic('trash', 15) + '</button>') + '</span></div>';
  }
  function setupBody(set) {
    return '<p class="muted small">Every project root gets the folders that are switched on, in this order. <b>01</b> to <b>06</b> are the standard folders the automatic sorting knows; folders you add are created empty. Switching a folder off stops creating it; folders already on disk stay as they are.</p>' +
      '<div class="fs-head"><span></span><span>No.</span><span>Name in the app</span><span>Folder name on disk</span><span></span></div>' +
      '<div class="fs-list" id="fsList">' + set.map(function (x, i) { return rowHtml(x, i, set.length); }).join('') + '</div>' +
      '<button type="button" class="btn sm" id="fsAdd">' + ic('plus', 14) + 'Add a folder</button>' +
      '<div class="fs-opts"><label class="switch dk-sw"><input type="checkbox" id="fsCreate" checked><span><span>Create new folders in existing projects now</span><span class="small muted dk-s">Only adds folders that are missing</span></span></label>' +
      '<label class="switch dk-sw"><input type="checkbox" id="fsRename" checked><span><span>Rename folders in existing projects to match</span><span class="small muted dk-s">When a folder name on disk is changed above. Each rename can be undone from Files</span></span></label></div>';
  }
  function openSetup() {
    var set = current();
    var read = function (root) {
      root.querySelectorAll('.fs-row').forEach(function (r) {
        var x = set[+r.dataset.i];
        x.on = r.querySelector('[data-fs=on]').checked;
        x.label = r.querySelector('[data-fs=label]').value.trim();
        x.name = r.querySelector('[data-fs=name]').value.trim();
      });
    };
    var redraw = function (root) { read(root); root.querySelector('#fsList').innerHTML = set.map(function (x, i) { return rowHtml(x, i, set.length); }).join(''); };
    return dialog('Project folder setup', setupBody(set), 'Save', false, {
      wide: true,
      ready: function (root) {
        root.addEventListener('click', function (e) {
          var mv = e.target.closest('[data-fs-move]'), del = e.target.closest('[data-fs-del]');
          if (mv) { read(root); var i = +mv.closest('.fs-row').dataset.i, j = i + +mv.dataset.fsMove; if (j < 0 || j >= set.length) return; var t = set[i]; set[i] = set[j]; set[j] = t; redraw(root); }
          else if (del) { read(root); set.splice(+del.closest('.fs-row').dataset.i, 1); redraw(root); }
          else if (e.target.closest('#fsAdd')) {
            read(root);
            var nums = set.map(function (x) { return +x.id || 0; }), id = String(Math.max.apply(null, nums.concat([6])) + 1);
            if (id.length < 2) id = '0' + id;
            set.push({ id: id, name: id + '_New_Folder', label: 'New folder', on: true, custom: true });
            redraw(root);
            var last = root.querySelector('.fs-row:last-child [data-fs=label]'); if (last) { last.focus(); last.select(); }
          }
        });
        root.addEventListener('change', function (e) { if (e.target.dataset.fs === 'on') e.target.closest('.fs-row').classList.toggle('off', !e.target.checked); });
        root.addEventListener('input', function (e) {
          /* a new folder's disk name follows its label until it is edited by hand */
          var r = e.target.closest('.fs-row'); if (!r || e.target.dataset.fs !== 'label') return;
          var x = set[+r.dataset.i], nm = r.querySelector('[data-fs=name]');
          if (x.custom && !nm.dataset.touched) nm.value = x.id + '_' + e.target.value.trim().replace(/[<>:"\/\\|?*]+/g, '').replace(/\s+/g, '_');
        });
        root.addEventListener('keydown', function (e) { if (e.target.dataset && e.target.dataset.fs === 'name') e.target.dataset.touched = '1'; });
      },
      check: function (root) {
        read(root);
        var seen = {};
        for (var i = 0; i < set.length; i++) {
          var x = set[i];
          if (!x.label) return 'Every folder needs a name in the app.';
          var bad = nameProblem(x.name); if (bad) return bad + ' (' + x.label + ')';
          var k = x.name.toLowerCase(); if (seen[k]) return 'Two folders are called ' + x.name + '.';
          seen[k] = true;
        }
        return { set: set.map(function (x) { return { id: x.id, name: x.name, label: x.label, on: !!x.on, custom: !isStd(x.id) || undefined }; }), create: root.querySelector('#fsCreate').checked, rename: root.querySelector('#fsRename').checked };
      }
    }).then(function (r) {
      if (!r) return null;
      M.toast('Saving the folder setup…');
      return save(r.set, r).then(function (out) {
        M.toast('Folder setup saved.' + (out.renamed ? ' Renamed ' + out.renamed + ' folder' + (out.renamed === 1 ? '' : 's') + ' on disk.' : '') + (out.created ? ' Created ' + out.created + ' folder' + (out.created === 1 ? '' : 's') + '.' : '') + (out.renameFailed ? ' ' + out.renameFailed + ' could not be renamed.' : ''));
        return out;
      });
    });
  }

  /* ===== one folder: rename (for every project), or move this project's copy to the Recycle Bin ===== */
  function renameStandard(fid) {
    var set = current(), x = set.find(function (y) { return y.id === fid; });
    if (!x) return Promise.resolve();
    var n = Object.values(pg().S.projects).filter(onDisk).length;
    return dialog('Rename ' + x.label, '<p class="muted small">This folder is part of every project, so it is renamed everywhere: in the app, in new projects and, if you keep the box ticked, on disk in the ' + n + ' project' + (n === 1 ? '' : 's') + ' that have folders.</p>' +
      '<div class="form-grid"><div class="field"><label for="rnLabel">Name in the app</label><input class="in" id="rnLabel" value="' + esc(x.label) + '"></div>' +
      '<div class="field"><label for="rnName">Folder name on disk</label><input class="in mono" id="rnName" value="' + esc(x.name) + '" spellcheck="false"></div></div>' +
      '<label class="switch dk-sw"><input type="checkbox" id="rnDisk" checked><span>Rename the folder on disk in existing projects</span></label>', 'Rename', false, {
      ready: function (root) { var i = root.querySelector('#rnLabel'); setTimeout(function () { i.focus(); i.select(); }, 30); },
      check: function (root) {
        var label = root.querySelector('#rnLabel').value.trim(), name = root.querySelector('#rnName').value.trim();
        if (!label) return 'Type a name.';
        var bad = nameProblem(name); if (bad) return bad;
        if (set.some(function (y) { return y.id !== fid && y.name.toLowerCase() === name.toLowerCase(); })) return 'Another folder is already called ' + name + '.';
        return { label: label, name: name, disk: root.querySelector('#rnDisk').checked };
      }
    }).then(function (r) {
      if (!r) return;
      x.label = r.label; x.name = r.name;
      return save(set, { rename: r.disk, create: false }).then(function (out) { M.toast('Renamed to ' + r.label + '.' + (out.renamed ? ' ' + out.renamed + ' folder' + (out.renamed === 1 ? '' : 's') + ' renamed on disk.' : '')); });
    });
  }
  function deleteStandard(pid, fid) {
    var p = pg().P(pid), t = (window.FOLDER_TEMPLATES || []).find(function (y) { return y.id === fid; });
    if (!p || !t) return Promise.resolve();
    var f = (p.folders || {})[fid] || {}, n = f.count || 0;
    return dialog('Delete ' + t.label, '<p class="muted">Move <b>' + esc(t.name) + '</b> of ' + esc(p.name) + (n ? ', with its ' + n + ' file' + (n === 1 ? '' : 's') + ',' : '') + ' to the Recycle Bin? You can restore it from there.</p>' +
      '<label class="switch dk-sw"><input type="checkbox" id="dlStop"><span><span>Also stop creating this folder in projects</span><span class="small muted dk-s">Changes the project folder setup; other projects keep theirs</span></span></label>', 'Move to Recycle Bin', true, {
      check: function (root) { return { stop: root.querySelector('#dlStop').checked }; }
    }).then(function (r) {
      if (!r) return;
      return H.trashPath(pg().subDir(p, fid)).then(function () {
        if (r.stop) { var set = current(), x = set.find(function (y) { return y.id === fid; }); if (x) x.on = false; return save(set, { rename: false, create: false }); }
        return pg().rescanProject(p, { force: true, quiet: true }).then(function () { pg().renderAll(); });
      }).then(function () { M.toast(t.label + ' is in the Recycle Bin.'); if (window.MorfisFiles && window.MorfisFiles.redraw) window.MorfisFiles.redraw(); },
        function (e) { M.toast('Could not remove it: ' + (e && e.message ? e.message : 'unknown error')); });
    });
  }
  function deleteProjectFolder(pid) {
    var p = pg().P(pid); if (!p) return Promise.resolve();
    var dir = pg().projDir(p);
    return dialog('Delete the project folder', '<p class="muted">Move <span class="mono">' + esc(dir) + '</span> and everything in it to the Recycle Bin?</p><p class="muted small">The project, its tasks and invoices stay in the app. You can restore the folder from the Recycle Bin, or create fresh folders from the project’s menu.</p>', 'Move to Recycle Bin', true, {})
      .then(function (ok) {
        if (!ok) return;
        return H.trashPath(dir).then(function () { return pg().rescanProject(p, { force: true, quiet: true }); }).then(function () {
          pg().renderAll(); if (window.MorfisFiles && window.MorfisFiles.redraw) window.MorfisFiles.redraw();
          M.toast('The folder of ' + p.name + ' is in the Recycle Bin.');
        }, function (e) { M.toast('Could not remove it: ' + (e && e.message ? e.message : 'unknown error')); });
      });
  }

  window.MorfisFolders = { openSetup: openSetup, renameStandard: renameStandard, deleteStandard: deleteStandard, deleteProjectFolder: deleteProjectFolder, isStd: isStd, current: current, apply: apply };
})();
