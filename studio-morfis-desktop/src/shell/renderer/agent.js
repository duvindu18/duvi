/* The assistant's hands: everything Morfis can do in the studio, as tools with clear rules.
   Safe changes (adding projects, jobs, tasks, reminders, folders and automations; ticking tasks off; moving a project
   on to its next stage; dates of single tasks) are done straight away, each with Undo. Changes that delete
   something, touch money (fees, payments, invoices), close a project, move a whole timeline, go back a stage or
   rename and move folders wait for your OK, and nothing is done until you give it.
   Every action is written to the activity log in Automations. */
(function () {
  'use strict';
  var M = window.Morfis, A = window.MorfisArt;
  if (!M || !A) return;
  var H = M.H, pg = M.page;
  var FL = function () { return window.MorfisFreelance; };
  var today = function () { return pg().today(); };
  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  var money = function (n) { return M.money(n); };
  var ymd = function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : ''; };
  var log = function (text) { if (window.MorfisAuto && window.MorfisAuto.log) window.MorfisAuto.log('sparkle', 'Assistant: ' + text); };

  /* ----- finding things by what they are called (forgiving small mishearings) ----- */
  var norm = function (s) { return String(s || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); };
  function lev(a, b) {
    if (a === b) return 0; var m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    var row = []; for (var j = 0; j <= n; j++) row[j] = j;
    for (var i = 1; i <= m; i++) { var prev = row[0]; row[0] = i; for (j = 1; j <= n; j++) { var t = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; } }
    return row[n];
  }
  var near = function (a, b) { return a === b || (a.length > 3 && b.length > 3 && lev(a, b) <= Math.max(1, Math.floor(Math.min(a.length, b.length) / 4))); };
  var SKIP = { the: 1, a: 1, an: 1, project: 1, job: 1, task: 1, my: 1, of: 1, for: 1, to: 1 };
  function score(q, name, code) {
    var words = norm(name).split(' ').filter(Boolean), qs = norm(q).split(' ').filter(function (w) { return w && !SKIP[w]; });
    if (!qs.length) return 0;
    var hit = qs.filter(function (w) { return words.some(function (x) { return near(w, x); }); }).length;
    var s = hit / qs.length + (hit && hit === words.length ? 0.3 : 0);
    var num = (/\b(\d{1,4})\b/.exec(norm(q)) || [])[1];
    if (num && code && new RegExp('\\b0*' + (+num) + '$').test(String(code).replace(/\s/g, ''))) s += 0.9;
    return s;
  }
  function best(list, q, nameOf, codeOf) {
    if (!q) return { err: 'Which one?' };
    var r = list.map(function (x) { return { x: x, s: score(q, nameOf(x), codeOf ? codeOf(x) : '') }; }).filter(function (r) { return r.s >= 0.5; }).sort(function (a, b) { return b.s - a.s; });
    if (!r.length) return { err: 'I couldn’t find “' + q + '”.' };
    if (r.length > 1 && r[0].s - r[1].s < 0.2 && r[0].s < 1.2) return { err: 'Which one do you mean: ' + r.slice(0, 3).map(function (y) { return nameOf(y.x); }).join(' or ') + '?', choices: r.slice(0, 3).map(function (y) { return y.x; }) };
    return { x: r[0].x };
  }
  var projectOf = function (q) { if (q && pg().P(q)) return { x: pg().P(q) }; return best(Object.values(pg().S.projects), q, function (p) { return p.name; }, function (p) { return p.code; }); };
  var jobOf = function (q) { if (!FL()) return { err: 'Freelance is not available.' }; if (q && FL().get(q)) return { x: FL().get(q) }; return best(FL().all(), q, function (j) { return j.title || j.code; }, function (j) { return j.code; }); };
  /* a project or a job, whichever the name fits best */
  function anyOf(q) {
    var p = projectOf(q), j = jobOf(q);
    var sp = p.x ? score(q, p.x.name, p.x.code) : 0, sj = j.x ? score(q, j.x.title || j.code, j.x.code) : 0;
    if (p.x && (!j.x || sp >= sj)) return { kind: 'p', x: p.x };
    if (j.x) return { kind: 'j', x: j.x };
    return { err: p.err || j.err };
  }
  var taskOf = function (p, q) { return best(p.tasks || [], q, function (t) { return t.title || ''; }); };
  function amount(v) {
    if (typeof v === 'number') return v;
    var s = String(v || '').toLowerCase().replace(/,/g, '').replace(/(rs\.?|lkr|rupees?)/g, '').trim(), m = /([\d.]+)\s*(k|thousand|m|mn|million|lakh|lakhs)?/.exec(s);
    if (!m) return NaN;
    var n = parseFloat(m[1]), u = m[2] || '';
    return Math.round(n * (/^k|thousand/.test(u) ? 1e3 : /^m/.test(u) ? 1e6 : /lakh/.test(u) ? 1e5 : 1));
  }
  var STAT = { completed: 'completed', done: 'completed', delivered: 'completed', closed: 'completed', finished: 'completed', on_hold: 'on_hold', hold: 'on_hold', paused: 'on_hold', in_progress: 'in_progress', active: 'in_progress', ongoing: 'in_progress', started: 'in_progress', not_started: 'not_started', upcoming: 'not_started', cancelled: 'cancelled', canceled: 'cancelled' };
  var statusKey = function (s) { return STAT[String(s || '').toLowerCase().replace(/\s+/g, '_')] || ''; };

  /* ----- the tools ----- */
  /* each: what it needs, whether it asks first (ask), a one-line description for the confirmation, and run() */
  var T = {};
  T.create_project = {
    help: 'Create a direct project with the seven stages, tasks and milestone invoices (and its folders). args: name, client?, location?, type?, budget?, start? (YYYY-MM-DD)',
    check: function (a) { return a.name ? '' : 'What should the project be called?'; },
    text: function (a) { return 'Create the project ' + a.name + (a.client ? ' for ' + a.client : ''); },
    run: function (a) {
      var S = pg().S, codes = Object.values(S.projects).map(function (x) { return x.code; });
      var p = pg().makeProject({ code: pg().nextProjectCode(codes, +today().slice(0, 4), S.settings.codeFormat), name: String(a.name).trim(), clientName: a.client || '', clientContact: a.contact || '', location: a.location || '',
        type: a.type || undefined, budget: amount(a.budget) || 0, retainPct: S.settings.retainPct, startDate: ymd(a.start) || today(), team: [] }, S.settings.team);
      pg().commit(p);
      if (a.folders !== false && pg().makeFoldersNow && !window.MORFIS_REMOTE) pg().makeFoldersNow([p], true).catch(function () {});
      return { say: 'Created ' + p.name + ', ' + p.code + ', starting ' + M.fdate(p.startDate) + ', with its stages, ' + p.tasks.length + ' tasks and the milestone invoices.', ref: { kind: 'p', id: p.id },
        undo: function () { pg().removeProject(p.id); pg().renderAll(); } };
    }
  };
  T.add_task = {
    help: 'Add a task to a project. args: project, title, stage? (1-7, default the current stage), due? (YYYY-MM-DD)',
    check: function (a) { var p = projectOf(a.project); return p.err || (a.title ? '' : 'What is the task?'); },
    text: function (a) { return 'Add the task “' + a.title + '” to ' + projectOf(a.project).x.name; },
    run: function (a) {
      var p = projectOf(a.project).x, st = Math.min(7, Math.max(1, +a.stage || p.currentStage || 1));
      var t = { id: pg().uid('t'), stage: st, title: String(a.title).trim(), deliverable: '', assignee: null, due: ymd(a.due) || (p.stages[st - 1] && p.stages[st - 1].end) || today(), status: 'todo' };
      p.tasks.push(t); pg().commit(p);
      return { say: 'Added “' + t.title + '” to ' + p.name + ', due ' + M.fdate(t.due) + '.', ref: { kind: 'p', id: p.id }, undo: function () { p.tasks = p.tasks.filter(function (x) { return x !== t; }); pg().commit(p); } };
    }
  };
  T.set_task_status = {
    help: 'Tick a task off or change it. args: project, task, status (done | doing | todo)',
    check: function (a) { var p = projectOf(a.project); if (p.err) return p.err; var t = taskOf(p.x, a.task); return t.err || ''; },
    text: function (a) { return 'Mark “' + taskOf(projectOf(a.project).x, a.task).x.title + '” as ' + (a.status || 'done'); },
    run: function (a) {
      var p = projectOf(a.project).x, t = taskOf(p, a.task).x, prev = t.status, want = /doing|progress|start/.test(a.status || '') ? 'doing' : /todo|open|undo/.test(a.status || '') ? 'todo' : 'done';
      t.status = want; pg().commit(p);
      return { say: '“' + t.title + '” is ' + (want === 'done' ? 'done' : want === 'doing' ? 'in progress' : 'open again') + '.', ref: { kind: 'p', id: p.id }, undo: function () { t.status = prev; pg().commit(p); } };
    }
  };
  T.set_task_due = {
    help: 'Change the due date of one task. args: project, task, due (YYYY-MM-DD)',
    check: function (a) { var p = projectOf(a.project); if (p.err) return p.err; var t = taskOf(p.x, a.task); return t.err || (ymd(a.due) ? '' : 'When should it be due?'); },
    text: function (a) { return 'Move “' + taskOf(projectOf(a.project).x, a.task).x.title + '” to ' + M.fdate(a.due); },
    run: function (a) { var p = projectOf(a.project).x, t = taskOf(p, a.task).x, prev = t.due; t.due = ymd(a.due); pg().commit(p); return { say: '“' + t.title + '” is now due ' + M.fdate(t.due) + '.', undo: function () { t.due = prev; pg().commit(p); } }; }
  };
  T.delete_task = {
    help: 'Delete a task. args: project, task', ask: true,
    check: function (a) { var p = projectOf(a.project); if (p.err) return p.err; return taskOf(p.x, a.task).err || ''; },
    text: function (a) { return 'Delete the task “' + taskOf(projectOf(a.project).x, a.task).x.title + '” from ' + projectOf(a.project).x.name; },
    run: function (a) { var p = projectOf(a.project).x, t = taskOf(p, a.task).x; p.tasks = p.tasks.filter(function (x) { return x !== t; }); pg().commit(p); return { say: 'Deleted “' + t.title + '”.', undo: function () { p.tasks.push(t); pg().commit(p); } }; }
  };
  T.set_stage = {
    help: 'Move a project to a stage (1-7) or to the next one. args: project, stage? (number, or "next")',
    ask: function (a) { var p = projectOf(a.project).x; return !!p && a.stage !== 'next' && +a.stage < p.currentStage; },
    check: function (a) { var p = projectOf(a.project); if (p.err) return p.err; if (p.x.status === 'closed') return p.x.name + ' is closed.'; var n = a.stage === 'next' || !a.stage ? p.x.currentStage + 1 : +a.stage; return n >= 1 && n <= 7 ? (n === p.x.currentStage ? p.x.name + ' is already in stage ' + n + '.' : '') : (n > 7 ? p.x.name + ' is already in the last stage.' : 'Which stage, 1 to 7?'); },
    text: function (a) { var p = projectOf(a.project).x, n = a.stage === 'next' || !a.stage ? p.currentStage + 1 : +a.stage; return 'Move ' + p.name + ' to stage ' + n + ', ' + pg().STAGES[n - 1].name; },
    run: function (a) {
      var p = projectOf(a.project).x, prev = p.currentStage, n = a.stage === 'next' || !a.stage ? prev + 1 : +a.stage;
      p.currentStage = n; pg().commit(p);
      var open = p.tasks.filter(function (t) { return t.stage === prev && t.status !== 'done'; }).length;
      return { say: p.name + ' is now in stage ' + n + ', ' + pg().STAGES[n - 1].name + '.' + (n > prev && open ? ' Stage ' + prev + ' still has ' + open + ' open task' + (open === 1 ? '' : 's') + '.' : ''), undo: function () { p.currentStage = prev; pg().commit(p); } };
    }
  };
  T.reschedule = {
    help: 'Move a project’s whole timeline (stages and open tasks). args: project, start? (YYYY-MM-DD new start) or days? (shift, + later / - earlier)', ask: true,
    check: function (a) { var p = projectOf(a.project); if (p.err) return p.err; return ymd(a.start) || +a.days ? '' : 'By how much should it move?'; },
    delta: function (a, p) { return ymd(a.start) ? Math.round((new Date(a.start + 'T00:00:00') - new Date(p.stages[0].start + 'T00:00:00')) / 864e5) : Math.round(+a.days); },
    text: function (a) { var p = projectOf(a.project).x, d = T.reschedule.delta(a, p); return 'Move the timeline of ' + p.name + ' ' + Math.abs(d) + ' day' + (Math.abs(d) === 1 ? '' : 's') + (d >= 0 ? ' later' : ' earlier'); },
    run: function (a) {
      var p = projectOf(a.project).x, d = T.reschedule.delta(a, p), keep = clone({ stages: p.stages, tasks: p.tasks, startDate: p.startDate });
      var sh = function (s) { return s ? M.addDays(s, d) : s; };
      p.stages.forEach(function (s) { s.start = sh(s.start); s.end = sh(s.end); });
      p.tasks.forEach(function (t) { if (t.status !== 'done') t.due = sh(t.due); });
      p.startDate = sh(p.startDate); pg().commit(p);
      return { say: 'Moved ' + p.name + '’s timeline ' + Math.abs(d) + ' days ' + (d >= 0 ? 'later' : 'earlier') + '. It now ends ' + M.fdate(p.stages[6].end) + '.', undo: function () { p.stages = keep.stages; p.tasks = keep.tasks; p.startDate = keep.startDate; pg().commit(p); } };
    }
  };
  T.set_status = {
    help: 'Set the status of a project or freelance job. args: name, status (in_progress | on_hold | not_started | completed | cancelled)',
    ask: function (a) { var s = statusKey(a.status); return s === 'completed' || s === 'cancelled'; },
    check: function (a) { var t = anyOf(a.name); return t.err || (statusKey(a.status) ? '' : 'Which status?'); },
    text: function (a) { var t = anyOf(a.name); return 'Set ' + (t.x.name || t.x.title) + ' to ' + A.STATUS[statusKey(a.status)].label; },
    run: function (a) {
      var t = anyOf(a.name), st = statusKey(a.status);
      if (t.kind === 'p') { var prev = t.x.workStatus, prevS = t.x.status; M.setWorkStatus(t.x.id, st); return { say: t.x.name + ' is now ' + A.STATUS[st].label.toLowerCase() + '.', undo: function () { t.x.workStatus = prev; t.x.status = prevS; pg().commit(t.x); } }; }
      var j = t.x, pj = j.status, pd = j.delivered; j.status = st; if (st === 'completed' && !j.delivered) j.delivered = today(); FL().save();
      return { say: (j.title || j.code) + ' is now ' + A.STATUS[st].label.toLowerCase() + '.', undo: function () { j.status = pj; j.delivered = pd; FL().save(); } };
    }
  };
  T.update_project = {
    help: 'Change a project’s details. args: project, name?, client?, contact?, location?, budget?', ask: true,
    check: function (a) { return projectOf(a.project).err || ''; },
    text: function (a) { var p = projectOf(a.project).x, ch = []; ['name', 'client', 'contact', 'location'].forEach(function (k) { if (a[k]) ch.push(k + ' to “' + a[k] + '”'); }); if (a.budget != null) ch.push('fee to ' + money(amount(a.budget))); return 'Change ' + p.name + ': ' + ch.join(', '); },
    run: function (a) {
      var p = projectOf(a.project).x, keep = clone({ name: p.name, client: p.client, location: p.location, budget: p.budget });
      if (a.name) p.name = a.name; if (a.client) p.client.name = a.client; if (a.contact) p.client.contact = a.contact; if (a.location) p.location = a.location; if (a.budget != null && amount(a.budget) >= 0) p.budget = amount(a.budget);
      pg().commit(p);
      return { say: 'Updated ' + p.name + '.', undo: function () { Object.assign(p, { name: keep.name, location: keep.location, budget: keep.budget }); p.client = keep.client; pg().commit(p); } };
    }
  };
  T.issue_invoice = {
    help: 'Issue the next milestone invoice that is ready (or a given milestone). args: project, milestone? (label or number), terms_days?', ask: true,
    pick: function (a, p) {
      var list = p.milestones.map(function (m, i) { return { m: m, i: i, info: pg().invoiceInfo(p, i, today()) }; }).filter(function (x) { return !x.m.invoice; });
      if (a.milestone) { var n = +a.milestone; return list.find(function (x) { return n ? x.i === n - 1 : score(a.milestone, x.m.label) >= 0.5; }); }
      return list.find(function (x) { return x.info.status === 'ready'; });
    },
    check: function (a) { var p = projectOf(a.project); if (p.err) return p.err; return T.issue_invoice.pick(a, p.x) ? '' : 'No milestone of ' + p.x.name + ' is ready to invoice yet.'; },
    text: function (a) { var p = projectOf(a.project).x, x = T.issue_invoice.pick(a, p); return 'Issue invoice ' + pg().invoiceNo(p, x.i) + ' to ' + ((p.client && p.client.name) || 'the client') + ' for “' + x.m.label + '”, ' + money(x.info.amount); },
    run: function (a) {
      var p = projectOf(a.project).x, x = T.issue_invoice.pick(a, p), terms = +a.terms_days || 14;
      x.m.invoice = { no: pg().invoiceNo(p, x.i), issued: today(), due: M.addDays(today(), terms), ref: '', note: '' }; pg().commit(p);
      return { say: 'Issued ' + x.m.invoice.no + ' for ' + money(x.info.amount) + ', due ' + M.fdate(x.m.invoice.due) + '.', undo: function () { x.m.invoice = null; pg().commit(p); } };
    }
  };
  T.record_payment = {
    help: 'Record a payment received against a project’s issued invoices. args: project, amount, date?', ask: true,
    target: function (p) { return p.milestones.map(function (m, i) { return { m: m, i: i, info: pg().invoiceInfo(p, i, today()) }; }).find(function (x) { return x.m.invoice && x.info.balance > 0; }); },
    check: function (a) { var p = projectOf(a.project); if (p.err) return p.err; var x = T.record_payment.target(p.x), n = amount(a.amount); if (!x) return p.x.name + ' has no issued invoice waiting for payment.'; return n > 0 ? (n > x.info.balance ? 'That is more than the ' + money(x.info.balance) + ' left on ' + x.m.invoice.no + '.' : '') : 'How much was paid?'; },
    text: function (a) { var p = projectOf(a.project).x, x = T.record_payment.target(p); return 'Record ' + money(amount(a.amount)) + ' received for ' + x.m.invoice.no + ' (' + p.name + ')'; },
    run: function (a) {
      var p = projectOf(a.project).x, x = T.record_payment.target(p), n = amount(a.amount);
      var r = { id: pg().uid('r'), date: ymd(a.date) || today(), amount: n, retained: pg().retainOn(p, n), method: '', ref: 'Recorded by voice', kind: 'payment' };
      x.m.receipts.push(r); pg().commit(p);
      var left = x.info.balance - n;
      return { say: left <= 0 ? x.m.invoice.no + ' is paid in full.' : 'Recorded. ' + money(left) + ' is still outstanding on ' + x.m.invoice.no + '.', undo: function () { x.m.receipts = x.m.receipts.filter(function (y) { return y !== r; }); pg().commit(p); } };
    }
  };
  T.delete_project = {
    help: 'Delete a project record (its folder on disk stays). args: project', ask: true,
    check: function (a) { return projectOf(a.project).err || ''; },
    text: function (a) { return 'Delete the project ' + projectOf(a.project).x.name + ' (its tasks, invoices and payment log; the folder on the computer stays)'; },
    run: function (a) { var p = projectOf(a.project).x, keep = clone(p); pg().removeProject(p.id); pg().renderAll(); return { say: 'Deleted ' + keep.name + '. Its folder is still on the computer.', undo: function () { pg().commit(keep); } }; }
  };
  /* freelance */
  T.create_job = {
    help: 'Start a freelance job. args: title, client?, platform? (Fiverr | Upwork | Freelancer | Direct client | Other), fee?, due? (YYYY-MM-DD), brief?, deliverables? [{kind: model|drawing|render|other, qty, label}]',
    check: function (a) { return FL() ? '' : 'Freelance is not available.'; },
    text: function (a) { return 'Start the freelance job ' + (a.title || '') + (a.client ? ' for ' + a.client : ''); },
    run: function (a) {
      var o = { title: a.title || '', client: a.client || '', brief: a.brief || '' };
      if (a.platform) o.platform = a.platform; if (amount(a.fee) > 0) o.fee = amount(a.fee); if (ymd(a.due)) o.due = ymd(a.due);
      if (Array.isArray(a.deliverables) && a.deliverables.length) o.deliverables = a.deliverables.map(function (d) { var k = /render/.test(d.kind) ? 'render' : /draw|dwg/.test(d.kind) ? 'drawing' : /3d|model/.test(d.kind) ? 'model' : 'other'; return { id: M.uid('d'), kind: k, label: d.label || { model: '3D model', drawing: 'Drawings', render: 'Renderings', other: 'Other' }[k], qty: Math.max(1, +d.qty || 1), done: false }; });
      var j = FL().add(o); FL().save();
      return { say: 'Started the job ' + (j.title || j.code) + (j.client ? ' for ' + j.client : '') + ', due ' + M.fdate(j.due) + '.', ref: { kind: 'j', id: j.id }, undo: function () { FL().replaceAll(FL().all().filter(function (x) { return x !== j; })); } };
    }
  };
  T.add_deliverable = {
    help: 'Add a deliverable to a freelance job. args: job, kind (model | drawing | render | other), qty?, label?',
    check: function (a) { return jobOf(a.job).err || ''; },
    text: function (a) { return 'Add ' + (a.qty || 1) + ' × ' + (a.label || a.kind) + ' to ' + (jobOf(a.job).x.title || 'the job'); },
    run: function (a) {
      var j = jobOf(a.job).x, k = /render/.test(a.kind) ? 'render' : /draw|dwg/.test(a.kind) ? 'drawing' : /3d|model/.test(a.kind) ? 'model' : 'other';
      var d = { id: M.uid('d'), kind: k, label: a.label || { model: '3D model', drawing: 'Drawings', render: 'Renderings', other: 'Other' }[k], qty: Math.max(1, +a.qty || 1), done: false };
      j.deliverables = (j.deliverables || []).concat([d]); FL().save();
      return { say: 'Added ' + d.qty + ' × ' + d.label + ' to ' + (j.title || j.code) + '.', undo: function () { j.deliverables = j.deliverables.filter(function (x) { return x !== d; }); FL().save(); } };
    }
  };
  T.deliver = {
    help: 'Tick off a deliverable of a freelance job (or all of them). args: job, item? (label or kind; "all")',
    check: function (a) { var j = jobOf(a.job); if (j.err) return j.err; return (j.x.deliverables || []).length ? '' : (j.x.title || 'The job') + ' has no deliverables yet.'; },
    text: function (a) { return 'Mark ' + (a.item || 'all deliverables') + ' of ' + (jobOf(a.job).x.title || 'the job') + ' as delivered'; },
    run: function (a) {
      var j = jobOf(a.job).x, all = !a.item || /\ball\b|everything/.test(a.item), list = all ? j.deliverables : j.deliverables.filter(function (d) { return score(a.item, d.label + ' ' + d.kind) >= 0.5; });
      if (!list.length) return { say: 'I couldn’t find “' + a.item + '” in ' + (j.title || j.code) + '.' };
      var prev = list.map(function (d) { return d.done; }); list.forEach(function (d) { d.done = true; }); FL().save();
      return { say: (all ? 'All deliverables' : list.map(function (d) { return d.label; }).join(', ')) + ' of ' + (j.title || j.code) + ' marked as delivered.', undo: function () { list.forEach(function (d, i) { d.done = prev[i]; }); FL().save(); } };
    }
  };
  T.set_job_due = {
    help: 'Change a freelance job’s due date. args: job, due (YYYY-MM-DD)',
    check: function (a) { return jobOf(a.job).err || (ymd(a.due) ? '' : 'When is it due?'); },
    text: function (a) { return 'Move ' + (jobOf(a.job).x.title || 'the job') + ' to ' + M.fdate(a.due); },
    run: function (a) { var j = jobOf(a.job).x, prev = j.due; j.due = ymd(a.due); FL().save(); return { say: (j.title || j.code) + ' is now due ' + M.fdate(j.due) + '.', undo: function () { j.due = prev; FL().save(); } }; }
  };
  T.set_job_money = {
    help: 'Set a freelance job’s fee or what has been paid. args: job, fee?, paid?', ask: true,
    check: function (a) { return jobOf(a.job).err || (a.fee != null || a.paid != null ? '' : 'The fee, or what was paid?'); },
    text: function (a) { var j = jobOf(a.job).x; return (a.fee != null ? 'Set the fee of ' + (j.title || j.code) + ' to ' + money(amount(a.fee)) : '') + (a.fee != null && a.paid != null ? ', and ' : '') + (a.paid != null ? 'record ' + money(amount(a.paid)) + ' paid' + (a.fee != null ? '' : ' on ' + (j.title || j.code)) : ''); },
    run: function (a) { var j = jobOf(a.job).x, keep = { fee: j.fee, paid: j.paid }; if (a.fee != null) j.fee = amount(a.fee); if (a.paid != null) j.paid = amount(a.paid); FL().save(); return { say: (j.title || j.code) + ': fee ' + money(j.fee) + ', paid ' + money(j.paid || 0) + '.', undo: function () { j.fee = keep.fee; j.paid = keep.paid; FL().save(); } }; }
  };
  T.delete_job = {
    help: 'Delete a freelance job record (its folder stays). args: job', ask: true,
    check: function (a) { return jobOf(a.job).err || ''; },
    text: function (a) { return 'Delete the freelance job ' + (jobOf(a.job).x.title || 'job') + ' (the folder on the computer stays)'; },
    run: function (a) { var j = jobOf(a.job).x, before = FL().all().slice(); FL().replaceAll(before.filter(function (x) { return x !== j; })); return { say: 'Deleted ' + (j.title || j.code) + '.', undo: function () { FL().replaceAll(before); } }; }
  };
  T.move_to = {
    help: 'Move a project to Freelance, or a freelance job to Direct projects (its folder moves too). args: name, to (freelance | direct)', ask: true,
    check: function (a) { var t = anyOf(a.name); if (t.err) return t.err; return (t.kind === 'p') === (/free/.test(a.to || '')) ? '' : 'It is already there.'; },
    text: function (a) { var t = anyOf(a.name); return 'Move ' + (t.x.name || t.x.title) + ' to ' + (t.kind === 'p' ? 'Freelance' : 'Direct projects') + ' (its folder moves too)'; },
    run: function (a) {
      var t = anyOf(a.name), conf = window.confirm; window.confirm = function () { return true; };
      try { if (t.kind === 'p') FL().fromProject(t.x.id); else FL().toDirect(t.x.id); } finally { window.confirm = conf; }
      return { say: 'Moving ' + (t.x.name || t.x.title) + '.' };
    }
  };
  /* reminders, folders, automations, documents, going places */
  T.add_reminder = {
    help: 'Add a reminder. args: title, date? (YYYY-MM-DD), time? (HH:MM), project?',
    check: function (a) { return a.title ? '' : 'What should I remind you about?'; },
    text: function (a) { return 'Remind you ' + (a.date ? 'on ' + M.fdate(a.date) : 'today') + ': ' + a.title; },
    run: function (a) {
      var p = a.project ? projectOf(a.project).x : null, r = { id: pg().uid('rm'), title: String(a.title).charAt(0).toUpperCase() + String(a.title).slice(1), date: ymd(a.date) || today(), time: /^\d\d:\d\d$/.test(a.time || '') ? a.time : '', pid: p ? p.id : '', done: false, created: today() };
      pg().S.settings.reminders = (pg().S.settings.reminders || []).concat([r]); pg().commitSettings();
      return { say: 'Okay, I’ll remind you ' + (r.date === today() ? 'today' : 'on ' + M.fdate(r.date)) + (r.time ? ' at ' + r.time : '') + ': ' + r.title + '.', undo: function () { pg().S.settings.reminders = pg().S.settings.reminders.filter(function (x) { return x !== r; }); pg().commitSettings(); } };
    }
  };
  T.make_folders = {
    help: 'Create the folders of a project or freelance job on the computer. args: name',
    check: function (a) { return window.MORFIS_REMOTE ? 'Folders are made on the computer.' : (anyOf(a.name).err || ''); },
    text: function (a) { var t = anyOf(a.name); return 'Create the folders of ' + (t.x.name || t.x.title); },
    run: function (a) {
      var t = anyOf(a.name);
      if (t.kind === 'j') { FL().makeFolder(t.x); return { say: 'Creating the folder of ' + (t.x.title || t.x.code) + '.' }; }
      pg().makeFoldersNow([t.x], true).catch(function () {});
      return { say: 'Creating the folders of ' + t.x.name + '.' };
    }
  };
  T.run_automation = {
    help: 'Run a built-in automation now. args: rule (one of the keys or titles listed)',
    find: function (a) { var list = window.MorfisAuto ? window.MorfisAuto.rules() : []; return list.find(function (r) { return r.key === a.rule; }) || best(list, a.rule, function (r) { return r.title; }).x; },
    check: function (a) { return T.run_automation.find(a) ? '' : 'Which automation?'; },
    text: function (a) { return 'Run “' + T.run_automation.find(a).title + '”'; },
    run: function (a) { var r = T.run_automation.find(a); window.MorfisAuto.run(r.key); return { say: 'Running “' + r.title + '”.' }; }
  };
  T.create_automation = {
    help: 'Create a custom automation. args: name, trigger {type: status (status) | stage (stage) | taskDue (days) | invoiceOverdue (days) | quoteExpiring (days) | weekly (dow 0-6)}, action {type: notify | reminder (days) | note | email, text with {project} {client} {task} {due}}',
    check: function (a) { return window.MorfisAuto && a.trigger && a.trigger.type && a.action && a.action.type && a.action.text ? '' : 'What should start it, and what should it do?'; },
    text: function (a) { return 'Create the automation “' + (a.name || 'New automation') + '”'; },
    run: function (a) { var r = window.MorfisAuto.addCustom({ name: a.name || 'New automation', trigger: a.trigger, action: a.action }); return { say: 'The automation “' + r.name + '” is on.', undo: function () { window.MorfisAuto.removeCustom(r.id); } }; }
  };
  T.draft_quote = {
    help: 'Draft a quotation (it stays a draft for you to check). args: client, project?, items [{desc, qty, unit, rate}]',
    check: function (a) { return window.MorfisDocs ? '' : 'Quotations are not available.'; },
    text: function (a) { return 'Draft a quotation for ' + (a.client || 'a client'); },
    run: function (a) {
      var p = a.project ? projectOf(a.project).x : null, d = window.MorfisDocs.blank('quotation', p ? p.id : null);
      d.clientName = a.client || (p && p.client && p.client.name) || '';
      if (Array.isArray(a.items) && a.items.length) d.items = a.items.map(function (x) { return { id: M.uid('l'), desc: x.desc || '', detail: x.detail || '', qty: +x.qty || 1, unit: x.unit || 'item', rate: amount(x.rate) || 0 }; });
      window.MorfisDocs.save(d, true);
      return { say: 'Drafted quotation ' + d.no + '. It is waiting in Invoices and quotes for you to check.', ref: { kind: 'doc', id: d.id } };
    }
  };
  T.open = {
    help: 'Open a page, project or job. args: what (home | projects | timeline | payments | files | direct | freelance | documents | automations | settings | a name)',
    check: function () { return ''; },
    text: function (a) { return 'Open ' + a.what; },
    run: function (a) {
      var v = norm(a.what), views = { home: 'home', dashboard: 'home', projects: 'projects', timeline: 'timeline', payments: 'payments', files: 'files', direct: 'direct', 'direct projects': 'direct', freelance: 'freelance', documents: 'documents', invoices: 'documents', automations: 'automations', settings: 'settings' };
      if (views[v]) { var dk = { files: 1, direct: 1, freelance: 1, documents: 1, automations: 1 }; if (dk[views[v]]) M.go(views[v]); else { var b = document.querySelector('#dkSide [data-go="' + views[v] + '"]'); if (b) b.click(); } return { say: 'Here you are.' }; }
      var t = anyOf(a.what); if (t.err) return { say: t.err };
      if (t.kind === 'j') M.go('freelance', { id: t.x.id }); else if (window.MorfisDirect) window.MorfisDirect.open(t.x.id); else M.go('project', { id: t.x.id });
      return { say: 'Here’s ' + (t.x.name || t.x.title) + '.' };
    }
  };

  /* ----- doing it: safe tools run now, the others wait for your OK ----- */
  var UNDO = [], PENDING = null;
  function needsOk(tool, a) { var t = T[tool]; return typeof t.ask === 'function' ? !!t.ask(a) : !!t.ask; }
  function execute(actions, o) {
    o = o || {};
    var done = [], wait = [], problems = [];
    (actions || []).forEach(function (act) {
      var t = T[act && act.tool], a = (act && act.args) || {};
      if (!t) { problems.push('I can’t do “' + (act && act.tool) + '”.'); return; }
      var bad = ''; try { bad = t.check(a); } catch (e) { bad = e.message; }
      if (bad) { problems.push(bad); return; }
      if (needsOk(act.tool, a) && !o.confirmed) { wait.push({ tool: act.tool, args: a, text: t.text(a) }); return; }
      try {
        var r = t.run(a) || {};
        if (r.undo) UNDO.push({ text: t.text(a), undo: r.undo });
        UNDO = UNDO.slice(-25);
        done.push(r); log(t.text(a) + (o.confirmed ? ' (you confirmed)' : ''));
      } catch (e) { problems.push('That didn’t work: ' + e.message); }
    });
    if (wait.length) PENDING = wait;
    return { done: done, wait: wait, problems: problems };
  }
  function confirm() { var p = PENDING; PENDING = null; return p ? execute(p, { confirmed: true }) : { done: [], wait: [], problems: ['There is nothing waiting.'] }; }
  function cancel() { var p = PENDING; PENDING = null; return !!p; }
  function undo() {
    var u = UNDO.pop(); if (!u) return { say: 'There is nothing to undo.' };
    try { u.undo(); log('undid: ' + u.text); return { say: 'Undone: ' + u.text.charAt(0).toLowerCase() + u.text.slice(1) + '.' }; } catch (e) { return { say: 'I couldn’t undo that: ' + e.message }; }
  }
  /* one sentence for the whole outcome */
  function summary(r) {
    var parts = r.done.map(function (d) { return d.say; }).filter(Boolean).concat(r.problems);
    if (r.wait.length) parts.push((r.wait.length === 1 ? 'This needs your OK: ' + r.wait[0].text + '.' : 'These need your OK: ' + r.wait.map(function (w) { return w.text; }).join('; ') + '.') + ' Shall I go ahead?');
    return parts.join(' ');
  }

  /* ----- planning with the local AI model, for requests no rule covers ----- */
  function context(said) {
    var S = pg().S, out = ['Today: ' + today() + '. Currency: ' + (S.settings.currency || 'LKR') + '.', 'Direct projects:'];
    Object.values(S.projects).forEach(function (p) {
      out.push('- "' + p.name + '" ' + p.code + ', ' + A.STATUS[A.statusOf(p, today())].label + ', stage ' + p.currentStage + ', starts ' + (p.stages[0] && p.stages[0].start) + ', client ' + ((p.client && p.client.name) || '-'));
      if (score(said, p.name, p.code) >= 0.5) (p.tasks || []).filter(function (t) { return t.status !== 'done'; }).slice(0, 25).forEach(function (t) { out.push('    task "' + t.title + '" stage ' + t.stage + ' due ' + t.due + ' ' + t.status); });
    });
    if (FL()) { out.push('Freelance jobs:'); FL().all().forEach(function (j) { out.push('- "' + (j.title || j.code) + '" ' + j.code + ', ' + FL().statusOf(j) + ', client ' + (j.client || '-') + ', due ' + (j.due || '-') + ', fee ' + (j.fee || 0) + ', paid ' + (j.paid || 0)); }); }
    if (window.MorfisAuto) out.push('Built-in automations: ' + window.MorfisAuto.rules().map(function (r) { return r.key + ' (' + r.title + ')'; }).join('; '));
    return out.join('\n');
  }
  /* the spoken answer, read out of the JSON while it is still being written: {"say": "…  */
  function partialSay(t) {
    var m = /"say"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(t || '');
    if (!m) return '';
    try { return JSON.parse('"' + m[1].replace(/\\$/, '') + '"'); } catch (e) { return m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"'); }
  }
  function plan(said, onSay) {
    var tools = Object.keys(T).map(function (k) { return '- ' + k + ': ' + T[k].help; }).join('\n');
    var sys = 'You are the assistant inside Seedform, an architecture studio\'s project app. Write calm, plain, warm sentences in UK English, no exclamation marks. Turn the request into actions using ONLY these tools:\n' + tools +
      '\n\nAnswer with JSON only: {"say": "one or two short spoken sentences", "actions": [{"tool": "...", "args": {...}}]}. Use exact project and job names from the data. Dates as YYYY-MM-DD. ' +
      'If the request is only a question, answer it in "say" with an empty "actions". If something is unclear, ask in "say" with no actions. Never invent projects or amounts.\n\n' + context(said);
    var o = { system: sys, prompt: said, json: true, timeoutMs: 60000 };
    var ask = onSay && H.aiStream ? H.aiStream(o, function (t) { var s = partialSay(t); if (s) onSay(s); }) : H.aiChat(o);
    return ask.then(function (r) {
      var d = r && r.data || {};
      return { say: String(d.say || '').trim(), actions: Array.isArray(d.actions) ? d.actions.filter(function (x) { return x && T[x.tool]; }).slice(0, 8) : [] };
    });
  }

  window.MorfisAgent = { tools: T, execute: execute, confirm: confirm, cancel: cancel, undo: undo, pending: function () { return PENDING; }, summary: summary, plan: plan, find: anyOf, projectOf: projectOf, jobOf: jobOf, amount: amount, needsOk: needsOk };
})();
