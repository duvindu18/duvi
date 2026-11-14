import * as THREE from 'three';
import { Viewer } from './viewer';
import { build2D, drawingOrigin, load3D, MODEL_EXT, diffColor, type Built2D } from './build';
import type { CadDrawing } from './cad/dxf';
import { diffDrawings, type DiffResult } from './cad/diff';
import * as lib from './library';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const uid = () => Math.random().toString(36).slice(2, 10);

const viewer = new Viewer($('canvasHost'), $('labels'));
const canvas = viewer.renderer.domElement;

interface Doc {
  id: string; name: string; mode: '2d' | '3d'; units: string; origin: THREE.Vector3;
  drawing?: CadDrawing; built?: Built2D; model?: THREE.Object3D; meta: lib.FileMeta;
}
let doc: Doc | null = null;
type Tool = 'none' | 'measure' | 'area' | 'note';
let tool: Tool = 'none';
let draft: THREE.Vector3[] = [];
let compare: { name: string; drawing: CadDrawing; result: DiffResult; onlyChanges: boolean } | null = null;
let site = false;
const fgColor = () => (site ? 0x000000 : 0xffffff);
const bgColor = () => (site ? 0xffffff : 0x0f1115);
viewer.setBackground(bgColor());

// ---------------- parsing in a worker ----------------
const worker = new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' });
let seq = 0;
const waiting = new Map<number, { res: (d: CadDrawing) => void; rej: (e: Error) => void }>();
worker.onmessage = (e) => {
  const w = waiting.get(e.data.id);
  waiting.delete(e.data.id);
  if (e.data.ok) w?.res(e.data.drawing); else w?.rej(new Error(e.data.error));
};
function parseDxfText(data: ArrayBuffer): Promise<CadDrawing> {
  const head = new TextDecoder().decode(data.slice(0, 22));
  if (head.startsWith('AutoCAD Binary DXF')) return Promise.reject(new Error('Binary DXF is not supported yet. Save it as ASCII DXF.'));
  const text = new TextDecoder().decode(data);
  return new Promise((res, rej) => {
    const id = ++seq;
    waiting.set(id, { res, rej });
    worker.postMessage({ id, text });
  });
}

// ---------------- UI helpers ----------------
let toastTimer = 0;
function toast(msg: string, ms = 3000) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}
function sheet(title: string, html: string, wire?: (body: HTMLElement) => void) {
  $('sheetTitle').textContent = title;
  const body = $('sheetBody');
  body.innerHTML = html;
  $('sheet').hidden = false;
  wire?.(body);
}
const closeSheet = () => ($('sheet').hidden = true);
$('sheetClose').onclick = closeSheet;

function hint(html: string | null, buttons: [string, () => void][] = []) {
  const h = $('hint');
  if (html === null) { h.hidden = true; return; }
  h.innerHTML = `<span>${html}</span>`;
  for (const [label, fn] of buttons) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = fn;
    h.appendChild(b);
  }
  h.hidden = false;
}

const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(3).replace(/\.?0+$/, '') : v.toPrecision(3));

// ---------------- opening files ----------------
$('btnOpen').onclick = $('homeOpen').onclick = () => $('fileInput').click();
$<HTMLInputElement>('fileInput').onchange = async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (f) await openBytes(f.name, await f.arrayBuffer());
};
$('btnHome').onclick = () => { closeSheet(); showHome(); };

