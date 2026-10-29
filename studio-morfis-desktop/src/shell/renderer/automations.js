/* Automations: rules that keep the studio's paperwork moving, and an AI assistant that runs on this computer.
   The assistant uses Ollama (free, open source) with an open model such as Qwen 2.5. Nothing is sent online.
   Rules work without the assistant; where it helps (wording, sorting odd file names, drafting quotes) it is used
   when available, and a plain template takes its place when it is not. */
(function () {
  'use strict';
  var M = window.Morfis, A = window.MorfisArt;
  if (!M || !A) return;
  var H = M.H, esc = M.esc, ic = M.ic, pg = M.page;
  var KV = { settings: 'auto:settings', log: 'auto:log', drafted: 'auto:drafted', outbox: 'auto:outbox', followed: 'auto:followed', digest: 'auto:digest', icons: 'auto:icons' };
  var ST = { settings: { draftInvoices: true, followUps: true, digest: true }, log: [], drafted: {}, outbox: [], followed: {}, digest: null, icons: {} };
  var AI = { status: null, checking: false, pull: null };
  var ready = false;

  var RULES = [
    { key: 'draftInvoices', kind: 'Rule', icon: 'documents', title: 'Draft the invoice when a stage is reached', text: 'When a project reaches the stage a milestone is billed at, a draft invoice is prepared in Invoices & quotes for you to check and issue.' },
    { key: 'followUps', kind: 'AI', icon: 'mail', title: 'Payment follow-ups for overdue invoices', text: 'For each overdue invoice, a short, polite reminder email is written for you to review, copy or open in your email program. Once a week per invoice.' },
    { key: 'digest', kind: 'AI', icon: 'sparkle', title: 'Monday studio summary', text: 'Every Monday, a short summary of what needs attention: overdue money, tasks due this week, quotes waiting for an answer.' },
    { key: 'folderIcons', kind: 'Rule', icon: 'files', title: 'Same folder icons in File Explorer', text: 'Project folders and their six standard folders get the icons you see in Files: the status badge, the folder number and the main file type. They follow every change within seconds.', pref: true },
    { key: 'aiSort', kind: 'AI', icon: 'sort', title: 'Sort files the rules cannot place', text: 'In Files, “Sort with AI” reads the names of loose files and suggests one of the six standard folders. You check before anything moves, and it can be undone.', manual: 'Files' },
    { key: 'quote', kind: 'AI', icon: 'documents', title: 'Quotation assistant', text: 'In a quotation, describe the job and the lines, quantities and rates are drafted from your studio’s past projects.', manual: 'Invoices & quotes' }
  ];

  /* ----- state on disk ----- */
  function loadState() {
    return Promise.all(Object.keys(KV).map(function (k) { return H.kvGet(KV[k]).then(function (v) { if (v != null) ST[k] = v; }, function () {}); }))
      .then(function () { ST.settings = Object.assign({ draftInvoices: true, followUps: true, digest: true }, ST.settings); ready = true; });
  }
  function put(k) { return H.kvSet(KV[k], ST[k]).catch(function () {}); }
  function log(icon, text, link) {
    ST.log.unshift({ at: new Date().toISOString(), icon: icon, text: text, link: link || null });
    ST.log = ST.log.slice(0, 40); put('log'); redraw();
  }

  /* ----- the AI engine ----- */
  function checkAi(force) {
    if (AI.checking || (AI.status && !force && Date.now() - AI.status.at < 60000)) return Promise.resolve(AI.status);
    AI.checking = true;
    return H.aiStatus().then(function (s) { s.at = Date.now(); AI.status = s; AI.checking = false; redraw(); return s; }, function () { AI.checking = false; return AI.status; });
  }
  var aiUsable = function () { return !!(AI.status && AI.status.running && AI.status.ready && AI.status.enabled); };
  function ask(system, prompt, json) { return H.aiChat({ system: system, prompt: prompt, json: !!json }); }
  H.onAiPull(function (p) {
    if (!AI.pull) return;
    AI.pull.status = p.status; AI.pull.pct = p.total ? Math.round(p.completed * 100 / p.total) : AI.pull.pct;
    var bar = document.getElementById('aiPullBar'), txt = document.getElementById('aiPullTxt');
    if (bar) bar.style.width = (AI.pull.pct || 0) + '%';
    if (txt) txt.textContent = (p.status || '') + (p.total ? ' · ' + AI.pull.pct + '%' : '');
  });
  function pullModel(name) {
    AI.pull = { name: name, pct: 0, status: 'Starting' }; redraw();
    H.aiPull(name).then(function () { AI.pull = null; M.toast(name + ' is ready.'); log('cpu', 'Downloaded the model ' + name + '.'); checkAi(true); },
      function (e) { AI.pull = null; redraw(); M.toast('Download failed: ' + (e && e.message ? e.message : 'unknown error')); });
  }
  /* check the engine first, then run fn if it can be used; otherwise explain how to set it up */
  function withAi(what, fn) { return checkAi().then(function () { if (needAi(what)) return fn(); }); }
  function needAi(what) {
    if (aiUsable()) return true;
    var s = AI.status || {};
    var msg = !s.running ? 'The AI assistant is not running on this computer.' : !s.ready ? 'The model ' + esc(s.model) + ' is not downloaded yet.' : 'The AI assistant is turned off.';
    M.modal('AI assistant needed', '<p class="muted">' + msg + ' ' + esc(what) + ' needs it.</p>' + setupSteps(s) +
      '<div class="dlg-foot"><button type="button" class="btn" data-act="close">Close</button><button type="button" class="btn primary" data-auto-go>Open Automations</button></div>');
    var b = document.querySelector('[data-auto-go]'); if (b) b.addEventListener('click', function () { pg().closeModal(); M.go('automations'); });
    return false;
  }
  function setupSteps(s) {
    s = s || {};
    return '<ol class="au-steps"><li class="' + (s.running ? 'done' : '') + '"><b>Install Ollama</b><span>Free and open source. Download it from ollama.com and run the installer. It starts by itself afterwards.</span></li>' +
      '<li class="' + (s.ready ? 'done' : '') + '"><b>Download a model</b><span>Pick one under AI assistant and press Download. Qwen 2.5 (3B) is about 1.9 GB and works on most PCs.</span></li>' +
      '<li><b>That is all</b><span>Automations marked AI use it from then on. Everything runs on this computer.</span></li></ol>';
  }

  /* ----- facts the assistant and the rules work from ----- */
  function overdue() {
    var out = [], today = pg().today();
    Object.values(pg().S.projects).forEach(function (p) {
      p.milestones.forEach(function (m, i) {
        var inf = pg().invoiceInfo(p, i, today);
        if (inf.status === 'overdue') out.push({ key: p.id + ':' + m.id, p: p, no: m.invoice.no, label: m.label, due: m.invoice.due, days: Math.round((new Date(today) - new Date(m.invoice.due)) / 864e5), amount: inf.balance, client: (p.client && p.client.name) || '', contact: (p.client && p.client.contact) || '' });
      });
    });
    return out;
  }
  function weekFacts() {
    var today = pg().today(), end = M.addDays(today, 7), tasks = [], cur = pg().S.settings.currency || 'LKR';
    Object.values(pg().S.projects).forEach(function (p) {
      if (p.status === 'closed') return;
      p.tasks.forEach(function (t) { if (t.status !== 'done' && t.due && t.due <= end) tasks.push({ p: p.code + ' ' + p.name, t: t.title, due: t.due, late: t.due < today }); });
    });
    var docs = window.MorfisDocs ? window.MorfisDocs.all() : [];
    var quotes = docs.filter(function (d) { return d.type === 'quote' && d.status === 'sent'; });
    var od = overdue();
    var active = Object.values(pg().S.projects).filter(function (p) { var s = A.statusOf(p, today); return s === 'in_progress' || s === 'on_hold'; });
    return {
      today: today, currency: cur,
      overdue: od.map(function (o) { return { invoice: o.no, project: o.p.name, client: o.client, amount: Math.round(o.amount), daysLate: o.days }; }),
      tasksLate: tasks.filter(function (x) { return x.late; }).slice(0, 12), tasksThisWeek: tasks.filter(function (x) { return !x.late; }).slice(0, 12),
      quotesWaiting: quotes.map(function (q) { return { no: q.no, client: q.clientName, total: Math.round(window.MorfisDocs.totals(q).total), validUntil: q.validUntil }; }),
      onHold: active.filter(function (p) { return A.statusOf(p, today) === 'on_hold'; }).map(function (p) { return p.code + ' ' + p.name; }),
      activeProjects: active.length
    };
  }

  /* ===== rule: draft invoices ===== */
  function runDraftInvoices() {
    if (!ST.settings.draftInvoices || !window.MorfisDocs) return 0;
    var made = 0, today = pg().today();
    Object.values(pg().S.projects).forEach(function (p) {
      if (p.status === 'closed' || !p.budget) return;
      p.milestones.forEach(function (m, i) {
        var key = p.id + ':' + m.id;
        if (m.invoice || ST.drafted[key] || pg().invoiceInfo(p, i, today).status !== 'ready') return;
        if (window.MorfisDocs.all().some(function (d) { return d.pid === p.id && d.mid === m.id; })) { ST.drafted[key] = today; return; }
        var d = window.MorfisDocs.forMilestone(p.id, m.id);
        d.status = 'draft';
        window.MorfisDocs.save(d, true);
        ST.drafted[key] = today; made++;
        log('documents', 'Drafted invoice ' + d.no + ' for ' + p.name + ', ' + m.label + '.', { doc: d.id });
      });
    });
    if (made) { put('drafted'); H.notify(made === 1 ? 'An invoice is ready to review' : made + ' invoices are ready to review', 'Open Invoices & quotes to check and issue ' + (made === 1 ? 'it' : 'them') + '.'); M.redrawSide(); }
    return made;
  }

  /* ===== AI: follow-up emails ===== */
  function template(o) {
    return 'Dear ' + (o.client || 'Sir or Madam') + ',\n\nI hope you are well. This is a gentle reminder that invoice ' + o.no + ' for ' + o.p.name + ' (' + o.label + ') was due on ' + M.fdate(o.due) + '. ' +
      'The balance of ' + M.money(o.amount) + ' is still open.\n\nIf payment is already on its way, thank you, and please ignore this note. Otherwise we would be grateful if you could arrange it this week. ' +
      'Let me know if anything is unclear or if a copy of the invoice would help.\n\nKind regards,\n' + (pg().S.settings.studio || '');
  }
  function runFollowUps() {
    if (!ST.settings.followUps) return Promise.resolve(0);
    var today = pg().today(), list = overdue().filter(function (o) { var last = ST.followed[o.key]; return !last || M.addDays(last, 7) <= today; });
    if (!list.length) return Promise.resolve(0);
    var made = 0;
    return list.reduce(function (chain, o) {
      return chain.then(function () {
        var write = aiUsable() ? ask('You write short, warm, professional payment reminder emails for an architecture and interior design studio. Plain text only, no subject line, under 130 words. Never invent facts.',
          'Write a reminder for this overdue invoice. Studio: ' + pg().S.settings.studio + '. Client: ' + (o.client || 'the client') + '. Project: ' + o.p.name + '. Invoice ' + o.no + ' for "' + o.label + '", due ' + M.fdate(o.due) + ' (' + o.days + ' days ago). Balance ' + M.money(o.amount) + '. ' +
          (o.days > 30 ? 'It is well overdue: be clear and firm, still courteous, and ask for a payment date.' : 'Keep it light and friendly.')).then(function (r) { return { text: r.text, ai: true }; }, function () { return { text: template(o), ai: false }; }) : Promise.resolve({ text: template(o), ai: false });
        return write.then(function (w) {
          ST.outbox.unshift({ id: M.uid('m'), key: o.key, to: /@/.test(o.contact) ? o.contact : '', client: o.client, subject: 'Invoice ' + o.no + ' · ' + o.p.name, body: w.text, ai: w.ai, created: today, amount: o.amount });
          ST.followed[o.key] = today; made++;
        });
      });
    }, Promise.resolve()).then(function () {
      ST.outbox = ST.outbox.slice(0, 30); put('outbox'); put('followed');
      log('mail', 'Wrote ' + made + ' payment follow-up' + (made === 1 ? '' : 's') + ' to review.');
      H.notify('Payment follow-ups to review', made + ' overdue invoice' + (made === 1 ? ' has' : 's have') + ' a reminder email ready.');
      M.redrawSide(); return made;
    });
  }

  /* ===== AI: Monday summary ===== */
  function factsText(f) {
    var lines = [];
    var sum = f.overdue.reduce(function (a, o) { return a + o.amount; }, 0);
    lines.push(f.overdue.length ? f.overdue.length + ' invoice' + (f.overdue.length === 1 ? ' is' : 's are') + ' overdue, ' + M.money(sum) + ' in total' + (f.overdue[0] ? ', the oldest ' + f.overdue.sort(function (a, b) { return b.daysLate - a.daysLate; })[0].invoice + ' (' + f.overdue[0].daysLate + ' days).' : '.') : 'No invoices are overdue.');
    lines.push(f.tasksLate.length ? f.tasksLate.length + ' task' + (f.tasksLate.length === 1 ? ' is' : 's are') + ' past due, for example “' + f.tasksLate[0].t + '” (' + f.tasksLate[0].p + ').' : 'No tasks are past due.');
    if (f.tasksThisWeek.length) lines.push(f.tasksThisWeek.length + ' task' + (f.tasksThisWeek.length === 1 ? ' is' : 's are') + ' due this week.');
    if (f.quotesWaiting.length) lines.push(f.quotesWaiting.length + ' quotation' + (f.quotesWaiting.length === 1 ? ' is' : 's are') + ' waiting for an answer.');
    if (f.onHold.length) lines.push('On hold: ' + f.onHold.join(', ') + '.');
    return lines.map(function (l) { return '• ' + l; }).join('\n');
  }
  function runDigest(force) {
    if (!ST.settings.digest && !force) return Promise.resolve(null);
    var today = pg().today(), dow = new Date(today + 'T00:00:00').getDay();
    var last = ST.digest && ST.digest.date;
    /* Mondays, or the first start after a missed Monday */
    var due = force || (last !== today && (dow === 1 || (last && M.addDays(last, 7) < today)));
    if (!due) return Promise.resolve(null);
    var f = weekFacts(), plain = factsText(f);
    var write = aiUsable() ? ask('You are the studio manager of an architecture and interior design practice. Write a calm, practical Monday summary for the principal: 4 to 6 short bullet points starting with "• ", most important first, each with a clear next step. Use only the facts given. Plain text.',
      'Facts as JSON:\n' + JSON.stringify(f)).then(function (r) { return { text: r.text || plain, ai: true }; }, function () { return { text: plain, ai: false }; }) : Promise.resolve({ text: plain, ai: false });
    return write.then(function (w) {
      ST.digest = { date: today, text: w.text, ai: w.ai }; put('digest');
      log('sparkle', 'Wrote the studio summary for the week of ' + M.fdate(today) + '.');
      H.notify('Your week at ' + (pg().S.settings.studio || 'the studio'), String(w.text).split('\n')[0].replace(/^•\s*/, ''));
      return ST.digest;
    });
  }

  /* ===== rule: the app's folder icons on the real folders in File Explorer ===== */
  /* every project folder (status badge) and its six standard folders (number tab), drawn exactly as in Files */
  function iconJobs(onlyPid) {
    var today = pg().today(), jobs = [];
    Object.values(pg().S.projects).forEach(function (p) {
      if (!p.foldersCreated || p.dirMissing || (onlyPid && p.id !== onlyPid)) return;
      var all = [], total = 0;
      pg().FOLDER_TEMPLATES.forEach(function (t) {
        var f = (p.folders || {})[t.id] || {}, files = f.files || [], count = f.count != null ? f.count : files.length;
        all = all.concat(files); total += count;
        if (f.exists) jobs.push({ dir: pg().subDir(p, t.id), v: A.variant({ num: t.id, count: count, kinds: A.kindsOf(files) }), tip: t.label + ' · ' + p.code + ' · ' + count + ' file' + (count === 1 ? '' : 's') });
      });
      var st = A.statusOf(p, today);
      jobs.push({ dir: pg().projDir(p), v: A.variant({ status: st, count: total, kinds: A.kindsOf(all) }), tip: A.STATUS[st].label + ' · ' + p.code + ' · Stage ' + p.currentStage + ' ' + pg().STAGES[Math.min(7, p.currentStage) - 1].short });
    });
    return jobs;
  }
  var iconBusy = false, iconAgain = false;
  function runFolderIcons(onlyPid) {
    var P = M.prefs();
    if (!P || !P.folderIcons) return Promise.resolve(0);
    if (iconBusy) { iconAgain = true; return Promise.resolve(0); }
    iconBusy = true;
    var jobs = iconJobs(onlyPid), pngs = {}, changed = [];
    return jobs.reduce(function (chain, j) {
      return chain.then(function () {
        var sig = j.v.key + '|' + A.ICON_VERSION + '|' + j.tip;
        if (ST.icons[j.dir] === sig) return;
        var png = pngs[j.v.key] ? Promise.resolve(pngs[j.v.key]) : A.toPng(A.explorerIcon(j.v), 256).then(function (u) { pngs[j.v.key] = u; return u; });
        return png.then(function (u) { return H.folderIcon({ dir: j.dir, key: j.v.key, version: A.ICON_VERSION, png: u, tip: j.tip }); }).then(function (r) {
          if (r && r.ok) { ST.icons[j.dir] = sig; changed.push(j.dir); }
        }, function () {});
      });
    }, Promise.resolve()).then(function () {
      iconBusy = false;
      if (changed.length) { put('icons'); H.folderIconRefresh(changed).catch(function () {}); log('files', 'Updated ' + changed.length + ' folder icon' + (changed.length === 1 ? '' : 's') + ' in File Explorer.'); }
      if (iconAgain) { iconAgain = false; setTimeout(runFolderIcons, 50); }
      return changed.length;
    }, function () { iconBusy = false; return 0; });
  }
  /* turned off: take the icons away again */
  function clearFolderIcons() {
    var dirs = Object.keys(ST.icons);
    return dirs.reduce(function (c, d) { return c.then(function () { return H.folderIconClear(d).catch(function () {}); }); }, Promise.resolve()).then(function () {
      if (dirs.length) H.folderIconRefresh(dirs).catch(function () {});
      ST.icons = {}; put('icons'); return dirs.length;
    });
  }
  window.addEventListener('morfis:status', function (e) { if (e.detail && e.detail.pid) runFolderIcons(e.detail.pid); });
  /* folders change as files are added, sorted or created: follow along, a few seconds behind */
  var iconT = 0;
  window.addEventListener('morfis:render', function () { clearTimeout(iconT); iconT = setTimeout(function () { if (ready && pg() && pg().S.ready) runFolderIcons(); }, 2500); });

  /* ===== AI: sort loose files ===== */
  function aiSort(pid) {
    var p = pg().P(pid);
    if (!p || !(p.loose || []).length) { M.toast('No loose files in this project.'); return Promise.resolve(); }
    return withAi('Sorting files', function () { return aiSortRun(p); });
  }
  function aiSortRun(p) {
    var files = p.loose.slice(0, 120), T = pg().FOLDER_TEMPLATES;
    M.toast('Reading ' + files.length + ' file name' + (files.length === 1 ? '' : 's') + '…');
    return ask('You file documents for an architecture and interior design studio. Each file goes into one of six folders: ' + T.map(function (t) { return t.id + ' = ' + t.label; }).join('; ') + '. ' +
      'Answer with JSON {"moves":[{"file":"<exact path>","folder":"<01 to 06, or empty if unsure>","why":"<3 to 6 words>"}]}. Use the exact paths given. Leave folder empty when unsure.',
      'Project: ' + p.name + ' (' + (p.type || '') + '). Files:\n' + files.join('\n'), true).then(function (r) {
      var moves = ((r.data && r.data.moves) || []).filter(function (m) { return files.indexOf(m.file) !== -1 && /^0[1-6]$/.test(m.folder || ''); });
      if (!moves.length) { M.toast('The assistant was not sure about any of these files.'); return; }
      return new Promise(function (resolve) {
        M.modal('Sort ' + moves.length + ' file' + (moves.length === 1 ? '' : 's'), '<p class="muted">Suggested by the AI assistant. Untick anything that should stay where it is. Moving can be undone.</p>' +
          '<div class="au-moves">' + moves.map(function (m, i) { var t = T.find(function (x) { return x.id === m.folder; }); return '<label class="au-move"><input type="checkbox" data-mv="' + i + '" checked><span class="mono">' + esc(m.file) + '</span><span class="au-to">→ ' + esc(t.label) + '</span><em>' + esc(m.why || '') + '</em></label>'; }).join('') + '</div>' +
          '<div class="dlg-foot"><button type="button" class="btn" data-act="close">Cancel</button><button type="button" class="btn primary" id="auMoveGo">Move the ticked files</button></div>', { wide: true });
        document.getElementById('auMoveGo').addEventListener('click', function () {
          var pick = moves.filter(function (m, i) { var c = document.querySelector('[data-mv="' + i + '"]'); return c && c.checked; });
          pg().closeModal();
          var ops = pick.map(function (m) { var t = T.find(function (x) { return x.id === m.folder; }); return { from: m.file, to: t.name + '/' + m.file.split('/').pop() }; });
          H.applyOps(pg().projDir(p), ops, 'move', 'AI sort ' + p.code).then(function (res) {
            log('sort', 'Sorted ' + res.moved + ' file' + (res.moved === 1 ? '' : 's') + ' in ' + p.name + ' with the AI assistant.');
            M.toast('Moved ' + res.moved + ' file' + (res.moved === 1 ? '' : 's') + '.', res.id ? { label: 'Undo', fn: function () { H.undo(res.id).then(function () { M.toast('Put back.'); pg().rescanProject(p, { force: true }); }); } } : undefined);
            resolve();
          }, function (e) { M.toast('Could not move: ' + (e && e.message ? e.message : 'unknown error')); resolve(); });
        });
      });
    }, function (e) { M.toast(e && e.message ? e.message : 'The assistant could not answer.'); });
  }

  /* ===== AI: quotation lines ===== */
  function pastFees() {
    return Object.values(pg().S.projects).filter(function (p) { return p.budget > 0; }).slice(0, 12).map(function (p) { return { type: p.type, area: p.gfa || null, fee: p.budget, location: p.location || '' }; });
  }
  function draftQuote(d, done) {
    var p = d.pid && pg().P(d.pid);
    M.modal('Draft the quotation', '<p class="muted">Describe the job in a sentence or two. The assistant suggests the lines; nothing is final until you change it on the page.</p>' +
      '<div class="field"><label for="auQ">The job</label><textarea class="in" id="auQ" rows="4" placeholder="Interior design for a 3-bedroom apartment, about 1,400 sqft, from concept to working drawings, with 3D renders and two site visits">' + esc(p ? (p.type || '') + ' project ' + p.name + (p.gfa ? ', about ' + p.gfa + ' sqm' : '') + (p.location ? ', ' + p.location : '') : '') + '</textarea></div>' +
      '<label class="switch dk-sw"><input type="checkbox" id="auReplace"' + (d.items.some(function (it) { return it.desc; }) ? '' : ' checked') + '><span>Replace the lines already on the page</span></label>' +
      '<div class="dlg-foot"><button type="button" class="btn" data-act="close">Cancel</button><button type="button" class="btn primary" id="auQGo">' + ic('sparkle', 15) + 'Draft the lines</button></div>');
    var go = document.getElementById('auQGo');
    go.addEventListener('click', function () {
      var brief = document.getElementById('auQ').value.trim(), replace = document.getElementById('auReplace').checked;
      if (!brief) return;
      withAi('The quotation assistant', function () {
      go.disabled = true; go.innerHTML = '<i class="spin"></i>Thinking…';
      return ask('You prepare fee quotations for an architecture and interior design studio. Currency ' + d.currency + '. The studio works in seven stages: ' + pg().STAGES.map(function (s) { return s.name; }).join(', ') + '. ' +
        'Answer with JSON {"items":[{"desc":"<short line title>","detail":"<one sentence of scope>","qty":<number>,"unit":"<lump sum|sqft|sqm|item|visit|hour|day|set>","rate":<number, no separators>}],"notes":"<one or two sentences of assumptions>"}. 3 to 9 lines. Rates must be realistic for the studio’s past fees.',
        'Past projects and fees: ' + JSON.stringify(pastFees()) + '\nThe job: ' + brief, true).then(function (r) {
        var items = ((r.data && r.data.items) || []).filter(function (it) { return it && it.desc; }).map(function (it) {
          return { id: M.uid('l'), desc: String(it.desc).slice(0, 160), detail: String(it.detail || '').slice(0, 400), qty: +it.qty || 1, unit: String(it.unit || 'item').slice(0, 20), rate: Math.max(0, Math.round(+String(it.rate).replace(/[^0-9.]/g, '') || 0)) };
        });
        pg().closeModal();
        if (!items.length) { M.toast('The assistant did not return any lines. Try describing the job differently.'); return; }
        d.items = replace ? items : d.items.filter(function (it) { return it.desc; }).concat(items);
        if (r.data.notes && (!d.notes || replace)) d.notes = String(r.data.notes).slice(0, 600);
        log('documents', 'Drafted ' + items.length + ' lines for quotation ' + d.no + '.');
        done(); M.toast('Drafted ' + items.length + ' lines. Check the quantities and rates.');
      }, function (e) { go.disabled = false; go.innerHTML = ic('sparkle', 15) + 'Draft the lines'; M.toast(e && e.message ? e.message : 'The assistant could not answer.'); });
      });
    });
  }
  function coverNote(d) { withAi('Writing a cover note', function () { coverNoteRun(d); }); }
  function coverNoteRun(d) {
    var t = window.MorfisDocs.totals(d);
    M.toast('Writing…');
    ask('You write short, warm, professional emails for an architecture and interior design studio. Plain text, under 110 words, no subject line. Use only the facts given.',
      'Write the email that goes with this ' + (d.type === 'quote' ? 'quotation' : 'invoice') + '. Studio: ' + pg().S.settings.studio + '. Client: ' + (d.clientName || 'the client') + '. Project: ' + (d.projectName || '') + '. Number ' + d.no + '. Total ' + window.MorfisDocs.fmt(t.total, d.currency) + '.' + (d.due ? ' Due ' + M.fdate(d.due) + '.' : '') + (d.validUntil ? ' Valid until ' + M.fdate(d.validUntil) + '.' : '')).then(function (r) {
      mailModal({ to: /@/.test(d.clientContact || '') ? d.clientContact : '', subject: (d.type === 'quote' ? 'Quotation ' : 'Invoice ') + d.no + (d.projectName ? ' · ' + d.projectName : ''), body: r.text });
    }, function (e) { M.toast(e && e.message ? e.message : 'The assistant could not answer.'); });
  }
  function mailModal(m, onDone) {
    M.modal(m.subject, '<div class="field"><label>To</label><input class="in" id="auTo" value="' + esc(m.to || '') + '" placeholder="client@example.com"></div><div class="field"><label>Message</label><textarea class="in" id="auBody" rows="11">' + esc(m.body) + '</textarea></div>' +
      '<div class="dlg-foot">' + (onDone ? '<button type="button" class="btn ghost" id="auDone" style="margin-right:auto">Mark as handled</button>' : '') + '<button type="button" class="btn" id="auCopy">' + ic('copy', 15) + 'Copy</button><button type="button" class="btn primary" id="auMail">' + ic('mail', 15) + 'Open in email</button></div>', { wide: true });
    document.getElementById('auCopy').addEventListener('click', function () { navigator.clipboard.writeText(document.getElementById('auBody').value).then(function () { M.toast('Copied.'); }); });
    document.getElementById('auMail').addEventListener('click', function () {
      var to = document.getElementById('auTo').value.trim(), body = document.getElementById('auBody').value;
      H.openExternal('mailto:' + encodeURIComponent(to) + '?subject=' + encodeURIComponent(m.subject) + '&body=' + encodeURIComponent(body)).catch(function () { M.toast('No email program answered. Use Copy instead.'); });
    });
    var dn = document.getElementById('auDone'); if (dn) dn.addEventListener('click', function () { pg().closeModal(); onDone(); });
  }

  /* ===== the view ===== */
  function engineCard() {
    var s = AI.status, P = M.prefs() || {};
    var state = !s ? ['neutral', 'Checking…'] : !s.running ? ['bad', 'Not running'] : !s.ready ? ['warn', 'Model not downloaded'] : !P.aiEnabled ? ['neutral', 'Turned off'] : ['good', 'Ready'];
    var models = s ? s.suggested.map(function (m) { var have = s.models.some(function (x) { return x.name === m.name; }); return { name: m.name, label: m.name + ' · ' + m.size + (have ? ' · downloaded' : ''), note: m.note, have: have }; }) : [];
    if (s) s.models.forEach(function (m) { if (!models.some(function (x) { return x.name === m.name; })) models.push({ name: m.name, label: m.name + ' · downloaded', have: true }); });
    var cur = models.find(function (m) { return m.name === P.aiModel; });
    return '<section class="card au-engine"><div class="au-eng-head"><span class="au-eng-ic">' + ic('cpu', 22) + '</span><div><h2>AI assistant</h2><p class="muted small">Runs on this computer with Ollama, free and open source. No account, no fees, nothing leaves the PC.</p></div>' +
      '<span class="st-tag st-' + state[0] + '"><i class="st-pip"></i>' + state[1] + '</span></div>' +
      '<div class="au-eng-body"><div class="field"><label for="auModel">Model</label><select class="in" id="auModel">' + models.map(function (m) { return '<option value="' + esc(m.name) + '"' + (m.name === P.aiModel ? ' selected' : '') + '>' + esc(m.label) + '</option>'; }).join('') + '</select>' +
        (cur && cur.note ? '<span class="hint small muted">' + esc(cur.note) + '</span>' : '') + '</div>' +
      '<div class="toolbar">' + (s && s.running && cur && !cur.have && !AI.pull ? '<button type="button" class="btn primary" data-au="pull">' + ic('download', 15) + 'Download ' + esc(P.aiModel) + '</button>' : '') +
        (!s || !s.running ? '<button type="button" class="btn primary" data-au="install">' + ic('ext', 15) + 'Get Ollama (free)</button>' : '') +
        '<button type="button" class="btn" data-au="recheck">' + ic('refresh', 15) + 'Check again</button>' + (aiUsable() ? '<button type="button" class="btn" data-au="test">' + ic('sparkle', 15) + 'Test</button>' : '') +
        '<label class="switch" style="margin-left:auto"><input type="checkbox" data-au-pref="aiEnabled"' + (P.aiEnabled ? ' checked' : '') + '>Use the assistant</label></div>' +
      (AI.pull ? '<div class="au-pull"><div class="au-bar"><i id="aiPullBar" style="width:' + (AI.pull.pct || 0) + '%"></i></div><span class="small muted" id="aiPullTxt">' + esc(AI.pull.status || '') + '</span></div>' : '') +
      (!s || !s.running || !s.ready ? setupSteps(s) : '') + '</div></section>';
  }
  function ruleCard(r) {
    var P = M.prefs() || {}, on = r.pref ? !!P[r.key] : r.manual ? null : !!ST.settings[r.key];
    return '<div class="au-rule"><div class="au-rule-h"><span class="au-rule-ic">' + ic(r.icon, 17) + '</span><span class="au-kind ' + (r.kind === 'AI' ? 'ai' : '') + '">' + r.kind + '</span>' +
      (on === null ? '<span class="small muted" style="margin-left:auto">In ' + esc(r.manual) + '</span>' : '<label class="switch" style="margin-left:auto" title="' + (on ? 'On' : 'Off') + '"><input type="checkbox" data-au-rule="' + r.key + '"' + (on ? ' checked' : '') + ' aria-label="' + esc(r.title) + '"></label>') + '</div>' +
      '<b>' + esc(r.title) + '</b><p class="small muted">' + esc(r.text) + '</p>' +
      (on !== null ? '<div class="au-rule-f"><button type="button" class="btn sm" data-au-run="' + r.key + '">' + ic('play', 13) + 'Run now</button></div>' : '') + '</div>';
  }
  function reviewHtml() {
    var docs = window.MorfisDocs ? window.MorfisDocs.all().filter(function (d) { return d.status === 'draft' && d.mid; }) : [];
    var parts = [];
    docs.slice(0, 8).forEach(function (d) { parts.push('<div class="au-item"><span class="au-item-ic">' + ic('documents', 16) + '</span><div><b>Invoice ' + esc(d.no) + '</b><span class="small muted">' + esc(d.projectName) + ' · ' + esc(window.MorfisDocs.fmt(window.MorfisDocs.totals(d).total, d.currency)) + '</span></div><button type="button" class="btn sm" data-au-doc="' + esc(d.id) + '">Review</button></div>'); });
    ST.outbox.slice(0, 8).forEach(function (m) { parts.push('<div class="au-item"><span class="au-item-ic">' + ic('mail', 16) + '</span><div><b>' + esc(m.subject) + '</b><span class="small muted">Reminder to ' + esc(m.client || 'the client') + (m.ai ? ' · written by the assistant' : '') + '</span></div><button type="button" class="btn sm" data-au-mail="' + esc(m.id) + '">Review</button></div>'); });
    return parts.length ? parts.join('') : '<p class="muted small" style="padding:6px 2px">Nothing waiting. Drafts and reminders the automations prepare show up here.</p>';
  }
  function view() {
    var dg = ST.digest;
    return '<div class="fx-head"><div><h1>Automations</h1><p class="muted">Rules and a private AI assistant that look after the routine work. You stay in control: everything they make waits for your review.</p></div></div>' +
      engineCard() +
      '<div class="au-cols"><section><div class="fx-sec-h"><h2>Automations</h2></div><div class="au-rules">' + RULES.map(ruleCard).join('') + '</div></section>' +
      '<section class="au-right"><div class="fx-sec-h"><h2>Waiting for you</h2><span class="count">' + attention() + '</span></div><div class="card au-review">' + reviewHtml() + '</div>' +
      '<div class="fx-sec-h"><h2>This week</h2>' + (dg ? '<span class="small muted">' + esc(M.fdate(dg.date)) + (dg.ai ? ' · by the assistant' : '') + '</span>' : '') + '<button type="button" class="btn sm" data-au-run="digest" style="margin-left:auto">' + ic('refresh', 13) + 'Write now</button></div>' +
      '<div class="card au-digest">' + (dg ? esc(dg.text).replace(/\n/g, '<br>') : '<span class="muted small">The Monday summary appears here.</span>') + '</div>' +
      '<div class="fx-sec-h"><h2>Activity</h2></div><div class="card au-log">' + (ST.log.length ? ST.log.slice(0, 14).map(function (l) { return '<div class="au-log-r">' + ic(l.icon || 'check', 14) + '<span>' + esc(l.text) + '</span><em>' + esc(new Date(l.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) + '</em></div>'; }).join('') : '<span class="muted small">Nothing has run yet.</span>') + '</div></section></div>';
  }
  var EL = null;
  function redraw() { if (EL && M.current() === 'automations') { var y = EL.scrollTop; EL.innerHTML = view(); EL.scrollTop = y; } }
  function attention() { var docs = window.MorfisDocs ? window.MorfisDocs.all().filter(function (d) { return d.status === 'draft' && d.mid; }).length : 0; return docs + ST.outbox.length; }

  function runRule(key) {
    if (key === 'draftInvoices') { var n = runDraftInvoices(); M.toast(n ? 'Drafted ' + n + ' invoice' + (n === 1 ? '' : 's') + '.' : 'No milestones are waiting for an invoice.'); redraw(); }
    else if (key === 'followUps') { ST.followed = {}; runFollowUps().then(function (n) { M.toast(n ? 'Wrote ' + n + ' follow-up' + (n === 1 ? '' : 's') + '.' : 'No invoices are overdue.'); redraw(); }); }
    else if (key === 'digest') { M.toast('Writing the summary…'); runDigest(true).then(function () { redraw(); }); }
    else if (key === 'folderIcons') { ST.icons = {}; runFolderIcons().then(function (n) { M.toast(n ? 'Updated ' + n + ' folder icon' + (n === 1 ? '' : 's') + ' in File Explorer.' : 'No project folders to update (Windows only).'); redraw(); }); }
  }
  function bind(el) {
    if (el.dataset.auBound) return;
    el.dataset.auBound = '1';
    el.addEventListener('click', function (e) {
      if (M.current() !== 'automations') return;
      var t = e.target, b;
      if ((b = t.closest('[data-au]'))) {
        var a = b.dataset.au;
        if (a === 'install') H.openExternal('https://ollama.com/download');
        else if (a === 'recheck') { AI.status = null; redraw(); checkAi(true); }
        else if (a === 'pull') pullModel(M.prefs().aiModel);
        else if (a === 'test') { b.disabled = true; ask('Answer in one short sentence.', 'Say hello to the studio and confirm you are ready.').then(function (r) { M.toast(r.text); b.disabled = false; }, function (x) { M.toast(x.message); b.disabled = false; }); }
        return;
      }
      if ((b = t.closest('[data-au-run]'))) { runRule(b.dataset.auRun); return; }
      if ((b = t.closest('[data-au-doc]'))) { window.MorfisDocs.open(b.dataset.auDoc); return; }
      if ((b = t.closest('[data-au-mail]'))) {
        var m = ST.outbox.find(function (x) { return x.id === b.dataset.auMail; });
        if (m) mailModal(m, function () { ST.outbox = ST.outbox.filter(function (x) { return x !== m; }); put('outbox'); redraw(); M.redrawSide(); });
      }
    });
    el.addEventListener('change', function (e) {
      var t = e.target;
      if (t.id === 'auModel') { M.setPref('aiModel', t.value).then(function () { checkAi(true); }); return; }
      if (t.dataset.auPref) { M.setPref(t.dataset.auPref, t.checked).then(function () { AI.status && (AI.status.enabled = t.checked); redraw(); }); return; }
      if (t.dataset.auRule) {
        var r = RULES.find(function (x) { return x.key === t.dataset.auRule; });
        if (r.pref) M.setPref(r.key, t.checked).then(function () { if (t.checked) runFolderIcons(); else clearFolderIcons().then(function (n) { if (n) M.toast('Removed the icons from ' + n + ' folder' + (n === 1 ? '' : 's') + '.'); }); redraw(); });
        else { ST.settings[r.key] = t.checked; put('settings'); if (t.checked) runRule(r.key); }
      }
    });
  }
  M.register('automations', {
    title: 'Automations', placeholder: 'Search',
    render: function (el) { EL = el; bind(el); el.innerHTML = view(); checkAi(true); },
    refresh: function () { redraw(); }
  });

  /* ===== schedule ===== */
  var lastDraft = 0;
  function tick() {
    if (!ready || !pg() || !pg().S.ready) return;
    runDraftInvoices();
    checkAi().then(function () { runFollowUps().then(function () { runDigest(false); }); });
    runFolderIcons();
  }
  window.addEventListener('morfis:render', function () { if (Date.now() - lastDraft > 60000 && ready && pg() && pg().S.ready) { lastDraft = Date.now(); runDraftInvoices(); } });
  loadState().then(function () { checkAi(true); setTimeout(function () { runFolderIcons(); }, 2500); setTimeout(tick, 8000); setInterval(tick, 30 * 60 * 1000); });

  /* redraw one project's folder icons now, even if nothing seems to have changed */
  function refreshIcons(pid) {
    var p = pg().P(pid); if (!p) return Promise.resolve(0);
    var base = pg().projDir(p);
    Object.keys(ST.icons).forEach(function (d) { if (d === base || d.indexOf(base) === 0) delete ST.icons[d]; });
    return runFolderIcons(pid);
  }
  window.MorfisAuto = { refreshIcons: refreshIcons, attention: attention, aiSort: aiSort, draftQuote: draftQuote, coverNote: coverNote, run: runRule, status: function () { return AI.status; } };
})();
