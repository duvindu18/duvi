// Streaming DXF reader. Works directly on bytes and writes geometry straight into typed
// arrays batched by (layer, colour), so memory stays a small multiple of the output size
// instead of the 30-40× blow-up of object-based parsers. Runs in a Web Worker.
import { ACI } from './aci';

/** Segment data (x1,y1,z1,x2,y2,z2 …) in fixed-size chunks: no doubling or final copy, and each chunk goes straight to the GPU. */
export interface Bucket { layer: number; color: number; chunks: Float32Array[]; length: number }
export const CHUNK = 6 * 524288; // floats per chunk (12 MB); a multiple of 6 so segments never straddle chunks

class Chunked {
  chunks: Float32Array[] = [];
  cur: Float32Array | null = null;
  off = 0;
  n = 0;
  room6(): Float32Array {
    if (!this.cur || this.off + 6 > this.cur.length) {
      if (this.cur && this.cur.length < CHUNK) { // small first chunk grows until it reaches CHUNK size
        const b = new Float32Array(Math.min(CHUNK, this.cur.length * 4));
        b.set(this.cur); this.cur = b; this.chunks[this.chunks.length - 1] = b;
      } else { this.cur = new Float32Array(this.chunks.length ? CHUNK : 1536); this.chunks.push(this.cur); this.off = 0; }
    }
    return this.cur;
  }
  out(): Float32Array[] {
    if (!this.cur) return [];
    const last = this.chunks.length - 1;
    return this.chunks.map((c, i) => (i === last ? c.slice(0, this.off) : c));
  }
}

/** Read float i of a chunked bucket. */
export const at = (b: Bucket, i: number) => b.chunks[(i / CHUNK) | 0][i % CHUNK];
export interface TextSet {
  values: string[];
  /** per text: x, y, z, height, rotation(rad) */
  num: Float32Array;
  /** per text: ax | ay << 2 | (multiline-from-top ? 16 : 0). ax 0 left 1 centre 2 right; ay 0 baseline 1 bottom 2 middle 3 top */
  align: Uint8Array;
  color: Int32Array;
  layer: Uint16Array;
}
export interface Drawing {
  origin: [number, number, number];
  units: string;
  layers: { name: string; color: number; visible: boolean }[];
  buckets: Bucket[];
  /** bucket, start, end (float offsets) per drawn piece; used by revision compare */
  pieces: Uint32Array;
  text: TextSet;
  snap: Float32Array;
  snapLayer: Uint16Array;
  bounds: [number, number, number, number, number, number];
  skipped: Record<string, number>;
  entities: number;
  /** display tiles (set by the worker; then `buckets[].chunks` are released) */
  tiles?: import('./tiles').Tile[];
}

type CS = { mode: 0 | 1 | 2; color: number }; // 0 ByLayer, 1 ByBlock, 2 explicit (rgb, or -1 = foreground)
type M = Float64Array; // 3x4 affine: [m00 m01 m02 m10 m11 m12 m20 m21 m22 tx ty tz]

const FG = -1;
const UNITS: Record<number, string> = { 1: 'in', 2: 'ft', 3: 'mi', 4: 'mm', 5: 'cm', 6: 'm', 7: 'km', 8: 'µin', 9: 'mil', 10: 'yd', 14: 'dm' };
const CODEPAGES: Record<string, string> = {
  ANSI_874: 'windows-874', ANSI_932: 'shift_jis', ANSI_936: 'gbk', ANSI_949: 'euc-kr', ANSI_950: 'big5',
  ANSI_1250: 'windows-1250', ANSI_1251: 'windows-1251', ANSI_1252: 'windows-1252', ANSI_1253: 'windows-1253',
  ANSI_1254: 'windows-1254', ANSI_1255: 'windows-1255', ANSI_1256: 'windows-1256', ANSI_1257: 'windows-1257', ANSI_1258: 'windows-1258',
};

