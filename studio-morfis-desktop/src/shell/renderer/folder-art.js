/* Shared artwork for the desktop views: project work status, folder illustrations, file-type icons, and the status
   icons Windows shows on project folders in File Explorer. Pure functions that return SVG text. */
(function () {
  'use strict';

  /* Work status of a project. Terms follow common project-management usage. */
  var STATUS = {
    not_started: { label: 'Not started', color: '#8B8B97', tone: 'neutral', hint: 'Signed or planned, work has not begun' },
    in_progress: { label: 'In progress', color: '#5B9BF0', tone: 'info', hint: 'Work is under way' },
    on_hold: { label: 'On hold', color: '#E4A23C', tone: 'warn', hint: 'Paused, waiting on the client, approvals or funds' },
    completed: { label: 'Completed', color: '#3FB68B', tone: 'good', hint: 'Handed over and closed' },
    cancelled: { label: 'Cancelled', color: '#F06272', tone: 'bad', hint: 'Stopped and will not continue' }
  };
  var ORDER = ['in_progress', 'not_started', 'on_hold', 'completed', 'cancelled'];

  /* the status set on the project, or one worked out from it */
  function statusOf(p, today) {
    if (p && STATUS[p.workStatus]) return p.workStatus;
    if (!p) return 'not_started';
    if (p.status === 'closed') return 'completed';
    var start = p.stages && p.stages[0] && p.stages[0].start;
    var anyDone = (p.tasks || []).some(function (t) { return t.status !== 'todo'; });
    if (start && today && start > today && !anyDone) return 'not_started';
    return 'in_progress';
  }

  /* ----- status glyphs, drawn on a 24 px grid ----- */
  function glyph(st, c) {
    c = c || '#fff';
    if (st === 'completed') return '<path d="M7 12.4l3.2 3.2L17 8.8" fill="none" stroke="' + c + '" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>';
    if (st === 'on_hold') return '<path d="M9.5 8v8M14.5 8v8" stroke="' + c + '" stroke-width="2.6" stroke-linecap="round"/>';
    if (st === 'cancelled') return '<path d="M8.6 8.6l6.8 6.8M15.4 8.6l-6.8 6.8" stroke="' + c + '" stroke-width="2.4" stroke-linecap="round"/>';
    if (st === 'not_started') return '<path d="M8 12h8" stroke="' + c + '" stroke-width="2.4" stroke-linecap="round"/>';
    return '<path d="M12 6.8V12l3.4 2.2" fill="none" stroke="' + c + '" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>';
  }
  function statusDot(st, size) {
    var s = STATUS[st] || STATUS.not_started;
    size = size || 14;
    return '<svg class="st-ic" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="' + s.color + '"/>' + glyph(st) + '</svg>';
  }
  function statusTag(st, extra) {
    var s = STATUS[st] || STATUS.not_started;
    return '<span class="st-tag st-' + s.tone + '" title="' + s.hint + '">' + statusDot(st, 12) + s.label + (extra || '') + '</span>';
  }

  /* ----- file types ----- */
  var KINDS = {
    pdf: ['PDF', '#E5484D'], dwg: ['DWG', '#3E8EDE'], dxf: ['DXF', '#3E8EDE'], rvt: ['RVT', '#2F7DD1'], ifc: ['IFC', '#2F7DD1'], pln: ['PLN', '#2F7DD1'],
    skp: ['SKP', '#E0663D'], '3dm': ['3DM', '#8D6AF0'], max: ['MAX', '#3AA394'], blend: ['BLND', '#E0883D'], psd: ['PSD', '#3192E8'], ai: ['AI', '#E8913A'],
    jpg: ['JPG', '#9C6AF0'], jpeg: ['JPG', '#9C6AF0'], png: ['PNG', '#9C6AF0'], heic: ['HEIC', '#9C6AF0'], webp: ['WEBP', '#9C6AF0'], tif: ['TIF', '#9C6AF0'],
    xls: ['XLS', '#2DA36A'], xlsx: ['XLS', '#2DA36A'], csv: ['CSV', '#2DA36A'], doc: ['DOC', '#3B7BE0'], docx: ['DOC', '#3B7BE0'], ppt: ['PPT', '#E06A3D'], pptx: ['PPT', '#E06A3D'],
    mp4: ['MP4', '#D9588A'], mov: ['MOV', '#D9588A'], zip: ['ZIP', '#8B8B97'], rar: ['RAR', '#8B8B97'], txt: ['TXT', '#8B8B97']
  };
  function kindOf(name) {
    var ext = (/\.([^.]+)$/.exec(String(name || '')) || [])[1];
    ext = ext ? ext.toLowerCase() : '';
    var k = KINDS[ext];
    return { ext: ext, label: k ? k[0] : (ext.slice(0, 4).toUpperCase() || 'FILE'), color: k ? k[1] : '#8B8B97' };
  }
  function fileIcon(name, size) {
    var k = kindOf(name);
    size = size || 30;
    return '<svg class="file-ic" width="' + size + '" height="' + size + '" viewBox="0 0 32 32" aria-hidden="true">' +
      '<path d="M8 3h11l7 7v17a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="var(--fi-bg,#24242A)" stroke="var(--fi-line,#34343C)"/>' +
      '<path d="M19 3v5a2 2 0 0 0 2 2h5" fill="none" stroke="var(--fi-line,#34343C)"/>' +
      '<rect x="3" y="16" width="' + Math.max(16, k.label.length * 5.4 + 6) + '" height="9" rx="2" fill="' + k.color + '"/>' +
      '<text x="' + (3 + Math.max(16, k.label.length * 5.4 + 6) / 2) + '" y="22.7" text-anchor="middle" font-family="Segoe UI,Arial,sans-serif" font-size="6.4" font-weight="700" fill="#fff">' + k.label + '</text></svg>';
  }

  /* ----- the folder artwork: one drawing for the app and for File Explorer, so both always match -----
     o: { status (project folders), num ('01'..'06' for the standard folders), full (has files), kind ('PDF', 'DWG'…) } */
  var PAL = { back: '#3D3F48', front: '#5A5E69', front2: '#464954', hi: 'rgba(255,255,255,.2)', sheet: '#F2F2F5', sheet2: '#CFD1D8', ink: '#C4C6CE', ring: '#FFFFFF' };
  var uid = 0;
  function art(o) {
    o = o || {};
    var id = 'fa' + (++uid), sheets = '';
    if (o.full) {
      sheets = '<g transform="rotate(-5 60 40)"><rect x="32" y="15" width="48" height="54" rx="4" fill="' + PAL.sheet2 + '"/></g>' +
        '<g transform="rotate(4 80 40)"><rect x="52" y="11" width="48" height="58" rx="4" fill="' + PAL.sheet + '"/>' + (o.kind ? tag(o.kind, 58, 17) : '<rect x="58" y="19" width="26" height="4" rx="2" fill="' + PAL.ink + '"/>') +
        '<rect x="58" y="32" width="30" height="3.4" rx="1.7" fill="' + PAL.ink + '"/><rect x="58" y="39" width="22" height="3.4" rx="1.7" fill="' + PAL.ink + '"/></g>';
    }
    var badge = '';
    if (o.status) {
      /* project root folders: the status written out on a coloured label across the front */
      var st = STATUS[o.status] || STATUS.not_started, txt = st.label.toUpperCase();
      var ink = o.status === 'on_hold' ? '#2B1C00' : '#FFFFFF', fs = txt.length > 9 ? 12.4 : 13.6;
      badge = '<rect x="14" y="60" width="104" height="27" rx="7" fill="' + st.color + '"/>' +
        '<text x="66" y="78.4" text-anchor="middle" font-family="Segoe UI,Arial,sans-serif" font-size="' + fs + '" font-weight="800" letter-spacing=".4" fill="' + ink + '">' + txt + '</text>';
    } else if (o.num) {
      badge = '<rect x="15" y="65" width="42" height="23" rx="6" fill="rgba(255,255,255,.2)"/><text x="36" y="81.8" text-anchor="middle" font-family="Segoe UI,Arial,sans-serif" font-size="15.5" font-weight="700" fill="#fff">' + o.num + '</text>';
    }
    return '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + PAL.front + '"/><stop offset="1" stop-color="' + PAL.front2 + '"/></linearGradient></defs>' +
      '<path d="M10 14a6 6 0 0 1 6-6h28a6 6 0 0 1 4.6 2.2l4.8 5.8H116a6 6 0 0 1 6 6v62a6 6 0 0 1-6 6H16a6 6 0 0 1-6-6z" fill="' + PAL.back + '"/>' + sheets +
      '<path d="M8 38a6 6 0 0 1 6-6h104a6 6 0 0 1 6 6v52a6 6 0 0 1-6 6H14a6 6 0 0 1-6-6z" fill="url(#' + id + ')"/>' +
      '<path d="M14 32.6h104a5.4 5.4 0 0 1 5.4 5.4" fill="none" stroke="' + PAL.hi + '" stroke-width="1.2"/>' + badge;
  }
  /* the variant a folder is drawn as, from what is in it; the same key names its Explorer icon */
  function variant(o) {
    o = o || {};
    var kind = (o.kinds || [])[0] || '', full = (o.count || 0) > 0;
    return { status: o.status || '', num: o.num || '', full: full, kind: full ? kind : '',
      key: (o.status ? 'st-' + o.status : 'f-' + (o.num || 'x')) + '-' + (full ? (kind ? kind.toLowerCase() : 'files') : 'empty') };
  }
  /* the main file kinds in a list of files ({ name }), most common first */
  function kindsOf(files) {
    var n = {};
    (files || []).forEach(function (f) { var k = kindOf(f.name).label; if (k !== 'FILE') n[k] = (n[k] || 0) + 1; });
    return Object.keys(n).sort(function (a, b) { return n[b] - n[a]; }).slice(0, 2);
  }
  /* in the app: o = { status | num, count, kinds } */
  function folder(o) { return '<svg class="fd-art" viewBox="0 0 132 104" aria-hidden="true">' + art(variant(o)) + '</svg>'; }
  function tag(label, x, y) {
    var k = kindOf('a.' + label.toLowerCase()), w = Math.max(18, label.length * 5.6 + 6);
    return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="9" rx="2" fill="' + k.color + '"/><text x="' + (x + w / 2) + '" y="' + (y + 6.7) + '" text-anchor="middle" font-family="Segoe UI,Arial,sans-serif" font-size="6.2" font-weight="700" fill="#fff">' + k.label + '</text>';
  }
  /* for File Explorer: the same drawing, square, 256 px */
  function explorerIcon(o) {
    if (typeof o === 'string') o = { status: o, count: 1 };
    return '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><g transform="translate(0 27) scale(1.9394)">' + art(variant(o)) + '</g></svg>';
  }

  /* SVG text -> PNG data URL, drawn at size x size */
  function toPng(svg, size) {
    size = size || 256;
    return new Promise(function (res, rej) {
      var img = new Image();
      img.onload = function () {
        var c = document.createElement('canvas'); c.width = size; c.height = size;
        c.getContext('2d').drawImage(img, 0, 0, size, size);
        res(c.toDataURL('image/png'));
      };
      img.onerror = function () { rej(new Error('Could not draw the icon.')); };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
  }

  window.MorfisArt = { STATUS: STATUS, ORDER: ORDER, statusOf: statusOf, statusDot: statusDot, statusTag: statusTag, glyph: glyph,
    kindOf: kindOf, fileIcon: fileIcon, folder: folder, variant: variant, kindsOf: kindsOf, explorerIcon: explorerIcon, toPng: toPng, ICON_VERSION: 'v4' };
})();
