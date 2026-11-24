'use strict';
/* Seedform for Windows: the main process.
   It opens one frameless window that shows the dashboard, keeps the data on this computer, gives the page real
   folder access through window.morfisDesktop (see preload.js and bridge.js), and handles the splash screen, tray,
   app name and icon, and the desktop settings. */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, nativeTheme, nativeImage, Tray, Menu, globalShortcut, session, screen, Notification } = require('electron');
const { Prefs } = require('./prefs');
const { Store } = require('./store');
const { Branding, APP_ID } = require('./branding');
const fsops = require('./fsops');
const patch = require('./patch');
const ai = require('./ai');
const { FolderIcons } = require('./folder-icons');
const { Remote } = require('./remote');

const ROOT = path.join(__dirname, '..', '..');
const DASHBOARD = path.join(ROOT, 'src', 'dashboard', 'dashboard.html');
const RENDERER = path.join(__dirname, 'renderer');
const DEFAULT_ICON = path.join(ROOT, 'build', 'icon.png');
const LEAFLET = path.dirname(require.resolve('leaflet/dist/leaflet.js'));
const MAMMOTH = path.dirname(require.resolve('mammoth/mammoth.browser.min.js'));
const INTER = path.join(path.dirname(require.resolve('@fontsource-variable/inter/package.json')), 'files');
/* the Seedform typefaces, on this computer: Playfair Display (headlines), Manrope (text and interface), IBM Plex Mono (labels) */
const FONTS = {
  playfair: path.join(path.dirname(require.resolve('@fontsource-variable/playfair-display/package.json')), 'files'),
  manrope: path.join(path.dirname(require.resolve('@fontsource-variable/manrope/package.json')), 'files'),
  plexmono: path.join(path.dirname(require.resolve('@fontsource/ibm-plex-mono/package.json')), 'files')
};
/* the voice assistant, all on this computer: the speech engine (ONNX Runtime, WebAssembly), Whisper to listen,
   Kokoro to speak, and espeak-ng (through phonemizer) to turn words into sounds for Kokoro */
/* a package's folder (some packages do not let their package.json be resolved by name: find it from the entry file) */
const pkgDir = (name) => {
  try { return path.dirname(require.resolve(name + '/package.json')); } catch (e) { /* try the entry file */ }
  try {
    let d = path.dirname(require.resolve(name));
    for (let i = 0; i < 6 && d !== path.dirname(d); i++, d = path.dirname(d)) {
      const pj = path.join(d, 'package.json');
      if (fs.existsSync(pj) && JSON.parse(fs.readFileSync(pj, 'utf8')).name === name) return d;
    }
  } catch (e) { /* not installed */ }
  const guess = path.join(__dirname, '..', '..', 'node_modules', name);
  return fs.existsSync(guess) ? guess : '';
};
const VOICE = {
  ort: path.join(pkgDir('onnxruntime-web'), 'dist'),
  transformers: path.join(pkgDir('@huggingface/transformers'), 'dist'),
  phonemizer: path.join(pkgDir('phonemizer'), 'dist'),
  whisper: path.join(pkgDir('sts-whisper-base'), 'models'),
  kokoroShards: pkgDir('kokoro-q8-shards'),
  kokoroVoices: path.join(pkgDir('kokoro-js'), 'voices')
};
const UA = 'StudioMorfisDesktop/' + app.getVersion() + ' (Windows desktop app; architecture practice dashboard)';
const HOTKEY = 'CommandOrControl+Alt+M';