// ---------------- growable typed arrays ----------------
class F32 {
  a: Float32Array; n = 0;
  constructor(cap = 1024) { this.a = new Float32Array(cap); }
  room(k: number) { if (this.n + k > this.a.length) { const b = new Float32Array(Math.max(this.a.length * 2, this.n + k)); b.set(this.a.subarray(0, this.n)); this.a = b; } }
  push(v: number) { this.room(1); this.a[this.n++] = v; }
  out() { return this.a.slice(0, this.n); }
}
class U32 {
  a: Uint32Array; n = 0;
  constructor(cap = 1024) { this.a = new Uint32Array(cap); }
  push(v: number) { if (this.n >= this.a.length) { const b = new Uint32Array(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.n++] = v; }
  out() { return this.a.slice(0, this.n); }
}
class I32 {
  a: Int32Array; n = 0;
  constructor(cap = 256) { this.a = new Int32Array(cap); }
  push(v: number) { if (this.n >= this.a.length) { const b = new Int32Array(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.n++] = v; }
  out() { return this.a.slice(0, this.n); }
}
class U16 {
  a: Uint16Array; n = 0;
  constructor(cap = 1024) { this.a = new Uint16Array(cap); }
  push(v: number) { if (this.n >= this.a.length) { const b = new Uint16Array(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.n++] = v; }
  out() { return this.a.slice(0, this.n); }
}

// ---------------- tokenizer ----------------
const isNum = (c: number) =>
  (c >= 10 && c <= 99) || (c >= 140 && c <= 147) || (c >= 170 && c <= 175) || (c >= 210 && c <= 239) ||
  (c >= 270 && c <= 289) || (c >= 370 && c <= 389) || (c >= 400 && c <= 409) || (c >= 420 && c <= 429) || (c >= 440 && c <= 469);

/** One entity's group codes, reused between entities to avoid allocation. */
class Rec {
  type = '';
  n = 0;
  codes = new Int32Array(256);
  nums = new Float64Array(256);
  ss = new Int32Array(256);
  se = new Int32Array(256);
  grow() {
    const k = this.codes.length * 2;
    const c = new Int32Array(k); c.set(this.codes); this.codes = c;
    const v = new Float64Array(k); v.set(this.nums); this.nums = v;
    const s = new Int32Array(k); s.set(this.ss); this.ss = s;
    const e = new Int32Array(k); e.set(this.se); this.se = e;
  }
  get(code: number, def = 0): number {
    for (let i = 0; i < this.n; i++) if (this.codes[i] === code) return this.nums[i];
    return def;
  }
  has(code: number) { for (let i = 0; i < this.n; i++) if (this.codes[i] === code) return true; return false; }
}

export class DxfReader {
  private b: Uint8Array;
  private p = 0;
  code = 0; s = 0; e = 0;
  dec: TextDecoder;
  constructor(bytes: Uint8Array) {
    this.b = bytes;
    this.dec = new TextDecoder('utf-8');
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) this.p = 3; // BOM
  }
  get pos() { return this.p; }
  next(): boolean {
    const b = this.b, n = b.length;
    let p = this.p;
    while (p < n && (b[p] === 32 || b[p] === 9 || b[p] === 13)) p++;
    if (p >= n) return false;
    let neg = false;
    if (b[p] === 45) { neg = true; p++; }
    let c = 0;
    while (p < n && b[p] >= 48 && b[p] <= 57) { c = c * 10 + b[p] - 48; p++; }
    while (p < n && b[p] !== 10) p++;
    p++;
    if (p > n) return false;
    const s = p;
    while (p < n && b[p] !== 10) p++;
    let e = p;
    if (e > s && b[e - 1] === 13) e--;
    this.code = neg ? -c : c;
    this.s = s; this.e = e; this.p = p + 1;
    return true;
  }
  str(s = this.s, e = this.e, trim = true): string {
    const b = this.b;
    if (trim) { while (s < e && (b[s] === 32 || b[s] === 9)) s++; while (e > s && (b[e - 1] === 32 || b[e - 1] === 9)) e--; }
    if (e - s < 32) { // fast path for short ASCII (entity and layer names)
      let ascii = true;
      for (let i = s; i < e; i++) if (b[i] > 127) { ascii = false; break; }
      if (ascii) return String.fromCharCode.apply(null, b.subarray(s, e) as unknown as number[]);
    }
    return this.dec.decode(b.subarray(s, e));
  }
  num(): number {
    const b = this.b;
    let p = this.s;
    const e = this.e;
    while (p < e && (b[p] === 32 || b[p] === 9)) p++;
    let sign = 1;
    if (b[p] === 45) { sign = -1; p++; } else if (b[p] === 43) p++;
    let v = 0, d = 0;
    while (p < e && (d = b[p] - 48) >= 0 && d <= 9) { v = v * 10 + d; p++; }
    if (b[p] === 46) {
      p++;
      let f = 0, sc = 1;
      while (p < e && (d = b[p] - 48) >= 0 && d <= 9) { if (sc < 1e17) { f = f * 10 + d; sc *= 10; } p++; }
      v += f / sc;
    }
    if (p < e && (b[p] === 101 || b[p] === 69)) {
      p++;
      let es = 1, ev = 0;
      if (b[p] === 45) { es = -1; p++; } else if (b[p] === 43) p++;
      while (p < e && (d = b[p] - 48) >= 0 && d <= 9) { ev = ev * 10 + d; p++; }
      v *= Math.pow(10, es * ev);
    }
    return sign * v;
  }
}

// ---------------- geometry helpers ----------------
const ident = (): M => new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
function mul(a: M, b: M): M {
  const r = new Float64Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    r[9 + i] = a[i * 3] * b[9] + a[i * 3 + 1] * b[10] + a[i * 3 + 2] * b[11] + a[9 + i];
  }
  return r;
}
const translate = (x: number, y: number, z: number): M => new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1, x, y, z]);
const scaleM = (x: number, y: number, z: number): M => new Float64Array([x, 0, 0, 0, y, 0, 0, 0, z, 0, 0, 0]);
const rotZ = (a: number): M => { const c = Math.cos(a), s = Math.sin(a); return new Float64Array([c, -s, 0, s, c, 0, 0, 0, 1, 0, 0, 0]); };

/** AutoCAD "arbitrary axis algorithm": object coordinate system from an extrusion vector. Null = identity. */
export function ocs(nx: number, ny: number, nz: number): M | null {
  const l = Math.hypot(nx, ny, nz);
  if (!l || (Math.abs(nx) < 1e-9 && Math.abs(ny) < 1e-9 && nz > 0)) return null;
  nx /= l; ny /= l; nz /= l;
  let ax: number, ay: number, az: number;
  if (Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64) { ax = nz; ay = 0; az = -nx; } // Wy × N
  else { ax = -ny; ay = nx; az = 0; } // Wz × N
  const al = Math.hypot(ax, ay, az); ax /= al; ay /= al; az /= al;
  const bx = ny * az - nz * ay, by = nz * ax - nx * az, bz = nx * ay - ny * ax; // N × Ax
  return new Float64Array([ax, bx, nx, ay, by, ny, az, bz, nz, 0, 0, 0]);
}

/** Max deviation of tessellated arcs from the true curve; set from the drawing extents. 0 = fixed 64/circle. */
let arcTol = 0;
/** Segments for an arc: enough that the chord error stays below arcTol, 16–128 per full circle. */
function arcSegs(r: number, sweep: number): number {
  let full = 64;
  if (arcTol > 0 && r > 0) full = Math.min(128, Math.max(16, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - arcTol / r)))));
  return Math.max(4, Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * full));
}

