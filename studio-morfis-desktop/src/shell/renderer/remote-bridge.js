/* The phone page's window.morfisDesktop: the same calls the desktop window makes, sent to the computer over the
   network (remote.js in the main process). Runs first in the page.

   Things that belong to the phone happen on the phone: choosing files uploads them, saved files and PDFs download,
   links open in the phone's browser.

   It also works with no connection. The phone keeps a copy of the projects, documents and settings, and of every
   project folder's names, sizes and dates (never the files themselves). Away from the computer, changes are made
   on that copy and queued: project and invoice edits, and renaming, moving, deleting, new folders and files added
   from the phone. When the computer answers again, the queue is sent in order. A record changed on both sides is
   merged item by item; where the same thing changed on both, the computer's version stays, and a short report
   says so. */
(function () {
  'use strict';
  window.MORFIS_REMOTE = true;
  var A = window.MorfisAndroid || null;
  /* in the Android app the page has a fixed address of its own and calls the computer directly with its key */
  var BASE = A && A.server ? String(A.server() || '') : '';
  var KEY = A && A.key ? String(A.key() || '') : '';
  var SERVER_ID = A && A.serverId ? String(A.serverId() || '') : '';
  var CLIENT = Math.random().toString(36).slice(2, 12);
  var ONLINE = true, SYNCING = false, forcedOffline = false;
  var NET = 'NET';

  /* ----- talking to the computer ----- */
  function headers(type) { var h = { 'content-type': type || 'application/json', 'x-morfis-client': CLIENT }; if (KEY) h['x-morfis-key'] = KEY; return h; }
  function post(path, body, type, timeout) {
    if (forcedOffline) return Promise.reject(netErr());
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, t = ctl && timeout ? setTimeout(function () { ctl.abort(); }, timeout) : 0;
    return fetch(BASE + path, { method: 'POST', credentials: BASE ? 'omit' : 'same-origin', headers: headers(type), body: body, signal: ctl ? ctl.signal : undefined }).then(function (r) {
      clearTimeout(t);
      if (r.status === 401) { unpaired(); throw new Error('This phone is no longer paired.'); }
      if (!ONLINE) online(true);
      return r.json();
    }, function () { clearTimeout(t); online(false); throw netErr(); });
  }
  function netErr() { var x = new Error('The computer did not answer. Check that it is on and on the same network.'); x.code = NET; return x; }
  var isNet = function (e) { return e && e.code === NET; };
  var unwrap = function (r) { if (r && r.e) { var x = new Error(r.e.message); if (r.e.code) x.code = r.e.code; throw x; } return r ? r.v : undefined; };
  function net(m, args, timeout) { return post('/api/' + m, JSON.stringify({ args: args || [] }), null, timeout || 30000).then(unwrap); }
  function unpaired() { if (A && A.unpaired) A.unpaired(); else location.replace('/'); }

  /* ----- what the phone keeps: IndexedDB, one database per computer ----- */
  var DBN = 'morfis-offline' + (SERVER_ID ? '-' + SERVER_ID : '');
  var L = { snap: null, docs: null, kv: {}, prefs: null, info: null, outbox: [], base: {}, trees: {} };
  var db = null;
  var ready = new Promise(function (resolve) {
    if (!window.indexedDB) { resolve(); return; }
    var rq = indexedDB.open(DBN, 1);
    rq.onupgradeneeded = function () { rq.result.createObjectStore('state'); rq.result.createObjectStore('blobs'); };
    rq.onerror = function () { resolve(); };
    rq.onsuccess = function () {
      db = rq.result;
      var tx = db.transaction('state', 'readonly'), st = tx.objectStore('state'), keys = st.getAllKeys(), vals = st.getAll();
      tx.oncomplete = function () {
        (keys.result || []).forEach(function (k, i) { var v = vals.result[i]; if (k.indexOf('tree:') === 0) L.trees[k.slice(5)] = v; else L[k] = v; });
        if (!Array.isArray(L.outbox)) L.outbox = [];
        resolve();
      };
      tx.onerror = function () { resolve(); };
    };
  });
  var dirty = {}, saveT = 0;
  function keep(k) { dirty[k] = true; clearTimeout(saveT); saveT = setTimeout(flush, 300); }
  function flush() {
    if (!db) return;
    var tx = db.transaction('state', 'readwrite'), st = tx.objectStore('state');
    Object.keys(dirty).forEach(function (k) {
      if (k.indexOf('tree:') === 0) { var t = L.trees[k.slice(5)]; if (t) st.put(t, k); else st.delete(k); } else st.put(L[k], k);
    });
    dirty = {};
  }
  function blobPut(id, file) { return new Promise(function (res, rej) { if (!db) return rej(new Error('This phone cannot keep files offline.')); var tx = db.transaction('blobs', 'readwrite'); tx.objectStore('blobs').put({ name: file.name, type: file.type, blob: file }, id); tx.oncomplete = function () { res(); }; tx.onerror = function () { rej(tx.error); }; }); }
  function blobGet(id) { return new Promise(function (res) { if (!db) return res(null); var rq = db.transaction('blobs').objectStore('blobs').get(id); rq.onsuccess = function () { res(rq.result || null); }; rq.onerror = function () { res(null); }; }); }
  function blobDel(id) { if (db) db.transaction('blobs', 'readwrite').objectStore('blobs').delete(id); }
  var clone = function (v) { return v == null ? v : JSON.parse(JSON.stringify(v)); };
  var same = function (a, b) { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); };

  /* ----- folders on the phone: one tree of names per project folder ----- */
  var JUNK = /^(desktop\.ini|thumbs\.db|\.ds_store|\.tmp|.*\.tmp|.*\.crdownload|.*\.part|~\$.*|\..*|.*\.bak)$/i;
  var norm = function (p) { return String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, ''); };
  var low = function (p) { return norm(p).toLowerCase(); };
  function sepOf(p) { return /\\/.test(p) || /^[A-Za-z]:/.test(p) ? '\\' : '/'; }
  function join(base, rel) { var s = sepOf(base); return String(base || '').replace(/[\\/]+$/, '') + (rel ? s + norm(rel).split('/').join(s) : ''); }
  var parentOf = function (rel) { var i = rel.lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); };
  var nameOf = function (rel) { return rel.slice(rel.lastIndexOf('/') + 1); };
  /* which tree a path is in, and where */
  function locate(abs) {
    var a = low(abs), best = null;
    Object.keys(L.trees).forEach(function (root) {
      var r = low(root);
      if ((a === r || a.indexOf(r + '/') === 0) && (!best || r.length > low(best.root).length)) best = L.trees[root];
    });
    if (!best) return null;
    var rel = norm(abs).slice(norm(best.root).length).replace(/^\//, '');
    /* the case on disk wins: find the stored spelling */
    if (rel && !best.e[rel]) { var lr = rel.toLowerCase(); Object.keys(best.e).some(function (k) { if (k.toLowerCase() === lr) { rel = k; return true; } return false; }); }
    return { t: best, rel: rel };
  }
  function tkeep(t) { keep('tree:' + t.root); }
  function ensureDir(t, rel) { var parts = rel ? rel.split('/') : []; for (var i = 1; i <= parts.length; i++) { var r = parts.slice(0, i).join('/'); if (!t.e[r]) t.e[r] = [1, 0, 0]; } }
  function freeRel(t, rel) {
    if (!t.e[rel]) return rel;
    var p = parentOf(rel), n = nameOf(rel), dot = n.lastIndexOf('.'), stem = dot > 0 ? n.slice(0, dot) : n, ext = dot > 0 ? n.slice(dot) : '';
    for (var k = 2; k < 999; k++) { var c = (p ? p + '/' : '') + stem + ' (' + k + ')' + ext; if (!t.e[c]) return c; }
    return rel;
  }
  function moveRel(t, from, to, copy) {
    var keys = Object.keys(t.e).filter(function (k) { return k === from || k.indexOf(from + '/') === 0; });
    ensureDir(t, parentOf(to));
    keys.forEach(function (k) { var v = t.e[k], nk = to + k.slice(from.length); if (!copy) delete t.e[k]; t.e[nk] = v.slice(); });
    return keys.length;
  }
  function removeRel(t, rel) { var n = 0; Object.keys(t.e).forEach(function (k) { if (k === rel || k.indexOf(rel + '/') === 0) { delete t.e[k]; n++; } }); return n; }
  var exists = function (loc) { return !!(loc && (loc.rel === '' || loc.t.e[loc.rel])); };
  var isDirAt = function (loc) { return !!(loc && (loc.rel === '' || (loc.t.e[loc.rel] && loc.t.e[loc.rel][0]))); };
  function children(t, rel) {
    var out = [];
    Object.keys(t.e).forEach(function (k) { if (parentOf(k) === rel && k !== rel) out.push(k); });
    return out;
  }
  function treeFrom(r) { var e = {}; (r.entries || []).forEach(function (x) { e[x[0]] = [x[1], x[2], x[3]]; }); return { root: r.root, at: r.at || Date.now(), capped: !!r.capped, e: e }; }
  var noCopy = function () { var x = new Error('This folder is not on the phone yet. Connect to the computer once and it is kept for offline use.'); x.code = 'ENOENT'; return x; };

  /* the answers the page gets while offline, worked out from the trees */
  var OFF = {
    info: function () { return Object.assign({ remote: true, offline: true, zoom: 1 }, L.info || {}); },
    getPrefs: function () { if (!L.prefs) throw new Error('Connect to the computer once to use the app offline.'); return L.prefs; },
    storeLoad: function () { if (!L.snap) throw new Error('Connect to the computer once to use the app offline.'); return clone(L.snap); },
    docsList: function () { return clone(L.docs || []); },
    kvGet: function (k) { return clone(L.kv[k]); },
    aiStatus: function () { return { running: false, ready: false, enabled: false, models: [], suggested: [], model: '' }; },
    isDir: function (p) { return isDirAt(locate(p)); },
    listDir: function (base, rel) {
      var loc = locate(join(base, rel || ''));
      if (!loc || !isDirAt(loc)) throw noCopy();
      return { entries: children(loc.t, loc.rel).filter(function (k) { return !JUNK.test(nameOf(k)); }).map(function (k) {
        var v = loc.t.e[k];
        return v[0] ? { name: nameOf(k), dir: true, size: 0, mtimeMs: 0, count: children(loc.t, k).filter(function (c) { return !JUNK.test(nameOf(c)); }).length } : { name: nameOf(k), dir: false, size: v[1], mtimeMs: v[2], count: 0 };
      }), capped: false, offline: true };
    },
    listTree: function (p) {
      var loc = locate(p); if (!loc || !isDirAt(loc)) throw noCopy();
      var pre = loc.rel ? loc.rel + '/' : '';
      return { entries: Object.keys(loc.t.e).filter(function (k) { return !pre || k.indexOf(pre) === 0; }).map(function (k) { var v = loc.t.e[k]; return { rel: k.slice(pre.length), size: v[1], isDir: !!v[0] }; }), capped: loc.t.capped };
    },
    /* the same result fsops.scanProject gives, from the names on the phone */
    scanProject: function (dir, tpls) {
      var loc = locate(dir);
      if (!loc) throw noCopy();
      if (loc.rel !== '' && !isDirAt(loc)) return { exists: false, subs: {}, looseCount: 0, loose: [] };
      var T = (Array.isArray(tpls) && tpls.length ? tpls : (window.__morfisPage && window.__morfisPage.FOLDER_TEMPLATES) || []), pre = loc.rel ? loc.rel + '/' : '';
      var top = {}, subs = {}, loose = [];
      Object.keys(loc.t.e).forEach(function (k) { if (pre && k.indexOf(pre) !== 0) return; var r = k.slice(pre.length); if (r) top[r] = loc.t.e[k]; });
      T.forEach(function (t) {
        var key = Object.keys(top).find(function (r) { return r.indexOf('/') === -1 && top[r][0] && r.toLowerCase() === String(t.name).toLowerCase(); });
        if (!key) { subs[t.id] = { exists: false, count: 0, files: [] }; return; }
        var files = Object.keys(top).filter(function (r) { return r.indexOf(key + '/') === 0 && !top[r][0] && !JUNK.test(nameOf(r)); }).map(function (r) { return { rel: r.slice(key.length + 1), size: top[r][1], mtimeMs: top[r][2] }; });
        files.sort(function (a, b) { return b.mtimeMs - a.mtimeMs; });
        subs[t.id] = { exists: true, count: files.length, files: files.slice(0, 300) };
      });
      var names = T.map(function (t) { return String(t.name).toLowerCase(); });
      Object.keys(top).forEach(function (r) { var head = r.split('/')[0]; if (names.indexOf(head.toLowerCase()) !== -1 || top[r][0] || JUNK.test(nameOf(r))) return; loose.push(r); });
      return { exists: true, subs: subs, looseCount: loose.length, loose: loose.slice(0, 200) };
    }
  };

  /* ----- changes: done on the computer when it answers, otherwise kept on the phone and sent later ----- */
  /* the change, applied to the phone's copy; returns what the computer would have answered */
  var LOCAL = {
    storeSet: function (kind, id, value) {
      if (!L.snap) L.snap = { projects: {}, settings: null };
      if (kind === 's') L.snap.settings = clone(value); else if (value === null) delete L.snap.projects[id]; else L.snap.projects[id] = clone(value);
      keep('snap'); return true;
    },
    docSave: function (d) { L.docs = (L.docs || []).filter(function (x) { return x.id !== d.id; }).concat([clone(d)]); keep('docs'); return true; },
    docDelete: function (id) { L.docs = (L.docs || []).filter(function (x) { return x.id !== id; }); keep('docs'); return true; },
    kvSet: function (k, v) { if (v == null) delete L.kv[k]; else L.kv[k] = clone(v); keep('kv'); return true; },
    renameItem: function (parent, rel, name) {
      if (!name || /[<>:"\/\\|?*\u0000-\u001F]/.test(name) || /[. ]$/.test(name)) throw new Error('A name cannot contain \\ / : * ? " < > | or end with a dot or space.');
      var abs = join(parent, rel), loc = locate(abs);
      /* the project folder itself: its tree moves with it */
      var root = Object.keys(L.trees).find(function (r) { return low(r) === low(abs); });
      var newAbs = join(parent, (parentOf(norm(rel)) ? parentOf(norm(rel)) + '/' : '') + name);
      if (root) { var t = L.trees[root]; delete L.trees[root]; keep('tree:' + root); t.root = newAbs; L.trees[newAbs] = t; tkeep(t); }
      else {
        if (!exists(loc)) throw new Error('It is not there any more.');
        var to = (parentOf(loc.rel) ? parentOf(loc.rel) + '/' : '') + name;
        if (to.toLowerCase() !== loc.rel.toLowerCase() && loc.t.e[to]) throw new Error('Something called ' + name + ' is already there.');
        moveRel(loc.t, loc.rel, to); tkeep(loc.t);
      }
      return { same: false, rel: norm((parentOf(norm(rel)) ? parentOf(norm(rel)) + '/' : '') + name), id: '' };
    },
    makeDir: function (base, rel, name) {
      if (!name || /[<>:"\/\\|?*\u0000-\u001F]/.test(name)) throw new Error('A name cannot contain \\ / : * ? " < > |');
      var loc = locate(join(join(base, rel || ''), name)); if (!loc) throw noCopy();
      if (loc.t.e[loc.rel]) throw new Error('A folder called ' + name + ' is already there.');
      ensureDir(loc.t, loc.rel); tkeep(loc.t); return { path: join(join(base, rel || ''), name) };
    },
    mkdirs: function (dirs) {
      return (dirs || []).map(function (d) {
        var loc = locate(d), had = exists(loc);
        /* a new project's folder, straight inside the projects folder: it gets a tree of its own */
        if (!loc) { var pg = window.__morfisPage, root = pg && pg.S && pg.S.settings && pg.S.settings.root; if (root && low(d.replace(/[\\/][^\\/]+[\\/]?$/, '')) === low(root)) { L.trees[d] = { root: d, at: Date.now(), capped: false, e: {} }; tkeep(L.trees[d]); loc = locate(d); } }
        if (loc) { ensureDir(loc.t, loc.rel); tkeep(loc.t); }
        return { path: d, ok: !!loc, existed: had, error: loc ? undefined : 'Not on this phone yet' };
      });
    },
    moveItems: function (base, rels, destRel) {
      var moved = 0, failed = [], skipped = 0, dl = locate(join(base, destRel || ''));
      if (!dl) throw noCopy();
      (rels || []).forEach(function (r) {
        var loc = locate(join(base, r));
        if (!exists(loc)) { failed.push({ path: r, error: 'It is not there any more.' }); return; }
        if (parentOf(loc.rel) === dl.rel) { skipped++; return; }
        if ((dl.rel + '/').indexOf(loc.rel + '/') === 0) { failed.push({ path: r, error: 'A folder cannot go inside itself.' }); return; }
        moveRel(loc.t, loc.rel, freeRel(loc.t, (dl.rel ? dl.rel + '/' : '') + nameOf(loc.rel))); moved++;
      });
      if (dl) tkeep(dl.t);
      return { moved: moved, failed: failed, skipped: skipped, id: '' };
    },
    applyOps: function (base, ops, mode) {
      var moved = 0, failed = [];
      (ops || []).forEach(function (o) {
        var a = locate(join(base, o.from)), b = locate(join(base, o.to));
        if (!exists(a) || !b) { failed.push({ from: o.from, error: 'It is not there any more.' }); return; }
        moveRel(a.t, a.rel, freeRel(b.t, b.rel), mode === 'copy'); tkeep(a.t); moved++;
      });
      return { moved: moved, failed: failed, id: '' };
    },
    trashItems: function (base, rels) {
      var n = 0, failed = [];
      (rels || []).forEach(function (r) { var loc = locate(join(base, r)); if (exists(loc)) { removeRel(loc.t, loc.rel); tkeep(loc.t); n++; } else failed.push({ path: r, error: 'It is not there any more.' }); });
      return { trashed: n, failed: failed };
    },
    trashPath: function (p) { var loc = locate(p); if (!exists(loc)) throw new Error('It is not there any more.'); removeRel(loc.t, loc.rel); tkeep(loc.t); return true; },
    /* files from the phone: kept here until they can be sent */
    copyInto: function (dir, paths) {
      var loc = locate(dir); if (!loc) throw noCopy();
      ensureDir(loc.t, loc.rel);
      var n = 0;
      (paths || []).forEach(function (p) { var m = /^phone-file:([^/]+)\/(.*)$/.exec(p), name = m ? m[2] : String(p).split(/[\\/]/).pop(); loc.t.e[freeRel(loc.t, (loc.rel ? loc.rel + '/' : '') + name)] = [0, m && PEND[m[1]] ? PEND[m[1]] : 0, Date.now()]; n++; });
      tkeep(loc.t); return { copied: n, failed: [] };
    }
  };
  var PEND = {}; /* sizes of files waiting on the phone, by id */
  var RECORD = { storeSet: 1, docSave: 1, docDelete: 1, kvSet: 1 };
  var keyOf = function (m, a) { return m === 'storeSet' ? (a[0] === 's' ? 's:studio' : 'p:' + a[1]) : m === 'docSave' ? 'd:' + a[0].id : m === 'docDelete' ? 'd:' + a[0] : m === 'kvSet' ? 'k:' + a[0] : ''; };
  /* what the computer had before the first change made on the phone: the base for merging later */
  function baseOf(k) {
    if (k === 's:studio') return clone(L.snap && L.snap.settings);
    if (k.indexOf('p:') === 0) return clone(L.snap && L.snap.projects[k.slice(2)]);
    if (k.indexOf('d:') === 0) return clone((L.docs || []).find(function (d) { return d.id === k.slice(2); }) || null);
    return null;
  }
  /* taken before the phone's copy changes */
  function noteBase(m, args) { var k = RECORD[m] ? keyOf(m, args) : ''; if (k && !(k in L.base)) { L.base[k] = baseOf(k); keep('base'); } }
  function enqueue(m, args) {
    var k = RECORD[m] ? keyOf(m, args) : '';
    if (k) {
      /* one entry per record, at the place of its first change, holding the latest version */
      var ex = L.outbox.find(function (o) { return o.k === k; });
      if (ex) { ex.m = m; ex.a = clone(args); keep('outbox'); return; }
    }
    L.outbox.push({ m: m, a: clone(args), k: k, at: Date.now() });
    keep('outbox'); status();
  }
  function write(m) {
    return function () {
      var args = Array.prototype.slice.call(arguments);
      var local = function () { noteBase(m, args); var v = LOCAL[m].apply(null, args); enqueue(m, args); return v; };
      var phoneFiles = m === 'copyInto' && (args[1] || []).some(function (p) { return /^phone-file:/.test(p); });
      return ready.then(function () {
        /* while anything is waiting, new changes wait behind it, so they reach the computer in the order made */
        if (!ONLINE || SYNCING || L.outbox.length || phoneFiles) return local();
        return net(m, args).then(function (v) {
          try { mirror(m, args, v); } catch (e) { /* the copy is read again later */ }
          return v;
        }, function (e) { if (isNet(e)) return local(); throw e; });
      });
    };
  }
  /* a change made on the computer through the phone: keep the copy in step */
  function mirror(m, args, v) {
    if (RECORD[m]) { LOCAL[m].apply(null, args); return; }
    if (m === 'renameItem' || m === 'makeDir' || m === 'mkdirs' || m === 'trashItems' || m === 'trashPath') { try { LOCAL[m].apply(null, args); } catch (e) { /* refreshed below */ } }
    var loc = locate(args[0]); if (loc) refreshSoon(loc.t.root);
  }
  function read(m) {
    return function () {
      var args = Array.prototype.slice.call(arguments);
      return ready.then(function () {
        if (!ONLINE) return OFF[m].apply(null, args);
        return net(m, args, 8000).then(function (v) { remember(m, args, v); return v; }, function (e) { if (isNet(e)) return OFF[m].apply(null, args); throw e; });
      });
    };
  }
  function remember(m, args, v) {
    if (m === 'storeLoad' && !L.outbox.length) { L.snap = clone(v); keep('snap'); setTimeout(fetchTrees, 2500); }
    else if (m === 'docsList' && !L.outbox.some(function (o) { return o.k.indexOf('d:') === 0; })) { L.docs = clone(v); keep('docs'); }
    else if (m === 'kvGet' && !L.outbox.some(function (o) { return o.k === 'k:' + args[0]; })) { if (v == null) delete L.kv[args[0]]; else L.kv[args[0]] = clone(v); keep('kv'); }
    else if (m === 'getPrefs') { L.prefs = clone(v); keep('prefs'); }
    else if (m === 'info') { L.info = clone(v); keep('info'); }
  }
  /* things that need the computer itself */
  function only(m) {
    return function () {
      var args = Array.prototype.slice.call(arguments);
      if (!ONLINE) return Promise.reject(new Error('This needs the computer. It works again when the phone reaches it.'));
      return net(m, args);
    };
  }

  var api = {};
  ['info', 'getPrefs', 'storeLoad', 'docsList', 'kvGet', 'aiStatus', 'isDir', 'listDir', 'listTree', 'scanProject'].forEach(function (m) { api[m] = read(m); });
  ['storeSet', 'docSave', 'docDelete', 'kvSet', 'renameItem', 'makeDir', 'mkdirs', 'moveItems', 'applyOps', 'trashItems', 'trashPath', 'copyInto'].forEach(function (m) { api[m] = write(m); });
  ['setTheme', 'setZoom', 'setBranding', 'reveal', 'openDataDir', 'readFile', 'scanRoot', 'scanDir', 'undo', 'geocode', 'reverse',
    'setPref', 'resetPrefs', 'relaunch', 'openBackups', 'backupNow', 'refreshShortcuts', 'notify',
    'aiChat', 'aiPull', 'folderIcon', 'folderIconClear', 'folderIconRefresh', 'preview', 'readText', 'thumb', 'dirs', 'syncTree', 'pdfFile', 'printFile', 'openPath'].forEach(function (m) { api[m] = only(m); });
  /* no undo for a change still waiting on the phone */
  var undo = api.undo; api.undo = function (id) { return id ? undo(id) : Promise.reject(new Error('That change has not reached the computer yet.')); };
  api.setTheme = function (t) { return ONLINE ? net('setTheme', [t]).catch(function () { return true; }) : Promise.resolve(true); };
  api.notify = function () { return Promise.resolve(false); };
  api.thumb = function (f, s) { return ONLINE ? net('thumb', [f, s]).catch(function () { return ''; }) : Promise.resolve(''); };

  /* ----- the project folders' names, kept for offline use ----- */
  var treeBusy = false, refreshQ = {}, refreshT = 0;
  function fetchTrees() {
    var pg = window.__morfisPage;
    if (treeBusy || !ONLINE || L.outbox.length || !pg || !pg.S || !pg.S.ready) return;
    treeBusy = true;
    var dirs = Object.values(pg.S.projects).filter(function (p) { return p.foldersCreated && !p.dirMissing; }).map(function (p) { return pg.projDir(p); });
    var keepRoots = {};
    dirs.reduce(function (c, d) { return c.then(function () { return pullTree(d).then(function () { keepRoots[low(d)] = 1; }, function () {}); }); }, Promise.resolve()).then(function () {
      /* folders of projects that are gone */
      Object.keys(L.trees).forEach(function (r) { if (!keepRoots[low(r)] && ONLINE && !L.outbox.length) { delete L.trees[r]; keep('tree:' + r); } });
      treeBusy = false; status();
    }, function () { treeBusy = false; });
  }
  function pullTree(dir) {
    return net('syncTree', [dir], 60000).then(function (r) {
      if (L.outbox.length) return;
      Object.keys(L.trees).forEach(function (k) { if (low(k) === low(dir) && k !== dir) { delete L.trees[k]; keep('tree:' + k); } });
      if (!r.exists) { delete L.trees[dir]; keep('tree:' + dir); return; }
      L.trees[dir] = treeFrom(r); keep('tree:' + dir);
    });
  }
  function refreshSoon(root) { refreshQ[root] = 1; clearTimeout(refreshT); refreshT = setTimeout(function () { var q = Object.keys(refreshQ); refreshQ = {}; q.reduce(function (c, d) { return c.then(function () { return pullTree(d).catch(function () {}); }); }, Promise.resolve()); }, 2500); }

  /* ----- back in touch: send what was done on the phone ----- */
  var DERIVED = { folders: 1, looseCount: 1, loose: 1, scannedAt: 1, dirMissing: 1, foldersCreated: 1, updatedAt: 1 };
  /* three-way merge: base (before the phone's changes), mine (the phone), theirs (the computer now) */
  function merge(b, m, t, path, clashes) {
    if (same(m, b)) return clone(t);
    if (same(t, b) || same(m, t)) return clone(m);
    var obj = function (x) { return x && typeof x === 'object' && !Array.isArray(x); };
    if (obj(b) && obj(m) && obj(t)) {
      var out = {};
      Object.keys(Object.assign({}, b, m, t)).forEach(function (k) {
        var v = (path.length === 0 && DERIVED[k]) ? clone(t[k] !== undefined ? t[k] : m[k]) : merge(b[k], m[k], t[k], path.concat(k), clashes);
        if (v !== undefined) out[k] = v;
      });
      return out;
    }
    var ids = function (x) { return Array.isArray(x) && x.every(function (i) { return i && typeof i === 'object' && i.id != null; }); };
    if (ids(b) && ids(m) && ids(t)) {
      var by = function (x) { var o = {}; x.forEach(function (i) { o[i.id] = i; }); return o; };
      var B = by(b), Mi = by(m), Ti = by(t), res = [];
      t.forEach(function (it) {
        if (!(it.id in Mi)) { if (it.id in B && same(B[it.id], it)) return; res.push(clone(it)); if (it.id in B) clashes.push(path.concat(String(it.id)).join(' › ')); return; }
        res.push(it.id in B ? merge(B[it.id], Mi[it.id], it, path.concat(String(it.id)), clashes) : clone(Mi[it.id]));
      });
      m.forEach(function (it) { if (!(it.id in Ti) && !(it.id in B)) res.push(clone(it)); });
      return res;
    }
    clashes.push(path.join(' › ') || 'the whole record');
    return clone(t);
  }
  var label = function (o) {
    var a = o.a, n = function (p) { return String(p || '').split(/[\\/]/).filter(Boolean).pop() || ''; };
    switch (o.m) {
      case 'storeSet': return a[0] === 's' ? 'Studio settings' : 'Project ' + ((a[2] && a[2].name) || a[1]);
      case 'docSave': return (a[0].type === 'quote' ? 'Quotation ' : 'Invoice ') + (a[0].no || '');
      case 'docDelete': return 'Deleting a document';
      case 'renameItem': return 'Renaming ' + n(a[1]) + ' to ' + a[2];
      case 'makeDir': return 'New folder ' + a[2];
      case 'moveItems': return 'Moving ' + (a[1] || []).length + ' item(s)';
      case 'applyOps': return 'Sorting ' + (a[1] || []).length + ' file(s)';
      case 'trashItems': return 'Deleting ' + (a[1] || []).length + ' item(s)';
      case 'trashPath': return 'Deleting ' + n(a[0]);
      case 'copyInto': return 'Adding ' + (a[1] || []).length + ' file(s) to ' + n(a[0]);
      default: return o.m;
    }
  };
  function sync() {
    if (SYNCING || !ONLINE || !L.outbox.length) return Promise.resolve();
    SYNCING = true; status();
    var rep = { done: 0, failed: [], clashes: [] }, theirs = null, theirDocs = null, touched = {};
    return Promise.all([net('storeLoad', []), net('docsList', [])]).then(function (r) {
      theirs = r[0]; theirDocs = r[1];
      var step = function () {
        if (!L.outbox.length) return Promise.resolve();
        var o = L.outbox[0];
        return replay(o, theirs, theirDocs, rep, touched).then(function () { rep.done++; }, function (e) {
          if (isNet(e)) throw e;
          rep.failed.push(label(o) + ': ' + e.message);
        }).then(function () { L.outbox.shift(); if (o.k) { delete L.base[o.k]; keep('base'); } keep('outbox'); status(); return step(); });
      };
      return step();
    }).then(function () {
      SYNCING = false; status();
      return Promise.all([net('storeLoad', []), net('docsList', [])]).then(function (r) {
        L.snap = r[0]; L.docs = r[1]; keep('snap'); keep('docs');
        var pg = window.__morfisPage; if (pg && pg.applyAll) pg.applyAll(r[0]);
        if (window.MorfisDocs && window.MorfisDocs.reload) window.MorfisDocs.reload();
        Object.keys(touched).forEach(refreshSoon);
        if (window.MorfisFiles && window.MorfisFiles.redraw) window.MorfisFiles.redraw();
        report(rep);
      });
    }, function () { SYNCING = false; status(); });
  }
  function replay(o, theirs, theirDocs, rep, touched) {
    var a = o.a, loc = a[0] && typeof a[0] === 'string' ? locate(a[0]) : null;
    if (loc) touched[loc.t.root] = 1;
    if (o.m === 'storeSet') {
      var kind = a[0], id = a[1], mine = a[2], base = L.base[o.k], cur = kind === 's' ? theirs.settings : theirs.projects[id], clashes = [];
      var name = kind === 's' ? 'Studio settings' : (mine && mine.name) || (cur && cur.name) || id;
      if (mine === null) {
        if (cur && base && !same(cur, base)) { rep.clashes.push(name + ': deleted on the phone but changed on the computer, so it was kept.'); return Promise.resolve(); }
        return net('storeSet', [kind, id, null]);
      }
      if (!cur && base) { rep.clashes.push(name + ': deleted on the computer, so the phone’s changes were not applied.'); return Promise.resolve(); }
      var merged = base && cur ? merge(base, mine, cur, [], clashes) : mine;
      if (clashes.length) rep.clashes.push(name + ': changed on both. The computer’s version was kept for ' + clashes.slice(0, 4).join(', ') + (clashes.length > 4 ? ' and ' + (clashes.length - 4) + ' more' : '') + '.');
      if (kind === 's') theirs.settings = merged; else theirs.projects[id] = merged;
      return net('storeSet', [kind, id, merged]);
    }
    if (o.m === 'docSave' || o.m === 'docDelete') {
      var did = o.m === 'docSave' ? a[0].id : a[0], dbase = L.base[o.k], dcur = (theirDocs || []).find(function (d) { return d.id === did; }) || null, dc = [];
      if (o.m === 'docDelete') { if (dcur && dbase && !same(dcur, dbase)) { rep.clashes.push('A document changed on the computer was kept, not deleted.'); return Promise.resolve(); } return net('docDelete', [did]); }
      var dm = dbase && dcur ? merge(dbase, a[0], dcur, [], dc) : a[0];
      if (dc.length) rep.clashes.push((a[0].no || 'A document') + ': changed on both. The computer’s version was kept for ' + dc.slice(0, 4).join(', ') + '.');
      return net('docSave', [dm]);
    }
    if (o.m === 'copyInto') {
      var sent = [];
      return (a[1] || []).reduce(function (c, p) {
        return c.then(function () {
          var mm = /^phone-file:([^/]+)\//.exec(p);
          if (!mm) { sent.push(p); return; }
          return blobGet(mm[1]).then(function (b) {
            if (!b) { rep.failed.push('A file added on the phone was no longer there.'); return; }
            return post('/upload?name=' + encodeURIComponent(b.name), b.blob, 'application/octet-stream', 0).then(unwrap).then(function (sp) { sent.push(sp); o.done = (o.done || []).concat([mm[1]]); });
          });
        });
      }, Promise.resolve()).then(function () { return sent.length ? net('copyInto', [a[0], sent]) : null; }).then(function (r) {
        (o.done || []).forEach(function (id) { blobDel(id); delete PEND[id]; });
        if (r && r.failed && r.failed.length) rep.failed.push(label(o) + ': ' + r.failed.length + ' could not be copied.');
      });
    }
    return net(o.m, a).then(function (r) {
      var f = r && (r.failed || []);
      if (f && f.length) rep.failed.push(label(o) + ': ' + f.map(function (x) { return x.error; }).filter(Boolean).slice(0, 2).join('; '));
    });
  }
  function report(rep) {
    var pg = window.__morfisPage;
    if (!rep.failed.length && !rep.clashes.length) { toast(rep.done + ' change' + (rep.done === 1 ? '' : 's') + ' from this phone ' + (rep.done === 1 ? 'is' : 'are') + ' now on the computer.'); return; }
    if (!pg || !pg.openModal) return;
    var list = function (h, xs) { return xs.length ? '<h3 style="margin-top:6px">' + h + '</h3><ul class="rb-rep">' + xs.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : ''; };
    pg.openModal('<div class="dlg-head"><h2>Changes from this phone</h2></div><p class="muted">' + rep.done + ' sent to the computer.</p>' +
      list('Changed on both', rep.clashes) + list('Could not be done', rep.failed) +
      '<div class="dlg-foot"><button type="button" class="btn primary" data-act="close">OK</button></div>', { label: 'Changes from this phone' });
  }

  /* ----- the connection: live changes, and checking for the computer while offline ----- */
  var subs = { store: [], ai: [] }, es = null, wasOpen = false, probeT = 0, errT = 0;
  function online(on) {
    if (forcedOffline) on = false;
    if (on === ONLINE) return;
    ONLINE = on; status();
    if (!on) { if (es) { es.close(); es = null; } probe(); }
    else { listen(); sync().then(function () { if (!L.outbox.length) fetchTrees(); }); }
  }
  function probe() {
    clearTimeout(probeT);
    probeT = setTimeout(function () {
      if (ONLINE || forcedOffline) return;
      var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, t = ctl ? setTimeout(function () { ctl.abort(); }, 3000) : 0;
      fetch(BASE + '/ping', { cache: 'no-store', credentials: 'omit', signal: ctl ? ctl.signal : undefined }).then(function (r) { clearTimeout(t); return r.json(); }).then(function (j) {
        if (j && j.app === 'studio-morfis' && (!SERVER_ID || !j.id || j.id === SERVER_ID)) online(true); else probe();
      }, function () { clearTimeout(t); probe(); });
    }, 4000);
  }
  function listen() {
    if (es || forcedOffline) return;
    es = new EventSource(BASE + '/events?client=' + CLIENT + (KEY ? '&key=' + KEY : ''));
    es.onopen = function () {
      if (!ONLINE) online(true);
      /* back after a gap: take in everything once, so nothing missed while asleep stays out of date */
      if (wasOpen && !L.outbox.length && window.__morfisPage && window.__morfisPage.applyAll) api.storeLoad().then(function (d) { window.__morfisPage.applyAll(d); if (window.MorfisDocs && window.MorfisDocs.reload) window.MorfisDocs.reload(); }, function () {});
      wasOpen = true;
    };
    /* the connection dropped: give it a few seconds to come back before working offline */
    es.onerror = function () {
      clearTimeout(errT);
      errT = setTimeout(function () { if (!es || es.readyState !== 1) { if (es) { es.close(); es = null; } online(false); } }, es && es.readyState === 2 ? 0 : 5000);
    };
    es.onmessage = function (m) {
      var ev; try { ev = JSON.parse(m.data); } catch (e) { return; }
      if (ev.t === 'ai:pull') { subs.ai.forEach(function (fn) { fn(ev.p); }); return; }
      /* the computer changed a record: the phone's copy follows (unless the phone has its own change waiting) */
      if ((ev.t === 'p' || ev.t === 's') && L.snap && !L.outbox.some(function (o) { return o.k === (ev.t === 's' ? 's:studio' : 'p:' + ev.id); })) {
        if (ev.t === 's') L.snap.settings = clone(ev.value); else if (ev.value === null) delete L.snap.projects[ev.id]; else L.snap.projects[ev.id] = clone(ev.value);
        keep('snap');
      }
      subs.store.forEach(function (fn) { fn(ev); });
    };
  }
  /* the notice at the top: offline, changes waiting, sending */
  function status() {
    var r = document.documentElement, n = L.outbox.length, box = document.querySelector('.rb-off');
    r.classList.toggle('rb-offline', !ONLINE || SYNCING);
    if (box) box.innerHTML = '<i></i>' + (SYNCING ? 'Sending ' + n + ' change' + (n === 1 ? '' : 's') + ' to the computer…' : !ONLINE ? 'Offline' + (n ? ' · ' + n + ' change' + (n === 1 ? '' : 's') + ' saved on this phone' : ' · working from this phone’s copy') : '');
    r.classList.toggle('rb-sync', SYNCING);
  }
  api.onStore = function (fn) { subs.store.push(fn); };
  api.onAiPull = function (fn) { subs.ai.push(fn); };
  api.logout = function () { return post('/logout', '{}').then(function () { unpaired(); }); };
  /* for the tests, and for a "work offline" switch: act as if the computer were away */
  window.__morfisOffline = function (on) { forcedOffline = !!on; if (on) { ONLINE = true; online(false); } else { forcedOffline = false; online(true); } };
  api.offline = function () { return { online: ONLINE, waiting: L.outbox.length, syncing: SYNCING, folders: Object.keys(L.trees).length, roots: Object.keys(L.trees) }; };
  api.syncNow = function () { return sync(); };

  /* ----- downloads to the phone ----- */
  function download(url) {
    if (A && A.download) { A.download(BASE + url); return; }
    var a = document.createElement('a');
    a.href = BASE + url; a.download = ''; a.rel = 'noopener'; a.style.display = 'none';
    document.body.appendChild(a); a.click(); setTimeout(function () { a.remove(); }, 1000);
  }
  api.saveFile = function (filename, bytes) {
    if (!ONLINE) return Promise.reject(new Error('Saving a file needs the computer. It works again when the phone reaches it.'));
    return post('/download?name=' + encodeURIComponent(filename), bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), 'application/octet-stream').then(unwrap).then(function (url) { download(url); return filename; });
  };
  api.savePdf = function (html, filename) { return api.pdfFile(html, filename).then(function (url) { download(url); return filename; }); };
  /* printing goes through the phone: the PDF opens in its viewer, which can print or share it */
  api.printHtml = function (html) { return api.printFile(html).then(function (url) { download(url); return { ok: true }; }); };

  /* ----- opening things: files open on the phone, folders on the computer ----- */
  api.openPath = function (p) {
    if (!ONLINE) return Promise.reject(new Error('Opening a file needs the computer: only the names are kept on the phone.'));
    return net('isDir', [p]).then(function (dir) {
      if (dir) return net('openPath', [p]);
      return net('preview', [p]).then(function (r) { download(r.url + '?dl=1'); return true; });
    });
  };
  api.openPathDirect = api.openPath;
  api.openExternal = function (url) {
    if (!/^(https:|mailto:)/i.test(url)) return Promise.reject(new Error('Only web and email links open from here.'));
    if (A && A.openExternal) A.openExternal(url); else window.open(url, '_blank', 'noopener');
    return Promise.resolve(true);
  };

  /* ----- choosing files on the phone: uploaded now, or kept on the phone until the computer answers ----- */
  api.pickFiles = function (o) {
    o = o || {};
    return new Promise(function (resolve, reject) {
      var inp = document.createElement('input'), done = false;
      inp.type = 'file'; inp.multiple = true; inp.style.display = 'none';
      var ext = []; (o.filters || []).forEach(function (f) { (f.extensions || []).forEach(function (e) { if (e !== '*') ext.push('.' + e); }); });
      if (ext.length) inp.accept = ext.join(',');
      var keepHere = function (list) {
        var out = [];
        return list.reduce(function (c, f) { return c.then(function () { var id = Math.random().toString(36).slice(2, 12); PEND[id] = f.size; return blobPut(id, f).then(function () { out.push('phone-file:' + id + '/' + f.name); }); }); }, Promise.resolve()).then(function () { return out; });
      };
      var finish = function (files) {
        if (done) return; done = true; inp.remove();
        if (!files || !files.length) { resolve([]); return; }
        var list = Array.prototype.slice.call(files), out = [];
        if (!ONLINE || L.outbox.length) { keepHere(list).then(resolve, reject); toast('Kept on this phone. They go to the computer when it answers.'); return; }
        toast('Uploading ' + list.length + ' file' + (list.length === 1 ? '' : 's') + '…');
        list.reduce(function (c, f) {
          return c.then(function () { return post('/upload?name=' + encodeURIComponent(f.name), f, 'application/octet-stream').then(unwrap).then(function (p) { out.push(p); }); });
        }, Promise.resolve()).then(function () { resolve(out); }, function (e) { if (isNet(e)) keepHere(list).then(resolve, reject); else reject(e); });
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
    if (!ONLINE) return Promise.reject(new Error('Choosing a folder needs the computer.'));
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
  api.onFocus = function (fn) { document.addEventListener('visibilitychange', function () { if (!document.hidden) { fn(); if (!ONLINE) probe(); } }); };
  api.onZoom = function () {};
  api.onWin = function () {};

  var start = function () { status(); ready.then(function () { status(); listen(); if (L.outbox.length) sync(); }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  /* keep what is waiting when the app is closed */
  document.addEventListener('visibilitychange', function () { if (document.hidden) flush(); });
  window.addEventListener('pagehide', flush);

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(t) { var pg = window.__morfisPage; if (pg && pg.toast) pg.toast(t); }
  window.morfisDesktop = api;
})();
