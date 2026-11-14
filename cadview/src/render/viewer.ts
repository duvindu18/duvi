import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { GestureControls, type GestureHandlers, type Mode } from './controls';
import { nearest, type SnapGrid } from '../cad/snapgrid';
import { textUniforms } from './text';
import { visibleCount } from '../cad/tiles';

(THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
(THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export type { Mode };
export interface Pick { point: THREE.Vector3; snapped: boolean }
export interface Label { id: string; pos: THREE.Vector3; html: string; cls: string; onTap?: () => void }

export const SNAP_PX = 22;

/**
 * Renders only when something changes (battery), drops resolution while a heavy scene is
 * moving and restores full sharpness the moment fingers stop.
 */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly content = new THREE.Group();
  readonly overlay = new THREE.Group();
  readonly cam2 = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e7, 1e7);
  readonly cam3 = new THREE.PerspectiveCamera(45, 1, 0.01, 1e7);
  readonly controls: GestureControls;
  mode: Mode = '2d';
  bounds = new THREE.Box3();
  section = { enabled: false, axis: 1 as 0 | 1 | 2, t: 0.5, flip: false };
  snap: { grid: SnapGrid | null; accept?: (tag: number) => boolean } = { grid: null };
  handlers: GestureHandlers = {};
  /** 2D level of detail: per tile, draw only segments longer than ~1 px */
  lod: { geom: THREE.BufferGeometry; len: Float32Array; text?: boolean }[] = [];
  /** 3D level of detail hook (SketchUp components) */
  lod3d: ((cam: THREE.PerspectiveCamera, heightPx: number) => void) | null = null;
  onFrame?: () => void;
  private plane = new THREE.Plane();
  private labels = new Map<string, { el: HTMLElement; pos: THREE.Vector3 }>();
  private pending = false;
  private fullRatio = Math.min(window.devicePixelRatio || 1, 2);
  private ratio = this.fullRatio;
  private frames: number[] = [];
  private moving = false;
  private restoreTimer = 0;
  private ray = new THREE.Raycaster();
  /** loupe: magnified view under the finger for precise placement */
  loupe: { el: HTMLCanvasElement; x: number; y: number; active: boolean; snapped: THREE.Vector3 | null };

  constructor(private host: HTMLElement, private labelLayer: HTMLElement, loupeEl: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.ratio);
    this.renderer.localClippingEnabled = false;
    host.appendChild(this.renderer.domElement);
    this.scene.add(this.content, this.overlay);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(1, 2, 1.5);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-1.5, 0.5, -1);
    this.scene.add(sun, fill);
    this.loupe = { el: loupeEl, x: 0, y: 0, active: false, snapped: null };
    (this.ray as any).firstHitOnly = true;

    this.controls = new GestureControls(this.renderer.domElement, this.cam2, this.cam3, {
      tap: (x, y) => this.handlers.tap?.(x, y),
      doubleTap: (x, y) => this.handlers.doubleTap?.(x, y),
      longPress: (x, y) => this.handlers.longPress?.(x, y),
      pressMove: (x, y) => this.handlers.pressMove?.(x, y),
      pressEnd: (x, y) => this.handlers.pressEnd?.(x, y),
      hit: (x, y) => this.hit(x, y),
      change: () => this.requestRender(),
      interacting: (on) => this.setMoving(on),
    });
    new ResizeObserver(() => this.resize()).observe(host);
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => e.preventDefault());
    this.renderer.domElement.addEventListener('webglcontextrestored', () => this.requestRender());
    this.resize();
  }

  get camera(): THREE.Camera { return this.mode === '2d' ? this.cam2 : this.cam3; }
  get maxTexture() { return this.renderer.capabilities.maxTextureSize; }

  setBackground(color: number) { this.scene.background = new THREE.Color(color); this.requestRender(); }

  /** Fit padding in CSS px, so content isn't hidden under the floating bars. */
  padding = { top: 0, right: 0, bottom: 0, left: 0 };

  setContent(obj: THREE.Object3D, mode: Mode, o: { bounds?: THREE.Box3; dispose?: boolean; fit?: boolean } = {}) {
    if (o.dispose !== false) Viewer.dispose(this.content); else this.content.clear();
    this.overlay.clear();
    this.clearLabels();
    this.content.add(obj);
    this.mode = mode;
    this.controls.mode = mode;
    this.content.updateMatrixWorld(true);
    if (o.bounds) this.bounds.copy(o.bounds); else this.bounds.setFromObject(this.content, true);
    const size = this.bounds.getSize(new THREE.Vector3()).length() || 1;
    Object.assign(this.controls.limits, { minScale: size * 1e-7, maxScale: size, minDist: size * 1e-4, maxDist: size * 20 });
    this.section.enabled = false;
    this.applySection();
    if (o.fit !== false) this.fit(false); else this.controls.apply();
  }

  /** Free GPU memory of a scene graph: crucial when opening several big files in a row. */
  static dispose(root: THREE.Object3D) {
    root.traverse((o: any) => {
      o.geometry?.disposeBoundsTree?.();
      o.geometry?.dispose?.();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) { for (const v of Object.values(m)) if ((v as any)?.isTexture && !(v as any).userData?.shared) (v as THREE.Texture).dispose(); m.dispose(); }
    });
    root.clear();
  }

  fit(animate = true) {
    const b = this.bounds;
    if (b.isEmpty()) return;
    const size = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    const P = this.padding, aw = Math.max(40, w - P.left - P.right), ah = Math.max(40, h - P.top - P.bottom);
    if (this.mode === '2d') {
      const scale = Math.max(size.x / (aw * 0.92), size.y / (ah * 0.92), 1e-9);
      // place the drawing centre in the middle of the *visible* area
      const centre = this.controls.centreFor(c.x, c.y, P.left + aw / 2, P.top + ah / 2, scale, 0);
      const to = { x: centre.x, y: centre.y, scale, rot: 0 };
      if (animate) this.controls.animate2D(to); else { this.controls.v2 = to; this.controls.apply(); }
    } else {
      const r = size.length() / 2 || 1;
      // half-angles of the visible (unobstructed) area, vertical and horizontal
      const t = Math.tan((this.cam3.fov * Math.PI) / 360);
      const half = Math.min(Math.atan((t * ah) / h), Math.atan((t * aw) / h));
      const to = { target: c, dist: (r / Math.sin(half)) * 1.02, yaw: 0.65, pitch: 0.5 };
      if (animate) this.controls.animate3D(to);
      else { Object.assign(this.controls.v3, to); this.controls.v3.target = c.clone(); this.controls.apply(); }
    }
  }

  view(dir: 'top' | 'front' | 'side' | 'iso' | 'back') {
    if (this.mode === '2d') return this.fit();
    const v = { top: [0, 1.553], front: [0, 0.08], back: [Math.PI, 0.08], side: [Math.PI / 2, 0.08], iso: [0.65, 0.5] }[dir];
    this.controls.animate3D({ yaw: v[0], pitch: v[1], target: this.bounds.getCenter(new THREE.Vector3()) });
  }

  /** Smoothly bring a point into view at a size where `radius` fills about a quarter of the screen. */
  focus(p: THREE.Vector3, radius: number) {
    const h = this.host.clientHeight || 1;
    if (this.mode === '2d') this.controls.animate2D({ x: p.x, y: p.y, scale: (radius * 4) / h }, 380);
    else this.controls.animate3D({ target: p.clone(), dist: radius * 6 });
  }

  applySection() {
    const s = this.section;
    if (!s.enabled || this.bounds.isEmpty()) this.renderer.clippingPlanes = [];
    else {
      const n = new THREE.Vector3().setComponent(s.axis, s.flip ? 1 : -1);
      const lo = this.bounds.min.getComponent(s.axis), hi = this.bounds.max.getComponent(s.axis);
      const at = lo + (hi - lo) * s.t;
      this.plane.set(n, s.flip ? -at : at);
      this.renderer.clippingPlanes = [this.plane];
    }
    this.requestRender();
  }

  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.controls.apply();
  }

  // ---------- adaptive resolution ----------
  private setMoving(on: boolean) {
    this.moving = on;
    clearTimeout(this.restoreTimer);
    if (on) this.frames = [];
    else this.restoreTimer = window.setTimeout(() => {
      if (this.ratio !== this.fullRatio) { this.ratio = this.fullRatio; this.renderer.setPixelRatio(this.ratio); this.resize(); }
      this.requestRender();
    }, 120);
  }
  private trackFrame(t: number) {
    if (!this.moving) return;
    this.frames.push(t);
    if (this.frames.length < 6) return;
    const f = this.frames.slice(-6), avg = (f[5] - f[0]) / 5;
    if (avg > 26 && this.ratio > 0.75) { // under ~38 fps: trade sharpness for smoothness while moving
      this.ratio = Math.max(0.75, this.ratio * 0.7);
      this.renderer.setPixelRatio(this.ratio);
      this.renderer.setSize(this.host.clientWidth, this.host.clientHeight, false);
      this.frames = [];
    }
  }

  requestRender() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame((t) => {
      this.pending = false;
      this.trackFrame(t);
      this.updateLod();
      this.renderer.render(this.scene, this.camera);
      if (this.loupe.active) this.drawLoupe();
      this.positionLabels();
      this.onFrame?.();
    });
  }

  private updateLod() {
    const ppu = this.controls.pixelsPerUnit();
    textUniforms.uPPU.value = ppu;
    if (this.mode !== '2d') { this.cam3.updateMatrixWorld(); this.lod3d?.(this.cam3, this.host.clientHeight || 1); return; }
    const minLen = 0.7 / ppu; // shorter than ~0.7 px: invisible, skip it
    const minText = textUniforms.uMinPx.value / ppu; // text smaller than this is unreadable: don't draw it
    for (const t of this.lod) {
      if (t.text) (t.geom as THREE.InstancedBufferGeometry).instanceCount = visibleCount(t.len, minText * 0.999);
      else t.geom.setDrawRange(0, visibleCount(t.len, minLen) * 2);
    }
  }

  /** Render now and copy the frame into a 2D canvas (for sharing). */
  capture(): HTMLCanvasElement {
    this.updateLod();
    this.renderer.render(this.scene, this.camera);
    const src = this.renderer.domElement;
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    c.getContext('2d')!.drawImage(src, 0, 0);
    return c;
  }

  pixelsPerUnit(at?: THREE.Vector3) { return this.controls.pixelsPerUnit(at); }

  toScreen(p: THREE.Vector3): { x: number; y: number; visible: boolean } {
    const v = p.clone().project(this.camera);
    return { x: ((v.x + 1) / 2) * this.host.clientWidth, y: ((1 - v.y) / 2) * this.host.clientHeight, visible: v.z > -1 && v.z < 1 };
  }

  // ---------- picking ----------
  private rayAt(x: number, y: number) {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    this.ray.setFromCamera(new THREE.Vector2((x / w) * 2 - 1, -(y / h) * 2 + 1), this.camera);
    return this.ray;
  }
  /** first visible surface under a screen point (3D) */
  hit(x: number, y: number): THREE.Vector3 | null {
    if (this.mode === '2d') { const [wx, wy] = this.controls.screenToWorld2D(x, y); return new THREE.Vector3(wx, wy, 0); }
    const clip = this.renderer.clippingPlanes[0];
    const hits = this.rayAt(x, y).intersectObject(this.content, true);
    const h = hits.find((i) => (!clip || clip.distanceToPoint(i.point) >= 0) && (i.object as any).isMesh);
    return h ? h.point.clone() : null;
  }

  /** Point under the finger, snapped to the nearest real corner / endpoint / centre within SNAP_PX. */
  pick(x: number, y: number): Pick | null {
    const g = this.snap.grid;
    if (this.mode === '2d') {
      const [wx, wy] = this.controls.screenToWorld2D(x, y);
      if (g) {
        const i = nearest(g, wx, wy, 0, SNAP_PX * this.controls.v2.scale, this.snap.accept);
        if (i >= 0) return { point: new THREE.Vector3(g.pts[i * 3], g.pts[i * 3 + 1], g.pts[i * 3 + 2]), snapped: true };
      }
      return { point: new THREE.Vector3(wx, wy, 0), snapped: false };
    }
    const p = this.hit(x, y);
    if (!p) return null;
    if (g) {
      const r = SNAP_PX / this.pixelsPerUnit(p);
      const clip = this.renderer.clippingPlanes[0];
      const i = nearest(g, p.x, p.y, p.z, r, (t) => (this.snap.accept ? this.snap.accept(t) : true), true);
      if (i >= 0) {
        const v = new THREE.Vector3(g.pts[i * 3], g.pts[i * 3 + 1], g.pts[i * 3 + 2]);
        const cam = this.cam3.position;
        // only accept a vertex that is not hidden behind the surface we touched
        if ((!clip || clip.distanceToPoint(v) >= 0) && cam.distanceTo(v) <= cam.distanceTo(p) + r) return { point: v, snapped: true };
      }
    }
    return { point: p, snapped: false };
  }

  // ---------- loupe ----------
  showLoupe(x: number, y: number, snapped: THREE.Vector3 | null) {
    Object.assign(this.loupe, { x, y, active: true, snapped });
    this.loupe.el.hidden = false;
    this.requestRender();
  }
  hideLoupe() { this.loupe.active = false; this.loupe.el.hidden = true; }
  private drawLoupe() {
    const L = this.loupe, c = L.el, src = this.renderer.domElement;
    const size = c.clientWidth || 120, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== size * dpr) { c.width = c.height = size * dpr; }
    const ctx = c.getContext('2d')!;
    const k = src.width / (this.host.clientWidth || 1);
    const zoom = 2.5, srcSize = (size / zoom) * k;
    ctx.save();
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.beginPath(); ctx.arc(c.width / 2, c.height / 2, c.width / 2, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(src, L.x * k - srcSize / 2, L.y * k - srcSize / 2, srcSize, srcSize, 0, 0, c.width, c.height);
    const m = c.width / 2;
    ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.moveTo(m - 12 * dpr, m); ctx.lineTo(m + 12 * dpr, m); ctx.moveTo(m, m - 12 * dpr); ctx.lineTo(m, m + 12 * dpr); ctx.stroke();
    if (L.snapped) {
      const s = this.toScreen(L.snapped);
      const sx = m + (s.x - L.x) * zoom * dpr, sy = m + (s.y - L.y) * zoom * dpr;
      ctx.strokeStyle = '#facc15'; ctx.lineWidth = 3 * dpr;
      ctx.strokeRect(sx - 7 * dpr, sy - 7 * dpr, 14 * dpr, 14 * dpr);
    }
    ctx.restore();
    c.style.transform = `translate(${L.x - size / 2}px, ${Math.max(4, L.y - size - 56)}px)`;
  }

  // ---------- HTML labels pinned to world positions ----------
  setLabel(l: Label) {
    let entry = this.labels.get(l.id);
    if (!entry) {
      const el = document.createElement('div');
      this.labelLayer.appendChild(el);
      entry = { el, pos: l.pos };
      this.labels.set(l.id, entry);
    }
    entry.pos = l.pos;
    entry.el.className = `label ${l.cls}`;
    entry.el.innerHTML = l.html;
    entry.el.onclick = l.onTap ? (ev) => { ev.stopPropagation(); l.onTap!(); } : null;
    this.requestRender();
  }
  removeLabel(id: string) { this.labels.get(id)?.el.remove(); this.labels.delete(id); this.requestRender(); }
  clearLabels(prefix = '') { for (const id of [...this.labels.keys()]) if (id.startsWith(prefix)) this.removeLabel(id); }
  labelEntries() { return [...this.labels.values()]; }
  private positionLabels() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    for (const { el, pos } of this.labels.values()) {
      const s = this.toScreen(pos);
      const on = s.visible && s.x > -40 && s.y > -40 && s.x < w + 40 && s.y < h + 40;
      el.style.display = on ? '' : 'none';
      if (on) el.style.transform = `translate(${s.x}px, ${s.y}px)`;
    }
  }

  /** Build BVHs for raycasting a little at a time, so big models stay responsive right after opening. */
  prepareRaycast() {
    const meshes: THREE.Mesh[] = [];
    this.content.traverse((o: any) => { if (o.isMesh && !o.geometry.boundsTree && !(o.geometry as any).isInstancedBufferGeometry) meshes.push(o); });
    const step = () => {
      const t0 = performance.now();
      while (meshes.length && performance.now() - t0 < 12) (meshes.pop()!.geometry as any).computeBoundsTree();
      if (meshes.length) setTimeout(step, 16);
    };
    setTimeout(step, 50);
  }
}
