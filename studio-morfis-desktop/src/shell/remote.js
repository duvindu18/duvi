'use strict';
/* Phone access: the desktop app serves its own interface to phones on the same network, so the Android app (or a
   phone browser) works on the projects, documents and real folders of this computer.

   - Off until it is turned on in Settings > Desktop app.
   - A phone pairs once with a six-digit PIN shown on the computer. It then holds a long random device key (a cookie);
     only a hash of the key is kept here, and each phone can be removed from the computer.
   - Every page call goes to the same API the desktop window uses (main.js), so both always do the same things.
   - Changes made on either side are pushed to the other at once (server-sent events), so they stay in step.
   - Plain HTTP on the local network: use it on a network you trust (home or office Wi-Fi, or a private VPN). */
const http = require('http');
const dgram = require('dgram');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeJsonAtomic } = require('./util');

const DISCOVERY_PORT = 47821;
const COOKIE = 'morfis_dev';
const MAX_JSON = 30 * 1024 * 1024;
const MAX_UPLOAD = 1024 * 1024 * 1024;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const rand = (n) => crypto.randomBytes(n).toString('hex');

/* the API calls a phone may make, and how they differ from the desktop window */
/* window, zoom, theme and the program's name and icon belong to the computer's own window; the computer applies a
   name or icon change itself when the studio settings reach it */
const PHONE_ONLY_NOOP = { winAct: {}, winState: {}, setZoom: 1, setTheme: true, notify: false, setBranding: { changed: false } };
const PHONE_BLOCKED = new Set(['saveFile', 'savePdf', 'pickFiles', 'pickFolder', 'printHtml']);

class Remote {
  /* o: { dir, api, prefs, version, name(), page(), asset(pathname) -> { file, type } | null, previewFile(token) -> path, renderPdf(html), onChange(ev) } */
  constructor(o) {
    this.o = o;
    this.file = path.join(o.dir, 'phone-access.json');
    this.tmp = path.join(o.dir, 'phone-transfer');
    this.data = { devices: [] };
    try { this.data = Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch (e) { /* first use */ }
    this.pin = null; this.pinAt = 0; this.wrong = 0; this.lockUntil = 0;
    this.clients = new Map();   /* SSE connections: id -> { res, device, client } */
    this.downloads = new Map(); /* token -> { file, name, at } */
    this.server = null; this.udp = null; this.error = '';
  }
  save() { try { writeJsonAtomic(this.file, this.data); } catch (e) { /* not fatal */ } }

  /* ----- pairing ----- */
  newPin() { this.pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0'); this.pinAt = Date.now(); this.wrong = 0; return this.pin; }
  livePin() { if (!this.pin || Date.now() - this.pinAt > 15 * 60 * 1000) this.newPin(); return this.pin; }
  device(req) {
    const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-f0-9]{64})').exec(req.headers.cookie || '');
    if (!m) return null;
    const h = sha(m[1]);
    return this.data.devices.find((d) => d.hash === h) || null;
  }
  status() {
    return {
      on: !!this.server, error: this.error, port: this.port(), pin: this.server ? this.livePin() : '', addresses: this.addresses(),
      devices: this.data.devices.map((d) => ({ id: d.id, name: d.name, paired: d.paired, seen: d.seen, online: [...this.clients.values()].some((c) => c.device === d.id) }))
    };
  }
  forget(id) {
    this.data.devices = this.data.devices.filter((d) => d.id !== id); this.save();
    for (const [k, c] of this.clients) if (c.device === id) { try { c.res.end(); } catch (e) { /* closed */ } this.clients.delete(k); }
    return this.status();
  }
  port() { return +this.o.prefs.get('remotePort') || 47820; }
  addresses() {
    const out = [];
    Object.values(os.networkInterfaces()).forEach((list) => (list || []).forEach((a) => { if (a.family === 'IPv4' && !a.internal) out.push(a.address); }));
    return out.map((ip) => 'http://' + ip + ':' + this.port());
  }

