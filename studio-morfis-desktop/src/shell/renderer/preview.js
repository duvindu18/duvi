/* Built-in preview, in the spirit of Quick Look: press Space or click a file to look at it without leaving the app.
   Images (zoom, pan, rotate), PDF (Chromium's viewer), video and audio, text and code, CSV as a table, JSON tidied,
   Word documents rendered as a page. Anything else shows the large thumbnail Windows itself makes for it (drawings,
   models, Office files, Photoshop, HEIC…) with a button to open it in its own program. */
(function () {
  'use strict';
  var M = window.Morfis, A = window.MorfisArt;
  if (!M || !A) return;
  var H = M.H, esc = M.esc, ic = M.ic;

  var KIND = {};
  'jpg jpeg png gif webp bmp svg avif ico'.split(' ').forEach(function (e) { KIND[e] = 'image'; });
  'mp4 m4v webm mov ogv'.split(' ').forEach(function (e) { KIND[e] = 'video'; });
  'mp3 wav ogg oga m4a aac flac opus'.split(' ').forEach(function (e) { KIND[e] = 'audio'; });
  'txt md markdown log ini cfg conf env yml yaml toml xml html htm css js mjs ts json csv tsv bat cmd ps1 py rb php sql lsp scr gitignore rtf'.split(' ').forEach(function (e) { KIND[e] = 'text'; });
  KIND.pdf = 'pdf'; KIND.docx = 'docx';
  var extOf = function (p) { var m = /\.([^.\\/]+)$/.exec(String(p || '')); return m ? m[1].toLowerCase() : ''; };
  var baseOf = function (p) { return String(p || '').split(/[\\/]/).pop(); };
  var kindOf = function (p) { return KIND[extOf(p)] || 'other'; };
  /* files the dashboard would otherwise hand to another program: these open here first */
  function handles(p) { return !!KIND[extOf(p)]; }

  var V = { list: [], i: 0, el: null, z: 1, fit: true, rot: 0, x: 0, y: 0, info: null, token: 0 };

  function fmtBytes(n) { n = +n || 0; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB'; if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'; return (n / 1073741824).toFixed(1) + ' GB'; }
  function shell() {
    if (V.el) return V.el;
    var el = document.createElement('div');
    el.className = 'pv'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.tabIndex = -1;
    el.innerHTML = '<div class="pv-bar"><div class="pv-file" id="pvFile"></div><div class="pv-nav" id="pvNav"></div><div class="pv-tools" id="pvTools"></div>' +
      '<button type="button" class="pv-btn" data-pv="open" title="Open in its own program (Enter)">' + ic('ext', 15) + '<span>Open</span></button>' +
      '<button type="button" class="pv-btn icon" data-pv="reveal" title="Show in File Explorer">' + ic('files', 16) + '</button>' +
      '<button type="button" class="pv-btn icon" data-pv="copy" title="Copy the path">' + ic('copy', 16) + '</button>' +
      '<button type="button" class="pv-btn icon" data-pv="close" title="Close (Esc)">' + ic('x', 17) + '</button></div>' +
      '<div class="pv-stage" id="pvStage"></div>' +
      '<button type="button" class="pv-arrow prev" data-pv="prev" title="Previous (←)">' + ic('back', 20) + '</button><button type="button" class="pv-arrow next" data-pv="next" title="Next (→)">' + ic('chevR', 20) + '</button>';
    document.body.appendChild(el);
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-pv]');
      if (b) { act(b.dataset.pv); return; }
      if (e.target.id === 'pvStage') close();
    });
    V.el = el;
    return el;
  }
  function act(a) {
    var p = V.list[V.i];
    if (a === 'close') close();
    else if (a === 'prev') go(-1);
    else if (a === 'next') go(1);
    else if (a === 'open') (H.openPathDirect || H.openPath)(p).catch(function () { M.toast('Windows has no program for this file type.'); });
    else if (a === 'reveal') H.reveal(p).catch(function () { M.toast('That file is no longer there.'); });
    else if (a === 'copy') navigator.clipboard.writeText(p).then(function () { M.toast('Path copied.'); });
    else if (a === 'zin') zoom(1.25);
    else if (a === 'zout') zoom(0.8);
    else if (a === 'fit') { V.fit = true; V.z = 1; V.x = V.y = 0; place(); }
    else if (a === 'one') { V.fit = false; V.z = 1; V.x = V.y = 0; place(); }
    else if (a === 'rot') { V.rot = (V.rot + 90) % 360; place(); }
  }

  function open(path, list) {
    var l = (list && list.length ? list : [path]).filter(Boolean);
    V.list = l; V.i = Math.max(0, l.indexOf(path));
    var el = shell();
    el.hidden = false;
    document.documentElement.classList.add('pv-open');
    show();
    el.focus();
  }
  function close() {
    if (!V.el || V.el.hidden) return;
    V.token++;
    var st = document.getElementById('pvStage'); if (st) st.innerHTML = '';
    V.el.hidden = true;
    document.documentElement.classList.remove('pv-open');
  }
  function go(d) { if (V.list.length < 2) return; V.i = (V.i + d + V.list.length) % V.list.length; show(); }

  function show() {
    var p = V.list[V.i], k = kindOf(p), tok = ++V.token, stage = document.getElementById('pvStage');
    V.z = 1; V.fit = true; V.rot = 0; V.x = V.y = 0;
    document.getElementById('pvFile').innerHTML = A.fileIcon(p, 28) + '<div><b title="' + esc(p) + '">' + esc(baseOf(p)) + '</b><span id="pvMeta" class="pv-meta"></span></div>';
    document.getElementById('pvNav').innerHTML = V.list.length > 1 ? '<span>' + (V.i + 1) + ' of ' + V.list.length + '</span>' : '';
    V.el.classList.toggle('multi', V.list.length > 1);
    document.getElementById('pvTools').innerHTML = k === 'image' ? '<button type="button" class="pv-btn icon" data-pv="zout" title="Zoom out (−)">−</button><span class="pv-z" id="pvZ">Fit</span><button type="button" class="pv-btn icon" data-pv="zin" title="Zoom in (+)">+</button>' +
      '<button type="button" class="pv-btn" data-pv="fit" title="Fit (0)">Fit</button><button type="button" class="pv-btn" data-pv="one" title="Actual size (1)">100%</button><button type="button" class="pv-btn icon" data-pv="rot" title="Rotate (R)">' + ic('refresh', 15) + '</button>' : '';
    stage.className = 'pv-stage pv-' + k;
    stage.innerHTML = '<div class="pv-wait"><i class="spin"></i>Opening…</div>';
    H.preview(p).then(function (info) {
      if (tok !== V.token) return;
      V.info = info;
      document.getElementById('pvMeta').textContent = [fmtBytes(info.size), new Date(info.mtimeMs).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }), baseOf(info.dir)].join('  ·  ');
      RENDER[k](stage, info, tok);
    }, function (e) { if (tok === V.token) stage.innerHTML = '<div class="pv-none">' + A.fileIcon(p, 64) + '<b>This file is no longer there</b><span>' + esc(e && e.message ? e.message : '') + '</span></div>'; });
  }

  /* ----- renderers ----- */
  var RENDER = {
    image: function (stage, info, tok) {
      var img = new Image();
      img.className = 'pv-img'; img.alt = ''; img.draggable = false;
      img.onload = function () { if (tok !== V.token) return; stage.innerHTML = ''; stage.appendChild(img); place(); };
      img.onerror = function () { if (tok === V.token) RENDER.other(stage, info, tok); };
      img.src = info.url;
    },
    pdf: function (stage, info) { stage.innerHTML = '<iframe class="pv-frame" src="' + esc(info.url) + '#view=FitH" title="' + esc(info.name) + '"></iframe>'; },
    video: function (stage, info) { stage.innerHTML = '<video class="pv-media" src="' + esc(info.url) + '" controls autoplay></video>'; },
    audio: function (stage, info) { stage.innerHTML = '<div class="pv-none">' + A.fileIcon(info.name, 84) + '<b>' + esc(info.name) + '</b><audio src="' + esc(info.url) + '" controls autoplay></audio></div>'; },
    text: function (stage, info, tok) {
      H.readText(V.list[V.i], 2097152).then(function (r) {
        if (tok !== V.token) return;
        var ext = info.ext, t = r.text, body;
        if (/\u0000/.test(t.slice(0, 2000))) { RENDER.other(stage, info, tok); return; }
        if (ext === 'json') { try { t = JSON.stringify(JSON.parse(t), null, 2); } catch (e) { /* keep as written */ } }
        if (ext === 'csv' || ext === 'tsv') body = table(t, ext === 'tsv' ? '\t' : null);
        else {
          var lines = t.split(/\r?\n/), w = String(lines.length).length;
          body = '<pre class="pv-pre' + (ext === 'md' || ext === 'txt' || ext === 'log' ? ' wrap' : '') + '">' + lines.slice(0, 20000).map(function (l, i) { return '<span class="ln" style="--w:' + w + 'ch">' + (i + 1) + '</span>' + esc(l); }).join('\n') + '</pre>';
        }
        stage.innerHTML = '<div class="pv-textwrap">' + (r.cut ? '<div class="pv-cut">Showing the first 2 MB of ' + fmtBytes(r.size) + '.</div>' : '') + body + '</div>';
      }, function () { if (tok === V.token) RENDER.other(stage, info, tok); });
    },
    docx: function (stage, info, tok) {
      loadMammoth().then(function () { return fetch(info.url).then(function (r) { return r.arrayBuffer(); }); })
        .then(function (buf) { return window.mammoth.convertToHtml({ arrayBuffer: buf }); })
        .then(function (res) {
          if (tok !== V.token) return;
          /* the converted document is shown in a sandboxed frame with scripts off */
          var html = '<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#E9E9EE;font:15px/1.6 Calibri,"Segoe UI",system-ui,sans-serif;color:#1d1d24}.page{max-width:794px;margin:28px auto;background:#fff;padding:72px 80px;box-shadow:0 1px 3px rgba(0,0,0,.15),0 14px 40px -16px rgba(0,0,0,.35);min-height:1000px}img{max-width:100%;height:auto}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:4px 8px;vertical-align:top}h1,h2,h3{line-height:1.25}</style><div class="page">' + res.value + '</div>';
          stage.innerHTML = '<iframe class="pv-frame" sandbox="" title="' + esc(info.name) + '"></iframe>';
          stage.querySelector('iframe').srcdoc = html;
        }, function () { if (tok === V.token) RENDER.other(stage, info, tok); });
    },
    other: function (stage, info, tok) {
      var p = V.list[V.i];
      H.thumb(p, 1024).then(function (u) {
        if (tok !== V.token) return;
        var name = esc(extOf(p).toUpperCase() || 'this');
        stage.className = 'pv-stage pv-other';
        stage.innerHTML = '<div class="pv-none">' + (u ? '<img class="pv-thumb" src="' + u + '" alt="">' : A.fileIcon(p, 84)) +
          '<b>' + esc(info.name) + '</b><span>' + (u ? 'The picture Windows makes for ' + name + ' files.' : 'No built-in preview for ' + name + ' files.') + ' Open it in its own program to work on it.</span>' +
          '<button type="button" class="btn primary" data-pv="open">' + ic('ext', 15) + 'Open ' + name + ' file</button></div>';
      });
    }
  };
  function table(text, sep) {
    var rows = [], cell = '', row = [], q = false, i, c, d = sep || (text.split('\n')[0].split(';').length > text.split('\n')[0].split(',').length ? ';' : ',');
    for (i = 0; i < text.length && rows.length < 1000; i++) {
      c = text[i];
      if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
      else if (c === '"') q = true;
      else if (c === d) { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    if (!rows.length) return '<pre class="pv-pre">(empty)</pre>';
    return '<div class="pv-tablewrap"><table class="pv-table"><thead><tr><th></th>' + rows[0].map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.slice(1).map(function (r, n) { return '<tr><td class="ln">' + (n + 1) + '</td>' + r.map(function (x) { return '<td>' + esc(x) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>' +
      (rows.length >= 1000 ? '<div class="pv-cut">Showing the first 1,000 rows.</div>' : '') + '</div>';
  }
  var mammothP = null;
  function loadMammoth() {
    if (window.mammoth) return Promise.resolve();
    if (mammothP) return mammothP;
    mammothP = new Promise(function (res, rej) { var s = document.createElement('script'); s.src = 'vendor/mammoth/mammoth.browser.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    return mammothP;
  }

  /* ----- image zoom and pan ----- */
  function place() {
    var img = V.el && V.el.querySelector('.pv-img'), st = document.getElementById('pvStage');
    if (!img || !st) return;
    var sw = st.clientWidth - 48, sh = st.clientHeight - 48, side = V.rot % 180 !== 0;
    var nw = side ? img.naturalHeight : img.naturalWidth, nh = side ? img.naturalWidth : img.naturalHeight;
    var fitK = Math.min(1, sw / nw, sh / nh), k = V.fit ? fitK * V.z : V.z;
    img.style.width = img.naturalWidth * k + 'px'; img.style.height = img.naturalHeight * k + 'px';
    img.style.transform = 'translate(-50%,-50%) translate(' + V.x + 'px,' + V.y + 'px) rotate(' + V.rot + 'deg)';
    var z = document.getElementById('pvZ'); if (z) z.textContent = Math.round(k * 100) + '%';
    st.classList.toggle('pannable', k > fitK + 0.001);
  }
  function zoom(f, cx, cy) {
    var img = V.el.querySelector('.pv-img'), st = document.getElementById('pvStage');
    if (!img) return;
    var before = img.getBoundingClientRect();
    if (V.fit) { V.z = V.z * f; } else V.z = V.z * f;
    V.z = Math.max(0.05, Math.min(16, V.z));
    place();
    if (cx != null) {
      var after = img.getBoundingClientRect(), r = st.getBoundingClientRect();
      var px = (cx - before.left) / before.width, py = (cy - before.top) / before.height;
      V.x -= (after.left + px * after.width) - cx; V.y -= (after.top + py * after.height) - cy;
      place();
    }
  }
  document.addEventListener('wheel', function (e) {
    if (!V.el || V.el.hidden || !e.target.closest || !e.target.closest('.pv-image')) return;
    e.preventDefault();
    zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
  }, { passive: false });
  var drag = null;
  document.addEventListener('mousedown', function (e) { if (V.el && !V.el.hidden && e.target.classList && e.target.classList.contains('pv-img')) { drag = { x: e.clientX - V.x, y: e.clientY - V.y }; e.preventDefault(); } });
  document.addEventListener('mousemove', function (e) { if (drag) { V.x = e.clientX - drag.x; V.y = e.clientY - drag.y; place(); } });
  document.addEventListener('mouseup', function () { drag = null; });
  document.addEventListener('dblclick', function (e) { if (V.el && !V.el.hidden && e.target.classList && e.target.classList.contains('pv-img')) { if (V.fit && V.z === 1) act('one'); else act('fit'); } });
  window.addEventListener('resize', function () { if (V.el && !V.el.hidden) place(); });
  document.addEventListener('keydown', function (e) {
    if (!V.el || V.el.hidden) return;
    var k = e.key;
    if (k === 'Escape' || (k === ' ' && !/^(INPUT|TEXTAREA|VIDEO|AUDIO)$/.test(e.target.tagName))) { e.preventDefault(); e.stopPropagation(); close(); }
    else if (k === 'ArrowLeft' || k === 'ArrowUp') { e.preventDefault(); go(-1); }
    else if (k === 'ArrowRight' || k === 'ArrowDown') { e.preventDefault(); go(1); }
    else if (k === 'Enter') { e.preventDefault(); act('open'); }
    else if (kindOf(V.list[V.i]) === 'image') {
      if (k === '+' || k === '=') act('zin'); else if (k === '-') act('zout'); else if (k === '0') act('fit'); else if (k === '1') act('one'); else if (k === 'r' || k === 'R') act('rot');
    }
  }, true);

  /* the dashboard's own file lists (project page folders) open previewable files here too */
  if (H.openPath && !H.openPathDirect) {
    var direct = H.openPath;
    H.openPathDirect = direct;
    H.openPath = function (p) { if (handles(p)) { open(p, siblings(p)); return Promise.resolve(true); } return direct(p); };
  }
  /* the other files in the same list on screen, so arrows move through them */
  function siblings(p) {
    var dir = String(p).replace(/[\\/][^\\/]*$/, ''), out = [];
    document.querySelectorAll('#overlay [data-fm-row][data-name]').forEach(function (r) { if (!r.classList.contains('is-dir')) out.push(dir + (dir.indexOf('\\') !== -1 ? '\\' : '/') + r.dataset.name); });
    return out.indexOf(p) !== -1 ? out : [p];
  }

  window.MorfisPreview = { open: open, close: close, handles: handles, kindOf: kindOf, isOpen: function () { return !!(V.el && !V.el.hidden); } };
})();
