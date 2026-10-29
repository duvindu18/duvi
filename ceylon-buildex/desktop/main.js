// Ceylon Buildex desktop program: one window with the page's own title bar, in front of the Python back end (launcher.py --desktop).
//
// Start: the window opens at once on a start-up screen in the last-used theme, while the back end starts on a local port.
// When it answers, the window loads the portal. Quit: the window asks the back end to stop (it then stops an Ollama it started),
// and kills it if it does not. If this process dies, the back end notices (it watches our process id) and stops by itself.
"use strict";
const {app, BrowserWindow, ipcMain, shell, Menu, session} = require("electron");
const path = require("path");
const fs = require("fs");
const net = require("net");
const http = require("http");
const crypto = require("crypto");
const {spawn, execFile} = require("child_process");

const PREFERRED_PORT = 47319;                    // the same port each time keeps the page's saved choices (theme, accent, mode)
const TOKEN = crypto.randomBytes(24).toString("hex");
const BG = {dark: "#0b0b0d", light: "#f3f3f1"};
const BOOT_TIMEOUT_MS = 120000;                  // first start on a slow disk with a virus scanner looking at every file

let win = null, child = null, origin = null, quitting = false, booting = null;

// ------------------------------------------------------------------ where things are
function dataHome() {                            // same rule as launcher.user_home()
  if (process.env.LRP_HOME) return process.env.LRP_HOME;
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(app.getPath("home"), "AppData", "Local"), "CeylonBuildex");
  if (process.platform === "darwin") return path.join(app.getPath("home"), "Library", "Application Support", "CeylonBuildex");
  return path.join(process.env.XDG_DATA_HOME || path.join(app.getPath("home"), ".local", "share"), "CeylonBuildex");
}

function backendCommand() {
  if (app.isPackaged) {
    const dir = path.join(process.resourcesPath, "server");
    return {cmd: path.join(dir, process.platform === "win32" ? "CeylonBuildexServer.exe" : "CeylonBuildexServer"), args: ["--desktop"], cwd: dir};
  }
  const root = path.join(__dirname, "..");     // development: run the Python sources
  return {cmd: process.env.CB_PYTHON || (process.platform === "win32" ? "python" : "python3"), args: [path.join(root, "launcher.py"), "--desktop"], cwd: root};
}

// ------------------------------------------------------------------ remembered window size, position and colours
const prefsFile = () => path.join(app.getPath("userData"), "window.json");
function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(prefsFile(), "utf8")) || {}; } catch { return {}; }
}
const prefs = {};
let saveTimer = null;
function savePrefs(now) {
  clearTimeout(saveTimer);
  const write = () => { try { fs.writeFileSync(prefsFile(), JSON.stringify(prefs)); } catch { /* not important enough to complain */ } };
  if (now) write(); else saveTimer = setTimeout(write, 400);
}
const isDark = () => (typeof prefs.dark === "boolean" ? prefs.dark : true);              // the portal opens dark until you choose otherwise

function onScreen(b) {                           // a saved position on a monitor that is no longer attached is not used
  const {screen} = require("electron");
  return b && screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return b.x + 120 > a.x && b.y + 40 > a.y && b.x < a.x + a.width - 120 && b.y < a.y + a.height - 40;
  });
}

