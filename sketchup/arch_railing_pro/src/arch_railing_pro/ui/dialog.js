/* ArchRailing Pro - panel logic (Parametric Builder look). Plain ES5 for every SketchUp HtmlDialog. */
(function () {
  'use strict';

  var SU = window.sketchup || {
    // Browser stand-in so the page can be opened and checked outside SketchUp.
    ready: function () {}, create: function () {}, update: function () {}, live: function () {},
    repath: function () {}, refresh_defs: function () {}, save_user_preset: function () {},
    delete_user_preset: function () {}, remember: function () {}, undo: function () {}, close: function () {}
  };

  var state = {
    p: {}, presets: [], user: [], defs: [], cat: 'All', presetId: null,
    sel: { railings: 0, edges: 0 }, tab: 'layout', units: 'mm',
    yaw: -38, pitch: 26, zoom: 1, edges: true, xray: false, spin: false
  };

  function $(id) { return document.getElementById(id); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function each(list, fn) { [].forEach.call(list, fn); }
  function store(k, v) { try { if (v === undefined) return window.localStorage.getItem(k); window.localStorage.setItem(k, v); } catch (e) { return null; } return null; }

  // ------------------------------------------------------------------
  // Icons (24px grid line icons)
  // ------------------------------------------------------------------
  var IC = {
    All: '<rect x="3.5" y="3.5" width="6" height="6" rx="1"/><rect x="14.5" y="3.5" width="6" height="6" rx="1"/><rect x="3.5" y="14.5" width="6" height="6" rx="1"/><rect x="14.5" y="14.5" width="6" height="6" rx="1"/>',
    Glass: '<path d="M3 5h18"/><rect x="4" y="7" width="16" height="13" rx="1"/><path d="M8 16l4-4M11 17.5l5-5"/>',
    Metal: '<path d="M3 6h18M3 13h18M6 6v14M18 6v14"/>',
    Cable: '<path d="M3 5h18M5 5v15M19 5v15M5 9h14M5 12h14M5 15h14"/>',
    Balusters: '<path d="M3 5h18M3 19h18M6 5v14M10 5v14M14 5v14M18 5v14"/>',
    Wood: '<path d="M6 20V7l1.5-2L9 7v13M15 20V7l1.5-2L18 7v13M4 11h16M4 16h16"/>',
    Panel: '<path d="M3 5h18"/><rect x="4" y="7" width="16" height="13" rx="1"/><path d="M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01"/>',
    Saved: '<path d="M7 4h10v16l-5-4-5 4z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'
  };
  function icon(name) { return '<svg class="i" viewBox="0 0 24 24" aria-hidden="true">' + (IC[name] || IC.All) + '</svg>'; }
  var CHECK = '<path d="M5 12.5l4.5 4.5L19 7.5"/>';
  var WARN = '<path d="M12 4L2.5 20h19z"/><path d="M12 10v4.5M12 17.5v.01"/>';
  var NOTE = '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>';

  // ------------------------------------------------------------------
  // Parameter form: [min, max, step] ranges drive the sliders
  // ------------------------------------------------------------------
  var PROFILE = [['rect', 'Rectangular'], ['round', 'Round']];
  function isRect(k) { return function (p) { return p[k] === 'rect'; }; }
  function on(k) { return function (p) { return !!p[k]; }; }
  function inf() { var a = arguments; return function (p) { for (var i = 0; i < a.length; i++) if (p.infill_type === a[i]) return true; return false; }; }
  function all() { var f = arguments; return function (p) { for (var i = 0; i < f.length; i++) if (!f[i](p)) return false; return true; }; }
  function not(fn) { return function (p) { return !fn(p); }; }

  var TABS = [
    { id: 'layout', label: 'Layout', items: [
      { g: 'Size' },
      { k: 'height', l: 'Height', t: 'num', len: 1, r: [300, 2500, 10] },
      { k: 'post_spacing', l: 'Post spacing', t: 'num', len: 1, r: [300, 3000, 10] },
      { k: 'spacing_mode', l: 'Spacing', t: 'seg', o: [['fit', 'Fit to length'], ['fixed', 'Fixed from start']] },
      { k: 'spacing_metric', l: 'Measured', t: 'seg', o: [['3d', 'Along slope'], ['plan', 'In plan']] },
      { g: 'Offset from path' },
      { k: 'offset_h', l: 'Sideways, + left', t: 'num', len: 1, r: [-500, 500, 5] },
      { k: 'offset_v', l: 'Up', t: 'num', len: 1, r: [-500, 500, 5] },
      { g: 'Corners and slopes' },
      { k: 'corner_angle', l: 'Corner post at turn', t: 'num', u: '°', r: [1, 90, 1] },
      { k: 'slope_break', l: 'Post at slope change', t: 'num', u: '°', r: [0.5, 30, 0.5] }
    ] },
    { id: 'posts', label: 'Posts', items: [
      { g: 'Which posts' },
      { k: 'show_start_post', l: 'Start', t: 'bool' },
      { k: 'show_end_post', l: 'End', t: 'bool' },
      { k: 'show_corner_posts', l: 'Corners', t: 'bool' },
      { k: 'show_mid_posts', l: 'Intermediate', t: 'bool' },
      { g: 'Post' },
      { k: 'post_profile', l: 'Profile', t: 'seg', o: PROFILE },
      { k: 'post_width', l: 'Width', t: 'num', len: 1, r: [10, 200, 1] },
      { k: 'post_depth', l: 'Depth', t: 'num', len: 1, r: [5, 200, 1], 'if': isRect('post_profile') },
      { k: 'base_plate', l: 'Base plate', t: 'bool' },
      { k: 'post_component', l: 'Post component', t: 'comp' }
    ] },
    { id: 'rails', label: 'Rails', items: [
      { g: 'Top rail' },
      { k: 'top_rail', l: 'Top rail', t: 'bool' },
      { k: 'top_rail_profile', l: 'Profile', t: 'seg', o: PROFILE, 'if': on('top_rail') },
      { k: 'top_rail_width', l: 'Width', t: 'num', len: 1, r: [10, 250, 1], 'if': on('top_rail') },
      { k: 'top_rail_height', l: 'Height', t: 'num', len: 1, r: [5, 150, 1], 'if': all(on('top_rail'), isRect('top_rail_profile')) },
      { k: 'top_rail_overhang', l: 'End overhang', t: 'num', len: 1, r: [0, 500, 5], 'if': function (p) { return p.top_rail || p.handrail2; } },
      { g: 'Bottom rail' },
      { k: 'bottom_rail', l: 'Bottom rail', t: 'bool' },
      { k: 'bottom_rail_profile', l: 'Profile', t: 'seg', o: PROFILE, 'if': on('bottom_rail') },
      { k: 'bottom_rail_width', l: 'Width', t: 'num', len: 1, r: [5, 200, 1], 'if': on('bottom_rail') },
      { k: 'bottom_rail_height', l: 'Height', t: 'num', len: 1, r: [5, 200, 1], 'if': all(on('bottom_rail'), isRect('bottom_rail_profile')) },
      { k: 'bottom_rail_elev', l: 'Above path', t: 'num', len: 1, r: [-200, 600, 5], 'if': on('bottom_rail') },
      { g: 'Handrail on brackets' },
      { k: 'handrail2', l: 'Handrail on brackets', t: 'bool' },
      { k: 'handrail2_elev', l: 'Height to centre', t: 'num', len: 1, r: [300, 1500, 10], 'if': on('handrail2') },
      { k: 'handrail2_diameter', l: 'Diameter', t: 'num', len: 1, r: [20, 80, 1], 'if': on('handrail2') },
      { k: 'handrail2_offset', l: 'Sideways, + left', t: 'num', len: 1, r: [-200, 200, 5], 'if': on('handrail2') },
      { k: 'bracket_size', l: 'Bracket', t: 'num', len: 1, r: [5, 40, 1], 'if': on('handrail2') }
    ] },
    { id: 'infill', label: 'Infill', items: [
      { k: 'infill_type', l: 'Infill', t: 'seg', o: [['none', 'None'], ['balusters', 'Bars'], ['glass', 'Glass'], ['panel', 'Panel'], ['horizontal', 'Horiz.']] },
      { k: 'infill_bottom', l: 'Bottom above path', t: 'num', len: 1, r: [-300, 600, 5], 'if': function (p) { return p.infill_type !== 'none' && !p.bottom_rail; } },
      { k: 'infill_top_gap', l: 'Gap below top', t: 'num', len: 1, r: [0, 300, 5], 'if': function (p) { return p.infill_type !== 'none'; } },
      { g: 'Balusters', 'if': inf('balusters') },
      { k: 'baluster_profile', l: 'Profile', t: 'seg', o: PROFILE, 'if': inf('balusters') },
      { k: 'baluster_width', l: 'Width', t: 'num', len: 1, r: [5, 200, 1], 'if': inf('balusters') },
      { k: 'baluster_depth', l: 'Depth', t: 'num', len: 1, r: [5, 200, 1], 'if': all(inf('balusters'), isRect('baluster_profile')) },
      { k: 'baluster_spacing', l: 'Max spacing, c/c', t: 'num', len: 1, r: [20, 400, 5], 'if': inf('balusters') },
      { k: 'baluster_component', l: 'Baluster component', t: 'comp', 'if': inf('balusters') },
      { g: 'Panels', 'if': inf('glass', 'panel') },
      { k: 'glass_thickness', l: 'Thickness', t: 'num', len: 1, r: [3, 200, 0.5], 'if': inf('glass', 'panel') },
      { k: 'glass_gap', l: 'Gap to post', t: 'num', len: 1, r: [0, 100, 1], 'if': inf('glass', 'panel') },
      { k: 'glass_offset', l: 'Sideways, + left', t: 'num', len: 1, r: [-200, 200, 1], 'if': inf('glass', 'panel') },
      { k: 'show_clamps', l: 'Glass clamps', t: 'bool', 'if': inf('glass') },
      { k: 'clamp_width', l: 'Clamp width', t: 'num', len: 1, r: [10, 150, 1], 'if': all(inf('glass'), on('show_clamps')) },
      { k: 'clamp_height', l: 'Clamp height', t: 'num', len: 1, r: [10, 150, 1], 'if': all(inf('glass'), on('show_clamps')) },
      { k: 'clamp_depth', l: 'Clamp depth', t: 'num', len: 1, r: [5, 100, 1], 'if': all(inf('glass'), on('show_clamps')) },
      { k: 'clamp_inset', l: 'Clamp inset', t: 'num', len: 1, r: [0, 600, 5], 'if': all(inf('glass'), on('show_clamps')) },
      { k: 'clamp_component', l: 'Clamp component', t: 'comp', 'if': all(inf('glass'), on('show_clamps')) },
      { g: 'Horizontal rails', 'if': inf('horizontal') },
      { k: 'hrail_profile', l: 'Profile', t: 'seg', o: [['round', 'Round / cable'], ['rect', 'Board / flat bar']], 'if': inf('horizontal') },
      { k: 'hrail_count', l: 'Count', t: 'num', r: [1, 20, 1], 'if': inf('horizontal') },
      { k: 'hrail_width', l: 'Thickness', t: 'num', len: 1, r: [2, 80, 1], 'if': inf('horizontal') },
      { k: 'hrail_height', l: 'Board height', t: 'num', len: 1, r: [2, 200, 1], 'if': all(inf('horizontal'), isRect('hrail_profile')) }
    ] },
    { id: 'finish', label: 'Finish', items: [
      { g: 'Colours' },
      { k: 'post_color', l: 'Posts', t: 'color' },
      { k: 'rail_color', l: 'Rails', t: 'color' },
      { k: 'infill_color', l: 'Infill', t: 'color' },
      { k: 'hardware_color', l: 'Hardware', t: 'color' },
      { k: 'glass_color', l: 'Glass', t: 'color' },
      { g: 'Transparency' },
      { k: 'glass_opacity', l: 'Glass opacity', t: 'num', r: [0.05, 1, 0.05] },
      { k: 'panel_opacity', l: 'Panel opacity', t: 'num', r: [0.05, 1, 0.05] },
      { g: 'Quality' },
      { k: 'round_segments', l: 'Round segments', t: 'num', u: 'sides', r: [6, 48, 2] }
    ] }
  ];

  var FIELDS = {};
  TABS.forEach(function (t) { t.items.forEach(function (it) { if (it.k) FIELDS[it.k] = it; }); });

  // Length values are stored in mm; the panel can show inches.
  function shown(f, v) {
    if (f.len && state.units === 'in') return Math.round(v / 25.4 * 100) / 100;
    var s = f.r ? f.r[2] : 1;
    return s < 1 ? Math.round(v * 100) / 100 : Math.round(v * 10) / 10;
  }
  function stored(f, v) { return f.len && state.units === 'in' ? v * 25.4 : v; }
  function unitOf(f) { return f.len ? state.units : (f.u || ''); }

  function itemHtml(f) {
    var id = 'f-' + f.k;
    if (f.t === 'num') {
      return '<div class="row" data-f="' + f.k + '"><div class="top"><label class="eyebrow" for="' + id + '-n">' + esc(f.l) + '</label>' +
        '<span class="val"><input id="' + id + '-n" type="number" step="any" inputmode="decimal"><i data-unit="' + f.k + '"></i></span></div>' +
        '<span class="sl"><span class="tr"></span><span class="fi"></span><span class="th"></span>' +
        '<input id="' + id + '" type="range" min="' + f.r[0] + '" max="' + f.r[1] + '" step="' + f.r[2] + '" aria-label="' + esc(f.l) + '"></span></div>';
    }
    if (f.t === 'bool') return '<button type="button" class="sw" role="switch" id="' + id + '" data-f="' + f.k + '" aria-checked="false"><span class="k" aria-hidden="true"></span>' + esc(f.l) + '</button>';
    if (f.t === 'seg') {
      return '<div class="field" data-f="' + f.k + '"><span class="eyebrow">' + esc(f.l) + '</span><div class="seg" role="group" aria-label="' + esc(f.l) + '" id="' + id + '">' +
        f.o.map(function (o) { return '<button type="button" data-v="' + o[0] + '" aria-pressed="false">' + esc(o[1]) + '</button>'; }).join('') + '</div></div>';
    }
    if (f.t === 'color') {
      return '<div class="swc" data-f="' + f.k + '"><label title="' + esc(f.l) + '"><span id="' + id + '-s"></span><input type="color" id="' + id + '" aria-label="' + esc(f.l) + ' colour"></label>' + esc(f.l) + '</div>';
    }
    return '<label class="field" data-f="' + f.k + '"><span class="eyebrow">' + esc(f.l) + '</span><select id="' + id + '" data-comp="1"></select></label>';
  }

  // Consecutive switches and colour swatches share one wrapping row.
  function paneHtml(t) {
    var out = '', group = null, buf = [];
    function flush() {
      if (!buf.length) return;
      out += group === 'bool' ? '<div class="opts">' + buf.join('') + '</div>' : group === 'color' ? '<div class="sws">' + buf.join('') + '</div>' : buf.join('');
      buf = [];
    }
    out += '<div class="rows">';
    t.items.forEach(function (it, i) {
      if (it.g) { flush(); group = null; out += '</div><p class="eyebrow grp" data-g="' + t.id + i + '">' + esc(it.g) + '</p><div class="rows">'; return; }
      var kind = it.t === 'bool' || it.t === 'color' ? it.t : 'other';
      if (kind !== group) { flush(); group = kind; }
      buf.push(itemHtml(it));
    });
    flush();
    return out + '</div>';
  }

  function buildForm() {
    $('tabs').innerHTML = TABS.map(function (t) {
      return '<button type="button" role="tab" data-tab="' + t.id + '" aria-selected="' + (t.id === state.tab) + '">' + t.label + '</button>';
    }).join('');
    $('pane').innerHTML = TABS.map(function (t) {
      return '<div data-pane="' + t.id + '"' + (t.id === state.tab ? '' : ' class="hide"') + '>' + paneHtml(t) + '</div>';
    }).join('');

    $('tabs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-tab]');
      if (!b) return;
      state.tab = b.getAttribute('data-tab');
      if (state.tab === 'posts' || state.tab === 'infill') SU.refresh_defs();
      each($('tabs').children, function (x) { x.setAttribute('aria-selected', x === b); });
      each($('pane').children, function (x) { x.classList.toggle('hide', x.getAttribute('data-pane') !== state.tab); });
      $('pane').scrollTop = 0;
    });

    Object.keys(FIELDS).forEach(function (k) {
      var f = FIELDS[k], el = $('f-' + k);
      if (f.t === 'num') {
        el.addEventListener('input', function () { set(k, stored(f, parseFloat(el.value))); });
        var n = $('f-' + k + '-n');
        n.addEventListener('change', function () { var v = parseFloat(n.value); if (!isNaN(v)) set(k, stored(f, v)); else syncForm(); });
        n.addEventListener('keydown', function (e) { if (e.key === 'Enter') n.blur(); });
      } else if (f.t === 'bool') {
        el.addEventListener('click', function () { set(k, !state.p[k]); });
      } else if (f.t === 'seg') {
        el.addEventListener('click', function (e) { var b = e.target.closest('[data-v]'); if (b) set(k, b.getAttribute('data-v')); });
      } else if (f.t === 'color') {
        el.addEventListener('input', function () { set(k, el.value); });
      } else {
        el.addEventListener('change', function () { set(k, el.value); });
      }
    });
  }

  function fillComponents() {
    var opts = '<option value="">Built-in geometry</option>' + state.defs.map(function (d) {
      return '<option value="' + esc(d) + '">' + esc(d) + '</option>';
    }).join('');
    each(document.querySelectorAll('[data-comp]'), function (s) { s.innerHTML = opts; });
  }

  function syncForm() {
    var p = state.p;
    Object.keys(FIELDS).forEach(function (k) {
      var f = FIELDS[k], el = $('f-' + k), v = p[k];
      if (!el || v === undefined) return;
      if (f.t === 'num') {
        var lo = f.r[0], hi = f.r[1];
        el.value = clamp(v, lo, hi);
        var pct = (clamp(v, lo, hi) - lo) / (hi - lo) * 100;
        var sl = el.parentNode;
        sl.querySelector('.fi').style.width = pct + '%';
        sl.querySelector('.th').style.left = pct + '%';
        var n = $('f-' + k + '-n');
        if (document.activeElement !== n) n.value = shown(f, v);
        document.querySelector('[data-unit="' + k + '"]').textContent = unitOf(f);
      } else if (f.t === 'bool') el.setAttribute('aria-checked', !!v);
      else if (f.t === 'seg') each(el.children, function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-v') === v); });
      else if (f.t === 'color') { el.value = v; $('f-' + k + '-s').style.background = v; }
      else {
        if (v && state.defs.indexOf(v) < 0) { var o = document.createElement('option'); o.value = v; o.textContent = v + ' (missing)'; el.appendChild(o); }
        el.value = v || '';
      }
    });
    Object.keys(FIELDS).forEach(function (k) {
      var f = FIELDS[k], box = document.querySelector('[data-f="' + k + '"]');
      if (box) box.classList.toggle('hide', !!(f['if'] && !f['if'](p)));
    });
    TABS.forEach(function (t) {
      t.items.forEach(function (it, i) {
        if (!it.g) return;
        var g = document.querySelector('[data-g="' + t.id + i + '"]');
        if (g) g.classList.toggle('hide', !!(it['if'] && !it['if'](p)));
      });
    });
  }

  function set(k, v) {
    if (typeof v === 'number' && isNaN(v)) return;
    state.p[k] = v;
    state.presetId = null;
    refresh();
    changed();
  }

  function refresh() {
    syncForm();
    drawScene();
    drawStats();
    markTiles();
    syncCrumb();
  }

  // ------------------------------------------------------------------
  // Live updates
  // ------------------------------------------------------------------
  var timer = null;
  function liveOn() { return $('live').getAttribute('aria-checked') === 'true'; }
  function changed() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      var json = JSON.stringify(state.p);
      if (liveOn() && state.sel.railings > 0) SU.live(json);
      else SU.remember(json);
    }, 350);
  }

  // ------------------------------------------------------------------
  // 3D model of the railing on an L-shaped run (boxes in mm)
  // ------------------------------------------------------------------
  function railH(kind, w, h) { return kind === 'round' ? w : h; }

  function runPosts(p, L, first, last) {
    var sp = Math.max(50, p.post_spacing), xs = [], k;
    if (p.spacing_mode === 'fixed') {
      for (k = 0; k * sp < L - sp * 0.05; k++) xs.push(k * sp);
      xs.push(L);
    } else {
      var n = Math.max(1, Math.ceil(L / sp - 1e-6));
      for (k = 0; k <= n; k++) xs.push(L * k / n);
    }
    return xs.map(function (s, i) {
      var kind = i === 0 ? (first ? 'start' : 'corner') : (i === xs.length - 1 ? (last ? 'end' : 'corner') : 'mid');
      var vis = { start: p.show_start_post, end: p.show_end_post, corner: p.show_corner_posts, mid: p.show_mid_posts }[kind];
      return { s: s, v: !!vis, kind: kind };
    });
  }

  function buildModel(p, small) {
    var sp = Math.max(50, p.post_spacing);
    var na = clamp(Math.round((small ? 2400 : 3600) / sp), 1, small ? 3 : 4);
    var La = sp * na, Lb = sp * Math.max(1, Math.round(na / 2));
    var segs = [{ o: [0, 0], d: [1, 0], L: La }, { o: [La, 0], d: [0, 1], L: Lb }];
    segs.forEach(function (sg) { sg.n = [-sg.d[1], sg.d[0]]; });
    var boxes = [], chunk = small ? 700 : 260;
    var H = p.height;
    var trH = p.top_rail ? railH(p.top_rail_profile, p.top_rail_width, p.top_rail_height) : 0;
    var postH = H - trH;
    var bottom = p.bottom_rail ? p.bottom_rail_elev + railH(p.bottom_rail_profile, p.bottom_rail_width, p.bottom_rail_height) : p.infill_bottom;
    var top = H - trH - p.infill_top_gap;
    var ov = p.top_rail_overhang;
    var hp = p.post_width / 2, pd = (p.post_profile === 'round' ? p.post_width : p.post_depth) / 2;
    var gl = { col: p.glass_color, op: clamp(p.glass_opacity, 0.2, 0.9), glass: 1 };

    // Long members are cut into short pieces so depth sorting stays right;
    // panels (whole = true) stay one piece so the glass shows no seams.
    function add(sg, s0, s1, u0, u1, z0, z1, col, op, whole) {
      if (s1 - s0 < 0.5 || z1 - z0 < 0.5) return;
      var n = whole ? 1 : Math.max(1, Math.ceil((s1 - s0) / chunk));
      for (var i = 0; i < n; i++) {
        var a0 = s0 + (s1 - s0) * i / n, a1 = s0 + (s1 - s0) * (i + 1) / n;
        var ax = sg.o[0] + sg.d[0] * a0 + sg.n[0] * u0, ay = sg.o[1] + sg.d[1] * a0 + sg.n[1] * u0;
        var bx = sg.o[0] + sg.d[0] * a1 + sg.n[0] * u1, by = sg.o[1] + sg.d[1] * a1 + sg.n[1] * u1;
        boxes.push({ x: Math.min(ax, bx), y: Math.min(ay, by), z: z0, w: Math.abs(bx - ax), d: Math.abs(by - ay), h: z1 - z0,
          col: col.col || col, op: op || col.op || 1, glass: !!col.glass });
      }
    }
    // A continuous member centred at u with half width hw, trimmed to meet at the corner.
    function cont(sg, i, u, hw, z0, z1, col, overhang) {
      var s0 = i === 0 ? -(overhang || 0) : u - hw;
      var s1 = i === segs.length - 1 ? sg.L + (overhang || 0) : sg.L - u + hw;
      add(sg, s0, s1, u - hw, u + hw, z0, z1, col);
    }

    segs.forEach(function (sg, i) {
      var posts = runPosts(p, sg.L, i === 0, i === segs.length - 1);
      // posts (the corner post belongs to the first run)
      posts.forEach(function (pt, j) {
        if (!pt.v || (i > 0 && j === 0)) return;
        add(sg, pt.s - hp, pt.s + hp, -pd, pd, 0, postH, p.post_color);
        if (p.base_plate) add(sg, pt.s - hp - 30, pt.s + hp + 30, -pd - 30, pd + 30, 0, 8, p.post_color);
      });
      // infill per bay
      for (var b = 0; b < posts.length - 1; b++) {
        var A = posts[b], B = posts[b + 1], l = B.s - A.s;
        if (p.infill_type === 'balusters') {
          var cnt = Math.max(Math.ceil(l / p.baluster_spacing - 1e-6) - 1, 0);
          var bw = p.baluster_width / 2, bd = (p.baluster_profile === 'round' ? p.baluster_width : p.baluster_depth) / 2;
          for (var k = 1; k <= cnt; k++) { var c = A.s + l * k / (cnt + 1); add(sg, c - bw, c + bw, -bd, bd, bottom, top, p.infill_color); }
        } else if (p.infill_type === 'glass' || p.infill_type === 'panel') {
          var s0 = A.s + (A.v ? hp : 0) + p.glass_gap, s1 = B.s - (B.v ? hp : 0) - p.glass_gap, t = p.glass_thickness / 2, go = p.glass_offset;
          if (s1 - s0 > 10) {
            add(sg, s0, s1, go - t, go + t, bottom, top, p.infill_type === 'glass' ? gl : { col: p.infill_color, op: clamp(p.panel_opacity, 0.3, 1) }, 0, true);
            if (p.infill_type === 'glass' && p.show_clamps) {
              var zs = top - bottom > 2 * p.clamp_inset + p.clamp_height ? [bottom + p.clamp_inset, top - p.clamp_inset] : [(bottom + top) / 2];
              [[A, 1], [B, -1]].forEach(function (pr) {
                if (!pr[0].v) return;
                var cc = pr[0].s + pr[1] * (hp + p.clamp_width / 2);
                zs.forEach(function (z) { add(sg, cc - p.clamp_width / 2, cc + p.clamp_width / 2, go - p.clamp_depth / 2, go + p.clamp_depth / 2, z - p.clamp_height / 2, z + p.clamp_height / 2, p.hardware_color); });
              });
            }
          }
        }
      }
      if (p.infill_type === 'horizontal') {
        var nh = p.hrail_count, hh = p.hrail_profile === 'round' ? p.hrail_width : p.hrail_height;
        var gap = (top - bottom - nh * hh) / (nh + 1);
        if (gap < 0) gap = (top - bottom) / (nh + 1);
        for (var r = 0; r < nh; r++) { var z0 = bottom + gap * (r + 1) + hh * r; cont(sg, i, 0, p.hrail_width / 2, z0, z0 + hh, p.infill_color); }
      }
      if (p.bottom_rail) cont(sg, i, 0, p.bottom_rail_width / 2, p.bottom_rail_elev, p.bottom_rail_elev + railH(p.bottom_rail_profile, p.bottom_rail_width, p.bottom_rail_height), p.rail_color);
      if (p.top_rail) cont(sg, i, 0, p.top_rail_width / 2, postH, H, p.rail_color, ov);
      if (p.handrail2) {
        var dd = p.handrail2_diameter, e = p.handrail2_elev, off = p.handrail2_offset, bs = p.bracket_size / 2;
        cont(sg, i, off, dd / 2, e - dd / 2, e + dd / 2, p.rail_color, ov);
        posts.forEach(function (pt, j) {
          if (i > 0 && j === 0) return;
          add(sg, pt.s - bs, pt.s + bs, Math.min(0, off), Math.max(0, off), e - bs, e + bs, p.hardware_color);
        });
      }
    });
    return { boxes: boxes, La: La, Lb: Lb, bay: sp };
  }

  // ------------------------------------------------------------------
  // Painter's-algorithm renderer (orthographic, SketchUp axes)
  // ------------------------------------------------------------------
  var FACES = [
    { n: [0, 0, 1], q: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
    { n: [0, 0, -1], q: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
    { n: [0, -1, 0], q: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
    { n: [0, 1, 0], q: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
    { n: [-1, 0, 0], q: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
    { n: [1, 0, 0], q: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] }
  ];
  var LIGHT = [0.35, -0.55, 0.76];

  // Very dark finishes (black steel) are lifted toward grey in the preview
  // so they still read against the dark viewport; the model keeps its colour.
  function shade(hex, k) {
    var n = parseInt(String(hex || '#888888').slice(1), 16);
    var c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    var lum = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
    if (lum < 90) c = c.map(function (v) { return v + (150 - v) * 0.55; });
    return 'rgb(' + c.map(function (v) { return Math.min(255, Math.round(v * k)); }).join(',') + ')';
  }

  function render(boxes, o) {
    var a = o.yaw * Math.PI / 180, e = o.pitch * Math.PI / 180;
    var c = Math.cos(a), s = Math.sin(a), cp = Math.cos(e), sp = Math.sin(e);
    var bb = { x0: Infinity, y0: Infinity, z0: 0, x1: -Infinity, y1: -Infinity, z1: -Infinity };
    boxes.forEach(function (b) {
      bb.x0 = Math.min(bb.x0, b.x); bb.y0 = Math.min(bb.y0, b.y); bb.z0 = Math.min(bb.z0, b.z);
      bb.x1 = Math.max(bb.x1, b.x + b.w); bb.y1 = Math.max(bb.y1, b.y + b.d); bb.z1 = Math.max(bb.z1, b.z + b.h);
    });
    if (!boxes.length) bb = { x0: 0, y0: 0, z0: 0, x1: 1000, y1: 1000, z1: 1000 };
    var cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2, cz = (bb.z0 + bb.z1) / 2;
    var R = Math.max(1, Math.sqrt(Math.pow(bb.x1 - bb.x0, 2) + Math.pow(bb.y1 - bb.y0, 2) + Math.pow(bb.z1 - bb.z0, 2)) / 2);
    var sc = Math.min(o.W, o.H) / (2 * R) * (o.fill || 0.95) * (o.zoom || 1);
    function P(x, y, z) {
      x -= cx; y -= cy; z -= cz;
      var xr = x * c - y * s, yr = x * s + y * c;
      return [o.W / 2 + xr * sc, o.H / 2 - (z * cp + yr * sp) * sc, -yr * cp + z * sp];
    }
    function f1(n) { return Math.round(n * 10) / 10; }
    var order = boxes.map(function (b) { return { b: b, d: P(b.x + b.w / 2, b.y + b.d / 2, b.z + b.h / 2)[2] }; })
      .sort(function (m, n) { return m.d - n.d; });
    var out = '';
    if (o.grid) {
      var st = R < 1500 ? 250 : 500, m = R * 0.35, k, p1, p2;
      var gx0 = Math.floor((bb.x0 - m) / st) * st, gx1 = Math.ceil((bb.x1 + m) / st) * st;
      var gy0 = Math.floor((bb.y0 - m) / st) * st, gy1 = Math.ceil((bb.y1 + m) / st) * st;
      var gl = '';
      for (k = gx0; k <= gx1; k += st) { p1 = P(k, gy0, 0); p2 = P(k, gy1, 0); gl += 'M' + f1(p1[0]) + ' ' + f1(p1[1]) + 'L' + f1(p2[0]) + ' ' + f1(p2[1]); }
      for (k = gy0; k <= gy1; k += st) { p1 = P(gx0, k, 0); p2 = P(gx1, k, 0); gl += 'M' + f1(p1[0]) + ' ' + f1(p1[1]) + 'L' + f1(p2[0]) + ' ' + f1(p2[1]); }
      out += '<path d="' + gl + '" style="fill:none;stroke:var(--grid);stroke-width:1"/>';
      var O = P(0, 0, 0), X = P(gx1, 0, 0), Y = P(0, gy1, 0), Z = P(0, 0, bb.z1 + st);
      [[X, 'x'], [Y, 'y'], [Z, 'z']].forEach(function (ax) {
        out += '<line x1="' + f1(O[0]) + '" y1="' + f1(O[1]) + '" x2="' + f1(ax[0][0]) + '" y2="' + f1(ax[0][1]) + '" style="stroke:var(--axis-' + ax[1] + ');stroke-width:1.6;stroke-linecap:round"/>';
      });
    }
    order.forEach(function (it) {
      var b = it.b;
      FACES.forEach(function (f) {
        var dot = -(f.n[0] * s + f.n[1] * c) * cp + f.n[2] * sp;
        if (!o.xray && !b.glass && dot <= 0.0005) return;
        if (b.glass && dot <= 0.0005) return;
        var pts = f.q.map(function (q) { var pp = P(b.x + q[0] * b.w, b.y + q[1] * b.d, b.z + q[2] * b.h); return f1(pp[0]) + ',' + f1(pp[1]); }).join(' ');
        var lit = 0.6 + 0.4 * Math.max(0, f.n[0] * LIGHT[0] + f.n[1] * LIGHT[1] + f.n[2] * LIGHT[2]);
        var op = o.xray ? Math.min(b.op, 0.3) : b.op;
        out += '<polygon points="' + pts + '" fill="' + shade(b.col, lit) + '"' + (op < 1 ? ' fill-opacity="' + op + '"' : '') +
          (o.edges ? ' style="stroke:var(--edge);stroke-width:' + o.sw + ';stroke-opacity:' + (b.glass ? 0.45 : (o.edgeOp || 0.85)) + ';stroke-linejoin:round"' : '') + '/>';
      });
    });
    return out;
  }

  var VIEWS = [['Iso', -38, 26], ['Top', 0, 90], ['Front', 0, 0], ['Right', -90, 0]];
  function normYaw(y) { return ((y % 360) + 540) % 360 - 180; }

  function drawScene() {
    var m = buildModel(state.p, false);
    $('scene').innerHTML = render(m.boxes, { yaw: state.yaw, pitch: state.pitch, W: 640, H: 400, zoom: state.zoom, edges: state.edges, xray: state.xray, grid: true, sw: 0.7, fill: 0.9 });
    var u = state.units === 'mm';
    function L(v) { return u ? Math.round(v).toLocaleString('en-US') : (v / 25.4).toFixed(1); }
    $('dims').textContent = L(m.La) + ' + ' + L(m.Lb) + ' run · ' + L(state.p.height) + ' ' + state.units + ' high';
    $('orbit').textContent = Math.round(normYaw(state.yaw)) + '° · ' + Math.round(state.pitch) + '°';
    each($('views').children, function (b) {
      var v = VIEWS[+b.getAttribute('data-i')];
      b.setAttribute('aria-pressed', Math.abs(normYaw(state.yaw) - v[1]) < 0.5 && Math.abs(state.pitch - v[2]) < 0.5);
    });
    $('tg-edges').setAttribute('aria-pressed', state.edges);
    $('tg-xray').setAttribute('aria-pressed', state.xray);
    $('tg-spin').setAttribute('aria-pressed', state.spin);
  }

  // ------------------------------------------------------------------
  // Check cards
  // ------------------------------------------------------------------
  function drawStats() {
    var p = state.p, u = state.units === 'mm';
    function L(v) { return u ? String(Math.round(v)) : (v / 25.4).toFixed(1); }
    var trH = p.top_rail ? railH(p.top_rail_profile, p.top_rail_width, p.top_rail_height) : 0;
    var bottom = p.bottom_rail ? p.bottom_rail_elev + railH(p.bottom_rail_profile, p.bottom_rail_width, p.bottom_rail_height) : p.infill_bottom;
    var top = p.height - trH - p.infill_top_gap, gap = null;
    if (p.infill_type === 'balusters') {
      var cnt = Math.max(Math.ceil(p.post_spacing / p.baluster_spacing - 1e-6) - 1, 0);
      gap = p.post_spacing / (cnt + 1) - p.baluster_width;
    } else if (p.infill_type === 'horizontal') {
      var hh = p.hrail_profile === 'round' ? p.hrail_width : p.hrail_height;
      gap = Math.max(0, (top - bottom - p.hrail_count * hh) / (p.hrail_count + 1));
    } else if (p.infill_type === 'glass' || p.infill_type === 'panel') gap = p.glass_gap;
    var toe = p.infill_type === 'none' ? null : Math.max(0, p.bottom_rail ? Math.min(p.bottom_rail_elev, bottom) : bottom);
    var cards = [
      { l: 'Height', n: L(p.height), u: state.units, ok: p.height >= 900, tip: 'Flagged below 900 mm. Check the rule that applies to your project.' },
      { l: 'Bay', n: L(p.post_spacing), u: state.units },
      { l: 'Clear gap', n: gap === null ? 'Open' : L(gap), u: gap === null ? '' : state.units, ok: gap !== null && gap <= 100, tip: 'Flagged above 100 mm between infill members.' },
      { l: 'Toe gap', n: toe === null ? '—' : L(toe), u: toe === null ? '' : state.units, ok: toe !== null && toe <= 100, tip: 'Gap between the path and the lowest infill or rail. Flagged above 100 mm.' }
    ];
    $('stats').innerHTML = cards.map(function (c) {
      var mark = c.ok === undefined ? '' : c.ok ? '<svg class="ok" viewBox="0 0 24 24" role="img" aria-label="Within range">' + CHECK + '</svg>' : '<svg class="wn" viewBox="0 0 24 24" role="img" aria-label="Outside range">' + WARN + '</svg>';
      return '<div class="card"' + (c.tip ? ' title="' + esc(c.tip) + '"' : '') + '><div class="h"><span class="eyebrow">' + c.l + '</span>' + mark + '</div><div class="n">' + c.n + '<i>' + (c.u ? ' ' + c.u : '') + '</i></div></div>';
    }).join('');
  }

  // ------------------------------------------------------------------
  // Category rail and preset tiles
  // ------------------------------------------------------------------
  function allPresets() { return state.presets.concat(state.user); }

  function buildRail() {
    var cats = ['All'];
    allPresets().forEach(function (pr) { if (cats.indexOf(pr.category) < 0) cats.push(pr.category); });
    $('rail').innerHTML = cats.map(function (c) {
      var n = c === 'All' ? allPresets().length : allPresets().filter(function (x) { return x.category === c; }).length;
      return '<button type="button" data-cat="' + esc(c) + '" aria-pressed="' + (c === state.cat) + '" aria-label="' + esc(c) + ', ' + n + ' railings" title="' + esc(c) + ' (' + n + ')">' + icon(c) + '</button>';
    }).join('');
    var n = state.cat === 'All' ? state.presets.length + ' ready-made' + (state.user.length ? ' + ' + state.user.length + ' saved' : '') :
      allPresets().filter(function (x) { return x.category === state.cat; }).length + ' railings';
    $('ptitle').textContent = (state.cat === 'All' ? 'All railings' : state.cat) + ' · ' + n;
  }

  var thumbs = {};
  function thumb(pr) {
    var key = pr.id + '|' + JSON.stringify(pr.params);
    if (!thumbs[key]) thumbs[key] = render(buildModel(pr.params, true).boxes, { yaw: -38, pitch: 24, W: 160, H: 100, edges: true, grid: false, sw: 0.4, edgeOp: 0.35, fill: 1.02 });
    return thumbs[key];
  }

  function buildTiles() {
    var list = allPresets().filter(function (pr) { return state.cat === 'All' || pr.category === state.cat; });
    $('tiles').innerHTML = list.map(function (pr) {
      return '<button type="button" class="tile" data-id="' + esc(pr.id) + '" aria-pressed="' + (pr.id === state.presetId) + '" title="' + esc(pr.name) + '">' +
        '<svg viewBox="0 0 160 100" aria-hidden="true">' + thumb(pr) + '</svg><span>' + esc(pr.name) + '</span></button>';
    }).join('');
  }

  function markTiles() {
    each($('tiles').children, function (t) { t.setAttribute('aria-pressed', t.getAttribute('data-id') === state.presetId); });
    $('pdel').classList.toggle('hide', !state.user.some(function (u) { return u.id === state.presetId; }));
  }

  function presetName() {
    var pr = allPresets().filter(function (x) { return x.id === state.presetId; })[0];
    return pr ? pr.name : 'Custom';
  }

  function applyPreset(id) {
    var pr = allPresets().filter(function (x) { return x.id === id; })[0];
    if (!pr) return;
    state.p = clone(pr.params);
    state.presetId = id;
    refresh();
    status('Loaded ' + pr.name + '.' + (state.sel.railings && liveOn() ? ' Applied to the selection.' : ''), 'info');
    changed();
  }

  // ------------------------------------------------------------------
  // Header, mode and status
  // ------------------------------------------------------------------
  function syncCrumb() {
    $('crumb').textContent = '/ ' + presetName();
    $('ptitle2').textContent = state.sel.railings === 1 ? 'Selected railing' : state.sel.railings > 1 ? state.sel.railings + ' railings' : 'New railing';
    $('live-badge').classList.toggle('hide', !(liveOn() && state.sel.railings > 0));
  }

  function syncMode() {
    var s = state.sel, m = $('mode');
    m.textContent = s.railings === 1 ? 'Editing 1 railing' : s.railings > 1 ? 'Editing ' + s.railings + ' railings' :
      s.edges > 0 ? s.edges + ' edge' + (s.edges === 1 ? '' : 's') + ' selected' : 'No selection';
    $('b-update').disabled = s.railings === 0;
    $('b-path').disabled = !(s.railings === 1 && s.edges > 0);
    $('b-create').disabled = s.edges === 0;
    syncCrumb();
  }

  function status(text, kind) {
    var ic = $('toast-ic');
    ic.innerHTML = kind === 'warn' ? WARN : kind === 'note' ? NOTE : CHECK;
    ic.style.stroke = kind === 'warn' ? 'var(--warn)' : kind === 'note' ? 'var(--muted)' : 'var(--ok)';
    $('status').textContent = text;
    $('undo').classList.toggle('hide', kind !== 'done');
  }

  function setTheme(t) {
    if (t) document.documentElement.setAttribute('data-theme', t);
    var dark = t ? t === 'dark' : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    $('theme').innerHTML = icon(dark ? 'sun' : 'moon');
    $('theme').setAttribute('aria-label', dark ? 'Light mode' : 'Dark mode');
    $('theme').title = dark ? 'Light mode' : 'Dark mode';
    $('theme').setAttribute('data-dark', dark);
  }

  // ------------------------------------------------------------------
  // API called from Ruby
  // ------------------------------------------------------------------
  window.ARP = {
    init: function (d) {
      state.presets = d.presets || [];
      state.user = d.userPresets || [];
      state.defs = d.definitions || [];
      state.p = d.params || (state.presets[0] && clone(state.presets[0].params)) || {};
      fillComponents();
      buildRail();
      buildTiles();
      refresh();
      syncMode();
    },
    setSelection: function (info) {
      state.sel = { railings: info.railings || 0, edges: info.edges || 0 };
      if (info.params) { state.p = info.params; state.presetId = null; refresh(); }
      syncMode();
    },
    setDefinitions: function (list) { state.defs = list || []; fillComponents(); syncForm(); },
    setUserPresets: function (list) { state.user = list || []; buildRail(); buildTiles(); markTiles(); },
    status: status
  };

  // ------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------
  function wire() {
    $('views').innerHTML = VIEWS.map(function (v, i) { return '<button type="button" class="v" data-i="' + i + '" aria-pressed="false">' + v[0] + '</button>'; }).join('');
    $('views').addEventListener('click', function (e) {
      var b = e.target.closest('[data-i]'); if (!b) return;
      var v = VIEWS[+b.getAttribute('data-i')];
      state.yaw = v[1]; state.pitch = v[2]; state.spin = false; drawScene();
    });
    $('tg-edges').addEventListener('click', function () { state.edges = !state.edges; drawScene(); });
    $('tg-xray').addEventListener('click', function () { state.xray = !state.xray; drawScene(); });
    $('tg-spin').addEventListener('click', function () { state.spin = !state.spin; drawScene(); });
    $('z-in').addEventListener('click', function () { state.zoom = clamp(state.zoom * 1.2, 0.4, 4); drawScene(); });
    $('z-out').addEventListener('click', function () { state.zoom = clamp(state.zoom / 1.2, 0.4, 4); drawScene(); });
    $('z-fit').addEventListener('click', function () { state.zoom = 1; drawScene(); });

    var drag = null, sc = $('scene');
    sc.addEventListener('pointerdown', function (e) { drag = { x: e.clientX, y: e.clientY, yaw: state.yaw, pitch: state.pitch }; try { sc.setPointerCapture(e.pointerId); } catch (err) {} });
    sc.addEventListener('pointermove', function (e) {
      if (!drag) return;
      state.yaw = drag.yaw + (e.clientX - drag.x) * 0.5;
      state.pitch = clamp(drag.pitch + (e.clientY - drag.y) * 0.4, 0, 90);
      drawScene();
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (t) { sc.addEventListener(t, function () { drag = null; }); });
    sc.addEventListener('wheel', function (e) { e.preventDefault(); state.zoom = clamp(state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 0.4, 4); drawScene(); }, { passive: false });
    setInterval(function () { if (state.spin && !drag) { state.yaw += 1.2; drawScene(); } }, 50);

    $('rail').addEventListener('click', function (e) {
      var b = e.target.closest('[data-cat]'); if (!b) return;
      state.cat = b.getAttribute('data-cat'); buildRail(); buildTiles();
    });
    $('tiles').addEventListener('click', function (e) { var t = e.target.closest('[data-id]'); if (t) applyPreset(t.getAttribute('data-id')); });
    $('psave').addEventListener('click', function () {
      var n = $('pname').value.trim();
      if (!n) { status('Name the preset before saving it.', 'warn'); $('pname').focus(); return; }
      SU.save_user_preset(n, JSON.stringify(state.p));
      $('pname').value = '';
    });
    $('pdel').addEventListener('click', function () {
      if (state.presetId && window.confirm('Delete this preset?')) { SU.delete_user_preset(state.presetId); state.presetId = null; markTiles(); }
    });

    $('u-mm').addEventListener('click', function () { state.units = 'mm'; units(); });
    $('u-in').addEventListener('click', function () { state.units = 'in'; units(); });
    function units() {
      $('u-mm').setAttribute('aria-pressed', state.units === 'mm');
      $('u-in').setAttribute('aria-pressed', state.units === 'in');
      store('arp_units', state.units);
      refresh();
    }

    $('live').addEventListener('click', function () {
      $('live').setAttribute('aria-checked', !liveOn());
      syncCrumb();
      if (liveOn() && state.sel.railings > 0) changed();
    });
    $('b-create').addEventListener('click', function () { SU.create(JSON.stringify(state.p)); });
    $('b-update').addEventListener('click', function () { SU.update(JSON.stringify(state.p)); });
    $('b-path').addEventListener('click', function () { SU.repath(); });
    $('undo').addEventListener('click', function () { SU.undo(); status('Undone.', 'note'); });
    $('close').addEventListener('click', function () { SU.close(); });
    $('theme').addEventListener('click', function () {
      var t = $('theme').getAttribute('data-dark') === 'true' ? 'light' : 'dark';
      store('arp_theme', t); setTheme(t);
    });

    var u = store('arp_units');
    if (u === 'in') { state.units = 'in'; $('u-mm').setAttribute('aria-pressed', false); $('u-in').setAttribute('aria-pressed', true); }
    setTheme(store('arp_theme'));
    status('Select edges, a curve or an arc, then create a railing.', 'note');
  }

  if (!Element.prototype.closest) {
    Element.prototype.closest = function (sel) {
      var el = this;
      while (el && el.nodeType === 1) { if ((el.matches || el.msMatchesSelector).call(el, sel)) return el; el = el.parentElement; }
      return null;
    };
  }

  document.addEventListener('DOMContentLoaded', function () {
    buildForm();
    wire();
    SU.ready();
  });
})();