/* ----- before the app is ready ----- */
protocol.registerSchemesAsPrivileged([{ scheme: 'morfis', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId(APP_ID);

/* the program is called Seedform now; its records stay in the folder they have always been in */
if (path.resolve(app.getPath('userData')) === path.resolve(path.join(app.getPath('appData'), app.getName()))) app.setPath('userData', path.join(app.getPath('appData'), 'Studio Morfis'));
const USER = app.getPath('userData');
const prefs = new Prefs(USER);
const store = new Store(path.join(USER, 'data'));
const journals = new fsops.Journals(path.join(USER, 'journals'));
const ops = fsops.makeOps(journals);
const branding = new Branding(prefs, USER, DEFAULT_ICON);
const folderIcons = new FolderIcons(USER);
if (!prefs.get('hwAccel')) app.disableHardwareAcceleration();

let win = null, splash = null, tray = null, quitting = false, lastSaveDir = '';
const startHidden = process.argv.indexOf('--hidden') !== -1;

const resolvedTheme = () => { const t = prefs.get('theme'); return t === 'light' || (t === 'system' && !nativeTheme.shouldUseDarkColors) ? 'light' : 'dark'; };
const bg = () => (resolvedTheme() === 'light' ? '#E9EBF3' : '#0A0A10');
const winState = () => (win && !win.isDestroyed() ? { focus: win.isFocused(), max: win.isMaximized(), full: win.isFullScreen() } : {});
const sendWin = () => { if (win && !win.isDestroyed()) win.webContents.send('win:state', winState()); };

/* ----- the page, served from morfis://app/ ----- */
const MIME = { '.wasm': 'application/wasm', '.mjs': 'text/javascript; charset=utf-8', '.onnx': 'application/octet-stream', '.bin': 'application/octet-stream', '.woff2': 'font/woff2', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
function pageHtml(remote) {
  const r = patch.build(fs.readFileSync(DASHBOARD, 'utf8'), { htmlClass: patch.htmlClass(prefs.public()) + (remote ? ' remote' : ''), tail: patch.tail('', remote) });
  if (r.missing.length) console.warn('[morfis] dashboard patch anchors missing:', r.missing);
  return r.html.replace(/<head>/, remote ? '<head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0A0A10"><script src="remote-bridge.js"></script>' : '<head><script src="bridge.js"></script>');
}
/* ----- file preview: the page gets a link to one file at a time, never a general file server ----- */
const PREVIEW = new Map();
const PMIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif', ico: 'image/x-icon',
  pdf: 'application/pdf', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/mp4', ogv: 'video/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg' };
function previewLink(file) {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error('That is a folder.');
  for (const [k, v] of PREVIEW) if (v === file) return k;
  const token = require('crypto').randomBytes(12).toString('hex');
  PREVIEW.set(token, file);
  if (PREVIEW.size > 400) PREVIEW.delete(PREVIEW.keys().next().value);
  return token;
}
function serveFile(req, file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return new Response('Not found', { status: 404 }); }
  const ext = path.extname(file).slice(1).toLowerCase(), mime = PMIME[ext] || 'application/octet-stream';
  const { Readable } = require('stream');
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  if (m && st.size) {
    const start = m[1] ? Math.min(+m[1], st.size - 1) : Math.max(0, st.size - (+m[2] || 0)), end = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
    return new Response(Readable.toWeb(fs.createReadStream(file, { start: start, end: end })), { status: 206, headers: Object.assign({ 'content-type': mime, 'content-range': 'bytes ' + start + '-' + end + '/' + st.size, 'accept-ranges': 'bytes', 'content-length': String(end - start + 1) }, ISOLATE) });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), { headers: Object.assign({ 'content-type': mime, 'content-length': String(st.size), 'accept-ranges': 'bytes', 'cache-control': 'no-store' }, ISOLATE) });
}
/* the scripts, styles, fonts and icon the page loads; shared by the window and the phone page */
function asset(pathname) {
  let file;
  if (pathname === '/app-icon.png') return { body: fs.readFileSync(branding.iconPng()), type: 'image/png' };
  if (pathname.indexOf('/vendor/leaflet/') === 0) file = path.join(LEAFLET, decodeURIComponent(pathname.slice('/vendor/leaflet/'.length)));
  else if (pathname.indexOf('/vendor/mammoth/') === 0) file = path.join(MAMMOTH, decodeURIComponent(pathname.slice('/vendor/mammoth/'.length)));
  else if (pathname.indexOf('/vendor/inter/') === 0) file = path.join(INTER, decodeURIComponent(pathname.slice('/vendor/inter/'.length)));
  else if (/^\/vendor\/fonts\/(playfair|manrope|plexmono)\//.test(pathname)) { const k = pathname.split('/')[3]; file = path.join(FONTS[k], decodeURIComponent(pathname.split('/').slice(4).join('/'))); }
  else file = path.join(RENDERER, decodeURIComponent(pathname.slice(1)));
  const okRoot = [LEAFLET, INTER, MAMMOTH, RENDERER, FONTS.playfair, FONTS.manrope, FONTS.plexmono].some((r) => path.resolve(file).startsWith(path.resolve(r) + path.sep));
  if (!okRoot || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return { body: fs.readFileSync(file), type: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' };
}
/* the voice files are large: streamed from disk, never read whole; Kokoro's weights come in six pieces, joined here */
const VOICE_ROUTES = [['/vendor/ort/', 'ort'], ['/vendor/transformers/', 'transformers'], ['/vendor/phonemizer/', 'phonemizer'], ['/voice/models/', 'whisper'], ['/voice/kokoro/voices/', 'kokoroVoices']];
function voiceFile(pathname) {
  for (const [pre, key] of VOICE_ROUTES) {
    if (pathname.indexOf(pre) !== 0 || !VOICE[key]) continue;
    const root = path.resolve(VOICE[key]), file = path.resolve(root, decodeURIComponent(pathname.slice(pre.length)));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    return file;
  }
  return null;
}
const ISOLATE = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'credentialless', 'cross-origin-resource-policy': 'same-origin' };
function serveVoice(pathname) {
  const { Readable } = require('stream');
  const head = (type, size) => Object.assign({ 'content-type': type, 'cache-control': 'max-age=31536000, immutable' }, size != null ? { 'content-length': String(size) } : {}, ISOLATE);
  if (pathname === '/voice/kokoro/model_quantized.onnx') {
    const parts = [0, 1, 2, 3, 4, 5].map((i) => path.join(VOICE.kokoroShards, 'kokoro-q8.part' + i + '.bin'));
    if (!VOICE.kokoroShards || !parts.every((f) => fs.existsSync(f))) return new Response('Not found', { status: 404 });
    const size = parts.reduce((a, f) => a + fs.statSync(f).size, 0);
    const joined = (async function* () { for (const f of parts) for await (const c of fs.createReadStream(f)) yield c; })();
    return new Response(Readable.toWeb(Readable.from(joined)), { headers: head('application/octet-stream', size) });
  }
  const file = voiceFile(pathname);
  if (!file) return null;
  return new Response(Readable.toWeb(fs.createReadStream(file)), { headers: head(MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', fs.statSync(file).size) });
}
function serve(req) {
  const u = new URL(req.url);
  if (u.pathname.indexOf('/vendor/ort/') === 0 || u.pathname.indexOf('/vendor/transformers/') === 0 || u.pathname.indexOf('/vendor/phonemizer/') === 0 || u.pathname.indexOf('/voice/') === 0) return serveVoice(u.pathname) || new Response('Not found', { status: 404 });
  if (u.pathname.indexOf('/__file/') === 0) { const tok = u.pathname.split('/')[2], f = PREVIEW.get(tok); return f ? serveFile(req, f) : new Response('Not found', { status: 404 }); }
  /* cross-origin isolated, so the speech engine can use several CPU threads (map tiles still load: credentialless) */
  if (u.pathname === '/' || u.pathname === '/index.html') return new Response(pageHtml(), { headers: Object.assign({ 'content-type': MIME['.html'], 'cache-control': 'no-store' }, ISOLATE) });
  const a = asset(u.pathname);
  if (!a) return new Response('Not found', { status: 404 });
  return new Response(a.body, { headers: Object.assign({ 'content-type': a.type, 'cache-control': u.pathname === '/app-icon.png' ? 'no-store' : 'no-cache' }, ISOLATE) });
}

/* ----- splash: a quick animated card while the dashboard loads ----- */
function openSplash() {
  if (!prefs.get('splash') || startHidden) return;
  splash = new BrowserWindow({ width: 380, height: 320, frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
    skipTaskbar: true, alwaysOnTop: true, show: false, hasShadow: false, focusable: false, icon: branding.image(),
    webPreferences: { preload: path.join(__dirname, 'splash-preload.js'), contextIsolation: true, sandbox: true } });
  const icon = branding.iconPng();
  /* the studio's wordmark, unless the app has been given another name or icon */
  const own = !prefs.get('branding').name && !prefs.get('branding').iconFile;
  splash.loadFile(path.join(RENDERER, 'splash.html'), { query: { name: branding.name(), icon: require('url').pathToFileURL(icon).href, logo: own ? '1' : '', display: require('url').pathToFileURL(path.join(FONTS.playfair, 'playfair-display-latin-wght-normal.woff2')).href, text: require('url').pathToFileURL(path.join(FONTS.manrope, 'manrope-latin-wght-normal.woff2')).href, theme: resolvedTheme(), accent: prefs.get('accent'), motion: prefs.get('reduceMotion') ? '0' : '1' } });
  splash.once('ready-to-show', () => { if (splash) { splash.shownAt = Date.now(); splash.show(); } });
}
function closeSplash(then) {
  if (!splash || splash.isDestroyed()) { splash = null; then(); return; }
  const wait = Math.max(0, 750 - (Date.now() - (splash.shownAt || Date.now())));
  setTimeout(() => {
    if (!splash || splash.isDestroyed()) { splash = null; then(); return; }
    splash.webContents.send('splash:done');
    then();
    setTimeout(() => { if (splash && !splash.isDestroyed()) splash.destroy(); splash = null; }, 260);
  }, wait);
}

/* ----- the main window ----- */
function savedBounds() {
  const w = prefs.get('window') || {}, b = w.bounds;
  if (!prefs.get('rememberWindow') || !b) return null;
  const d = screen.getDisplayMatching(b).workArea;
  const visible = b.x < d.x + d.width - 80 && b.x + b.width > d.x + 80 && b.y >= d.y - 10 && b.y < d.y + d.height - 80;
  return visible ? b : null;
}
let boundsT = null;
function keepBounds() {
  clearTimeout(boundsT);
  boundsT = setTimeout(() => {
    if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    prefs.set('window', { bounds: win.isMaximized() ? (prefs.get('window').bounds || win.getNormalBounds()) : win.getBounds(), maximized: win.isMaximized() });
  }, 400);
}
function createWindow() {
  const b = savedBounds();
  win = new BrowserWindow(Object.assign({ width: 1440, height: 900, center: !b }, b || {}, {
    minWidth: 960, minHeight: 620, frame: false, show: false, backgroundColor: bg(), title: branding.name(), icon: branding.image(),
    alwaysOnTop: prefs.get('alwaysOnTop'), roundedCorners: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, plugins: true, spellcheck: prefs.get('spellcheck'), backgroundThrottling: false }
  }));
  if (b && prefs.get('window').maximized) win.maximize();
  win.setMenuBarVisibility(false);
  win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});

  let ready = 0;
  const reveal = () => {
    if (++ready < 2) return;
    win.webContents.setZoomFactor(prefs.get('zoom'));
    closeSplash(() => {
      if (startHidden) { ensureTray(); return; }
      if (prefs.get('startMinimized')) { if (prefs.get('closeToTray')) ensureTray(); else { win.showInactive(); win.minimize(); } return; }
      win.show(); win.focus();
    });
  };
  win.once('ready-to-show', reveal);
  win.webContents.once('did-finish-load', () => setTimeout(reveal, 120));
  setTimeout(() => { if (ready < 2) { ready = 1; reveal(); } }, 9000);

  ['maximize', 'unmaximize', 'focus', 'blur', 'enter-full-screen', 'leave-full-screen', 'restore'].forEach((ev) => win.on(ev, sendWin));
  win.on('focus', () => win.webContents.send('app:focus'));
  win.on('resize', keepBounds); win.on('move', keepBounds);
  win.on('close', (e) => {
    keepBounds();
    if (quitting) return;
    if (prefs.get('closeToTray')) { e.preventDefault(); win.hide(); ensureTray(); return; }
    if (prefs.get('confirmQuit')) {
      e.preventDefault();
      dialog.showMessageBox(win, { type: 'question', buttons: ['Quit', 'Cancel'], defaultId: 0, cancelId: 1, title: branding.name(), message: 'Quit ' + branding.name() + '?', detail: 'Everything is already saved on this computer.' })
        .then((r) => { if (r.response === 0) { quitting = true; app.quit(); } });
    }
  });
  win.on('closed', () => { win = null; });

  /* links to maps and websites open in the browser; the window itself never navigates away */
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!/^morfis:\/\/app\//.test(url)) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); } });
  win.webContents.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    const ctrl = i.control || i.meta;
    if (i.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if (ctrl && i.shift && i.key.toLowerCase() === 'i' && (prefs.get('devTools') || !app.isPackaged)) { win.webContents.toggleDevTools(); e.preventDefault(); }
    else if (ctrl && (i.key === '=' || i.key === '+' || i.key === '-' || i.key === '0')) {
      const z = i.key === '0' ? 1 : Math.round((prefs.get('zoom') + (i.key === '-' ? -0.1 : 0.1)) * 100) / 100;
      prefs.set('zoom', z); win.webContents.setZoomFactor(prefs.get('zoom')); win.webContents.send('app:zoom', prefs.get('zoom')); e.preventDefault();
    }
  });
  win.loadURL('morfis://app/index.html');
}
function showWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

/* ----- tray ----- */
function trayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open ' + branding.name(), click: showWindow },
    { label: 'New project', click: () => { showWindow(); win.webContents.executeJavaScript("(function(){var b=document.querySelector('[data-act=newProject]');if(b)b.click();})()").catch(() => {}); } },
    { label: 'Reminders', click: () => { showWindow(); win.webContents.executeJavaScript("(function(){var b=document.getElementById('bellBtn');if(b)b.click();})()").catch(() => {}); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } }
  ]);
}
function ensureTray() {
  if (tray) return;
  tray = new Tray(branding.image().resize({ width: 16, height: 16, quality: 'best' }));
  tray.setToolTip(branding.name());
  tray.setContextMenu(trayMenu());
  tray.on('click', () => { if (win && win.isVisible() && win.isFocused()) win.hide(); else showWindow(); });
}
function dropTray() { if (tray && !prefs.get('closeToTray')) { tray.destroy(); tray = null; } }
function refreshBrandingLive() {
  const name = branding.name();
  if (win) { win.setTitle(name); win.setIcon(branding.image()); }
  if (tray) { tray.setImage(branding.image().resize({ width: 16, height: 16, quality: 'best' })); tray.setToolTip(name); tray.setContextMenu(trayMenu()); }
}

