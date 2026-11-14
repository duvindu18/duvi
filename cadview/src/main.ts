import * as THREE from 'three';
import { Capacitor } from '@capacitor/core';
import { Viewer, type Pick } from './render/viewer';
import { build2D, buildMeshes, loadMainThread, MODEL_EXT, WORKER_MESH, type Scene2D, type Scene3D } from './render/scene';
import { textUniforms } from './render/text';
import type { Drawing } from './cad/dxf';
import type { SnapGrid } from './cad/snapgrid';
import * as lib from './library';
import { hydrateIcons, icon, type IconName } from './ui/icons';
import { $, esc, toast, openSheet, closeSheet, sheetOpen, wireSheetDrag, popover, hidePopover, loading, haptic, fmtBytes, fmtAgo, consumeSkipPop } from './ui/widgets';

hydrateIcons();
wireSheetDrag();
const root = document.documentElement;
const uid = () => Math.random().toString(36).slice(2, 10);
const store = {
  get: (k: string) => { try { return localStorage.getItem(`cadview.${k}`); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(`cadview.${k}`, v); } catch { /* private mode */ } },
};

// ---------------- theme ----------------
const cssColor = (name: string) => new THREE.Color(getComputedStyle(root).getPropertyValue(name).trim() || '#000').getHex();
const fgColor = () => { const bg = new THREE.Color(cssColor('--canvas')); return bg.getHSL({ h: 0, s: 0, l: 0 }).l > 0.5 ? 0x111111 : 0xf2f3f5; };
let site = store.get('site') === '1';
root.classList.toggle('site', site);

const viewer = new Viewer($('#canvasHost'), $('#labels'), $('#loupe') as HTMLCanvasElement);
function applyTheme() {
  viewer.setBackground(cssColor('--canvas'));
  const light = isLightCanvas();
  textUniforms.uFg.value.setHex(fgColor());
  textUniforms.uDarken.value = light ? 1 : 0;
  for (const s of [doc?.s2, compare?.scene]) {
    if (!s) continue;
    for (const m of s.fgMaterials) m.color.setHex(fgColor());
    for (const m of s.materials) if (m.userData.orig !== undefined && m.userData.orig >= 0) m.color.setHex(adaptColor(m.userData.orig, light));
  }
  viewer.requestRender();
}
const isLightCanvas = () => new THREE.Color(cssColor('--canvas')).getHSL({ h: 0, s: 0, l: 0 }).l > 0.5;
/** CAD palettes assume a dark screen: on a light background, darken pale colours (yellow, cyan…) so they stay readable. */
function adaptColor(c: number, light: boolean) {
  if (!light) return c;
  const col = new THREE.Color(c), hsl = { h: 0, s: 0, l: 0 };
  col.getHSL(hsl);
  const lum = 0.299 * col.r + 0.587 * col.g + 0.114 * col.b;
  if (lum > 0.45) col.setHSL(hsl.h, Math.min(1, hsl.s * 1.05), Math.min(hsl.l, 0.32));
  return col.getHex();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ---------------- background worker ----------------
class Jobs {
  private w!: Worker;
  private seq = 0;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void; progress?: (stage: string, f: number) => void }>();
  constructor() { this.spawn(); }
  private spawn() {
    this.w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.w.onmessage = (e) => {
      const m = e.data, p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') return p.progress?.(m.stage, m.f);
      this.pending.delete(m.id);
      if (m.type === 'error') p.rej(new Error(m.error)); else p.res(m);
    };
    this.w.onerror = (e) => { for (const p of this.pending.values()) p.rej(new Error(e.message || 'The file could not be processed (out of memory?)')); this.pending.clear(); this.restart(); };
  }
  run(msg: any, transfer: Transferable[], progress?: (stage: string, f: number) => void): Promise<any> {
    const id = ++this.seq;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej, progress }); this.w.postMessage({ ...msg, id }, transfer); });
  }
  restart() { this.w.terminate(); for (const p of this.pending.values()) p.rej(new Error('cancelled')); this.pending.clear(); this.spawn(); }
}
const jobs = new Jobs();

// ---------------- state ----------------
interface Doc {
  id: string; name: string; ext: string; size: number; mode: '2d' | '3d'; units: string; origin: [number, number, number];
  meta: lib.FileMeta; drawing?: Drawing; s2?: Scene2D; s3?: Scene3D; grid: SnapGrid; stats: string[]; ms: number;
}
let doc: Doc | null = null;
type Tool = 'none' | 'measure' | 'area' | 'note';
let tool: Tool = 'none';
let draft: THREE.Vector3[] = [];
let compare: { name: string; scene: Scene2D; grid: SnapGrid; added: number; removed: number; same: number } | null = null;
let rotLock = store.get('rotlock') === '1';
viewer.controls.rotate2D = !rotLock;

const units = () => doc?.meta.units ?? doc?.units ?? 'units';

// ---------------- formatting ----------------
function fmtLen(v: number, u = units()): string {
  const a = Math.abs(v);
  if (u === 'ft' || u === 'in') { // feet-inches to 1/16"
    const inches = u === 'ft' ? a * 12 : a;
    let ft = Math.floor(inches / 12), s16 = Math.round((inches - ft * 12) * 16);
    if (s16 === 192) { ft++; s16 = 0; }
    const whole = Math.floor(s16 / 16);
    let num = s16 % 16, den = 16;
    while (num && num % 2 === 0) { num /= 2; den /= 2; }
    const frac = num ? ` ${num}/${den}` : '';
    return ft ? `${ft}'-${whole}${frac}"` : `${whole}${frac}"`;
  }
  const d = u === 'mm' ? (a < 10 ? 1 : 0) : u === 'cm' ? 1 : u === 'm' ? (a < 10 ? 3 : 2) : a >= 1000 ? 1 : a >= 1 ? 3 : 4;
  return `${v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: u === 'm' ? Math.min(d, 2) : 0 })}${u === 'units' ? '' : ` ${u}`}`;
}
function fmtArea(a: number, u = units()): string {
  const f = (x: number, d = 2) => x.toLocaleString(undefined, { maximumFractionDigits: d });
  switch (u) {
    case 'mm': return `${f(a / 1e6, 3)} m²`;
    case 'cm': return `${f(a / 1e4, 3)} m²`;
    case 'm': return `${f(a)} m²`;
    case 'in': return `${f(a / 144)} ft²`;
    case 'ft': return `${f(a)} ft²`;
    case 'units': return `${f(a, 3)} units²`;
    default: return `${f(a, 3)} ${u}²`;
  }
}

