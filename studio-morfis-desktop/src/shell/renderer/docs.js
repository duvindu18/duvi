/* Invoices & quotes: a list of every quotation and invoice, and an editor that shows the document as the A4 page it
   will print as. Lines, client details, dates, tax, discount and notes are edited on the page itself or in the panel
   beside it; PDF export and printing use the same page. Milestone invoices stay linked to the dashboard's payments. */
(function () {
  'use strict';
  var M = window.Morfis;
  if (!M) return;
  var H = M.H, esc = M.esc, ic = M.ic, pg = M.page;
  var DOCS = [], loaded = false;
  var D = { tab: 'all', q: '', open: null, saveT: null, saved: true };

  var TYPE = { quote: 'Quotation', invoice: 'Invoice' };
  var QSTATUS = { draft: ['Draft', 'neutral'], sent: ['Sent', 'info'], accepted: ['Accepted', 'good'], declined: ['Declined', 'bad'], expired: ['Expired', 'warn'] };
  var ISTATUS = { draft: ['Draft', 'neutral'], issued: ['Issued', 'info'], pending: ['Awaiting payment', 'warn'], overdue: ['Overdue', 'bad'], paid: ['Paid', 'good'], void: ['Void', 'neutral'] };
  var UNITS = ['item', 'lump sum', 'sqft', 'sqm', 'hour', 'day', 'visit', 'set', 'sheet', 'nos', '%'];

  function load() { return H.docsList().then(function (l) { DOCS = l || []; loaded = true; M.redrawSide(); return DOCS; }, function () { loaded = true; return DOCS; }); }
  function byId(id) { return DOCS.find(function (d) { return d.id === id; }); }
  function save(d, now) {
    d.updated = new Date().toISOString();
    if (DOCS.indexOf(d) === -1) DOCS.push(d);
    D.saved = false; savedMark();
    clearTimeout(D.saveT);
    var go = function () { H.docSave(JSON.parse(JSON.stringify(d))).then(function () { D.saved = true; savedMark(); M.redrawSide(); }, function (e) { M.toast('Could not save: ' + (e && e.message ? e.message : 'unknown error')); }); };
    if (now) go(); else D.saveT = setTimeout(go, 450);
  }
  function remove(d) { DOCS = DOCS.filter(function (x) { return x !== d; }); H.docDelete(d.id); M.redrawSide(); }
  function savedMark() { var s = document.getElementById('edSaved'); if (s) { s.textContent = D.saved ? 'Saved' : 'Saving…'; s.classList.toggle('busy', !D.saved); } }

  /* ----- money and totals ----- */
  var num = function (v) { var n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : 0; };
  function fmt(n, cur) { n = Math.round(num(n) * 100) / 100; var s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }); return (cur ? cur + ' ' : '') + (n < 0 ? '−' : '') + s; }
  function totals(d) {
    var sub = d.items.reduce(function (a, it) { return a + num(it.qty) * num(it.rate); }, 0);
    var disc = d.discountPct ? sub * num(d.discountPct) / 100 : num(d.discount);
    var taxable = Math.max(0, sub - disc), pct = num(d.taxPct), tax = 0, total = taxable;
    if (d.taxMode === 'added') { tax = taxable * pct / 100; total = taxable + tax; }
    else if (d.taxMode === 'included') tax = pct > 0 ? taxable * pct / (100 + pct) : 0;
    var ret = d.type === 'invoice' ? total * num(d.retainPct) / 100 : 0;
    return { sub: sub, disc: disc, taxable: taxable, tax: tax, total: total, retain: ret, due: total - ret };
  }

  /* ----- numbering ----- */
  var pad = function (n, w) { n = String(n); while (n.length < (w || 2)) n = '0' + n; return n; };
  function nextNo(type, p) {
    var year = new Date().getFullYear();
    if (p) {
      var head = / I /.test(p.code) ? p.code + (type === 'quote' ? ' I QT ' : ' I INV A') : p.code + (type === 'quote' ? '/QT-' : '/INV-A');
      var used = DOCS.filter(function (d) { return d.no && d.no.indexOf(head) === 0; }).map(function (d) { return +d.no.slice(head.length) || 0; });
      return head + pad((used.length ? Math.max.apply(null, used) : 0) + 1);
    }
    var pre = (type === 'quote' ? 'QT-' : 'INV-') + year + '-';
    var n = DOCS.filter(function (d) { return d.no && d.no.indexOf(pre) === 0; }).map(function (d) { return +d.no.slice(pre.length) || 0; });
    return pre + pad((n.length ? Math.max.apply(null, n) : 0) + 1, 3);
  }

  /* ----- making documents ----- */
  function settings() { return pg().S.settings; }
  function blank(type, p) {
    var s = settings(), b = s.business || {}, today = pg().today();
    return {
      id: M.uid(type === 'quote' ? 'q' : 'i'), type: type, no: nextNo(type, p), status: 'draft', title: p ? p.name : '',
      pid: p ? p.id : '', mid: '', clientName: p && p.client ? p.client.name || '' : '', clientContact: p && p.client ? p.client.contact || '' : '', clientAddress: '',
      projectName: p ? p.name : '', projectLocation: p ? p.location || '' : '',
      issued: today, due: type === 'invoice' ? M.addDays(today, +s.termsDays || 14) : '', validUntil: type === 'quote' ? M.addDays(today, 30) : '',
      ref: '', currency: s.currency || 'LKR',
      items: [{ id: M.uid('l'), desc: '', detail: '', qty: 1, unit: 'item', rate: 0 }],
      discount: 0, discountPct: 0, taxMode: num(b.taxPct) > 0 ? 'included' : 'none', taxPct: num(b.taxPct), retainPct: 0,
      notes: type === 'quote' ? 'Fees cover the scope listed above. Work outside this scope is quoted separately.' : '',
      terms: type === 'quote' ? 'This quotation is valid until the date shown. 20% of the fee is payable on acceptance, the balance at each stage as invoiced.' : (b.notes || ''),
      showBank: type === 'invoice', created: new Date().toISOString(), updated: ''
    };
  }
  /* the editor copy of a dashboard milestone invoice: one line for the milestone, linked by pid + mid */
  function forMilestone(pid, mid) {
    var p = pg().P(pid), m = p && p.milestones.find(function (x) { return x.id === mid; });
    if (!m) return null;
    var d = DOCS.find(function (x) { return x.pid === pid && x.mid === mid; });
    if (d) return d;
    var idx = p.milestones.indexOf(m), st = pg().STAGES[m.stage - 1], amt = pg().milestoneAmount(p, idx);
    d = blank('invoice', p);
    d.mid = mid;
    d.no = m.invoice ? m.invoice.no : pg().invoiceNo(p, idx);
    if (m.invoice) { d.issued = m.invoice.issued; d.due = m.invoice.due; d.ref = m.invoice.ref || ''; d.status = 'issued'; }
    d.items = [{ id: M.uid('l'), desc: m.label + ' · ' + m.pct + '% of the contract', detail: 'Stage ' + m.stage + ', ' + st.name + '. Contract value ' + fmt(p.budget, d.currency) + '.', qty: 1, unit: 'lump sum', rate: amt }];
    d.retainPct = p.retainPct || 0;
    d.notes = m.invoice && m.invoice.note ? m.invoice.note : '';
    return d;
  }
  function milestoneOf(d) { var p = d.pid && pg().P(d.pid); return p && d.mid ? { p: p, m: p.milestones.find(function (x) { return x.id === d.mid; }) } : null; }
  function liveStatus(d) {
    if (d.type === 'quote') { if (d.status === 'sent' && d.validUntil && d.validUntil < pg().today()) return 'expired'; return d.status; }
    var lk = milestoneOf(d);
    if (lk && lk.m && lk.m.invoice) { var st = pg().invoiceInfo(lk.p, lk.p.milestones.indexOf(lk.m), pg().today()).status; return st === 'paid' ? 'paid' : st === 'overdue' ? 'overdue' : 'pending'; }
    if (d.status === 'issued' && d.due && d.due < pg().today()) return 'overdue';
    return d.status;
  }
  function statusTag(d) { var st = liveStatus(d), m = (d.type === 'quote' ? QSTATUS : ISTATUS)[st] || ['Draft', 'neutral']; return '<span class="st-tag st-' + m[1] + '"><i class="st-pip"></i>' + m[0] + '</span>'; }

  /* ===== list ===== */
  function rows() {
    var list = DOCS.slice(), q = D.q.trim().toLowerCase();
    /* milestone invoices issued in the dashboard but never opened here */
    Object.values(pg().S.projects).forEach(function (p) {
      p.milestones.forEach(function (m) { if (m.invoice && !DOCS.some(function (d) { return d.pid === p.id && d.mid === m.id; })) list.push({ virtual: true, id: 'v:' + p.id + ':' + m.id, type: 'invoice', no: m.invoice.no, pid: p.id, mid: m.id, clientName: (p.client && p.client.name) || '', projectName: p.name, issued: m.invoice.issued, due: m.invoice.due, status: 'issued', currency: settings().currency, _amt: pg().milestoneAmount(p, p.milestones.indexOf(m)) }); });
    });
    list = list.filter(function (d) {
      if (D.tab === 'quote' && d.type !== 'quote') return false;
      if (D.tab === 'invoice' && d.type !== 'invoice') return false;
      if (D.tab === 'draft' && d.status !== 'draft') return false;
      return !q || [d.no, d.clientName, d.projectName, d.title].join(' ').toLowerCase().indexOf(q) !== -1;
    });
    return list.sort(function (a, b) { return String(b.issued || '').localeCompare(String(a.issued || '')) || String(b.no).localeCompare(String(a.no)); });
  }
  function listView() {
    var list = rows(), all = DOCS.length, cur = settings().currency || 'LKR';
    var openQ = DOCS.filter(function (d) { return d.type === 'quote' && liveStatus(d) === 'sent'; });
    var drafts = DOCS.filter(function (d) { return d.status === 'draft'; });
    var fin = { overdue: 0, billedPending: 0 };
    Object.values(pg().S.projects).forEach(function (p) { var f = pg().projectFinance(p, pg().today()); fin.overdue += f.overdue; fin.billedPending += f.billedPending; });
    DOCS.forEach(function (d) { if (d.type === 'invoice' && !d.mid && (liveStatus(d) === 'issued' || liveStatus(d) === 'overdue')) { var t = totals(d).due; if (liveStatus(d) === 'overdue') fin.overdue += t; else fin.billedPending += t; } });
    var tab = function (k, l, n) { return '<button type="button" class="tab' + (D.tab === k ? ' on' : '') + '" data-doc-tab="' + k + '">' + l + (n != null ? ' <span class="faint">' + n + '</span>' : '') + '</button>'; };
    var body = list.length ? '<div class="fx-table dc-table" role="table"><div class="fx-tr fx-th" role="row"><span>Number</span><span>Client and project</span><span>Date</span><span>Status</span><span class="num">Amount</span><span></span></div>' +
      list.map(function (d) {
        var amt = d.virtual ? d._amt : totals(d).total;
        return '<div class="fx-tr" role="row" data-doc-open="' + esc(d.id) + '"><span class="dc-no"><span class="dc-kind ' + d.type + '">' + (d.type === 'quote' ? 'QT' : 'INV') + '</span><b class="mono">' + esc(d.no) + '</b></span>' +
          '<span class="dc-who"><b>' + esc(d.clientName || 'No client yet') + '</b><em>' + esc(d.projectName || d.title || '') + '</em></span>' +
          '<span class="muted">' + esc(M.fdate(d.issued)) + '</span><span>' + statusTag(d) + '</span><span class="num mono">' + esc(fmt(amt, d.currency || cur)) + '</span>' +
          '<span class="fx-acts">' + (d.virtual ? '' : '<button type="button" class="icon-btn" data-doc-menu="' + esc(d.id) + '" title="More">' + ic('dots', 15) + '</button>') + '</span></div>';
      }).join('') + '</div>' :
      '<div class="dc-empty">' + ic('documents', 28) + '<b>' + (all ? 'Nothing here for this filter' : 'No invoices or quotations yet') + '</b><span class="muted small">Make a quotation for a new client, or an invoice for a project milestone or extra work.</span>' +
      '<div class="toolbar"><button type="button" class="btn primary" data-doc-new="quote">' + ic('plus', 15) + 'New quotation</button><button type="button" class="btn" data-doc-new="invoice">New invoice</button></div></div>';
    return '<div class="fx-head"><div><h1>Invoices & quotes</h1><p class="muted">Write, edit and export quotations and invoices. Milestone invoices stay linked to Payments.</p></div>' +
      '<div class="toolbar"><button type="button" class="btn" data-doc-new="invoice">' + ic('plus', 15) + 'New invoice</button><button type="button" class="btn primary" data-doc-new="quote">' + ic('plus', 15) + 'New quotation</button></div></div>' +
      '<div class="dc-stats"><div class="dc-stat"><span>Quotes awaiting an answer</span><b>' + openQ.length + '</b><em>' + esc(fmt(openQ.reduce(function (a, d) { return a + totals(d).total; }, 0), cur)) + '</em></div>' +
      '<div class="dc-stat"><span>Drafts</span><b>' + drafts.length + '</b><em>' + (drafts.length ? 'Review and send' : 'All sent') + '</em></div>' +
      '<div class="dc-stat"><span>Invoiced, not yet paid</span><b>' + esc(fmt(fin.billedPending + fin.overdue, cur)) + '</b><em class="' + (fin.overdue ? 'bad-t' : '') + '">' + (fin.overdue ? esc(fmt(fin.overdue, cur)) + ' overdue' : 'Nothing overdue') + '</em></div></div>' +
      '<div class="tabs" role="tablist">' + tab('all', 'All', null) + tab('quote', 'Quotations', DOCS.filter(function (d) { return d.type === 'quote'; }).length) + tab('invoice', 'Invoices', null) + tab('draft', 'Drafts', drafts.length) + '</div>' + body;
  }

  /* ===== the page itself ===== */
  function studio() {
    var s = settings(), b = s.business || {};
    return { name: s.studio || 'Studio', tagline: b.tagline || '', address: String(b.address || '').split(/\r?\n/).filter(Boolean), phone: b.phone || '', email: b.email || '', website: b.website || '',
      taxLabel: b.taxLabel || 'Tax', taxNo: b.taxNo || '', bank: [['Bank', b.bankName], ['Account name', b.accName], ['Account number', b.accNo], ['Branch', b.branch], ['SWIFT', b.swift]].filter(function (x) { return x[1]; }),
      accent: s.accent || '#7C6CF0', logo: pg().brandIcon ? pg().brandIcon() : '' };
  }
  /* mode 'edit' draws inputs on the page; mode 'print' draws plain text for the PDF and the printer */
  function paper(d, mode) {
    var E = mode === 'edit', st = studio(), t = totals(d), cur = d.currency;
    var inp = function (k, v, ph, cls) { return E ? '<input class="pp-in ' + (cls || '') + '" data-f="' + k + '" value="' + esc(v) + '" placeholder="' + esc(ph || '') + '" spellcheck="true">' : '<span class="' + (cls || '') + '">' + esc(v) + '</span>'; };
    var area = function (k, v, ph, cls) { return E ? '<textarea class="pp-in pp-area ' + (cls || '') + '" data-f="' + k + '" rows="1" placeholder="' + esc(ph || '') + '">' + esc(v) + '</textarea>' : (v ? '<div class="' + (cls || '') + '">' + esc(v).replace(/\n/g, '<br>') + '</div>' : ''); };
    var dateRow = function (label, k) { return d[k] || E ? '<div class="pp-kv"><span>' + label + '</span>' + (E ? '<input class="pp-in pp-date" type="date" data-f="' + k + '" value="' + esc(d[k]) + '">' : '<b>' + esc(M.fdate(d[k])) + '</b>') + '</div>' : ''; };
    var lines = d.items.map(function (it, i) {
      var amt = num(it.qty) * num(it.rate);
      return '<tr class="pp-line" data-line="' + it.id + '"><td class="pp-c-n">' + (i + 1) + '</td>' +
        '<td class="pp-c-d">' + (E ? '<textarea class="pp-in pp-area pp-desc" data-l="desc" rows="1" placeholder="Describe the work">' + esc(it.desc) + '</textarea><textarea class="pp-in pp-area pp-sub" data-l="detail" rows="1" placeholder="Details (optional)">' + esc(it.detail) + '</textarea>'
          : '<div class="pp-desc">' + esc(it.desc) + '</div>' + (it.detail ? '<div class="pp-sub">' + esc(it.detail).replace(/\n/g, '<br>') + '</div>' : '')) + '</td>' +
        '<td class="pp-c-q">' + (E ? '<input class="pp-in pp-num" data-l="qty" value="' + esc(it.qty) + '" inputmode="decimal">' : esc(fmt(it.qty))) + '</td>' +
        '<td class="pp-c-u">' + (E ? '<input class="pp-in" data-l="unit" value="' + esc(it.unit) + '" list="ppUnits">' : esc(it.unit)) + '</td>' +
        '<td class="pp-c-r">' + (E ? '<input class="pp-in pp-num" data-l="rate" value="' + esc(it.rate) + '" inputmode="decimal">' : esc(fmt(it.rate))) + '</td>' +
        '<td class="pp-c-a">' + esc(fmt(amt)) + (E ? '<button type="button" class="pp-x" data-del-line="' + it.id + '" title="Remove this line" tabindex="-1">' + ic('x', 13) + '</button>' : '') + '</td></tr>';
    }).join('');
    var tot = '<div class="pp-tot">' +
      '<div class="pp-kv"><span>Subtotal</span><b>' + esc(fmt(t.sub, cur)) + '</b></div>' +
      (t.disc ? '<div class="pp-kv"><span>Discount' + (d.discountPct ? ' (' + num(d.discountPct) + '%)' : '') + '</span><b>− ' + esc(fmt(t.disc, cur)) + '</b></div>' : '') +
      (d.taxMode === 'added' ? '<div class="pp-kv"><span>' + esc(st.taxLabel) + ' ' + num(d.taxPct) + '%</span><b>' + esc(fmt(t.tax, cur)) + '</b></div>' : '') +
      '<div class="pp-kv pp-grand"><span>Total</span><b>' + esc(fmt(t.total, cur)) + '</b></div>' +
      (d.taxMode === 'included' && t.tax ? '<div class="pp-kv pp-note"><span>Includes ' + esc(st.taxLabel) + ' ' + num(d.taxPct) + '%</span><b>' + esc(fmt(t.tax, cur)) + '</b></div>' : '') +
      (t.retain ? '<div class="pp-kv"><span>Retention ' + num(d.retainPct) + '%</span><b>− ' + esc(fmt(t.retain, cur)) + '</b></div><div class="pp-kv pp-grand"><span>Amount due</span><b>' + esc(fmt(t.due, cur)) + '</b></div>' : '') + '</div>';
    return '<article class="pp' + (E ? ' pp-edit' : '') + '" style="--pp-acc:' + esc(st.accent) + '">' +
      '<div class="pp-band"></div>' +
      '<header class="pp-head"><div class="pp-from">' + (st.logo ? '<img class="pp-logo" src="' + esc(st.logo) + '" alt="">' : '') + '<div><div class="pp-studio">' + esc(st.name) + '</div>' +
        (st.tagline ? '<div class="pp-muted">' + esc(st.tagline) + '</div>' : '') + st.address.map(function (a) { return '<div class="pp-muted">' + esc(a) + '</div>'; }).join('') +
        '<div class="pp-muted">' + esc([st.phone, st.email, st.website].filter(Boolean).join('  ·  ')) + '</div>' + (st.taxNo ? '<div class="pp-muted">' + esc(st.taxLabel) + ' reg. no. ' + esc(st.taxNo) + '</div>' : '') + '</div></div>' +
        '<div class="pp-title"><div class="pp-kind">' + TYPE[d.type] + '</div>' + inp('no', d.no, 'Number', 'pp-no') +
        dateRow(d.type === 'quote' ? 'Date' : 'Issued', 'issued') + (d.type === 'quote' ? dateRow('Valid until', 'validUntil') : dateRow('Due', 'due')) +
        (d.ref || E ? '<div class="pp-kv"><span>Reference</span>' + inp('ref', d.ref, 'PO or reference') + '</div>' : '') + '</div></header>' +
      '<section class="pp-parties"><div><div class="pp-label">' + (d.type === 'quote' ? 'Prepared for' : 'Bill to') + '</div>' + inp('clientName', d.clientName, 'Client name', 'pp-strong') + area('clientAddress', d.clientAddress, 'Address') + inp('clientContact', d.clientContact, 'Phone or email') + '</div>' +
        '<div><div class="pp-label">Project</div>' + inp('projectName', d.projectName, 'Project name', 'pp-strong') + inp('projectLocation', d.projectLocation, 'Site location') + (d.pid ? '<span class="pp-muted">' + esc((pg().P(d.pid) || {}).code || '') + '</span>' : '') + '</div></section>' +
      '<table class="pp-items"><thead><tr><th class="pp-c-n">#</th><th class="pp-c-d">Description</th><th class="pp-c-q">Qty</th><th class="pp-c-u">Unit</th><th class="pp-c-r">Rate</th><th class="pp-c-a">Amount (' + esc(cur) + ')</th></tr></thead><tbody>' + lines + '</tbody></table>' +
      (E ? '<div class="pp-addrow"><button type="button" class="pp-add" data-add-line>' + ic('plus', 14) + 'Add a line</button><button type="button" class="pp-add" data-add-line="section">' + ic('plus', 14) + 'Add a stage of work</button></div>' : '') +
      '<div class="pp-bottom"><div class="pp-notes">' + (d.notes || E ? '<div class="pp-label">Notes</div>' + area('notes', d.notes, 'Anything the client should know') : '') +
        (d.terms || E ? '<div class="pp-label">' + (d.type === 'quote' ? 'Terms' : 'Payment terms') + '</div>' + area('terms', d.terms, 'Payment terms') : '') +
        (d.showBank && st.bank.length ? '<div class="pp-label">Pay to</div><div class="pp-bank">' + st.bank.map(function (b) { return '<span>' + esc(b[0]) + '</span><b>' + esc(b[1]) + '</b>'; }).join('') + '</div>' : '') + '</div>' + tot + '</div>' +
      '<footer class="pp-foot">' + esc(st.name) + (d.type === 'quote' ? '  ·  Thank you for considering us' : '  ·  Thank you') + '</footer>' +
      (E ? '<datalist id="ppUnits">' + UNITS.map(function (u) { return '<option value="' + u + '">'; }).join('') + '</datalist>' : '') + '</article>';
  }

  /* complete stand-alone HTML for the PDF and the printer: same page, Inter embedded, no scripts */
  var FONT = null;
  function fontCss() {
    if (FONT !== null) return Promise.resolve(FONT);
    return fetch('vendor/inter/inter-latin-wght-normal.woff2').then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
      var bin = '', b = new Uint8Array(buf);
      for (var i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      FONT = "@font-face{font-family:'InterVar';font-weight:100 900;src:url(data:font/woff2;base64," + btoa(bin) + ") format('woff2-variations')}";
      return FONT;
    }, function () { FONT = ''; return FONT; });
  }
  function printHtml(d) {
    var css = '';
    for (var i = 0; i < document.styleSheets.length; i++) {
      var sh = document.styleSheets[i];
      if (!/views\.css/.test(sh.href || '')) continue;
      try { css = Array.prototype.map.call(sh.cssRules, function (r) { return r.cssText; }).filter(function (t) { return /(^|[\s,])\.pp|@page/.test(t); }).join('\n'); } catch (e) { css = ''; }
    }
    return fontCss().then(function (font) {
      return '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(TYPE[d.type] + ' ' + d.no) + '</title><style>' + font +
        '@page{size:A4;margin:0}html,body{margin:0;background:#fff}body{-webkit-print-color-adjust:exact;print-color-adjust:exact}' + css + '.pp{box-shadow:none!important;margin:0!important;border:0!important}</style></head><body>' + paper(d, 'print') + '</body></html>';
    });
  }

  /* ===== editor ===== */
  function inspector(d) {
    var sel = function (k, opts) { return '<select class="in" data-f="' + k + '">' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(d[k]) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>'; };
    var fld = function (label, body, hint) { return '<div class="field"><label>' + label + '</label>' + body + (hint ? '<span class="hint small muted">' + hint + '</span>' : '') + '</div>'; };
    var projects = Object.values(pg().S.projects).sort(function (a, b) { return String(b.code).localeCompare(String(a.code), undefined, { numeric: true }); });
    var lk = milestoneOf(d), mismatch = '';
    if (lk && lk.m) { var amt = pg().milestoneAmount(lk.p, lk.p.milestones.indexOf(lk.m)), tt = totals(d).total; if (Math.round(amt) !== Math.round(tt)) mismatch = '<p class="ed-warn">' + ic('help', 14) + '<span>Payments track ' + esc(fmt(amt, d.currency)) + ' for this milestone. This invoice totals ' + esc(fmt(tt, d.currency)) + '.</span></p>'; }
    var stOpts = d.type === 'quote' ? Object.keys(QSTATUS).filter(function (k) { return k !== 'expired'; }).map(function (k) { return [k, QSTATUS[k][0]]; }) : [['draft', 'Draft'], ['issued', 'Issued'], ['paid', 'Paid'], ['void', 'Void']];
    return '<aside class="ed-side">' +
      '<div class="ed-sec"><h3>Document</h3>' +
        fld('Status', lk && lk.m && lk.m.invoice ? '<div>' + statusTag(d) + '<span class="small muted" style="margin-left:8px">from Payments</span></div>' : sel('status', stOpts)) +
        fld('Project', '<select class="in" data-f="pid"' + (d.mid ? ' disabled' : '') + '><option value="">No project</option>' + projects.map(function (p) { return '<option value="' + p.id + '"' + (d.pid === p.id ? ' selected' : '') + '>' + esc(p.code + ' · ' + p.name) + '</option>'; }).join('') + '</select>', d.mid ? 'Linked to a milestone in Payments.' : '') +
        mismatch + '</div>' +
      '<div class="ed-sec"><h3>Amounts</h3>' +
        '<div class="form-grid">' + fld('Currency', '<input class="in mono" data-f="currency" value="' + esc(d.currency) + '" maxlength="4">') +
        fld('Discount', '<input class="in" data-f="discountPct" value="' + esc(d.discountPct || '') + '" placeholder="%" inputmode="decimal">') + '</div>' +
        '<div class="form-grid">' + fld('Tax', sel('taxMode', [['none', 'No tax'], ['included', 'Included in rates'], ['added', 'Added on top']])) + fld('Tax %', '<input class="in" data-f="taxPct" value="' + esc(d.taxPct || '') + '" inputmode="decimal"' + (d.taxMode === 'none' ? ' disabled' : '') + '>') + '</div>' +
        (d.type === 'invoice' ? fld('Retention %', '<input class="in" data-f="retainPct" value="' + esc(d.retainPct || '') + '" inputmode="decimal">', 'Held back until hand-over.') : '') + '</div>' +
      '<div class="ed-sec"><h3>On the page</h3>' +
        '<label class="switch dk-sw"><input type="checkbox" data-fb="showBank"' + (d.showBank ? ' checked' : '') + '><span><span>Bank details</span><span class="small muted dk-s">From Settings, Invoice details</span></span></label>' +
        '<button type="button" class="btn sm" data-ed-act="studioDetails">Edit studio and bank details</button></div>' +
      (d.type === 'quote' ? '<div class="ed-sec"><h3>Assistant</h3><p class="small muted">Describe the job and the local AI drafts the lines and rates. You check and adjust them.</p><button type="button" class="btn sm" data-ed-act="ai">' + ic('sparkle', 14) + 'Draft lines with AI</button></div>' :
        '<div class="ed-sec"><h3>Assistant</h3><p class="small muted">Write a short, polite cover note to send with this invoice.</p><button type="button" class="btn sm" data-ed-act="aiNote">' + ic('sparkle', 14) + 'Write a cover note</button></div>') +
      '</aside>';
  }
  function editorView(d) {
    var main = d.type === 'quote' ? (d.status === 'accepted' ? '<button type="button" class="btn primary" data-ed-act="toInvoice">Make the invoice</button>' : d.status === 'draft' ? '<button type="button" class="btn primary" data-ed-act="markSent">' + ic('send', 15) + 'Mark as sent</button>' : '<button type="button" class="btn primary" data-ed-act="markAccepted">' + ic('check', 15) + 'Accepted</button>')
      : (d.status === 'draft' ? '<button type="button" class="btn primary" data-ed-act="issue">' + ic('send', 15) + 'Issue invoice</button>' : '');
    return '<div class="ed">' +
      '<div class="ed-bar"><button type="button" class="icon-btn" data-ed-act="back" title="Back to the list">' + ic('back', 18) + '</button>' +
      '<div class="ed-name"><b>' + TYPE[d.type] + ' <span class="mono">' + esc(d.no) + '</span></b><span><span id="edSaved" class="ed-saved">Saved</span></span></div>' + statusTag(d) +
      '<span class="grow"></span>' +
      '<button type="button" class="btn" data-ed-act="print">' + ic('print', 15) + 'Print</button>' +
      '<button type="button" class="btn" data-ed-act="pdf">' + ic('pdf', 15) + 'Export PDF</button>' + main +
      '<button type="button" class="icon-btn" data-doc-menu="' + esc(d.id) + '" title="More">' + ic('dots', 16) + '</button></div>' +
      '<div class="ed-body"><div class="ed-canvas" id="edCanvas"><div class="ed-scale" id="edScale">' + paper(d, 'edit') + '</div></div>' + inspector(d) + '</div></div>';
  }

  var EL = null;
  function draw() {
    if (!EL || M.current() !== 'documents') return;
    if (!loaded) { EL.innerHTML = '<div class="fx-empty"><i class="spin"></i> Loading…</div>'; load().then(draw); return; }
    var d = D.open && byId(D.open);
    if (D.open && !d) D.open = null;
    EL.classList.toggle('dk-fill', !!d);
    EL.innerHTML = d ? editorView(d) : listView();
    if (d) { fit(); grow(EL); }
    M.crumb();
  }
  /* the page keeps its A4 proportions and shrinks to fit narrow windows */
  function fit() {
    var c = document.getElementById('edCanvas'), s = document.getElementById('edScale');
    if (!c || !s) return;
    var w = c.clientWidth - 48, k = Math.min(1, w / 794);
    s.style.zoom = k < 1 ? k : '';
  }
  window.addEventListener('resize', function () { if (D.open) fit(); });
  function grow(scope) { (scope || EL).querySelectorAll('.pp-area').forEach(function (t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }); }
  /* redraw only the parts that depend on numbers, so typing is never interrupted */
  function refreshCalc(d) {
    var art = EL.querySelector('.pp');
    if (!art) return;
    var fresh = document.createElement('div'); fresh.innerHTML = paper(d, 'edit');
    var nt = fresh.querySelector('.pp-tot'), ot = art.querySelector('.pp-tot'); if (nt && ot) ot.replaceWith(nt);
    d.items.forEach(function (it) {
      var row = art.querySelector('[data-line="' + it.id + '"] .pp-c-a'), nr = fresh.querySelector('[data-line="' + it.id + '"] .pp-c-a');
      if (row && nr) row.innerHTML = nr.innerHTML;
    });
    var side = EL.querySelector('.ed-warn'), ns = document.createElement('div'); ns.innerHTML = inspector(d);
    var nw = ns.querySelector('.ed-warn');
    if (side && !nw) side.remove(); else if (side && nw) side.replaceWith(nw); else if (!side && nw) { var sec = EL.querySelector('.ed-side .ed-sec'); if (sec) sec.appendChild(nw); }
  }

  function openDoc(id) {
    if (String(id).indexOf('v:') === 0) {
      var parts = id.split(':'), d = forMilestone(parts[1], parts[2]);
      if (!d) return;
      save(d, true); id = d.id;
    }
    D.open = id; M.go('documents', { keep: true }); draw();
    var c = document.getElementById('edCanvas'); if (c) c.scrollTop = 0;
  }
  function newDoc(type, pid) {
    var p = pid ? pg().P(pid) : null;
    var d = blank(type, p);
    save(d, true);
    openDoc(d.id);
    return d;
  }
  function pickNew(type, anchor) {
    var projects = Object.values(pg().S.projects).filter(function (p) { return p.status !== 'closed'; }).sort(function (a, b) { return String(b.code).localeCompare(String(a.code), undefined, { numeric: true }); });
    var items = [{ head: type === 'quote' ? 'New quotation for' : 'New invoice for' }, { label: type === 'quote' ? 'A new client (no project yet)' : 'Extra work, not a milestone', icon: 'plus', fn: function () { newDoc(type, ''); } }];
    if (type === 'invoice') {
      var ready = [];
      projects.forEach(function (p) { p.milestones.forEach(function (m, i) { if (!m.invoice && pg().invoiceInfo(p, i, pg().today()).status === 'ready') ready.push({ p: p, m: m }); }); });
      if (ready.length) items.push({ sep: true }, { head: 'Milestones ready to invoice' });
      ready.slice(0, 8).forEach(function (x) { items.push({ label: x.p.code + ' · ' + x.m.label, icon: 'documents', fn: function () { var d = forMilestone(x.p.id, x.m.id); d.status = 'draft'; save(d, true); openDoc(d.id); } }); });
    }
    if (projects.length) items.push({ sep: true }, { head: 'Project' });
    projects.slice(0, 10).forEach(function (p) { items.push({ label: p.code + ' · ' + p.name, icon: 'projects', fn: function () { newDoc(type, p.id); } }); });
    M.menu(anchor, items);
  }
  function docMenu(btn) {
    var d = byId(btn.dataset.docMenu); if (!d) return;
    var items = [
      { label: 'Open', icon: 'documents', fn: function () { openDoc(d.id); } },
      { label: 'Export PDF', icon: 'pdf', fn: function () { exportPdf(d); } },
      { label: 'Duplicate', icon: 'copy', fn: function () { var c = JSON.parse(JSON.stringify(d)); c.id = M.uid(d.type === 'quote' ? 'q' : 'i'); c.no = nextNo(d.type, d.pid && pg().P(d.pid)); c.status = 'draft'; c.mid = ''; c.issued = pg().today(); c.created = new Date().toISOString(); c.items.forEach(function (it) { it.id = M.uid('l'); }); save(c, true); openDoc(c.id); M.toast('Copied as ' + c.no + '.'); } }
    ];
    if (d.type === 'quote') items.push({ label: 'Make an invoice from it', icon: 'send', fn: function () { toInvoice(d); } });
    items.push({ sep: true }, { label: 'Delete', icon: 'trash', danger: true, fn: function () {
      if (d.type === 'invoice' && d.mid && d.status !== 'draft') { M.toast('This invoice is in Payments. Delete it there, or mark it Void.'); return; }
      if (!window.confirm('Delete ' + TYPE[d.type].toLowerCase() + ' ' + d.no + '? This cannot be undone.')) return;
      remove(d); if (D.open === d.id) D.open = null; draw(); M.toast('Deleted.');
    } });
    M.menu(btn, items);
  }
  function toInvoice(q) {
    var p = q.pid && pg().P(q.pid), inv = blank('invoice', p);
    ['clientName', 'clientContact', 'clientAddress', 'projectName', 'projectLocation', 'currency', 'discount', 'discountPct', 'taxMode', 'taxPct', 'ref'].forEach(function (k) { inv[k] = q[k]; });
    inv.items = q.items.map(function (it) { return Object.assign({}, it, { id: M.uid('l') }); });
    inv.fromQuote = q.id; inv.notes = 'As quoted in ' + q.no + '.';
    if (q.status !== 'accepted') { q.status = 'accepted'; save(q, true); }
    save(inv, true); openDoc(inv.id); M.toast('Invoice ' + inv.no + ' made from ' + q.no + '.');
  }
  function fileName(d) { return (TYPE[d.type] + ' ' + d.no + (d.clientName ? ' - ' + d.clientName : '')).replace(/[<>:"\/\\|?*]+/g, '-') + '.pdf'; }
  function exportPdf(d) {
    M.toast('Making the PDF…');
    printHtml(d).then(function (html) { return H.savePdf(html, fileName(d)); }).then(function (path) {
      if (path) M.toast('Saved ' + path.split(/[\\/]/).pop() + '.', { label: 'Open', fn: function () { H.openPath(path); } });
    }, function (e) { M.toast('Could not make the PDF: ' + (e && e.message ? e.message : 'unknown error')); });
  }
  function issue(d) {
    if (!d.items.some(function (it) { return num(it.qty) * num(it.rate) > 0; })) { M.toast('Add at least one line with an amount first.'); return; }
    var lk = milestoneOf(d);
    if (lk && lk.m) {
      lk.m.invoice = { no: d.no, issued: d.issued, due: d.due || M.addDays(d.issued, +settings().termsDays || 14), ref: d.ref || '', note: d.notes || '' };
      pg().commit(lk.p);
    }
    d.status = 'issued'; save(d, true); draw();
    M.toast('Invoice ' + d.no + ' issued' + (lk ? ' and added to Payments' : '') + '.', { label: 'Export PDF', fn: function () { exportPdf(d); } });
  }
  /* edits to a linked, issued milestone invoice go back to Payments */
  function syncMilestone(d) {
    var lk = milestoneOf(d);
    if (!lk || !lk.m || !lk.m.invoice) return;
    var inv = lk.m.invoice, changed = false;
    [['no', 'no'], ['issued', 'issued'], ['due', 'due'], ['ref', 'ref'], ['notes', 'note']].forEach(function (k) { if ((inv[k[1]] || '') !== (d[k[0]] || '')) { inv[k[1]] = d[k[0]] || ''; changed = true; } });
    if (changed) { pg().S.projects[lk.p.id] = lk.p; pg().queueWrite('p', lk.p.id, lk.p); }
  }

  var ED_ACT = {
    back: function () { D.open = null; draw(); },
    pdf: function (d) { exportPdf(d); },
    print: function (d) { printHtml(d).then(function (html) { return H.printHtml(html); }).then(function (r) { if (r && !r.ok && r.reason && r.reason !== 'cancelled') M.toast('Printing failed: ' + r.reason); }); },
    issue: function (d) { issue(d); },
    markSent: function (d) { d.status = 'sent'; save(d, true); draw(); M.toast('Marked as sent. It shows as expired after ' + M.fdate(d.validUntil) + '.'); },
    markAccepted: function (d) { d.status = 'accepted'; save(d, true); draw(); M.toast('Quotation accepted.', { label: 'Make the invoice', fn: function () { toInvoice(d); } }); },
    toInvoice: function (d) { toInvoice(d); },
    studioDetails: function () { pg().setView('settings'); },
    ai: function (d) { if (window.MorfisAuto) window.MorfisAuto.draftQuote(d, function () { save(d, true); draw(); }); },
    aiNote: function (d) { if (window.MorfisAuto) window.MorfisAuto.coverNote(d); }
  };

  function bind(el) {
    if (el.dataset.dcBound) return;
    el.dataset.dcBound = '1';
    el.addEventListener('click', function (e) {
      if (M.current() !== 'documents') return;
      var t = e.target, d = D.open && byId(D.open);
      var tb = t.closest('[data-doc-tab]'); if (tb) { D.tab = tb.dataset.docTab; draw(); return; }
      var nw = t.closest('[data-doc-new]'); if (nw) { pickNew(nw.dataset.docNew, nw); return; }
      var mn = t.closest('[data-doc-menu]'); if (mn) { e.stopPropagation(); docMenu(mn); return; }
      var op = t.closest('[data-doc-open]'); if (op) { openDoc(op.dataset.docOpen); return; }
      var ea = t.closest('[data-ed-act]'); if (ea && (d || ea.dataset.edAct === 'back')) { ED_ACT[ea.dataset.edAct](d); return; }
      if (!d) return;
      var add = t.closest('[data-add-line]');
      if (add) {
        var it = add.dataset.addLine === 'section' ? { id: M.uid('l'), desc: 'Stage: ', detail: '', qty: 1, unit: 'lump sum', rate: 0 } : { id: M.uid('l'), desc: '', detail: '', qty: 1, unit: d.items.length ? d.items[d.items.length - 1].unit : 'item', rate: 0 };
        d.items.push(it); save(d); draw();
        var nr = EL.querySelector('[data-line="' + it.id + '"] .pp-desc'); if (nr) { nr.focus(); nr.setSelectionRange(nr.value.length, nr.value.length); }
        return;
      }
      var del = t.closest('[data-del-line]');
      if (del) { if (d.items.length === 1) { d.items[0] = { id: d.items[0].id, desc: '', detail: '', qty: 1, unit: 'item', rate: 0 }; } else d.items = d.items.filter(function (x) { return x.id !== del.dataset.delLine; }); save(d); draw(); }
    });
    el.addEventListener('input', function (e) {
      var d = D.open && byId(D.open), t = e.target;
      if (!d || M.current() !== 'documents') return;
      if (t.classList.contains('pp-area')) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }
      if (t.dataset.l) {
        var row = t.closest('[data-line]'), it = d.items.find(function (x) { return x.id === row.dataset.line; });
        if (!it) return;
        it[t.dataset.l] = t.value;
        save(d); if (t.dataset.l === 'qty' || t.dataset.l === 'rate') refreshCalc(d);
        return;
      }
      if (t.dataset.f && t.tagName !== 'SELECT') {
        d[t.dataset.f] = t.value;
        if (t.dataset.f === 'discountPct') d.discount = 0;
        save(d); syncMilestone(d);
        if (/^(discountPct|taxPct|retainPct|currency)$/.test(t.dataset.f)) refreshCalc(d);
      }
    });
    el.addEventListener('change', function (e) {
      var d = D.open && byId(D.open), t = e.target;
      if (!d || M.current() !== 'documents') return;
      if (t.dataset.fb) { d[t.dataset.fb] = t.checked; save(d); draw(); return; }
      if (t.tagName === 'SELECT' && t.dataset.f) {
        d[t.dataset.f] = t.value;
        if (t.dataset.f === 'pid') { var p = pg().P(t.value); if (p) { d.projectName = p.name; d.projectLocation = p.location || ''; if (!d.clientName && p.client) { d.clientName = p.client.name || ''; d.clientContact = p.client.contact || ''; } } }
        if (t.dataset.f === 'status' && t.value === 'issued' && d.type === 'invoice') { t.value = d.status = 'draft'; issue(d); return; }
        save(d); draw();
      } else if (t.type === 'date' && t.dataset.f) { d[t.dataset.f] = t.value; save(d); syncMilestone(d); }
    });
  }

  /* the dashboard's invoice preview gets an Edit button that opens the same invoice here */
  new MutationObserver(function () {
    var ov = document.getElementById('overlay');
    if (!ov || ov.hidden) return;
    var pdf = ov.querySelector('.dialog [data-act=exportInvoice]');
    if (pdf && !ov.querySelector('[data-dk-edit]')) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'btn'; b.setAttribute('data-dk-edit', ''); b.innerHTML = ic('documents', 15) + 'Edit invoice';
      b.addEventListener('click', function () { var pid = pdf.dataset.pid, mid = pdf.dataset.mid; pg().closeModal(); loaded ? openDoc('v:' + pid + ':' + mid) : load().then(function () { openDoc('v:' + pid + ':' + mid); }); });
      pdf.parentNode.insertBefore(b, pdf);
    }
  }).observe(document.body, { childList: true, subtree: true });

  M.register('documents', {
    title: 'Invoices & quotes', placeholder: 'Search invoices and quotations',
    crumb: function () { var d = D.open && byId(D.open); return 'Invoices & quotes' + (d ? ' / ' + d.no : ''); },
    render: function (el, o) { EL = el; bind(el); if (!(o && o.keep)) D.open = null; draw(); },
    refresh: function () { if (!D.open) draw(); },
    search: function (q) { D.q = q; if (!D.open) draw(); }
  });
  load();

  window.MorfisDocs = {
    attention: function () { return DOCS.filter(function (d) { return d.status === 'draft'; }).length; },
    all: function () { return DOCS; }, load: load, printHtml: printHtml, save: save, blank: blank, forMilestone: forMilestone, open: openDoc, totals: totals, fmt: fmt, liveStatus: liveStatus, byId: byId
  };
})();