async function openBytes(name: string, data: ArrayBuffer, remember = true) {
  const ext = name.split('.').pop()!.toLowerCase();
  if (ext === 'dwg') return explainDwg();
  if (ext === 'skp') return explainSkp();
  toast(`Opening ${name}…`, 60000);
  try {
    const id = lib.fileId(name, data);
    let next: Doc;
    if (ext === 'dxf') {
      const drawing = await parseDxfText(data);
      const origin = drawingOrigin(drawing);
      const built = build2D(drawing.primitives, origin, fgColor());
      for (const l of drawing.layers) { const g = built.layerGroups.get(l.name); if (g) g.visible = l.visible; }
      viewer.setContent(built.root, '2d');
      next = { id, name, mode: '2d', units: drawing.units, origin, drawing, built, meta: await lib.getMeta(id) };
      const skippedList = Object.entries(drawing.skipped).map(([k, v]) => `${v} ${k}`);
      if (built.hiddenText) skippedList.push(`${built.hiddenText} text labels (performance limit)`);
      if (skippedList.length) toast(`Opened. Not drawn yet: ${skippedList.join(', ')}`, 6000);
      else toast(`Opened: ${drawing.primitives.length.toLocaleString()} entities`);
    } else if (MODEL_EXT.includes(ext)) {
      const model = await load3D(name, data);
      viewer.setContent(model, '3d');
      next = { id, name, mode: '3d', units: ext === 'glb' || ext === 'gltf' ? 'm' : 'units', origin: new THREE.Vector3(), model, meta: await lib.getMeta(id) };
      toast('Opened');
    } else {
      toast(`.${ext} files are not supported`);
      return;
    }
    doc = next;
    compare = null;
    $('legend').hidden = true;
    setTool('none');
    restoreAnnotations();
    $('title').textContent = name;
    $('home').hidden = true;
    $('tools').hidden = false;
    for (const b of document.querySelectorAll<HTMLElement>('#tools [data-only]')) b.hidden = b.dataset.only !== doc.mode;
    if (remember) await lib.saveFile({ id, name, size: data.byteLength, opened: Date.now(), data });
  } catch (err: any) {
    toast(`Could not open ${name}: ${err?.message ?? err}`, 6000);
  }
}

function explainDwg() {
  sheet('DWG files', `<p>DWG is AutoCAD's closed format. To read it with no internet connection, the app has to include a DWG decoder.
    The free one (LibreDWG) would make the whole app GPL. The commercial one (ODA) is a paid licence.</p>
    <p class="muted">For now, save the drawing as <b>DXF</b> in AutoCAD, BricsCAD, DraftSight or the free ODA File Converter, then open the .dxf.</p>`);
}
function explainSkp() {
  sheet('SketchUp files', `<p>SketchUp's official SDK only runs on desktop computers, not phones, so .skp files can't be opened directly yet.</p>
    <p class="muted">In SketchUp, use <b>File → Export → 3D Model</b> and choose <b>.dae</b> (keeps components and materials), <b>.obj</b>, <b>.stl</b>, or <b>.glb</b> if your version has it. Then open the exported file here.</p>`);
}

async function showHome() {
  $('home').hidden = false;
  const files = await lib.listFiles();
  $('recentTitle').hidden = !files.length;
  const ul = $('recent');
  ul.innerHTML = '';
  for (const f of files) {
    const li = document.createElement('li');
    li.innerHTML = `<button class="open"><span class="n">${esc(f.name)}</span><span class="m">${(f.size / 1024 / 1024).toFixed(1)} MB · ${new Date(f.opened).toLocaleDateString()}</span></button><button class="icon del" aria-label="Remove">🗑</button>`;
    li.querySelector<HTMLElement>('.open')!.onclick = async () => {
      const full = await lib.getFile(f.id);
      if (full) openBytes(full.name, full.data);
    };
    li.querySelector<HTMLElement>('.del')!.onclick = async () => {
      if (!confirm(`Remove ${f.name} and its notes from this device?`)) return;
      await lib.deleteFile(f.id);
      showHome();
    };
    ul.appendChild(li);
  }
}

// ---------------- taps ----------------
let pointers = 0;
let down: { x: number; y: number; t: number } | null = null;
canvas.addEventListener('pointerdown', (e) => {
  pointers++;
  down = pointers === 1 ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
});
canvas.addEventListener('pointerup', (e) => {
  pointers = Math.max(0, pointers - 1);
  if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8 && performance.now() - down.t < 500) onTap(e.clientX, e.clientY);
  down = null;
});
canvas.addEventListener('pointercancel', () => { pointers = Math.max(0, pointers - 1); down = null; });

