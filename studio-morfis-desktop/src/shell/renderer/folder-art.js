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

  /* ----- folder illustration for the Files view (follows the theme through CSS variables) ----- */
  var uid = 0;
  function folder(o) {
    o = o || {};
    var id = 'fd' + (++uid), kinds = (o.kinds || []).slice(0, 2), full = (o.count || 0) > 0;
    var sheets = '';
    if (full) {
      sheets += '<g transform="rotate(-5 60 40)"><rect x="34" y="16" width="46" height="52" rx="4" fill="var(--fd-sheet2)"/>' + (kinds[1] ? tag(kinds[1], 40, 22) : '') + '</g>';
      sheets += '<g transform="rotate(4 80 40)"><rect x="54" y="12" width="46" height="56" rx="4" fill="var(--fd-sheet)"/>' + (kinds[0] ? tag(kinds[0], 60, 18) : '') +
        '<rect x="60" y="34" width="28" height="3" rx="1.5" fill="var(--fd-sheet-ink)"/><rect x="60" y="41" width="20" height="3" rx="1.5" fill="var(--fd-sheet-ink)"/></g>';
    }
    var badge = o.status ? '<g transform="translate(14 76)"><circle cx="9" cy="9" r="10" fill="var(--fd-front2)"/><svg x="0" y="0" width="18" height="18" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="' + (STATUS[o.status] || STATUS.not_started).color + '"/>' + glyph(o.status) + '</svg></g>' : '';
    return '<svg class="fd-art" viewBox="0 0 132 104" aria-hidden="true"><defs>' +
      '<linearGradient id="' + id + 'f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--fd-front)"/><stop offset="1" stop-color="var(--fd-front2)"/></linearGradient></defs>' +
      '<path d="M10 14a6 6 0 0 1 6-6h28a6 6 0 0 1 4.6 2.2l4.8 5.8H116a6 6 0 0 1 6 6v62a6 6 0 0 1-6 6H16a6 6 0 0 1-6-6z" fill="var(--fd-back)"/>' +
      sheets +
      '<path d="M8 38a6 6 0 0 1 6-6h104a6 6 0 0 1 6 6v52a6 6 0 0 1-6 6H14a6 6 0 0 1-6-6z" fill="url(#' + id + 'f)"/>' +
      '<path d="M14 32.5h104a5.5 5.5 0 0 1 5.5 5.5" fill="none" stroke="var(--fd-hi)" stroke-width="1"/>' + badge + '</svg>';
  }
  function tag(label, x, y) {
    var k = kindOf('a.' + label.toLowerCase()), w = Math.max(18, label.length * 5.6 + 6);
    return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="9" rx="2" fill="' + k.color + '"/><text x="' + (x + w / 2) + '" y="' + (y + 6.7) + '" text-anchor="middle" font-family="Segoe UI,Arial,sans-serif" font-size="6.2" font-weight="700" fill="#fff">' + k.label + '</text>';
  }

  /* ----- Explorer icon: a folder with the status badge, fixed colours, 256 px ----- */
  function explorerIcon(st) {
    var s = STATUS[st] || STATUS.not_started;
    return '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><defs>' +
      '<linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8A8F9C"/><stop offset="1" stop-color="#666B78"/></linearGradient>' +
      '<linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5A5E6A"/><stop offset="1" stop-color="#4A4E59"/></linearGradient></defs>' +
      '<path d="M16 46a12 12 0 0 1 12-12h62a12 12 0 0 1 9 4l11 12h118a12 12 0 0 1 12 12v134a12 12 0 0 1-12 12H28a12 12 0 0 1-12-12z" fill="url(#b)"/>' +
      '<rect x="44" y="52" width="150" height="110" rx="8" fill="#F2F2F5" transform="rotate(-3 120 100)"/>' +
      '<rect x="62" y="70" width="90" height="7" rx="3.5" fill="#C9CBD3" transform="rotate(-3 120 100)"/><rect x="62" y="86" width="64" height="7" rx="3.5" fill="#C9CBD3" transform="rotate(-3 120 100)"/>' +
      '<path d="M12 104a12 12 0 0 1 12-12h208a12 12 0 0 1 12 12v102a12 12 0 0 1-12 12H24a12 12 0 0 1-12-12z" fill="url(#f)"/>' +
      '<path d="M24 93h208a11 11 0 0 1 11 11" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="2"/>' +
      '<circle cx="196" cy="190" r="54" fill="#fff"/><circle cx="196" cy="190" r="46" fill="' + s.color + '"/>' +
      '<g transform="translate(160 154) scale(3)">' + glyph(st) + '</g></svg>';
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
    kindOf: kindOf, fileIcon: fileIcon, folder: folder, explorerIcon: explorerIcon, toPng: toPng, ICON_VERSION: 'v1' };
})();
