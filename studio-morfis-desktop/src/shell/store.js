'use strict';
/* Studio data on this computer: one JSON file per project plus the studio settings, and a dated backup every day. */
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic, ymd } = require('./util');

const safeId = (id) => String(id || '').replace(/[^A-Za-z0-9_\-.~@+]/g, '_').slice(0, 120);

class Store {
  constructor(root) {
    this.root = root;
    this.projDir = path.join(root, 'projects');
    this.settingsFile = path.join(root, 'settings.json');
    this.backupDir = path.join(path.dirname(root), 'backups');
    fs.mkdirSync(this.projDir, { recursive: true });
  }
  load() {
    const projects = {};
    let names = [];
    try { names = fs.readdirSync(this.projDir).filter((n) => n.endsWith('.json')); } catch (e) { names = []; }
    names.forEach((n) => {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(this.projDir, n), 'utf8'));
        if (p && p.id) projects[p.id] = p;
      } catch (e) {
        /* keep a damaged file aside rather than losing it silently */
        try { fs.renameSync(path.join(this.projDir, n), path.join(this.projDir, n + '.damaged')); } catch (x) { /* ignore */ }
      }
    });
    let settings = null;
    try { settings = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')); } catch (e) { settings = null; }
    return { projects: projects, settings: settings, firstRun: !settings && !Object.keys(projects).length };
  }
  set(kind, id, value) {
    if (kind === 's') {
      if (value === null) { try { fs.unlinkSync(this.settingsFile); } catch (e) { /* gone already */ } return; }
      writeJsonAtomic(this.settingsFile, value);
      return;
    }
    const file = path.join(this.projDir, safeId(id) + '.json');
    if (value === null) { try { fs.unlinkSync(file); } catch (e) { /* gone already */ } return; }
    writeJsonAtomic(file, value);
  }
  /* one backup per day, the oldest dropped beyond `keep` */
  backup(keep) {
    try {
      const file = path.join(this.backupDir, 'studio-morfis-backup-' + ymd() + '.json');
      if (fs.existsSync(file)) return;
      const d = this.load();
      if (d.firstRun) return;
      writeJsonAtomic(file, { exported: ymd(), settings: d.settings, projects: d.projects });
      const all = fs.readdirSync(this.backupDir).filter((n) => /^studio-morfis-backup-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
      all.slice(0, Math.max(0, all.length - Math.max(1, keep || 14))).forEach((n) => { try { fs.unlinkSync(path.join(this.backupDir, n)); } catch (e) { /* ignore */ } });
    } catch (e) { /* a missed backup is retried next start */ }
  }
}

module.exports = { Store };
