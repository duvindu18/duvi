/* The phone page's window.morfisDesktop: the same calls the desktop window makes, sent to the computer over the
   network (remote.js in the main process). Things that belong to the phone happen on the phone: choosing files
   uploads them, saved files and PDFs download, links open in the phone's browser. Runs first in the page. */
(function () {
  'use strict';
  window.MORFIS_REMOTE = true;
  var CLIENT = Math.random().toString(36).slice(2, 12);
  var post = function (url, body, type) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': type || 'application/json', 'x-morfis-client': CLIENT }, body: body }).then(function (r) {
      if (r.status === 401) { location.replace('/'); throw new Error('This phone is no longer paired.'); }
      return r.json();
    }, function () { throw new Error('The computer did not answer. Check that it is on and on the same network.'); });
  };
  var unwrap = function (r) { if (r && r.e) { var x = new Error(r.e.message); if (r.e.code) x.code = r.e.code; throw x; } return r ? r.v : undefined; };
  var call = function (m) { return function () { return post('/api/' + m, JSON.stringify({ args: Array.prototype.slice.call(arguments) })).then(unwrap); }; };
  var api = {};
  ['info', 'storeLoad', 'storeSet', 'setTheme', 'setZoom', 'setBranding',
    'reveal', 'openDataDir', 'trashPath', 'readFile', 'isDir',
    'scanProject', 'scanRoot', 'scanDir', 'listTree', 'listDir', 'mkdirs', 'copyInto', 'applyOps', 'undo',
    'renameItem', 'makeDir', 'moveItems', 'trashItems', 'geocode', 'reverse',
    'getPrefs', 'setPref', 'resetPrefs', 'relaunch', 'openBackups', 'backupNow', 'refreshShortcuts',
    'docsList', 'docSave', 'docDelete', 'kvGet', 'kvSet', 'notify',
    'aiStatus', 'aiChat', 'aiPull', 'folderIcon', 'folderIconClear', 'folderIconRefresh', 'preview', 'readText', 'thumb', 'dirs'].forEach(function (m) { api[m] = call(m); });

  /* ----- downloads to the phone ----- */
  function download(url) {
    var a = document.createElement('a');
    a.href = url; a.download = ''; a.rel = 'noopener'; a.style.display = 'none';
    document.body.appendChild(a); a.click(); setTimeout(function () { a.remove(); }, 1000);
  }
  api.saveFile = function (filename, bytes) {
    return post('/download?name=' + encodeURIComponent(filename), bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), 'application/octet-stream').then(unwrap).then(function (url) { download(url); return filename; });
  };
  api.savePdf = function (html, filename) { return call('pdfFile')(html, filename).then(function (url) { download(url); return filename; }); };
  /* printing goes through the phone: the PDF opens in its viewer, which can print or share it */
  api.printHtml = function (html) { return call('printFile')(html).then(function (url) { download(url); return { ok: true }; }); };

  /* ----- opening things: files open on the phone, folders on the computer ----- */
  api.openPath = function (p) {
    return api.isDir(p).then(function (dir) {
      if (dir) return call('openPath')(p);
      return api.preview(p).then(function (r) { download(r.url + '?dl=1'); return true; });
    });
  };
  api.openPathDirect = api.openPath;
  api.openExternal = function (url) {
    if (!/^(https:|mailto:)/i.test(url)) return Promise.reject(new Error('Only web and email links open from here.'));
    if (window.MorfisAndroid && window.MorfisAndroid.openExternal) window.MorfisAndroid.openExternal(url); else window.open(url, '_blank', 'noopener');
    return Promise.resolve(true);
  };

  /* ----- choosing files on the phone: they are uploaded, and the page gets their place on the computer ----- */
  api.pickFiles = function (o) {
    o = o || {};
    return new Promise(function (resolve, reject) {
      var inp = document.createElement('input'), done = false;
      inp.type = 'file'; inp.multiple = true; inp.style.display = 'none';
      var ext = []; (o.filters || []).forEach(function (f) { (f.extensions || []).forEach(function (e) { if (e !== '*') ext.push('.' + e); }); });
      if (ext.length) inp.accept = ext.join(',');
      var finish = function (files) {
        if (done) return; done = true; inp.remove();
        if (!files || !files.length) { resolve([]); return; }
        var list = Array.prototype.slice.call(files), out = [];
        toast('Uploading ' + list.length + ' file' + (list.length === 1 ? '' : 's') + '…');
        list.reduce(function (c, f) {
          return c.then(function () { return post('/upload?name=' + encodeURIComponent(f.name), f, 'application/octet-stream').then(unwrap).then(function (p) { out.push(p); }); });
        }, Promise.resolve()).then(function () { resolve(out); }, reject);
      };
      inp.addEventListener('change', function () { finish(inp.files); });
      inp.addEventListener('cancel', function () { finish(null); });
      /* when the chooser closes without a choice and no cancel event comes */
      window.addEventListener('focus', function f() { window.removeEventListener('focus', f); setTimeout(function () { if (!inp.files || !inp.files.length) finish(null); }, 1500); });
      document.body.appendChild(inp); inp.click();
    });
  };
  /* ----- choosing a folder on the computer, from the phone ----- */
  api.pickFolder = function (o) {
    o = o || {};
    return new Promise(function (resolve) {
      var box = document.createElement('div');
      box.className = 'rb-pick'; box.setAttribute('role', 'dialog');
      document.body.appendChild(box);
      var close = function (v) { box.remove(); resolve(v); };
      var show = function (p) {
        box.innerHTML = '<div class="rb-pick-c"><div class="rb-pick-h"><b>' + esc(o.title || 'Choose a folder on the computer') + '</b><span class="mono">' + esc(p || 'This computer') + '</span></div><div class="rb-pick-l"><i class="spin"></i></div>' +
          '<div class="rb-pick-f"><button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn primary" data-ok' + (p ? '' : ' disabled') + '>Use this folder</button></div></div>';
        box.querySelector('[data-x]').onclick = function () { close(null); };
        box.querySelector('[data-ok]').onclick = function () { close(p); };
        api.dirs(p).then(function (r) {
          var l = box.querySelector('.rb-pick-l');
          l.innerHTML = (r.parent || r.path ? '<button type="button" data-p="' + esc(r.parent) + '">↑ Up</button>' : '') + r.dirs.map(function (d) { return '<button type="button" data-p="' + esc(d.path) + '">' + esc(d.name) + '</button>'; }).join('') + (r.dirs.length ? '' : '<p class="muted small">No folders here.</p>');
          l.querySelectorAll('[data-p]').forEach(function (b) { b.onclick = function () { show(b.dataset.p); }; });
        }, function (e) { box.querySelector('.rb-pick-l').innerHTML = '<p class="muted small">' + esc(e.message) + '</p>'; });
      };
      show(o.defaultPath || '');
    });
  };

  /* ----- what only the desktop window has ----- */
  api.pathsOf = function () { return []; };
  api.onFocus = function (fn) { document.addEventListener('visibilitychange', function () { if (!document.hidden) fn(); }); };
  api.onZoom = function () {};
  api.onWin = function () {};

  /* ----- live changes from the computer ----- */
  var subs = { store: [], ai: [] }, es = null, wasOpen = false;
  function listen() {
    es = new EventSource('/events?client=' + CLIENT);
    es.onopen = function () {
      document.documentElement.classList.remove('rb-offline');
      /* back after a gap: take in everything once, so nothing missed while asleep stays out of date */
      if (wasOpen && window.__morfisPage && window.__morfisPage.applyAll) api.storeLoad().then(function (d) { window.__morfisPage.applyAll(d); if (window.MorfisDocs && window.MorfisDocs.reload) window.MorfisDocs.reload(); }, function () {});
      wasOpen = true;
    };
    es.onerror = function () { document.documentElement.classList.add('rb-offline'); };
    es.onmessage = function (m) {
      var ev; try { ev = JSON.parse(m.data); } catch (e) { return; }
      if (ev.t === 'ai:pull') subs.ai.forEach(function (fn) { fn(ev.p); });
      else subs.store.forEach(function (fn) { fn(ev); });
    };
  }
  api.onStore = function (fn) { subs.store.push(fn); };
  api.onAiPull = function (fn) { subs.ai.push(fn); };
  api.logout = function () { return post('/logout', '{}').then(function () { location.replace('/'); }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', listen); else listen();

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(t) { var pg = window.__morfisPage; if (pg && pg.toast) pg.toast(t); }
  window.morfisDesktop = api;
})();