const toReal = (v: THREE.Vector3): [number, number, number] => [v.x + doc!.origin.x, v.y + doc!.origin.y, v.z + doc!.origin.z];
const toLocal = (p: [number, number, number]) => new THREE.Vector3(p[0] - doc!.origin.x, p[1] - doc!.origin.y, p[2] - doc!.origin.z);

function onTap(x: number, y: number) {
  if (!doc || tool === 'none') return;
  const hit = viewer.pick(x, y);
  if (!hit) return toast('Nothing there to snap to');
  if (tool === 'note') return editNote(null, hit.point);
  if (tool === 'area' && draft.length >= 3) {
    const s = viewer.toScreen(draft[0]);
    const r = canvas.getBoundingClientRect();
    if (Math.hypot(s.x + r.left - x, s.y + r.top - y) < 28) return finishArea();
  }
  draft.push(hit.point);
  viewer.setLabel({ id: `draft:${draft.length}`, pos: hit.point, html: '', cls: hit.snapped ? 'dot' : 'dot free' });
  drawDraft();
  if (tool === 'measure' && draft.length === 2) {
    commitMeasure({ id: uid(), kind: 'dist', pts: draft.map(toReal) });
    resetDraft();
  }
}

function lineObj(pts: THREE.Vector3[], closed: boolean, color = 0xfacc15) {
  const g = new THREE.BufferGeometry().setFromPoints(closed ? [...pts, pts[0]] : pts);
  const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
  l.renderOrder = 999;
  return l;
}
function drawDraft() {
  viewer.overlay.getObjectByName('draft')?.removeFromParent();
  if (draft.length >= 2) {
    const l = lineObj(draft, false, 0xf59e0b);
    l.name = 'draft';
    viewer.overlay.add(l);
  }
  if (tool === 'area') {
    const a = draft.length >= 3 ? ` · ${fmt(polyArea(draft))} ${doc!.units}²` : '';
    hint(`Tap corners. Tap the first point to close.${a}`, [
      ['Undo', () => { viewer.removeLabel(`draft:${draft.length}`); draft.pop(); drawDraft(); }],
      ['Done', finishArea],
    ]);
  }
  viewer.requestRender();
}
function resetDraft() {
  draft = [];
  viewer.clearLabels('draft:');
  drawDraft();
}
function finishArea() {
  if (draft.length < 3) return toast('An area needs at least 3 points');
  commitMeasure({ id: uid(), kind: 'area', pts: draft.map(toReal) });
  resetDraft();
}

export function polyArea(p: THREE.Vector3[]): number {
  let nx = 0, ny = 0, nz = 0; // Newell's method: works for planar polygons in any orientation
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  return Math.hypot(nx, ny, nz) / 2;
}

