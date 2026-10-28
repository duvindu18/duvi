'use strict';
/* Everything the dashboard does to real folders: read them, create them, sort files into them, rename,
   move and recycle. Every move and rename is written to a journal first, so it can be undone. */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { shell } = require('electron');
const { writeJsonAtomic, nameProblem, under, toRel, freeName, niceError } = require('./util');

/* the six standard folders; must match FOLDER_TEMPLATES in the dashboard */
const TEMPLATES = [
  { id: '01', name: '01_Brief_and_Site_Data', label: 'Brief & Site Data' },
  { id: '02', name: '02_Schematics_and_3D', label: 'Schematics & 3D' },
  { id: '03', name: '03_Working_Drawings', label: 'Working Drawings' },
  { id: '04', name: '04_Schedules_BOQ', label: 'Schedules & BOQ' },
  { id: '05', name: '05_Financials_and_Contracts', label: 'Financials & Contracts' },
  { id: '06', name: '06_Site_Photos_and_Minutes', label: 'Site Photos & Minutes' }
];
const JUNK = /^(desktop\.ini|thumbs\.db|\.ds_store|\.tmp|.*\.tmp|.*\.crdownload|.*\.part|~\$.*|\..*|.*\.bak)$/i;
const SKIP_DIR = /^(\$recycle\.bin|system volume information|\.git|node_modules)$/i;

function templateOf(name) {
  const n = String(name || '').trim().toLowerCase();
  const t = TEMPLATES.find((f) => n === f.name.toLowerCase() || n === f.label.toLowerCase() || n === f.id + ' ' + f.label.toLowerCase());
  if (t) return t.id;
  const m = /^0([1-6])[\s_.\-]/.exec(n);
  return m ? '0' + m[1] : '';
}

async function statOrNull(p) { try { return await fsp.stat(p); } catch (e) { return null; } }
const isDirent = (d) => d.isDirectory() && !d.isSymbolicLink();

/* walk a folder, files only, depth first; stops at cap */
async function walk(dir, cap, onFile, rel) {
  rel = rel || '';
  let list;
  try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return false; }
  for (const d of list) {
    if (cap.left <= 0) return true;
    const r = rel ? rel + '/' + d.name : d.name;
    if (isDirent(d)) {
      if (SKIP_DIR.test(d.name)) continue;
      if (cap.dirs) { cap.left--; onFile({ rel: r, isDir: true, size: 0, mtimeMs: 0 }); }
      if (await walk(path.join(dir, d.name), cap, onFile, r)) return true;
    } else if (d.isFile()) {
      const st = await statOrNull(path.join(dir, d.name));
      cap.left--;
      onFile({ rel: r, isDir: false, size: st ? st.size : 0, mtimeMs: st ? st.mtimeMs : 0, name: d.name });
    }
  }
  return cap.left <= 0;
}

