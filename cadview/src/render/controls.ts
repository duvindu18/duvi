// Touch-first camera controller.
// 2D: 1 finger pan · pinch zoom about the fingers · twist rotate · fling with momentum.
// 3D: 1 finger orbit · 2 fingers pinch zoom toward what's under them + pan · twist spins.
// Both: double-tap zoom in (3D: also re-centres the orbit there) · two-finger tap zoom out ·
// long-press for a context action · mouse wheel / drag for desktop.
import * as THREE from 'three';

export type Mode = '2d' | '3d';
export interface View2D { x: number; y: number; scale: number; rot: number } // scale = world units per CSS px
export interface View3D { target: THREE.Vector3; dist: number; yaw: number; pitch: number }

export interface GestureHandlers {
  tap?(x: number, y: number): void;
  doubleTap?(x: number, y: number): boolean | void; // return true if handled (suppresses default zoom)
  longPress?(x: number, y: number): void;
  /** while a long-press is held and the finger moves (precision placement with the loupe) */
  pressMove?(x: number, y: number): void;
  pressEnd?(x: number, y: number): void;
  change?(): void;
  interacting?(active: boolean): void;
  /** world point under a screen point (3D anchor for zoom / double-tap) */
  hit?(x: number, y: number): THREE.Vector3 | null;
}

const TAP_MOVE = 10, TAP_MS = 300, DOUBLE_MS = 320, LONG_MS = 480, ROT_START = 0.14; // rad before a twist starts rotating

export class GestureControls {
  mode: Mode = '2d';
  v2: View2D = { x: 0, y: 0, scale: 1, rot: 0 };
  v3: View3D = { target: new THREE.Vector3(), dist: 10, yaw: 0.6, pitch: 0.5 };
  rotate2D = true;
  limits = { minScale: 1e-6, maxScale: 1e6, minDist: 1e-3, maxDist: 1e7 };
  enabled = true;
  private pts = new Map<number, { x: number; y: number; x0: number; y0: number; t0: number }>();
  private anim = 0;
  private inertia = { vx: 0, vy: 0, active: false };
  private lastMove = { t: 0, x: 0, y: 0 };
  private longTimer = 0;
  private pressing = false;
  private lastTap = { t: 0, x: 0, y: 0 };
  private twoTap = { t: 0, moved: false, active: false };
  private pinch: null | { d0: number; a0: number; cx: number; cy: number; v2: View2D; world: [number, number]; rotOn: boolean; prevD: number; prevA: number; prevCx: number; prevCy: number; anchor: THREE.Vector3 | null } = null;
  private pan: null | { world: [number, number] } = null;
  private interactingFlag = false;