// ---------------- measurements & notes (persisted per file) ----------------
function commitMeasure(m: lib.Measure) {
  doc!.meta.measures.push(m);
  lib.saveMeta(doc!.id, doc!.meta);
  drawMeasure(m);
}
function drawMeasure(m: lib.Measure) {
  const pts = m.pts.map(toLocal);
  const line = lineObj(pts, m.kind === 'area');
  line.name = `m:${m.id}`;
  viewer.overlay.add(line);
  const u = doc!.units;
  let html: string, at: THREE.Vector3;
  if (m.kind === 'dist') {
    const [a, b] = pts;
    const d = a.distanceTo(b);
    const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y), dz = Math.abs(b.z - a.z);
    html = `${fmt(d)} ${u}` + (doc!.mode === '2d' ? ` <small>Δx ${fmt(dx)} Δy ${fmt(dy)}</small>` : dz > d * 0.01 ? ` <small>Δh ${fmt(dz)}</small>` : '');
    at = a.clone().lerp(b, 0.5);
  } else {
    let per = 0;
    pts.forEach((p, i) => (per += p.distanceTo(pts[(i + 1) % pts.length])));
    html = `${fmt(polyArea(pts))} ${u}² <small>perimeter ${fmt(per)}</small>`;
    at = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(pts.length);
  }
  viewer.setLabel({
    id: `m:${m.id}`, pos: at, html, cls: 'dim',
    onTap: () => sheet('Measurement', `<p>${html}</p><div class="btns"><button id="delM">Delete</button></div>`, (b) => {
      b.querySelector<HTMLElement>('#delM')!.onclick = () => {
        doc!.meta.measures = doc!.meta.measures.filter((x) => x.id !== m.id);
        lib.saveMeta(doc!.id, doc!.meta);
        viewer.overlay.getObjectByName(`m:${m.id}`)?.removeFromParent();
        viewer.removeLabel(`m:${m.id}`);
        closeSheet();
      };
    }),
  });
}
function drawNotes() {
  viewer.clearLabels('n:');
  doc!.meta.notes.forEach((n, i) => {
    viewer.setLabel({ id: `n:${n.id}`, pos: toLocal([n.x, n.y, n.z]), html: `📍<b>${i + 1}</b>`, cls: 'pin', onTap: () => editNote(n) });
  });
}
function editNote(n: lib.Note | null, at?: THREE.Vector3) {
  sheet(n ? `Note ${doc!.meta.notes.indexOf(n) + 1}` : 'New note', `
    <textarea id="noteText" rows="4" placeholder="e.g. Socket height wrong, check with electrician">${esc(n?.text ?? '')}</textarea>
    ${n ? `<p class="muted">${new Date(n.created).toLocaleString()}</p>` : ''}
    <div class="btns"><button class="primary" id="noteSave">Save</button>${n ? '<button id="noteDel">Delete</button>' : ''}</div>`, (b) => {
    const ta = b.querySelector<HTMLTextAreaElement>('#noteText')!;
    if (!n) ta.focus();
    b.querySelector<HTMLElement>('#noteSave')!.onclick = () => {
      const text = ta.value.trim();
      if (!text) return toast('Write something first');
      if (n) n.text = text;
      else { const [x, y, z] = toReal(at!); doc!.meta.notes.push({ id: uid(), x, y, z, text, created: Date.now() }); }
      lib.saveMeta(doc!.id, doc!.meta);
      drawNotes();
      closeSheet();
    };
    b.querySelector<HTMLElement>('#noteDel')?.addEventListener('click', () => {
      doc!.meta.notes = doc!.meta.notes.filter((x) => x !== n);
      lib.saveMeta(doc!.id, doc!.meta);
      drawNotes();
      closeSheet();
    });
  });
}
function restoreAnnotations() {
  for (const m of doc!.meta.measures) drawMeasure(m);
  drawNotes();
}

// ---------------- tools ----------------
function setTool(t: Tool) {
  tool = tool === t ? 'none' : t;
  resetDraft();
  for (const b of document.querySelectorAll<HTMLElement>('#tools [data-tool]')) b.classList.toggle('on', b.dataset.tool === tool);
  if (tool === 'measure') hint('Tap two points. Snaps to corners and line ends.', [['Stop', () => setTool('measure')]]);
  else if (tool === 'area') drawDraft();
  else if (tool === 'note') hint('Tap where the note goes', [[`All notes (${doc?.meta.notes.length ?? 0})`, listNotes], ['Stop', () => setTool('note')]]);
  else hint(null);
}

