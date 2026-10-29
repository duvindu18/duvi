'use strict';
/* The app's folder icons on the real folders in File Explorer. Each icon (a project status, or one of the six
   standard folders) is drawn by folder-art.js in the page, sent here as a PNG and kept once as an .ico. A folder points
   at its icon through desktop.ini, the standard Windows way to give a folder its own icon and tooltip; the tooltip of a
   project folder starts with its status, which the dashboard reads back on import. Explorer is told straight away. */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { nativeImage } = require('electron');
const { icoFrom } = require('./branding');

const LABEL = { not_started: 'Not started', in_progress: 'In progress', on_hold: 'On hold', completed: 'Completed', cancelled: 'Cancelled' };
const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { windowsHide: true, timeout: 30000 }, () => res()));

class FolderIcons {
  constructor(dir) { this.dir = path.join(dir, 'folder-icons'); }
  icoPath(key, version) { return path.join(this.dir, String(key).replace(/[^a-z0-9_-]/gi, '') + '-' + version + '.ico'); }
  ensureIco(key, version, pngDataUrl) {
    const f = this.icoPath(key, version);
    if (fs.existsSync(f)) return f;
    const m = /^data:image\/png;base64,(.+)$/.exec(String(pngDataUrl || ''));
    if (!m) throw new Error('No icon picture for ' + key + '.');
    let img = nativeImage.createFromBuffer(Buffer.from(m[1], 'base64'));
    if (img.isEmpty()) throw new Error('The icon picture could not be read.');
    if (img.getSize().width !== 256) img = img.resize({ width: 256, height: 256, quality: 'best' });
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(f, icoFrom(img));
    return f;
  }
  /* o: { dir, key, version, png, tip }; the first version passed { status, note } */
  async apply(o) {
    if (process.platform !== 'win32') return { ok: false, reason: 'Folder icons are a Windows feature.' };
    if (!o.dir || !fs.existsSync(o.dir) || !fs.statSync(o.dir).isDirectory()) return { ok: false, reason: 'The folder is not there yet.' };
    const key = o.key || (LABEL[o.status] ? 'st-' + o.status : '');
    if (!key) throw new Error('No icon was named.');
    const tip = o.tip || ((LABEL[o.status] || '') + (o.note ? ' · ' + o.note : ''));
    const ico = this.ensureIco(key, o.version || 'v1', o.png);
    const ini = path.join(o.dir, 'desktop.ini');
    const text = '[.ShellClassInfo]\r\nIconResource=' + ico + ',0\r\n' + (tip ? 'InfoTip=' + String(tip).replace(/[\r\n]+/g, ' ') + '\r\n' : '') + '[ViewState]\r\nMode=\r\nVid=\r\nFolderType=Generic\r\n';
    if (fs.existsSync(ini)) {
      const old = readIni(ini);
      if (old.indexOf(this.dir) === -1 && /IconResource|IconFile/i.test(old)) return { ok: false, reason: 'That folder already has its own icon.' };
      await run('attrib', ['-s', '-h', '-r', ini]);
    }
    fs.writeFileSync(ini, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]));
    await run('attrib', ['+s', '+h', ini]);
    await run('attrib', ['+r', o.dir]);
    return { ok: true };
  }
  async clear(dir) {
    if (process.platform !== 'win32') return { ok: false };
    const ini = path.join(dir, 'desktop.ini');
    if (!fs.existsSync(ini)) return { ok: true };
    /* only remove a desktop.ini this app wrote */
    if (readIni(ini).indexOf(this.dir) === -1) return { ok: false, reason: 'That folder has its own desktop.ini.' };
    await run('attrib', ['-s', '-h', '-r', ini]);
    fs.unlinkSync(ini);
    await run('attrib', ['-r', dir]);
    return { ok: true };
  }
  /* tell File Explorer these folders changed, so open windows show the new icons without pressing F5 */
  async refresh(dirs) {
    if (process.platform !== 'win32' || !dirs || !dirs.length) return { ok: false };
    const all = Array.from(new Set(dirs.concat(dirs.map((d) => path.dirname(d)))));
    for (let i = 0; i < all.length; i += 40) {
      const list = all.slice(i, i + 40).map((d) => "'" + String(d).replace(/'/g, "''") + "'").join(',');
      const ps = 'Add-Type -Namespace Morfis -Name Shell -MemberDefinition \'[DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern void SHChangeNotify(int e, uint f, string a, System.IntPtr b);\';' +
        'foreach ($d in @(' + list + ')) { [Morfis.Shell]::SHChangeNotify(0x00002000, 0x0005, $d, [IntPtr]::Zero); [Morfis.Shell]::SHChangeNotify(0x00001000, 0x0005, $d, [IntPtr]::Zero) }';
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')]);
    }
    return { ok: true };
  }
}
function readIni(file) {
  const b = fs.readFileSync(file);
  return b[0] === 0xFF && b[1] === 0xFE ? b.slice(2).toString('utf16le') : b.toString('utf8');
}

module.exports = { FolderIcons, LABEL };