/* ----- reading ----- */
async function scanProject(dir) {
  const st = await statOrNull(dir);
  if (!st || !st.isDirectory()) return { exists: false, subs: {}, looseCount: 0, loose: [] };
  const subs = {};
  for (const t of TEMPLATES) {
    const sd = path.join(dir, t.name), sst = await statOrNull(sd);
    if (!sst || !sst.isDirectory()) { subs[t.id] = { exists: false, count: 0, files: [] }; continue; }
    const files = [];
    await walk(sd, { left: 20000 }, (f) => { if (!JUNK.test(f.name)) files.push(f); });
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    subs[t.id] = { exists: true, count: files.length, files: files.slice(0, 300).map((f) => ({ rel: f.rel, size: f.size, mtimeMs: f.mtimeMs })) };
  }
  /* loose: files in the project folder that are not inside one of the six */
  const loose = [];
  let top = [];
  try { top = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { top = []; }
  const names = TEMPLATES.map((t) => t.name.toLowerCase());
  for (const d of top) {
    if (names.indexOf(d.name.toLowerCase()) !== -1) continue;
    if (isDirent(d)) { if (!SKIP_DIR.test(d.name)) await walk(path.join(dir, d.name), { left: 5000 }, (f) => { if (!JUNK.test(f.name)) loose.push(d.name + '/' + f.rel); }); }
    else if (d.isFile() && !JUNK.test(d.name)) loose.push(d.name);
  }
  return { exists: true, subs: subs, looseCount: loose.length, loose: loose.slice(0, 200) };
}

async function scanDir(p) {
  const st = await statOrNull(p);
  if (!st || !st.isDirectory()) throw new Error('That folder is not there.');
  const cap = { left: 4000 };
  let files = 0;
  const capped = await walk(p, cap, (f) => { if (!JUNK.test(f.name)) files++; });
  let templates = [];
  try { templates = (await fsp.readdir(p, { withFileTypes: true })).filter(isDirent).map((d) => templateOf(d.name)).filter(Boolean); } catch (e) { templates = []; }
  return { path: p, name: path.basename(p), files: files, capped: !!capped, mtimeMs: st.mtimeMs, templates: Array.from(new Set(templates)) };
}

async function scanRoot(root) {
  const st = await statOrNull(root);
  if (!st || !st.isDirectory()) throw new Error('That folder is not there.');
  const list = (await fsp.readdir(root, { withFileTypes: true })).filter((d) => isDirent(d) && !SKIP_DIR.test(d.name) && !d.name.startsWith('.'));
  const rows = [];
  let i = 0;
  const worker = async () => { while (i < list.length) { const d = list[i++]; try { rows.push(await scanDir(path.join(root, d.name))); } catch (e) { /* unreadable folder: skip */ } } };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { rows: rows };
}

async function listTree(p, o) {
  const cap = { left: (o && o.cap) || 15000, dirs: true };
  const entries = [];
  const capped = await walk(p, cap, (f) => entries.push({ rel: f.rel, size: f.size, isDir: f.isDir }));
  return { entries: entries, capped: !!capped };
}

async function listDir(base, rel) {
  const dir = under(base, rel);
  let list;
  try { list = await fsp.readdir(dir, { withFileTypes: true }); }
  catch (e) { const x = new Error(niceError(e)); x.code = e.code; throw x; }
  const out = [];
  for (const d of list) {
    if (out.length >= 1500) break;
    if (JUNK.test(d.name)) continue;
    const full = path.join(dir, d.name), st = await statOrNull(full);
    if (!st) continue;
    if (st.isDirectory()) {
      let count = 0;
      try { count = (await fsp.readdir(full)).filter((n) => !JUNK.test(n)).length; } catch (e) { count = 0; }
      out.push({ name: d.name, dir: true, size: 0, mtimeMs: st.mtimeMs, count: count });
    } else out.push({ name: d.name, dir: false, size: st.size, mtimeMs: st.mtimeMs, count: 0 });
  }
  return { entries: out, capped: list.length > 1500 };
}

/* ----- journals: what was moved, so Undo can put it back ----- */
class Journals {
  constructor(dir) { this.dir = dir; fs.mkdirSync(dir, { recursive: true }); this.prune(); }
  file(id) { return path.join(this.dir, String(id).replace(/[^a-z0-9]/gi, '') + '.json'); }
  write(label, ops) {
    if (!ops.length) return '';
    const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    writeJsonAtomic(this.file(id), { id: id, label: label || '', at: Date.now(), undone: false, ops: ops });
    return id;
  }
  read(id) { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')); }
  mark(j) { writeJsonAtomic(this.file(j.id), j); }
  /* keep 90 days of history */
  prune() {
    try {
      const old = Date.now() - 90 * 864e5;
      fs.readdirSync(this.dir).forEach((n) => { const f = path.join(this.dir, n); try { if (fs.statSync(f).mtimeMs < old) fs.unlinkSync(f); } catch (e) { /* ignore */ } });
    } catch (e) { /* ignore */ }
  }
}

async function moveOne(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try { await fsp.rename(from, to); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    await fsp.rm(from, { recursive: true, force: true });
  }
}
/* folders emptied by a sort are removed, up to (not including) the project folder */
async function pruneEmpty(dirs, stopAt) {
  const stop = path.resolve(stopAt).toLowerCase();
  const sorted = Array.from(new Set(dirs)).sort((a, b) => b.length - a.length);
  for (let d of sorted) {
    while (d && path.resolve(d).toLowerCase() !== stop && path.resolve(d).toLowerCase().startsWith(stop)) {
      let left;
      try { left = (await fsp.readdir(d)).filter((n) => !/^(desktop\.ini|thumbs\.db|\.ds_store)$/i.test(n)); } catch (e) { break; }
      if (left.length) break;
      try { await fsp.rm(d, { recursive: true, force: true }); } catch (e) { break; }
      d = path.dirname(d);
    }
  }
}

function makeOps(J) {
  return {
    async mkdirs(dirs) {
      const out = [];
      for (const d of dirs || []) {
        const existed = fs.existsSync(d);
        try { await fsp.mkdir(d, { recursive: true }); out.push({ path: d, ok: true, existed: existed }); }
        catch (e) { out.push({ path: d, ok: false, existed: existed, error: niceError(e) }); }
      }
      return out;
    },
    async copyInto(dir, paths) {
      await fsp.mkdir(dir, { recursive: true });
      let copied = 0;
      const failed = [];
      for (const p of paths || []) {
        try {
          const to = freeName(path.join(dir, path.basename(p)));
          await fsp.cp(p, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
          copied++;
        } catch (e) { failed.push({ path: p, error: niceError(e) }); }
      }
      return { copied: copied, failed: failed };
    },
    async applyOps(base, ops, mode, label) {
      const done = [], failed = [], left = [];
      for (const o of ops || []) {
        try {
          const from = under(base, o.from);
          const to = freeName(under(base, o.to));
          if (mode === 'copy') { await fsp.mkdir(path.dirname(to), { recursive: true }); await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true }); }
          else { await moveOne(from, to); left.push(path.dirname(from)); }
          done.push({ kind: mode === 'copy' ? 'copy' : 'move', from: from, to: to });
        } catch (e) { failed.push({ from: o.from, error: niceError(e) }); }
      }
      if (mode !== 'copy') await pruneEmpty(left, base);
      const id = J.write(label, done);
      return { moved: done.length, failed: failed, id: id };
    },
    async renameItem(parent, rel, name) {
      const bad = nameProblem(name);
      if (bad) throw new Error(bad);
      const from = under(parent, rel), to = path.join(path.dirname(from), name);
      if (from === to) return { same: true, rel: toRel(parent, to), id: '' };
      if (!fs.existsSync(from)) throw new Error('It is not there any more.');
      const caseOnly = from.toLowerCase() === to.toLowerCase();
      if (!caseOnly && fs.existsSync(to)) throw new Error('Something called ' + name + ' is already there.');
      if (caseOnly) { const tmp = from + '.' + Date.now() + '.rn'; await fsp.rename(from, tmp); await fsp.rename(tmp, to); }
      else await fsp.rename(from, to).catch((e) => { throw new Error(niceError(e)); });
      const id = J.write('Rename ' + path.basename(from), [{ kind: 'move', from: from, to: to }]);
      return { same: false, rel: toRel(parent, to), id: id };
    },
    async makeDir(base, rel, name) {
      const bad = nameProblem(name);
      if (bad) throw new Error(bad);
      const d = path.join(under(base, rel), name);
      if (fs.existsSync(d)) throw new Error('A folder called ' + name + ' is already there.');
      await fsp.mkdir(d, { recursive: true });
      return { path: d };
    },
    async moveItems(base, rels, destRel, label) {
      const dest = under(base, destRel), done = [], failed = [];
      let skipped = 0;
      await fsp.mkdir(dest, { recursive: true });
      for (const r of rels || []) {
        try {
          const from = under(base, r);
          if (path.dirname(from).toLowerCase() === dest.toLowerCase()) { skipped++; continue; }
          if ((dest + path.sep).toLowerCase().startsWith((from + path.sep).toLowerCase())) throw new Error('A folder cannot go inside itself.');
          const to = freeName(path.join(dest, path.basename(from)));
          await moveOne(from, to);
          done.push({ kind: 'move', from: from, to: to });
        } catch (e) { failed.push({ path: r, error: e.code ? niceError(e) : e.message }); }
      }
      return { moved: done.length, failed: failed, skipped: skipped, id: J.write(label, done) };
    },
    async trashItems(base, rels) {
      let trashed = 0;
      const failed = [];
      for (const r of rels || []) {
        try { await shell.trashItem(under(base, r)); trashed++; } catch (e) { failed.push({ path: r, error: niceError(e) }); }
      }
      return { trashed: trashed, failed: failed };
    },
    async undo(id) {
      let j;
      try { j = J.read(id); } catch (e) { throw new Error('the record of that change is gone'); }
      if (j.undone) return { already: true, restored: 0, failed: [] };
      let restored = 0;
      const failed = [];
      for (const o of j.ops.slice().reverse()) {
        try {
          if (o.kind === 'copy') { if (fs.existsSync(o.to)) await shell.trashItem(o.to); restored++; continue; }
          if (!fs.existsSync(o.to)) throw new Error(path.basename(o.to) + ' is not where it was put.');
          const back = fs.existsSync(o.from) && o.from.toLowerCase() !== o.to.toLowerCase() ? freeName(o.from) : o.from;
          if (o.from.toLowerCase() === o.to.toLowerCase() && o.from !== o.to) { const tmp = o.to + '.' + Date.now() + '.rn'; await fsp.rename(o.to, tmp); await fsp.rename(tmp, back); }
          else await moveOne(o.to, back);
          restored++;
        } catch (e) { failed.push({ path: o.to, error: e.code ? niceError(e) : e.message }); }
      }
      j.undone = true;
      J.mark(j);
      return { already: false, restored: restored, failed: failed };
    }
  };
}

module.exports = { TEMPLATES, scanProject, scanDir, scanRoot, listTree, listDir, Journals, makeOps };