// ---------------- navigation ----------------
function show(screen: 'home' | 'viewer') {
  $('#home').classList.toggle('active', screen === 'home');
  $('#viewer').classList.toggle('active', screen === 'viewer');
  if (screen === 'viewer') { measurePadding(); viewer.resize(); }
}
addEventListener('popstate', () => {
  hidePopover();
  if (consumeSkipPop()) return;
  if (sheetOpen()) { closeSheet(true); return; }
  if ($('#viewer').classList.contains('active')) leaveViewer();
});
addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (sheetOpen()) closeSheet(); else if (tool !== 'none') setTool('none'); } });
$('#btnBack').onclick = () => history.back();
function leaveViewer() {
  saveView();
  setTool('none');
  show('home');
  renderLibrary();
}

function measurePadding() {
  const r = $('#stage').getBoundingClientRect();
  const tb = $('#topbar').getBoundingClientRect(), dk = $('#dock').getBoundingClientRect();
  const landscape = dk.height > dk.width;
  viewer.padding = landscape
    ? { top: tb.bottom - r.top + 8, right: r.right - dk.left + 8, bottom: 16, left: 16 }
    : { top: tb.bottom - r.top + 8, right: 12, bottom: r.bottom - dk.top + 12, left: 12 };
}
addEventListener('resize', () => requestAnimationFrame(measurePadding));

// ---------------- opening files ----------------
$('#btnOpen').onclick = () => $('#fileInput').click();
($('#fileInput') as HTMLInputElement).onchange = async (e) => {
  const input = e.target as HTMLInputElement, f = input.files?.[0];
  input.value = '';
  if (f) openBytes(f.name, await f.arrayBuffer());
};
document.querySelectorAll<HTMLElement>('[data-sample]').forEach((b) => (b.onclick = async () => {
  const s = b.dataset.sample!;
  const get = async (n: string) => (await fetch(`samples/${n}`)).arrayBuffer();
  if (s === 'compare') {
    await openBytes('floorplan-rev-A.dxf', await get('floorplan-rev-A.dxf'));
    await runCompare('floorplan-rev-B.dxf', await get('floorplan-rev-B.dxf'));
  } else openBytes(s, await get(s));
}));

async function openBytes(name: string, data: ArrayBuffer, fromLibrary = false) {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  if (ext === 'dwg') return explainDwg();
  if (ext === 'skp') return explainSkp();
  if (ext !== 'dxf' && !MODEL_EXT.includes(ext)) return toast(`.${ext} files aren't supported yet`);
  const id = lib.fileId(name, data), size = data.byteLength;
  // copy for the on-device library before the buffer is handed (zero-copy) to the worker
  const blob = fromLibrary ? null : new Blob([data]);
  let cancelled = false;
  loading.show(name, () => { cancelled = true; jobs.restart(); });
  const t0 = performance.now();
  try {
    const meta = await lib.getMeta(id);
    let next: Doc;
    if (ext === 'dxf') {
      const r = await jobs.run({ type: 'dxf', buf: data }, [data], loading.progress);
      const d: Drawing = r.drawing;
      loading.progress('Building view', 1);
      await new Promise((res) => setTimeout(res, 0));
      const s2 = build2D(d, fgColor(), viewer.maxTexture);
      const segs = d.buckets.reduce((s, b) => s + b.length / 6, 0), tiles = d.tiles?.length ?? 0;
      next = {
        id, name, ext, size, mode: '2d', units: d.units, origin: d.origin, meta, drawing: d, s2, grid: r.grid, ms: 0,
        stats: [`${d.entities.toLocaleString()} entities`, `${Math.round(segs).toLocaleString()} line segments`, `${d.text.values.length.toLocaleString()} text labels`, `${d.layers.length} layers`, `${tiles} display tiles`],
      };
      const skipped = Object.entries(d.skipped).sort((a, b) => b[1] - a[1]);
      if (skipped.length) next.stats.push(`Not drawn yet: ${skipped.map(([k, v]) => `${v.toLocaleString()} ${k}`).join(', ')}`);
    } else {
      let s3: Scene3D;
      if (WORKER_MESH.includes(ext)) {
        const r = await jobs.run({ type: 'mesh', ext, buf: data }, [data], loading.progress);
        s3 = buildMeshes(r.meshes, r.grid, r.tris);
      } else {
        s3 = await loadMainThread(ext, data, viewer.renderer, loading.progress);
        s3.root.addEventListener('edges' as any, () => viewer.requestRender());
      }
      next = {
        id, name, ext, size, mode: '3d', units: ext === 'glb' || ext === 'gltf' ? 'm' : 'units', origin: [0, 0, 0], meta, s3, grid: s3.grid, ms: 0,
        stats: [`${Math.round(s3.tris).toLocaleString()} triangles`, `${s3.parts.length} parts`],
      };
    }
    if (cancelled) return;
    if (compare) exitCompare(false);
    if (doc && $('#viewer').classList.contains('active')) saveView();
    doc = next;
    doc.ms = performance.now() - t0;
    // the viewer must be laid out before fitting, or the camera is framed for a 0×0 canvas
    if (!$('#viewer').classList.contains('active')) { history.pushState({ viewer: true }, ''); show('viewer'); }
    measurePadding();
    viewer.resize();
    mount();
    loading.hide();
    restoreView();
    if (blob) await lib.saveFile({ id, name, size, opened: Date.now() }, blob);
    else lib.touch(id, { opened: Date.now() });
    setTimeout(() => saveThumb(id), 700);
    maybeCoach();
  } catch (err: any) {
    loading.hide();
    if (cancelled || err?.message === 'cancelled') return;
    toast(`Couldn't open ${name}: ${err?.message ?? err}`, 6000);
  }
}

/** Put the current doc on screen. */
function mount() {
  const d = doc!;
  if (d.mode === '2d') {
    viewer.setContent(d.s2!.root, '2d', { bounds: d.s2!.bounds });
    viewer.lod = d.s2!.lod;
    viewer.snap = { grid: d.grid, accept: (layer) => d.s2!.layers[layer]?.visible !== false };
  } else {
    viewer.setContent(d.s3!.root, '3d');
    viewer.lod = [];
    viewer.snap = { grid: d.grid, accept: (part) => d.s3!.parts[part]?.visible !== false };
    viewer.prepareRaycast();
  }
  applyTheme();
  $('#title').textContent = d.name;
  $('#subtitle').textContent = `${d.ext.toUpperCase()} · ${fmtBytes(d.size)} · ${units() === 'units' ? 'no units' : units()}`;
  $('#legend').hidden = true;
  buildDock();
  setTool('none');
  restoreAnnotations();
}