  constructor(private el: HTMLElement, public cam2: THREE.OrthographicCamera, public cam3: THREE.PerspectiveCamera, public h: GestureHandlers) {
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', this.down);
    el.addEventListener('pointermove', this.move);
    el.addEventListener('pointerup', this.up);
    el.addEventListener('pointercancel', this.cancel);
    el.addEventListener('wheel', this.wheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get w() { return this.el.clientWidth || 1; }
  get hgt() { return this.el.clientHeight || 1; }

  // ---------- coordinate helpers ----------
  screenToWorld2D(px: number, py: number, v = this.v2): [number, number] {
    const dx = (px - this.w / 2) * v.scale, dy = (py - this.hgt / 2) * v.scale;
    const c = Math.cos(v.rot), s = Math.sin(v.rot);
    return [v.x + dx * c + dy * s, v.y + dx * s - dy * c];
  }
  /** centre such that world point (wx,wy) sits under screen (px,py) */
  centreFor(wx: number, wy: number, px: number, py: number, scale: number, rot: number) {
    const dx = (this.w / 2 - px) * scale, dy = (this.hgt / 2 - py) * scale;
    const c = Math.cos(rot), s = Math.sin(rot);
    return { x: wx + dx * c + dy * s, y: wy + dx * s - dy * c };
  }
  pixelsPerUnit(at?: THREE.Vector3): number {
    if (this.mode === '2d') return 1 / this.v2.scale;
    const d = at ? this.cam3.position.distanceTo(at) : this.v3.dist;
    return this.hgt / (2 * d * Math.tan((this.cam3.fov * Math.PI) / 360));
  }

  // ---------- apply state to cameras ----------
  apply() {
    if (this.mode === '2d') {
      const v = this.v2, c = this.cam2, hw = (this.w / 2) * v.scale, hh = (this.hgt / 2) * v.scale;
      c.left = -hw; c.right = hw; c.top = hh; c.bottom = -hh; c.zoom = 1;
      c.position.set(v.x, v.y, 1e5);
      c.up.set(-Math.sin(v.rot), Math.cos(v.rot), 0);
      c.lookAt(v.x, v.y, 0);
      c.near = -1e7; c.far = 2e7;
      c.updateProjectionMatrix();
    } else {
      const v = this.v3, c = this.cam3;
      const cp = Math.cos(v.pitch);
      c.position.set(v.target.x + v.dist * cp * Math.sin(v.yaw), v.target.y + v.dist * Math.sin(v.pitch), v.target.z + v.dist * cp * Math.cos(v.yaw));
      c.up.set(0, 1, 0);
      c.lookAt(v.target);
      c.aspect = this.w / this.hgt;
      c.near = Math.max(v.dist * 0.002, this.limits.minDist * 0.1);
      c.far = v.dist + this.limits.maxDist * 0.1 + v.dist * 50;
      c.updateProjectionMatrix();
    }
    this.h.change?.();
  }

  private clamp() {
    const L = this.limits;
    this.v2.scale = Math.min(L.maxScale, Math.max(L.minScale, this.v2.scale));
    this.v3.dist = Math.min(L.maxDist, Math.max(L.minDist, this.v3.dist));
    this.v3.pitch = Math.min(1.553, Math.max(-1.553, this.v3.pitch));
  }

  // ---------- programmatic moves ----------
  stop() { cancelAnimationFrame(this.anim); this.anim = 0; this.inertia.active = false; }

  animate2D(to: Partial<View2D>, ms = 280) {
    this.stop();
    const from = { ...this.v2 };
    let dr = (to.rot ?? from.rot) - from.rot;
    dr = Math.atan2(Math.sin(dr), Math.cos(dr)); // shortest way round
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      const ls = Math.log(from.scale) + (Math.log(to.scale ?? from.scale) - Math.log(from.scale)) * e;
      this.v2 = { x: from.x + ((to.x ?? from.x) - from.x) * e, y: from.y + ((to.y ?? from.y) - from.y) * e, scale: Math.exp(ls), rot: from.rot + dr * e };
      this.apply();
      if (k < 1) this.anim = requestAnimationFrame(step); else this.endInteraction();
    };
    this.beginInteraction();
    this.anim = requestAnimationFrame(step);
  }
  animate3D(to: Partial<{ target: THREE.Vector3; dist: number; yaw: number; pitch: number }>, ms = 360) {
    this.stop();
    const f = { target: this.v3.target.clone(), dist: this.v3.dist, yaw: this.v3.yaw, pitch: this.v3.pitch };
    let dy = (to.yaw ?? f.yaw) - f.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      this.v3.target.lerpVectors(f.target, to.target ?? f.target, e);
      this.v3.dist = Math.exp(Math.log(f.dist) + (Math.log(to.dist ?? f.dist) - Math.log(f.dist)) * e);
      this.v3.yaw = f.yaw + dy * e;
      this.v3.pitch = f.pitch + ((to.pitch ?? f.pitch) - f.pitch) * e;
      this.apply();
      if (k < 1) this.anim = requestAnimationFrame(step); else this.endInteraction();
    };
    this.beginInteraction();
    this.anim = requestAnimationFrame(step);
  }
  zoomBy(factor: number, px = this.w / 2, py = this.hgt / 2, animate = true) {
    if (this.mode === '2d') {
      const [wx, wy] = this.screenToWorld2D(px, py);
      const scale = Math.min(this.limits.maxScale, Math.max(this.limits.minScale, this.v2.scale / factor));
      const c = this.centreFor(wx, wy, px, py, scale, this.v2.rot);
      if (animate) this.animate2D({ ...c, scale }, 260); else { this.v2 = { ...this.v2, ...c, scale }; this.apply(); }
    } else {
      const p = this.h.hit?.(px, py) ?? null;
      const target = p ? this.v3.target.clone().lerp(p, 1 - 1 / factor) : this.v3.target.clone();
      const dist = Math.min(this.limits.maxDist, Math.max(this.limits.minDist, this.v3.dist / factor));
      if (animate) this.animate3D({ target, dist }, 300); else { this.v3.target.copy(target); this.v3.dist = dist; this.apply(); }
    }
  }

  private beginInteraction() { if (!this.interactingFlag) { this.interactingFlag = true; this.h.interacting?.(true); } }
  private endInteraction() { if (this.interactingFlag && !this.pts.size && !this.anim && !this.inertia.active) { this.interactingFlag = false; this.h.interacting?.(false); } }