export function arcPts(cx: number, cy: number, r: number, a0: number, a1: number, out: number[]) {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += Math.PI * 2;
  const n = arcSegs(r, sweep);
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
}

/** Expand polyline vertices with bulges (arc segments) into a flat x,y list. */
export function bulgePts(xs: number[], ys: number[], bs: number[], closed: boolean): number[] {
  const out: number[] = [];
  const n = xs.length;
  if (!n) return out;
  out.push(xs[0], ys[0]);
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % n;
    const ax = xs[i], ay = ys[i], bx = xs[j], by = ys[j], bulge = bs[i] || 0;
    const chord = Math.hypot(bx - ax, by - ay);
    if (Math.abs(bulge) > 1e-9 && chord > 0) {
      const theta = 4 * Math.atan(bulge);
      const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
      const h = r * Math.cos(Math.abs(theta) / 2);
      const ux = -(by - ay) / chord, uy = (bx - ax) / chord;
      const sgn = Math.sign(bulge) * (Math.abs(theta) > Math.PI ? -1 : 1);
      const cx = (ax + bx) / 2 + ux * h * sgn, cy = (ay + by) / 2 + uy * h * sgn;
      const s = Math.atan2(ay - cy, ax - cx);
      const k = arcSegs(r, theta);
      for (let q = 1; q <= k; q++) { const a = s + (theta * q) / k; out.push(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
    } else out.push(bx, by);
  }
  return out;
}

/** (Rational) B-spline by de Boor; returns x,y,z triples. */
export function splinePts(cps: number[], knots: number[], p: number, w: number[]): number[] {
  const n = cps.length / 3;
  if (n < p + 1 || knots.length !== n + p + 1) return cps;
  const lo = knots[p], hi = knots[knots.length - p - 1];
  const steps = Math.min(4000, Math.max(16, n * 10));
  const out: number[] = [];
  const d = new Float64Array((p + 1) * 4);
  for (let i = 0; i <= steps; i++) {
    const t = lo + ((hi - lo) * i) / steps;
    let k = p;
    while (k < n - 1 && t >= knots[k + 1]) k++;
    for (let j = 0; j <= p; j++) {
      const c = k - p + j, ww = w[c] ?? 1;
      d[j * 4] = cps[c * 3] * ww; d[j * 4 + 1] = cps[c * 3 + 1] * ww; d[j * 4 + 2] = cps[c * 3 + 2] * ww; d[j * 4 + 3] = ww;
    }
    for (let r = 1; r <= p; r++)
      for (let j = p; j >= r; j--) {
        const den = knots[j + 1 + k - r] - knots[j + k - p];
        const al = den === 0 ? 0 : (t - knots[j + k - p]) / den;
        for (let q = 0; q < 4; q++) d[j * 4 + q] = (1 - al) * d[(j - 1) * 4 + q] + al * d[j * 4 + q];
      }
    const ww = d[p * 4 + 3] || 1;
    out.push(d[p * 4] / ww, d[p * 4 + 1] / ww, d[p * 4 + 2] / ww);
  }
  return out;
}

/** Strip MTEXT formatting codes and decode AutoCAD escapes. */
export function cleanText(s: string): string {
  return s
    .replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\P/g, '\n')
    .replace(/\\~/g, ' ')
    .replace(/\\[ACcFfHhQTWp][^;\\]*;/g, '')
    .replace(/\\[LlOoKk]/g, '')
    .replace(/\\S([^;]*?)[#^/]([^;]*);/g, '$1/$2')
    .replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%[uUoO]/g, '').replace(/%%%/g, '%')
    .replace(/\\\\/g, '\\')
    .replace(/[{}]/g, '')
    .trim();
}

// ---------------- sinks: where entity geometry goes ----------------
interface TextItem { v: string; x: number; y: number; z: number; h: number; rot: number; align: number }
interface InsertItem { name: string; m: M; layer: string; cs: CS; dim: boolean }
interface Part { layer: string; cs: CS; segs: number[]; snaps: number[]; texts: TextItem[]; inserts: InsertItem[] }
interface BlockDef { base: [number, number, number]; parts: Part[] }

interface Sink {
  begin(layer: string, cs: CS): void;
  seg(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): void;
  snap(x: number, y: number, z: number): void;
  text(t: TextItem): void;
  insert(i: InsertItem): void;
  end(): void;
}

class BlockSink implements Sink {
  cur: Part | null = null;
  constructor(public def: BlockDef) {}
  begin(layer: string, cs: CS) { this.cur = { layer, cs, segs: [], snaps: [], texts: [], inserts: [] }; }
  seg(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) { this.cur!.segs.push(x1, y1, z1, x2, y2, z2); }
  snap(x: number, y: number, z: number) { this.cur!.snaps.push(x, y, z); }
  text(t: TextItem) { this.cur!.texts.push(t); }
  insert(i: InsertItem) { this.cur!.inserts.push(i); }
  end() { const c = this.cur!; if (c.segs.length || c.snaps.length || c.texts.length || c.inserts.length) this.def.parts.push(c); this.cur = null; }
}

class WorldSink implements Sink {
  layerNames: string[] = [];
  layerIdx = new Map<string, number>();
  buckets: { layer: number; color: number; f: Chunked }[] = [];
  bucketKey = new Map<number, number>();
  pieces = new U32(4096);
  snapP = new F32(4096);
  snapL = new U16(1024);
  tv: string[] = [];
  tn = new F32(1024);
  ta: number[] = [];
  tc = new I32();
  tl = new U16();
  origin: [number, number, number] | null;
  bmin = [Infinity, Infinity, Infinity];
  bmax = [-Infinity, -Infinity, -Infinity];
  private cb = -1;
  private cl = 0;
  private cc = FG;
  private pieceStart = 0;
  constructor(public layerColor: (name: string) => number, public blocks: Map<string, BlockDef>, origin: [number, number, number] | null) {
    this.origin = origin;
  }
  layer(name: string) {
    let i = this.layerIdx.get(name);
    if (i === undefined) { i = this.layerNames.length; this.layerNames.push(name); this.layerIdx.set(name, i); }
    return i;
  }
  resolve(layer: string, cs: CS) { return cs.mode === 2 ? cs.color : cs.mode === 1 ? FG : this.layerColor(layer); }
  begin(layer: string, cs: CS) { this.beginResolved(layer, this.resolve(layer, cs)); }
  beginResolved(layer: string, color: number) { this.cl = this.layer(layer); this.cc = color; this.cb = -1; }
  private bucket() {
    if (this.cb >= 0) return this.buckets[this.cb].f;
    const key = this.cl * 33554432 + this.cc + 1;
    let b = this.bucketKey.get(key);
    if (b === undefined) { b = this.buckets.length; this.buckets.push({ layer: this.cl, color: this.cc, f: new Chunked() }); this.bucketKey.set(key, b); }
    this.cb = b;
    this.pieceStart = this.buckets[b].f.n;
    return this.buckets[b].f;
  }
  private o(x: number, y: number, z: number) { if (!this.origin) this.origin = [x, y, z]; return this.origin; }
  private grow(x: number, y: number, z: number) {
    const a = this.bmin, b = this.bmax;
    if (x < a[0]) a[0] = x; if (x > b[0]) b[0] = x;
    if (y < a[1]) a[1] = y; if (y > b[1]) b[1] = y;
    if (z < a[2]) a[2] = z; if (z > b[2]) b[2] = z;
  }
  seg(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) {
    if (!(isFinite(x1) && isFinite(y1) && isFinite(z1) && isFinite(x2) && isFinite(y2) && isFinite(z2))) return;
    const f = this.bucket();
    const [ox, oy, oz] = this.o(x1, y1, z1);
    const a = f.room6(), n = f.off;
    a[n] = x1 - ox; a[n + 1] = y1 - oy; a[n + 2] = z1 - oz; a[n + 3] = x2 - ox; a[n + 4] = y2 - oy; a[n + 5] = z2 - oz;
    f.off = n + 6;
    f.n += 6;
    this.grow(a[n], a[n + 1], a[n + 2]);
    this.grow(a[n + 3], a[n + 4], a[n + 5]);
  }
  snap(x: number, y: number, z: number) {
    if (!(isFinite(x) && isFinite(y) && isFinite(z))) return;
    const [ox, oy, oz] = this.o(x, y, z);
    this.snapP.push(x - ox); this.snapP.push(y - oy); this.snapP.push(z - oz);
    this.snapL.push(this.cl);
  }
  text(t: TextItem) {
    if (!t.v || !isFinite(t.x) || !isFinite(t.y)) return;
    const [ox, oy, oz] = this.o(t.x, t.y, t.z);
    this.tv.push(t.v);
    this.tn.push(t.x - ox); this.tn.push(t.y - oy); this.tn.push(t.z - oz); this.tn.push(t.h); this.tn.push(t.rot);
    this.ta.push(t.align);
    this.tc.push(this.cc);
    this.tl.push(this.cl);
    this.grow(t.x - ox, t.y - oy, t.z - oz);
  }
  end() {
    if (this.cb >= 0) {
      const f = this.buckets[this.cb].f;
      if (f.n > this.pieceStart) { this.pieces.push(this.cb); this.pieces.push(this.pieceStart); this.pieces.push(f.n); }
    }
    this.cb = -1;
  }
  insert(ins: InsertItem) { this.expand(ins, ins.m, this.resolve(ins.layer, ins.cs), ins.layer, 0); }

  /** Instantiate a block: transform its pre-tessellated parts into world buckets. */
  private expand(ins: InsertItem, m0: M, insColor: number, insLayer: string, depth: number) {
    const def = this.blocks.get(ins.name);
    if (!def || depth > 12) return;
    const m = ins.dim ? m0 : mul(m0, translate(-def.base[0], -def.base[1], -def.base[2]));
    const ys = Math.hypot(m[1], m[4], m[7]);
    const xr = Math.atan2(m[3], m[0]);
    for (const part of def.parts) {
      const layer = part.layer === '0' ? insLayer : part.layer;
      const color = part.cs.mode === 2 ? part.cs.color : part.cs.mode === 1 ? insColor : this.layerColor(layer);
      this.beginResolved(layer, color);
      const s = part.segs;
      for (let i = 0; i < s.length; i += 6) {
        const x1 = s[i], y1 = s[i + 1], z1 = s[i + 2], x2 = s[i + 3], y2 = s[i + 4], z2 = s[i + 5];
        this.seg(
          m[0] * x1 + m[1] * y1 + m[2] * z1 + m[9], m[3] * x1 + m[4] * y1 + m[5] * z1 + m[10], m[6] * x1 + m[7] * y1 + m[8] * z1 + m[11],
          m[0] * x2 + m[1] * y2 + m[2] * z2 + m[9], m[3] * x2 + m[4] * y2 + m[5] * z2 + m[10], m[6] * x2 + m[7] * y2 + m[8] * z2 + m[11],
        );
      }
      for (let i = 0; i < part.snaps.length; i += 3) {
        const x = part.snaps[i], y = part.snaps[i + 1], z = part.snaps[i + 2];
        this.snap(m[0] * x + m[1] * y + m[2] * z + m[9], m[3] * x + m[4] * y + m[5] * z + m[10], m[6] * x + m[7] * y + m[8] * z + m[11]);
      }
      for (const t of part.texts)
        this.text({ ...t, x: m[0] * t.x + m[1] * t.y + m[2] * t.z + m[9], y: m[3] * t.x + m[4] * t.y + m[5] * t.z + m[10], z: m[6] * t.x + m[7] * t.y + m[8] * t.z + m[11], h: t.h * ys, rot: t.rot + xr });
      this.end();
      for (const sub of part.inserts) {
        const subLayer = sub.layer === '0' ? layer : sub.layer;
        const subColor = sub.cs.mode === 2 ? sub.cs.color : sub.cs.mode === 1 ? color : this.layerColor(subLayer);
        this.expand(sub, mul(m, sub.m), subColor, subLayer, depth + 1);
      }
    }
  }
}

// ---------------- entity interpretation ----------------
function colorSpec(r: Rec): CS {
  for (let i = 0; i < r.n; i++) if (r.codes[i] === 420) return { mode: 2, color: r.nums[i] & 0xffffff };
  let idx = 256;
  for (let i = 0; i < r.n; i++) if (r.codes[i] === 62) { idx = Math.abs(r.nums[i]); break; }
  if (idx === 0) return { mode: 1, color: 0 };
  if (idx >= 256) return { mode: 0, color: 0 };
  return { mode: 2, color: idx === 7 ? FG : ACI[idx] };
}

type V3 = [number, number, number];
interface PolyState { flags: number; layer: string; cs: CS; elev: number; o: M | null; m: number; n: number; v: number[]; faces: number[] }

class EntityReader {
  skipped: Record<string, number> = {};
  count = 0;
  poly: PolyState | null = null;
  constructor(private rd: DxfReader) {}

  str(r: Rec, code: number, trim = true): string | null {
    for (let i = 0; i < r.n; i++) if (r.codes[i] === code) return this.rd.str(r.ss[i], r.se[i], trim);
    return null;
  }

  handle(r: Rec, sink: Sink) {
    const t = r.type;
    // POLYLINE … VERTEX … SEQEND sequences
    if (t === 'VERTEX') {
      if (!this.poly) return;
      const f = r.get(70);
      if (f & 128 && !(f & 64)) this.poly.faces.push(r.get(71), r.get(72), r.get(73), r.get(74)); // polyface face record
      else this.poly.v.push(r.get(10), r.get(20), r.get(30), r.get(42));
      return;
    }
    if (t === 'SEQEND') { if (this.poly) this.flushPoly(sink); return; }
    if (this.poly) this.flushPoly(sink);
    this.count++;

    const layer = this.str(r, 8) || '0';
    const cs = colorSpec(r);
    const ex = r.has(210) ? ocs(r.get(210), r.get(220), r.get(230, 1)) : null;
    const P = (x: number, y: number, z: number): V3 =>
      ex ? [ex[0] * x + ex[1] * y + ex[2] * z, ex[3] * x + ex[4] * y + ex[5] * z, ex[6] * x + ex[7] * y + ex[8] * z] : [x, y, z];
    const line2 = (pts: number[], z: number, closed = false) => {
      let prev = P(pts[0], pts[1], z);
      sink.snap(...prev);
      for (let i = 2; i < pts.length; i += 2) {
        const cur = P(pts[i], pts[i + 1], z);
        sink.seg(prev[0], prev[1], prev[2], cur[0], cur[1], cur[2]);
        prev = cur;
      }
      if (closed && pts.length > 4) { const f = P(pts[0], pts[1], z); sink.seg(prev[0], prev[1], prev[2], f[0], f[1], f[2]); }
      sink.snap(...prev);
    };

    switch (t) {
      case 'LINE': {
        sink.begin(layer, cs);
        const a: V3 = [r.get(10), r.get(20), r.get(30)], b: V3 = [r.get(11), r.get(21), r.get(31)];
        sink.seg(a[0], a[1], a[2], b[0], b[1], b[2]);
        sink.snap(...a); sink.snap(...b); sink.snap((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
        sink.end();
        return;
      }
      case 'CIRCLE':
      case 'ARC': {
        const cx = r.get(10), cy = r.get(20), cz = r.get(30), rad = r.get(40);
        const a0 = t === 'ARC' ? (r.get(50) * Math.PI) / 180 : 0, a1 = t === 'ARC' ? (r.get(51) * Math.PI) / 180 : Math.PI * 2;
        const pts: number[] = [];
        arcPts(cx, cy, rad, a0, a1, pts);
        sink.begin(layer, cs);
        line2(pts, cz);
        sink.snap(...P(cx, cy, cz));
        if (t === 'CIRCLE') for (let q = 0; q < 4; q++) sink.snap(...P(cx + rad * Math.cos((q * Math.PI) / 2), cy + rad * Math.sin((q * Math.PI) / 2), cz));
        sink.end();
        return;
      }
      case 'LWPOLYLINE': {
        const xs: number[] = [], ys: number[] = [], bs: number[] = [];
        for (let i = 0; i < r.n; i++) {
          const c = r.codes[i];
          if (c === 10) { xs.push(r.nums[i]); ys.push(0); bs.push(0); }
          else if (c === 20 && ys.length) ys[ys.length - 1] = r.nums[i];
          else if (c === 42 && bs.length) bs[bs.length - 1] = r.nums[i];
        }
        if (!xs.length) return;
        const closed = (r.get(70) & 1) === 1;
        const z = r.get(38);
        sink.begin(layer, cs);
        line2(bulgePts(xs, ys, bs, closed), z);
        for (let i = 0; i < xs.length; i++) sink.snap(...P(xs[i], ys[i], z));
        sink.end();
        return;
      }
      case 'POLYLINE': {
        const flags = r.get(70);
        this.poly = { flags, layer, cs, elev: r.get(30), o: flags & (8 | 16 | 64) ? null : ex, m: r.get(71), n: r.get(72), v: [], faces: [] };
        return;
      }
      case 'ELLIPSE': {
        const cx = r.get(10), cy = r.get(20), cz = r.get(30);
        const mx = r.get(11), my = r.get(21), mz = r.get(31), ratio = r.get(40, 1);
        const nx = r.has(210) ? r.get(210) : 0, ny = r.has(220) ? r.get(220) : 0, nz = r.has(230) ? r.get(230) : 1;
        const ix = (ny * mz - nz * my) * ratio, iy = (nz * mx - nx * mz) * ratio, iz = (nx * my - ny * mx) * ratio; // (N × major)·ratio
        const t0 = r.get(41, 0);
        let sweep = r.get(42, Math.PI * 2) - t0;
        while (sweep <= 1e-12) sweep += Math.PI * 2;
        const n = Math.max(12, arcSegs(Math.hypot(mx, my, mz), sweep) * 1.5);
        sink.begin(layer, cs);
        let px = 0, py = 0, pz = 0;
        for (let i = 0; i <= n; i++) {
          const a = t0 + (sweep * i) / n, c = Math.cos(a), s = Math.sin(a);
          const x = cx + mx * c + ix * s, y = cy + my * c + iy * s, z = cz + mz * c + iz * s;
          if (i) sink.seg(px, py, pz, x, y, z); else sink.snap(x, y, z);
          px = x; py = y; pz = z;
        }
        sink.snap(px, py, pz); sink.snap(cx, cy, cz);
        sink.end();
        return;
      }
      case 'SPLINE': {
        const cps: number[] = [], fits: number[] = [], knots: number[] = [], w: number[] = [];
        for (let i = 0; i < r.n; i++) {
          const c = r.codes[i], v = r.nums[i];
          if (c === 10) cps.push(v, 0, 0); else if (c === 20) cps[cps.length - 2] = v; else if (c === 30) cps[cps.length - 1] = v;
          else if (c === 11) fits.push(v, 0, 0); else if (c === 21) fits[fits.length - 2] = v; else if (c === 31) fits[fits.length - 1] = v;
          else if (c === 40) knots.push(v); else if (c === 41) w.push(v);
        }
        let pts = cps.length ? splinePts(cps, knots, r.get(71, 3), w) : fits;
        if (pts.length < 6) pts = fits;
        if (pts.length < 6) return;
        sink.begin(layer, cs);
        for (let i = 3; i < pts.length; i += 3) sink.seg(pts[i - 3], pts[i - 2], pts[i - 1], pts[i], pts[i + 1], pts[i + 2]);
        sink.snap(pts[0], pts[1], pts[2]); sink.snap(pts[pts.length - 3], pts[pts.length - 2], pts[pts.length - 1]);
        sink.end();
        return;
      }
      case 'SOLID':
      case 'TRACE':
      case '3DFACE': {
        const q: V3[] = [];
        for (let k = 0; k < 4; k++) {
          const p: V3 = [r.get(10 + k), r.get(20 + k), r.get(30 + k)];
          q.push(t === '3DFACE' ? p : P(...p));
        }
        const order = t === '3DFACE' ? [0, 1, 2, 3] : [0, 1, 3, 2];
        sink.begin(layer, cs);
        for (let k = 0; k < 4; k++) {
          const a = q[order[k]], b = q[order[(k + 1) % 4]];
          if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) sink.seg(a[0], a[1], a[2], b[0], b[1], b[2]);
          sink.snap(...a);
        }
        sink.end();
        return;
      }
      case 'POINT':
        sink.begin(layer, cs); sink.snap(r.get(10), r.get(20), r.get(30)); sink.end();
        return;
      case 'LEADER': {
        const v: number[] = [];
        for (let i = 0; i < r.n; i++) { const c = r.codes[i]; if (c === 10) v.push(r.nums[i], 0, 0); else if (c === 20) v[v.length - 2] = r.nums[i]; else if (c === 30) v[v.length - 1] = r.nums[i]; }
        sink.begin(layer, cs);
        for (let i = 3; i < v.length; i += 3) sink.seg(v[i - 3], v[i - 2], v[i - 1], v[i], v[i + 1], v[i + 2]);
        if (v.length) sink.snap(v[0], v[1], v[2]);
        sink.end();
        return;
      }
      case 'TEXT':
      case 'ATTRIB': {
        if (t === 'ATTRIB' && r.get(70) & 1) return; // invisible attribute
        const raw = this.str(r, 1, false);
        if (!raw) return;
        const h = r.get(72), v = t === 'TEXT' ? r.get(73) : r.get(74);
        const useSecond = (h !== 0 || v !== 0) && h !== 3 && h !== 5 && r.has(11);
        const p = useSecond ? P(r.get(11), r.get(21), r.get(31)) : P(r.get(10), r.get(20), r.get(30));
        const ax = h === 1 || h === 4 ? 1 : h === 2 ? 2 : 0;
        const ay = h === 4 ? 2 : v === 1 ? 1 : v === 2 ? 2 : v === 3 ? 3 : 0;
        const rot = (r.get(50) * Math.PI) / 180 + (ex ? Math.atan2(ex[3], ex[0]) : 0);
        sink.begin(layer, cs);
        sink.text({ v: cleanText(raw), x: p[0], y: p[1], z: p[2], h: r.get(40, 1), rot, align: ax | (ay << 2) });
        sink.snap(...p);
        sink.end();
        return;
      }
      case 'MTEXT': {
        let raw = '';
        for (let i = 0; i < r.n; i++) if (r.codes[i] === 3 || r.codes[i] === 1) raw += this.rd.str(r.ss[i], r.se[i], false);
        if (!raw) return;
        const a = Math.min(9, Math.max(1, r.get(71, 1)));
        const rot = r.has(11) ? Math.atan2(r.get(21), r.get(11)) : r.get(50);
        const x = r.get(10), y = r.get(20), z = r.get(30);
        sink.begin(layer, cs);
        sink.text({ v: cleanText(raw), x, y, z, h: r.get(40, 1), rot, align: ((a - 1) % 3) | ((a <= 3 ? 3 : a <= 6 ? 2 : 1) << 2) | 16 });
        sink.snap(x, y, z);
        sink.end();
        return;
      }
      case 'INSERT': {
        const name = this.str(r, 2);
        if (!name) return;
        const px = r.get(10), py = r.get(20), pz = r.get(30);
        const sx = r.get(41, 1), sy = r.get(42, 1), sz = r.get(43, 1), rot = (r.get(50) * Math.PI) / 180;
        const cols = Math.max(1, r.get(70, 1)), rows = Math.max(1, r.get(71, 1));
        const csp = r.get(44), rsp = r.get(45);
        const base = mul(ex ?? ident(), mul(translate(px, py, pz), rotZ(rot)));
        sink.begin(layer, cs);
        sink.snap(...P(px, py, pz));
        for (let c = 0; c < cols && c < 100; c++)
          for (let rr = 0; rr < rows && rr < 100; rr++)
            sink.insert({ name, m: mul(base, mul(translate(c * csp, rr * rsp, 0), scaleM(sx, sy, sz))), layer, cs, dim: false });
        sink.end();
        return;
      }
      case 'DIMENSION': {
        const name = this.str(r, 2);
        if (!name) return;
        sink.begin(layer, cs);
        sink.insert({ name, m: ident(), layer, cs, dim: true });
        sink.end();
        return;
      }
      case 'ATTDEF': case 'VIEWPORT':
        this.count--;
        return;
      default:
        this.count--;
        this.skipped[t] = (this.skipped[t] ?? 0) + 1;
    }
  }

  flushPoly(sink: Sink) {
    const p = this.poly!;
    this.poly = null;
    const { v, faces } = p;
    const nv = v.length / 4;
    if (!nv) return;
    sink.begin(p.layer, p.cs);
    const is3 = p.flags & (8 | 16 | 64);
    const W = (i: number): V3 => {
      const x = v[i * 4], y = v[i * 4 + 1], z = is3 ? v[i * 4 + 2] : p.elev, o = p.o;
      return o ? [o[0] * x + o[1] * y + o[2] * z, o[3] * x + o[4] * y + o[5] * z, o[6] * x + o[7] * y + o[8] * z] : [x, y, z];
    };
    if (p.flags & 64) { // polyface mesh
      for (let f = 0; f < faces.length; f += 4) {
        const idx = [faces[f], faces[f + 1], faces[f + 2], faces[f + 3]].filter((k) => k !== 0);
        for (let k = 0; k < idx.length; k++) {
          const a = idx[k], b = idx[(k + 1) % idx.length];
          if (a < 0 || Math.abs(a) > nv || Math.abs(b) > nv) continue; // negative = invisible edge
          sink.seg(...W(Math.abs(a) - 1), ...W(Math.abs(b) - 1));
        }
      }
      for (let i = 0; i < nv; i++) sink.snap(...W(i));
    } else if (p.flags & 16) { // M×N polygon mesh
      const m = p.m, n = p.n;
      if (m * n <= nv) for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) {
        const a = W(i * n + j);
        if (j + 1 < n || p.flags & 32) sink.seg(...a, ...W(i * n + ((j + 1) % n)));
        if (i + 1 < m || p.flags & 1) sink.seg(...a, ...W(((i + 1) % m) * n + j));
      }
    } else if (p.flags & 8) { // 3D polyline
      for (let i = 1; i < nv; i++) sink.seg(...W(i - 1), ...W(i));
      if (p.flags & 1 && nv > 2) sink.seg(...W(nv - 1), ...W(0));
      for (let i = 0; i < nv; i++) sink.snap(...W(i));
    } else { // 2D polyline with bulges
      const xs: number[] = [], ys: number[] = [], bs: number[] = [];
      for (let i = 0; i < nv; i++) { xs.push(v[i * 4]); ys.push(v[i * 4 + 1]); bs.push(v[i * 4 + 3]); }
      const pts = bulgePts(xs, ys, bs, (p.flags & 1) === 1);
      const o = p.o, z = p.elev;
      const T = (x: number, y: number): V3 => (o ? [o[0] * x + o[1] * y + o[2] * z, o[3] * x + o[4] * y + o[5] * z, o[6] * x + o[7] * y + o[8] * z] : [x, y, z]);
      for (let i = 2; i < pts.length; i += 2) sink.seg(...T(pts[i - 2], pts[i - 1]), ...T(pts[i], pts[i + 1]));
      for (let i = 0; i < nv; i++) sink.snap(...T(xs[i], ys[i]));
    }
    sink.end();
  }
}

// ---------------- main entry ----------------
export interface ParseOptions { origin?: [number, number, number]; onProgress?: (fraction: number) => void; /** bytes are UTF-8 regardless of $DWGCODEPAGE (e.g. DXF produced by our DWG converter) */ utf8?: boolean }

export function parseDxf(bytes: Uint8Array, opts: ParseOptions = {}): Drawing {
  arcTol = 0;
  const head = new TextDecoder().decode(bytes.subarray(0, 22));
  if (head.startsWith('AutoCAD Binary DXF')) throw new Error('This is a binary DXF. Save it as ASCII DXF and try again.');
  const rd = new DxfReader(bytes);
  const er = new EntityReader(rd);
  const layerTable = new Map<string, { color: number; visible: boolean }>();
  const blocks = new Map<string, BlockDef>();
  let units = 0, acadver = '';
  let extMin: number[] | null = null, extMax: number[] | null = null;
  let world: WorldSink | null = null;
  const layerColor = (name: string) => layerTable.get(name)?.color ?? FG;
  const getWorld = (): WorldSink => {
    if (!world) {
      let origin = opts.origin ?? null;
      if (!origin && extMin && extMax && extMin.every((v, i) => isFinite(v) && Math.abs(v) < 1e15 && v <= extMax![i]))
        origin = [(extMin[0] + extMax[0]) / 2, (extMin[1] + extMax[1]) / 2, 0];
      world = new WorldSink(layerColor, blocks, origin);
    }
    return world;
  };

  let section = '';
  let headerVar = '';
  const rec = new Rec();
  let inRec = false;
  let block: { name: string; def: BlockDef; sink: BlockSink; skip: boolean } | null = null;
  let lastProgress = 0;
  let sawEntities = false;

  const flush = () => {
    if (!inRec) return;
    inRec = false;
    const r = rec;
    if (section === 'TABLES') {
      if (r.type === 'LAYER') {
        const name = er.str(r, 2) ?? '0';
        const aci = r.get(62, 7);
        let color = Math.abs(aci) === 7 ? FG : ACI[Math.abs(aci)] ?? FG;
        for (let i = 0; i < r.n; i++) if (r.codes[i] === 420) color = r.nums[i] & 0xffffff;
        layerTable.set(name, { color, visible: aci >= 0 && !(r.get(70) & 1) });
      }
    } else if (section === 'BLOCKS') {
      if (r.type === 'BLOCK') {
        const name = er.str(r, 2) ?? '';
        const def: BlockDef = { base: [r.get(10), r.get(20), r.get(30)], parts: [] };
        block = { name, def, sink: new BlockSink(def), skip: /^\*paper_space/i.test(name) };
      } else if (r.type === 'ENDBLK') {
        if (block) { if (er.poly) er.flushPoly(block.sink); if (!block.skip) blocks.set(block.name, block.def); }
        block = null;
      } else if (block && !block.skip) {
        er.handle(r, block.sink);
      }
    } else if (section === 'ENTITIES') {
      if (r.get(67) === 1) return; // paper-space (layout) entity: not part of the model
      er.handle(r, getWorld());
    }
  };

  while (rd.next()) {
    const code = rd.code;
    if (code === 0) {
      flush();
      const type = rd.str();
      if (type === 'SECTION') {
        if (rd.next() && rd.code === 2) section = rd.str();
        if (section === 'ENTITIES') sawEntities = true;
        continue;
      }
      if (type === 'ENDSEC') {
        if (section === 'HEADER' && extMin && extMax) {
          const ext = Math.max(extMax[0] - extMin[0], extMax[1] - extMin[1]);
          arcTol = isFinite(ext) && ext > 0 && ext < 1e15 ? ext * 2e-6 : 0;
        }
        { const blk = block as { sink: BlockSink } | null; if (er.poly) er.flushPoly(section === 'BLOCKS' && blk ? blk.sink : getWorld()); }
        section = '';
        continue;
      }
      if (type === 'EOF') break;
      rec.type = type;
      rec.n = 0;
      inRec = true;
      if (rd.pos - lastProgress > 1 << 20) { lastProgress = rd.pos; opts.onProgress?.(rd.pos / bytes.length); }
      continue;
    }
    if (section === 'HEADER') {
      if (code === 9) { headerVar = rd.str(); continue; }
      if (headerVar === '$INSUNITS' && code === 70) units = rd.num();
      else if (headerVar === '$ACADVER' && code === 1) acadver = rd.str();
      else if (headerVar === '$DWGCODEPAGE' && code === 3) {
        const cp = CODEPAGES[rd.str().toUpperCase()];
        // R2007+ (AC1021) files are always UTF-8; older ones use the drawing code page
        if (cp && acadver && acadver < 'AC1021' && !opts.utf8) { try { rd.dec = new TextDecoder(cp); } catch { /* keep utf-8 */ } }
      } else if (headerVar === '$EXTMIN' && (code === 10 || code === 20 || code === 30)) (extMin ??= [0, 0, 0])[code / 10 - 1] = rd.num();
      else if (headerVar === '$EXTMAX' && (code === 10 || code === 20 || code === 30)) (extMax ??= [0, 0, 0])[code / 10 - 1] = rd.num();
      continue;
    }
    if (!inRec || code >= 1000 || code === 999) continue;
    if (rec.n >= rec.codes.length) rec.grow();
    const i = rec.n++;
    rec.codes[i] = code;
    rec.ss[i] = rd.s;
    rec.se[i] = rd.e;
    rec.nums[i] = isNum(code) ? rd.num() : 0;
  }
  flush();
  const w = getWorld();
  if (er.poly) er.flushPoly(w);
  opts.onProgress?.(1);
  if (!sawEntities && !w.buckets.length) throw new Error('No drawing data found. Is this a DXF file?');

  const layers = w.layerNames.map((name) => {
    const l = layerTable.get(name);
    return { name, color: l?.color ?? FG, visible: l ? l.visible : true };
  });
  const bounds: Drawing['bounds'] = isFinite(w.bmin[0]) ? [w.bmin[0], w.bmin[1], w.bmin[2], w.bmax[0], w.bmax[1], w.bmax[2]] : [0, 0, 0, 0, 0, 0];
  return {
    origin: w.origin ?? [0, 0, 0],
    units: UNITS[units] ?? 'units',
    layers,
    buckets: w.buckets.map((b) => ({ layer: b.layer, color: b.color, chunks: b.f.out(), length: b.f.n })),
    pieces: w.pieces.out(),
    text: { values: w.tv, num: w.tn.out(), align: Uint8Array.from(w.ta), color: w.tc.out(), layer: w.tl.out() },
    snap: w.snapP.out(),
    snapLayer: w.snapL.out(),
    bounds,
    skipped: er.skipped,
    entities: er.count,
  };
}
