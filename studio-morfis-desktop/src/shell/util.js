'use strict';
const fs = require('fs');
const path = require('path');

/* write to a temp file next to the target, then swap it in, so a crash never leaves half a file */
function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
function writeJsonAtomic(file, obj) { writeFileAtomic(file, JSON.stringify(obj, null, 2)); }

function ymd(d) {
  d = d || new Date();
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* Windows file names: no \ / : * ? " < > |, no control characters, no trailing dot or space, no reserved device names */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
function nameProblem(name) {
  const n = String(name || '');
  if (!n.trim()) return 'Type a name.';
  if (/[<>:"\/\\|?*\u0000-\u001F]/.test(n)) return 'A name cannot contain \\ / : * ? " < > |';
  if (/[. ]$/.test(n)) return 'A name cannot end with a dot or a space.';
  if (RESERVED.test(n)) return 'Windows keeps that name for itself. Choose another.';
  if (n.length > 150) return 'That name is too long.';
  return '';
}

/* "a/b/c" from the page -> a native path under base, refusing anything that climbs out of base */
function under(base, rel) {
  const b = path.resolve(String(base || ''));
  const out = path.resolve(b, String(rel || '').replace(/[\\/]+/g, path.sep));
  const rb = b.endsWith(path.sep) ? b : b + path.sep;
  if (out !== b && !out.toLowerCase().startsWith(rb.toLowerCase())) throw new Error('That path is outside the project folder.');
  return out;
}
const toRel = (base, p) => path.relative(base, p).split(path.sep).join('/');

/* "Plan.pdf" taken -> "Plan (2).pdf" */
function freeName(file) {
  if (!fs.existsSync(file)) return file;
  const dir = path.dirname(file), ext = path.extname(file), stem = path.basename(file, ext);
  for (let i = 2; i < 1000; i++) {
    const t = path.join(dir, stem + ' (' + i + ')' + ext);
    if (!fs.existsSync(t)) return t;
  }
  throw new Error('Too many files called ' + path.basename(file) + '.');
}

/* readable messages for the errors Windows gives most often */
function niceError(e) {
  const c = e && e.code;
  if (c === 'ENOENT') return 'It is not there any more.';
  if (c === 'EEXIST') return 'Something with that name is already there.';
  if (c === 'EACCES' || c === 'EPERM') return 'Windows did not allow it. The file may be open in another program, or the folder is protected.';
  if (c === 'EBUSY') return 'The file is open in another program. Close it and try again.';
  if (c === 'ENOSPC') return 'The disk is full.';
  if (c === 'ENAMETOOLONG') return 'The path is too long for Windows.';
  if (c === 'EXDEV') return 'That move crosses drives.';
  return (e && e.message) || 'Unknown error';
}

module.exports = { writeFileAtomic, writeJsonAtomic, ymd, nameProblem, under, toRel, freeName, niceError };
