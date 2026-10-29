'use strict';
/* Desktop-only preferences: window, splash, tray, controls, fonts, backups.
   Studio data (projects, settings) lives in store.js; this file holds how the program itself behaves. */
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./util');

const DEFAULTS = {
  branding: { name: '', iconFile: '' },
  window: { bounds: null, maximized: false },
  rememberWindow: true,
  splash: true,
  controls: 'windows',         // windows | pill | mac
  titleBar: 'name',            // name | none
  closeToTray: false,
  startMinimized: false,
  launchAtLogin: false,
  alwaysOnTop: false,
  hwAccel: true,
  spellcheck: true,
  globalHotkey: false,
  confirmQuit: false,
  font: 'inter',               // inter | segoe | technical | system | studio
  density: 'comfortable',      // comfortable | compact
  sideCollapsed: false,
  folderIcons: true,           // show project status on the Windows folder icons
  aiEnabled: true,
  aiEndpoint: 'http://127.0.0.1:11434',
  aiModel: 'qwen2.5:3b',
  reduceMotion: false,
  pattern: false,
  glow: true,
  roundCorners: true,
  backupKeep: 14,
  devTools: false,
  zoom: 1,
  theme: 'dark',
  accent: '#7C6CF0'
};

const CHOICES = {
  controls: ['windows', 'pill', 'mac'],
  density: ['comfortable', 'compact'],
  titleBar: ['name', 'none'],
  font: ['inter', 'segoe', 'technical', 'system', 'studio'],
  backupKeep: [3, 7, 14, 30, 90]
};

class Prefs {
  constructor(dir) {
    this.file = path.join(dir, 'desktop.json');
    this.data = JSON.parse(JSON.stringify(DEFAULTS));
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      Object.keys(DEFAULTS).forEach((k) => {
        if (raw[k] === undefined) return;
        if (DEFAULTS[k] && typeof DEFAULTS[k] === 'object') this.data[k] = Object.assign({}, DEFAULTS[k], raw[k]);
        else this.data[k] = raw[k];
      });
    } catch (e) { /* first start, or an unreadable file: defaults */ }
    this.clean();
  }
  clean() {
    const d = this.data;
    /* names used by the first version */
    if (d.controls === 'fluent') d.controls = 'pill';
    if (d.controls === 'classic') d.controls = 'windows';
    if (d.font === 'default') d.font = 'inter';
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(String(d.aiEndpoint || ''))) d.aiEndpoint = DEFAULTS.aiEndpoint;
    d.aiModel = String(d.aiModel || DEFAULTS.aiModel).trim().slice(0, 80) || DEFAULTS.aiModel;
    Object.keys(CHOICES).forEach((k) => { if (CHOICES[k].indexOf(d[k]) === -1) d[k] = DEFAULTS[k]; });
    d.zoom = Math.min(1.5, Math.max(0.75, +d.zoom || 1));
    if (!/^#[0-9A-Fa-f]{6}$/.test(d.accent || '')) d.accent = DEFAULTS.accent;
    if (['dark', 'light', 'system'].indexOf(d.theme) === -1) d.theme = 'dark';
  }
  get(k) { return this.data[k]; }
  set(k, v) {
    if (!(k in DEFAULTS)) throw new Error('Unknown setting: ' + k);
    if (typeof DEFAULTS[k] === 'boolean') v = !!v;
    else if (typeof DEFAULTS[k] === 'number') v = +v;
    this.data[k] = v;
    this.clean();
    this.save();
    return this.data[k];
  }
  patch(o) { Object.assign(this.data, o); this.clean(); this.save(); }
  reset() {
    const keep = { branding: this.data.branding, window: this.data.window, theme: this.data.theme, accent: this.data.accent, zoom: this.data.zoom };
    this.data = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), keep);
    this.save();
  }
  save() { try { writeJsonAtomic(this.file, this.data); } catch (e) { /* not fatal: the app keeps running with what it has */ } }
  /* what the page's settings card may read and change */
  public() {
    const d = this.data, out = {};
    Object.keys(DEFAULTS).forEach((k) => { if (k !== 'window' && k !== 'branding') out[k] = d[k]; });
    out.choices = CHOICES;
    return out;
  }
}

module.exports = { Prefs, DEFAULTS, CHOICES };
