/* Automations: rules that keep the studio's paperwork moving, and an AI assistant that runs on this computer.
   The assistant uses Ollama (free, open source) with an open model such as Qwen 2.5. Nothing is sent online.
   Rules work without the assistant; where it helps (wording, sorting odd file names, drafting quotes) it is used
   when available, and a plain template takes its place when it is not. */
(function () {
  'use strict';
  var M = window.Morfis, A = window.MorfisArt;
  if (!M || !A) return;
  var H = M.H, esc = M.esc, ic = M.ic, pg = M.page;
  var KV = { settings: 'auto:settings', log: 'auto:log', drafted: 'auto:drafted', outbox: 'auto:outbox', followed: 'auto:followed', digest: 'auto:digest', icons: 'auto:icons',
    custom: 'auto:custom', fired: 'auto:fired', seen: 'auto:seen', notes: 'auto:notes' };
  var DEF_SETTINGS = { draftInvoices: true, followUps: true, digest: true, quoteExpiry: true, lateTasks: true, holdNudge: true, freshFolders: true };
  var ST = { settings: Object.assign({}, DEF_SETTINGS), log: [], drafted: {}, outbox: [], followed: {}, digest: null, icons: {}, custom: [], fired: {}, seen: null, notes: [] };
  var AI = { status: null, checking: false, pull: null };
  var ready = false;

  var RULES = [
    { key: 'draftInvoices', kind: 'Rule', icon: 'documents', title: 'Draft the invoice when a stage is reached', text: 'When a project reaches the stage a milestone is billed at, a draft invoice is prepared in Invoices & quotes for you to check and issue.' },
    { key: 'followUps', kind: 'AI', icon: 'mail', title: 'Payment follow-ups for overdue invoices', text: 'For each overdue invoice, a short, polite reminder email is written for you to review, copy or open in your email program. Once a week per invoice.' },
    { key: 'digest', kind: 'AI', icon: 'sparkle', title: 'Monday studio summary', text: 'Every Monday, a short summary of what needs attention: overdue money, tasks due this week, quotes waiting for an answer.' },
    { key: 'quoteExpiry', kind: 'Rule', icon: 'documents', title: 'Quotations about to expire', text: 'Three days before a sent quotation runs out, and again when it has expired, you get a notification and a note to follow it up with the client.' },
    { key: 'lateTasks', kind: 'Rule', icon: 'bell', title: 'Morning task check', text: 'Once a day, a notification lists the tasks that are past due or due today, so nothing slips while you are on other projects.' },
    { key: 'holdNudge', kind: 'Rule', icon: 'refresh', title: 'Projects on hold for a month', text: 'When a project has been On hold for 30 days, a note asks whether to restart, keep waiting or close it. Again every 30 days.' },
    { key: 'freshFolders', kind: 'Rule', icon: 'files', title: 'Keep folder counts up to date', text: 'Every 15 minutes the folders of active projects are read again, so Files, the folder icons and the counts match what is on the disk.' },
    { key: 'folderIcons', kind: 'Rule', icon: 'files', title: 'Same folder icons in File Explorer', text: 'Project folders and their six standard folders get the icons you see in Files: the status badge, the folder number and the main file type. They follow every change within seconds.', pref: true },
    { key: 'aiSort', kind: 'AI', icon: 'sort', title: 'Sort files the rules cannot place', text: 'In Files, “Sort with AI” reads the names of loose files and suggests one of the six standard folders. You check before anything moves, and it can be undone.', manual: 'Files' },
    { key: 'quote', kind: 'AI', icon: 'documents', title: 'Quotation assistant', text: 'In a quotation, describe the job and the lines, quantities and rates are drafted from your studio’s past projects.', manual: 'Invoices & quotes' }
  ];

  /* ----- state on disk ----- */
  function loadState() {
    return Promise.all(Object.keys(KV).map(function (k) { return H.kvGet(KV[k]).then(function (v) { if (v != null) ST[k] = v; }, function () {}); }))
      .then(function () {
        ST.settings = Object.assign({}, DEF_SETTINGS, ST.settings);
        if (!Array.isArray(ST.custom)) ST.custom = [];
        if (!Array.isArray(ST.notes)) ST.notes = [];
        if (!ST.fired || typeof ST.fired !== 'object') ST.fired = {};
        ready = true;
      });
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

  /* ===== notes: small to-dos the automations leave under Waiting for you ===== */
  function note(icon, title, sub, link) {
    ST.notes.unshift({ id: M.uid('n'), icon: icon, title: title, sub: sub || '', link: link || null, at: pg().today() });
    ST.notes = ST.notes.slice(0, 40); put('notes');
  }
  /* once per key, or once per key every `every` days */
  function onceFor(key, every) {
    var last = ST.fired[key], today = pg().today();
    if (last && (!every || M.addDays(last, every) > today)) return false;
    ST.fired[key] = today; return true;
  }
  function pruneFired() {
    var cut = M.addDays(pg().today(), -400);
    Object.keys(ST.fired).forEach(function (k) { if (ST.fired[k] < cut) delete ST.fired[k]; });
  }

  /* ===== rule: quotations about to expire ===== */
  function runQuoteExpiry() {
    if (!ST.settings.quoteExpiry || !window.MorfisDocs) return 0;
    var today = pg().today(), n = 0;
    window.MorfisDocs.all().forEach(function (d) {
      if (d.type !== 'quote' || d.status !== 'sent' || !d.validUntil) return;
      var soon = d.validUntil >= today && d.validUntil <= M.addDays(today, 3), gone = d.validUntil < today;
      if (!soon && !gone) return;
      if (!onceFor('qx|' + d.id + '|' + (gone ? 'gone' : 'soon'))) return;
      var t = (gone ? 'Quotation ' + d.no + ' has expired' : 'Quotation ' + d.no + ' expires ' + M.fdate(d.validUntil));
      note('documents', t, (d.clientName || 'Client') + (d.projectName ? ' · ' + d.projectName : '') + ' · ask whether to go ahead, or extend it', { doc: d.id });
      H.notify(t, 'Follow it up with ' + (d.clientName || 'the client') + '.');
      n++;
    });
    if (n) { put('fired'); log('documents', n + ' quotation' + (n === 1 ? ' needs' : 's need') + ' a follow-up.'); M.redrawSide(); }
    return n;
  }
  /* ===== rule: the morning task check ===== */
  function runLateTasks(force) {
    var today = pg().today(), late = [], due = [];
    if (!force && (!ST.settings.lateTasks || new Date().getHours() < 7 || ST.fired['tasks|' + today])) return 0;
    Object.values(pg().S.projects).forEach(function (p) {
      if (p.status === 'closed') return;
      p.tasks.forEach(function (t) { if (t.status === 'done' || !t.due) return; if (t.due < today) late.push({ p: p, t: t }); else if (t.due === today) due.push({ p: p, t: t }); });
    });
    ST.fired['tasks|' + today] = today; put('fired');
    if (!late.length && !due.length) return 0;
    var title = (late.length ? late.length + ' task' + (late.length === 1 ? ' is' : 's are') + ' past due' : '') + (late.length && due.length ? ', ' : '') + (due.length ? due.length + ' due today' : '');
    var first = (late[0] || due[0]);
    H.notify(title.charAt(0).toUpperCase() + title.slice(1), '“' + first.t.title + '” · ' + first.p.name);
    log('bell', 'Morning check: ' + title + '.');
    return late.length + due.length;
  }
  /* ===== rule: projects on hold for a month ===== */
  function runHoldNudge() {
    if (!ST.settings.holdNudge) return 0;
    var today = pg().today(), n = 0;
    Object.values(pg().S.projects).forEach(function (p) {
      if (A.statusOf(p, today) !== 'on_hold') return;
      var since = p.workStatusAt || (p.updatedAt ? String(p.updatedAt).slice(0, 10) : '') || today;
      if (M.addDays(since, 30) > today) return;
      if (!onceFor('hold|' + p.id, 30)) return;
      note('refresh', p.name + ' has been on hold since ' + M.fdate(since), p.code + ' · restart it, keep waiting, or close it', { pid: p.id });
      n++;
    });
    if (n) { put('fired'); log('refresh', n + ' project' + (n === 1 ? ' has' : 's have') + ' been on hold for a month.'); M.redrawSide(); }
    return n;
  }
  /* ===== rule: read the active project folders again ===== */
  var freshAt = 0;
  function runFreshFolders(force) {
    if (!ST.settings.freshFolders && !force) return Promise.resolve(0);
    if (!force && Date.now() - freshAt < 15 * 60 * 1000) return Promise.resolve(0);
    freshAt = Date.now();
    var today = pg().today(), list = Object.values(pg().S.projects).filter(function (p) { var st = A.statusOf(p, today); return p.foldersCreated && !p.dirMissing && st !== 'completed' && st !== 'cancelled'; });
    var changed = 0;
    return list.reduce(function (c, p) { return c.then(function () { return pg().rescanProject(p, { quiet: true }).then(function (ch) { if (ch) changed++; }, function () {}); }); }, Promise.resolve()).then(function () { return changed; });
  }

  /* ===== your own automations: when something happens, do something ===== */
  var STATUS_OPTS = function () { return A.ORDER.map(function (k) { return [k, A.STATUS[k].label]; }); };
  var STAGE_OPTS = function () { return pg().STAGES.map(function (s) { return [String(s.n), s.n + ' · ' + s.name]; }); };
  var DOW = [['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday'], ['0', 'Sunday']];
  var TRIGGERS = {
    status: { label: 'A project’s status changes to', param: 'status', scope: 'project' },
    stage: { label: 'A project reaches stage', param: 'stage', scope: 'project' },
    invoiceReady: { label: 'A milestone is ready to invoice', scope: 'invoice' },
    invoiceOverdue: { label: 'An invoice is overdue by at least', param: 'days', unit: 'days', def: 7, scope: 'invoice' },
    taskDue: { label: 'A task is due within', param: 'days', unit: 'days', def: 2, scope: 'task' },
    quoteExpiring: { label: 'A sent quotation expires within', param: 'days', unit: 'days', def: 3, scope: 'quote' },
    weekly: { label: 'Every week on', param: 'dow', scope: 'time' },
    daily: { label: 'Every day', scope: 'time' }
  };
  var ACTIONS = {
    notify: { label: 'Show a Windows notification', text: true },
    reminder: { label: 'Add a reminder under the bell', text: true, days: true },
    note: { label: 'Add a to-do under Waiting for you', text: true },
    email: { label: 'Draft an email to the client', text: true, ai: true },
    status: { label: 'Set the project’s status to', status: true, needs: 'project' },
    ai: { label: 'Ask the AI assistant', text: true }
  };
  var TOKENS = ['{project}', '{code}', '{client}', '{stage}', '{status}', '{invoice}', '{amount}', '{due}', '{days}', '{task}', '{quote}', '{studio}', '{date}'];
  var PRESETS = [
    { name: 'Close-out checklist', trigger: { type: 'status', status: 'completed' }, action: { type: 'reminder', days: 0, text: 'Close out {project}: invoice the retention, archive the drawings, ask {client} for feedback' } },
    { name: 'Firm reminder after 14 days overdue', trigger: { type: 'invoiceOverdue', days: 14 }, action: { type: 'email', ai: true, text: 'Dear {client},\n\nInvoice {invoice} for {project} ({amount}) was due on {due} and is now {days} days overdue. Could you let us know when we can expect payment?\n\nKind regards,\n{studio}' } },
    { name: 'Heads-up two days before a task is due', trigger: { type: 'taskDue', days: 2 }, action: { type: 'notify', text: '“{task}” is due {due} · {project}' } },
    { name: 'Chase a quotation before it expires', trigger: { type: 'quoteExpiring', days: 5 }, action: { type: 'reminder', days: 0, text: 'Call {client} about quotation {quote} before {due}' } },
    { name: 'Friday wrap-up', trigger: { type: 'weekly', dow: '5' }, action: { type: 'notify', text: 'Friday wrap-up: update the stages and tasks, file this week’s drawings' } },
    { name: 'Schematic design kick-off', trigger: { type: 'stage', stage: '2' }, action: { type: 'note', text: 'Send the schematic design programme to {client} for {project}' } },
    { name: 'Pause invoicing when a project goes on hold', trigger: { type: 'status', status: 'on_hold' }, action: { type: 'note', text: '{project} is on hold: check open invoices and tell the team' } }
  ];

  /* the things a trigger is about right now, each with a key (so it fires once) and the words its message can use */
  function words(base) { return Object.assign({ studio: pg().S.settings.studio || '', date: M.fdate(pg().today()) }, base); }
  function pWords(p) { var st = A.statusOf(p, pg().today()); return { project: p.name, code: p.code, client: (p.client && p.client.name) || 'the client', contact: (p.client && p.client.contact) || '', stage: p.currentStage + ' ' + pg().STAGES[Math.min(7, p.currentStage) - 1].name, status: A.STATUS[st].label, pid: p.id }; }
  function matches(r, transitions) {
    var t = r.trigger || {}, today = pg().today(), out = [];
    var keep = function (p) { return !r.only || A.statusOf(p, today) === r.only; };
    if (t.type === 'status' || t.type === 'stage') {
      (transitions || []).forEach(function (x) {
        var p = pg().P(x.pid); if (!p || !keep(p)) return;
        if (t.type === 'status' && x.st === t.status && x.prevSt !== t.status) out.push({ key: p.id + '|' + x.st + '|' + today, w: words(pWords(p)), p: p });
        if (t.type === 'stage' && x.stage === +t.stage && x.prevStage < +t.stage) out.push({ key: p.id + '|s' + x.stage, w: words(pWords(p)), p: p });
      });
    } else if (t.type === 'invoiceReady' || t.type === 'invoiceOverdue') {
      Object.values(pg().S.projects).forEach(function (p) {
        if (!keep(p)) return;
        p.milestones.forEach(function (m, i) {
          var inf = pg().invoiceInfo(p, i, today);
          if (t.type === 'invoiceReady' && inf.status === 'ready' && p.status !== 'closed') out.push({ key: p.id + '|' + m.id, p: p, w: words(Object.assign(pWords(p), { invoice: m.label, amount: M.money(inf.amount), due: '', days: '0' })) });
          if (t.type === 'invoiceOverdue' && inf.status === 'overdue') {
            var days = Math.round((new Date(today) - new Date(m.invoice.due)) / 864e5);
            if (days >= (+t.days || 0)) out.push({ key: p.id + '|' + m.id, p: p, w: words(Object.assign(pWords(p), { invoice: m.invoice.no, amount: M.money(inf.balance), due: M.fdate(m.invoice.due), days: String(days) })) });
          }
        });
      });
    } else if (t.type === 'taskDue') {
      var end = M.addDays(today, +t.days || 0);
      Object.values(pg().S.projects).forEach(function (p) {
        if (p.status === 'closed' || !keep(p)) return;
        p.tasks.forEach(function (k) { if (k.status !== 'done' && k.due && k.due >= today && k.due <= end) out.push({ key: p.id + '|' + k.id + '|' + k.due, p: p, w: words(Object.assign(pWords(p), { task: k.title, due: M.fdate(k.due), days: String(Math.round((new Date(k.due) - new Date(today)) / 864e5)) })) }); });
      });
    } else if (t.type === 'quoteExpiring' && window.MorfisDocs) {
      var qend = M.addDays(today, +t.days || 0);
      window.MorfisDocs.all().forEach(function (d) {
        if (d.type !== 'quote' || d.status !== 'sent' || !d.validUntil || d.validUntil < today || d.validUntil > qend) return;
        var p = d.pid && pg().P(d.pid);
        if (r.only && !(p && keep(p))) return;
        out.push({ key: d.id + '|' + d.validUntil, p: p || null, doc: d.id, w: words(Object.assign(p ? pWords(p) : { project: d.projectName || '', client: d.clientName || 'the client', contact: d.clientContact || '' }, { quote: d.no, due: M.fdate(d.validUntil), amount: window.MorfisDocs.fmt(window.MorfisDocs.totals(d).total, d.currency), client: d.clientName || 'the client' })) });
      });
    } else if (t.type === 'weekly') {
      if (String(new Date(today + 'T00:00:00').getDay()) === String(t.dow)) out.push({ key: 'w|' + today, p: null, w: words({}) });
    } else if (t.type === 'daily') out.push({ key: 'd|' + today, p: null, w: words({}) });
    return out;
  }
  function fill(text, w) { return String(text || '').replace(/\{(\w+)\}/g, function (m, k) { return w[k] != null ? w[k] : m; }); }
  function act(r, hit) {
    var a = r.action || {}, text = fill(a.text, hit.w), p = hit.p;
    if (a.type === 'notify') { H.notify(r.name || 'Automation', text); return Promise.resolve(); }
    if (a.type === 'note') { note('automations', text, r.name, p ? { pid: p.id } : hit.doc ? { doc: hit.doc } : null); return Promise.resolve(); }
    if (a.type === 'reminder') {
      var S = pg().S;
      S.settings.reminders = (S.settings.reminders || []).concat([{ id: M.uid('rm'), title: text.slice(0, 200), date: M.addDays(pg().today(), +a.days || 0), time: '', pid: p ? p.id : '', done: false, created: pg().today() }]);
      pg().commitSettings(); return Promise.resolve();
    }
    if (a.type === 'status') { if (p && a.status && A.statusOf(p, pg().today()) !== a.status) M.setWorkStatus(p.id, a.status); return Promise.resolve(); }
    if (a.type === 'email') {
      var write = a.ai && aiUsable() ? ask('You polish short professional emails for an architecture and interior design studio. Keep the facts exactly, plain text, no subject line, under 140 words.', 'Polish this email:\n\n' + text).then(function (x) { return { text: x.text || text, ai: true }; }, function () { return { text: text, ai: false }; }) : Promise.resolve({ text: text, ai: false });
      return write.then(function (wr) {
        ST.outbox.unshift({ id: M.uid('m'), key: 'c|' + hit.key, to: /@/.test(hit.w.contact || '') ? hit.w.contact : '', client: hit.w.client || '', subject: (r.name || 'Message') + (hit.w.project ? ' · ' + hit.w.project : ''), body: wr.text, ai: wr.ai, created: pg().today() });
        ST.outbox = ST.outbox.slice(0, 30); put('outbox');
      });
    }
    if (a.type === 'ai') {
      if (!aiUsable()) { note('sparkle', text, (r.name || 'Automation') + ' · the AI assistant was not available, so here is the question', p ? { pid: p.id } : null); return Promise.resolve(); }
      return ask('You are the studio manager of an architecture and interior design practice. Answer briefly and practically, plain text, under 120 words.', text).then(function (x) {
        note('sparkle', r.name || 'The assistant', x.text, p ? { pid: p.id } : null);
      }, function () { note('sparkle', text, r.name || 'Automation', p ? { pid: p.id } : null); });
    }
    return Promise.resolve();
  }
  /* projects whose status or stage moved since last time; the first look only remembers */
  function transitions() {
    var today = pg().today(), now = {}, out = [], first = !ST.seen;
    Object.values(pg().S.projects).forEach(function (p) { now[p.id] = { st: A.statusOf(p, today), stage: p.currentStage }; });
    if (!first) Object.keys(now).forEach(function (id) {
      var a = ST.seen[id], b = now[id];
      if (!a) return;
      if (a.st !== b.st || a.stage !== b.stage) out.push({ pid: id, st: b.st, prevSt: a.st, stage: b.stage, prevStage: a.stage });
    });
    var changed = first || out.length || Object.keys(now).length !== Object.keys(ST.seen || {}).length;
    ST.seen = now; if (changed) put('seen');
    return out;
  }
  var customBusy = false;
  function runCustom(onlyId, force) {
    if (!ready || customBusy || !pg() || !pg().S.ready) return Promise.resolve(0);
    customBusy = true;
    var tr = transitions(), n = 0;
    var jobs = [];
    ST.custom.forEach(function (r) {
      if ((onlyId && r.id !== onlyId) || (!r.on && !force)) return;
      matches(r, tr).forEach(function (hit) {
        var key = 'c|' + r.id + '|' + hit.key;
        if (ST.fired[key] && !force) return;
        ST.fired[key] = pg().today();
        jobs.push(function () { return act(r, hit).then(function () { n++; r.last = new Date().toISOString(); r.runs = (r.runs || 0) + 1; }, function () {}); });
      });
    });
    return jobs.reduce(function (c, j) { return c.then(j); }, Promise.resolve()).then(function () {
      customBusy = false;
      if (jobs.length) { put('fired'); put('custom'); log('automations', 'Your automations ran ' + n + ' time' + (n === 1 ? '' : 's') + '.'); M.redrawSide(); redraw(); }
      return n;
    }, function () { customBusy = false; return n; });
  }
  window.addEventListener('morfis:status', function () { setTimeout(function () { runCustom(); }, 300); });
  var customT = 0;
  window.addEventListener('morfis:render', function () { clearTimeout(customT); customT = setTimeout(function () { runCustom(); }, 1500); });

  /* the editor for one automation */
  function optHtml(list, v) { return list.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(v) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join(''); }
  function describe(r) {
    var t = r.trigger || {}, a = r.action || {}, T = TRIGGERS[t.type] || { label: '?' }, X = ACTIONS[a.type] || { label: '?' };
    var when = T.label + (T.param === 'status' ? ' ' + (A.STATUS[t.status] || {}).label : T.param === 'stage' ? ' ' + t.stage : T.param === 'days' ? ' ' + (+t.days || 0) + ' days' : T.param === 'dow' ? ' ' + ((DOW.find(function (d) { return d[0] === String(t.dow); }) || [])[1] || '') : '');
    var then = X.label + (a.type === 'status' ? ' ' + (A.STATUS[a.status] || {}).label : '');
    return { when: when, then: then };
  }
  function editRule(id, preset) {
    var r = id ? ST.custom.find(function (x) { return x.id === id; }) : null;
    var d = JSON.parse(JSON.stringify(r || preset || { name: '', trigger: { type: 'status', status: 'completed' }, action: { type: 'notify', text: '' } }));
    d.trigger = d.trigger || {}; d.action = d.action || {};
    var body = '<div class="au-ed">' +
      (r || preset ? '' : '<div class="field"><span class="fl">Start from an example</span><div class="au-presets">' + PRESETS.map(function (pr, i) { return '<button type="button" class="chip-btn" data-preset="' + i + '">' + esc(pr.name) + '</button>'; }).join('') + '</div></div>') +
      '<div class="field"><label for="auName">Name</label><input class="in" id="auName" maxlength="80" value="' + esc(d.name) + '" placeholder="Close-out checklist"></div>' +
      '<div class="au-ed-blk"><span class="au-ed-k">When</span><div class="au-ed-row"><select class="in" id="auTr">' + optHtml(Object.keys(TRIGGERS).map(function (k) { return [k, TRIGGERS[k].label]; }), d.trigger.type) + '</select><span id="auTrP"></span></div></div>' +
      '<div class="au-ed-blk"><span class="au-ed-k">Only for</span><div class="au-ed-row"><select class="in" id="auOnly"><option value="">Any project</option>' + optHtml(STATUS_OPTS().map(function (o) { return [o[0], 'Projects that are ' + o[1]]; }), d.only || '') + '</select></div></div>' +
      '<div class="au-ed-blk"><span class="au-ed-k">Then</span><div class="au-ed-row"><select class="in" id="auAc">' + optHtml(Object.keys(ACTIONS).map(function (k) { return [k, ACTIONS[k].label]; }), d.action.type) + '</select><span id="auAcP"></span></div>' +
      '<div class="field" id="auTxtF"><label for="auTxt">Message</label><textarea class="in" id="auTxt" rows="4" maxlength="1200">' + esc(d.action.text || '') + '</textarea><span class="hint small muted">You can use ' + TOKENS.map(function (t) { return '<button type="button" class="au-tok" data-tok="' + t + '">' + t + '</button>'; }).join(' ') + '</span></div>' +
      '<label class="switch dk-sw" id="auAiF"><input type="checkbox" id="auAi"' + (d.action.ai ? ' checked' : '') + '><span>Let the AI assistant polish the wording, when it is available</span></label></div>' +
      '<p class="err" id="auErr"></p></div>' +
      '<div class="dlg-foot">' + (r ? '<button type="button" class="btn danger ghost" id="auDel" style="margin-right:auto">Delete</button>' : '') + '<button type="button" class="btn" data-act="close">Cancel</button><button type="button" class="btn primary" id="auSave">' + (r ? 'Save' : 'Create automation') + '</button></div>';
    M.modal(r ? 'Edit automation' : 'New automation', body, { wide: true });
    var $ = function (x) { return document.getElementById(x); };
    function params() {
      var T = TRIGGERS[$('auTr').value], X = ACTIONS[$('auAc').value];
      var tp = '';
      if (T.param === 'status') tp = '<select class="in" id="auTrV">' + optHtml(STATUS_OPTS(), d.trigger.status || 'completed') + '</select>';
      else if (T.param === 'stage') tp = '<select class="in" id="auTrV">' + optHtml(STAGE_OPTS(), d.trigger.stage || '2') + '</select>';
      else if (T.param === 'days') tp = '<span class="au-num"><input class="in" id="auTrV" type="number" min="0" max="365" value="' + esc(d.trigger.days != null ? d.trigger.days : T.def) + '"><em>days</em></span>';
      else if (T.param === 'dow') tp = '<select class="in" id="auTrV">' + optHtml(DOW, d.trigger.dow || '1') + '</select>';
      $('auTrP').innerHTML = tp;
      var ap = '';
      if (X.status) ap = '<select class="in" id="auAcV">' + optHtml(STATUS_OPTS(), d.action.status || 'in_progress') + '</select>';
      else if (X.days) ap = '<span class="au-num"><em>in</em><input class="in" id="auAcV" type="number" min="0" max="365" value="' + esc(d.action.days || 0) + '"><em>days</em></span>';
      $('auAcP').innerHTML = ap;
      $('auTxtF').hidden = !X.text; $('auAiF').hidden = !X.ai;
      $('auErr').textContent = X.needs === 'project' && ['status', 'stage', 'invoiceReady', 'invoiceOverdue', 'taskDue'].indexOf($('auTr').value) === -1 ? 'Setting a status needs a trigger about a project.' : '';
    }
    function read() {
      var tv = $('auTrV'), av = $('auAcV'), tt = $('auTr').value, at = $('auAc').value, T = TRIGGERS[tt];
      d.trigger = { type: tt }; if (tv) d.trigger[T.param] = T.param === 'days' ? Math.max(0, Math.min(365, +tv.value || 0)) : tv.value;
      d.action = { type: at, text: $('auTxt').value.trim(), ai: $('auAi').checked }; if (av) { if (ACTIONS[at].status) d.action.status = av.value; else d.action.days = Math.max(0, +av.value || 0); }
      d.only = $('auOnly').value; d.name = $('auName').value.trim();
    }
    $('auTr').addEventListener('change', function () { read(); params(); });
    $('auAc').addEventListener('change', function () { read(); params(); });
    params();
    var ov = document.getElementById('overlay');
    ov.querySelectorAll('[data-preset]').forEach(function (b) { b.addEventListener('click', function () { var pr = PRESETS[+b.dataset.preset]; pg().closeModal(); editRule(null, JSON.parse(JSON.stringify(pr))); }); });
    ov.querySelectorAll('[data-tok]').forEach(function (b) { b.addEventListener('click', function () { var ta = $('auTxt'), at = ta.selectionStart || ta.value.length; ta.value = ta.value.slice(0, at) + b.dataset.tok + ta.value.slice(ta.selectionEnd || at); ta.focus(); ta.selectionStart = ta.selectionEnd = at + b.dataset.tok.length; }); });
    if ($('auDel')) $('auDel').addEventListener('click', function () {
      if (!window.confirm('Delete the automation “' + (r.name || 'Untitled') + '”?')) return;
      ST.custom = ST.custom.filter(function (x) { return x !== r; }); put('custom'); pg().closeModal(); redraw(); M.toast('Automation deleted.');
    });
    $('auSave').addEventListener('click', function () {
      read();
      var X = ACTIONS[d.action.type];
      if (X.needs === 'project' && ['status', 'stage', 'invoiceReady', 'invoiceOverdue', 'taskDue'].indexOf(d.trigger.type) === -1) { $('auErr').textContent = 'Setting a status needs a trigger about a project.'; return; }
      if (X.text && !d.action.text) { $('auErr').textContent = 'Write the message.'; $('auTxt').focus(); return; }
      if (!d.name) d.name = describe(d).then;
      if (r) Object.assign(r, d); else { d.id = M.uid('ar'); d.on = true; d.created = pg().today(); ST.custom.push(d); }
      put('custom'); pg().closeModal(); redraw();
      M.toast(r ? 'Automation saved.' : 'Automation created. It runs by itself from now on.');
      /* what is already true when it is made counts as seen, so a new rule does not fire for every old item at once */
      if (!r) { var tr = transitions(); matches(d, tr).forEach(function (hit) { ST.fired['c|' + d.id + '|' + hit.key] = pg().today(); }); put('fired'); }
    });
  }
  function customCard(r) {
    var ds = describe(r);
    return '<div class="au-rule au-own' + (r.on ? '' : ' off') + '"><div class="au-rule-h"><span class="au-rule-ic">' + ic('automations', 17) + '</span><span class="au-kind">Yours</span>' +
      '<label class="switch" style="margin-left:auto" title="' + (r.on ? 'On' : 'Off') + '"><input type="checkbox" data-au-own="' + esc(r.id) + '"' + (r.on ? ' checked' : '') + ' aria-label="' + esc(r.name) + '"></label></div>' +
      '<b>' + esc(r.name || 'Untitled') + '</b><p class="small muted"><span class="au-w">When</span> ' + esc(ds.when) + (r.only ? ' (' + esc(A.STATUS[r.only].label) + ' projects)' : '') + '<br><span class="au-w">Then</span> ' + esc(ds.then) + '</p>' +
      '<div class="au-rule-f"><button type="button" class="btn sm" data-au-edit="' + esc(r.id) + '">Edit</button><button type="button" class="btn sm" data-au-own-run="' + esc(r.id) + '">' + ic('play', 13) + 'Run now</button>' +
      (r.runs ? '<span class="small muted" style="margin-left:auto">' + r.runs + ' run' + (r.runs === 1 ? '' : 's') + '</span>' : '') + '</div></div>';
  }
  function customSection() {
    return '<section><div class="fx-sec-h"><h2>Your automations</h2><span class="count">' + ST.custom.length + '</span><button type="button" class="btn sm primary" data-au-new style="margin-left:auto">' + ic('plus', 14) + 'New automation</button></div>' +
      (ST.custom.length ? '<div class="au-rules">' + ST.custom.map(customCard).join('') + '</div>' :
        '<div class="fx-empty fx-empty-col"><b>Make your own</b><span>Pick what should happen when a project changes status, reaches a stage, an invoice runs late, a task or quotation comes due, or on a schedule.</span><span class="au-presets">' +
        PRESETS.slice(0, 4).map(function (pr) { return '<button type="button" class="chip-btn" data-au-preset="' + PRESETS.indexOf(pr) + '">' + ic('plus', 12) + esc(pr.name) + '</button>'; }).join('') + '</span></div>') + '</section>';
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
    ST.notes.slice(0, 10).forEach(function (n) { parts.push('<div class="au-item"><span class="au-item-ic">' + ic(n.icon || 'check', 16) + '</span><div><b title="' + esc(n.title) + '">' + esc(n.title) + '</b><span class="small muted au-sub">' + esc(n.sub || '') + '</span></div>' + (n.link ? '<button type="button" class="btn sm" data-au-note="' + esc(n.id) + '">Open</button>' : '') + '<button type="button" class="icon-btn" data-au-note-x="' + esc(n.id) + '" title="Done" aria-label="Done">' + ic('check', 15) + '</button></div>'); });
    ST.outbox.slice(0, 8).forEach(function (m) { parts.push('<div class="au-item"><span class="au-item-ic">' + ic('mail', 16) + '</span><div><b>' + esc(m.subject) + '</b><span class="small muted">Reminder to ' + esc(m.client || 'the client') + (m.ai ? ' · written by the assistant' : '') + '</span></div><button type="button" class="btn sm" data-au-mail="' + esc(m.id) + '">Review</button></div>'); });
    return parts.length ? parts.join('') : '<p class="muted small" style="padding:6px 2px">Nothing waiting. Drafts and reminders the automations prepare show up here.</p>';
  }
  function view() {
    var dg = ST.digest;
    return '<div class="fx-head"><div><h1>Automations</h1><p class="muted">Rules and a private AI assistant that look after the routine work. You stay in control: everything they make waits for your review.</p></div></div>' +
      engineCard() +
      '<div class="au-cols"><div class="au-left">' + customSection() + '<section><div class="fx-sec-h"><h2>Built in</h2><span class="count">' + RULES.length + '</span></div><div class="au-rules">' + RULES.map(ruleCard).join('') + '</div></section></div>' +
      '<section class="au-right"><div class="fx-sec-h"><h2>Waiting for you</h2><span class="count">' + attention() + '</span></div><div class="card au-review">' + reviewHtml() + '</div>' +
      '<div class="fx-sec-h"><h2>This week</h2>' + (dg ? '<span class="small muted">' + esc(M.fdate(dg.date)) + (dg.ai ? ' · by the assistant' : '') + '</span>' : '') + '<button type="button" class="btn sm" data-au-run="digest" style="margin-left:auto">' + ic('refresh', 13) + 'Write now</button></div>' +
      '<div class="card au-digest">' + (dg ? esc(dg.text).replace(/\n/g, '<br>') : '<span class="muted small">The Monday summary appears here.</span>') + '</div>' +
      '<div class="fx-sec-h"><h2>Activity</h2></div><div class="card au-log">' + (ST.log.length ? ST.log.slice(0, 14).map(function (l) { return '<div class="au-log-r">' + ic(l.icon || 'check', 14) + '<span>' + esc(l.text) + '</span><em>' + esc(new Date(l.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) + '</em></div>'; }).join('') : '<span class="muted small">Nothing has run yet.</span>') + '</div></section></div>';
  }
  var EL = null;
  var lastView = '';
  function redraw() { if (EL && M.current() === 'automations') { var h = view(); if (h === lastView) return; lastView = h; var y = EL.scrollTop; EL.innerHTML = h; EL.scrollTop = y; } }
  function attention() { var docs = window.MorfisDocs ? window.MorfisDocs.all().filter(function (d) { return d.status === 'draft' && d.mid; }).length : 0; return docs + ST.outbox.length + ST.notes.length; }

  function runRule(key) {
    if (key === 'draftInvoices') { var n = runDraftInvoices(); M.toast(n ? 'Drafted ' + n + ' invoice' + (n === 1 ? '' : 's') + '.' : 'No milestones are waiting for an invoice.'); redraw(); }
    else if (key === 'followUps') { ST.followed = {}; runFollowUps().then(function (n) { M.toast(n ? 'Wrote ' + n + ' follow-up' + (n === 1 ? '' : 's') + '.' : 'No invoices are overdue.'); redraw(); }); }
    else if (key === 'digest') { M.toast('Writing the summary…'); runDigest(true).then(function () { redraw(); }); }
    else if (key === 'quoteExpiry') { var q = runQuoteExpiry(); M.toast(q ? q + ' quotation' + (q === 1 ? ' needs' : 's need') + ' a follow-up.' : 'No sent quotations are about to expire.'); redraw(); }
    else if (key === 'lateTasks') { var lt = runLateTasks(true); M.toast(lt ? 'Sent the task check: ' + lt + ' task' + (lt === 1 ? '' : 's') + '.' : 'No tasks are late or due today.'); }
    else if (key === 'holdNudge') { var h = runHoldNudge(); M.toast(h ? h + ' project' + (h === 1 ? ' has' : 's have') + ' been on hold for a month.' : 'No project has been on hold for 30 days.'); redraw(); }
    else if (key === 'freshFolders') { M.toast('Reading the project folders…'); runFreshFolders(true).then(function (n) { M.toast(n ? 'Updated ' + n + ' project folder' + (n === 1 ? '' : 's') + '.' : 'The folders are up to date.'); }); }
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
      if ((b = t.closest('[data-au-new]'))) { editRule(null); return; }
      if ((b = t.closest('[data-au-preset]'))) { editRule(null, JSON.parse(JSON.stringify(PRESETS[+b.dataset.auPreset]))); return; }
      if ((b = t.closest('[data-au-edit]'))) { editRule(b.dataset.auEdit); return; }
      if ((b = t.closest('[data-au-own-run]'))) { var rid = b.dataset.auOwnRun; runCustom(rid, true).then(function (n) { M.toast(n ? 'Ran ' + n + ' time' + (n === 1 ? '' : 's') + '.' : 'Nothing matches it right now.'); }); return; }
      if ((b = t.closest('[data-au-note-x]'))) { ST.notes = ST.notes.filter(function (x) { return x.id !== b.dataset.auNoteX; }); put('notes'); redraw(); M.redrawSide(); return; }
      if ((b = t.closest('[data-au-note]'))) {
        var nn = ST.notes.find(function (x) { return x.id === b.dataset.auNote; }); if (!nn || !nn.link) return;
        if (nn.link.doc && window.MorfisDocs) window.MorfisDocs.open(nn.link.doc); else if (nn.link.pid) M.go('project', { id: nn.link.pid });
        return;
      }
      if ((b = t.closest('[data-au-doc]'))) { window.MorfisDocs.open(b.dataset.auDoc); return; }
      if ((b = t.closest('[data-au-mail]'))) {
        var m = ST.outbox.find(function (x) { return x.id === b.dataset.auMail; });
        if (m) mailModal(m, function () { ST.outbox = ST.outbox.filter(function (x) { return x !== m; }); put('outbox'); redraw(); M.redrawSide(); });
      }
    });
    el.addEventListener('change', function (e) {
      var t = e.target;
      if (t.id === 'auModel') { M.setPref('aiModel', t.value).then(function () { checkAi(true); }); return; }
      if (t.dataset.auOwn) { var cr = ST.custom.find(function (x) { return x.id === t.dataset.auOwn; }); if (cr) { cr.on = t.checked; put('custom'); redraw(); } return; }
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
    render: function (el) { EL = el; bind(el); lastView = view(); el.innerHTML = lastView; checkAi(true); },
    refresh: function () { redraw(); }
  });

  /* ===== schedule ===== */
  var lastDraft = 0;
  function tick() {
    if (!ready || !pg() || !pg().S.ready) return;
    runDraftInvoices(); runQuoteExpiry(); runLateTasks(); runHoldNudge(); pruneFired();
    checkAi().then(function () { runFollowUps().then(function () { runDigest(false); }).then(function () { return runCustom(); }); });
    runFreshFolders().then(function () { runFolderIcons(); });
  }
  window.addEventListener('morfis:render', function () { if (Date.now() - lastDraft > 60000 && ready && pg() && pg().S.ready) { lastDraft = Date.now(); runDraftInvoices(); } });
  loadState().then(function () { checkAi(true); setTimeout(function () { runFolderIcons(); }, 2500); setTimeout(tick, 8000); setInterval(tick, 10 * 60 * 1000); });

  /* redraw one project's folder icons now, even if nothing seems to have changed */
  function refreshIcons(pid) {
    var p = pg().P(pid); if (!p) return Promise.resolve(0);
    var base = pg().projDir(p);
    Object.keys(ST.icons).forEach(function (d) { if (d === base || d.indexOf(base) === 0) delete ST.icons[d]; });
    return runFolderIcons(pid);
  }
  window.MorfisAuto = { refreshIcons: refreshIcons, attention: attention, aiSort: aiSort, draftQuote: draftQuote, coverNote: coverNote, run: runRule, status: function () { return AI.status; } };
})();
