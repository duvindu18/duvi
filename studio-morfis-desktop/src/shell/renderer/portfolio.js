/* Portfolio maker: the studio's portfolio, in the Seedform brand, as A4 landscape pages.
   Add projects (from Direct projects, Freelance or by hand), edit their details for the portfolio, add pictures, and
   the pages lay themselves out: a cover, an about page, a contents page that keeps itself up to date, an opening page
   per project with its main picture, then its pictures arranged by shape, and a back page. Every page but the covers
   has the brand's header and a footer with the page number. Exported as a PDF from the same pages you see.
   Details edited here belong to the portfolio only: the project's own record is not changed. */
(function () {
  'use strict';
  var M = window.Morfis;
  if (!M) return;
  var H = M.H, esc = M.esc, ic = M.ic, pg = M.page;
  var D = null, IMG = {}, SEL = 'cover', EL = null, loading = null;
  var KEY = 'portfolio';

  /* ----- the record ----- */
  function defaults() {
    var s = (pg() && pg().S.settings) || {}, b = s.business || {};
    return {
      v: 1, title: 'Selected works', subtitle: 'Architecture, grown from an idea.', year: String(new Date().getFullYear()), cover: null,
      aboutTitle: 'About the studio', about: '', aboutImg: null,
      contact: { studio: s.studio || 'Seedform', address: b.address || '', email: b.email || '', phone: b.phone || '', website: b.website || '' },
      items: []
    };
  }
  function load() {
    if (loading) return loading;
    loading = Promise.resolve(H.kvGet(KEY)).then(function (v) {
      D = v && v.v ? v : defaults();
      D.items = D.items || []; D.contact = D.contact || defaults().contact;
      return refreshUrls();
    }).catch(function () { D = D || defaults(); });
    return loading;
  }
  /* picture links last for one run of the app: ask for them again */
  function allImgs() {
    var a = [D.cover, D.aboutImg].filter(Boolean);
    D.items.forEach(function (it) { a = a.concat(it.imgs || []); });
    return a;
  }
  function refreshUrls() {
    return Promise.all(allImgs().map(function (im) {
      if (IMG[im.c]) return null;
      return H.pfImage(im.file, im.c).then(function (r) { IMG[im.c] = r.url; }).catch(function () { im.missing = true; });
    }));
  }
  var saveT = 0;
  function save() { clearTimeout(saveT); saveT = setTimeout(function () { H.kvSet(KEY, D).catch(function () { M.toast('The portfolio could not be saved.'); }); }, 350); }
  /* A project's details follow the project (a new name, area or client shows up here) until you change that detail
     in the portfolio; from then on the portfolio keeps your wording. */
  var FOLLOW = { title: 1, location: 1, year: 1, type: 1, area: 1, client: 1, text: 1 };
  function source(it) {
    if (!it.ref || !pg()) return null;
    if (/^Freelance/.test(it.src || '')) { var all = window.MorfisFreelance ? window.MorfisFreelance.all() || {} : {}, j = all[it.ref] || Object.values(all).filter(function (x) { return x.id === it.ref; })[0]; return j ? fromJob(j) : null; }
    var p = pg().P(it.ref); return p ? fromProject(p) : null;
  }
  function follow() {
    var changed = false;
    (D ? D.items : []).forEach(function (it) {
      var f = source(it); if (!f) return;
      it.ed = it.ed || {};
      Object.keys(FOLLOW).forEach(function (k) { if (!it.ed[k] && f[k] && f[k] !== it[k]) { it[k] = f[k]; changed = true; } });
    });
    if (changed) save();
    return changed;
  }
  var item = function (id) { return D.items.filter(function (x) { return x.id === id; })[0]; };

  /* ----- page layout ----- */
  var ratio = function (im) { return im && im.w && im.h ? im.w / im.h : 1.5; };
  /* the pictures after the main one, grouped onto pages by their shape */
  function plan(imgs) {
    var out = [], i = 0, n = imgs.length;
    var land = function (im) { return ratio(im) >= 1.05; }, port = function (im) { return ratio(im) < 0.9; };
    while (i < n) {
      var a = imgs[i], rest = n - i;
      if (rest === 1 || ratio(a) >= 1.7) { out.push({ k: 'one', imgs: [a] }); i += 1; }
      else if (rest >= 3 && port(a) && port(imgs[i + 1]) && port(imgs[i + 2])) { out.push({ k: 'three', imgs: imgs.slice(i, i + 3) }); i += 3; }
      else if (rest >= 4 && imgs.slice(i, i + 4).every(function (x) { return ratio(x) >= 0.9 && ratio(x) < 1.7; })) { out.push({ k: 'four', imgs: imgs.slice(i, i + 4) }); i += 4; }
      else if (rest >= 3 && land(a) && land(imgs[i + 1]) && land(imgs[i + 2])) { out.push({ k: 'big', imgs: imgs.slice(i, i + 3) }); i += 3; }
      else { out.push({ k: 'two', imgs: imgs.slice(i, i + 2) }); i += 2; }
    }
    return out;
  }
  var ROWS = 9;   /* contents rows on one page */
  function pageList() {
    var P = [];
    P.push({ kind: 'cover', sec: 'cover' });
    P.push({ kind: 'about', sec: 'about', label: 'About' });
    var cn = Math.max(1, Math.ceil(D.items.length / ROWS));
    for (var c = 0; c < cn; c++) P.push({ kind: 'contents', sec: 'contents', label: 'Contents', part: c });
    D.items.forEach(function (it, ix) {
      var imgs = (it.imgs || []).slice(), main = imgs.filter(function (x) { return x.c === it.main; })[0] || imgs[0];
      it._start = P.length + 1;
      P.push({ kind: 'project', sec: it.id, label: it.title, it: it, n: ix + 1, main: main });
      plan(imgs.filter(function (x) { return x !== main; })).forEach(function (g) { P.push({ kind: 'pics', sec: it.id, label: it.title, it: it, n: ix + 1, g: g }); });
    });
    P.push({ kind: 'back', sec: 'back' });
    P.forEach(function (p, i) { p.no = i + 1; });
    return P;
  }

  /* ----- one page ----- */
  var two = function (n) { return (n < 10 ? '0' : '') + n; };
  var logo = function (cls) { return '<span class="pf-lg ' + (cls || '') + '"><b><span class="a">seed</span><span class="b">form</span></b><i></i></span>'; };
  function src(im, mode) { return !im ? '' : mode === 'pdf' ? 'pfimg:' + im.c : (IMG[im.c] || ''); }
  function pic(im, mode, cls, style) {
    if (!im) return '<div class="pf-ph ' + (cls || '') + '"' + (style ? ' style="' + style + '"' : '') + '><span>Add a picture</span></div>';
    return '<div class="pf-im ' + (cls || '') + '"' + (style ? ' style="' + style + '"' : '') + '><img src="' + esc(src(im, mode)) + '" alt=""></div>';
  }
  var paras = function (t) { return String(t || '').split(/\n\s*\n/).filter(function (x) { return x.trim(); }).map(function (x) { return '<p>' + esc(x.trim()).replace(/\n/g, '<br>') + '</p>'; }).join(''); };
  function meta(it) {
    var rows = [['Location', it.location], ['Year', it.year], ['Type', it.type], ['Area', it.area], ['Client', it.client], ['Our role', it.role], ['Status', it.status]].filter(function (r) { return r[1]; });
    return rows.length ? '<dl class="pf-dl">' + rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('') + '</dl>' : '';
  }
  function page(p, total, mode) {
    var body = '', chrome = p.kind !== 'cover' && p.kind !== 'back';
    if (p.kind === 'cover') {
      body = (D.cover ? pic(D.cover, mode, 'pf-cv-im') : '') +
        '<div class="pf-cv' + (D.cover ? ' has-im' : '') + '"><div class="pf-cv-top mono">Portfolio · ' + esc(D.year) + '</div>' +
        '<div class="pf-cv-bot">' + '<div class="pf-prim"><span class="a">seed</span><span class="r"><span class="b">form</span><i></i></span></div>' +
        '<h1>' + esc(D.title) + '</h1><p>' + esc(D.subtitle) + '</p></div></div>';
    } else if (p.kind === 'about') {
      var c = D.contact || {};
      var crow = [['Studio', c.studio], ['Address', c.address], ['Email', c.email], ['Phone', c.phone], ['Website', c.website]].filter(function (r) { return r[1]; });
      body = '<div class="pf-ab"><div class="pf-ab-t"><span class="pf-lbl">About</span><h2>' + esc(D.aboutTitle) + '</h2><div class="pf-txt pf-cols">' + paras(D.about) + '</div></div>' +
        '<div class="pf-ab-s">' + (D.aboutImg ? pic(D.aboutImg, mode, 'pf-ab-im') : '<div class="pf-ab-im pf-sand">' + logo('pf-lg-big') + '</div>') +
        (crow.length ? '<dl class="pf-dl pf-dl-c">' + crow.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('') + '</dl>' : '') + '</div></div>';
    } else if (p.kind === 'contents') {
      var rows = D.items.slice(p.part * ROWS, (p.part + 1) * ROWS);
      body = '<div class="pf-ct"><div class="pf-ct-h"><span class="pf-lbl">Contents</span><h2>Contents</h2></div><ol class="pf-ct-l">' +
        (rows.length ? rows.map(function (it, i) {
          var n = p.part * ROWS + i + 1;
          return '<li><span class="pf-ct-n mono">' + two(n) + '</span><span class="pf-ct-t"><b>' + esc(it.title || 'Untitled project') + '</b><em>' + esc([it.location, it.year].filter(Boolean).join(' · ')) + '</em></span><span class="pf-ct-p mono">' + two(it._start) + '</span></li>';
        }).join('') : '<li class="pf-ct-e">Projects you add appear here, with their page numbers.</li>') + '</ol></div>';
    } else if (p.kind === 'project') {
      var it = p.it;
      body = '<div class="pf-pj"><div class="pf-pj-t"><span class="pf-lbl"><b>' + two(p.n) + '</b> Project</span><h2>' + esc(it.title || 'Untitled project') + '</h2>' + meta(it) + '<div class="pf-txt">' + paras(it.text) + '</div></div>' +
        pic(p.main, mode, 'pf-pj-im') + '</div>';
    } else if (p.kind === 'pics') {
      var g = p.g;
      /* Pictures always run from the left margin to the right one (265 mm). Their height follows their shape, up to
         the 168 mm the page allows; a picture taller than that is trimmed top and bottom, never at the sides. */
      if (g.k === 'one') { var h1 = Math.min(168, 265 / ratio(g.imgs[0])); body = '<div class="pf-g pf-g-one">' + pic(g.imgs[0], mode, '', 'width:265mm;height:' + h1.toFixed(1) + 'mm') + '</div>'; }
      else if (g.k === 'two' || g.k === 'three') {
        var sum = g.imgs.reduce(function (a, im) { return a + ratio(im); }, 0), room = 265 - 4 * (g.imgs.length - 1), hmm = Math.min(168, room / sum);
        body = '<div class="pf-g pf-g-row">' + g.imgs.map(function (im) { return pic(im, mode, '', 'width:' + (room * ratio(im) / sum).toFixed(2) + 'mm;height:' + hmm.toFixed(1) + 'mm'); }).join('') + '</div>';
      }
      else if (g.k === 'four') body = '<div class="pf-g pf-g-four">' + g.imgs.map(function (im) { return pic(im, mode); }).join('') + '</div>';
      else body = '<div class="pf-g pf-g-big">' + pic(g.imgs[0], mode, 'pf-g-a') + pic(g.imgs[1], mode) + pic(g.imgs[2], mode) + '</div>';
    } else if (p.kind === 'back') {
      var cc = D.contact || {};
      body = '<div class="pf-bk"><span class="pf-mono"><b><span class="a">s</span><span class="b">f</span></b><i></i></span>' +
        '<p class="mono">' + esc([cc.email, cc.phone, cc.website].filter(Boolean).join('   ·   ') || (cc.studio || 'Seedform')) + '</p></div>';
    }
    var hd = chrome ? '<header class="pf-hd">' + logo() + '<span class="pf-sec mono">' + esc(p.kind === 'pics' || p.kind === 'project' ? two(p.n) + ' · ' + (p.label || '') : p.label || '') + '</span></header>' : '';
    var ft = chrome ? '<footer class="pf-ft"><span class="mono">' + esc((D.contact && D.contact.studio) || 'Seedform') + ' · Portfolio ' + esc(D.year) + '</span><span class="pf-no mono"><b>' + two(p.no) + '</b> / ' + two(total) + '</span></footer>' : '';
    return '<section class="pf-pg pf-k-' + p.kind + '" data-pf-sel="' + esc(p.sec) + '" data-pf-no="' + p.no + '">' + hd + '<div class="pf-body">' + body + '</div>' + ft + '</section>';
  }

  /* the pages' own styles: the same in the app and in the PDF */
  var CSS =
    '.pf-pg{--lw:#F4F1EA;--rz:#FBFAF6;--sand:#E2D6BF;--ln:#D3CBBA;--ink:#22231F;--mu:#5A5D52;--cn:#1F3B2D;--sp:#5E8A4C;--spl:#8DBB78;--lt:#A84E33;' +
      'width:297mm;height:210mm;position:relative;overflow:hidden;box-sizing:border-box;background:var(--lw);color:var(--ink);font-family:Manrope,"Segoe UI",sans-serif;font-size:10pt;line-height:1.5;break-after:page;page-break-after:always}' +
    '.pf-pg *{box-sizing:border-box}.pf-pg .mono{font-family:"IBM Plex Mono",ui-monospace,monospace}' +
    '.pf-pg h1,.pf-pg h2{font-family:"Playfair Display",Georgia,serif;font-weight:500;letter-spacing:-.01em;margin:0}' +
    '.pf-lg{display:inline-flex;align-items:baseline;gap:.09em;font-size:11pt;line-height:1;color:var(--cn);white-space:nowrap}.pf-lg b,.pf-mono b{font-weight:400;letter-spacing:-.02em}' +
    '.pf-pg .a{font-family:Inter,"Segoe UI",sans-serif;font-weight:600}.pf-pg .b{font-family:"Archivo Black","Arial Black",sans-serif;font-weight:400}' +
    '.pf-lg i,.pf-mono i,.pf-prim i{display:inline-block;width:.3em;height:.3em;border-radius:50%;background:var(--sp)}' +
    '.pf-hd{position:absolute;left:16mm;right:16mm;top:9mm;height:8mm;display:flex;align-items:center;justify-content:space-between;border-bottom:.25mm solid var(--ln)}' +
    '.pf-sec,.pf-ft{font-size:6.8pt;letter-spacing:.14em;text-transform:uppercase;color:var(--mu)}' +
    '.pf-ft{position:absolute;left:16mm;right:16mm;bottom:8mm;height:6mm;display:flex;align-items:center;justify-content:space-between;border-top:.25mm solid var(--ln)}' +
    '.pf-no b{color:var(--ink);font-weight:500}' +
    '.pf-body{position:absolute;left:16mm;right:16mm;top:23mm;bottom:19mm}' +
    '.pf-k-cover .pf-body,.pf-k-back .pf-body{inset:0}' +
    '.pf-im{overflow:hidden;background:var(--sand)}.pf-im img{width:100%;height:100%;object-fit:cover;display:block}' +
    '.pf-ph{background:var(--sand);display:grid;place-items:center;color:var(--mu);font:7pt "IBM Plex Mono",monospace;letter-spacing:.14em;text-transform:uppercase}' +
    '.pf-lbl{display:block;font:500 6.8pt "IBM Plex Mono",monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--mu);margin-bottom:4mm}.pf-lbl b{color:var(--sp);font-weight:500;margin-right:2mm}' +
    '.pf-txt p{margin:0 0 2.6mm}.pf-cols{column-count:2;column-gap:8mm}' +
    '.pf-dl{display:grid;grid-template-columns:22mm 1fr;margin:0 0 6mm;border-top:.25mm solid var(--ln)}.pf-dl dt,.pf-dl dd{margin:0;padding:1.6mm 0;border-bottom:.25mm solid var(--ln)}' +
    '.pf-dl dt{font:500 6.4pt/1.9 "IBM Plex Mono",monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--mu)}.pf-dl dd{font-size:9pt}' +
    /* cover */
    '.pf-k-cover{background:var(--cn);color:var(--lw)}' +
    '.pf-cv{position:absolute;inset:0;padding:14mm 16mm 16mm;display:flex;flex-direction:column;justify-content:space-between}.pf-cv.has-im{right:46%}' +
    '.pf-cv-im{position:absolute;top:0;right:0;bottom:0;width:46%}' +
    '.pf-cv-top{font-size:7pt;letter-spacing:.16em;text-transform:uppercase;color:rgba(244,241,234,.72)}' +
    '.pf-prim{display:flex;flex-direction:column;align-items:flex-start;gap:.6mm;color:var(--lw);margin-bottom:10mm}.pf-prim .a{font-size:22pt;line-height:1;letter-spacing:-.02em;margin-left:.6mm}' +
    '.pf-prim .r{display:flex;align-items:baseline;gap:1.4mm}.pf-prim .b{font-size:50pt;line-height:.86;letter-spacing:-.02em}.pf-prim i{background:var(--spl)}' +
    '.pf-cv h1{font-size:30pt;line-height:1.08;max-width:150mm}.pf-cv p{margin:3mm 0 0;font-size:11pt;color:rgba(244,241,234,.78)}' +
    /* about */
    '.pf-ab{display:grid;grid-template-columns:1fr 92mm;gap:14mm;height:100%}.pf-ab h2{font-size:26pt;margin-bottom:7mm}' +
    '.pf-ab-s{display:flex;flex-direction:column;gap:6mm;min-height:0}.pf-ab-im{flex:1;min-height:0}.pf-sand{background:var(--sand);display:grid;place-items:center}.pf-lg-big{font-size:26pt}' +
    '.pf-dl-c{margin:0}' +
    /* contents */
    '.pf-ct{display:grid;grid-template-columns:80mm 1fr;gap:14mm;height:100%}.pf-ct h2{font-size:26pt}' +
    '.pf-ct-l{list-style:none;margin:0;padding:0;border-top:.25mm solid var(--ln)}.pf-ct-l li{display:flex;align-items:baseline;gap:6mm;padding:3.2mm 0;border-bottom:.25mm solid var(--ln)}' +
    '.pf-ct-n{font-size:8pt;color:var(--sp);width:8mm}.pf-ct-t{flex:1;display:flex;flex-direction:column}.pf-ct-t b{font:500 14pt/1.2 "Playfair Display",Georgia,serif}.pf-ct-t em{font-style:normal;color:var(--mu);font-size:8.5pt}' +
    '.pf-ct-p{font-size:9pt}.pf-ct-e{color:var(--mu)}' +
    /* a project's opening page */
    '.pf-pj{display:grid;grid-template-columns:84mm 1fr;gap:10mm;height:100%}.pf-pj-t{min-height:0;overflow:hidden}.pf-pj h2{font-size:24pt;line-height:1.12;margin-bottom:6mm}.pf-pj-im{height:100%}' +
    '.pf-pj .pf-txt{font-size:9pt}' +
    /* picture pages */
    '.pf-g{height:100%;display:flex;gap:4mm}.pf-g>*{min-width:0;min-height:0}' +
    '.pf-g-one{align-items:center;justify-content:center}' +
    '.pf-g-row{align-items:center;justify-content:space-between}.pf-g-row>*{flex:none}' +
    '.pf-g-four{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr}' +
    '.pf-g-big{display:grid;grid-template-columns:2fr 1fr;grid-template-rows:1fr 1fr}.pf-g-a{grid-row:span 2}' +
    /* back page */
    '.pf-k-back{background:var(--cn);color:var(--lw)}.pf-bk{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12mm}' +
    '.pf-mono{display:inline-flex;align-items:baseline;gap:.07em;font-size:64pt;line-height:.86;letter-spacing:-.03em;color:var(--lw)}.pf-mono i{background:var(--spl)}' +
    '.pf-bk p{margin:0;font-size:7.5pt;letter-spacing:.14em;color:rgba(244,241,234,.72)}';

  function docHtml(mode) {
    var P = pageList();
    return '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(D.title) + '</title><style>/*PF-FONTS*/@page{size:297mm 210mm;margin:0}html,body{margin:0;padding:0;background:#F4F1EA;-webkit-print-color-adjust:exact;print-color-adjust:exact}' + CSS + '.pf-pg:last-child{break-after:auto;page-break-after:auto}</style></head><body>' +
      P.map(function (p) { return page(p, P.length, mode); }).join('') + '</body></html>';
  }

  /* ----- the editor ----- */
  function sections() {
    var row = function (id, name, sub, tools, drag) {
      return '<div class="pf-row' + (SEL === id ? ' on' : '') + (drag ? ' pf-dr" draggable="true" data-pf-drag="' + esc(id) + '" title="Drag to reorder' : '') + '">' + (drag ? '<span class="pf-grip" aria-hidden="true"></span>' : '') + '<button type="button" class="pf-row-b" data-pf-sel="' + esc(id) + '"><b>' + esc(name) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '') + '</button>' + (tools || '') + '</div>';
    };
    return '<div class="pf-secs">' + row('cover', 'Cover', D.title) + row('about', 'About', D.aboutTitle) + row('contents', 'Contents', 'Updates itself') +
      D.items.map(function (it, i) {
        return row(it.id, two(i + 1) + '  ' + (it.title || 'Untitled project'), (it.imgs || []).length + ' picture' + ((it.imgs || []).length === 1 ? '' : 's'),
          '<span class="pf-tools"><button type="button" class="icon-btn" data-pf-mv="-1" data-id="' + esc(it.id) + '" aria-label="Move up" title="Move up"' + (i ? '' : ' disabled') + '>' + ic('chev', 14).replace('<svg', '<svg style="transform:rotate(180deg)"') + '</button>' +
          '<button type="button" class="icon-btn" data-pf-mv="1" data-id="' + esc(it.id) + '" aria-label="Move down" title="Move down"' + (i < D.items.length - 1 ? '' : ' disabled') + '>' + ic('chev', 14) + '</button></span>', true);
      }).join('') + row('back', 'Back page', 'Contact details') +
      '<button type="button" class="btn sm pf-add" data-pf-act="add">' + ic('plus', 14) + 'Add a project</button></div>';
  }
  var fld = function (label, key, val, o) {
    o = o || {};
    return '<label class="field' + (o.wide ? ' pf-wide' : '') + '"><span class="fl">' + esc(label) + '</span>' + (o.area ? '<textarea class="in" rows="' + (o.rows || 6) + '" data-pf-f="' + key + '" placeholder="' + esc(o.ph || '') + '">' + esc(val || '') + '</textarea>' :
      '<input class="in" data-pf-f="' + key + '" value="' + esc(val || '') + '" placeholder="' + esc(o.ph || '') + '">') + '</label>';
  };
  var oneImg = function (slot, im, label) {
    return '<div class="pf-slot"><span class="fl">' + esc(label) + '</span>' + (im ? '<div class="pf-thumb"><img src="' + esc(IMG[im.c] || '') + '" alt=""><button type="button" class="icon-btn" data-pf-clear="' + slot + '" aria-label="Remove the picture" title="Remove">' + ic('x', 14) + '</button></div>' : '') +
      '<button type="button" class="btn sm" data-pf-pick="' + slot + '">' + ic('upload', 14) + (im ? 'Change the picture' : 'Choose a picture') + '</button></div>';
  };
  function form() {
    if (SEL === 'cover') return '<h3>Cover</h3><div class="pf-fields">' + fld('Title', 'title', D.title, { wide: true }) + fld('Line under the title', 'subtitle', D.subtitle, { wide: true }) + fld('Year', 'year', D.year) + '</div>' + oneImg('cover', D.cover, 'Cover picture');
    if (SEL === 'about') {
      var c = D.contact || {};
      return '<h3>About</h3><div class="pf-fields">' + fld('Heading', 'aboutTitle', D.aboutTitle, { wide: true }) +
        fld('About the studio', 'about', D.about, { wide: true, area: true, rows: 8, ph: 'A few lines on how the studio works, what it cares about and the projects it takes on. Leave a blank line between paragraphs.' }) +
        fld('Studio', 'c.studio', c.studio) + fld('Website', 'c.website', c.website) + fld('Email', 'c.email', c.email) + fld('Phone', 'c.phone', c.phone) + fld('Address', 'c.address', c.address, { wide: true }) + '</div>' + oneImg('aboutImg', D.aboutImg, 'Picture on the about page');
    }
    if (SEL === 'contents') return '<h3>Contents</h3><p class="small muted">The contents page lists every project in the order you set, with the page it starts on. It updates itself when you add, remove or reorder projects, or when a project gains pages.</p>';
    if (SEL === 'back') return '<h3>Back page</h3><p class="small muted">The monogram, with the email, phone and website from the about page.</p>';
    var it = item(SEL);
    if (!it) { SEL = 'cover'; return form(); }
    var imgs = it.imgs || [], main = it.main || (imgs[0] && imgs[0].c);
    return '<h3>' + esc(it.title || 'Untitled project') + '</h3>' + (it.src ? '<p class="small muted">Started from ' + esc(it.src) + '. Changes here are for the portfolio only.</p>' : '') +
      '<div class="pf-fields">' + fld('Project name', 'i.title', it.title, { wide: true }) + fld('Location', 'i.location', it.location) + fld('Year', 'i.year', it.year) + fld('Type', 'i.type', it.type) + fld('Area', 'i.area', it.area, { ph: '210 m²' }) +
      fld('Client', 'i.client', it.client) + fld('Our role', 'i.role', it.role, { ph: 'Architecture and interiors' }) + fld('Status', 'i.status', it.status, { ph: 'Completed 2025' }) +
      fld('About the project', 'i.text', it.text, { wide: true, area: true, rows: 6, ph: 'The idea, the site and what makes the project worth showing.' }) + '</div>' +
      '<div class="fx-sec-h" style="margin:6px 0 8px"><h3 style="margin:0">Pictures</h3><span class="count">' + imgs.length + '</span></div>' +
      '<div class="pf-imgs">' + imgs.map(function (im, i) {
        return '<div class="pf-thumb' + (im.c === main ? ' main' : '') + (im.missing ? ' missing' : '') + '" draggable="true" data-pf-dragimg="' + i + '" title="' + esc((im.name ? im.name + ' · ' : '') + 'drag to reorder') + '"><img src="' + esc(IMG[im.c] || '') + '" alt="">' + (im.c === main ? '<span class="pf-main">Main</span>' : '') +
          '<span class="pf-th-tools">' + (im.c === main ? '' : '<button type="button" class="icon-btn" data-pf-main="' + i + '" aria-label="Use as the main picture" title="Use as the main picture">' + ic('check', 13) + '</button>') +
          '<button type="button" class="icon-btn" data-pf-img="-1" data-i="' + i + '" aria-label="Move earlier" title="Move earlier"' + (i ? '' : ' disabled') + '>' + ic('chevR', 13).replace('<svg', '<svg style="transform:scaleX(-1)"') + '</button>' +
          '<button type="button" class="icon-btn" data-pf-img="1" data-i="' + i + '" aria-label="Move later" title="Move later"' + (i < imgs.length - 1 ? '' : ' disabled') + '>' + ic('chevR', 13) + '</button>' +
          '<button type="button" class="icon-btn" data-pf-rm="' + i + '" aria-label="Remove from the portfolio" title="Remove from the portfolio">' + ic('x', 13) + '</button></span></div>';
      }).join('') + '<button type="button" class="pf-addimg" data-pf-pick="item">' + ic('plus', 18) + '<span>Add pictures</span></button></div>' +
      '<p class="small muted">The main picture opens the project. The others are arranged by shape: wide ones get a page of their own, upright ones sit side by side.</p>' +
      '<div class="toolbar" style="margin-top:12px"><button type="button" class="btn sm" data-pf-act="remove">' + ic('trash', 14) + 'Remove from the portfolio</button></div>';
  }
  /* the pages are drawn in a frame of their own, so the app's styles cannot reach them: what you see is the PDF */
  var FACES = "@font-face{font-family:'Playfair Display';font-weight:400 900;src:url(vendor/fonts/playfair/playfair-display-latin-wght-normal.woff2)}" +
    "@font-face{font-family:'Manrope';font-weight:200 800;src:url(vendor/fonts/manrope/manrope-latin-wght-normal.woff2)}" +
    "@font-face{font-family:'IBM Plex Mono';font-weight:400;src:url(vendor/fonts/plexmono/ibm-plex-mono-latin-400-normal.woff2)}" +
    "@font-face{font-family:'IBM Plex Mono';font-weight:500;src:url(vendor/fonts/plexmono/ibm-plex-mono-latin-500-normal.woff2)}" +
    "@font-face{font-family:'Inter';font-weight:100 900;src:url(vendor/inter/inter-latin-wght-normal.woff2)}" +
    "@font-face{font-family:'Archivo Black';src:url(vendor/fonts/archivo/archivo-black-latin-400-normal.woff2)}";
  function thumbs() {
    var P = pageList();
    return P.map(function (p) { return '<div class="pf-th' + (p.sec === SEL ? ' on' : '') + '" data-pf-sel="' + esc(p.sec) + '" title="Page ' + p.no + '"><div class="pf-scale">' + page(p, P.length, 'app') + '</div><span class="pf-th-n">' + two(p.no) + '</span></div>'; }).join('');
  }
  function frameDoc() {
    var cs = getComputedStyle(document.documentElement), v = function (n, d) { return (cs.getPropertyValue(n) || '').trim() || d; };
    return '<!doctype html><html><head><meta charset="utf-8"><style>' + FACES +
      ':root{--line:' + v('--line', '#D3CBBA') + ';--ink2:' + v('--ink-2', '#5A5D52') + ';--on:' + v('--sf-sprout', '#5E8A4C') + '}' +
      'html,body{margin:0;background:transparent}body{padding:3px 3px 24px}' +
      '.pf-grid{display:grid;grid-template-columns:repeat(auto-fill,260px);gap:30px 18px}' +
      '.pf-th{position:relative;width:260px;height:184px;cursor:pointer;outline:1px solid var(--line)}.pf-th:hover{outline-color:var(--ink2)}' +
      '.pf-th.on{outline:2px solid var(--on);outline-offset:1px}.pf-th>.pf-scale{width:297mm;height:210mm;overflow:hidden;transform:scale(.2316);transform-origin:0 0;pointer-events:none}' +
      '.pf-th-n{position:absolute;left:0;top:190px;font:500 10.5px "IBM Plex Mono",monospace;color:var(--ink2)}' +
      CSS + '</style></head><body><div class="pf-grid" id="g">' + thumbs() + '</div></body></html>';
  }
  function fit() { var f = EL && EL.querySelector('#pfFrame'), d = f && f.contentDocument; if (d && d.body) f.style.height = d.documentElement.scrollHeight + 'px'; }
  function mountFrame() {
    var f = EL.querySelector('#pfFrame');
    if (!f) return;
    f.onload = function () {
      var d = f.contentDocument;
      d.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('[data-pf-sel]'); if (b) { SEL = b.dataset.pfSel; draw(); } });
      fit(); d.fonts.ready.then(fit); Array.prototype.forEach.call(d.images, function (i) { i.addEventListener('load', fit); });
      f.dataset.ready = '1';
    };
    f.srcdoc = frameDoc();
  }
  function pmeta() { return '<span><b>' + pageList().length + '</b> pages · A4 landscape</span><span class="muted">Click a page to edit it</span>'; }
  function updateFrame() {
    var f = EL && EL.querySelector('#pfFrame'), d = f && f.contentDocument, g = d && d.getElementById('g'), m = EL.querySelector('#pfMeta');
    if (m) m.innerHTML = pmeta();
    if (!g) return mountFrame();
    g.innerHTML = thumbs(); fit(); Array.prototype.forEach.call(d.images, function (i) { if (!i.complete) i.addEventListener('load', fit); });
  }
  function view() {
    return '<div class="fx-head"><div><h1>Portfolio</h1><p class="muted">Projects and pictures, laid out on the Seedform pages: cover, about, contents, header, footer and page numbers.</p></div>' +
      '<div class="toolbar"><button type="button" class="btn" data-pf-act="add">' + ic('plus', 15) + 'Add a project</button><button type="button" class="btn primary" data-pf-act="pdf">Export PDF' + ic('pdf', 15) + '</button></div></div>' +
      '<div class="pf-wrap"><aside class="pf-ed card" id="pfEd">' + editor() + '</aside><div class="pf-prev"><div class="pf-pmeta" id="pfMeta">' + pmeta() + '</div><iframe class="pf-frame" id="pfFrame" title="The portfolio pages"></iframe></div></div>';
  }
  var editor = function () { return sections() + '<div class="pf-form" id="pfForm">' + form() + '</div>'; };
  /* redraw: the editor and the pages; the frame stays, so the pages do not flash */
  function draw() {
    if (!EL || M.current() !== 'portfolio') return;
    if (!D) { EL.innerHTML = '<div class="fx-empty">Opening the portfolio…</div>'; load().then(draw); return; }
    follow();
    var ed = EL.querySelector('#pfEd');
    if (ed) { var y = ed.scrollTop; ed.innerHTML = editor(); ed.scrollTop = y; updateFrame(); }
    else { EL.innerHTML = view(); mountFrame(); }
    M.crumb();
  }
  var pT = 0;
  function redrawPreview(now) {
    clearTimeout(pT);
    pT = setTimeout(function () {
      var se = EL && EL.querySelector('.pf-secs');
      if (se) se.outerHTML = sections();
      updateFrame();
    }, now ? 0 : 180);
  }

  /* ----- adding projects and pictures ----- */
  function fromProject(p) {
    return { id: M.uid('pf'), src: 'Direct projects · ' + p.code, ref: p.id, title: p.name || '', location: p.location || '', year: String(p.startDate || p.createdAt || '').slice(0, 4),
      type: p.type || '', area: p.gfa ? p.gfa + ' m²' : '', client: (p.client && p.client.name) || '', role: '', status: '', text: p.brief || p.description || '', imgs: [] };
  }
  function fromJob(j) {
    return { id: M.uid('pf'), src: 'Freelance · ' + j.code, ref: j.id, title: j.title || '', location: j.location || '', year: String(j.created || j.createdAt || j.start || '').slice(0, 4),
      type: j.type || '', area: '', client: j.client || '', role: '', status: '', text: j.brief || j.notes || '', imgs: [] };
  }
  function addProject() {
    var used = {}; D.items.forEach(function (it) { if (it.ref) used[it.ref] = 1; });
    var ps = Object.values(pg().S.projects).filter(function (p) { return !used[p.id]; });
    var js = (window.MorfisFreelance ? Object.values(window.MorfisFreelance.all() || {}) : []).filter(function (j) { return !used[j.id]; });
    var opt = function (kind, id, code, name, sub) { return '<button type="button" class="pf-pick" data-pf-from="' + kind + ':' + esc(id) + '"><span class="mono">' + esc(code) + '</span><b>' + esc(name) + '</b><em>' + esc(sub || '') + '</em></button>'; };
    M.modal('Add a project to the portfolio',
      '<div class="pf-picks">' + (ps.length ? '<span class="fl">Direct projects</span>' + ps.map(function (p) { return opt('p', p.id, p.code, p.name, [p.location, p.type].filter(Boolean).join(' · ')); }).join('') : '') +
      (js.length ? '<span class="fl">Freelance</span>' + js.map(function (j) { return opt('j', j.id, j.code, j.title || 'Untitled job', j.client); }).join('') : '') +
      '<span class="fl">Something else</span>' + opt('n', 'new', '+', 'A project not in the app', 'Competition entries, older work, personal projects') + '</div>');
    setTimeout(function () {
      document.querySelectorAll('[data-pf-from]').forEach(function (b) {
        b.addEventListener('click', function () {
          var k = b.dataset.pfFrom.split(':'), it;
          if (k[0] === 'p') it = fromProject(pg().P(k[1]));
          else if (k[0] === 'j') it = fromJob((window.MorfisFreelance.all() || {})[k[1]] || Object.values(window.MorfisFreelance.all()).filter(function (j) { return j.id === k[1]; })[0]);
          else it = { id: M.uid('pf'), title: '', location: '', year: D.year, type: '', area: '', client: '', role: '', status: '', text: '', imgs: [] };
          D.items.push(it); SEL = it.id; save(); pg().closeModal(); draw();
        });
      });
    }, 0);
  }
  function addImages(files) {
    return Promise.all(files.map(function (f) { return H.pfImage(f).then(function (r) { IMG[r.c] = r.url; return { c: r.c, w: r.w, h: r.h, file: f, name: r.name }; }).catch(function (e) { M.toast((e && e.message) || 'A picture could not be added.'); return null; }); }))
      .then(function (a) { return a.filter(Boolean); });
  }
  function folderOf(it) {
    try {
      var x = it && it.ref && pg().P(it.ref);
      if (x && x.foldersCreated) return pg().projDir(x);
    } catch (e) { /* none */ }
    return (pg().S.settings || {}).root;
  }
  function pick(slot) {
    var it = item(SEL);
    H.pickFiles({ title: 'Choose pictures', defaultPath: folderOf(it), filters: [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'png'] }] }).then(function (files) {
      if (!files || !files.length) return;
      if (slot !== 'item') files = files.slice(0, 1);
      return addImages(files).then(function (a) {
        if (!a.length) return;
        if (slot === 'item' && it) { it.imgs = (it.imgs || []).concat(a); if (!it.main) it.main = it.imgs[0].c; M.toast(a.length + ' picture' + (a.length === 1 ? '' : 's') + ' added and placed on the pages.'); }
        else D[slot] = a[0];
        save(); draw();
      });
    });
  }
  function exportPdf() {
    M.toast('Making the PDF…');
    H.savePortfolioPdf(docHtml('pdf'), ((D.contact && D.contact.studio) || 'Seedform') + ' Portfolio ' + D.year + '.pdf').then(function (f) { if (f) M.toast('Saved ' + String(f).split(/[\\/]/).pop() + '.'); })
      .catch(function (e) { M.toast('The PDF could not be made: ' + ((e && e.message) || e)); });
  }

  /* ----- events ----- */
  function bind(el) {
    if (el.dataset.pfBound) return;
    el.dataset.pfBound = '1';
    el.addEventListener('click', function (e) {
      if (M.current() !== 'portfolio' || !D) return;
      var t = e.target, b, it = item(SEL);
      if ((b = t.closest('[data-pf-act]'))) {
        var a = b.dataset.pfAct;
        if (a === 'add') addProject();
        else if (a === 'pdf') exportPdf();
        else if (a === 'remove' && it && window.confirm('Remove “' + (it.title || 'this project') + '” from the portfolio? The project itself and its pictures stay as they are.')) { D.items = D.items.filter(function (x) { return x !== it; }); SEL = 'contents'; save(); draw(); }
        return;
      }
      if ((b = t.closest('[data-pf-mv]'))) { var i = D.items.indexOf(item(b.dataset.id)), j = i + (+b.dataset.pfMv); if (i < 0 || j < 0 || j >= D.items.length) return; var x = D.items.splice(i, 1)[0]; D.items.splice(j, 0, x); save(); draw(); return; }
      if ((b = t.closest('[data-pf-pick]'))) { pick(b.dataset.pfPick); return; }
      if ((b = t.closest('[data-pf-clear]'))) { D[b.dataset.pfClear] = null; save(); draw(); return; }
      if (it && (b = t.closest('[data-pf-main]'))) { it.main = it.imgs[+b.dataset.pfMain].c; save(); draw(); return; }
      if (it && (b = t.closest('[data-pf-img]'))) { var k = +b.dataset.i, m = k + (+b.dataset.pfImg); if (m < 0 || m >= it.imgs.length) return; var y = it.imgs.splice(k, 1)[0]; it.imgs.splice(m, 0, y); save(); draw(); return; }
      if (it && (b = t.closest('[data-pf-rm]'))) { var r = it.imgs.splice(+b.dataset.pfRm, 1)[0]; if (r && it.main === r.c) it.main = it.imgs[0] && it.imgs[0].c; save(); draw(); return; }
      if ((b = t.closest('[data-pf-sel]'))) { SEL = b.dataset.pfSel; draw(); }
    });
    /* drag to reorder: projects in the list, pictures in a project; pages, contents and numbers follow at once */
    var DR = null;
    var clearMarks = function () { el.querySelectorAll('.pf-before,.pf-after').forEach(function (x) { x.classList.remove('pf-before', 'pf-after'); }); };
    el.addEventListener('dragstart', function (e) {
      var r = e.target.closest && e.target.closest('[data-pf-drag],[data-pf-dragimg]');
      if (!r || M.current() !== 'portfolio') return;
      DR = r.dataset.pfDrag ? { kind: 'item', id: r.dataset.pfDrag } : { kind: 'img', i: +r.dataset.pfDragimg };
      r.classList.add('pf-dragging');
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'pf'); } catch (x) { /* fine */ }
    });
    var target = function (e) { return DR && e.target.closest && e.target.closest(DR.kind === 'item' ? '[data-pf-drag]' : '[data-pf-dragimg]'); };
    el.addEventListener('dragover', function (e) {
      var t = target(e); if (!t) return;
      e.preventDefault();
      var bx = t.getBoundingClientRect(), after = DR.kind === 'item' ? e.clientY > bx.top + bx.height / 2 : e.clientX > bx.left + bx.width / 2;
      clearMarks(); t.classList.add(after ? 'pf-after' : 'pf-before');
    });
    el.addEventListener('drop', function (e) {
      var t = target(e); if (!t) return;
      e.preventDefault();
      var after = t.classList.contains('pf-after'), list, from, to;
      if (DR.kind === 'item') { list = D.items; from = list.indexOf(item(DR.id)); to = list.indexOf(item(t.dataset.pfDrag)); }
      else { var it = item(SEL); if (!it) return; list = it.imgs; from = DR.i; to = +t.dataset.pfDragimg; }
      if (from < 0 || to < 0) return;
      var x = list.splice(from, 1)[0];
      if (from < to) to--;
      list.splice(after ? to + 1 : to, 0, x);
      DR = null; clearMarks(); save(); draw();
    });
    el.addEventListener('dragend', function () { DR = null; clearMarks(); el.querySelectorAll('.pf-dragging').forEach(function (x) { x.classList.remove('pf-dragging'); }); });
    el.addEventListener('input', function (e) {
      var k = e.target.dataset && e.target.dataset.pfF;
      if (M.current() !== 'portfolio' || !k || !D) return;
      var v = e.target.value;
      if (k.indexOf('c.') === 0) D.contact[k.slice(2)] = v;
      else if (k.indexOf('i.') === 0) { var it = item(SEL); if (it) { it[k.slice(2)] = v; it.ed = it.ed || {}; it.ed[k.slice(2)] = 1; } }
      else D[k] = v;
      save(); redrawPreview();
    });
  }

  M.register('portfolio', {
    title: 'Portfolio', placeholder: 'Search',
    crumb: function () { var it = D && item(SEL); return 'Portfolio' + (it ? ' / ' + (it.title || 'Untitled project') : ''); },
    render: function (el, o) { EL = el; bind(el); EL.innerHTML = ''; if (o && o.sel) SEL = o.sel; draw(); },
    refresh: function () { if (D && follow() && !(document.activeElement && document.activeElement.closest && document.activeElement.closest('.pf-form'))) draw(); },
    search: function () { /* nothing to search */ }
  });
  window.MorfisPortfolio = { html: function (mode) { return D ? docHtml(mode || 'pdf') : ''; }, pages: function () { return D ? pageList().length : 0; }, data: function () { return D; }, load: load, addImages: addImages, reload: function () { loading = null; D = null; return load().then(draw); } };
})();
