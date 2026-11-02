/* .SketchCorner dialog logic.
 * Ruby -> page : SC.receive(state), SC.error(message)
 * page -> Ruby : sketchup.params(json), sketchup.action(name), sketchup.ready()
 * Outside SketchUp (opened in a browser) a stub keeps the page usable.
 */
(function () {
  'use strict';

  var bridge = window.sketchup || {
    ready: function () { setTimeout(function () { SC.receive(demoState()); }, 0); },
    params: function (json) { var s = demoState(); Object.assign(s.params, JSON.parse(json)); window.__demo = s; SC.receive(s); },
    action: function (name) { SC.receive(Object.assign(demoState(), { message: 'Action: ' + name })); }
  };

  var state = { mode: 'create', params: {}, stats: {}, lengths: {} };
  var $ = function (id) { return document.getElementById(id); };
  var all = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  function send(updates) { bridge.params(JSON.stringify(updates)); }
  function act(name) { bridge.action(name); }

  // ---------------------------------------------------------------- wiring
  all('.tile').forEach(function (t) {
    t.addEventListener('click', function () { send({ profile: t.dataset.profile }); });
  });
  all('[data-key]').forEach(function (group) {
    group.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-value]');
      if (!b) return;
      var u = {}; u[group.dataset.key] = b.dataset.value; send(u);
    });
  });
  all('[data-step]').forEach(function (b) {
    b.addEventListener('click', function () {
      var key = b.dataset.step;
      var v = (state.params[key] || 1) + parseInt(b.dataset.d, 10);
      var u = {}; u[key] = Math.max(1, Math.min(key === 'steps' ? 32 : 64, v)); send(u);
    });
  });
  ['variable', 'uv', 'soften_boundary', 'clamp', 'custom_smooth'].forEach(function (id) {
    $(id).addEventListener('change', function () { var u = {}; u[id] = $(id).checked; send(u); });
  });
  ['radius', 'radius_end'].forEach(function (id) {
    var el = $(id);
    el.addEventListener('change', function () { var u = {}; u[id] = el.value; el.classList.remove('invalid'); send(u); });
    el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') el.blur(); });
  });
  var timer = null;
  ['ratio', 'rho'].forEach(function (id) {
    var el = $(id);
    el.addEventListener('input', function () {
      paintRange(el); $(id + '-out').textContent = parseFloat(el.value).toFixed(2);
      var local = Object.assign({}, state.params); local[id] = parseFloat(el.value); drawProfile(local);
      clearTimeout(timer);
      timer = setTimeout(function () { var u = {}; u[id] = parseFloat(el.value); send(u); }, 140);
    });
  });
  $('material').addEventListener('change', function () { send({ material: $('material').value || null }); });
  $('tag').addEventListener('change', function () { send({ tag: $('tag').value.trim() || null }); });
  $('op').addEventListener('change', function () { send({ op_id: $('op').value }); });
  $('reverse').addEventListener('click', function () { act('reverse'); });
  $('pick-profile').addEventListener('click', function () { act('pick_profile'); });
  $('mode-create').addEventListener('click', function () { act('mode_create'); });
  $('mode-edit').addEventListener('click', function () { act('mode_edit'); });
  $('apply').addEventListener('click', function () { act('apply'); });
  $('secondary').addEventListener('click', function () { act(state.mode === 'edit' ? 'revert' : 'clear'); });
  $('tertiary').addEventListener('click', function () { act('bake'); });

  function paintRange(el) {
    el.style.setProperty('--p', ((el.value - el.min) / (el.max - el.min) * 100) + '%');
  }

  // ---------------------------------------------------------------- render
  var MITER_HINTS = {
    smooth: 'Three or more rounded edges meet in a curved patch that follows the fillet radius.',
    sharp: 'Strips meet on a crisp miter; uneven corners get flat facets with hard edges.',
    blend: 'One soft quad loop runs around the corner and closes with a single flat face.'
  };

  function pressed(sel, attr, value) {
    all(sel).forEach(function (b) { b.setAttribute(attr, String(b.dataset.value === value || b.dataset.profile === value)); });
  }

  function render() {
    var p = state.params || {};
    var edit = state.mode === 'edit';
    $('mode-create').setAttribute('aria-pressed', String(!edit));
    $('mode-edit').setAttribute('aria-pressed', String(edit));
    $('edit-panel').hidden = !edit;

    pressed('.tile', 'aria-pressed', p.profile);
    pressed('[data-key="bevel_mode"] .chip', 'aria-pressed', p.bevel_mode);
    pressed('[data-key="interp"] .chip', 'aria-pressed', p.interp);
    pressed('[data-key="measure"] .chip', 'aria-pressed', p.measure);
    pressed('[data-key="material_mode"] .chip', 'aria-pressed', p.material_mode);
    pressed('[data-key="miter"] .tab', 'aria-selected', p.miter);
    $('miter-hint').textContent = MITER_HINTS[p.miter] || '';

    $('opt-conic').hidden = p.profile !== 'conic';
    $('opt-bevel').hidden = p.profile !== 'bevel';
    $('opt-custom').hidden = p.profile !== 'custom';
    $('steps-row').hidden = p.bevel_mode !== 'stepped';
    $('seg-row').hidden = p.profile === 'custom' || (p.profile === 'bevel' && p.bevel_mode !== 'facet');
    $('steps').textContent = p.steps;
    $('segments').textContent = p.segments;
    ['ratio', 'rho'].forEach(function (id) {
      if (document.activeElement !== $(id)) { $(id).value = p[id]; paintRange($(id)); }
      $(id + '-out').textContent = Number(p[id] || 0).toFixed(2);
    });
    $('custom-hint').textContent = p.custom_profile ? 'Profile loaded: ' + p.custom_profile.length +
      ' points. Pick again to replace it. Hold Shift while picking to flip the bulge.' :
      'Draw an open polyline or arc, then pick it. Hold Shift while picking to flip the bulge.';
    $('custom_smooth').checked = p.custom_smooth !== false;

    var L = state.lengths || {};
    if (document.activeElement !== $('radius')) $('radius').value = L.radius || '';
    if (document.activeElement !== $('radius_end')) $('radius_end').value = L.radius_end || '';
    $('variable').checked = !!p.variable;
    $('r2-wrap').hidden = !p.variable;
    $('interp-wrap').hidden = !p.variable;
    $('r1-label').textContent = p.variable ? 'Start radius' : (p.measure === 'setback' ? 'Setback' : 'Radius');

    var mats = state.materials || [];
    $('material').innerHTML = '<option value="">Choose a material</option>' + mats.map(function (m) {
      return '<option' + (m === p.material ? ' selected' : '') + '>' + esc(m) + '</option>';
    }).join('');
    $('material-wrap').hidden = p.material_mode !== 'assign';
    $('tags').innerHTML = (state.tags || []).map(function (t) { return '<option value="' + esc(t) + '">'; }).join('');
    if (document.activeElement !== $('tag')) $('tag').value = p.tag || '';
    $('uv').checked = !!p.uv;
    $('soften_boundary').checked = !!p.soften_boundary;
    $('clamp').checked = !!p.clamp;

    var s = state.stats || {};
    $('st-edges').textContent = s.edges || 0;
    $('st-chains').textContent = s.chains || 0;
    $('st-junctions').textContent = s.junctions || 0;
    $('st-clamped').textContent = s.clamped || 0;
    $('st-clamped').className = s.clamped ? 'warn' : '';

    if (edit) {
      var ops = state.ops || [];
      $('op').innerHTML = ops.map(function (o) {
        return '<option value="' + esc(o.id) + '"' + (o.id === state.op_id ? ' selected' : '') + '>' +
          esc(o.label) + (o.editable ? '' : ' (locked)') + '</option>';
      }).join('');
      $('edit-hint').hidden = ops.length > 0;
    }
    $('apply').textContent = edit ? 'Update fillet' : 'Apply fillet';
    $('secondary').textContent = edit ? 'Revert' : 'Clear selection';
    $('tertiary').hidden = !edit;
    $('apply').disabled = edit ? !state.op_id : !(s.edges > 0);

    setStatus(state.message || (state.mode === 'idle' ? 'Choose Create to round edges, or Edit to change a fillet.' : 'Ready'), false);
    $('version').textContent = state.version ? 'v' + state.version : '';
    drawProfile(p);
  }

  function setStatus(text, isError) {
    $('status').textContent = text;
    $('status').classList.toggle('error', !!isError);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  // ------------------------------------------------- 2D profile preview
  // Mirrors Profiles.unit for a 90 degree corner, in triangle coordinates:
  // point = apex + a*(start - apex) + b*(end - apex).
  function unitProfile(p) {
    var seg = Math.max(1, Math.min(64, p.segments || 6)), pts = [], i;
    function circle(n) {
      var out = [];
      for (i = 0; i <= n; i++) { var t = i / n * Math.PI / 2; out.push([1 - Math.sin(t), 1 - Math.cos(t)]); }
      return out;
    }
    switch (p.profile) {
      case 'conic':
        var r = Math.min(0.98, Math.max(0.02, p.rho || 0.5)), w = r / (1 - r);
        for (i = 0; i <= seg * 8; i++) {
          var t = i / (seg * 8), d = (1 - t) * (1 - t) + 2 * w * t * (1 - t) + t * t;
          pts.push([(1 - t) * (1 - t) / d, t * t / d]);
        }
        return pts;
      case 'cove': return circle(seg).map(function (q) { return [1 - q[1], 1 - q[0]]; });
      case 'custom': return (p.custom_profile && p.custom_profile.length > 1) ? p.custom_profile : [[1, 0], [0, 1]];
      case 'bevel':
        if (p.bevel_mode === 'facet') return circle(seg);
        if (p.bevel_mode === 'stepped') {
          var n = Math.max(1, p.steps || 3), a = 1, b = 0; pts = [[1, 0]];
          for (i = 0; i < n; i++) { a -= 1 / n; pts.push([a, b]); b += 1 / n; pts.push([a, b]); }
          return pts;
        }
        return [[1, 0], [0, 1]];
      default: return circle(seg);
    }
  }

  function drawProfile(p) {
    var svg = $('pv'); if (!svg || !p.profile) return;
    var ratio = p.profile === 'conic' ? (p.ratio || 1) : 1;
    // corner of a block: apex top-right, face 1 runs left, face 2 runs down
    var ox = 250, oy = 34, s = 110, sx = s, sy = s * ratio;
    if (sy > 130) { sx *= 130 / sy; sy = 130; }
    var pts = unitProfile(p).map(function (q) { return [ox - q[0] * sx, oy + q[1] * sy]; });
    var css = getComputedStyle(document.documentElement);
    var ink = css.getPropertyValue('--ink').trim(), blue = css.getPropertyValue('--blue-text').trim();
    var body = 'M30 ' + oy + ' L' + pts[0][0].toFixed(1) + ' ' + oy + ' ' +
      pts.map(function (q) { return 'L' + q[0].toFixed(1) + ' ' + q[1].toFixed(1); }).join(' ') +
      ' L' + ox + ' 172 L30 172 Z';
    var dots = pts.map(function (q) { return '<circle cx="' + q[0].toFixed(1) + '" cy="' + q[1].toFixed(1) + '" r="2" fill="' + blue + '"/>'; }).join('');
    svg.innerHTML =
      '<path d="M' + (ox - sx) + ' ' + oy + ' L' + ox + ' ' + oy + ' L' + ox + ' ' + (oy + sy) + '" fill="none" stroke="' + ink + '" stroke-width="1" stroke-dasharray="4 3" opacity=".55"/>' +
      '<path d="' + body + '" fill="var(--blue-tint)" stroke="' + ink + '" stroke-width="1.4"/>' +
      '<polyline points="' + pts.map(function (q) { return q[0].toFixed(1) + ',' + q[1].toFixed(1); }).join(' ') + '" fill="none" stroke="' + blue + '" stroke-width="2.4"/>' +
      dots +
      '<text x="30" y="22" style="font:400 10px var(--font-mono);fill:' + ink + '">' +
      esc(((state.lengths || {}).radius || '') + (p.variable ? ' to ' + ((state.lengths || {}).radius_end || '') : '')) + '</text>';
  }

  // ------------------------------------------------------------- public
  window.SC = {
    receive: function (s) {
      state = s || state;
      state.params = state.params || {};
      render();
    },
    error: function (msg) {
      setStatus(msg, true);
      ['radius', 'radius_end'].forEach(function (id) {
        if (/length|radius/i.test(msg) && document.activeElement !== $(id)) $(id).classList.add('invalid');
      });
    }
  };

  function demoState() {
    return window.__demo || {
      mode: 'create', version: '1.0.0', message: 'Preview outside SketchUp',
      params: { profile: 'circular', bevel_mode: 'chamfer', segments: 6, steps: 3, variable: false, interp: 'linear',
        ratio: 1, rho: 0.41, measure: 'radius', miter: 'smooth', material_mode: 'inherit', uv: true,
        soften_boundary: false, clamp: true, custom_smooth: true },
      lengths: { radius: '5 mm', radius_end: '12 mm' },
      stats: { edges: 4, chains: 1, junctions: 0, clamped: 0 }, materials: ['Oak', 'Steel'], tags: ['Fillets']
    };
  }

  bridge.ready();
})();