  /* ----- start and stop ----- */
  start() {
    if (this.server) return Promise.resolve(this.status());
    this.error = '';
    fs.mkdirSync(this.tmp, { recursive: true });
    this.cleanTmp();
    return new Promise((resolve) => {
      const s = http.createServer((req, res) => this.handle(req, res).catch((e) => this.fail(res, 500, (e && e.message) || 'Error')));
      s.requestTimeout = 0; s.headersTimeout = 30000;
      s.on('error', (e) => { this.error = e && e.code === 'EADDRINUSE' ? 'Port ' + this.port() + ' is in use by another program. Choose another port.' : (e && e.message) || 'Could not start.'; this.server = null; resolve(this.status()); });
      s.listen(this.port(), '0.0.0.0', () => { this.server = s; this.newPin(); this.startDiscovery(); resolve(this.status()); });
    });
  }
  stop() {
    for (const c of this.clients.values()) { try { c.res.end(); } catch (e) { /* closed */ } }
    this.clients.clear();
    if (this.udp) { try { this.udp.close(); } catch (e) { /* closed */ } this.udp = null; }
    const s = this.server; this.server = null; this.pin = null;
    return new Promise((resolve) => { if (!s) return resolve(this.status()); s.close(() => resolve(this.status())); setTimeout(() => resolve(this.status()), 1500); });
  }
  /* the phone app asks "MORFIS?" on the network and this computer answers with its name and port */
  startDiscovery() {
    try {
      const u = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      u.on('message', (msg, r) => {
        if (String(msg).trim() !== 'MORFIS?') return;
        const body = Buffer.from(JSON.stringify({ app: 'studio-morfis', name: this.o.name(), host: os.hostname(), port: this.port(), version: this.o.version }));
        u.send(body, r.port, r.address);
      });
      u.on('error', () => { try { u.close(); } catch (e) { /* closed */ } if (this.udp === u) this.udp = null; });
      u.bind(DISCOVERY_PORT, '0.0.0.0');
      this.udp = u;
    } catch (e) { this.udp = null; }
  }

  /* ----- changes pushed to the open pages ----- */
  push(ev, exceptClient) {
    const line = 'data: ' + JSON.stringify(ev) + '\n\n';
    for (const c of this.clients.values()) if (c.client !== exceptClient) { try { c.res.write(line); } catch (e) { /* closed */ } }
  }