function explainDwg() {
  openSheet('DWG files', `<p>DWG is AutoCAD's closed format. To read it with no internet connection the app needs a DWG decoder. The free one (LibreDWG) would make this whole app GPL, and the commercial one (ODA) is a paid licence.</p>
    <p class="muted">For now, save the drawing as <b>DXF</b> in AutoCAD, BricsCAD or DraftSight (or with the free ODA File Converter) and open the .dxf here.</p>`);
}
function explainSkp() {
  openSheet('SketchUp files', `<p>SketchUp's official file reader only runs on desktop computers, so .skp files can't be opened on a phone yet.</p>
    <p class="muted">In SketchUp, use <b>File → Export → 3D Model</b> and choose <b>.dae</b> (keeps groups and materials), <b>.glb</b>, <b>.obj</b> or <b>.stl</b>. Then open the exported file here.</p>`);
}

// ---------------- library ----------------
async function renderLibrary() {
  const files = await lib.listFiles();
  const ul = $('#recent');
  $('#empty').hidden = files.length > 0;
  ul.innerHTML = files.map((f) => {
    const ext = f.name.split('.').pop()!.toUpperCase();
    const thumb = f.thumb ? `style="background-image:url(${f.thumb})"` : '';
    return `<li class="card"><div class="thumb" ${thumb}>${f.thumb ? '' : icon(ext === 'DXF' ? 'shapes' : 'cube', 26)}</div>
      <div class="meta"><div class="name">${esc(f.name)}</div><div class="sub"><span class="badge">${esc(ext)}</span>${fmtBytes(f.size)} · ${fmtAgo(f.opened)}</div></div>
      <button class="open" data-id="${f.id}" aria-label="Open ${esc(f.name)}"></button>
      <button class="icon-btn del" data-del="${f.id}" aria-label="Remove ${esc(f.name)}">${icon('trash', 19)}</button></li>`;
  }).join('');
  ul.querySelectorAll<HTMLElement>('[data-id]').forEach((b) => (b.onclick = async () => {
    const f = files.find((x) => x.id === b.dataset.id)!;
    const data = await lib.getData(f.id);
    if (data) openBytes(f.name, data, true); else toast('That file is no longer stored on this device');
  }));
  ul.querySelectorAll<HTMLElement>('[data-del]').forEach((b) => (b.onclick = () => {
    const f = files.find((x) => x.id === b.dataset.del)!;
    openSheet('Remove file?', `<p>${esc(f.name)} and its notes and measurements will be removed from this device.</p>
      <div class="btns"><button class="btn" id="no">Keep</button><button class="btn primary" id="yes" style="background:var(--danger)">Remove</button></div>`, (body) => {
      $('#no', body).onclick = () => closeSheet();
      $('#yes', body).onclick = async () => { await lib.deleteFile(f.id); closeSheet(); renderLibrary(); };
    });
  }));
  const s = await lib.storageInfo();
  $('#storage').textContent = s && files.length ? `${fmtBytes(s.used)} used` : '';
}

function saveThumb(id: string) {
  if (doc?.id !== id) return;
  const src = viewer.capture();
  const c = document.createElement('canvas'), k = 240 / Math.max(src.width, src.height);
  const side = Math.min(src.width, src.height);
  c.width = c.height = 200;
  c.getContext('2d')!.drawImage(src, (src.width - side) / 2, (src.height - side) / 2, side, side, 0, 0, 200, 200);
  void k;
  lib.touch(id, { thumb: c.toDataURL('image/jpeg', 0.72) });
}

function saveView() {
  if (!doc) return;
  const c = viewer.controls;
  doc.meta.view = doc.mode === '2d' ? { ...c.v2 } : { t: c.v3.target.toArray(), dist: c.v3.dist, yaw: c.v3.yaw, pitch: c.v3.pitch };
  lib.saveMeta(doc.id, doc.meta);
}
function restoreView() {
  const v: any = doc?.meta.view;
  if (!v) return;
  const c = viewer.controls;
  if (doc!.mode === '2d' && 'scale' in v) { c.v2 = { ...v }; c.apply(); }
  else if (doc!.mode === '3d' && 't' in v) { c.v3.target.fromArray(v.t); Object.assign(c.v3, { dist: v.dist, yaw: v.yaw, pitch: v.pitch }); c.apply(); }
}

function maybeCoach() {
  if (store.get('coach') === '1') return;
  showCoach();
}
function showCoach() {
  const is3 = doc?.mode === '3d';
  $('#coachDrag').textContent = is3 ? 'Orbit around the model (two fingers to move)' : 'Move around the drawing';
  $('#coachTwist').textContent = is3 ? 'Spin the model' : 'Rotate the drawing (lock it in More)';
  $('#coach').hidden = false;
  $('#coachOk').onclick = () => { $('#coach').hidden = true; store.set('coach', '1'); };
}
$('#btnHelp').onclick = showCoach;

// ---------------- dock & tools ----------------
interface DockItem { id: string; icon: IconName; label: string; run: () => void }
function buildDock() {
  const items: DockItem[] = doc!.mode === '2d'
    ? [
      { id: 'measure', icon: 'ruler', label: 'Measure', run: () => setTool('measure') },
      { id: 'area', icon: 'area', label: 'Area', run: () => setTool('area') },
      { id: 'note', icon: 'pin', label: 'Note', run: () => setTool('note') },
      { id: 'layers', icon: 'layers', label: 'Layers', run: showLayers },
      { id: 'more', icon: 'more', label: 'More', run: showMore },
    ]
    : [
      { id: 'measure', icon: 'ruler', label: 'Measure', run: () => setTool('measure') },
      { id: 'section', icon: 'section', label: 'Section', run: showSection },
      { id: 'note', icon: 'pin', label: 'Note', run: () => setTool('note') },
      { id: 'layers', icon: 'layers', label: 'Parts', run: showLayers },
      { id: 'more', icon: 'more', label: 'More', run: showMore },
    ];
  const dock = $('#dock');
  dock.innerHTML = items.map((it) => `<button data-tool="${it.id}" aria-label="${it.label}">${icon(it.icon, 23)}<span>${it.label}</span></button>`).join('');
  dock.querySelectorAll<HTMLElement>('button').forEach((b, i) => (b.onclick = () => { haptic.tick(); items[i].run(); }));
}

function hint(text: string | null, buttons: [string, () => void, boolean?][] = []) {
  const h = $('#hint');
  if (text === null) { h.classList.remove('show'); return; }
  h.innerHTML = `<span class="txt">${text}</span>`;
  for (const [label, fn, primary] of buttons) {
    const b = document.createElement('button');
    b.textContent = label;
    if (primary) b.classList.add('primary');
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    h.appendChild(b);
  }
  h.classList.add('show');
}

