'use strict';
/* Project status on the real folder icons in File Explorer. Each status has one .ico (drawn by folder-art.js in the
   page, sent here as PNG), and a project folder points at it through its desktop.ini, the standard Windows way to give
   a folder its own icon and tooltip. The tooltip also carries the status, which the dashboard reads back on import. */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { nativeImage } = require('electron');
const { icoFrom } = require('./branding');

const LABEL = { not_started: 'Not started', in_progress: 'In progress', on_hold: 'On hold', completed: 'Completed', cancelled: 'Cancelled' };
const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { windowsHide: true }, () => res()));

class FolderIcons {
  constructor(dir) { this.dir = path.join(dir, 'folder-icons'); }
  icoPath(status, version) { return path.join(this.dir, status + '-' + version + '.ico'); }
  ensureIco(status, version, pngDataUrl) {
    const f = this.icoPath(status, version);
    if (fs.existsSync(f)) return f;
    const m = /^data:image\/png;base64,(.+)$/.exec(String(pngDataUrl || ''));
    if (!m) throw new Error('No icon picture for ' + status + '.');
    let img = nativeImage.createFromBuffer(Buffer.from(m[1], 'base64'));
    if (img.isEmpty()) throw new Error('The icon picture could not be read.');
    if (img.getSize().width !== 256) img = img.resize({ width: 256, height: 256, quality: 'best' });
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(f, icoFrom(img));
    return f;
  }
  /* o: { dir, status, version, png, note } */
  async apply(o) {
    if (process.platform !== 'win32') return { ok: false, reason: 'Folder icons are a Windows feature.' };
    if (!o.dir || !fs.existsSync(o.dir) || !fs.statSync(o.dir).isDirectory()) return { ok: false, reason: 'The folder is not there yet.' };
    const label = LABEL[o.status];
    if (!label) throw new Error('Unknown status ' + o.status);
    const ico = this.ensureIco(o.status, o.version || 'v1', o.png);
    const ini = path.join(o.dir, 'desktop.ini');
    const text = '[.ShellClassInfo]\r\nIconResource=' + ico + ',0\r\nInfoTip=' + label + (o.note ? ' · ' + String(o.note).replace(/[\r\n]+/g, ' ') : '') + '\r\n[ViewState]\r\nMode=\r\nVid=\r\nFolderType=Generic\r\n';
    if (fs.existsSync(ini)) await run('attrib', ['-s', '-h', '-r', ini]);
    fs.writeFileSync(ini, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]));
    await run('attrib', ['+s', '+h', ini]);
    await run('attrib', ['+r', o.dir]);
    return { ok: true, label: label };
  }
  async clear(dir) {
    if (process.platform !== 'win32') return { ok: false };
    const ini = path.join(dir, 'desktop.ini');
    if (!fs.existsSync(ini)) return { ok: true };
    const txt = fs.readFileSync(ini);
    /* only remove a desktop.ini this app wrote */
    if (Buffer.from(txt).toString(txt[0] === 0xFF ? 'utf16le' : 'utf8').indexOf(this.dir) === -1) return { ok: false, reason: 'That folder has its own desktop.ini.' };
    await run('attrib', ['-s', '-h', '-r', ini]);
    fs.unlinkSync(ini);
    await run('attrib', ['-r', dir]);
    return { ok: true };
  }
}

module.exports = { FolderIcons, LABEL };
