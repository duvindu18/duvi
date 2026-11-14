import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type Mode = '2d' | '3d';
export interface Pick { point: THREE.Vector3; snapped: boolean }
export interface Label { id: string; pos: THREE.Vector3; html: string; cls: string; onTap?: () => void }

const SNAP_PX = 24;

/**
 * Battery-friendly viewer: renders only when something changes (no constant 60fps loop),
 * which matters on phones used all day on site.
 */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly content = new THREE.Group();
  readonly overlay = new THREE.Group();
  persp = new THREE.PerspectiveCamera(50, 1, 0.01, 1e7);
  ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e7, 1e7);
  camera: THREE.Camera = this.persp;
  controls: OrbitControls;
  mode: Mode = '3d';
  bounds = new THREE.Box3();
  section = { enabled: false, axis: 1 as 0 | 1 | 2, t: 0.5, flip: false };
  private plane = new THREE.Plane();
  private snapVerts = new Float32Array(0);
  private labels = new Map<string, { el: HTMLElement; pos: THREE.Vector3 }>();
  private pending = false;
  onRender?: () => void;

  constructor(private host: HTMLElement, private labelLayer: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);
    this.scene.add(this.content, this.overlay);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(1, 2, 1.5);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-1.5, 0.5, -1);
    this.scene.add(sun, fill);
    this.controls = this.makeControls();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  private makeControls() {
    const c = new OrbitControls(this.camera, this.renderer.domElement);
    c.enableDamping = false;
    c.screenSpacePanning = true;
    c.zoomToCursor = true;
    c.addEventListener('change', () => this.requestRender());
    return c;
  }

  setBackground(color: number) {
    this.scene.background = new THREE.Color(color);
    this.requestRender();
  }

  setContent(obj: THREE.Object3D, mode: Mode) {
    this.content.clear();
    this.overlay.clear();
    this.clearLabels();
    this.content.add(obj);
    this.mode = mode;
    this.camera = mode === '2d' ? this.ortho : this.persp;
    this.controls.dispose();
    this.controls = this.makeControls();
    if (mode === '2d') {
      this.controls.enableRotate = false;
      this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
      this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    }
    this.content.updateMatrixWorld(true);
    this.bounds.setFromObject(this.content);
    this.refreshSnap();
    this.section.enabled = false;
    this.applySection();
    this.fit();
  }

  /** Vertex cloud used for snapping measurements to real corners/endpoints. */
  refreshSnap() {
    const chunks: Float32Array[] = [];
    let total = 0;
    const v = new THREE.Vector3();
    this.content.traverseVisible((o: any) => {
      const pos = o.geometry?.attributes?.position;
      if (!pos || o.userData.noSnap) return;
      const arr = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        arr[i * 3] = v.x; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z;
      }
      chunks.push(arr);
      total += arr.length;
    });
    this.snapVerts = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { this.snapVerts.set(c, off); off += c.length; }
  }

  fit(box = this.bounds) {
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const { clientWidth: w, clientHeight: h } = this.host;
    const aspect = w / Math.max(h, 1);
    if (this.mode === '2d') {
      const half = Math.max(size.x / aspect, size.y) * 0.55 || 1;
      Object.assign(this.ortho, { left: -half * aspect, right: half * aspect, top: half, bottom: -half, zoom: 1 });
      this.ortho.position.set(center.x, center.y, center.z + 1000);
      this.ortho.up.set(0, 1, 0);
      this.ortho.updateProjectionMatrix();
    } else {
      const r = size.length() / 2 || 1;
      // Use the narrower of the vertical/horizontal FOV, otherwise portrait phones crop the sides.
      const vHalf = (this.persp.fov * Math.PI) / 360;
      const half = Math.min(vHalf, Math.atan(Math.tan(vHalf) * aspect));
      const dist = (r / Math.sin(half)) * 1.05;
      this.persp.near = r / 1000;
      this.persp.far = r * 1000;
      this.persp.position.copy(center).add(new THREE.Vector3(0.8, 0.6, 1).normalize().multiplyScalar(dist));
      this.persp.updateProjectionMatrix();
    }
    this.controls.target.copy(center);
    this.controls.update();
    this.requestRender();
  }

  /** Standard views for 3D: front / top / side / iso. */
  view(dir: 'top' | 'front' | 'side' | 'iso') {
    if (this.mode === '2d') return this.fit();
    const c = this.bounds.getCenter(new THREE.Vector3());
    const d = this.persp.position.distanceTo(this.controls.target);
    const v = { top: [0, 1, 0.0001], front: [0, 0, 1], side: [1, 0, 0], iso: [0.8, 0.6, 1] }[dir];
    this.persp.position.copy(c).add(new THREE.Vector3(...(v as [number, number, number])).normalize().multiplyScalar(d));
    this.controls.target.copy(c);
    this.controls.update();
  }

  applySection() {
    const s = this.section;
    if (!s.enabled || this.bounds.isEmpty()) {
      this.renderer.clippingPlanes = [];
    } else {
      const n = new THREE.Vector3().setComponent(s.axis, s.flip ? 1 : -1);
      const lo = this.bounds.min.getComponent(s.axis), hi = this.bounds.max.getComponent(s.axis);
      const at = lo + (hi - lo) * s.t;
      this.plane.set(n, s.flip ? -at : at);
      this.renderer.clippingPlanes = [this.plane];
    }
    this.requestRender();
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    const halfH = (this.ortho.top - this.ortho.bottom) / 2;
    const cx = (this.ortho.left + this.ortho.right) / 2;
    this.ortho.left = cx - halfH * (w / h);
    this.ortho.right = cx + halfH * (w / h);
    this.ortho.updateProjectionMatrix();
    this.requestRender();
  }

  requestRender() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.renderer.render(this.scene, this.camera);
      this.positionLabels();
      this.onRender?.();
    });
  }

  /** Screen-space units per world unit, used to keep markers a constant tap-able size. */
  pixelSize(at: THREE.Vector3): number {
    const h = this.host.clientHeight || 1;
    if (this.mode === '2d') return (this.ortho.top - this.ortho.bottom) / this.ortho.zoom / h;
    const d = this.persp.position.distanceTo(at);
    return (2 * d * Math.tan((this.persp.fov * Math.PI) / 360)) / h;
  }

  toScreen(p: THREE.Vector3): { x: number; y: number; visible: boolean } {
    const v = p.clone().project(this.camera);
    return {
      x: ((v.x + 1) / 2) * this.host.clientWidth,
      y: ((1 - v.y) / 2) * this.host.clientHeight,
      visible: v.z > -1 && v.z < 1,
    };
  }

  /** Pick a point under the finger, snapping to the nearest real vertex within SNAP_PX. */
  pick(clientX: number, clientY: number): Pick | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const sx = clientX - rect.left, sy = clientY - rect.top;
    const w = rect.width, h = rect.height;
    const m = new THREE.Matrix4().multiplyMatrices((this.camera as any).projectionMatrix, this.camera.matrixWorldInverse);
    const e = m.elements;
    const verts = this.snapVerts;
    const clip = this.renderer.clippingPlanes[0];
    let best = -1, bestD = SNAP_PX * SNAP_PX;
    for (let i = 0; i < verts.length; i += 3) {
      const x = verts[i], y = verts[i + 1], z = verts[i + 2];
      const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (cw <= 0 && this.mode === '3d') continue;
      const px = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / cw + 1) * 0.5 * w;
      const py = (1 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw) * 0.5 * h;
      const d = (px - sx) ** 2 + (py - sy) ** 2;
      if (d < bestD) {
        if (clip && clip.distanceToPoint(new THREE.Vector3(x, y, z)) < 0) continue;
        bestD = d; best = i;
      }
    }
    const ndc = new THREE.Vector2((sx / w) * 2 - 1, -(sy / h) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    // In 3D prefer a surface hit when it is clearly in front of the snapped vertex (avoids snapping "through" walls).
    if (this.mode === '3d') {
      ray.params.Line = { threshold: this.pixelSize(this.controls.target) * 4 };
      const hit = ray.intersectObject(this.content, true).find((h) => !clip || clip.distanceToPoint(h.point) >= 0);
      if (best >= 0) {
        const vp = new THREE.Vector3(verts[best], verts[best + 1], verts[best + 2]);
        const camPos = (this.camera as THREE.PerspectiveCamera).position;
        if (!hit || camPos.distanceTo(vp) <= hit.distance * 1.02) return { point: vp, snapped: true };
      }
      return hit ? { point: hit.point.clone(), snapped: false } : null;
    }
    if (best >= 0) return { point: new THREE.Vector3(verts[best], verts[best + 1], verts[best + 2]), snapped: true };
    const p = new THREE.Vector3();
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), p) ? { point: p, snapped: false } : null;
  }

  // ---- HTML labels pinned to world positions (measurements, notes, search hits) ----
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
  removeLabel(id: string) {
    this.labels.get(id)?.el.remove();
    this.labels.delete(id);
    this.requestRender();
  }
  clearLabels(prefix = '') {
    for (const id of [...this.labels.keys()]) if (id.startsWith(prefix)) this.removeLabel(id);
  }
  labelEntries() {
    return [...this.labels.values()];
  }
  private positionLabels() {
    for (const { el, pos } of this.labels.values()) {
      const s = this.toScreen(pos);
      el.style.display = s.visible ? '' : 'none';
      el.style.transform = `translate(${s.x}px, ${s.y}px)`;
    }
  }

  /** Fly the 2D/3D camera to centre on a point and zoom so `radius` fills the view. */
  focus(p: THREE.Vector3, radius: number) {
    if (this.mode === '2d') {
      const delta = p.clone().sub(this.controls.target);
      this.ortho.position.add(delta);
      this.controls.target.copy(p);
      this.ortho.zoom = (this.ortho.top - this.ortho.bottom) / (radius * 4);
      this.ortho.updateProjectionMatrix();
    } else {
      const dir = this.persp.position.clone().sub(this.controls.target).normalize();
      this.controls.target.copy(p);
      this.persp.position.copy(p).add(dir.multiplyScalar(radius * 6));
    }
    this.controls.update();
  }
}