function setTool(t: Tool, toggle = true) {
  tool = toggle && tool === t ? 'none' : t;
  resetDraft();
  document.querySelectorAll<HTMLElement>('#dock [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
  refreshHint();
}
function refreshHint() {
  if (tool === 'measure') hint(draft.length ? 'Now tap the second point' : 'Tap two points · long-press for the magnifier', [['Done', () => setTool('none')]]);
  else if (tool === 'area') {
    const a = draft.length >= 3 ? ` · ${fmtArea(polyArea(draft))}` : '';
    hint(draft.length < 3 ? `Tap the corners (${draft.length})${a}` : `Tap the first point to close${a}`, [
      ...(draft.length ? [['Undo', undoPoint] as [string, () => void]] : []),
      ...(draft.length >= 3 ? [['Finish', finishArea, true] as [string, () => void, boolean]] : [['Cancel', () => setTool('none')] as [string, () => void]]),
    ]);
  } else if (tool === 'note') hint('Tap where the note goes', [[`All (${doc?.meta.notes.length ?? 0})`, listNotes], ['Done', () => setTool('none')]]);
  else if (compare) hint(null);
  else hint(null);
}

// ---------------- gestures → actions ----------------
let pressPick: Pick | null = null;
viewer.handlers = {
  tap: (x, y) => {
    hidePopover();
    if (!doc || tool === 'none') return;
    const p = viewer.pick(x, y);
    if (!p) return toast('Nothing there');
    place(p, x, y);
  },
  longPress: (x, y) => {
    if (!doc) return;
    haptic.strong();
    if (tool === 'none') return contextMenu(x, y);
    pressPick = viewer.pick(x, y);
    viewer.showLoupe(x, y, pressPick?.snapped ? pressPick.point : null);
  },
  pressMove: (x, y) => {
    if (tool === 'none') return;
    const p = viewer.pick(x, y);
    if (p?.snapped && (!pressPick?.snapped || !p.point.equals(pressPick.point))) haptic.tick();
    pressPick = p;
    viewer.showLoupe(x, y, p?.snapped ? p.point : null);
  },
  pressEnd: (x, y) => {
    viewer.hideLoupe();
    if (tool !== 'none' && pressPick) place(pressPick, x, y);
    pressPick = null;
    viewer.requestRender();
  },
};

function place(p: Pick, x: number, y: number) {
  haptic.tap();
  if (tool === 'note') return editNote(null, p.point);
  if (tool === 'area' && draft.length >= 3) {
    const s = viewer.toScreen(draft[0]);
    if (Math.hypot(s.x - x, s.y - y) < 30) return finishArea();
  }
  draft.push(p.point);
  viewer.setLabel({ id: `draft:${draft.length}`, pos: p.point, html: '', cls: p.snapped ? 'dot' : 'dot free' });
  drawDraft();
  if (tool === 'measure' && draft.length === 2) {
    commitMeasure({ id: uid(), kind: 'dist', pts: draft.map(toReal) });
    resetDraft();
  }
  refreshHint();
}

function contextMenu(x: number, y: number) {
  const p = viewer.pick(x, y);
  if (!p) return;
  const r = viewer.renderer.domElement.getBoundingClientRect();
  const real = toReal(p.point);
  const items = [
    { icon: 'ruler', label: 'Measure from here', run: () => { setTool('measure', false); place(p, x, y); } },
    { icon: 'pin', label: 'Add a note here', run: () => editNote(null, p.point) },
    { icon: 'plus', label: 'Zoom in here', run: () => viewer.controls.zoomBy(3, x, y) },
    { icon: 'copy', label: `Copy ${p.snapped ? 'snapped ' : ''}coordinates`, run: () => {
      const txt = doc!.mode === '2d' ? `${fmtNum(real[0])}, ${fmtNum(real[1])}` : real.map(fmtNum).join(', ');
      navigator.clipboard?.writeText(txt).then(() => toast(`Copied ${txt}`), () => toast(txt, 5000));
    } },
  ];
  popover(x + r.left, y + r.top, items);
}
const fmtNum = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 4, useGrouping: false });

// ---------------- measuring ----------------
const toReal = (v: THREE.Vector3): [number, number, number] => [v.x + doc!.origin[0], v.y + doc!.origin[1], v.z + doc!.origin[2]];
const toLocal = (p: [number, number, number]) => new THREE.Vector3(p[0] - doc!.origin[0], p[1] - doc!.origin[1], p[2] - doc!.origin[2]);