function listNotes() {
  const notes = doc!.meta.notes;
  sheet('Notes', notes.length ? notes.map((n, i) => `<div class="row" data-i="${i}"><b>${i + 1}</b><span class="grow">${esc(n.text)}</span></div>`).join('') +
    '<div class="btns"><button id="exportNotes">Export as text</button></div>' : '<p class="muted">No notes yet.</p>', (b) => {
    b.querySelectorAll<HTMLElement>('.row').forEach((r) => (r.onclick = () => {
      const n = notes[+r.dataset.i!];
      closeSheet();
      viewer.focus(toLocal([n.x, n.y, n.z]), viewer.bounds.getSize(new THREE.Vector3()).length() / 40);
    }));
    b.querySelector<HTMLElement>('#exportNotes')?.addEventListener('click', () => {
      const txt = `${doc!.name}\n\n` + notes.map((n, i) => `${i + 1}. ${n.text}\n   at (${fmt(n.x)}, ${fmt(n.y)}, ${fmt(n.z)}) · ${new Date(n.created).toLocaleString()}`).join('\n');
      shareFile(new File([txt], `${doc!.name}-notes.txt`, { type: 'text/plain' }));
    });
  });
}

const actions: Record<string, () => void> = {
  fit: () => viewer.fit(),
  measure: () => setTool('measure'),
  area: () => setTool('area'),
  note: () => setTool('note'),
  layers: showLayers,
  find: showFind,
  compare: () => (compare ? exitCompare() : $('compareInput').click()),
  section: showSection,
  views: showViews,
  site: toggleSite,
  snap: snapshot,
};
for (const b of document.querySelectorAll<HTMLElement>('#tools [data-tool]')) b.onclick = () => actions[b.dataset.tool!]();

function showLayers() {
  let groups: { name: string; obj: THREE.Object3D; color: number }[];
  if (doc!.mode === '2d') {
    const src = compare ? [] : doc!.drawing!.layers;
    groups = src.map((l) => ({ name: l.name, obj: doc!.built!.layerGroups.get(l.name)!, color: l.color })).filter((g) => g.obj);
    if (compare) return toast('Layers are hidden during compare');
  } else {
    // SketchUp exports put groups/components as children; walk past single-child wrappers.
    let root: THREE.Object3D = doc!.model!;
    while (root.children.length === 1) root = root.children[0];
    groups = root.children.map((c, i) => ({ name: c.name || `Part ${i + 1}`, obj: c, color: -2 }));
  }
  if (!groups.length) return toast('No layers in this file');
  const sw = (c: number) => (c === -2 ? '' : `<span class="swatch" style="background:#${(c < 0 ? fgColor() : c).toString(16).padStart(6, '0')}"></span>`);
  sheet(doc!.mode === '2d' ? `Layers (${groups.length})` : `Parts (${groups.length})`,
    `<div class="btns" style="margin:0 0 8px"><button id="allOn">All on</button><button id="allOff">All off</button></div>` +
    groups.map((g, i) => `<label class="row"><input type="checkbox" data-i="${i}" ${g.obj.visible ? 'checked' : ''}>${sw(g.color)}<span class="grow">${esc(g.name)}</span></label>`).join(''),
    (b) => {
      const sync = () => { viewer.refreshSnap(); viewer.requestRender(); };
      b.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((cb) => (cb.onchange = () => { groups[+cb.dataset.i!].obj.visible = cb.checked; sync(); }));
      const all = (v: boolean) => { groups.forEach((g) => (g.obj.visible = v)); b.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((c) => (c.checked = v)); sync(); };
      b.querySelector<HTMLElement>('#allOn')!.onclick = () => all(true);
      b.querySelector<HTMLElement>('#allOff')!.onclick = () => all(false);
    });
}