  // ---------- pointer handling ----------
  private down = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.el.setPointerCapture?.(e.pointerId);
    this.stop();
    const now = performance.now();
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: now });
    const r = this.el.getBoundingClientRect();
    if (this.pts.size === 1) {
      this.twoTap = { t: 0, moved: false, active: false };
      this.lastMove = { t: now, x: e.clientX, y: e.clientY };
      this.inertia.vx = this.inertia.vy = 0;
      this.pan = this.mode === '2d' ? { world: this.screenToWorld2D(e.clientX - r.left, e.clientY - r.top) } : null;
      clearTimeout(this.longTimer);
      if (e.pointerType !== 'mouse' || e.button === 0)
        this.longTimer = window.setTimeout(() => {
          const p = this.pts.get(e.pointerId);
          if (p && this.pts.size === 1 && Math.hypot(p.x - p.x0, p.y - p.y0) < TAP_MOVE) {
            this.pressing = true;
            this.h.longPress?.(p.x - r.left, p.y - r.top);
          }
        }, LONG_MS);
    } else if (this.pts.size === 2) {
      clearTimeout(this.longTimer);
      if (this.pressing) return;
      this.twoTap = { t: now, moved: false, active: true };
      this.startPinch();
    } else clearTimeout(this.longTimer);
    this.beginInteraction();
  };

  private startPinch() {
    const [a, b] = [...this.pts.values()];
    const r = this.el.getBoundingClientRect();
    const cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
    const d = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), ang = Math.atan2(b.y - a.y, b.x - a.x);
    this.pinch = {
      d0: d, a0: ang, cx, cy, v2: { ...this.v2 }, world: this.screenToWorld2D(cx, cy), rotOn: false,
      prevD: d, prevA: ang, prevCx: cx, prevCy: cy,
      anchor: this.mode === '3d' ? this.h.hit?.(cx, cy) ?? null : null,
    };
    this.pan = null;
  }

  private move = (e: PointerEvent) => {
    const p = this.pts.get(e.pointerId);
    if (!p) return;
    const px = p.x, py = p.y;
    p.x = e.clientX; p.y = e.clientY;
    const r = this.el.getBoundingClientRect();
    if (this.pressing) { this.h.pressMove?.(p.x - r.left, p.y - r.top); return; }
    if (Math.hypot(p.x - p.x0, p.y - p.y0) > TAP_MOVE) { clearTimeout(this.longTimer); this.twoTap.moved = true; }
    const now = performance.now();

    if (this.pts.size === 1) {
      if (Math.hypot(p.x - p.x0, p.y - p.y0) < TAP_MOVE && !this.pan) return;
      const dt = Math.max(1, now - this.lastMove.t);
      // smoothed finger velocity for the fling
      this.inertia.vx = 0.7 * ((p.x - this.lastMove.x) / dt) + 0.3 * this.inertia.vx;
      this.inertia.vy = 0.7 * ((p.y - this.lastMove.y) / dt) + 0.3 * this.inertia.vy;
      this.lastMove = { t: now, x: p.x, y: p.y };
      const rightOrShift = e.pointerType === 'mouse' && ((e.buttons & 2) !== 0 || e.shiftKey);
      if (this.mode === '2d' && this.pan) {
        const c = this.centreFor(this.pan.world[0], this.pan.world[1], p.x - r.left, p.y - r.top, this.v2.scale, this.v2.rot);
        this.v2.x = c.x; this.v2.y = c.y;
      } else if (this.mode === '3d' && rightOrShift) this.pan3(p.x - px, p.y - py);
      else if (this.mode === '3d') { this.v3.yaw -= (p.x - px) * 0.0065; this.v3.pitch += (p.y - py) * 0.0065; }
      this.clamp();
      this.apply();
    } else if (this.pts.size === 2 && this.pinch) {
      const [a, b] = [...this.pts.values()];
      const cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
      const d = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), ang = Math.atan2(b.y - a.y, b.x - a.x);
      const pin = this.pinch;
      if (this.mode === '2d') {
        let da = ang - pin.a0;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        if (!pin.rotOn && this.rotate2D && Math.abs(da) > ROT_START) { pin.rotOn = true; pin.a0 = ang; pin.v2 = { ...pin.v2, rot: this.v2.rot }; da = 0; }
        const rot = pin.rotOn ? pin.v2.rot + da : pin.v2.rot;
        const scale = Math.min(this.limits.maxScale, Math.max(this.limits.minScale, pin.v2.scale * (pin.d0 / d)));
        const c = this.centreFor(pin.world[0], pin.world[1], cx, cy, scale, rot);
        this.v2 = { x: c.x, y: c.y, scale, rot };
      } else {
        const f = pin.prevD / d; // >1 = fingers closing = zoom out
        if (pin.anchor) this.v3.target.lerp(pin.anchor, 1 - f);
        this.v3.dist *= f;
        this.pan3(cx - pin.prevCx, cy - pin.prevCy);
        let da = ang - pin.prevA;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        this.v3.yaw -= da;
      }
      pin.prevD = d; pin.prevA = ang; pin.prevCx = cx; pin.prevCy = cy;
      this.clamp();
      this.apply();
    }
  };

  private pan3(dx: number, dy: number) {
    const k = 1 / this.pixelsPerUnit(this.v3.target);
    const right = new THREE.Vector3().setFromMatrixColumn(this.cam3.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.cam3.matrix, 1);
    this.v3.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
  }

  private up = (e: PointerEvent) => {
    const p = this.pts.get(e.pointerId);
    this.pts.delete(e.pointerId);
    clearTimeout(this.longTimer);
    const r = this.el.getBoundingClientRect();
    const now = performance.now();
    if (!p) return;
    const lx = p.x - r.left, ly = p.y - r.top;
    if (this.pressing) {
      if (!this.pts.size) { this.pressing = false; this.h.pressEnd?.(lx, ly); this.endInteraction(); }
      return;
    }
    if (this.pts.size === 1) {
      // second finger lifted: two-finger tap = zoom out
      if (this.twoTap.active && !this.twoTap.moved && now - this.twoTap.t < TAP_MS) {
        this.twoTap.active = false;
        this.zoomBy(0.5, lx, ly);
      }
      this.pinch = null;
      const [rest] = [...this.pts.values()];
      // keep panning smoothly with the remaining finger
      rest.x0 = rest.x; rest.y0 = rest.y;
      this.lastMove = { t: now, x: rest.x, y: rest.y };
      this.pan = this.mode === '2d' ? { world: this.screenToWorld2D(rest.x - r.left, rest.y - r.top) } : null;
      return;
    }
    if (this.pts.size === 0) {
      this.pinch = null;
      const isTap = Math.hypot(p.x - p.x0, p.y - p.y0) < TAP_MOVE && now - p.t0 < TAP_MS && !this.twoTap.active;
      if (isTap) {
        if (now - this.lastTap.t < DOUBLE_MS && Math.hypot(lx - this.lastTap.x, ly - this.lastTap.y) < 40) {
          this.lastTap.t = 0;
          if (!this.h.doubleTap?.(lx, ly)) this.doubleTapZoom(lx, ly);
        } else {
          this.lastTap = { t: now, x: lx, y: ly };
          this.h.tap?.(lx, ly);
        }
      } else if (!this.twoTap.active && now - this.lastMove.t < 60) {
        this.fling();
      }
      this.twoTap.active = false;
      this.pan = null;
      this.endInteraction();
    }
  };

  private cancel = (e: PointerEvent) => {
    this.pts.delete(e.pointerId);
    clearTimeout(this.longTimer);
    if (!this.pts.size) { this.pinch = null; this.pan = null; this.pressing = false; this.endInteraction(); }
  };

  private doubleTapZoom(x: number, y: number) {
    if (this.mode === '3d') {
      const p = this.h.hit?.(x, y);
      if (p) { this.animate3D({ target: p, dist: Math.max(this.limits.minDist, this.v3.dist * 0.5) }); return; }
    }
    this.zoomBy(2, x, y);
  }

  private fling() {
    let { vx, vy } = this.inertia;
    if (Math.hypot(vx, vy) < 0.25) return; // px/ms
    this.inertia.active = true;
    let last = performance.now();
    const step = (t: number) => {
      const dt = Math.min(32, t - last);
      last = t;
      const decay = Math.pow(0.0035, dt / 1000); // ~85% speed lost per 300ms
      vx *= decay; vy *= decay;
      if (this.mode === '2d') {
        const v = this.v2, c = Math.cos(v.rot), s = Math.sin(v.rot);
        const dx = -vx * dt * v.scale, dy = -vy * dt * v.scale;
        v.x += dx * c + dy * s; v.y += dx * s - dy * c;
      } else { this.v3.yaw -= vx * dt * 0.0065; this.v3.pitch += vy * dt * 0.0065; this.clamp(); }
      this.apply();
      if (Math.hypot(vx, vy) > 0.02 && this.inertia.active) this.anim = requestAnimationFrame(step);
      else { this.inertia.active = false; this.anim = 0; this.endInteraction(); }
    };
    this.anim = requestAnimationFrame(step);
  }

  private wheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)); // ctrlKey = trackpad pinch
    this.zoomBy(f, e.clientX - r.left, e.clientY - r.top, false);
  };
}