function lineObj(pts: THREE.Vector3[], closed: boolean, color = 0xfacc15, fill = false) {
  const g = new THREE.Group();
  const lg = new THREE.BufferGeometry().setFromPoints(closed ? [...pts, pts[0]] : pts);
  const l = new THREE.Line(lg, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
  l.renderOrder = 999;
  g.add(l);
  if (fill && pts.length >= 3 && doc?.mode === '2d') {
    const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, p.y)));
    const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, depthTest: false, side: THREE.DoubleSide }));
    m.renderOrder = 998;
    g.add(m);
  }
  return g;
}
function drawDraft() {
  viewer.overlay.getObjectByName('draft')?.removeFromParent();
  if (draft.length >= 2) {
    const l = lineObj(draft, tool === 'area' && draft.length >= 3, 0xfb923c, tool === 'area');
    l.name = 'draft';
    viewer.overlay.add(l);
  }
  viewer.requestRender();
}
function undoPoint() { viewer.removeLabel(`draft:${draft.length}`); draft.pop(); drawDraft(); refreshHint(); }
function resetDraft() { draft = []; viewer.clearLabels('draft:'); drawDraft(); }
function finishArea() {
  if (draft.length < 3) return toast('An area needs at least 3 points');
  commitMeasure({ id: uid(), kind: 'area', pts: draft.map(toReal) });
  resetDraft();
  refreshHint();
}
function polyArea(p: THREE.Vector3[]): number {
  let nx = 0, ny = 0, nz = 0; // Newell's method: any planar polygon, any orientation
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    nx += (a.y - b.y) * (a.z + b.z); ny += (a.z - b.z) * (a.x + b.x); nz += (a.x - b.x) * (a.y + b.y);
  }
  return Math.hypot(nx, ny, nz) / 2;
}
function commitMeasure(m: lib.Measure) {
  doc!.meta.measures.push(m);
  lib.saveMeta(doc!.id, doc!.meta);
  drawMeasure(m);
  haptic.strong();
}
function measureText(m: lib.Measure) {
  const pts = m.pts.map(toLocal);
  if (m.kind === 'dist') {
    const [a, b] = pts, d = a.distanceTo(b);
    const dz = Math.abs(b.z - a.z), dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
    const detail = doc!.mode === '2d' ? `Δx ${fmtLen(dx)} · Δy ${fmtLen(dy)}` : `height difference ${fmtLen(Math.abs(b.y - a.y))}`;
    void dz;
    return { main: fmtLen(d), detail, at: a.clone().lerp(b, 0.5) };
  }
  let per = 0;
  pts.forEach((p, i) => (per += p.distanceTo(pts[(i + 1) % pts.length])));
  return { main: fmtArea(polyArea(pts)), detail: `perimeter ${fmtLen(per)}`, at: pts.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(pts.length) };
}
function drawMeasure(m: lib.Measure) {
  const pts = m.pts.map(toLocal);
  const line = lineObj(pts, m.kind === 'area', 0xfacc15, m.kind === 'area');
  line.name = `m:${m.id}`;
  viewer.overlay.add(line);
  pts.forEach((p, i) => viewer.setLabel({ id: `m:${m.id}:p${i}`, pos: p, html: '', cls: 'dot' }));
  const t = measureText(m);
  viewer.setLabel({ id: `m:${m.id}`, pos: t.at, html: esc(t.main), cls: 'dim', onTap: () => measureSheet(m) });
}
function measureSheet(m: lib.Measure) {
  const t = measureText(m);
  openSheet(m.kind === 'dist' ? 'Distance' : 'Area', `
    <div class="big-num">${esc(t.main)}</div><p class="muted">${esc(t.detail)}</p>
    ${unitPicker()}
    <div class="btns"><button class="btn" id="mCopy">${icon('copy', 18)}Copy</button><button class="btn danger" id="mDel">${icon('trash', 18)}Delete</button></div>`, (b) => {
    wireUnitPicker(b, () => measureSheet(m));
    $('#mCopy', b).onclick = () => navigator.clipboard?.writeText(`${t.main} (${t.detail})`).then(() => toast('Copied'));
    $('#mDel', b).onclick = () => {
      doc!.meta.measures = doc!.meta.measures.filter((x) => x.id !== m.id);
      lib.saveMeta(doc!.id, doc!.meta);
      viewer.overlay.getObjectByName(`m:${m.id}`)?.removeFromParent();
      viewer.clearLabels(`m:${m.id}`);
      closeSheet();
    };
  });
}
const UNIT_CHOICES = ['mm', 'cm', 'm', 'in', 'ft'];
function unitPicker() {
  const cur = units();
  return `<p class="muted" style="margin:16px 0 6px">Drawing units${doc!.units !== 'units' && !doc!.meta.units ? ' (from file)' : ''}</p>
    <div class="seg">${UNIT_CHOICES.map((u) => `<button data-u="${u}" class="${cur === u ? 'on' : ''}">${u}</button>`).join('')}</div>`;
}
function wireUnitPicker(b: HTMLElement, after?: () => void) {
  b.querySelectorAll<HTMLElement>('[data-u]').forEach((x) => (x.onclick = () => {
    doc!.meta.units = x.dataset.u!;
    lib.saveMeta(doc!.id, doc!.meta);
    $('#subtitle').textContent = `${doc!.ext.toUpperCase()} · ${fmtBytes(doc!.size)} · ${units()}`;
    redrawAnnotations();
    haptic.tick();
    after?.();
  }));
}

// ---------------- notes ----------------
function drawNotes() {
  viewer.clearLabels('n:');
  doc!.meta.notes.forEach((n, i) => viewer.setLabel({ id: `n:${n.id}`, pos: toLocal([n.x, n.y, n.z]), html: `<b>${i + 1}</b>`, cls: 'pin', onTap: () => editNote(n) }));
}
function editNote(n: lib.Note | null, at?: THREE.Vector3) {
  const idx = n ? doc!.meta.notes.indexOf(n) + 1 : doc!.meta.notes.length + 1;
  openSheet(n ? `Note ${idx}` : 'New note', `
    <textarea id="noteText" rows="4" placeholder="e.g. Socket height wrong, check with electrician">${esc(n?.text ?? '')}</textarea>
    ${n ? `<p class="muted">${new Date(n.created).toLocaleString()}</p>` : ''}
    <div class="btns">${n ? `<button class="btn danger" id="noteDel">${icon('trash', 18)}Delete</button>` : ''}<button class="btn primary" id="noteSave">${icon('check', 18)}Save</button></div>`, (b) => {
    const ta = $('#noteText', b) as HTMLTextAreaElement;
    if (!n) setTimeout(() => ta.focus({ preventScroll: true }), 250);
    $('#noteSave', b).onclick = () => {
      const text = ta.value.trim();
      if (!text) return toast('Write something first');
      if (n) n.text = text;
      else { const [x, y, z] = toReal(at!); doc!.meta.notes.push({ id: uid(), x, y, z, text, created: Date.now() }); }
      lib.saveMeta(doc!.id, doc!.meta);
      drawNotes();
      closeSheet();
      haptic.tap();
      refreshHint();
    };
    $('#noteDel', b)?.addEventListener('click', () => {
      doc!.meta.notes = doc!.meta.notes.filter((x) => x !== n);
      lib.saveMeta(doc!.id, doc!.meta);
      drawNotes();
      closeSheet();
    });
  });
}
function listNotes() {
  const notes = doc!.meta.notes;
  openSheet(`Notes (${notes.length})`, notes.length
    ? `<div class="list">${notes.map((n, i) => `<button class="row" data-i="${i}"><b style="width:22px">${i + 1}</b><span class="grow">${esc(n.text)}</span><span class="sub">${fmtAgo(n.created)}</span></button>`).join('')}</div>
       <div class="btns"><button class="btn" id="exportNotes">${icon('share', 18)}Share as text</button></div>`
    : '<p class="muted">No notes yet. Choose Note, then tap the drawing.</p>', (b) => {
    b.querySelectorAll<HTMLElement>('[data-i]').forEach((r) => (r.onclick = () => {
      const n = notes[+r.dataset.i!];
      closeSheet();
      viewer.focus(toLocal([n.x, n.y, n.z]), viewer.bounds.getSize(new THREE.Vector3()).length() / 40);
    }));
    $('#exportNotes', b)?.addEventListener('click', () => {
      const txt = `${doc!.name}: notes\n\n` + notes.map((n, i) => `${i + 1}. ${n.text}\n   at ${fmtNum(n.x)}, ${fmtNum(n.y)}${doc!.mode === '3d' ? `, ${fmtNum(n.z)}` : ''} · ${new Date(n.created).toLocaleString()}`).join('\n\n');
      shareFile(new Blob([txt], { type: 'text/plain' }), `${doc!.name.replace(/\.\w+$/, '')}-notes.txt`, txt);
    });
  });
}
function restoreAnnotations() {
  for (const m of doc!.meta.measures) drawMeasure(m);
  drawNotes();
}
function redrawAnnotations() {
  for (const m of doc!.meta.measures) { viewer.overlay.getObjectByName(`m:${m.id}`)?.removeFromParent(); viewer.clearLabels(`m:${m.id}`); }
  restoreAnnotations();
}