/* ----- desktop settings with side effects ----- */
function loginItem() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  app.setLoginItemSettings({ openAtLogin: !!prefs.get('launchAtLogin'), args: prefs.get('startMinimized') ? ['--hidden'] : [] });
}
function hotkey() {
  globalShortcut.unregister(HOTKEY);
  if (prefs.get('globalHotkey')) globalShortcut.register(HOTKEY, () => { if (win && win.isVisible() && win.isFocused()) win.hide(); else showWindow(); });
}
function applyPref(k) {
  if (k === 'launchAtLogin' || k === 'startMinimized') loginItem();
  if (k === 'alwaysOnTop' && win) win.setAlwaysOnTop(prefs.get('alwaysOnTop'));
  if (k === 'spellcheck') session.defaultSession.setSpellCheckerEnabled(prefs.get('spellcheck'));
  if (k === 'globalHotkey') return { ok: hotkey() !== false && (!prefs.get('globalHotkey') || globalShortcut.isRegistered(HOTKEY)) };
  if (k === 'closeToTray') { if (prefs.get('closeToTray')) ensureTray(); else dropTray(); }
  if (k === 'zoom' && win) win.webContents.setZoomFactor(prefs.get('zoom'));
  if (k === 'hwAccel') return { restart: true };
  return {};
}

