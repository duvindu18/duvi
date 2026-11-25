/* Morfis, the voice assistant. Press the microphone (or Ctrl+Space), speak naturally, and it answers aloud.
   Everything stays on this computer: Whisper listens and Kokoro speaks (voice-worker.js), and the requests are
   understood here, from the studio's own records: open a view or a project, what is due, who owes money, set a
   status, start a job, add a reminder, search. A question it has no rule for goes to the local AI model (Ollama)
   when one is installed. You can also type to it. */
(function () {
  'use strict';
  var M = window.Morfis, A = window.MorfisArt;
  if (!M || !A || window.MORFIS_REMOTE) return;
  var H = M.H, esc = M.esc, ic = M.ic, pg = M.page;
  var PR = function () { return M.prefs() || {}; };
  var VOICES = { af_heart: 'Heart (US, warm)', af_bella: 'Bella (US, bright)', af_nicole: 'Nicole (US, soft)', am_michael: 'Michael (US)', am_fenrir: 'Fenrir (US, deep)', bf_emma: 'Emma (UK)', bm_george: 'George (UK)' };

  /* ===== the engine (a worker; started on first use, stopped after 10 idle minutes to give the memory back) ===== */
  var WK = null, seq = 0, PEND = {}, idleT = 0, ENGINE = { ready: false, warming: null, threads: 0 };
  function worker() {
    if (!WK) {
      WK = new Worker('voice-worker.js', { type: 'module' });
      WK.onmessage = function (e) {
        var m = e.data || {}, h = PEND[m.id];
        if (m.type === 'loaded') { ENGINE.threads = m.threads; return; }
        if (!h) return;
        if (m.type === 'audio') { if (h.onAudio) h.onAudio(m); return; }
        delete PEND[m.id];
        if (m.type === 'error') h.rej(new Error(m.message)); else h.res(m);
      };
      WK.onerror = function () { Object.keys(PEND).forEach(function (k) { PEND[k].rej(new Error('The voice engine could not start.')); delete PEND[k]; }); WK = null; ENGINE.ready = false; ENGINE.warming = null; };
    }
    clearTimeout(idleT);
    idleT = setTimeout(function () { if (WK && !Object.keys(PEND).length && STATE === 'idle') { WK.terminate(); WK = null; ENGINE.ready = false; ENGINE.warming = null; } }, 10 * 60 * 1000);
    return WK;
  }
  function call(msg, onAudio) {
    return new Promise(function (res, rej) { msg.id = ++seq; PEND[msg.id] = { res: res, rej: rej, onAudio: onAudio }; worker().postMessage(msg); });
  }
  function warm() {
    if (ENGINE.ready) return Promise.resolve();
    if (!ENGINE.warming) ENGINE.warming = call({ type: 'warm', voice: PR().voiceName || 'af_heart', mouth: PR().voiceReply !== false }).then(function (r) { ENGINE.ready = true; ENGINE.threads = r.threads; }, function (e) { ENGINE.warming = null; throw e; });
    return ENGINE.warming;
  }

  /* ===== hearing: the microphone, a speech detector, then Whisper ===== */
  var MIC = null;
  function openMic() {
    if (MIC) return Promise.resolve(MIC);
    return navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(function (stream) {
      var ctx = new AudioContext({ sampleRate: 16000 });
      return ctx.audioWorklet.addModule('voice-capture.js').then(function () {
        var src = ctx.createMediaStreamSource(stream), node = new AudioWorkletNode(ctx, 'morfis-capture');
        src.connect(node);
        MIC = { stream: stream, ctx: ctx, node: node, onFrame: null };
        node.port.onmessage = function (e) { if (MIC && MIC.onFrame) MIC.onFrame(e.data); };
        return MIC;
      });
    });
  }
  function closeMic() {
    if (!MIC) return;
    try { MIC.stream.getTracks().forEach(function (t) { t.stop(); }); MIC.ctx.close(); } catch (e) { /* gone */ }
    MIC = null;
  }
  /* listen until the speaker stops: speech starts above the room's noise, ends after 0.9 s of quiet (max 15 s) */
  var LISTEN = null;
  function record() {
    return openMic().then(function (mic) {
      if (mic.ctx.state === 'suspended') mic.ctx.resume();
      return new Promise(function (resolve) {
        var frames = [], floor = 0.004, n = 0, talking = false, quiet = 0, total = 0, done = false;
        var finish = function (why) { if (done) return; done = true; mic.onFrame = null; LISTEN = null; var len = frames.reduce(function (a, f) { return a + f.length; }, 0), out = new Float32Array(len), at = 0; frames.forEach(function (f) { out.set(f, at); at += f.length; }); resolve({ audio: out, why: why, spoke: talking }); };
        LISTEN = { stop: function () { finish(talking ? 'stopped' : 'none'); }, cancel: function () { frames = []; talking = false; finish('cancel'); } };
        mic.onFrame = function (f) {
          var s = 0; for (var i = 0; i < f.length; i++) s += f[i] * f[i];
          var rms = Math.sqrt(s / f.length); n++; total += f.length; FRAMES++;
          LEVEL = Math.min(1, rms * 14);
          if (n <= 12) floor = Math.max(floor, rms * 0.9);
          var on = rms > Math.max(0.012, floor * 2.6);
          if (on) { talking = true; quiet = 0; } else if (talking) quiet += f.length;
          if (talking || frames.length < 15) frames.push(f); else frames = frames.slice(-15).concat([f]);
          if (talking && quiet > 16000 * 0.9) finish('end');
          else if (!talking && total > 16000 * 7) finish('none');
          else if (total > 16000 * 15) finish('long');
        };
      });
    });
  }

  /* ===== speaking: Kokoro, a phrase at a time; Windows' own voice if the engine is not there =====
     A talk is a queue of phrases: the first can be heard while the answer is still being written, and the next one
     is made while the one before plays. */
  var OUT = null, PLAY = { at: 0, sources: [], id: 0, cur: 0 };
  var clean = function (text) { return String(text).replace(/\s*\n\s*/g, '. ').replace(/[•·]/g, ',').replace(/\bLKR\b/g, 'rupees').replace(/\bFL I (\d+) I (\d+)\b/g, 'F L $1 $2').replace(/\bMRF I (\d+) I (\d+)\b/g, 'M R F $1 $2'); };
  function talkStart() {
    stopSpeaking();
    if (!OUT) { OUT = new AudioContext({ sampleRate: 24000 }); OUT.an = OUT.createAnalyser(); OUT.an.fftSize = 256; OUT.an.connect(OUT.destination); }
    if (OUT.state === 'suspended') OUT.resume();
    PLAY.at = OUT.currentTime + 0.03;
    var T = { g: ++seq, q: Promise.resolve() };
    PLAY.id = T.g;
    return T;
  }
  function talkAdd(T, text) {
    text = clean(text).trim();
    if (!text || T.g !== PLAY.id) return;
    T.q = T.q.then(function () {
      return new Promise(function (done) {
        if (T.g !== PLAY.id) { done(); return; }
        var id = ++seq; PLAY.cur = id;
        PEND[id] = { res: function () { done(); }, rej: function () { if (T.g === PLAY.id) winSpeak(text).then(done); else done(); },
          onAudio: function (m) {
            if (PLAY.id !== T.g) return;
            var b = OUT.createBuffer(1, m.pcm.length, m.rate); b.copyToChannel(m.pcm, 0);
            var src = OUT.createBufferSource(); src.buffer = b; src.connect(OUT.an);
            var at = Math.max(PLAY.at, OUT.currentTime + 0.02); src.start(at); PLAY.at = at + b.duration + 0.05; PLAY.sources.push(src);
            if (STATE !== 'speaking') setState('speaking');
          } };
        worker().postMessage({ type: 'speak', id: id, text: text, voice: PR().voiceName || 'af_heart', speed: +PR().voiceSpeed || 1 });
      });
    });
  }
  function talkEnd(T) {
    return T.q.then(function () {
      var wait = T.g === PLAY.id && OUT ? Math.max(0, (PLAY.at - OUT.currentTime) * 1000) : 0;
      return new Promise(function (r) { setTimeout(r, wait + 50); });
    }).then(function () { if (PLAY.id === T.g && STATE === 'speaking') setState('idle'); });
  }
  function speak(text) {
    if (!text || PR().voiceReply === false) { stopSpeaking(); return Promise.resolve(); }
    var T = talkStart(); talkAdd(T, text); return talkEnd(T);
  }
  /* where the text written so far can be cut and spoken: after a full stop, a question or, for the very first
     phrase, a comma, so the voice starts as soon as there is something worth saying */
  function cutAt(t, first) {
    var re = first ? /([.!?…]["”)]?|[,;:])\s/g : /[.!?…]["”)]?\s/g, m, end = 0;
    while ((m = re.exec(t))) { if (!first || m.index >= 18 || /[.!?…]/.test(m[1] || m[0])) { end = m.index + m[0].length; if (first) break; } }
    return end;
  }
  /* an answer that is still being written: shown as it comes, spoken a phrase at a time */
  function live() {
    var T = PR().voiceReply !== false && ENGINE.ready ? talkStart() : null, spoken = 0, last = '';
    return {
      text: function (t) {
        last = t; showLive(t);
        if (!T) return;
        var rest = t.slice(spoken), n = cutAt(rest, spoken === 0);
        if (n) { talkAdd(T, rest.slice(0, n)); spoken += n; }
      },
      /* the whole answer: say what is left of it, or all of it when it is not the one being written */
      finish: function (full) {
        if (!T) return null;
        var said = last.slice(0, spoken);
        talkAdd(T, full.indexOf(said) === 0 ? full.slice(spoken) : spoken ? '' : full);
        return talkEnd(T);
      }
    };
  }
  function winSpeak(text) {
    return new Promise(function (resolve) {
      if (!window.speechSynthesis) { resolve(); return; }
      var u = new SpeechSynthesisUtterance(text); u.rate = +PR().voiceSpeed || 1; u.onend = u.onerror = function () { resolve(); };
      setState('speaking'); window.speechSynthesis.speak(u);
    });
  }
  function stopSpeaking() {
    if (PLAY.cur) { try { if (WK) WK.postMessage({ type: 'stop', of: PLAY.cur }); } catch (e) { /* gone */ } }
    PLAY.cur = 0;
    PLAY.id = 0;
    PLAY.sources.forEach(function (s) { try { s.stop(); } catch (e) { /* done */ } });
    PLAY.sources = [];
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }

  /* ===== understanding ===== */
  var norm = function (s) { return String(s || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); };
  function lev(a, b) {
    if (a === b) return 0; var m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    var row = []; for (var j = 0; j <= n; j++) row[j] = j;
    for (var i = 1; i <= m; i++) { var prev = row[0]; row[0] = i; for (j = 1; j <= n; j++) { var t = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; } }
    return row[n];
  }
  var near = function (a, b) { return a === b || (a.length > 3 && b.length > 3 && lev(a, b) <= Math.max(1, Math.floor(Math.min(a.length, b.length) / 4))); };
  var STOPW = { the: 1, a: 1, an: 1, project: 1, job: 1, open: 1, show: 1, me: 1, to: 1, go: 1, for: 1, of: 1, my: 1, please: 1, folder: 1, page: 1, i: 1 };
  function things() {
    var S = pg().S, out = [];
    Object.values(S.projects).forEach(function (p) { out.push({ kind: 'p', id: p.id, name: p.name, code: p.code, st: A.statusOf(p, pg().today()) }); });
    if (window.MorfisFreelance) window.MorfisFreelance.all().forEach(function (j) { out.push({ kind: 'j', id: j.id, name: j.title || j.code, code: j.code, st: window.MorfisFreelance.statusOf(j) }); });
    return out;
  }
  /* the project or job a phrase names, by its words (forgiving small mishearings) or its number */
  function find(phrase) {
    var q = norm(phrase).split(' ').filter(function (w) { return w && !STOPW[w]; });
    if (!q.length) return [];
    var num = (/\b(\d{1,4})\b/.exec(q.join(' ')) || [])[1];
    return things().map(function (t) {
      var words = norm(t.name).split(' ').filter(Boolean), hit = 0;
      q.forEach(function (w) { if (words.some(function (x) { return near(w, x); })) hit++; });
      var score = hit / Math.max(q.length, 1) + (hit && hit === words.length ? 0.3 : 0);
      if (num && new RegExp('\\b0*' + (+num) + '$').test(String(t.code).replace(/\s/g, ''))) score += 0.9;
      return { t: t, score: score };
    }).filter(function (x) { return x.score >= 0.5; }).sort(function (a, b) { return b.score - a.score; });
  }
  var today = function () { return pg().today(); };
  var addDays = function (n) { return M.addDays(today(), n); };
  var when = function (ymd) { if (!ymd) return ''; var d = Math.round((new Date(ymd + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 864e5); return d === 0 ? 'today' : d === 1 ? 'tomorrow' : d === -1 ? 'yesterday' : d > 1 && d < 7 ? 'on ' + new Date(ymd + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long' }) : 'on ' + M.fdate(ymd); };
  var money = function (n) { return M.money(n); };
  var plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); };
  var listSay = function (arr) { return arr.length <= 1 ? arr.join('') : arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1]; };

  /* dates in a sentence: today, tomorrow, Friday, next week, in 3 days, on 5 December, the 12th */
  var DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  var MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  function dateIn(t) {
    var s = norm(t), m;
    if (/\bday after tomorrow\b/.test(s)) return { d: addDays(2), re: /\b(on )?the day after tomorrow\b/i };
    if (/\btomorrow\b/.test(s)) return { d: addDays(1), re: /\b(by |on )?tomorrow\b/i };
    if (/\btoday\b|\btonight\b/.test(s)) return { d: today(), re: /\b(by |on )?(today|tonight)\b/i };
    if ((m = /\bin (\d+|a|one|two|three|four|five|six|seven) (day|days|week|weeks)\b/.exec(s))) {
      var w = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 }[m[1]] || +m[1];
      return { d: addDays(w * (/week/.test(m[2]) ? 7 : 1)), re: new RegExp('\\bin ' + m[1] + ' ' + m[2] + '\\b', 'i') };
    }
    if (/\bnext week\b/.test(s)) return { d: addDays(7), re: /\bnext week\b/i };
    for (var i = 0; i < 7; i++) if (new RegExp('\\b' + DAYS[i] + '\\b').test(s)) {
      var dow = new Date(today() + 'T00:00:00').getDay(), diff = (i - dow + 7) % 7 || 7;
      return { d: addDays(diff), re: new RegExp('\\b(on |by |next |this )?' + DAYS[i] + '\\b', 'i') };
    }
    for (i = 0; i < 12; i++) {
      var r = new RegExp('\\b(\\d{1,2})(st|nd|rd|th)? (of )?' + MONTHS[i] + '\\b|\\b' + MONTHS[i] + ' (\\d{1,2})(st|nd|rd|th)?\\b', 'i'), mm = r.exec(t);
      if (mm) {
        var day = +(mm[1] || mm[4]), y = +today().slice(0, 4), cand = y + '-' + String(i + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
        if (cand < today()) cand = (y + 1) + cand.slice(4);
        return { d: cand, re: new RegExp('\\b(on |by )?(the )?' + mm[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i') };
      }
    }
    return null;
  }
  function timeIn(t) {
    var m = /\b(?:at )?(\d{1,2})(?:[:.](\d{2}))? ?(am|pm|a m|p m)\b/i.exec(t) || /\bat (\d{1,2})[:.](\d{2})\b/i.exec(t);
    if (!m) return null;
    var h = +m[1], mi = +(m[2] || 0), ap = (m[3] || '').replace(/\s/g, '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
    return { t: String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0'), re: new RegExp(m[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') };
  }

  /* what is coming up, from the dashboard's tasks and stages, the freelance deadlines and the invoices */
  function upcoming(from, to) {
    var S = pg().S, out = [];
    Object.values(S.projects).forEach(function (p) {
      var st = A.statusOf(p, today()); if (st === 'completed' || st === 'cancelled') return;
      (p.tasks || []).forEach(function (t) { if (t.status !== 'done' && t.due && t.due >= from && t.due <= to) out.push({ d: t.due, what: (t.title || t.name || 'A task') + ' for ' + p.name, go: { kind: 'p', id: p.id } }); });
    });
    if (window.MorfisFreelance) window.MorfisFreelance.all().forEach(function (j) { var s = window.MorfisFreelance.statusOf(j); if (s !== 'completed' && s !== 'cancelled' && j.due && j.due >= from && j.due <= to) out.push({ d: j.due, what: (j.title || j.code) + ' is due to the client', go: { kind: 'j', id: j.id } }); });
    (S.settings.reminders || []).forEach(function (r) { if (!r.done && r.date >= from && r.date <= to) out.push({ d: r.date, what: r.title, rem: true }); });
    return out.sort(function (a, b) { return a.d.localeCompare(b.d); });
  }
  function overdue() {
    var S = pg().S, list = [];
    Object.values(S.projects).forEach(function (p) {
      (p.milestones || []).forEach(function (m, i) { var x = pg().invoiceInfo(p, i, today()); if (x.status === 'overdue' && x.balance > 0) list.push({ p: p, amount: x.balance }); });
    });
    var late = window.MorfisFreelance ? window.MorfisFreelance.all().filter(function (j) { var s = window.MorfisFreelance.statusOf(j); return s === 'completed' && (+j.fee || 0) > (+j.paid || 0); }) : [];
    return { inv: list, total: list.reduce(function (a, x) { return a + x.amount; }, 0), jobs: late, jobTotal: late.reduce(function (a, j) { return a + (+j.fee || 0) - (+j.paid || 0); }, 0) };
  }
  function openThing(t) {
    if (t.kind === 'j') M.go('freelance', { id: t.id });
    else if (window.MorfisDirect) window.MorfisDirect.open(t.id); else M.go('project', { id: t.id });
  }
  var STATUS_WORDS = [[/\b(complete|completed|done|finished|delivered|closed)\b/, 'completed'], [/\b(on hold|paused|pause|hold)\b/, 'on_hold'], [/\b(in progress|ongoing|started|active|working on)\b/, 'in_progress'], [/\b(upcoming|not started|later)\b/, 'not_started'], [/\b(cancel+ed|cancel|dropped)\b/, 'cancelled']];
  var VIEWS = [[/\b(home|dashboard|overview)\b/, 'home', 'Home'], [/\bdirect projects?\b/, 'direct', 'Direct projects'], [/\b(projects?)\b/, 'projects', 'Projects'], [/\btime ?line\b/, 'timeline', 'the Timeline'],
    [/\b(payments?|cash ?flow)\b/, 'payments', 'Payments'], [/\b(files?|folders?)\b/, 'files', 'Files'], [/\b(freelance|jobs?)\b/, 'freelance', 'Freelance'], [/\b(invoices?|quotes?|quotations?|documents?)\b/, 'documents', 'Invoices and quotes'],
    [/\b(automations?)\b/, 'automations', 'Automations'], [/\b(settings?|preferences)\b/, 'settings', 'Settings']];

  var CTX = { pending: null };   /* a question back ("which one?"), answered by the next thing said */
  function brain(said) {
    var raw = String(said || '').trim(), s = norm(raw);
    if (!s) return { say: 'I didn’t catch that.' };
    if (CTX.pending) { var p0 = CTX.pending; CTX.pending = null; var r0 = p0(s, raw); if (r0) return r0; }
    var m, AG = window.MorfisAgent;
    /* something waiting for your OK: yes does it, no drops it */
    if (AG && AG.pending()) {
      if (/^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|confirm|please do|proceed|correct|right|thats right)\b/.test(s)) return agentReply(AG.confirm());
      if (/^(no|nope|cancel|stop|dont|do not|never ?mind|leave it|not now)\b/.test(s)) { AG.cancel(); return { say: 'Okay, I left it as it was.' }; }
    }
    if (AG && /^(undo|undo that|take that back|revert( that)?)\b/.test(s)) return AG.undo();
    if (AG) { var acted = actions(s, raw); if (acted) return acted; }
    if (/^(stop|cancel|never ?mind|nothing|thats all|that is all|bye|goodbye|close)\b/.test(s)) return { say: 'Okay.', close: true };
    if (/^(thanks|thank you|cheers|great|perfect|nice)\b/.test(s)) return { say: 'You’re welcome.', close: true };
    if (/\b(what can you do|what can i say|help me|how do i use you|commands)\b/.test(s) || s === 'help') return { say: 'I can open any page or project, tell you what’s due, who owes you money, change a project’s status, start a freelance job, add a reminder and search your files. Just ask.',
      items: ['What’s due this week?', 'Any overdue invoices?', 'Open Files', 'New freelance job for Anna', 'Remind me to call the client tomorrow at 10 am', 'Mark Galle Fort as on hold'].map(function (x) { return { label: x, ask: x }; }) };
    if (/^(hi|hello|hey|good (morning|afternoon|evening)|morfis|seedform)\b/.test(s) && s.split(' ').length <= 4) {
      var hr = new Date().getHours(), up = upcoming(today(), addDays(7)), od = overdue();
      return { say: (hr < 12 ? 'Good morning.' : hr < 18 ? 'Good afternoon.' : 'Good evening.') + ' ' + (up.length ? plural(up.length, 'thing') + ' ' + (up.length === 1 ? 'is' : 'are') + ' due this week' : 'Nothing is due this week') + (od.inv.length ? ', and ' + plural(od.inv.length, 'invoice') + ' ' + (od.inv.length === 1 ? 'is' : 'are') + ' overdue.' : '.') + ' What can I do for you?', ask: true };
    }
    if (/\bwhat time is it\b|\bthe time\b/.test(s)) return { say: 'It’s ' + new Date().toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }) + '.' };
    if (/\bwhat (day|date) is it\b|\btodays date\b|\bwhats the date\b/.test(s)) return { say: 'It’s ' + new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) + '.' };
    if (/\b(dark|night) (mode|theme)\b/.test(s) || /\b(light|day) (mode|theme)\b/.test(s)) {
      var want = /\b(dark|night)\b/.test(s) ? 'dark' : 'light';
      if ((document.documentElement.dataset.theme || 'dark') !== want) { var tb = document.querySelector('[data-act="toggleTheme"]'); if (tb) tb.click(); }
      return { say: (want === 'dark' ? 'Dark' : 'Light') + ' mode.' };
    }

    /* reminders */
    if ((m = /^(please )?remind me (to |about |that )?(.+)/i.exec(raw)) || (m = /^(please )?(add|set|make|create) (a )?reminder (to |for |about )?(.+)/i.exec(raw))) {
      var body = (m[3] && m[0].toLowerCase().indexOf('remind me') !== -1 ? m[3] : m[5]) || '', dd = dateIn(body), tt = timeIn(body);
      var title = body.replace(dd ? dd.re : /$^/, '').replace(tt ? tt.re : /$^/, '').replace(/\s+(on|by|at|for)\s*$/i, '').replace(/\s+/g, ' ').trim().replace(/[.?!]+$/, '');
      if (!title) return { say: 'What should I remind you about?', ask: true, pending: function (x, r) { return brain('remind me to ' + r); } };
      var date = dd ? dd.d : today(), rem = { id: M.uid('rm'), title: title.charAt(0).toUpperCase() + title.slice(1), date: date, time: tt ? tt.t : '', pid: '', done: false, created: today() };
      pg().S.settings.reminders = (pg().S.settings.reminders || []).concat([rem]); pg().commitSettings();
      return { say: 'Okay, I’ll remind you ' + when(date) + (rem.time ? ' at ' + new Date('2000-01-01T' + rem.time).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }) : '') + ': ' + rem.title + '.' };
    }
    if (/\b(my )?reminders\b/.test(s) && /\b(what|read|list|show|any|my)\b/.test(s)) {
      var rl = (pg().S.settings.reminders || []).filter(function (r) { return !r.done && r.date >= addDays(-1); }).sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); });
      if (!rl.length) return { say: 'You have no reminders coming up.' };
      return { say: 'You have ' + plural(rl.length, 'reminder') + '. ' + rl.slice(0, 3).map(function (r) { return r.title + ' ' + when(r.date); }).join('. ') + '.', items: rl.slice(0, 8).map(function (r) { return { label: r.title, sub: when(r.date) + (r.time ? ' at ' + r.time : '') }; }) };
    }

    /* what is due */
    if (/\b(whats|what is|what do i have|anything|whats on|what have i got|what s)\b.*\b(due|coming up|on|planned|deadline|deadlines|today|tomorrow|week)\b|\bdue (today|tomorrow|this week|next week)\b|\bdeadlines?\b/.test(s) && !/\b(owe|overdue|invoice)\b/.test(s)) {
      var from = today(), to = addDays(7), span = 'this week';
      if (/\btoday\b/.test(s)) { to = today(); span = 'today'; } else if (/\btomorrow\b/.test(s)) { from = to = addDays(1); span = 'tomorrow'; } else if (/\bnext week\b/.test(s)) { from = addDays(7); to = addDays(14); span = 'next week'; }
      var list = upcoming(from, to), late = upcoming('0000-00-00', addDays(-1)).filter(function (x) { return !x.rem; });
      var lateSay = late.length && span !== 'next week' && span !== 'tomorrow' ? ' ' + plural(late.length, 'thing') + ' ' + (late.length === 1 ? 'is' : 'are') + ' already late.' : '';
      if (!list.length) return { say: 'Nothing is due ' + span + '.' + lateSay, items: late.slice(0, 6).map(function (x) { return { label: x.what, sub: 'was due ' + when(x.d), go: x.go }; }) };
      /* spoken: the count and the first one or two; the screen lists them all */
      var nToday = list.filter(function (x) { return x.d === today(); }).length, first = list.slice(0, list.length > 2 ? 1 : 2).map(function (x) { return x.what + ' ' + when(x.d); });
      return { say: plural(list.length, 'thing') + ' ' + (list.length === 1 ? 'is' : 'are') + ' due ' + span + (span === 'this week' && nToday ? ', ' + nToday + ' of ' + (list.length === 1 ? 'it' : 'them') + ' today' : '') + '. ' + (list.length > 2 ? 'First, ' : '') + listSay(first) + '.' + lateSay + (list.length > 2 ? ' The rest are on screen.' : ''),
        text: plural(list.length, 'thing') + ' due ' + span + '.' + lateSay,
        items: list.slice(0, 12).map(function (x) { return { label: x.what, sub: when(x.d), go: x.go }; }) };
    }
    /* money */
    if (/\b(overdue|owe|owes|owing|unpaid|outstanding|not paid|late payments?|who hasnt paid)\b/.test(s)) {
      var od2 = overdue();
      if (!od2.inv.length && !od2.jobs.length) return { say: 'Nobody owes you anything overdue. All invoices are on time.' };
      var parts = [];
      if (od2.inv.length) parts.push(plural(od2.inv.length, 'invoice') + ' ' + (od2.inv.length === 1 ? 'is' : 'are') + ' overdue, ' + money(od2.total) + ' in all, from ' + listSay(Array.from(new Set(od2.inv.map(function (x) { return (x.p.client && x.p.client.name) || x.p.name; }))).slice(0, 3)));
      if (od2.jobs.length) parts.push(plural(od2.jobs.length, 'delivered freelance job') + ' still ' + (od2.jobs.length === 1 ? 'has' : 'have') + ' ' + money(od2.jobTotal) + ' to be paid');
      return { say: parts.join('. ') + '.', items: od2.inv.map(function (x) { return { label: x.p.name, sub: money(x.amount) + ' overdue', go: { kind: 'p', id: x.p.id } }; }).concat(od2.jobs.map(function (j) { return { label: j.title || j.code, sub: money((+j.fee || 0) - (+j.paid || 0)) + ' to be paid', go: { kind: 'j', id: j.id } }; })).slice(0, 10) };
    }
    if (/\bhow much\b|\b(total|revenue|income|received|pending balance|cash ?flow)\b/.test(s) && /\b(money|received|paid|pending|contract|revenue|income|earn|earned|outstanding|balance|cash)\b/.test(s)) {
      var tot = Object.values(pg().S.projects).reduce(function (a, p) { var f = pg().projectFinance(p, today()); a.c += f.contract || 0; a.r += f.received || 0; a.o += f.overdue || 0; return a; }, { c: 0, r: 0, o: 0 });
      var flLeft = window.MorfisFreelance ? window.MorfisFreelance.all().reduce(function (a, j) { return a + Math.max(0, (+j.fee || 0) - (+j.paid || 0)); }, 0) : 0;
      return { say: 'Across your direct projects, ' + money(tot.r) + ' has been received of ' + money(tot.c) + (tot.o ? ', and ' + money(tot.o) + ' is overdue' : '') + '.' + (flLeft ? ' Freelance jobs still have ' + money(flLeft) + ' to come in.' : '') };
    }
    if ((m = /\bhow many (active |open |ongoing |completed )?(direct )?(projects|jobs|freelance jobs|freelance projects)\b/.exec(s))) {
      var fl = /job|freelance/.test(m[3]), done = /completed/.test(m[1] || ''), all = fl ? (window.MorfisFreelance ? window.MorfisFreelance.all().map(function (j) { return window.MorfisFreelance.statusOf(j); }) : []) : Object.values(pg().S.projects).map(function (p) { return A.statusOf(p, today()); });
      var n = all.filter(function (x) { return done ? x === 'completed' : x !== 'completed' && x !== 'cancelled'; }).length;
      return { say: 'You have ' + plural(n, (done ? 'completed ' : 'open ') + (fl ? 'freelance job' : 'direct project')) + '.' };
    }

    /* status */
    if ((m = /^(?:please )?(?:mark|set|change|move|make|put)\s+(.+?)\s+(?:as|to|on|into)\s+(.+)$/.exec(s)) || (m = /^(.+?)\s+is\s+(done|finished|completed|delivered|on hold|cancelled|in progress)$/.exec(s))) {
      var stWant = null; STATUS_WORDS.some(function (x) { if (x[0].test(m[2])) { stWant = x[1]; return true; } return false; });
      if (stWant) {
        var hits = find(m[1]);
        if (!hits.length) return { say: 'I couldn’t find a project called ' + m[1] + '.' };
        var setIt = function (t) { return agentReply(window.MorfisAgent.execute([{ tool: 'set_status', args: { name: t.id, status: stWant } }])); };
        if (hits.length > 1 && hits[0].score - hits[1].score < 0.2) return askWhich(hits, setIt);
        return setIt(hits[0].t);
      }
    }
    /* new job / project */
    if ((m = /^(?:please )?(?:new|create|start|add|make|open)\s+(?:a\s+)?(?:new\s+)?(freelance job|freelance project|job|direct project|project)\b\s*(.*)$/.exec(s))) {
      var rest = raw.replace(/^.*?\b(freelance job|freelance project|job|direct project|project)\b\s*/i, '');
      var cm = /\bfor\s+(.+?)(?=\s+(?:called|named)\b|$)/i.exec(rest), nm = /\b(?:called|named)\s+(.+?)(?=\s+for\b|$)/i.exec(rest);
      var client = cm ? cm[1].trim() : '', name = nm ? nm[1].trim() : '';
      if (/freelance|job/.test(m[1]) && window.MorfisFreelance) {
        var job = window.MorfisFreelance.newJob({ title: name ? name.replace(/[.?!]+$/, '') : '', client: client ? client.replace(/[.?!]+$/, '') : '' });
        return { say: 'I’ve started a freelance job' + (client ? ' for ' + job.client : '') + (name ? ', ' + job.title : '') + '. Add the brief and the deliverables when you’re ready.' };
      }
      if (name && window.MorfisAgent) {
        var bud = /\b(?:budget|fee|worth|of)\s+(?:of\s+)?((?:rs\.?\s*|lkr\s*)?[\d.,]+\s*(?:k|thousand|m|million|lakhs?)?)/i.exec(rest), dd0 = dateIn(rest);
        name = name.replace(/\s+(?:with\s+a\s+|with\s+)?(?:budget|fee)\b.*$/i, '').replace(/\s+(?:starting|from|on)\s+.*$/i, '').replace(/[.?!]+$/, '');
        client = client.replace(/\s+(?:with\s+a\s+|with\s+)?(?:budget|fee)\b.*$/i, '').replace(/\s+(?:starting|from|on)\s+.*$/i, '').replace(/[.?!]+$/, '');
        return agentReply(window.MorfisAgent.execute([{ tool: 'create_project', args: { name: name, client: client, budget: bud ? bud[1] : 0, start: dd0 ? dd0.d : '' } }]));
      }
      if (M.newProject) M.newProject('direct'); else pg().newProject();
      return { say: 'Here’s a new direct project. Tell me its name next time and I’ll set it up for you, or fill in the details and save it.', close: true };
    }
    /* search */
    if ((m = /^(?:please )?(?:search|find|look)\s+(?:for\s+)?(?:files?\s+(?:called|named)\s+)?(.+?)(?:\s+in\s+(?:the\s+)?files)?$/.exec(s)) && !/\b(project|job)\b/.test(m[1])) {
      M.go('files'); setTimeout(function () { var q = document.getElementById('q'); if (q) { q.value = m[1]; q.dispatchEvent(new Event('input', { bubbles: true })); } }, 250);
      return { say: 'Searching your files for ' + m[1] + '.' };
    }
    /* open the folder of */
    if ((m = /\b(?:open|show)\s+(?:the\s+)?(?:folder|files)\s+(?:of|for)\s+(.+)$/.exec(s)) || (m = /\b(?:open|show)\s+(.+?)(?:s)?\s+folder\s*(?:in explorer)?$/.exec(s))) {
      var fh = find(m[1]);
      if (fh.length) {
        var t0 = fh[0].t, dir = t0.kind === 'p' ? pg().projDir(pg().P(t0.id)) : window.MorfisFreelance.dirOf(window.MorfisFreelance.get(t0.id));
        H.openPath(dir).catch(function () { M.toast('That folder is not on this computer.'); });
        return { say: 'Opening the folder of ' + t0.name + '.' };
      }
    }
    /* go somewhere */
    if ((m = /^(?:please )?(?:open|go to|show(?: me)?|take me to|switch to|bring up|navigate to|lets see|let me see)\s+(?:the\s+|my\s+)?(.+)$/.exec(s)) || (m = /^(.+?)\s+(?:please|page)$/.exec(s))) {
      var target = m[1].replace(/\s+(page|tab|view|section|screen)$/, '');
      if (/\breminders?\b/.test(target)) { pg().openReminders(); return { say: 'Here are your reminders.', close: true }; }
      var hit2 = find(target), view = null;
      VIEWS.some(function (v) { if (v[0].test(target) && target.split(' ').length <= 3) { view = v; return true; } return false; });
      if (hit2.length && (!view || hit2[0].score >= 1)) {
        if (hit2.length > 1 && hit2[0].score - hit2[1].score < 0.2) return askWhich(hit2, function (t) { openThing(t); return { say: 'Here’s ' + t.name + '.', close: true }; });
        openThing(hit2[0].t); return { say: 'Here’s ' + hit2[0].t.name + '.', close: true };
      }
      if (view) { goView(view[1]); return { say: 'Here’s ' + view[2] + '.', close: true }; }
    }
    /* a project's state */
    if ((m = /\b(?:how is|hows|whats happening with|status of|update on|where are we with|tell me about)\s+(.+)$/.exec(s))) {
      var sh = find(m[1]);
      if (sh.length) return describe(sh[0].t);
    }
    var direct = find(s);
    if (direct.length && direct[0].score >= 1.2) return describe(direct[0].t);
    return null;
  }
  /* a request to do something, read without the AI model: the common ones, in everyday words */
  var WORDNUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  var num = function (x) { return WORDNUM[x] || +x || 0; };
  /* "X to/for/in Y": the split where Y names a project best */
  function splitOn(text, kind) {
    var words = text.split(' '), bestSplit = null;
    for (var i = words.length - 1; i > 0; i--) {
      if (!/^(to|for|in|on|of|from)$/.test(words[i])) continue;
      var left = words.slice(0, i).join(' '), right = words.slice(i + 1).join(' ');
      var hit = kind === 'j' ? window.MorfisAgent.jobOf(right) : kind === 'p' ? window.MorfisAgent.projectOf(right) : window.MorfisAgent.find(right);
      if (hit.x && left) { bestSplit = { left: left, right: right, x: hit.x }; break; }
    }
    return bestSplit;
  }
  function actions(s, raw) {
    var AG = window.MorfisAgent, m, sp, dd;
    var go = function (list) { return agentReply(AG.execute(list)); };
    /* tasks */
    if ((m = /^(?:please )?(?:add|create|put|new)\s+(?:a\s+)?(?:new\s+)?task\s+(?:called\s+|to\s+)?(.+)$/.exec(s))) {
      dd = dateIn(m[1]); var body = dd ? norm(m[1].replace(dd.re, ' ')) : m[1]; body = body.replace(/\s+due\s*$/, '');
      if ((sp = splitOn(body, 'p'))) return go([{ tool: 'add_task', args: { project: sp.x.id, title: sp.left.replace(/^(to )/, '').replace(/\s+due$/, ''), due: dd ? dd.d : '' } }]);
      return { say: 'Which project should I add it to?' };
    }
    if ((m = /^(?:please )?(?:mark|tick off|tick|check off|complete|finish|close)\s+(?:the\s+)?(?:task\s+)?(.+?)(?:\s+as\s+(?:done|complete|completed|finished))?$/.exec(s)) && (sp = splitOn(m[1].replace(/\s+as\s+(done|complete|completed|finished)\b/, ''), 'p'))) {
      var tk = (sp.x.tasks || []).some(function (t) { return t.status !== 'done'; });
      if (tk) return go([{ tool: 'set_task_status', args: { project: sp.x.id, task: sp.left.replace(/\s+(done|complete|completed|finished)$/, ''), status: 'done' } }]);
    }
    if ((m = /^(?:please )?(?:delete|remove)\s+(?:the\s+)?task\s+(.+)$/.exec(s)) && (sp = splitOn(m[1], 'p'))) return go([{ tool: 'delete_task', args: { project: sp.x.id, task: sp.left } }]);
    if ((m = /^(?:please )?(?:move|change|set)\s+(?:the\s+)?(?:task\s+)?(.+?)\s+(?:due date\s+)?to\s+(.+)$/.exec(s)) && (dd = dateIn(m[2])) && (sp = splitOn(m[1], 'p'))) return go([{ tool: 'set_task_due', args: { project: sp.x.id, task: sp.left, due: dd.d } }]);
    /* stages and timelines */
    if ((m = /^(?:please )?(?:move|advance|push|take|bring)\s+(.+?)\s+(?:on\s+)?to\s+(?:the\s+)?next stage$/.exec(s)) || (m = /^(?:please )?(?:advance|next stage for)\s+(.+)$/.exec(s))) return go([{ tool: 'set_stage', args: { project: m[1], stage: 'next' } }]);
    if ((m = /^(?:please )?(?:move|set|put|change)\s+(.+?)\s+(?:to|into)\s+stage\s+(\d|one|two|three|four|five|six|seven)$/.exec(s))) return go([{ tool: 'set_stage', args: { project: m[1], stage: num(m[2]) } }]);
    if ((m = /^(?:please )?(?:push|delay|move|shift|postpone|bring)\s+(?:the\s+)?(?:timeline of\s+|schedule of\s+)?(.+?)\s+(back|later|forward|earlier|ahead)?\s*by\s+(\d+|a|an|one|two|three|four|five|six)\s+(days?|weeks?|months?)\s*(back|later|forward|earlier|ahead)?$/.exec(s))) {
      var n = num(m[3]) * (/week/.test(m[4]) ? 7 : /month/.test(m[4]) ? 30 : 1), dir = m[2] || m[5] || 'later';
      return go([{ tool: 'reschedule', args: { project: m[1], days: /forward|earlier|ahead/.test(dir) && !/push/.test(s.split(' ')[0]) ? -n : n } }]);
    }
    if ((m = /^(?:please )?(?:reschedule|move)\s+(.+?)\s+to\s+start\s+(.+)$/.exec(s)) && (dd = dateIn(m[2]))) return go([{ tool: 'reschedule', args: { project: m[1], start: dd.d } }]);
    /* money */
    if ((m = /^(?:please )?(?:record|log|add|enter)\s+(?:a\s+)?payment\s+(?:of\s+)?(.+?)\s+(?:from|for|on|against)\s+(.+)$/.exec(s))) {
      var tj = AG.find(m[2]);
      if (tj.kind === 'j') return go([{ tool: 'set_job_money', args: { job: tj.x.id, paid: (+tj.x.paid || 0) + AG.amount(m[1]) } }]);
      return go([{ tool: 'record_payment', args: { project: m[2], amount: m[1] } }]);
    }
    if ((m = /^(?:please )?(?:issue|send|raise|create|make|prepare)\s+(?:the\s+|an\s+)?(?:next\s+)?invoice\s+(?:for|to)\s+(.+)$/.exec(s))) {
      var ti = AG.find(m[1]);
      if (ti.kind === 'j') { if (window.MorfisFreelance.invoice) window.MorfisFreelance.invoice(ti.x.id); else window.MorfisFreelance.open(ti.x.id); return { say: 'Here’s the invoice for ' + (ti.x.title || ti.x.code) + ', ready for you to check.', close: true }; }
      return go([{ tool: 'issue_invoice', args: { project: m[1] } }]);
    }
    if ((m = /^(?:please )?(?:set|change|make)\s+the\s+(?:fee|budget|price)\s+(?:of|for|on)\s+(.+?)\s+(?:to|at)\s+(.+)$/.exec(s))) {
      var tf = AG.find(m[1]);
      if (tf.kind === 'j') return go([{ tool: 'set_job_money', args: { job: tf.x.id, fee: m[2] } }]);
      return go([{ tool: 'update_project', args: { project: m[1], budget: m[2] } }]);
    }
    /* deleting */
    if ((m = /^(?:please )?(?:delete|remove)\s+(?:the\s+)?(freelance job|job|direct project|project)\s+(.+)$/.exec(s))) return go([{ tool: /job/.test(m[1]) ? 'delete_job' : 'delete_project', args: /job/.test(m[1]) ? { job: m[2] } : { project: m[2] } }]);
    /* freelance deliverables */
    if ((m = /^(?:please )?add\s+(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)?\s*(renders?|renderings?|drawings?|3d models?|models?|views?)\s+(?:to|for)\s+(.+)$/.exec(s))) return go([{ tool: 'add_deliverable', args: { job: m[3], kind: m[2], qty: num(m[1] || 'one') } }]);
    if ((m = /^(?:please )?(?:mark|tick off|tick)\s+(?:the\s+)?(.+?)\s+(?:of|for|on|in)\s+(.+?)\s+as delivered$/.exec(s))) return go([{ tool: 'deliver', args: { job: m[2], item: m[1] } }]);
    if ((m = /^(?:please )?(?:mark|tick)\s+(?:everything|all deliverables)\s+(?:of|for|on)\s+(.+?)\s+(?:as\s+)?delivered$/.exec(s)) || (m = /^(?:i(?:ve| have)?\s+)?delivered everything (?:for|to|on)\s+(.+)$/.exec(s))) return go([{ tool: 'deliver', args: { job: m[1], item: 'all' } }]);
    /* folders, automations, moving between direct and freelance */
    if ((m = /^(?:please )?(?:create|make|set up)\s+(?:the\s+)?folders?\s+(?:for|of)\s+(.+)$/.exec(s))) return go([{ tool: 'make_folders', args: { name: m[1] } }]);
    if ((m = /^(?:please )?(?:move|convert|turn)\s+(.+?)\s+(?:to|into)\s+(?:a\s+)?(freelance|direct)(?:\s+(?:project|projects|job))?$/.exec(s))) return go([{ tool: 'move_to', args: { name: m[1], to: m[2] } }]);
    if ((m = /^(?:please )?run\s+(?:the\s+)?(.+?)(?:\s+automation)?(?:\s+now)?$/.exec(s)) && window.MorfisAuto) {
      var hasRule = window.MorfisAuto.rules().some(function (r) { return near(norm(r.title).split(' ')[0], m[1].split(' ')[0]) || norm(r.title).indexOf(m[1]) !== -1; });
      if (hasRule) return go([{ tool: 'run_automation', args: { rule: m[1] } }]);
    }
    return null;
  }
  /* what the agent did, said in one breath; what needs your OK becomes a question with Yes and Cancel */
  function agentReply(r) {
    var AG = window.MorfisAgent, say = AG.summary(r), items = [];
    r.done.forEach(function (d) { if (d.ref && d.ref.kind !== 'doc') items.push({ label: 'Open', sub: d.say.split('.')[0], go: { kind: d.ref.kind, id: d.ref.id } }); });
    if (r.wait.length) {
      items = [{ label: 'Yes, go ahead', confirm: true }, { label: 'Cancel', cancel: true }].concat(r.wait.map(function (w) { return { label: w.text, sub: 'needs your OK', info: true }; }));
      return { say: say, ask: true, items: items, confirmBox: true };
    }
    if (r.done.some(function (d) { return d.undo; }) && AG) setTimeout(function () { M.toast(r.done[r.done.length - 1].say.split('. ')[0].replace(/\.$/, '') + '.', { label: 'Undo', fn: function () { show(AG.undo()); } }); }, 0);
    return { say: say || 'Done.', items: items };
  }
  function goView(v) {
    var dk = { files: 1, direct: 1, freelance: 1, documents: 1, automations: 1 };
    if (dk[v]) M.go(v); else { var b = document.querySelector('#dkSide [data-go="' + v + '"]'); if (b) b.click(); else pg().setView(v); }
  }
  function askWhich(hits, then) {
    var two = hits.slice(0, 3).map(function (h) { return h.t; });
    CTX.pending = function (x) {
      var pick = two.find(function (t) { return find(x).some(function (h) { return h.t.id === t.id; }); }) || (/\b(first|one|1st)\b/.test(x) ? two[0] : /\b(second|two|2nd|other)\b/.test(x) ? two[1] : /\b(third|three)\b/.test(x) ? two[2] : null);
      return pick ? then(pick) : { say: 'Okay, never mind.' };
    };
    return { say: 'Which one: ' + listSay(two.map(function (t) { return t.name; })).replace(/ and /, ' or ') + '?', ask: true, items: two.map(function (t) { return { label: t.name, sub: t.code, pick: t }; }), pickThen: then };
  }
  function describe(t) {
    if (t.kind === 'j') {
      var j = window.MorfisFreelance.get(t.id), d = window.MorfisFreelance.done(j);
      return { say: (j.title || j.code) + ' is ' + A.STATUS[window.MorfisFreelance.statusOf(j)].label.toLowerCase() + ', ' + d.n + ' of ' + d.of + ' deliverables done, ' + (window.MorfisFreelance.dueText(j) || 'no due date').toLowerCase() + '.' + ((+j.fee || 0) > (+j.paid || 0) ? ' ' + money((+j.fee || 0) - (+j.paid || 0)) + ' is still to be paid.' : ''), items: [{ label: 'Open ' + (j.title || j.code), go: t }] };
    }
    var p = pg().P(t.id), f = pg().projectFinance(p, today()), g = pg().projectProgress(p), st = pg().STAGES[Math.min(7, p.currentStage) - 1];
    return { say: p.name + ' is ' + A.STATUS[A.statusOf(p, today())].label.toLowerCase() + ', in stage ' + p.currentStage + ', ' + st.name + ', with ' + g.pct + ' percent of the checklist done.' + (f.overdue ? ' ' + money(f.overdue) + ' is overdue.' : ''), items: [{ label: 'Open ' + p.name, go: t }] };
  }
  /* no rule for it: the local AI model, with a short picture of the studio, if it is installed */
  function thinkHarder(said, onSay) {
    var S = pg().S, lines = [];
    Object.values(S.projects).slice(0, 25).forEach(function (p) { var f = pg().projectFinance(p, today()); lines.push('Project ' + p.code + ' "' + p.name + '": ' + A.STATUS[A.statusOf(p, today())].label + ', stage ' + p.currentStage + ', client ' + ((p.client && p.client.name) || '-') + ', fee ' + f.contract + ', received ' + f.received + ', overdue ' + f.overdue); });
    if (window.MorfisFreelance) window.MorfisFreelance.all().slice(0, 25).forEach(function (j) { lines.push('Freelance job ' + j.code + ' "' + (j.title || '') + '": ' + window.MorfisFreelance.statusOf(j) + ', client ' + (j.client || '-') + ', due ' + (j.due || '-') + ', fee ' + (j.fee || 0) + ', paid ' + (j.paid || 0)); });
    var sys = 'You are the voice assistant of Seedform, an architecture studio in Colombo. Speak like a good architect on site: calm, clear, warm, plain words, no exclamation marks. Today is ' + today() + '. Answer in one or two short sentences that sound natural when spoken. Use the studio data below; if it does not hold the answer, say so briefly. Amounts are in ' + (S.settings.currency || 'LKR') + '.\n\n' + lines.join('\n');
    var o = { system: sys, prompt: said, timeoutMs: 45000 };
    return (onSay && H.aiStream ? H.aiStream(o, function (t) { onSay(t.replace(/\*\*/g, '')); }) : H.aiChat(o)).then(function (r) { return { say: String(r.text || '').replace(/\*\*/g, '').trim() || 'I’m not sure.' }; },
      function () { return { say: 'I can’t answer that one yet. Try asking what’s due, who owes you money, or say open, and a project’s name.', items: ['What can you do?'].map(function (x) { return { label: x, ask: x }; }) }; });
  }

  /* ===== the panel ===== */
  var FRAMES = 0, STATE = 'idle', LEVEL = 0, EL = null, LAST = { said: '', reply: null };
  function setState(s) { STATE = s; document.documentElement.dataset.vx = EL && !EL.hidden ? s : ''; if (EL) { EL.dataset.state = s; var st = EL.querySelector('.vx-state'); if (st) st.textContent = { idle: 'Ask me anything', listening: 'Listening…', hearing: 'Getting that…', thinking: 'Thinking…', speaking: 'Speaking', loading: 'Getting ready… (the first time takes a few seconds)' }[s] || ''; } var b = document.getElementById('vxBtn'); if (b) b.classList.toggle('on', s !== 'idle' || !!(EL && !EL.hidden)); }
  function panel() {
    if (EL) return EL;
    EL = document.createElement('div');
    EL.className = 'vx'; EL.hidden = true; EL.setAttribute('role', 'dialog'); EL.setAttribute('aria-label', 'Voice assistant');
    EL.innerHTML = '<div class="vx-card">' +
      '<div class="vx-top"><button type="button" class="vx-orb" data-vx="mic" aria-label="Speak"><i></i><i></i><i></i><b class="vx-core">' + ic('mic', 22) + '</b></button>' +
      '<div class="vx-text"><span class="vx-state">Ask me anything</span><span class="vx-said"></span></div>' +
      '<button type="button" class="icon-btn vx-x" data-vx="close" aria-label="Close" title="Close (Esc)">' + ic('x', 18) + '</button></div>' +
      '<div class="vx-reply" aria-live="polite"></div>' +
      '<div class="vx-items"></div>' +
      '<form class="vx-type" data-vx-form><input class="in" name="q" placeholder="Or type here, then Enter" autocomplete="off" spellcheck="true" aria-label="Type to the assistant"><button type="button" class="icon-btn" data-vx="settings" title="Voice settings">' + ic('settings', 16) + '</button></form>' +
      '</div>';
    document.body.appendChild(EL);
    /* a soft light rising from the bottom of the window while Morfis listens, thinks and speaks (Gemini Live style) */
    var edge = document.createElement('div'); edge.className = 'vx-aura'; edge.setAttribute('aria-hidden', 'true');
    edge.innerHTML = '<div class="vx-aura-in"><i class="a1"></i><i class="a2"></i><i class="a3"></i><i class="a4"></i><i class="band"></i></div>';
    document.body.appendChild(edge);
    EL.addEventListener('click', function (e) {
      var b = e.target.closest('[data-vx]'); if (b) { var a = b.dataset.vx; if (a === 'mic') toggle(); else if (a === 'close') close(); else if (a === 'settings') { close(); pg().setView('settings'); setTimeout(function () { var c = document.getElementById('dkVoice'); if (c) c.scrollIntoView({ block: 'center' }); }, 300); } return; }
      var it = e.target.closest('[data-vx-item]'); if (it) { var x = (LAST.reply && LAST.reply.items || [])[+it.dataset.vxItem]; if (!x) return; if (x.info) return; if (x.confirm) { handle('yes'); return; } if (x.cancel) { handle('no'); return; } if (x.ask) handle(x.ask); else if (x.pick && LAST.reply.pickThen) { CTX.pending = null; show(LAST.reply.pickThen(x.pick)); } else if (x.go) { openThing(x.go); close(); } }
    });
    EL.querySelector('[data-vx-form]').addEventListener('submit', function (e) { e.preventDefault(); var i = e.target.q, v = i.value.trim(); if (!v) return; i.value = ''; handle(v); });
    return EL;
  }
  function open() { panel().hidden = false; requestAnimationFrame(function () { EL.classList.add('vx-open'); }); setState(STATE); loop(); }
  function close() {
    stopSpeaking(); if (LISTEN) LISTEN.cancel(); CTX.pending = null; setState('idle');
    if (EL) { EL.classList.remove('vx-open'); document.documentElement.dataset.vx = ''; var el = EL; setTimeout(function () { if (!el.classList.contains('vx-open')) el.hidden = true; }, 260); }
    setTimeout(closeMic, 400);
  }
  function show(r, instant) {
    LAST.reply = r || null;
    if (!EL) return;
    /* the answer, at once: a quick fade over its first words only (a streamed answer is already on screen) */
    var words = String(r ? r.text || r.say || '' : '').split(/(\s+)/), wi = 0;
    EL.querySelector('.vx-reply').innerHTML = instant ? esc(words.join('')) : words.map(function (w) { return /^\s+$/.test(w) || !w ? w : '<span class="vx-w" style="animation-delay:' + Math.min(120, (wi++) * 10) + 'ms">' + esc(w) + '</span>'; }).join('');
    EL.querySelector('.vx-items').innerHTML = r && r.items && r.items.length ? r.items.map(function (x, i) { return '<button type="button" class="vx-it' + (x.confirm ? ' vx-yes' : x.cancel ? ' vx-no' : x.info ? ' vx-info' : '') + '" data-vx-item="' + i + '"><b>' + esc(x.label) + '</b>' + (x.sub ? '<span>' + esc(x.sub) + '</span>' : '') + '</button>'; }).join('') : '';
  }
  function showLive(t) { if (EL) { EL.querySelector('.vx-reply').textContent = t; EL.querySelector('.vx-items').innerHTML = ''; } }
  function showSaid(t) { if (EL) EL.querySelector('.vx-said').textContent = t ? '“' + t + '”' : ''; }
  /* the orb follows the voice: the microphone while listening, the answer while speaking */
  var raf = 0;
  function loop() {
    cancelAnimationFrame(raf);
    var step = function () {
      if (!EL || EL.hidden) return;
      var lv = 0;
      if (STATE === 'listening') lv = LEVEL;
      else if (STATE === 'speaking' && OUT && OUT.an) { var d = new Uint8Array(OUT.an.frequencyBinCount); OUT.an.getByteTimeDomainData(d); var mx = 0; for (var i = 0; i < d.length; i++) mx = Math.max(mx, Math.abs(d[i] - 128)); lv = Math.min(1, mx / 60); }
      else if (STATE === 'thinking' || STATE === 'hearing' || STATE === 'loading') lv = 0.25 + 0.15 * Math.sin(performance.now() / 260);
      var v = (lv * 0.9 + (+EL.style.getPropertyValue('--lv') || 0) * 0.1).toFixed(3);
      EL.style.setProperty('--lv', v); document.documentElement.style.setProperty('--vxlv', v);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  /* one turn: listen, understand, answer, and listen again when it asked something back */
  function toggle() {
    if (STATE === 'listening') { if (LISTEN) LISTEN.stop(); return; }
    if (STATE === 'speaking') { stopSpeaking(); setState('idle'); return; }
    if (STATE !== 'idle') return;
    turn();
  }
  function turn(followUp) {
    open(); stopSpeaking(); if (!followUp) { show(null); showSaid(''); }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { setState('idle'); show({ say: 'There is no microphone. You can type instead.' }); return; }
    setState(ENGINE.ready ? 'listening' : 'loading');
    var ready = warm().catch(function (e) { return { failed: e }; });
    record().then(function (rec) {
      if (rec.why === 'cancel') return;
      if (!rec.spoke) { setState('idle'); if (!followUp) show({ say: 'I didn’t hear anything. Press the orb and speak, or type below.' }); return; }
      setState('hearing');
      return ready.then(function (w) {
        if (w && w.failed) throw w.failed;
        return call({ type: 'listen', audio: rec.audio });
      }).then(function (r) {
        var text = (r.text || '').trim();
        if (!text || /^(you|thank you\.?|\.)$/i.test(text)) { setState('idle'); show({ say: 'Sorry, I didn’t catch that. Try again?' }); return; }
        return handle(text);
      });
    }, function (e) {
      setState('idle');
      show({ say: /Permission|NotAllowed|denied/i.test(String(e && (e.name || e.message))) ? 'The microphone is blocked. Allow it in Windows Settings > Privacy > Microphone, or type below.' : 'The microphone could not start: ' + ((e && e.message) || 'no microphone found') + '. You can type below.' });
    }).catch(function (e) { setState('idle'); show({ say: 'The voice engine had a problem: ' + ((e && e.message) || 'unknown') + '.' }); });
    if (ENGINE.ready) return;
    ready.then(function () { if (STATE === 'loading') setState('listening'); });
  }
  function handle(text) {
    open(); showSaid(text); LAST.said = text; setState('thinking');
    var r = null, LV = null;
    try { r = brain(text); } catch (e) { r = { say: 'Something went wrong there: ' + e.message }; }
    /* an answer from the AI model streams in: shown and spoken while it is still being written */
    var onSay = function (t) { if (!LV) LV = live(); LV.text(t); };
    var p = r ? Promise.resolve(r) : (window.MorfisAgent ? window.MorfisAgent.plan(text, onSay).then(function (pl) {
      if (!pl.actions.length) return pl.say ? { say: pl.say } : thinkHarder(text, onSay);
      var out = agentReply(window.MorfisAgent.execute(pl.actions));
      if (pl.say && !out.ask) out.say = pl.say + ' ' + out.say;
      return out;
    }, function () { return thinkHarder(text, onSay); }) : thinkHarder(text, onSay));
    return p.then(function (reply) {
      if (reply.pending) CTX.pending = reply.pending;
      show(reply, !!LV);
      var streamed = LV && LV.finish(reply.say);
      var said = streamed ? streamed : PR().voiceReply !== false ? (ENGINE.ready || ENGINE.warming ? speak(reply.say) : warm().then(function () { return speak(reply.say); }, function () { return winSpeak(reply.say); })) : Promise.resolve();
      if (PR().voiceReply === false) setState('idle');
      return said.then(function () {
        setState('idle');
        if (reply.close) setTimeout(function () { if (STATE === 'idle') close(); }, 1400);
        else if (reply.ask && PR().voiceFollowUp !== false && EL && !EL.hidden) setTimeout(function () { if (STATE === 'idle' && EL && !EL.hidden) turn(true); }, 250);
      });
    });
  }

  /* ===== the microphone button, the shortcut, and the settings ===== */
  function button() {
    if (PR().voiceOn === false) { var old = document.getElementById('vxBtn'); if (old) old.remove(); return; }
    if (document.getElementById('vxBtn')) return;
    var anchor = document.getElementById('themeBtn'); if (!anchor) return;
    anchor.insertAdjacentHTML('beforebegin', '<button type="button" class="icon-btn lg vx-btn" id="vxBtn" aria-label="Voice assistant" title="Voice assistant (Ctrl+Space)">' + ic('mic', 18) + '</button>');
  }
  window.addEventListener('morfis:render', button);
  document.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('#vxBtn')) { if (EL && !EL.hidden && STATE === 'idle') close(); else toggle(); } });
  document.addEventListener('keydown', function (e) {
    if (PR().voiceOn === false) return;
    if (e.code === 'Space' && e.ctrlKey && !e.shiftKey && !e.altKey) { e.preventDefault(); toggle(); return; }
    if (e.key === 'Escape' && EL && !EL.hidden) { e.preventDefault(); e.stopPropagation(); close(); }
  }, true);

  window.MorfisVoice = {
    open: open, close: close, listen: turn, ask: handle, brain: brain, speak: speak, warm: warm, engine: function () { return ENGINE; }, state: function () { return STATE; }, last: function () { return LAST; },
    /* for tests and tools: speech in (16 kHz) as if it came from the microphone; text to 24 kHz audio */
    hear: function (audio) { open(); setState('hearing'); return warm().then(function () { return call({ type: 'listen', audio: audio }); }).then(function (r) { return handle(r.text).then(function () { return r.text; }); }); },
    synth: function (text) { var parts = []; return warm().then(function () { return call({ type: 'speak', text: text, voice: PR().voiceName || 'af_heart', speed: 1 }, function (m) { parts.push(m.pcm); }); }).then(function () { var n = parts.reduce(function (a, b) { return a + b.length; }, 0), out = new Float32Array(n), at = 0; parts.forEach(function (b) { out.set(b, at); at += b.length; }); return out; }); },
    level: function () { return LEVEL; }, frames: function () { return FRAMES; },
    voices: VOICES, sample: function () { return warm().then(function () { return speak('Hi, I’m the Seedform assistant. Ask me what’s due this week, or tell me to open a project.'); }); }
  };
})();