// ------------------------------------------------------------------ the back end
function freePort(want) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once("error", () => resolve(want ? freePort(0) : 0));
    s.listen(want, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function request(method, url, headers = {}, timeout = 2000) {
  return new Promise(resolve => {
    const req = http.request(url, {method, headers, timeout}, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(0));
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function startBackend() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort(attempt === 0 ? PREFERRED_PORT : 0);
    const {cmd, args, cwd} = backendCommand();
    const env = {...process.env, PORT: String(port), LRP_PARENT_PID: String(process.pid), LRP_DESKTOP_TOKEN: TOKEN, LRP_BROWSER: "none"};
    let exited = null;
    const p = spawn(cmd, args, {cwd, env, stdio: "ignore", windowsHide: true});
    p.once("error", e => { exited = {code: -1, error: e}; });
    p.once("exit", code => { exited = exited || {code}; if (child === p) child = null; });
    child = p;
    const base = `http://127.0.0.1:${port}`, end = Date.now() + BOOT_TIMEOUT_MS;
    let wait = 60;
    while (Date.now() < end && !exited && !quitting) {
      if (await request("GET", base + "/api/status") === 200) return base;
      await sleep(wait);
      wait = Math.min(wait * 1.5, 400);
    }
    if (quitting) throw new Error("quitting");
    if (!exited) { killBackend(); throw new Error("The back end did not answer within two minutes."); }
    if (exited.error) throw new Error(`The back end could not be started (${exited.error.message}).`);
    if (exited.code !== 1) throw new Error(`The back end stopped while starting (exit code ${exited.code}).`);
    // exit code 1: most often the port was taken between our check and its start - try another port
  }
  throw new Error("The back end could not start.");
}

function killBackend() {
  const p = child;
  if (!p || p.exitCode !== null) return;
  if (process.platform === "win32") execFile("taskkill", ["/pid", String(p.pid), "/T", "/F"], {windowsHide: true}, () => {});
  else p.kill("SIGKILL");
}

async function stopBackend() {
  const p = child;
  if (!p || p.exitCode !== null) return;
  const gone = new Promise(r => p.once("exit", r));
  if (origin) await request("POST", origin + "/api/desktop/quit", {"X-Desktop-Token": TOKEN}, 1500);
  else killBackend();
  if (await Promise.race([gone.then(() => true), sleep(4000).then(() => false)])) return;
  killBackend();
  await Promise.race([gone, sleep(2000)]);
}

// ------------------------------------------------------------------ the window
function windowState(w) {
  return {maximized: w.isMaximized(), minimized: w.isMinimized(), fullscreen: w.isFullScreen(), focused: w.isFocused()};
}

function createWindow() {
  const saved = prefs.bounds && onScreen(prefs.bounds) ? prefs.bounds : null;
  const area = require("electron").screen.getPrimaryDisplay().workAreaSize;      // first start: 1360 x 880, or 90 % of a smaller screen
  win = new BrowserWindow({
    width: saved ? saved.width : Math.min(1360, Math.round(area.width * 0.9)), height: saved ? saved.height : Math.min(880, Math.round(area.height * 0.9)),
    x: saved ? saved.x : undefined, y: saved ? saved.y : undefined,
    minWidth: 820, minHeight: 560,
    title: "Ceylon Buildex",
    titleBarStyle: "hidden",                    // no system title bar: the page draws its own, in its own theme (resizing and snap stay native)
    show: false,
    backgroundColor: isDark() ? BG.dark : BG.light,
    webPreferences: {preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false},
  });
  const send = () => { if (win && !win.isDestroyed()) win.webContents.send("win:state", windowState(win)); };
  for (const ev of ["maximize", "unmaximize", "minimize", "restore", "enter-full-screen", "leave-full-screen", "focus", "blur"]) win.on(ev, send);
  win.once("ready-to-show", () => {
    if (prefs.maximized) win.maximize();
    win.show();
  });
  win.on("close", () => {
    prefs.bounds = win.getNormalBounds(); prefs.maximized = win.isMaximized();
    savePrefs(true);
  });
  win.on("closed", () => { win = null; });

  const wc = win.webContents;
  wc.setWindowOpenHandler(({url}) => {
    if (origin && url.startsWith(origin + "/")) {      // a stored PDF and the like: a plain window of our own
      return {action: "allow", overrideBrowserWindowOptions: {autoHideMenuBar: true, backgroundColor: isDark() ? BG.dark : BG.light,
        webPreferences: {contextIsolation: true, sandbox: true, nodeIntegration: false}}};
    }
    openOutside(url);
    return {action: "deny"};
  });
  wc.on("will-navigate", (e, url) => {
    if (url.startsWith("file:") || (origin && url.startsWith(origin + "/"))) return;
    e.preventDefault();
    openOutside(url);
  });
  wc.on("will-attach-webview", e => e.preventDefault());
  wc.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    const ctrl = input.control || input.meta, k = input.key.toLowerCase();
    if (k === "f11") { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if ((k === "f5" || (ctrl && k === "r")) && origin) { wc.reload(); e.preventDefault(); }
    else if (ctrl && (k === "=" || k === "+")) { wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 4)); e.preventDefault(); }
    else if (ctrl && k === "-") { wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3)); e.preventDefault(); }
    else if (ctrl && k === "0") { wc.setZoomLevel(0); e.preventDefault(); }
    else if (!app.isPackaged && ctrl && input.shift && k === "i") { wc.toggleDevTools(); e.preventDefault(); }
  });
  wc.on("render-process-gone", (_e, d) => {
    if (d.reason !== "clean-exit" && !quitting && origin) setTimeout(() => win && win.loadURL(origin + "/"), 500);
  });
  win.loadFile(path.join(__dirname, "loading.html"), {query: {dark: isDark() ? "1" : "0", accent: prefs.accent || ""}});
}

function openOutside(url) {
  if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
}

async function boot() {
  if (booting) return booting;
  booting = (async () => {
    try {
      origin = await startBackend();
      if (win && !quitting) await win.loadURL(origin + "/");
    } catch (e) {
      origin = null;
      if (win && !quitting) win.webContents.send("boot", {error: e.message, log: path.join(dataHome(), "logs", "launcher.log")});
    } finally {
      booting = null;
    }
  })();
  return booting;
}

// ------------------------------------------------------------------ messages from the page
const fromMain = e => win && e.sender === win.webContents;

ipcMain.on("win", (e, cmd) => {
  if (!fromMain(e)) return;
  if (cmd === "minimize") win.minimize();
  else if (cmd === "maximize") { if (win.isFullScreen()) win.setFullScreen(false); else if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
  else if (cmd === "close") win.close();
});
ipcMain.handle("win:state", e => (fromMain(e) ? windowState(win) : null));
ipcMain.on("win:theme", (e, t) => {
  if (!fromMain(e) || !t) return;
  const accent = /^#[0-9a-f]{6}$/i.test(t.accent) ? t.accent : null;
  if (prefs.dark === t.dark && prefs.accent === accent) return;
  prefs.dark = t.dark; prefs.accent = accent;
  win.setBackgroundColor(t.dark ? BG.dark : BG.light);
  savePrefs();
});
ipcMain.on("boot", (e, what) => {
  if (!fromMain(e)) return;
  if (what === "retry") boot();
  else if (what === "logs") shell.openPath(path.join(dataHome(), "logs"));
});

// ------------------------------------------------------------------ the program
if (!app.requestSingleInstanceLock()) {
  app.quit();                                    // a copy is already running: it brings its window up (second-instance below)
} else {
  app.setAppUserModelId("lk.ceylonbuildex.desktop");
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
  });
  Menu.setApplicationMenu(null);
  app.whenReady().then(() => {
    Object.assign(prefs, loadPrefs());
    session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === "clipboard-sanitized-write" || perm === "fullscreen"));
    createWindow();
    boot();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", e => {
    if (quitting) return;
    quitting = true;
    if (!child) return;
    e.preventDefault();
    stopBackend().finally(() => app.quit());
  });
}
