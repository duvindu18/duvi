'use strict';
/* The program's own name and icon, everywhere Windows shows them:
   the window and taskbar button (live), the Start menu and desktop shortcuts, a pinned taskbar shortcut,
   and the entry in Settings > Apps (installed builds only). */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { app, nativeImage, shell } = require('electron');

const DEFAULT_NAME = 'Studio Morfis';
const APP_ID = 'com.studiomorfis.desktop';

/* PNG data URL -> bytes, or null */
function pngBytes(dataUrl) {
  const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  let img = nativeImage.createFromBuffer(Buffer.from(m[2], 'base64'));
  if (img.isEmpty()) return null;
  const s = img.getSize();
  if (s.width !== 256 || s.height !== 256) img = img.resize({ width: 256, height: 256, quality: 'best' });
  return img;
}

/* An .ico holding PNG images at several sizes (Windows Vista and later read PNG inside .ico). */
function icoFrom(img) {
  const sizes = [256, 64, 48, 32, 24, 16];
  const pngs = sizes.map((s) => (s === 256 ? img : img.resize({ width: s, height: s, quality: 'best' })).toPNG());
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let off = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + i * 16;
    head.writeUInt8(s >= 256 ? 0 : s, e); head.writeUInt8(s >= 256 ? 0 : s, e + 1);
    head.writeUInt8(0, e + 2); head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(pngs[i].length, e + 8); head.writeUInt32LE(off, e + 12);
    off += pngs[i].length;
  });
  return Buffer.concat([head].concat(pngs));
}

const safeName = (s) => String(s || '').replace(/[<>:"\/\\|?*\u0000-\u001F]/g, '').replace(/[. ]+$/, '').trim().slice(0, 60) || DEFAULT_NAME;

class Branding {
  constructor(prefs, dir, defaultIconPng) {
    this.prefs = prefs;
    this.dir = path.join(dir, 'branding');
    this.defaultIconPng = defaultIconPng;
  }
  name() { return String((this.prefs.get('branding') || {}).name || '').trim() || DEFAULT_NAME; }
  iconPng() {
    const f = (this.prefs.get('branding') || {}).iconFile;
    return f && fs.existsSync(path.join(this.dir, f + '.png')) ? path.join(this.dir, f + '.png') : this.defaultIconPng;
  }
  iconIco() {
    const f = (this.prefs.get('branding') || {}).iconFile;
    if (f && fs.existsSync(path.join(this.dir, f + '.ico'))) return path.join(this.dir, f + '.ico');
    return app.isPackaged ? process.execPath : path.join(path.dirname(this.defaultIconPng), 'icon.ico');
  }
  image() { return nativeImage.createFromPath(this.iconPng()); }

  /* from the page: { name: '' for the original, icon: data URL or '' } -> true when something changed */
  set(o) {
    const cur = Object.assign({ name: '', iconFile: '' }, this.prefs.get('branding'));
    const next = { name: String((o && o.name) || '').trim().slice(0, 40), iconFile: cur.iconFile };
    const img = o && o.icon ? pngBytes(o.icon) : null;
    if (img) {
      const png = img.toPNG();
      const tag = require('crypto').createHash('sha1').update(png).digest('hex').slice(0, 12);
      if (tag !== cur.iconFile) {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(path.join(this.dir, tag + '.png'), png);
        fs.writeFileSync(path.join(this.dir, tag + '.ico'), icoFrom(img));
        next.iconFile = tag;
      }
    } else next.iconFile = '';
    if (next.name === cur.name && next.iconFile === cur.iconFile) return false;
    this.prefs.set('branding', next);
    /* drop icon files no longer in use (shortcuts are rewritten right after this) */
    try { fs.readdirSync(this.dir).forEach((n) => { if (!n.startsWith(next.iconFile + '.') || !next.iconFile) fs.unlinkSync(path.join(this.dir, n)); }); } catch (e) { /* ignore */ }
    return true;
  }

  /* ----- Windows integration ----- */
  shortcutDirs() {
    const ad = app.getPath('appData'), out = [
      path.join(ad, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      app.getPath('desktop'),
      path.join(ad, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
      path.join(ad, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'StartMenu')
    ];
    if (process.env.ProgramData) out.push(path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
    if (process.env.PUBLIC) out.push(path.join(process.env.PUBLIC, 'Desktop'));
    return out;
  }
  findShortcuts() {
    const exe = process.execPath.toLowerCase(), found = [];
    const look = (dir, depth) => {
      let list = [];
      try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      list.forEach((d) => {
        const p = path.join(dir, d.name);
        if (d.isDirectory() && depth > 0) look(p, depth - 1);
        else if (/\.lnk$/i.test(d.name)) {
          try { const l = shell.readShortcutLink(p); if (String(l.target || '').toLowerCase() === exe) found.push({ path: p, link: l }); } catch (e) { /* not readable */ }
        }
      });
    };
    this.shortcutDirs().forEach((d) => look(d, 1));
    return found;
  }
  /* rename and re-icon every shortcut that starts this program; pinned ones keep their file name so the pin stays */
  updateShortcuts() {
    if (process.platform !== 'win32') return { updated: 0 };
    const name = safeName(this.name()), icon = this.iconIco();
    let updated = 0;
    this.findShortcuts().forEach((s) => {
      const pinned = /User Pinned/i.test(s.path);
      const target = pinned ? s.path : path.join(path.dirname(s.path), name + '.lnk');
      const opts = { target: process.execPath, cwd: s.link.cwd || path.dirname(process.execPath), args: s.link.args || '', description: name, icon: icon, iconIndex: 0, appUserModelId: APP_ID };
      try {
        if (target.toLowerCase() !== s.path.toLowerCase() && fs.existsSync(target)) return;
        if (shell.writeShortcutLink(target, fs.existsSync(target) ? 'replace' : 'create', opts)) {
          if (target.toLowerCase() !== s.path.toLowerCase()) fs.unlinkSync(s.path);
          updated++;
        }
      } catch (e) { /* a shortcut in a protected folder stays as it is */ }
    });
    this.updateAppsEntry(name, icon);
    /* ask Explorer to drop its cached icons so the new ones show straight away */
    try { execFile('ie4uinit.exe', ['-show'], { windowsHide: true }, () => {}); } catch (e) { /* older Windows */ }
    return { updated: updated };
  }
  /* Settings > Apps lists the name and icon from the uninstall key the installer wrote (per-user install) */
  updateAppsEntry(name, icon) {
    if (!app.isPackaged) return;
    const root = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
    const dir = path.dirname(process.execPath).toLowerCase();
    execFile('reg.exe', ['query', root, '/s', '/v', 'InstallLocation'], { windowsHide: true, maxBuffer: 8 << 20 }, (err, out) => {
      if (err || !out) return;
      let key = '';
      String(out).split(/\r?\n/).forEach((ln) => {
        if (/^HKEY_/i.test(ln.trim())) key = ln.trim();
        else if (/InstallLocation\s+REG_\w+\s+(.+)$/i.test(ln) && key) {
          const loc = /InstallLocation\s+REG_\w+\s+(.+)$/i.exec(ln)[1].trim().replace(/[\\/]+$/, '').toLowerCase();
          if (loc === dir) {
            execFile('reg.exe', ['add', key, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', name, '/f'], { windowsHide: true }, () => {});
            execFile('reg.exe', ['add', key, '/v', 'DisplayIcon', '/t', 'REG_SZ', '/d', icon + ',0', '/f'], { windowsHide: true }, () => {});
          }
        }
      });
    });
  }
}

module.exports = { Branding, DEFAULT_NAME, APP_ID, icoFrom };