function showFind() {
  const texts = doc!.built!.texts;
  sheet('Find text', `<input type="search" id="q" placeholder="Room number, door tag, note…" autocomplete="off"><div id="res"></div>`, (b) => {
    const q = b.querySelector<HTMLInputElement>('#q')!;
    const res = b.querySelector<HTMLElement>('#res')!;
    const run = () => {
      const s = q.value.trim().toLowerCase();
      if (!s) { res.innerHTML = `<p class="muted">${texts.length.toLocaleString()} text labels in this drawing.</p>`; return; }
      const hits = texts.filter((t) => t.value.toLowerCase().includes(s));
      res.innerHTML = hits.length ? hits.slice(0, 200).map((t, i) => `<div class="row" data-i="${i}"><span class="grow">${esc(t.value)}</span></div>`).join('') +
        (hits.length > 200 ? `<p class="muted">+${hits.length - 200} more</p>` : '') : '<p class="muted">No matches</p>';
      res.querySelectorAll<HTMLElement>('.row').forEach((r) => (r.onclick = () => {
        const t = hits[+r.dataset.i!];
        closeSheet();
        viewer.focus(t.pos, Math.max(t.height * 8, 1e-6));
        viewer.setLabel({ id: 'hit', pos: t.pos, html: '', cls: 'hit' });
        setTimeout(() => viewer.removeLabel('hit'), 3500);
      }));
    };
    q.oninput = run;
    run();
    q.focus();
  });
}

// ---- revision compare ----
$<HTMLInputElement>('compareInput').onchange = async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!f || !doc?.drawing) return;
  toast('Comparing…', 60000);
  try {
    const other = await parseDxfText(await f.arrayBuffer());
    const result = diffDrawings(doc.drawing.primitives, other.primitives);
    compare = { name: f.name, drawing: other, result, onlyChanges: false };
    renderCompare();
    toast(result.added + result.removed ? `${result.added} added, ${result.removed} removed` : 'No geometric differences found');
  } catch (err: any) {
    toast(`Could not compare: ${err?.message ?? err}`, 6000);
  }
};
function renderCompare() {
  const c = compare!;
  const items = c.onlyChanges ? c.result.items.filter((i) => i.state !== 'same') : c.result.items;
  const built = build2D(items.map((i) => i.prim), doc!.origin, fgColor(), (_p, i) => diffColor(items[i].state));
  viewer.setContent(built.root, '2d');
  restoreAnnotations();
  const lg = $('legend');
  lg.innerHTML = `<div><b>${esc(doc!.name)}</b> → <b>${esc(c.name)}</b></div>
    <div><i style="background:#22c55e"></i>Added ${c.result.added}</div>
    <div><i style="background:#ef4444"></i>Removed ${c.result.removed}</div>
    <div><i style="background:#8a8f98"></i>Unchanged ${c.result.same}</div>
    <div class="btns" style="margin-top:6px;display:flex;gap:6px"><button id="onlyCh">${c.onlyChanges ? 'Show all' : 'Only changes'}</button><button id="exitCmp">Exit</button></div>`;
  lg.hidden = false;
  lg.querySelector<HTMLElement>('#onlyCh')!.onclick = () => { c.onlyChanges = !c.onlyChanges; renderCompare(); };
  lg.querySelector<HTMLElement>('#exitCmp')!.onclick = exitCompare;
  document.querySelector('#tools [data-tool=compare]')!.classList.add('on');
}
function exitCompare() {
  compare = null;
  $('legend').hidden = true;
  document.querySelector('#tools [data-tool=compare]')!.classList.remove('on');
  viewer.setContent(doc!.built!.root, '2d');
  restoreAnnotations();
}

