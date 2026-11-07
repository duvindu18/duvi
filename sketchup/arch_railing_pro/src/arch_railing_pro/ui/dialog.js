/* ArchRailing Pro - panel logic. Plain ES5 so it runs in every SketchUp HtmlDialog. */
(function () {
  'use strict';

  var SU = window.sketchup || {
    // Browser stand-in so the page can be opened and checked outside SketchUp.
    ready: function () {}, create: function () {}, update: function () {}, live: function () {},
    repath: function () {}, refresh_defs: function () {}, save_user_preset: function () {},
    delete_user_preset: function () {}, remember: function () {}, close: function () {}
  };

  var state = {
    p: {}, presets: [], user: [], defs: [], cat: 'All', presetId: null,
    sel: { railings: 0, edges: 0 }, tab: 'layout'
  };

  function $(id) { return document.getElementById(id); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function r1(v) { return Math.round(v * 10) / 10; }

  // ------------------------------------------------------------------
  // Parameter form
  // ------------------------------------------------------------------
  var PROFILE = [['rect', 'Rectangular'], ['round', 'Round']];
  function isRect(k) { return function (p) { return p[k] === 'rect'; }; }
  function on(k) { return function (p) { return !!p[k]; }; }
  function inf() { var a = arguments; return function (p) { for (var i = 0; i < a.length; i++) if (p.infill_type === a[i]) return true; return false; }; }

  var TABS = [
    { id: 'layout', label: 'Layout', items: [
      { g: 'Size' },
      { row: [{ k: 'height', l: 'Height', t: 'num', u: 'mm', s: 10 }, { k: 'post_spacing', l: 'Post spacing', t: 'num', u: 'mm', s: 10 }] },
      { k: 'spacing_mode', l: 'Spacing', t: 'chips', o: [['fit', 'Fit to length'], ['fixed', 'Fixed from start']] },
      { k: 'spacing_metric', l: 'Measure spacing', t: 'chips', o: [['3d', 'Along slope'], ['plan', 'In plan']] },
      { g: 'Offset from path' },
      { row: [{ k: 'offset_h', l: 'Horizontal', t: 'num', u: 'mm, + left', s: 5 }, { k: 'offset_v', l: 'Vertical', t: 'num', u: 'mm', s: 5 }] },
      { g: 'Corners and slopes' },
      { row: [{ k: 'corner_angle', l: 'Corner post at', t: 'num', u: 'deg turn', s: 1 }, { k: 'slope_break', l: 'Slope break at', t: 'num', u: 'deg', s: 0.5 }] }
    ] },
    { id: 'posts', label: 'Posts', items: [
      { g: 'Which posts' },
      { row: [{ k: 'show_start_post', l: 'Start post', t: 'bool' }, { k: 'show_end_post', l: 'End post', t: 'bool' }] },
      { row: [{ k: 'show_corner_posts', l: 'Corner posts', t: 'bool' }, { k: 'show_mid_posts', l: 'Intermediate posts', t: 'bool' }] },
      { g: 'Post' },
      { k: 'post_profile', l: 'Profile', t: 'chips', o: PROFILE },
      { row: [{ k: 'post_width', l: 'Width', t: 'num', u: 'mm', s: 1 }, { k: 'post_depth', l: 'Depth', t: 'num', u: 'mm', s: 1, 'if': isRect('post_profile') }] },
      { k: 'base_plate', l: 'Base plate', t: 'bool' },
      { k: 'post_component', l: 'Post component', t: 'comp' }
    ] },
    { id: 'rails', label: 'Rails', items: [
      { g: 'Top rail' },
      { k: 'top_rail', l: 'Top rail', t: 'bool' },
      { k: 'top_rail_profile', l: 'Profile', t: 'chips', o: PROFILE, 'if': on('top_rail') },
      { row: [{ k: 'top_rail_width', l: 'Width', t: 'num', u: 'mm', s: 1, 'if': on('top_rail') },
              { k: 'top_rail_height', l: 'Height', t: 'num', u: 'mm', s: 1, 'if': function (p) { return p.top_rail && p.top_rail_profile === 'rect'; } }] },
      { k: 'top_rail_overhang', l: 'End overhang', t: 'num', u: 'mm', s: 5, 'if': function (p) { return p.top_rail || p.handrail2; } },
      { g: 'Bottom rail' },
      { k: 'bottom_rail', l: 'Bottom rail', t: 'bool' },
      { k: 'bottom_rail_profile', l: 'Profile', t: 'chips', o: PROFILE, 'if': on('bottom_rail') },
      { row: [{ k: 'bottom_rail_width', l: 'Width', t: 'num', u: 'mm', s: 1, 'if': on('bottom_rail') },
              { k: 'bottom_rail_height', l: 'Height', t: 'num', u: 'mm', s: 1, 'if': function (p) { return p.bottom_rail && p.bottom_rail_profile === 'rect'; } }] },
      { k: 'bottom_rail_elev', l: 'Above path', t: 'num', u: 'mm', s: 5, 'if': on('bottom_rail') },
      { g: 'Handrail on brackets' },
      { k: 'handrail2', l: 'Handrail on brackets', t: 'bool' },
      { row: [{ k: 'handrail2_elev', l: 'Height to centre', t: 'num', u: 'mm', s: 10, 'if': on('handrail2') },
              { k: 'handrail2_diameter', l: 'Diameter', t: 'num', u: 'mm', s: 1, 'if': on('handrail2') }] },
      { row: [{ k: 'handrail2_offset', l: 'Side offset', t: 'num', u: 'mm, + left', s: 5, 'if': on('handrail2') },
              { k: 'bracket_size', l: 'Bracket', t: 'num', u: 'mm', s: 1, 'if': on('handrail2') }] }
    ] },
    { id: 'infill', label: 'Infill', items: [
      { k: 'infill_type', l: 'Infill', t: 'chips', o: [['none', 'None'], ['balusters', 'Balusters'], ['glass', 'Glass'], ['panel', 'Panel'], ['horizontal', 'Horizontal']] },
      { row: [{ k: 'infill_bottom', l: 'Bottom above path', t: 'num', u: 'mm', s: 5, 'if': function (p) { return p.infill_type !== 'none' && !p.bottom_rail; } },
              { k: 'infill_top_gap', l: 'Gap below top', t: 'num', u: 'mm', s: 5, 'if': function (p) { return p.infill_type !== 'none'; } }] },
      { g: 'Balusters', 'if': inf('balusters') },
      { k: 'baluster_profile', l: 'Profile', t: 'chips', o: PROFILE, 'if': inf('balusters') },
      { row: [{ k: 'baluster_width', l: 'Width', t: 'num', u: 'mm', s: 1, 'if': inf('balusters') },
              { k: 'baluster_depth', l: 'Depth', t: 'num', u: 'mm', s: 1, 'if': function (p) { return p.infill_type === 'balusters' && p.baluster_profile === 'rect'; } }] },
      { k: 'baluster_spacing', l: 'Max spacing, centre to centre', t: 'num', u: 'mm', s: 5, 'if': inf('balusters') },
      { k: 'baluster_component', l: 'Baluster component', t: 'comp', 'if': inf('balusters') },
      { g: 'Panels', 'if': inf('glass', 'panel') },
      { row: [{ k: 'glass_thickness', l: 'Thickness', t: 'num', u: 'mm', s: 0.5, 'if': inf('glass', 'panel') },
              { k: 'glass_gap', l: 'Gap to post', t: 'num', u: 'mm', s: 1, 'if': inf('glass', 'panel') }] },
      { k: 'glass_offset', l: 'Side offset', t: 'num', u: 'mm, + left', s: 1, 'if': inf('glass', 'panel') },
      { k: 'show_clamps', l: 'Glass clamps', t: 'bool', 'if': inf('glass') },
      { row: [{ k: 'clamp_width', l: 'Clamp width', t: 'num', u: 'mm', s: 1, 'if': function (p) { return p.infill_type === 'glass' && p.show_clamps; } },
              { k: 'clamp_height', l: 'Clamp height', t: 'num', u: 'mm', s: 1, 'if': function (p) { return p.infill_type === 'glass' && p.show_clamps; } }] },
      { row: [{ k: 'clamp_depth', l: 'Clamp depth', t: 'num', u: 'mm', s: 1, 'if': function (p) { return p.infill_type === 'glass' && p.show_clamps; } },
              { k: 'clamp_inset', l: 'Clamp inset', t: 'num', u: 'mm', s: 5, 'if': function (p) { return p.infill_type === 'glass' && p.show_clamps; } }] },
      { k: 'clamp_component', l: 'Clamp component', t: 'comp', 'if': function (p) { return p.infill_type === 'glass' && p.show_clamps; } },
      { g: 'Horizontal rails', 'if': inf('horizontal') },
      { k: 'hrail_profile', l: 'Profile', t: 'chips', o: [['round', 'Round / cable'], ['rect', 'Board / flat bar']], 'if': inf('horizontal') },
      { row: [{ k: 'hrail_count', l: 'Count', t: 'num', u: '', s: 1, 'if': inf('horizontal') },
              { k: 'hrail_width', l: 'Thickness', t: 'num', u: 'mm', s: 1, 'if': inf('horizontal') }] },
      { k: 'hrail_height', l: 'Board height', t: 'num', u: 'mm', s: 1, 'if': function (p) { return p.infill_type === 'horizontal' && p.hrail_profile === 'rect'; } }
    ] },
    { id: 'finish', label: 'Finish', items: [
      { g: 'Colours' },
      { row: [{ k: 'post_color', l: 'Posts', t: 'color' }, { k: 'rail_color', l: 'Rails', t: 'color' }] },
      { row: [{ k: 'infill_color', l: 'Infill', t: 'color' }, { k: 'hardware_color', l: 'Hardware', t: 'color' }] },
      { row: [{ k: 'glass_color', l: 'Glass', t: 'color' }, { k: 'glass_opacity', l: 'Glass opacity', t: 'num', u: '0 to 1', s: 0.05 }] },
      { k: 'panel_opacity', l: 'Panel opacity', t: 'num', u: '0 to 1', s: 0.05 },
      { g: 'Quality' },
      { k: 'round_segments', l: 'Round segments', t: 'num', u: 'sides', s: 2 }
    ] }
  ];

  function fieldHtml(f) {
    var id = 'f-' + f.k, h = '';
    var unit = f.u ? ' <em>' + esc(f.u) + '</em>' : '';
    if (f.t === 'bool') {
      return '<label class="su-opt" data-f="' + f.k + '"><input type="checkbox" id="' + id + '"> ' + esc(f.l) + '</label>';
    }
    h += '<label class="su-f" data-f="' + f.k + '"><span>' + esc(f.l) + unit + '</span>';
    if (f.t === 'num') h += '<input class="su-fld" type="number" id="' + id + '" step="' + (f.s || 1) + '">';
    else if (f.t === 'color') h += '<span class="clr"><input type="color" id="' + id + '"><code id="' + id + '-hex"></code></span>';
    else if (f.t === 'comp') h += '<select class="su-sel" id="' + id + '" data-comp="1"></select>';
    else if (f.t === 'chips') {
      h = '<div class="su-f" data-f="' + f.k + '"><span>' + esc(f.l) + '</span><div class="seg" id="' + id + '">';
      f.o.forEach(function (o) { h += '<button type="button" class="su-chip" data-v="' + o[0] + '" aria-pressed="false">' + esc(o[1]) + '</button>'; });
      return h + '</div></div>';
    }
    return h + '</label>';
  }

  function buildForm() {
    var tabs = '', pane = '';
    TABS.forEach(function (t) {
      tabs += '<button class="su-tab" role="tab" data-tab="' + t.id + '" aria-selected="' + (t.id === state.tab) + '">' + t.label + '</button>';
      pane += '<div data-pane="' + t.id + '"' + (t.id === state.tab ? '' : ' class="hide"') + '>';
      t.items.forEach(function (it, i) {
        if (it.g) pane += '<p class="grp" data-g="' + t.id + i + '">' + esc(it.g) + '</p>';
        else if (it.row) pane += '<div class="g2">' + it.row.map(fieldHtml).join('') + '</div>';
        else pane += fieldHtml(it);
      });
      pane += '</div>';
    });
    $('tabs').innerHTML = tabs;
    $('pane').innerHTML = pane;

    $('tabs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-tab]');
      if (!b) return;
      state.tab = b.getAttribute('data-tab');
      if (state.tab === 'posts' || state.tab === 'infill') SU.refresh_defs();
      [].forEach.call($('tabs').children, function (x) { x.setAttribute('aria-selected', x === b); });
      [].forEach.call($('pane').children, function (x) { x.classList.toggle('hide', x.getAttribute('data-pane') !== state.tab); });
    });

    eachField(function (f) {
      var el = $('f-' + f.k);
      if (f.t === 'chips') {
        el.addEventListener('click', function (e) {
          var b = e.target.closest('[data-v]');
          if (!b) return;
          set(f.k, b.getAttribute('data-v'));
        });
      } else if (f.t === 'bool') {
        el.addEventListener('change', function () { set(f.k, el.checked); });
      } else if (f.t === 'num') {
        el.addEventListener('input', function () { var v = parseFloat(el.value); if (!isNaN(v)) set(f.k, v); });
      } else {
        el.addEventListener(f.t === 'color' ? 'input' : 'change', function () { set(f.k, el.value); });
      }
    });
  }

  function eachField(fn) {
    TABS.forEach(function (t) {
      t.items.forEach(function (it) {
        if (it.row) it.row.forEach(fn);
        else if (!it.g) fn(it);
      });
    });
  }

  function fillComponents() {
    var opts = '<option value="">Built-in geometry</option>' + state.defs.map(function (d) {
      return '<option value="' + esc(d) + '">' + esc(d) + '</option>';
    }).join('');
    [].forEach.call(document.querySelectorAll('[data-comp]'), function (s) { s.innerHTML = opts; });
  }

  function syncForm() {
    var p = state.p;
    eachField(function (f) {
      var el = $('f-' + f.k), v = p[f.k];
      if (!el) return;
      if (f.t === 'bool') el.checked = !!v;
      else if (f.t === 'chips') [].forEach.call(el.children, function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-v') === v); });
      else if (f.t === 'color') { el.value = v; $('f-' + f.k + '-hex').textContent = v; }
      else if (f.t === 'comp') {
        if (v && state.defs.indexOf(v) < 0) { var o = document.createElement('option'); o.value = v; o.textContent = v + ' (missing)'; el.appendChild(o); }
        el.value = v || '';
      } else if (document.activeElement !== el) el.value = r1(v);
    });
    syncVisibility();
  }

  function syncVisibility() {
    var p = state.p;
    eachField(function (f) {
      var box = document.querySelector('[data-f="' + f.k + '"]');
      if (box) box.classList.toggle('hide', !!(f['if'] && !f['if'](p)));
    });
    TABS.forEach(function (t) {
      t.items.forEach(function (it, i) {
        if (!it.g) return;
        var g = document.querySelector('[data-g="' + t.id + i + '"]');
        if (g) g.classList.toggle('hide', !!(it['if'] && !it['if'](p)));
      });
    });
    [].forEach.call(document.querySelectorAll('.g2'), function (row) {
      var any = [].some.call(row.children, function (c) { return !c.classList.contains('hide'); });
      row.classList.toggle('hide', !any);
    });
  }

  function set(k, v) {
    state.p[k] = v;
    state.presetId = null;
    markTiles();
    syncForm();
    drawPreview();
    changed();
  }

  // ------------------------------------------------------------------
  // Live updates
  // ------------------------------------------------------------------
  var timer = null;
  function changed() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      var json = JSON.stringify(state.p);
      if ($('live').checked && state.sel.railings > 0) SU.live(json);
      else SU.remember(json);
    }, 350);
  }

  // ------------------------------------------------------------------
  // Elevation drawing (preview and preset thumbnails share it)
  // ------------------------------------------------------------------
  function railH(kind, w, h) { return kind === 'round' ? w : h; }

  function layout(p, L) {
    var sp = Math.max(50, p.post_spacing), xs = [], k;
    if (p.spacing_mode === 'fixed') {
      for (k = 0; k * sp < L - sp * 0.05; k++) xs.push(k * sp);
      xs.push(L);
    } else {
      var n = Math.max(1, Math.ceil(L / sp - 1e-6));
      for (k = 0; k <= n; k++) xs.push(L * k / n);
    }
    return xs.map(function (x, i) {
      var vis = i === 0 ? p.show_start_post : (i === xs.length - 1 ? p.show_end_post : p.show_mid_posts);
      return { x: x, v: !!vis };
    });
  }

  function elevation(p, VW, VH, dims) {
    // Preview a run of whole bays so the bay width shown equals the spacing.
    var sp0 = Math.max(50, p.post_spacing);
    var nb = Math.max(1, Math.min(VW < 200 ? 3 : 4, Math.round((VW < 200 ? 2600 : 4000) / sp0)));
    var L = sp0 * nb;
    var H = p.height;
    var trH = p.top_rail ? railH(p.top_rail_profile, p.top_rail_width, p.top_rail_height) : 0;
    var postH = H - trH;
    var bottom = p.bottom_rail ? p.bottom_rail_elev + railH(p.bottom_rail_profile, p.bottom_rail_width, p.bottom_rail_height) : p.infill_bottom;
    var top = H - trH - p.infill_top_gap;
    var ov = (p.top_rail || p.handrail2) ? p.top_rail_overhang : 0;
    var zMin = Math.min(0, bottom, p.bottom_rail ? p.bottom_rail_elev : 0);
    var zMax = Math.max(H, p.handrail2 ? p.handrail2_elev + p.handrail2_diameter / 2 : 0);
    var mx = dims ? 46 : 8, myT = dims ? 30 : 8, myB = dims ? 14 : 6;
    var sc = Math.min((VW - 2 * mx) / (L + 2 * ov), (VH - myT - myB) / (zMax - zMin));
    var ox = (VW - L * sc) / 2, oy = VH - myB + zMin * sc;
    function X(x) { return ox + x * sc; }
    function Y(z) { return oy - z * sc; }
    function rect(x0, z0, x1, z1, cls, extra) {
      var w = Math.max(Math.abs(X(x1) - X(x0)), 0.7), h = Math.max(Math.abs(Y(z1) - Y(z0)), 0.7);
      return '<rect x="' + Math.min(X(x0), X(x1)).toFixed(1) + '" y="' + Math.min(Y(z0), Y(z1)).toFixed(1) +
        '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) + '" style="' + cls + '"' + (extra || '') + '/>';
    }
    var S_SOLID = 'fill:var(--ink);stroke:none';
    var S_OUT = 'fill:var(--surface);stroke:var(--ink);stroke-width:0.8';
    var S_GLASS = 'fill:var(--blue-tint);stroke:var(--blue-text);stroke-width:0.8';
    var S_PANEL = 'fill:var(--tone);stroke:var(--ink);stroke-width:0.6';
    var S_HW = 'fill:var(--smoke);stroke:none';
    var posts = layout(p, L), o = '', stats = { bay: L / (posts.length - 1), gap: null };
    var hp = p.post_width / 2;

    o += '<line x1="0" x2="' + VW + '" y1="' + Y(0).toFixed(1) + '" y2="' + Y(0).toFixed(1) + '" style="stroke:var(--smoke);stroke-width:1;stroke-dasharray:4 3"/>';

    // infill
    for (var i = 0; i < posts.length - 1; i++) {
      var a = posts[i], b = posts[i + 1], l = b.x - a.x;
      if (p.infill_type === 'balusters') {
        var bw = p.baluster_width, cnt = Math.max(Math.ceil(l / p.baluster_spacing - 1e-6) - 1, 0);
        for (var k = 1; k <= cnt; k++) {
          var cx = a.x + l * k / (cnt + 1);
          o += rect(cx - bw / 2, bottom, cx + bw / 2, top, S_SOLID);
        }
        stats.gap = l / (cnt + 1) - bw;
      } else if (p.infill_type === 'glass' || p.infill_type === 'panel') {
        var s0 = a.x + (a.v ? hp : 0) + p.glass_gap, s1 = b.x - (b.v ? hp : 0) - p.glass_gap;
        if (s1 - s0 > 10) {
          o += rect(s0, bottom, s1, top, p.infill_type === 'glass' ? S_GLASS : S_PANEL,
            p.infill_type === 'panel' ? ' opacity="' + Math.max(0.35, p.panel_opacity) + '"' : '');
          if (p.infill_type === 'glass' && p.show_clamps) {
            var zs = (top - bottom > 2 * p.clamp_inset + p.clamp_height) ? [bottom + p.clamp_inset, top - p.clamp_inset] : [(bottom + top) / 2];
            [[a, 1], [b, -1]].forEach(function (pr) {
              if (!pr[0].v) return;
              var c = pr[0].x + pr[1] * (hp + p.clamp_width / 2);
              zs.forEach(function (z) { o += rect(c - p.clamp_width / 2, z - p.clamp_height / 2, c + p.clamp_width / 2, z + p.clamp_height / 2, S_HW); });
            });
          }
        }
        stats.gap = p.glass_gap;
      }
    }
    if (p.infill_type === 'horizontal') {
      var n = p.hrail_count, hh = p.hrail_profile === 'round' ? p.hrail_width : p.hrail_height;
      var gap = (top - bottom - n * hh) / (n + 1);
      if (gap < 0) gap = (top - bottom) / (n + 1);
      for (var j = 0; j < n; j++) {
        var z0 = bottom + gap * (j + 1) + hh * j;
        o += rect(0, z0, L, z0 + hh, S_SOLID);
      }
      stats.gap = gap;
    }
    // bottom rail
    if (p.bottom_rail) o += rect(0, p.bottom_rail_elev, L, p.bottom_rail_elev + railH(p.bottom_rail_profile, p.bottom_rail_width, p.bottom_rail_height), S_OUT);
    // posts
    posts.forEach(function (pt) {
      if (!pt.v) return;
      o += rect(pt.x - hp, 0, pt.x + hp, postH, S_OUT);
      if (p.base_plate) o += rect(pt.x - hp - 30, 0, pt.x + hp + 30, 8, S_SOLID);
    });
    // top rail
    if (p.top_rail) o += rect(-ov, postH, L + ov, H, S_OUT);
    // handrail on brackets
    if (p.handrail2) {
      var d = p.handrail2_diameter, e = p.handrail2_elev;
      posts.forEach(function (pt) { o += rect(pt.x - p.bracket_size / 2, e - p.bracket_size / 2, pt.x + p.bracket_size / 2, e + p.bracket_size / 2, S_HW); });
      o += rect(-ov, e - d / 2, L + ov, e + d / 2, S_OUT);
    }
    // dimensions
    if (dims) {
      var dx = ox - 22, t = 'style="stroke:var(--ink);stroke-width:0.8"';
      o += '<line x1="' + dx + '" x2="' + dx + '" y1="' + Y(0).toFixed(1) + '" y2="' + Y(H).toFixed(1) + '" ' + t + '/>';
      o += '<line x1="' + (dx - 4) + '" x2="' + (dx + 4) + '" y1="' + Y(H).toFixed(1) + '" y2="' + Y(H).toFixed(1) + '" ' + t + '/>';
      o += '<line x1="' + (dx - 4) + '" x2="' + (dx + 4) + '" y1="' + Y(0).toFixed(1) + '" y2="' + Y(0).toFixed(1) + '" ' + t + '/>';
      o += '<text x="' + (dx - 6) + '" y="' + ((Y(0) + Y(H)) / 2).toFixed(1) + '" text-anchor="middle" style="font-size:9px;fill:var(--ink)" transform="rotate(-90 ' + (dx - 6) + ' ' + ((Y(0) + Y(H)) / 2).toFixed(1) + ')">' + Math.round(H) + ' mm</text>';
      if (posts.length > 1) {
        var ty = Y(zMax) - 14, x0 = X(posts[0].x), x1 = X(posts[1].x);
        o += '<line x1="' + x0.toFixed(1) + '" x2="' + x1.toFixed(1) + '" y1="' + ty.toFixed(1) + '" y2="' + ty.toFixed(1) + '" ' + t + '/>';
        o += '<line x1="' + x0.toFixed(1) + '" x2="' + x0.toFixed(1) + '" y1="' + (ty - 4).toFixed(1) + '" y2="' + (ty + 4).toFixed(1) + '" ' + t + '/>';
        o += '<line x1="' + x1.toFixed(1) + '" x2="' + x1.toFixed(1) + '" y1="' + (ty - 4).toFixed(1) + '" y2="' + (ty + 4).toFixed(1) + '" ' + t + '/>';
        o += '<text x="' + ((x0 + x1) / 2).toFixed(1) + '" y="' + (ty - 5).toFixed(1) + '" text-anchor="middle" style="font-size:9px;fill:var(--ink)">' + Math.round(stats.bay) + ' mm</text>';
      }
    }
    return { svg: o, stats: stats };
  }

  var INFILL_NAME = { none: 'None', balusters: 'Balusters', glass: 'Glass', panel: 'Panel', horizontal: 'Horizontal' };

  function drawPreview() {
    var r = elevation(state.p, 400, 250, true);
    $('pv').innerHTML = r.svg;
    $('st-h').textContent = Math.round(state.p.height) + ' mm';
    $('st-bay').textContent = Math.round(r.stats.bay) + ' mm';
    $('st-inf').textContent = INFILL_NAME[state.p.infill_type] || '-';
    $('st-gap').textContent = r.stats.gap === null ? '-' : Math.round(r.stats.gap) + ' mm';
  }

  // ------------------------------------------------------------------
  // Preset gallery
  // ------------------------------------------------------------------
  function allPresets() { return state.presets.concat(state.user); }

  function buildCats() {
    var cats = ['All'];
    allPresets().forEach(function (pr) { if (cats.indexOf(pr.category) < 0) cats.push(pr.category); });
    $('cats').innerHTML = cats.map(function (c) {
      return '<button class="su-chip" data-cat="' + esc(c) + '" aria-pressed="' + (c === state.cat) + '">' + esc(c) + '</button>';
    }).join('');
    $('pcount').textContent = '(' + state.presets.length + (state.user.length ? ' + ' + state.user.length + ' saved' : '') + ')';
  }

  function buildTiles() {
    var list = allPresets().filter(function (pr) { return state.cat === 'All' || pr.category === state.cat; });
    $('tiles').innerHTML = list.map(function (pr) {
      return '<button class="su-tile" data-id="' + esc(pr.id) + '" aria-pressed="' + (pr.id === state.presetId) + '" title="' + esc(pr.name) + '">' +
        '<svg viewBox="0 0 160 90" aria-hidden="true">' + elevation(pr.params, 160, 90, false).svg + '</svg>' +
        '<b>' + esc(pr.name) + '</b><small>' + esc(pr.category) + '</small></button>';
    }).join('');
  }

  function markTiles() {
    [].forEach.call($('tiles').children, function (t) { t.setAttribute('aria-pressed', t.getAttribute('data-id') === state.presetId); });
    var isUser = state.user.some(function (u) { return u.id === state.presetId; });
    $('pdel').classList.toggle('hide', !isUser);
  }

  function applyPreset(id) {
    var pr = allPresets().filter(function (x) { return x.id === id; })[0];
    if (!pr) return;
    state.p = clone(pr.params);
    state.presetId = id;
    markTiles();
    syncForm();
    drawPreview();
    status('Loaded "' + pr.name + '".' + (state.sel.railings && $('live').checked ? ' Applied to the selection.' : ''), 'info');
    changed();
  }

  // ------------------------------------------------------------------
  // Mode and status
  // ------------------------------------------------------------------
  function status(text, kind) {
    var s = $('status');
    s.textContent = text;
    s.className = 'su-status' + (kind && kind !== 'info' ? ' ' + kind : '');
  }

  function syncMode() {
    var s = state.sel, m = $('mode');
    if (s.railings === 1) { m.textContent = 'Editing railing'; m.className = 'su-tag solid'; }
    else if (s.railings > 1) { m.textContent = 'Editing ' + s.railings + ' railings'; m.className = 'su-tag solid'; }
    else if (s.edges > 0) { m.textContent = s.edges + ' edge' + (s.edges === 1 ? '' : 's') + ' selected'; m.className = 'su-tag'; }
    else { m.textContent = 'No selection'; m.className = 'su-tag neutral'; }
    $('b-update').disabled = s.railings === 0;
    $('b-path').disabled = !(s.railings === 1 && s.edges > 0);
    $('b-create').disabled = s.edges === 0;
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
      $('ver').textContent = 'Version ' + d.version + '. ' + state.presets.length + ' ready-made railings. Sizes in mm.';
      fillComponents();
      buildCats();
      buildTiles();
      syncForm();
      drawPreview();
      syncMode();
    },
    setSelection: function (info) {
      state.sel = { railings: info.railings || 0, edges: info.edges || 0 };
      if (info.params) {
        state.p = info.params;
        state.presetId = null;
        markTiles();
        syncForm();
        drawPreview();
      }
      syncMode();
    },
    setDefinitions: function (list) { state.defs = list || []; fillComponents(); syncForm(); },
    setUserPresets: function (list) { state.user = list || []; buildCats(); buildTiles(); markTiles(); },
    status: status
  };

  // ------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------
  function wire() {
    $('cats').addEventListener('click', function (e) {
      var b = e.target.closest('[data-cat]');
      if (!b) return;
      state.cat = b.getAttribute('data-cat');
      buildCats();
      buildTiles();
    });
    $('tiles').addEventListener('click', function (e) {
      var t = e.target.closest('[data-id]');
      if (t) applyPreset(t.getAttribute('data-id'));
    });
    $('psave').addEventListener('click', function () {
      var n = $('pname').value.trim();
      if (!n) { status('Name the preset before saving it.', 'warn'); $('pname').focus(); return; }
      SU.save_user_preset(n, JSON.stringify(state.p));
      $('pname').value = '';
    });
    $('pdel').addEventListener('click', function () {
      if (state.presetId && window.confirm('Delete this preset?')) { SU.delete_user_preset(state.presetId); state.presetId = null; markTiles(); }
    });
    $('b-create').addEventListener('click', function () { SU.create(JSON.stringify(state.p)); });
    $('b-update').addEventListener('click', function () { SU.update(JSON.stringify(state.p)); });
    $('b-path').addEventListener('click', function () { SU.repath(); });
    $('live').addEventListener('change', function () {
      $('live').parentNode.classList.toggle('on', $('live').checked);
      if ($('live').checked && state.sel.railings > 0) changed();
    });
    $('live').parentNode.classList.toggle('on', $('live').checked);
  }

  // Element.closest fallback for very old dialog engines.
  if (!Element.prototype.closest) {
    Element.prototype.closest = function (sel) {
      var el = this;
      while (el && el.nodeType === 1) { if (el.matches ? el.matches(sel) : el.msMatchesSelector(sel)) return el; el = el.parentElement; }
      return null;
    };
  }

  document.addEventListener('DOMContentLoaded', function () {
    buildForm();
    wire();
    SU.ready();
  });
})();
