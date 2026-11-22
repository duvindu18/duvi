/* A folder browser that sits inside a page (a freelance job, a direct project), so its folders and files can be
   browsed, previewed and changed in place, without going to Files. One browser per page:
     var b = MorfisBrowser.make({ dir: fn, label: fn, onChange: fn });
     html: b.html()   clicks: if (b.handle(e)) return;   after drawing: b.mount(el)
   Its buttons use data-br-* attributes, so they never collide with the page's own. */
(function () {
  'use strict';
  var M = window.Morfis, A = window.MorfisArt;
  if (!M || !A) return;
  var H = M.H, esc = M.esc, ic = M.ic;
  var THUMBS = {};
  function fmtBytes(n) { n = +n || 0; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB'; if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'; return (n / 1073741824).toFixed(1) + ' GB'; }
  var numOf = function (name) { var m = /^(\d\d)[_ .\-]/.exec(name || ''); return m ? m[1] : ''; };
  function openApp(abs) { (H.openPathDirect || H.openPath)(abs).catch(function () { M.toast('That file is no longer there, or Windows has no program for it.'); }); }

  function make(o) {
    var b = { rel: '', list: null, key: '', view: 'grid', swap: false };
    var dir = function () { return o.dir() || ''; };
    var here = function () { return M.jn(dir(), b.rel); };
    var changed = function () { if (o.onChange) o.onChange(); };
    function load() {
      var key = b.key = dir() + '|' + b.rel;
      H.listDir(dir(), b.rel).then(function (r) { if (b.key !== key) return; b.list = { entries: r.entries }; changed(); },
        function (e) { if (b.key !== key) return; b.list = { entries: [], err: e && e.code === 'ENOENT' ? 'This folder is not on the disk.' : (e && e.message) || 'Could not read the folder.' }; changed(); });
    }
    b.go = function (rel) { b.rel = rel || ''; b.list = null; b.key = ''; b.swap = true; changed(); };
    b.reload = function () { b.list = null; b.key = ''; changed(); };

    b.html = function () {
      if (!dir()) return '<div class="fx-empty">No folder yet.</div>';
      if (b.key !== dir() + '|' + b.rel) { b.list = null; load(); }
      var segs = b.rel ? b.rel.split('/') : [];
      var crumbs = '<nav class="fx-crumbs br-crumbs"><button type="button" class="fx-cr" data-br-go="">' + esc(o.label ? o.label() : 'Folder') + '</button>' +
        segs.map(function (s, i) { return '<span class="fx-sep">' + ic('chevR', 12) + '</span><button type="button" class="fx-cr" data-br-go="' + esc(segs.slice(0, i + 1).join('/')) + '">' + esc(s) + '</button>'; }).join('') + '</nav>';
      var tools = '<div class="toolbar br-tools">' + (b.rel ? '<button type="button" class="btn sm" data-br-act="up">' + ic('chevR', 13).replace('class="ic"', 'class="ic" style="transform:rotate(180deg)"') + 'Up</button>' : '') +
        '<button type="button" class="btn sm" data-br-act="newDir">' + ic('plus', 14) + 'New folder</button><button type="button" class="btn sm" data-br-act="add">' + ic('upload', 14) + 'Add files</button>' +
        '<button type="button" class="btn sm" data-br-act="explorer">' + ic('ext', 14) + 'Open in File Explorer</button><button type="button" class="btn sm" data-br-act="reload">' + ic('refresh', 14) + 'Read again</button></div>';
      var body;
      if (b.list === null) body = '<div class="fx-empty"><i class="spin"></i> Reading the folder…</div>';
      else if (b.list.err) body = '<div class="fx-empty">' + esc(b.list.err) + '</div>';
      else {
        var dirs = b.list.entries.filter(function (e) { return e.dir; }).sort(function (x, y) { return x.name.localeCompare(y.name, undefined, { numeric: true }); });
        var files = b.list.entries.filter(function (e) { return !e.dir; }).sort(function (x, y) { return (y.mtimeMs - x.mtimeMs) || x.name.localeCompare(y.name, undefined, { numeric: true }); });
        body = (dirs.length ? '<div class="fx-grid br-grid">' + dirs.map(function (e) {
          var rel = (b.rel ? b.rel + '/' : '') + e.name;
          return '<div class="fx-card" role="button" tabindex="0" data-br-go="' + esc(rel) + '"><div class="fx-art">' + A.folder({ num: b.rel ? '' : numOf(e.name), count: e.count }) + '</div>' +
            '<div class="fx-name" title="' + esc(e.name) + '">' + esc(e.name) + '</div><div class="fx-meta">' + e.count + ' item' + (e.count === 1 ? '' : 's') + '</div>' +
            '<button type="button" class="fx-more" data-br-dmenu="' + esc(rel) + '" aria-label="Folder options">' + ic('dots', 16) + '</button></div>';
        }).join('') + '</div>' : '') +
        (files.length ? '<div class="fx-files br-files">' + files.map(function (e) {
          var abs = M.jn(here(), e.name);
          return '<div class="fx-fcard" role="button" tabindex="0" data-br-file="' + esc(abs) + '" title="' + esc(e.name) + '"><div class="fx-thumb" data-br-thumb="' + esc(abs) + '">' + A.fileIcon(e.name, 46) + '</div>' +
            '<div class="fx-fname">' + esc(e.name) + '</div><div class="fx-meta">' + esc(fmtBytes(e.size)) + ' · ' + esc(M.fdate(M.ymd(new Date(e.mtimeMs)))) + '</div>' +
            '<button type="button" class="fx-more" data-br-fmenu="' + esc(abs) + '" aria-label="More">' + ic('dots', 16) + '</button></div>';
        }).join('') + '</div>' : '') +
        (!dirs.length && !files.length ? '<div class="fx-empty">Empty. Use Add files, or New folder.</div>' : '');
      }
      return '<div class="br' + (b.swap ? ' fx-swap' : '') + '">' + crumbs + tools + body + '</div>';
    };

    b.mount = function (scope) {
      b.swap = false;
      var boxes = scope.querySelectorAll('[data-br-thumb]');
      if (!boxes.length) return;
      var io = new IntersectionObserver(function (list) {
        list.forEach(function (en) {
          if (!en.isIntersecting) return;
          var box = en.target, abs = box.dataset.brThumb;
          io.unobserve(box);
          var got = THUMBS[abs] ? Promise.resolve(THUMBS[abs]) : H.thumb(abs, 256).then(function (u) {
            if (u) return u;
            return window.MorfisPreview && window.MorfisPreview.kindOf(abs) === 'image' ? H.preview(abs).then(function (r) { return r.url; }) : '';
          });
          got.then(function (u) { if (!u) return; THUMBS[abs] = u; box.innerHTML = '<img src="' + esc(u) + '" alt="" draggable="false">'; box.classList.add('has-img'); }, function () {});
        });
      }, { rootMargin: '200px' });
      boxes.forEach(function (x) { if (THUMBS[x.dataset.brThumb]) { x.innerHTML = '<img src="' + esc(THUMBS[x.dataset.brThumb]) + '" alt="" draggable="false">'; x.classList.add('has-img'); } else io.observe(x); });
    };

    function preview(abs, scope) {
      var list = [];
      (scope || document).querySelectorAll('[data-br-file]').forEach(function (r) { list.push(r.dataset.brFile); });
      if (window.MorfisPreview) window.MorfisPreview.open(abs, list); else openApp(abs);
    }
    function ask(t, l, v, ok) { return M.ask ? M.ask(t, l, v, ok) : Promise.resolve(window.prompt(l, v)); }
    var ACT = {
      up: function () { b.go(b.rel.split('/').slice(0, -1).join('/')); },
      reload: function () { b.reload(); },
      explorer: function () { H.openPath(here()).catch(function () { M.toast('The folder is not there.'); }); },
      newDir: function () {
        ask('New folder', 'Name of the new folder', 'New folder', 'Create').then(function (name) {
          if (!name) return;
          H.makeDir(dir(), b.rel, name.trim()).then(function () { M.toast('Folder created.'); b.reload(); }, function (e) { M.toast(e && e.message ? e.message : 'Could not create it.'); });
        });
      },
      add: function () {
        var to = here();
        H.pickFiles({ title: 'Add files' }).then(function (paths) {
          if (!paths.length) return;
          return H.copyInto(to, paths).then(function (r) { M.toast('Added ' + r.copied + ' file' + (r.copied === 1 ? '' : 's') + '.' + (r.failed.length ? ' ' + r.failed.length + ' could not be copied.' : '')); b.reload(); });
        });
      }
    };
    function dirMenu(btn, rel) {
      var abs = M.jn(dir(), rel), name = rel.split('/').pop();
      M.menu(btn, [{ head: name },
        { label: 'Open', icon: 'files', fn: function () { b.go(rel); } },
        { label: 'Open in File Explorer', icon: 'ext', fn: function () { H.openPath(abs).catch(function () {}); } },
        { label: 'Rename…', icon: 'documents', fn: function () {
          ask('Rename folder', 'New name', name, 'Rename').then(function (nm) {
            if (!nm || nm === name) return;
            H.renameItem(dir(), rel, nm).then(function (r) { M.toast('Renamed to ' + nm + '.', r.id ? { label: 'Undo', fn: function () { H.undo(r.id).then(b.reload); } } : undefined); b.reload(); }, function (e) { M.toast(e && e.message ? e.message : 'Could not rename it.'); });
          });
        } },
        { label: 'Copy folder path', icon: 'copy', fn: function () { navigator.clipboard.writeText(abs).then(function () { M.toast('Path copied.'); }); } },
        { sep: true },
        { label: 'Delete (to the Recycle Bin)…', icon: 'trash', danger: true, fn: function () {
          if (!window.confirm('Move the folder ' + name + ' and everything in it to the Recycle Bin?')) return;
          H.trashPath(abs).then(function () { M.toast(name + ' is in the Recycle Bin.'); b.reload(); }, function (e) { M.toast('Could not remove it: ' + (e && e.message ? e.message : 'unknown error')); });
        } }]);
    }
    function fileMenu(btn, abs) {
      var name = abs.split(/[\\/]/).pop();
      M.menu(btn, [
        { label: 'Preview', icon: 'search', fn: function () { preview(abs, btn.closest('.br')); } },
        { label: 'Open in its own program', icon: 'ext', fn: function () { openApp(abs); } },
        { label: 'Show in Explorer', icon: 'files', fn: function () { H.reveal(abs).catch(function () {}); } },
        { label: 'Rename…', icon: 'documents', fn: function () {
          ask('Rename file', 'New name', name, 'Rename').then(function (nm) {
            if (!nm || nm === name) return;
            H.renameItem(dir(), (b.rel ? b.rel + '/' : '') + name, nm).then(function (r) { M.toast('Renamed to ' + nm + '.', r.id ? { label: 'Undo', fn: function () { H.undo(r.id).then(b.reload); } } : undefined); b.reload(); }, function (e) { M.toast(e && e.message ? e.message : 'Could not rename it.'); });
          });
        } },
        { label: 'Copy path', icon: 'copy', fn: function () { navigator.clipboard.writeText(abs).then(function () { M.toast('Path copied.'); }); } },
        { sep: true },
        { label: 'Move to the Recycle Bin', icon: 'trash', danger: true, fn: function () {
          if (!window.confirm('Move ' + name + ' to the Recycle Bin?')) return;
          H.trashPath(abs).then(function () { M.toast(name + ' is in the Recycle Bin.'); b.reload(); }, function (e) { M.toast('Could not remove it: ' + (e && e.message ? e.message : 'unknown error')); });
        } }]);
    }
    /* clicks inside the page: true when the browser took it */
    b.handle = function (e) {
      var t = e.target, x;
      if (!t.closest || !t.closest('.br')) return false;
      if ((x = t.closest('[data-br-dmenu]'))) { e.stopPropagation(); dirMenu(x, x.dataset.brDmenu); return true; }
      if ((x = t.closest('[data-br-fmenu]'))) { e.stopPropagation(); fileMenu(x, x.dataset.brFmenu); return true; }
      if ((x = t.closest('[data-br-act]'))) { ACT[x.dataset.brAct](); return true; }
      if ((x = t.closest('[data-br-go]'))) { b.go(x.dataset.brGo); return true; }
      if ((x = t.closest('[data-br-file]'))) { preview(x.dataset.brFile, x.closest('.br')); return true; }
      return true;
    };
    b.dbl = function (e) { var x = e.target.closest && e.target.closest('[data-br-file]'); if (!x) return false; if (window.MorfisPreview) window.MorfisPreview.close(); openApp(x.dataset.brFile); return true; };
    b.key2 = function (e) {
      var x = e.target.closest && e.target.closest('[data-br-go],[data-br-file]');
      if (!x || (e.key !== 'Enter' && e.key !== ' ')) return false;
      e.preventDefault();
      if (x.dataset.brGo != null) b.go(x.dataset.brGo); else if (e.key === ' ') preview(x.dataset.brFile, x.closest('.br')); else openApp(x.dataset.brFile);
      return true;
    };
    return b;
  }
  window.MorfisBrowser = { make: make };
})();