  /* ----- HTTP ----- */
  fail(res, code, msg) {
    if (res.headersSent) { try { res.end(); } catch (e) { /* closed */ } return; }
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ e: { message: msg } }));
  }
  json(res, obj, headers) { res.writeHead(200, Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, headers || {})); res.end(JSON.stringify(obj)); }
  body(req, max) {
    return new Promise((resolve, reject) => {
      const parts = []; let n = 0;
      req.on('data', (c) => { n += c.length; if (n > max) { reject(new Error('Too large.')); req.destroy(); return; } parts.push(c); });
      req.on('end', () => resolve(Buffer.concat(parts)));
      req.on('error', reject);
    });
  }
  sendFile(req, res, file, name, attach) {
    let st;
    try { st = fs.statSync(file); } catch (e) { return this.fail(res, 404, 'Not found'); }
    const type = this.o.mime(file);
    const h = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
    if (attach) h['content-disposition'] = 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(name || path.basename(file));
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m && st.size) {
      const start = m[1] ? Math.min(+m[1], st.size - 1) : Math.max(0, st.size - (+m[2] || 0)), end = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
      res.writeHead(206, Object.assign(h, { 'content-range': 'bytes ' + start + '-' + end + '/' + st.size, 'content-length': String(end - start + 1) }));
      fs.createReadStream(file, { start: start, end: end }).pipe(res);
      return;
    }
    res.writeHead(200, Object.assign(h, { 'content-length': String(st.size) }));
    fs.createReadStream(file).pipe(res);
  }
  /* a file kept for the phone to download (exports, PDFs), for an hour */
  offer(name, bytes) {
    const tok = rand(16), dir = path.join(this.tmp, 'out-' + tok);
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(name || 'download').replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_').slice(0, 150) || 'download';
    const file = path.join(dir, safe);
    fs.writeFileSync(file, bytes);
    this.downloads.set(tok, { file: file, name: safe, at: Date.now() });
    return '/dl/' + tok + '/' + encodeURIComponent(safe);
  }
  cleanTmp() {
    const old = Date.now() - 24 * 3600 * 1000;
    try { fs.readdirSync(this.tmp).forEach((n) => { const p = path.join(this.tmp, n); try { if (fs.statSync(p).mtimeMs < old) fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ } }); } catch (e) { /* none yet */ }
    for (const [k, v] of this.downloads) if (Date.now() - v.at > 3600 * 1000) this.downloads.delete(k);
  }
  pairPage(msg) {
    const name = String(this.o.name()).replace(/[<>&"]/g, '');
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + name + '</title>' +
      '<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0A0A10;color:#EDEDF0;font:15px/1.5 system-ui,sans-serif;padding:20px;box-sizing:border-box}' +
      '.c{width:100%;max-width:360px;display:flex;flex-direction:column;gap:14px}img{width:52px;height:52px;border-radius:14px}h1{font-size:22px;margin:0}p{margin:0;color:#A1A1AB}' +
      'input{font:600 26px/1 ui-monospace,monospace;letter-spacing:.35em;text-align:center;padding:14px;border-radius:12px;border:1px solid #2B2B33;background:#141418;color:#EDEDF0;width:100%;box-sizing:border-box}' +
      'input.n{font:15px system-ui,sans-serif;letter-spacing:0;text-align:left}button{font:600 15px system-ui,sans-serif;padding:14px;border-radius:12px;border:1px solid #7C6CF0;background:rgba(124,108,240,.18);color:#EDEDF0}' +
      '.e{color:#F06272;min-height:1.5em}</style></head><body><form class="c" id="f"><img src="/app-icon.png" alt=""><h1>Connect to ' + name + '</h1>' +
      '<p>On the computer, open Settings &gt; Desktop app &gt; Phone access and type the PIN shown there.</p>' +
      '<input id="pin" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" required>' +
      '<input class="n" id="nm" maxlength="40" placeholder="Name of this phone" required><button>Connect</button><p class="e" id="e">' + (msg || '') + '</p></form>' +
      '<script>var nm=document.getElementById("nm");try{nm.value=localStorage.getItem("morfis:phoneName")||(/Android/.test(navigator.userAgent)?"Android phone":"Phone")}catch(x){nm.value="Phone"}' +
      'document.getElementById("f").onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";try{localStorage.setItem("morfis:phoneName",nm.value)}catch(x){}' +
      'fetch("/pair",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({pin:document.getElementById("pin").value.trim(),name:nm.value.trim()})})' +
      '.then(function(r){return r.json()}).then(function(j){if(j.ok)location.replace("/app");else e.textContent=j.error||"That did not work."},function(){e.textContent="The computer did not answer."})};</script></body></html>';
  }

  async handle(req, res) {
    const u = new URL(req.url, 'http://x'), p = u.pathname;
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    if (p === '/ping') return this.json(res, { app: 'studio-morfis', name: this.o.name(), version: this.o.version });
    if (p === '/app-icon.png') return this.sendFile(req, res, this.o.iconPng());
    if (p === '/pair' && req.method === 'POST') {
      const b = JSON.parse(String(await this.body(req, 4096)) || '{}');
      /* five wrong tries: a new PIN, and no pairing for a minute, so a PIN cannot be guessed by trying them all */
      if (Date.now() < this.lockUntil) return this.json(res, { ok: false, error: 'Too many tries. Wait a minute, then use the new PIN shown on the computer.' });
      const pin = this.livePin();
      if (String(b.pin || '') !== pin) {
        if (++this.wrong >= 5) { this.newPin(); this.lockUntil = Date.now() + 60000; this.o.onChange({ t: 'remote' }); }
        await new Promise((r) => setTimeout(r, 400));
        return this.json(res, { ok: false, error: 'That PIN is not right.' });
      }
      const key = rand(32), d = { id: rand(6), name: String(b.name || 'Phone').slice(0, 40) || 'Phone', hash: sha(key), paired: new Date().toISOString(), seen: new Date().toISOString() };
      this.data.devices.push(d); this.save(); this.newPin();
      this.o.onChange({ t: 'remote' });
      return this.json(res, { ok: true }, { 'set-cookie': COOKIE + '=' + key + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=315360000' });
    }
    const dev = this.device(req);
    if (!dev) {
      if (p === '/' || p === '/app' || p === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(this.pairPage()); }
      return this.fail(res, 401, 'This phone is not paired.');
    }
    if (Date.now() - Date.parse(dev.seen || 0) > 60000) { dev.seen = new Date().toISOString(); this.save(); }
    const client = String(req.headers['x-morfis-client'] || u.searchParams.get('client') || '').slice(0, 40);

    if (p === '/' || p === '/index.html') { res.writeHead(302, { location: '/app' }); return res.end(); }
    if (p === '/app') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(this.o.page()); }
    if (p === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      const id = rand(6);
      this.clients.set(id, { res: res, device: dev.id, client: client });
      const ka = setInterval(() => { try { res.write(': k\n\n'); } catch (e) { /* closed */ } }, 25000);
      req.on('close', () => { clearInterval(ka); this.clients.delete(id); this.o.onChange({ t: 'remote' }); });
      this.o.onChange({ t: 'remote' });
      return;
    }
    if (p === '/logout' && req.method === 'POST') { this.forget(dev.id); this.o.onChange({ t: 'remote' }); return this.json(res, { ok: true }, { 'set-cookie': COOKIE + '=; Path=/; Max-Age=0' }); }
    if (p.indexOf('/__file/') === 0) { const f = this.o.previewFile(p.split('/')[2]); return f ? this.sendFile(req, res, f, path.basename(f), u.searchParams.has('dl')) : this.fail(res, 404, 'Not found'); }
    if (p.indexOf('/dl/') === 0) { const d = this.downloads.get(p.split('/')[2]); return d ? this.sendFile(req, res, d.file, d.name, true) : this.fail(res, 404, 'That download has expired.'); }
    if (p === '/upload' && req.method === 'POST') {
      /* a file chosen on the phone lands in a private folder here; the page then copies it where it belongs */
      const name = String(u.searchParams.get('name') || 'file').replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_').slice(0, 150) || 'file';
      const dir = path.join(this.tmp, 'in-' + rand(8)); fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, name);
      await new Promise((resolve, reject) => {
        let n = 0; const out = fs.createWriteStream(file);
        req.on('data', (c) => { n += c.length; if (n > MAX_UPLOAD) { req.destroy(); out.destroy(); reject(new Error('That file is too large.')); } });
        req.pipe(out); out.on('finish', resolve); out.on('error', reject); req.on('error', reject);
      });
      return this.json(res, { v: file });
    }
    if (p === '/download' && req.method === 'POST') return this.json(res, { v: this.offer(u.searchParams.get('name'), await this.body(req, MAX_JSON)) });
    if (p.indexOf('/api/') === 0 && req.method === 'POST') return this.api(req, res, p.slice(5), client);
    if (req.method === 'GET') {
      const a = this.o.asset(p);
      if (a) { res.writeHead(200, { 'content-type': a.type, 'cache-control': 'no-store' }); return res.end(a.body); }
    }
    return this.fail(res, 404, 'Not found');
  }

  async api(req, res, method, client) {
    let args = [];
    try { args = JSON.parse(String(await this.body(req, MAX_JSON)) || '{}').args || []; } catch (e) { return this.fail(res, 400, 'Bad request'); }
    if (!Array.isArray(args)) args = [];
    if (Object.prototype.hasOwnProperty.call(PHONE_ONLY_NOOP, method)) return this.json(res, { v: PHONE_ONLY_NOOP[method] });
    const extra = this.extra();
    const fn = extra[method] || (!PHONE_BLOCKED.has(method) && this.o.api[method]);
    if (typeof fn !== 'function') return this.json(res, { e: { message: 'Not available from the phone: ' + method } });
    try {
      let v = await fn.apply(extra[method] ? extra : this.o.api, args);
      if (method === 'preview' && v && v.url) v = Object.assign({}, v, { url: v.url.replace(/^morfis:\/\/app/, '') });
      if (method === 'info' && v) v = Object.assign({}, v, { zoom: 1, remote: true });
      this.o.after(method, args, client);
      return this.json(res, { v: v === undefined ? null : v });
    } catch (err) { return this.json(res, { e: { message: (err && err.message) || String(err), code: err && err.code } }); }
  }
  /* calls only the phone needs */
  extra() {
    const self = this;
    return {
      /* folders on this computer, for choosing one from the phone */
      dirs(p) {
        if (!p) {
          if (process.platform === 'win32') {
            const out = [];
            for (let c = 67; c <= 90; c++) { const d = String.fromCharCode(c) + ':\\'; try { fs.accessSync(d); out.push({ name: d, path: d }); } catch (e) { /* no drive */ } }
            return { path: '', parent: '', dirs: [{ name: 'Documents', path: path.join(os.homedir(), 'Documents') }, { name: 'Desktop', path: path.join(os.homedir(), 'Desktop') }].concat(out) };
          }
          p = os.homedir();
        }
        const list = fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory() && !/^[.$]/.test(d.name) && !/^(system volume information|node_modules)$/i.test(d.name))
          .map((d) => ({ name: d.name, path: path.join(p, d.name) })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).slice(0, 500);
        const parent = path.dirname(p);
        return { path: p, parent: parent === p ? '' : parent, dirs: list };
      },
      async pdfFile(html, filename) { return self.offer(filename || 'document.pdf', await self.o.renderPdf(html)); },
      async printFile(html) { return self.offer('print.pdf', await self.o.renderPdf(html)); }
    };
  }
}

module.exports = { Remote, DISCOVERY_PORT };