// ---------------- sheets: layers, more, find, section, views, info ----------------
function showLayers() {
  type G = { name: string; obj: THREE.Object3D; color: number | null };
  let groups: G[];
  if (compare) return toast('Use the legend to show or hide changes');
  if (doc!.mode === '2d') groups = doc!.drawing!.layers.map((l, i) => ({ name: l.name, obj: doc!.s2!.layers[i], color: l.color }));
  else groups = doc!.s3!.parts.map((p) => ({ name: p.name, obj: p, color: null }));
  if (!groups.length) return toast('Nothing to list');
  const fg = fgColor();
  const sw = (c: number | null) => (c === null ? '' : `<span class="swatch" style="background:#${(c < 0 ? fg : c).toString(16).padStart(6, '0')}"></span>`);
  const title = doc!.mode === '2d' ? `Layers (${groups.length})` : `Parts (${groups.length})`;
  openSheet(title, `
    ${groups.length > 10 ? '<input type="search" id="lq" placeholder="Filter…" autocomplete="off" style="margin-bottom:8px">' : ''}
    <div class="btns" style="margin:0 0 6px"><button class="btn" id="allOn">Show all</button><button class="btn" id="allOff">Hide all</button></div>
    <div class="list" id="ll">${groups.map((g, i) => `<label class="row" data-i="${i}">${sw(g.color)}<span class="grow">${esc(g.name)}</span><input type="checkbox" class="switch" ${g.obj.visible ? 'checked' : ''}></label>`).join('')}</div>`, (b) => {
    const sync = () => viewer.requestRender();
    b.querySelectorAll<HTMLElement>('[data-i]').forEach((row) => {
      const cb = row.querySelector('input')!;
      cb.onchange = () => { groups[+row.dataset.i!].obj.visible = cb.checked; haptic.tick(); sync(); };
    });
    const all = (v: boolean) => { b.querySelectorAll<HTMLElement>('[data-i]').forEach((row) => { if (row.hidden) return; groups[+row.dataset.i!].obj.visible = v; row.querySelector('input')!.checked = v; }); sync(); };
    $('#allOn', b).onclick = () => all(true);
    $('#allOff', b).onclick = () => all(false);
    const q = b.querySelector<HTMLInputElement>('#lq');
    if (q) q.oninput = () => { const s = q.value.toLowerCase(); b.querySelectorAll<HTMLElement>('[data-i]').forEach((row) => (row.hidden = !groups[+row.dataset.i!].name.toLowerCase().includes(s))); };
  }, { tall: groups.length > 8 });
}

function showMore() {
  const is2 = doc!.mode === '2d';
  const tiles: { id: string; icon: IconName; label: string; on?: boolean; run: () => void }[] = [
    ...(is2 ? [
      { id: 'find', icon: 'search' as IconName, label: 'Find text', run: showFind },
      { id: 'compare', icon: 'compare' as IconName, label: compare ? 'Exit compare' : 'Compare revision', on: !!compare, run: () => (compare ? (closeSheet(), exitCompare()) : $('#compareInput').click()) },
      { id: 'lock', icon: (rotLock ? 'lock' : 'unlock') as IconName, label: rotLock ? 'Rotation locked' : 'Rotation free', on: rotLock, run: toggleRotLock },
    ] : [
      { id: 'area', icon: 'area' as IconName, label: 'Area', run: () => { closeSheet(); setTool('area'); } },
      { id: 'views', icon: 'cube' as IconName, label: 'Views', run: showViews },
    ]),
    { id: 'units', icon: 'ruler', label: `Units: ${units()}`, run: showUnits },
    { id: 'site', icon: 'sun', label: 'Site mode', on: site, run: toggleSite },
    { id: 'notes', icon: 'notes', label: 'Notes', run: listNotes },
    { id: 'share', icon: 'image', label: 'Share image', run: () => { closeSheet(); snapshot(); } },
    { id: 'help', icon: 'hand', label: 'Gestures', run: () => { closeSheet(); showCoach(); } },
    { id: 'info', icon: 'info', label: 'File info', run: showInfo },
  ];
  openSheet('More', `<div class="tiles">${tiles.map((t, i) => `<button class="tile ${t.on ? 'on' : ''}" data-i="${i}">${icon(t.icon, 24)}<span>${esc(t.label)}</span></button>`).join('')}</div>`, (b) => {
    b.querySelectorAll<HTMLElement>('[data-i]').forEach((x) => (x.onclick = () => { haptic.tick(); tiles[+x.dataset.i!].run(); }));
  });
}
function showUnits() {
  openSheet('Units', `<p class="muted">Set what one drawing unit means, so measurements read correctly. Files exported without units (OBJ, STL, many DAE files) need this.</p>${unitPicker()}`, (b) => wireUnitPicker(b, showUnits));
}
function toggleRotLock() {
  rotLock = !rotLock;
  store.set('rotlock', rotLock ? '1' : '0');
  viewer.controls.rotate2D = !rotLock;
  if (rotLock) viewer.controls.animate2D({ rot: 0 });
  toast(rotLock ? 'Rotation locked: twist no longer rotates' : 'Twist with two fingers to rotate');
  showMore();
}
function toggleSite() {
  site = !site;
  root.classList.toggle('site', site);
  store.set('site', site ? '1' : '0');
  applyTheme();
  requestAnimationFrame(measurePadding);
  if (sheetOpen()) showMore();
}

function showFind() {
  const t = doc!.drawing!.text;
  openSheet('Find text', `<input type="search" id="q" placeholder="Room number, door tag, note…" autocomplete="off" enterkeyhint="search"><div id="res" class="list" style="margin-top:8px"></div>`, (b) => {
    const q = $('#q', b) as HTMLInputElement, res = $('#res', b);
    let timer = 0;
    const run = () => {
      const s = q.value.trim().toLowerCase();
      if (!s) { res.innerHTML = `<p class="muted">${t.values.length.toLocaleString()} text labels in this drawing.</p>`; return; }
      const hits: number[] = [];
      for (let i = 0; i < t.values.length && hits.length < 300; i++) if (t.values[i].toLowerCase().includes(s)) hits.push(i);
      res.innerHTML = hits.length
        ? hits.map((i) => `<button class="row" data-i="${i}">${icon('locate', 18)}<span class="grow">${esc(t.values[i].replace(/\n/g, ' '))}</span><span class="sub">${esc(doc!.drawing!.layers[t.layer[i]]?.name ?? '')}</span></button>`).join('') + (hits.length >= 300 ? '<p class="muted">Showing the first 300 matches.</p>' : '')
        : '<p class="muted">No matches</p>';
      res.querySelectorAll<HTMLElement>('[data-i]').forEach((r) => (r.onclick = () => {
        const i = +r.dataset.i!;
        const pos = new THREE.Vector3(t.num[i * 5], t.num[i * 5 + 1], t.num[i * 5 + 2]);
        closeSheet();
        const L = doc!.s2!.layers[t.layer[i]];
        if (L && !L.visible) { L.visible = true; toast(`Layer "${L.name}" turned on`); }
        viewer.focus(pos, Math.max(t.num[i * 5 + 3] * 6, 1e-6));
        viewer.setLabel({ id: 'hit', pos, html: '', cls: 'hit' });
        setTimeout(() => viewer.removeLabel('hit'), 3500);
      }));
    };
    q.oninput = () => { clearTimeout(timer); timer = window.setTimeout(run, 120); };
    run();
    setTimeout(() => q.focus({ preventScroll: true }), 250);
  }, { tall: true });
}