/* ----- maps: search and address lookup (OpenStreetMap Nominatim) ----- */
async function nominatim(pathAndQuery) {
  const r = await net.fetch('https://nominatim.openstreetmap.org/' + pathAndQuery, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
  if (!r.ok) throw new Error('The map search answered ' + r.status + '.');
  return r.json();
}
function shortAddr(a) {
  a = a || {};
  return [a.house_number && a.road ? a.house_number + ' ' + a.road : a.road, a.suburb || a.village || a.neighbourhood, a.town || a.city || a.county].filter(Boolean).slice(0, 3).join(', ');
}

/* ----- everything the page can ask for ----- */
let explorerDarkAt = 0, explorerDarkWas = false;
const mustExist = (p) => { if (!p || !fs.existsSync(p)) { const e = new Error('It is not there.'); e.code = 'ENOENT'; throw e; } };
const API = {
  info: () => ({ dataDir: store.root, documents: app.getPath('documents'), zoom: prefs.get('zoom'), version: app.getVersion(), electron: process.versions.electron, packaged: app.isPackaged, platform: process.platform }),
  storeLoad: () => store.load(),
  storeSet: (kind, id, value) => { store.set(kind, id, value); return true; },
  async saveFile(filename, bytes) {
    const ext = path.extname(filename).slice(1).toLowerCase();
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(lastSaveDir || app.getPath('documents'), filename), filters: ext ? [{ name: ext.toUpperCase() + ' file', extensions: [ext] }] : [] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, Buffer.from(bytes));
    lastSaveDir = path.dirname(r.filePath);
    return r.filePath;
  },
  winAct(a) {
    if (!win) return {};
    if (a === 'min') win.minimize();
    else if (a === 'max') { if (win.isFullScreen()) win.setFullScreen(false); else if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
    else if (a === 'close') win.close();
    return winState();
  },
  winState: () => winState(),
  setTheme(t) {
    const th = t === 'light' ? 'light' : 'dark';
    if (prefs.get('theme') !== th) prefs.set('theme', th);
    nativeTheme.themeSource = th;
    if (win) win.setBackgroundColor(bg());
    return true;
  },
  setZoom(f) { prefs.set('zoom', f); if (win) win.webContents.setZoomFactor(prefs.get('zoom')); return prefs.get('zoom'); },
  setBranding(o) {
    if (!branding.set(o)) return { changed: false };
    refreshBrandingLive();
    setTimeout(() => { try { branding.updateShortcuts(); } catch (e) { /* shortcuts stay as they were */ } }, 50);
    return { changed: true };
  },
  async openPath(p) { mustExist(p); const r = await shell.openPath(p); if (r) throw new Error(r); return true; },
  reveal(p) { mustExist(p); shell.showItemInFolder(p); return true; },
  async openDataDir() { const r = await shell.openPath(store.root); if (r) throw new Error(r); return true; },
  trashPath: (p) => shell.trashItem(p),
  async pickFiles(o) {
    o = o || {};
    const r = await dialog.showOpenDialog(win, { title: o.title, defaultPath: o.defaultPath, filters: o.filters, properties: ['openFile', 'multiSelections'].concat(o.folders ? ['openDirectory'] : []) });
    return r.canceled ? [] : r.filePaths;
  },
  async pickFolder(o) {
    o = o || {};
    const r = await dialog.showOpenDialog(win, { title: o.title, defaultPath: o.defaultPath && fs.existsSync(o.defaultPath) ? o.defaultPath : undefined, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  },
  readFile: (p) => fs.readFileSync(p, 'utf8').replace(/^﻿/, ''),
  isDir: (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } },
  scanProject: (d, t) => fsops.scanProject(d, t),
  scanRoot: (d) => fsops.scanRoot(d),
  scanDir: (d) => fsops.scanDir(d),
  listTree: (d, o) => fsops.listTree(d, o),
  listDir: (b, r) => fsops.listDir(b, r),
  mkdirs: (d, l) => ops.mkdirs(d, l),
  journalList: (o) => ops.journalList(o),
  removeIfEmpty: (d, l) => ops.removeIfEmpty(d, l),
  copyInto: (d, p) => ops.copyInto(d, p),
  applyOps: (b, o, m, l) => ops.applyOps(b, o, m, l),
  undo: (id) => ops.undo(id),
  renameItem: (p, r, n) => ops.renameItem(p, r, n),
  movePath: (f, t, l) => ops.movePath(f, t, l),
  makeDir: (b, r, n) => ops.makeDir(b, r, n),
  moveItems: (b, r, d, l) => ops.moveItems(b, r, d, l),
  trashItems: (b, r) => ops.trashItems(b, r),
  async geocode(q) {
    const list = await nominatim('search?format=jsonv2&addressdetails=1&limit=6&q=' + encodeURIComponent(q));
    return (list || []).map((x) => ({ lat: +x.lat, lng: +x.lon, label: x.display_name }));
  },
  async reverse(lat, lng) {
    const x = await nominatim('reverse?format=jsonv2&zoom=18&addressdetails=1&lat=' + (+lat) + '&lon=' + (+lng));
    return { label: (x && x.display_name) || '', short: shortAddr(x && x.address) };
  },
  /* desktop settings card */
  getPrefs: () => Object.assign(prefs.public(), { version: app.getVersion(), electron: process.versions.electron, packaged: app.isPackaged, hotkey: 'Ctrl+Alt+M', backups: store.backupDir, name: branding.name() }),
  setPref(k, v) { prefs.set(k, v); return Object.assign({ value: prefs.get(k) }, applyPref(k)); },
  resetPrefs() { prefs.reset(); ['launchAtLogin', 'alwaysOnTop', 'spellcheck', 'globalHotkey', 'closeToTray', 'zoom'].forEach(applyPref); return prefs.public(); },
  relaunch() { quitting = true; app.relaunch(); app.exit(0); },
  async openBackups() { fs.mkdirSync(store.backupDir, { recursive: true }); const r = await shell.openPath(store.backupDir); if (r) throw new Error(r); return true; },
  backupNow() { const f = path.join(store.backupDir, 'studio-morfis-backup-' + require('./util').ymd() + '.json'); try { fs.unlinkSync(f); } catch (e) { /* none yet */ } store.backup(prefs.get('backupKeep')); return fs.existsSync(f) ? f : ''; },
  refreshShortcuts: () => branding.updateShortcuts(),

  /* document editor */
  docsList: () => store.docsList(),
  docSave: (d) => store.docSave(d),
  docDelete: (id) => store.docDelete(id),
  kvGet: (k) => store.kvGet(k),
  kvSet: (k, v) => store.kvSet(k, v),
  async savePdf(html, filename) {
    const pdf = await renderPdf(html);
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(lastSaveDir || app.getPath('documents'), filename), filters: [{ name: 'PDF document', extensions: ['pdf'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, pdf);
    lastSaveDir = path.dirname(r.filePath);
    return r.filePath;
  },
  printHtml(html) {
    return new Promise((resolve) => {
      const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
      w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      w.webContents.once('did-finish-load', () => w.webContents.print({ printBackground: true }, (ok, why) => { w.destroy(); resolve({ ok: ok, reason: why || '' }); }));
    });
  },
  notify(title, body) {
    if (!Notification.isSupported()) return false;
    const n = new Notification({ title: String(title || branding.name()), body: String(body || ''), icon: branding.image() });
    n.on('click', showWindow);
    n.show();
    return true;
  },
  openExternal(url) { if (/^https:\/\//i.test(url) || /^mailto:/i.test(url)) return shell.openExternal(url); throw new Error('Only web and email links open from here.'); },

  /* automation agent on this computer (Ollama) */
  aiStatus: () => ai.status(prefs),
  aiDelete: (name) => ai.remove(prefs, name),
  aiChat: (o) => ai.chat(prefs, o || {}),
  aiPull(name) {
    return ai.pull(prefs, name, (p) => { if (win && !win.isDestroyed()) win.webContents.send('ai:pull', p); remote.push({ t: 'ai:pull', p: p }); });
  },

  /* phone access */
  remoteStatus: () => remote.status(),
  async remoteSet(on) { prefs.set('remoteOn', !!on); return on ? remote.start() : remote.stop(); },
  remoteNewPin() { remote.newPin(); return remote.status(); },
  remoteForget: (id) => remote.forget(id),
  async remotePort(n) {
    n = Math.round(+n);
    if (!(n >= 1024 && n <= 65535)) throw new Error('Choose a port from 1024 to 65535.');
    prefs.set('remotePort', n);
    if (!remote.server) return remote.status();
    await remote.stop(); return remote.start();
  },

  /* built-in preview */
  preview(file) {
    const st = fs.statSync(file);
    return { url: 'morfis://app/__file/' + previewLink(file) + '/' + encodeURIComponent(path.basename(file)), name: path.basename(file), dir: path.dirname(file), size: st.size, mtimeMs: st.mtimeMs, ext: path.extname(file).slice(1).toLowerCase() };
  },
  readText(file, max) {
    const lim = Math.min(+max || 1048576, 4194304), st = fs.statSync(file), fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(lim, st.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      let text = buf[0] === 0xFF && buf[1] === 0xFE ? buf.slice(2).toString('utf16le') : buf.toString('utf8').replace(/^\uFEFF/, '');
      return { text: text, cut: st.size > lim, size: st.size };
    } finally { fs.closeSync(fd); }
  },
  /* the picture Windows shows for a file in File Explorer (any type with a thumbnail handler) */
  async thumb(file, size) {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return '';
    try {
      const img = await nativeImage.createThumbnailFromPath(file, { width: size || 256, height: size || 256 });
      return img.isEmpty() ? '' : img.toDataURL();
    } catch (e) { return ''; }
  },

  /* the app's folder icons on the real folders in File Explorer */
  /* whether File Explorer is in dark mode (Windows: Settings > Personalisation > Colours > app mode) */
  explorerDark() {
    if (process.platform !== 'win32') return nativeTheme.shouldUseDarkColors;
    if (Date.now() - (explorerDarkAt || 0) < 60000) return explorerDarkWas;
    explorerDarkAt = Date.now();
    try {
      const out = require('child_process').execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
      return (explorerDarkWas = /AppsUseLightTheme\s+REG_DWORD\s+0x0\b/.test(out));
    } catch (e) { return (explorerDarkWas = false); }
  },
  folderIcon: (o) => folderIcons.apply(o || {}),
  folderIconClear: (dir) => folderIcons.clear(dir),
  folderIconClearTree: (dir, depth) => folderIcons.clearTree(dir, depth),
  folderIconRefresh: (dirs) => folderIcons.refresh(dirs)
};

/* A4 PDF from a complete HTML document, rendered off screen with scripts off */
async function renderPdf(html) {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return await w.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'none' }, preferCSSPageSize: true });
  } finally { w.destroy(); }
}

ipcMain.handle('host', async (e, method, args) => {
  if (!win || e.sender !== win.webContents) return { e: { message: 'Not allowed' } };
  const fn = API[method];
  if (!fn) return { e: { message: 'Unknown request: ' + method } };
  try { const a = Array.isArray(args) ? args : [], v = await fn.apply(API, a); changed(method, a, 'win'); return { v: v }; }
  catch (err) { return { e: { message: (err && err.message) || String(err), code: err && err.code } }; }
});

/* ----- keeping the window and the phones in step: a saved change is sent to every other open page ----- */
function changed(method, args, origin) {
  let ev = null;
  if (method === 'storeSet') ev = { t: args[0] === 's' ? 's' : 'p', id: args[1], value: args[2] };
  else if (method === 'docSave' || method === 'docDelete') ev = { t: 'doc' };
  else if (method === 'kvSet') ev = { t: 'kv', key: args[0] };
  if (!ev) return;
  if (origin !== 'win' && win && !win.isDestroyed()) win.webContents.send('store:changed', ev);
  remote.push(ev, origin);
}
const remote = new Remote({
  dir: USER, api: API, prefs: prefs, version: app.getVersion(), name: () => branding.name(), iconPng: () => branding.iconPng(),
  page: () => pageHtml(true), asset: asset, previewFile: (tok) => PREVIEW.get(tok), renderPdf: renderPdf,
  mime: (file) => { const ext = path.extname(file).slice(1).toLowerCase(); return PMIME[ext] || MIME['.' + ext] || 'application/octet-stream'; },
  after: changed,
  onChange: (ev) => { if (win && !win.isDestroyed()) win.webContents.send('remote:status', ev); }
});

/* ----- start ----- */
app.on('second-instance', showWindow);
app.whenReady().then(() => {
  protocol.handle('morfis', serve);
  nativeTheme.themeSource = prefs.get('theme') === 'light' ? 'light' : 'dark';
  /* the microphone only for the app's own window, and only sound (the voice assistant); nothing else asks */
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => {
    if (perm === 'media') return cb(!!win && wc === win.webContents && prefs.get('voiceOn') !== false && (details.mediaTypes || []).every((t) => t === 'audio'));
    cb(perm === 'notifications' || perm === 'clipboard-sanitized-write');
  });
  session.defaultSession.setPermissionCheckHandler((wc, perm) => perm !== 'media' || (!!win && wc === win.webContents));
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['https://tile.openstreetmap.org/*', 'https://server.arcgisonline.com/*'] }, (d, cb) => { d.requestHeaders['User-Agent'] = UA; cb({ requestHeaders: d.requestHeaders }); });
  session.defaultSession.setSpellCheckerEnabled(prefs.get('spellcheck'));
  Menu.setApplicationMenu(null);
  openSplash();
  createWindow();
  loginItem();
  hotkey();
  if (prefs.get('closeToTray') || startHidden) ensureTray();
  if (prefs.get('remoteOn')) remote.start();
  setTimeout(() => store.backup(prefs.get('backupKeep')), 5000);
  setInterval(() => store.backup(prefs.get('backupKeep')), 6 * 3600 * 1000);
  /* shortcuts made by the installer pick up a name or icon chosen before this version, once per start */
  if (app.isPackaged && (prefs.get('branding').name || prefs.get('branding').iconFile)) setTimeout(() => { try { branding.updateShortcuts(); } catch (e) { /* ignore */ } }, 4000);
});
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); remote.stop(); });
app.on('window-all-closed', () => app.quit());