// ---- 3D section & views ----
function showSection() {
  const s = viewer.section;
  sheet('Section cut', `
    <label class="row"><input type="checkbox" id="secOn" ${s.enabled ? 'checked' : ''}><span class="grow">Cut the model</span></label>
    <input type="range" id="secT" min="0" max="1" step="0.002" value="${s.t}">
    <div class="btns">${['X', 'Y (height)', 'Z'].map((a, i) => `<button data-ax="${i}" class="${s.axis === i ? 'on' : ''}">${a}</button>`).join('')}<button id="secFlip">Flip side</button></div>
    <p class="muted">Use Y to cut a building horizontally and see a floor plan.</p>`, (b) => {
    const on = b.querySelector<HTMLInputElement>('#secOn')!;
    on.onchange = () => { s.enabled = on.checked; viewer.applySection(); };
    b.querySelector<HTMLInputElement>('#secT')!.oninput = (e) => { s.t = +(e.target as HTMLInputElement).value; s.enabled = on.checked = true; viewer.applySection(); };
    b.querySelectorAll<HTMLElement>('[data-ax]').forEach((btn) => (btn.onclick = () => {
      s.axis = +btn.dataset.ax! as 0 | 1 | 2;
      b.querySelectorAll('[data-ax]').forEach((x) => x.classList.toggle('on', x === btn));
      s.enabled = on.checked = true;
      viewer.applySection();
    }));
    b.querySelector<HTMLElement>('#secFlip')!.onclick = () => { s.flip = !s.flip; viewer.applySection(); };
  });
}
function showViews() {
  sheet('Views', `<div class="btns">${['top', 'front', 'side', 'iso'].map((v) => `<button data-v="${v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div>
    <div class="btns"><button id="zup">Model is lying on its side? Stand it up</button></div>`, (b) => {
    b.querySelectorAll<HTMLElement>('[data-v]').forEach((btn) => (btn.onclick = () => viewer.view(btn.dataset.v as any)));
    b.querySelector<HTMLElement>('#zup')!.onclick = () => {
      const m = doc!.model!;
      m.rotation.x = m.rotation.x === 0 ? -Math.PI / 2 : 0; // Z-up (SketchUp/OBJ) → Y-up
      viewer.setContent(m, '3d');
      restoreAnnotations();
    };
  });
}

function toggleSite() {
  site = !site;
  document.body.classList.toggle('site', site);
  document.querySelector('#tools [data-tool=site]')!.classList.toggle('on', site);
  viewer.setBackground(bgColor());
  for (const m of doc?.built?.fgMaterials ?? []) (m as any).color.setHex(fgColor());
  if (compare) renderCompare();
  requestAnimationFrame(() => viewer.resize());
}

// ---- snapshot with markups, shared through the phone's share sheet ----
function snapshot() {
  viewer.renderer.render(viewer.scene, viewer.camera);
  const src = viewer.renderer.domElement;
  const out = document.createElement('canvas');
  out.width = src.width; out.height = src.height + 60;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = site ? '#fff' : '#0f1115';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(src, 0, 0);
  const k = src.width / src.clientWidth;
  ctx.font = `${13 * k}px sans-serif`;
  for (const { el, pos } of viewer.labelEntries()) {
    const s = viewer.toScreen(pos);
    if (!s.visible) continue;
    const x = s.x * k, y = s.y * k;
    if (el.classList.contains('pin')) {
      ctx.fillStyle = '#ef4444';
      ctx.beginPath(); ctx.arc(x, y - 12 * k, 10 * k, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(el.textContent!.replace('📍', ''), x, y - 8 * k);
    } else if (el.classList.contains('dim')) {
      const t = el.textContent!;
      const w = ctx.measureText(t).width + 12 * k;
      ctx.fillStyle = '#111c'; ctx.fillRect(x - w / 2, y - 14 * k, w, 20 * k);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(t, x, y + 1 * k);
    }
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = site ? '#000' : '#e8eaee';
  ctx.font = `${16 * Math.max(1, k / 1.5)}px sans-serif`;
  ctx.fillText(`${doc?.name ?? ''} · ${new Date().toLocaleString()}`, 16, src.height + 38);
  out.toBlob((blob) => blob && shareFile(new File([blob], `${(doc?.name ?? 'view').replace(/\.\w+$/, '')}-markup.png`, { type: 'image/png' })), 'image/png');
}
async function shareFile(file: File) {
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: file.name }); return; }
  } catch (e: any) { if (e?.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// Offline for the browser/PWA build (the native app bundles everything already).
if ('serviceWorker' in navigator && location.protocol === 'https:' && !(window as any).Capacitor) navigator.serviceWorker.register('sw.js');

showHome();
(window as any).cadview = { openBytes, viewer }; // used by tests