function showSection() {
  const s = viewer.section;
  openSheet('Section cut', `
    <label class="row"><span class="grow">Cut through the model</span><input type="checkbox" class="switch" id="secOn" ${s.enabled ? 'checked' : ''}></label>
    <div class="seg" style="margin:12px 0">${['Across (X)', 'Height', 'Depth (Z)'].map((a, i) => `<button data-ax="${i}" class="${s.axis === i ? 'on' : ''}">${a}</button>`).join('')}</div>
    <input type="range" id="secT" min="0" max="1" step="0.001" value="${s.t}" aria-label="Cut position">
    <div class="btns"><button class="btn" id="secFlip">${icon('reset', 18)}Flip side</button><button class="btn" id="secTop">${icon('cube', 18)}Look from above</button></div>
    <p class="muted">Tip: choose Height and slide to see each floor as a plan.</p>`, (b) => {
    const on = $('#secOn', b) as HTMLInputElement;
    const upd = () => { viewer.applySection(); document.querySelector('#dock [data-tool=section]')?.classList.toggle('on', s.enabled); };
    on.onchange = () => { s.enabled = on.checked; upd(); };
    ($('#secT', b) as HTMLInputElement).oninput = (e) => { s.t = +(e.target as HTMLInputElement).value; s.enabled = on.checked = true; upd(); };
    b.querySelectorAll<HTMLElement>('[data-ax]').forEach((btn) => (btn.onclick = () => {
      s.axis = +btn.dataset.ax! as 0 | 1 | 2;
      b.querySelectorAll('[data-ax]').forEach((x) => x.classList.toggle('on', x === btn));
      s.enabled = on.checked = true; upd(); haptic.tick();
    }));
    $('#secFlip', b).onclick = () => { s.flip = !s.flip; s.enabled = on.checked = true; upd(); };
    $('#secTop', b).onclick = () => viewer.view('top');
  });
}
function showViews() {
  const views: [string, 'top' | 'front' | 'side' | 'back' | 'iso'][] = [['Top', 'top'], ['Front', 'front'], ['Side', 'side'], ['Back', 'back'], ['3D', 'iso']];
  openSheet('Views', `<div class="tiles">${views.map(([l, v]) => `<button class="tile" data-v="${v}">${icon('cube', 24)}<span>${l}</span></button>`).join('')}
    <button class="tile" id="zup">${icon('reset', 24)}<span>Stand model up</span></button></div>
    <p class="muted">"Stand model up" fixes files exported with Z pointing up (common from SketchUp, OBJ and STL).</p>`, (b) => {
    b.querySelectorAll<HTMLElement>('[data-v]').forEach((x) => (x.onclick = () => { viewer.view(x.dataset.v as any); haptic.tick(); }));
    $('#zup', b).onclick = () => {
      const r = doc!.s3!.root;
      r.rotation.x = r.rotation.x === 0 ? -Math.PI / 2 : 0;
      r.updateMatrixWorld(true);
      // rotate snap points too: (x, y, z) → (x, z, -y) and back
      const p = doc!.grid.pts, up = r.rotation.x !== 0;
      for (let i = 0; i < p.length; i += 3) { const y = p[i + 1], z = p[i + 2]; if (up) { p[i + 1] = z; p[i + 2] = -y; } else { p[i + 1] = -z; p[i + 2] = y; } }
      import('./cad/snapgrid').then(({ buildGrid }) => {
        doc!.grid = buildGrid(p, doc!.grid.tags, true);
        viewer.snap.grid = doc!.grid;
      });
      viewer.setContent(r, '3d', { dispose: false });
      restoreAnnotations();
      closeSheet();
    };
  });
}
function showInfo() {
  const d = doc!;
  openSheet('File info', `<div class="list">
    <div class="row"><span class="grow">Name</span><span class="sub">${esc(d.name)}</span></div>
    <div class="row"><span class="grow">Size</span><span class="sub">${fmtBytes(d.size)}</span></div>
    <div class="row"><span class="grow">Opened in</span><span class="sub">${(d.ms / 1000).toFixed(2)} s, on this device</span></div>
    <div class="row"><span class="grow">Units</span><span class="sub">${esc(units())}</span></div>
    ${d.stats.map((s) => `<div class="row"><span class="grow" style="white-space:normal">${esc(s)}</span></div>`).join('')}
  </div><p class="muted">Everything is processed on this phone. Nothing is uploaded.</p>`);
}

