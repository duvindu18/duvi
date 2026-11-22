'use strict';
/* The voice assistant's engine, end to end and offline: Kokoro says a sentence, Whisper listens to that audio, and
   the words must come back. Also times both. Usage: electron scripts/voice-test.js [out-dir]
   (on Linux CI: xvfb-run -a npx electron --no-sandbox scripts/voice-test.js) */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, session } = require('electron');

const out = path.resolve(process.argv.slice(process.argv.findIndex((a) => /voice-test\.js$/.test(a)) + 1).filter((a) => !a.startsWith('--'))[0] || 'voice-out');
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'morfis-voice-'));
app.setPath('userData', profile);
fs.writeFileSync(path.join(profile, 'desktop.json'), JSON.stringify({ splash: false }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.error('VOICE TEST FAILED: timed out'); app.exit(2); }, 9 * 60 * 1000).unref();

require('../src/shell/main.js');
app.whenReady().then(async () => {
  /* nothing may go to the internet: every request must stay on morfis:// */
  const outside = [];
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (d, cb) => { if (!/127\.0\.0\.1|localhost|fonts\.googleapis\.com|fonts\.gstatic\.com/.test(d.url)) outside.push(d.url); cb({ cancel: true }); });
  let w = null;
  for (let i = 0; i < 80 && !w; i++) { await wait(250); w = BrowserWindow.getAllWindows().find((x) => /^morfis:/.test(x.webContents.getURL())); }
  if (!w) { console.error('no window'); app.exit(1); return; }
  w.webContents.on('console-message', (e) => console.log('[page]', (e.message || '').slice(0, 400)));
  await wait(2500);
  const r = JSON.parse(await w.webContents.executeJavaScript(`(async function () {
    var o = {}, id = 0, wk = new Worker('voice-worker.js', { type: 'module' }), wait = {};
    var ask = function (m) { return new Promise(function (res, rej) { m.id = ++id; wait[m.id] = { res: res, rej: rej, audio: [] }; wk.postMessage(m); setTimeout(function () { rej(new Error('step timed out: ' + m.type)); }, 200000); }); };
    wk.onmessage = function (e) {
      var m = e.data, h = wait[m.id];
      if (m.type === 'loaded') { o.loaded = m; return; }
      if (!h) return;
      if (m.type === 'audio') { h.audio.push(m.pcm); if (!h.first) h.first = performance.now(); return; }
      if (m.type === 'error') { h.rej(new Error(m.message)); return; }
      if (m.type === 'end') { h.res({ audio: h.audio, first: h.first }); return; }
      h.res(m);
    };
    wk.onerror = function (e) { o.workerError = String(e.message || e) + ' ' + (e.filename || '') + ':' + (e.lineno || ''); console.error('worker error', o.workerError); Object.keys(wait).forEach(function (k) { wait[k].rej(new Error('worker error: ' + o.workerError)); }); };
    console.log('worker started');
    try {
      o.isolated = self.crossOriginIsolated; console.log('isolated', o.isolated);
      var t0 = performance.now(); o.ready = await ask({ type: 'warm', voice: 'af_heart' }); o.warmMs = Math.round(performance.now() - t0); console.log('warm', o.warmMs, JSON.stringify(o.ready));
      o.ph = (await ask({ type: 'phonemes', text: 'Studio Morfis has three projects due this week.' })).text;
      var say = 'Studio Morfis has three projects due this week.';
      t0 = performance.now(); var sp = await ask({ type: 'speak', text: say, voice: 'af_heart', speed: 1 });
      o.speakMs = Math.round(performance.now() - t0); o.firstAudioMs = Math.round(sp.first - t0);
      var n = sp.audio.reduce(function (a, b) { return a + b.length; }, 0), pcm = new Float32Array(n), at = 0;
      sp.audio.forEach(function (b) { pcm.set(b, at); at += b.length; });
      o.seconds = +(n / 24000).toFixed(2); o.peak = pcm.reduce(function (a, b) { return Math.max(a, Math.abs(b)); }, 0);
      /* 24 kHz to 16 kHz for Whisper */
      var len = Math.floor(n * 2 / 3), x = new Float32Array(len);
      for (var i = 0; i < len; i++) { var p = i * 1.5, k = Math.floor(p), f = p - k; x[i] = pcm[k] * (1 - f) + (pcm[k + 1] || 0) * f; }
      t0 = performance.now(); var heard = await ask({ type: 'listen', audio: x }); o.listenMs = Math.round(performance.now() - t0); o.heard = heard.text;
      /* a WAV of what it said, for a human to listen to */
      var buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf), w = function (o2, s) { for (var j = 0; j < s.length; j++) v.setUint8(o2 + j, s.charCodeAt(j)); };
      w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 24000, true); v.setUint32(28, 48000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
      for (i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 32767, true);
      o.wav = Array.from(new Uint8Array(buf)).map(function (b) { return String.fromCharCode(b); }).join('');
    } catch (e) { o.err = String(e && e.stack || e); }
    return JSON.stringify(o);
  })()`));
  if (r.wav) { fs.writeFileSync(path.join(out, 'kokoro-sample.wav'), Buffer.from(r.wav, 'latin1')); delete r.wav; }
  r.outside = outside;
  console.log('voice:', JSON.stringify(r));
  const words = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean);
  const want = words('Studio Morfis has three projects due this week'), got = words(r.heard);
  const hit = want.filter((x) => got.indexOf(x) !== -1).length;
  const ok = !r.err && r.seconds > 1 && r.peak > 0.05 && hit >= want.length - 2 && !outside.length;
  console.log(ok ? 'VOICE TEST PASSED (' + hit + '/' + want.length + ' words heard back)' : 'VOICE TEST FAILED');
  app.exit(ok ? 0 : 1);
});