// ---------------- revision compare ----------------
($('#compareInput') as HTMLInputElement).onchange = async (e) => {
  const input = e.target as HTMLInputElement, f = input.files?.[0];
  input.value = '';
  closeSheet();
  if (f) runCompare(f.name, await f.arrayBuffer());
};
async function runCompare(name: string, other: ArrayBuffer) {
  if (!doc?.drawing) return;
  const base = await lib.getData(doc.id);
  if (!base) return toast('The current drawing is not stored on this device, so it can’t be compared');
  loading.show(`${doc.name} → ${name}`, () => jobs.restart());
  try {
    const r = await jobs.run({ type: 'compare', base, other, origin: doc.drawing.origin }, [base, other], loading.progress);
    const scene = build2D(r.drawing, fgColor(), viewer.maxTexture);
    compare = { name, scene, grid: r.grid, added: r.added, removed: r.removed, same: r.same };
    setTool('none');
    viewer.setContent(scene.root, '2d', { bounds: scene.bounds, dispose: false, fit: false });
    viewer.lod = scene.lod;
    viewer.snap = { grid: r.grid, accept: (l) => scene.layers[l]?.visible !== false };
    restoreAnnotations();
    applyTheme();
    renderLegend();
    loading.hide();
    toast(r.added + r.removed ? `${r.added.toLocaleString()} added · ${r.removed.toLocaleString()} removed` : 'No differences found');
  } catch (err: any) {
    loading.hide();
    if (err?.message !== 'cancelled') toast(`Couldn't compare: ${err?.message ?? err}`, 6000);
  }
}
function renderLegend() {
  const c = compare!, lg = $('#legend');
  const rows: [string, string, number, number][] = [['Added', '#22c55e', c.added, 2], ['Removed', '#ef4444', c.removed, 1], ['Unchanged', '#8a8f98', c.same, 0]];
  lg.innerHTML = `<div class="row" style="font-weight:650;min-height:24px">Changes in ${esc(c.name)}</div>
    ${rows.map(([l, col, n, layer]) => `<div class="row"><label><input type="checkbox" data-l="${layer}" ${c.scene.layers[layer]?.visible !== false ? 'checked' : ''}><span class="sw" style="background:${col}"></span>${l}</label><b>${n.toLocaleString()}</b></div>`).join('')}
    <div class="btns" style="margin-top:6px"><button class="btn" id="exitCmp" style="min-height:38px">${icon('close', 16)}Exit compare</button></div>`;
  lg.hidden = false;
  lg.querySelectorAll<HTMLInputElement>('[data-l]').forEach((cb) => (cb.onchange = () => { const L = c.scene.layers[+cb.dataset.l!]; if (L) L.visible = cb.checked; viewer.requestRender(); }));
  $('#exitCmp', lg).onclick = () => exitCompare();
}
function exitCompare(remount = true) {
  if (!compare) return;
  const old = compare;
  compare = null;
  $('#legend').hidden = true;
  if (remount && doc?.s2) {
    viewer.setContent(doc.s2.root, '2d', { bounds: doc.s2.bounds, dispose: false, fit: false });
    viewer.lod = doc.s2.lod;
    Viewer.dispose(old.scene.root);
    viewer.snap = { grid: doc.grid, accept: (layer) => doc!.s2!.layers[layer]?.visible !== false };
    restoreAnnotations();
  } else Viewer.dispose(old.scene.root);
}

// ---------------- share ----------------
$('#btnShare').onclick = snapshot;
function snapshot() {
  const src = viewer.capture();
  const out = document.createElement('canvas');
  const k = src.width / (viewer.renderer.domElement.clientWidth || 1);
  out.width = src.width; out.height = src.height + Math.round(56 * k);
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = site ? '#fff' : '#0b0d12';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(src, 0, 0);
  ctx.font = `600 ${13 * k}px system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  for (const { el, pos } of viewer.labelEntries()) {
    const s = viewer.toScreen(pos);
    if (!s.visible) continue;
    const x = s.x * k, y = s.y * k;
    if (el.classList.contains('pin')) {
      ctx.fillStyle = '#ff5d5d'; ctx.beginPath(); ctx.arc(x, y - 16 * k, 12 * k, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(el.textContent ?? '', x, y - 16 * k);
    } else if (el.classList.contains('dim')) {
      const t = el.textContent ?? '', w = ctx.measureText(t).width + 16 * k;
      ctx.fillStyle = 'rgba(12,15,22,.92)'; ctx.beginPath(); (ctx as any).roundRect?.(x - w / 2, y - 12 * k, w, 24 * k, 8 * k) ?? ctx.rect(x - w / 2, y - 12 * k, w, 24 * k); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(t, x, y);
    } else if (el.classList.contains('dot')) {
      ctx.fillStyle = '#facc15'; ctx.beginPath(); ctx.arc(x, y, 5 * k, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = site ? '#000' : '#eef0f4';
  ctx.font = `600 ${14 * k}px system-ui, sans-serif`;
  ctx.fillText(`${doc?.name ?? ''}  ·  ${new Date().toLocaleString()}`, 16 * k, src.height + 28 * k);
  out.toBlob((b) => b && shareFile(b, `${(doc?.name ?? 'view').replace(/\.\w+$/, '')}-markup.png`), 'image/png');
}
async function shareFile(blob: Blob, name: string, text?: string) {
  try {
    if (Capacitor.isNativePlatform()) {
      const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
      const data = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(blob); });
      const f = await Filesystem.writeFile({ path: name, data, directory: Directory.Cache });
      await Share.share({ title: name, files: [f.uri] });
      return;
    }
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    if (text && navigator.share) { await navigator.share({ title: name, text }); return; }
  } catch (e: any) { if (e?.name === 'AbortError' || /cancel/i.test(String(e?.message))) return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------- HUD: scale bar & compass ----------------
$('#btnFit').onclick = () => { haptic.tick(); viewer.fit(); };
$('#btnCompass').onclick = () => { haptic.tick(); viewer.controls.animate2D({ rot: 0 }); };
viewer.onFrame = () => {
  const sb = $('#scalebar');
  if (!doc || viewer.mode !== '2d') { sb.hidden = true; $('#btnCompass').hidden = true; return; }
  const ppu = viewer.pixelsPerUnit();
  const world = 96 / ppu, p = Math.pow(10, Math.floor(Math.log10(world))), f = world / p;
  const nice = (f >= 5 ? 5 : f >= 2 ? 2 : 1) * p;
  sb.hidden = false;
  ($('.bar', sb) as HTMLElement).style.width = `${nice * ppu}px`;
  $('span', sb).textContent = fmtLen(nice);
  const rot = viewer.controls.v2.rot;
  const showC = Math.abs(Math.atan2(Math.sin(rot), Math.cos(rot))) > 0.01;
  $('#btnCompass').hidden = !showC;
  if (showC) $('#needle').style.transform = `rotate(${rot}rad)`;
};

// ---------------- "Open with…" from other apps (native) ----------------
if (Capacitor.isNativePlatform()) {
  import('@capacitor/app').then(({ App }) => {
    App.addListener('appUrlOpen', async ({ url }) => {
      try {
        const { Filesystem } = await import('@capacitor/filesystem');
        const r = await Filesystem.readFile({ path: url });
        const bin = atob(typeof r.data === 'string' ? r.data : await (r.data as Blob).text());
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const name = decodeURIComponent(url.split(/[/\\]/).pop() ?? 'file').replace(/\?.*$/, '');
        openBytes(name, bytes.buffer);
      } catch (e: any) { toast(`Couldn't open the shared file: ${e?.message ?? e}`); }
    });
  });
}

// Offline cache for the installable web build (the native app bundles everything already).
if ('serviceWorker' in navigator && location.protocol === 'https:' && !Capacitor.isNativePlatform()) navigator.serviceWorker.register('sw.js');

history.replaceState({ home: true }, '');
applyTheme();
renderLibrary();
(window as any).cadview = { openBytes, viewer, get doc() { return doc; }, runCompare }; // used by end-to-end tests
