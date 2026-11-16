// Streaming DXF reader. Works directly on bytes and writes geometry straight into typed
// arrays batched by (layer, colour), so memory stays a small multiple of the output size
// instead of the 30-40× blow-up of object-based parsers. Runs in a Web Worker.
import { ACI } from './aci';
import { patternSegments, fillTriangles, type PatternLine } from './hatch';

/** floats per text in TextSet.num: x, y, z, height, rotation, width factor, wrap width (0 = none) */
export const TS = 7;

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
  /** per text (TS floats): x, y, z, height, rotation(rad), width factor, wrap width (MTEXT box, 0 = no wrap) */
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
  /** filled areas (solid hatches, SOLIDs, wide polylines, arrowheads) as x,y,z triangles */
  fills: { layer: number; color: number; alpha: number; data: Float32Array }[];
  /** display tiles (set by the worker; then `buckets[].chunks` are released) */
  tiles?: import('./tiles').Tile[];
}

type CS = { mode: 0 | 1 | 2; color: number; lt?: string; lts?: number }; // colour: 0 ByLayer, 1 ByBlock, 2 explicit (rgb, or -1 = foreground); lt = linetype name
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
interface TextItem { v: string; x: number; y: number; z: number; h: number; rot: number; align: number; wf: number; ww: number }
interface InsertItem { name: string; m: M; layer: string; cs: CS; dim: boolean }
interface Part { layer: string; cs: CS; segs: number[]; snaps: number[]; texts: TextItem[]; inserts: InsertItem[]; fills: { a: number; t: number[] }[] }
interface BlockDef { base: [number, number, number]; parts: Part[] }

interface Sink {
  begin(layer: string, cs: CS): void;
  seg(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): void;
  snap(x: number, y: number, z: number): void;
  text(t: TextItem): void;
  /** filled triangles x,y,z,… (alpha < 1 = light tint, used for very dense hatch patterns) */
  fill(tris: number[], alpha?: number): void;
  insert(i: InsertItem): void;
  end(): void;
}

class BlockSink implements Sink {
  cur: Part | null = null;
  constructor(public def: BlockDef) {}
  begin(layer: string, cs: CS) { this.cur = { layer, cs, segs: [], snaps: [], texts: [], inserts: [], fills: [] }; }
  fill(tris: number[], alpha = 1) { if (tris.length) this.cur!.fills.push({ a: alpha, t: tris }); }
  seg(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) { this.cur!.segs.push(x1, y1, z1, x2, y2, z2); }
  snap(x: number, y: number, z: number) { this.cur!.snaps.push(x, y, z); }
  text(t: TextItem) { this.cur!.texts.push(t); }
  insert(i: InsertItem) { this.cur!.inserts.push(i); }
  end() { const c = this.cur!; if (c.segs.length || c.snaps.length || c.texts.length || c.inserts.length || c.fills.length) this.def.parts.push(c); this.cur = null; }
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
  fillB: { layer: number; color: number; alpha: number; f: F32 }[] = [];
  fillKey = new Map<string, number>();
  private cb = -1;
  private cl = 0;
  private cc = FG;
  private pieceStart = 0;
  // current dash pattern (already scaled) and where we are in it
  private pat: number[] | null = null;
  private patLen = 0;
  private pi = 0;
  private po = 0;
  private lx = NaN; private ly = NaN; private lz = NaN;
  constructor(public layerColor: (name: string) => number, public blocks: Map<string, BlockDef>, origin: [number, number, number] | null,
    public lt: { types: Map<string, number[]>; layerLt: (layer: string) => string; scale: number }) {
    this.origin = origin;
  }
  /** effective linetype name: ByLayer → the layer's, ByBlock → the inserting block's */
  ltName(layer: string, cs: CS, inherited = 'CONTINUOUS') {
    const n = (cs.lt ?? 'BYLAYER').toUpperCase();
    return n === 'BYBLOCK' ? inherited : n === 'BYLAYER' ? this.lt.layerLt(layer) : n;
  }
  patternFor(name: string, lts = 1): number[] | null {
    const p = this.lt.types.get(name);
    if (!p || !p.length || !p.some((x) => x < 0)) return null; // continuous
    const k = this.lt.scale * (lts || 1);
    return p.map((x) => x * k);
  }
  layer(name: string) {
    let i = this.layerIdx.get(name);
    if (i === undefined) { i = this.layerNames.length; this.layerNames.push(name); this.layerIdx.set(name, i); }
    return i;
  }
  resolve(layer: string, cs: CS) { return cs.mode === 2 ? cs.color : cs.mode === 1 ? FG : this.layerColor(layer); }
  begin(layer: string, cs: CS) { this.beginResolved(layer, this.resolve(layer, cs), this.patternFor(this.ltName(layer, cs), cs.lts)); }
  beginResolved(layer: string, color: number, pattern: number[] | null = null) {
    this.cl = this.layer(layer); this.cc = color; this.cb = -1;
    this.pat = pattern; this.patLen = pattern ? pattern.reduce((s2, x) => s2 + Math.abs(x), 0) : 0;
    this.pi = 0; this.po = 0; this.lx = NaN;
  }
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
    if (this.pat && this.patLen > 0) this.dashed(x1, y1, z1, x2, y2, z2);
    else this.solid(x1, y1, z1, x2, y2, z2);
  }
  /** Split a segment by the dash pattern; the pattern carries on across connected segments (polyline corners). */
  private dashed(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) {
    const p = this.pat!, L = Math.hypot(x2 - x1, y2 - y1, z2 - z1);
    if (!(x1 === this.lx && y1 === this.ly && z1 === this.lz)) { this.pi = 0; this.po = 0; }
    this.lx = x2; this.ly = y2; this.lz = z2;
    if (L === 0) return;
    if (L / this.patLen > 3000) { this.solid(x1, y1, z1, x2, y2, z2); return; } // too fine to see: solid
    const ux = (x2 - x1) / L, uy = (y2 - y1) / L, uz = (z2 - z1) / L;
    let t = 0, guard = 0;
    while (t < L - 1e-12 && guard++ < 20000) {
      const e = p[this.pi], len = Math.abs(e);
      const step = Math.min(len - this.po, L - t);
      if (e > 0) this.solid(x1 + ux * t, y1 + uy * t, z1 + uz * t, x1 + ux * (t + step), y1 + uy * (t + step), z1 + uz * (t + step));
      else if (e === 0) { const d = Math.min(L - t, this.patLen * 0.004); this.solid(x1 + ux * t, y1 + uy * t, z1 + uz * t, x1 + ux * (t + d), y1 + uy * (t + d), z1 + uz * (t + d)); }
      t += step; this.po += step;
      if (this.po >= len - 1e-12) { this.pi = (this.pi + 1) % p.length; this.po = 0; }
    }
  }
  fill(tris: number[], alpha = 1) {
    if (tris.length < 9) return;
    const key = `${this.cl}|${this.cc}|${alpha}`;
    let b = this.fillKey.get(key);
    if (b === undefined) { b = this.fillB.length; this.fillB.push({ layer: this.cl, color: this.cc, alpha, f: new F32(256) }); this.fillKey.set(key, b); }
    const f = this.fillB[b].f, [ox, oy, oz] = this.o(tris[0], tris[1], tris[2]);
    f.room(tris.length);
    for (let i = 0; i < tris.length; i += 3) {
      const x = tris[i] - ox, y = tris[i + 1] - oy, z = tris[i + 2] - oz;
      f.a[f.n++] = x; f.a[f.n++] = y; f.a[f.n++] = z;
      this.grow(x, y, z);
    }
  }
  private solid(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) {
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
    this.tn.push(t.x - ox); this.tn.push(t.y - oy); this.tn.push(t.z - oz); this.tn.push(t.h); this.tn.push(t.rot); this.tn.push(t.wf || 1); this.tn.push(t.ww || 0);
    this.ta.push(t.align);
    this.tc.push(this.cc);
    this.tl.push(this.cl);
    // extents include the space the text takes up (not just its insertion point), so "fit" and exports don't cut it off
    const x = t.x - ox, y = t.y - oy, z = t.z - oz, lines = t.v.split('\n');
    const longest = Math.max(...lines.map((l) => l.length));
    const w = t.ww > 0 ? t.ww : longest * t.h * 0.62 * (t.wf || 1);
    const nl = t.ww > 0 ? Math.max(lines.length, Math.ceil((t.v.length * t.h * 0.62 * (t.wf || 1)) / t.ww)) : lines.length;
    const hh = t.h * (1 + (nl - 1) * 1.667);
    const ax = t.align & 3, ay = (t.align >> 2) & 3;
    if (Math.abs(Math.sin(t.rot)) > 0.01) { const rr = Math.hypot(w, hh); this.grow(x - rr, y - rr, z); this.grow(x + rr, y + rr, z); return; }
    const x0 = ax === 1 ? x - w / 2 : ax === 2 ? x - w : x;
    const y0 = ay === 3 ? y - hh : ay === 2 ? y - hh / 2 : y - t.h * 0.3;
    this.grow(x0, y0, z);
    this.grow(x0 + w, y0 + hh + (ay === 3 || ay === 2 ? 0 : t.h * 0.3), z);
  }
  end() {
    if (this.cb >= 0) {
      const f = this.buckets[this.cb].f;
      if (f.n > this.pieceStart) { this.pieces.push(this.cb); this.pieces.push(this.pieceStart); this.pieces.push(f.n); }
    }
    this.cb = -1;
  }
  insert(ins: InsertItem) { this.expand(ins, ins.m, this.resolve(ins.layer, ins.cs), ins.layer, 0, this.ltName(ins.layer, ins.cs)); }

  /** Instantiate a block: transform its pre-tessellated parts into world buckets. */
  private expand(ins: InsertItem, m0: M, insColor: number, insLayer: string, depth: number, insLt: string) {
    const def = this.blocks.get(ins.name);
    if (!def || depth > 12) return;
    const m = ins.dim ? m0 : mul(m0, translate(-def.base[0], -def.base[1], -def.base[2]));
    const ys = Math.hypot(m[1], m[4], m[7]), xs = Math.hypot(m[0], m[3], m[6]);
    const xr = Math.atan2(m[3], m[0]);
    for (const part of def.parts) {
      const layer = part.layer === '0' ? insLayer : part.layer;
      const color = part.cs.mode === 2 ? part.cs.color : part.cs.mode === 1 ? insColor : this.layerColor(layer);
      const ltn = this.ltName(layer, part.cs, insLt);
      this.beginResolved(layer, color, this.patternFor(ltn, part.cs.lts));
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
        this.text({ ...t, x: m[0] * t.x + m[1] * t.y + m[2] * t.z + m[9], y: m[3] * t.x + m[4] * t.y + m[5] * t.z + m[10], z: m[6] * t.x + m[7] * t.y + m[8] * t.z + m[11], h: t.h * ys, rot: t.rot + xr, wf: t.wf * (ys ? xs / ys : 1), ww: t.ww * xs });
      for (const fl of part.fills) {
        const tr = fl.t, o: number[] = new Array(tr.length);
        for (let i = 0; i < tr.length; i += 3) {
          const x = tr[i], y = tr[i + 1], z = tr[i + 2];
          o[i] = m[0] * x + m[1] * y + m[2] * z + m[9]; o[i + 1] = m[3] * x + m[4] * y + m[5] * z + m[10]; o[i + 2] = m[6] * x + m[7] * y + m[8] * z + m[11];
        }
        this.fill(o, fl.a);
      }
      this.end();
      for (const sub of part.inserts) {
        const subLayer = sub.layer === '0' ? layer : sub.layer;
        const subColor = sub.cs.mode === 2 ? sub.cs.color : sub.cs.mode === 1 ? color : this.layerColor(subLayer);
        this.expand(sub, mul(m, sub.m), subColor, subLayer, depth + 1, this.ltName(subLayer, sub.cs, ltn));
      }
    }
  }
}

// ---------------- entity interpretation ----------------
function colorSpec(r: Rec, lt?: string): CS {
  const lts = r.get(48, 1);
  for (let i = 0; i < r.n; i++) if (r.codes[i] === 420) return { mode: 2, color: r.nums[i] & 0xffffff, lt, lts };
  let idx = 256;
  for (let i = 0; i < r.n; i++) if (r.codes[i] === 62) { idx = Math.abs(r.nums[i]); break; }
  if (idx === 0) return { mode: 1, color: 0, lt, lts };
  if (idx >= 256) return { mode: 0, color: 0, lt, lts };
  return { mode: 2, color: idx === 7 ? FG : ACI[idx], lt, lts };
}

export interface TextStyle { wf: number; h: number; font: string }
/** CAD fonts (SHX "romans", "simplex"…) are narrower than the phone's sans-serif: compensate. */
function fontFactor(font: string) {
  const f = font.toLowerCase();
  if (f.includes('narrow') || f.startsWith('arialn')) return 0.82;
  if (f.endsWith('.shx') || (!f.includes('.') && f)) return 0.86;
  return 1;
}

/** Filled arrowhead: tip at (x,y), pointing away from (tx,ty). AutoCAD's closed filled arrow is 1/3 as wide as it is long. */
function arrow(x: number, y: number, z: number, tx: number, ty: number, size: number): number[] {
  const dx = tx - x, dy = ty - y, L = Math.hypot(dx, dy);
  if (!L || !(size > 0)) return [];
  const ux = dx / L, uy = dy / L, s = Math.min(size, L), w = s / 6;
  const bx = x + ux * s, by = y + uy * s;
  return [x, y, z, bx - uy * w, by + ux * w, z, bx + uy * w, by - ux * w, z];
}

/** Filled band for polylines with width (also how AutoCAD users draw arrows and thick title lines). */
function widthBand(pts: number[], ws: number[], we: number[], z: number, P: (x: number, y: number, z: number) => [number, number, number]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i], ay = pts[i + 1], bx = pts[i + 2], by = pts[i + 3], k = i / 2;
    const L = Math.hypot(bx - ax, by - ay);
    if (!L) continue;
    const nx = -(by - ay) / L, ny = (bx - ax) / L, a = (ws[k] ?? 0) / 2, b = (we[k] ?? 0) / 2;
    if (a <= 0 && b <= 0) continue;
    const q = [P(ax + nx * a, ay + ny * a, z), P(ax - nx * a, ay - ny * a, z), P(bx - nx * b, by - ny * b, z), P(bx + nx * b, by + ny * b, z)];
    out.push(...q[0], ...q[1], ...q[2], ...q[0], ...q[2], ...q[3]);
  }
  return out;
}

type V3 = [number, number, number];
interface PolyState { flags: number; layer: string; cs: CS; elev: number; o: M | null; m: number; n: number; v: number[]; faces: number[]; w0: number; w1: number }
const PV = 6; // floats per POLYLINE vertex: x, y, z, bulge, start width, end width

class EntityReader {
  skipped: Record<string, number> = {};
  count = 0;
  poly: PolyState | null = null;
  constructor(private rd: DxfReader, private ctx: { styles: Map<string, TextStyle>; arrow: () => number }) {}
  style(r: Rec): TextStyle {
    const n = (this.str(r, 7) || 'STANDARD').toUpperCase();
    return this.ctx.styles.get(n) ?? this.ctx.styles.get('STANDARD') ?? { wf: 1, h: 0, font: '' };
  }

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
      else this.poly.v.push(r.get(10), r.get(20), r.get(30), r.get(42), r.has(40) ? r.get(40) : this.poly.w0, r.has(41) ? r.get(41) : this.poly.w1);
      return;
    }
    if (t === 'SEQEND') { if (this.poly) this.flushPoly(sink); return; }
    if (this.poly) this.flushPoly(sink);
    this.count++;

    const layer = this.str(r, 8) || '0';
    const cs = colorSpec(r, this.str(r, 6) ?? undefined);
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
        const xs: number[] = [], ys: number[] = [], bs: number[] = [], w0: number[] = [], w1: number[] = [];
        const cw = r.get(43, 0);
        for (let i = 0; i < r.n; i++) {
          const c = r.codes[i];
          if (c === 10) { xs.push(r.nums[i]); ys.push(0); bs.push(0); w0.push(cw); w1.push(cw); }
          else if (c === 20 && ys.length) ys[ys.length - 1] = r.nums[i];
          else if (c === 42 && bs.length) bs[bs.length - 1] = r.nums[i];
          else if (c === 40 && w0.length) w0[w0.length - 1] = r.nums[i];
          else if (c === 41 && w1.length) w1[w1.length - 1] = r.nums[i];
        }
        if (!xs.length) return;
        // a constant width (43) wins over per-vertex widths written as 0 (some writers emit both)
        if (cw > 0) for (let i = 0; i < w0.length; i++) if (!w0[i] && !w1[i]) { w0[i] = cw; w1[i] = cw; }
        const closed = (r.get(70) & 1) === 1;
        const z = r.get(38);
        sink.begin(layer, cs);
        line2(bulgePts(xs, ys, bs, closed), z);
        if (w0.some((w) => w > 0) || w1.some((w) => w > 0)) sink.fill(this.wideBand(xs, ys, bs, w0, w1, closed, z, P));
        for (let i = 0; i < xs.length; i++) sink.snap(...P(xs[i], ys[i], z));
        sink.end();
        return;
      }
      case 'POLYLINE': {
        const flags = r.get(70);
        this.poly = { flags, layer, cs, elev: r.get(30), o: flags & (8 | 16 | 64) ? null : ex, m: r.get(71), n: r.get(72), v: [], faces: [], w0: r.get(40, 0), w1: r.get(41, 0) };
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
        // SOLID/TRACE are filled (dimension arrowheads are usually SOLIDs)
        if (t !== '3DFACE') sink.fill([...q[0], ...q[1], ...q[2], ...q[1], ...q[3], ...q[2]]);
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
        if (v.length >= 6 && r.get(71, 1) === 1) sink.fill(arrow(v[0], v[1], v[2], v[3], v[4], this.ctx.arrow()));
        sink.end();
        return;
      }
      case 'HATCH':
        sink.begin(layer, cs);
        this.hatch(r, sink, P);
        sink.end();
        return;
      case 'MULTILEADER':
      case 'MLEADER':
        sink.begin(layer, cs);
        this.mleader(r, sink);
        sink.end();
        return;
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
        const st = this.style(r);
        sink.begin(layer, cs);
        sink.text({ v: cleanText(raw), x: p[0], y: p[1], z: p[2], h: r.get(40, 0) || st.h || 1, rot, align: ax | (ay << 2), wf: (r.has(41) ? r.get(41) : st.wf || 1) * fontFactor(st.font), ww: 0 });
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
        const st = this.style(r);
        sink.begin(layer, cs);
        // code 41 = width of the MTEXT box: lines are wrapped to it when drawn
        sink.text({ v: cleanText(raw), x, y, z, h: r.get(40, 0) || st.h || 1, rot, align: ((a - 1) % 3) | ((a <= 3 ? 3 : a <= 6 ? 2 : 1) << 2) | 16, wf: (st.wf || 1) * fontFactor(st.font), ww: r.get(41, 0) });
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

  /** Filled band of a polyline with widths; arc (bulge) segments are subdivided with interpolated width. */
  wideBand(xs: number[], ys: number[], bs: number[], w0: number[], w1: number[], closed: boolean, z: number, P: (x: number, y: number, z: number) => V3): number[] {
    const n = xs.length, out: number[] = [];
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const pts = bulgePts([xs[i], xs[j]], [ys[i], ys[j]], [bs[i] || 0, 0], false);
      const k = pts.length / 2 - 1, ws: number[] = [], we: number[] = [];
      for (let q = 0; q < k; q++) { ws.push(w0[i] + ((w1[i] - w0[i]) * q) / k); we.push(w0[i] + ((w1[i] - w0[i]) * (q + 1)) / k); }
      out.push(...widthBand(pts, ws, we, z, P));
    }
    return out;
  }

  /** HATCH: boundary paths → pattern lines clipped to them, or a solid fill. Hatch coordinates are in OCS. */
  hatch(r: Rec, sink: Sink, P: (x: number, y: number, z: number) => V3) {
    const C = r.codes, N = r.nums, n = r.n;
    const z = r.get(30);
    let k = 0;
    while (k < n && C[k] !== 91) k++;
    if (k >= n) return;
    const solid = r.get(70) === 1, nPaths = N[k++];
    const at = (code: number, def = 0) => (k < n && C[k] === code ? N[k++] : def);
    const loops: number[][] = [];
    for (let pth = 0; pth < nPaths && k < n; pth++) {
      while (k < n && C[k] !== 92) k++;
      const flags = at(92);
      let loop: number[] = [];
      if (flags & 2) { // polyline path
        const hasB = at(72), _closed = at(73, 1), cnt = at(93);
        void _closed;
        const xs: number[] = [], ys: number[] = [], bs: number[] = [];
        for (let v = 0; v < cnt; v++) { xs.push(at(10)); ys.push(at(20)); bs.push(hasB ? at(42) : 0); }
        loop = bulgePts(xs, ys, bs, true);
      } else { // edges
        const ne = at(93);
        for (let e = 0; e < ne && k < n; e++) {
          const type = at(72, 1);
          if (type === 1) { const x1 = at(10), y1 = at(20), x2 = at(11), y2 = at(21); loop.push(x1, y1, x2, y2); }
          else if (type === 2 || type === 3) {
            const cx = at(10), cy = at(20);
            const mx = type === 3 ? at(11) : 0, my = type === 3 ? at(21) : 0;
            const rad = at(40), s0 = at(50), s1 = at(51), ccw = at(73, 1);
            // clockwise edges store their angles mirrored (measured clockwise)
            let a0 = (s0 * Math.PI) / 180, a1 = (s1 * Math.PI) / 180;
            if (!ccw) { a0 = -a0; a1 = -a1; }
            let sweep = ccw ? a1 - a0 : a0 - a1;
            while (sweep <= 0) sweep += Math.PI * 2;
            const steps = Math.max(8, Math.ceil((sweep / (Math.PI * 2)) * 64));
            const maj = type === 3 ? Math.hypot(mx, my) : rad, rot = type === 3 ? Math.atan2(my, mx) : 0, minr = type === 3 ? maj * rad : rad;
            for (let q = 0; q <= steps; q++) {
              const a = a0 + (ccw ? 1 : -1) * (sweep * q) / steps, ex2 = maj * Math.cos(a), ey2 = minr * Math.sin(a);
              loop.push(cx + ex2 * Math.cos(rot) - ey2 * Math.sin(rot), cy + ex2 * Math.sin(rot) + ey2 * Math.cos(rot));
            }
          } else if (type === 4) {
            const deg = at(94, 3), rat = at(73), _per = at(74), nk = at(95), nc = at(96);
            void _per;
            const knots: number[] = [], cps: number[] = [], w: number[] = [];
            for (let q = 0; q < nk; q++) knots.push(at(40));
            for (let q = 0; q < nc; q++) { cps.push(at(10), at(20), 0); if (rat) w.push(at(42, 1)); }
            const nf = at(97);
            const fits: number[] = [];
            for (let q = 0; q < nf; q++) fits.push(at(11), at(21), 0);
            if (C[k] === 12) { at(12); at(22); } if (C[k] === 13) { at(13); at(23); }
            const sp = cps.length ? splinePts(cps, knots, deg, w) : fits;
            for (let q = 0; q < sp.length; q += 3) loop.push(sp[q], sp[q + 1]);
          }
        }
      }
      // drop consecutive duplicates (edge end = next edge start)
      const clean: number[] = [];
      for (let q = 0; q < loop.length; q += 2) {
        const L2 = clean.length;
        if (!L2 || Math.abs(clean[L2 - 2] - loop[q]) > 1e-9 || Math.abs(clean[L2 - 1] - loop[q + 1]) > 1e-9) clean.push(loop[q], loop[q + 1]);
      }
      if (clean.length >= 6) loops.push(clean);
      const src = at(97);
      for (let q = 0; q < src && k < n && C[k] === 330; q++) k++;
    }
    if (!loops.length) return;
    // pattern definition lines (already scaled/rotated in the file)
    const lines: PatternLine[] = [];
    while (k < n && C[k] !== 78 && C[k] !== 450) k++;
    if (k < n && C[k] === 78) {
      const nl = at(78);
      for (let q = 0; q < nl && k < n; q++) {
        const angle = at(53), bx = at(43), by = at(44), ox = at(45), oy = at(46), nd = at(79);
        const dashes: number[] = [];
        for (let d = 0; d < nd; d++) dashes.push(at(49));
        lines.push({ angle, bx, by, ox, oy, dashes });
      }
    }
    const gradient = r.get(450) === 1;
    const to3 = (xy: number[]) => { const o: number[] = []; for (let q = 0; q < xy.length; q += 2) o.push(...P(xy[q], xy[q + 1], z)); return o; };
    if (solid || gradient || !lines.length) { sink.fill(to3(fillTriangles(loops))); return; }
    const segs = patternSegments(loops, lines);
    if (!segs) { sink.fill(to3(fillTriangles(loops)), 0.28); return; } // too dense to see as lines: light tint
    for (let q = 0; q < segs.length; q += 4) { const a = P(segs[q], segs[q + 1], z), b = P(segs[q + 2], segs[q + 3], z); sink.seg(...a, ...b); }
  }

  /** MULTILEADER: leader lines with arrowheads, landing (dogleg) and its MTEXT. */
  mleader(r: Rec, sink: Sink) {
    const C = r.codes, N = r.nums, n = r.n;
    let inLeader = false, inLine = false, text = '', tx = NaN, ty = 0, tz = 0, th = 0, trot = 0, tw = 0, asz = 0, attach = 1;
    let conn: V3 | null = null, dogX = 0, dogY = 0, dogLen = 0, cur: number[] = [];
    const lines: { pts: number[]; conn: V3 | null }[] = [];
    const landings: [V3, number, number, number][] = [];
    for (let k = 0; k < n; k++) {
      const c = C[k], v = N[k];
      if (c === 302 || c === 303 || c === 304 || c === 305) {
        const sv = this.rd.str(r.ss[k], r.se[k], false);
        if (c === 302 && sv.trim() === 'LEADER{') { inLeader = true; conn = null; dogX = 0; dogY = 0; dogLen = 0; }
        else if (c === 304 && sv.trim() === 'LEADER_LINE{') { inLine = true; cur = []; }
        else if (c === 305 && inLine) { inLine = false; lines.push({ pts: cur, conn }); }
        else if (c === 303 && inLeader) { inLeader = false; if (conn) landings.push([conn, dogX, dogY, dogLen]); }
        else if (c === 304 && !inLeader && !text) text = sv;
        continue;
      }
      if (inLine) { if (c === 10) cur.push(v, 0, 0); else if (c === 20) cur[cur.length - 2] = v; else if (c === 30) cur[cur.length - 1] = v; }
      else if (inLeader) {
        if (c === 10) conn = [v, 0, 0]; else if (c === 20 && conn) conn[1] = v; else if (c === 30 && conn) conn[2] = v;
        else if (c === 11) dogX = v; else if (c === 21) dogY = v; else if (c === 40) dogLen = v;
      } else {
        if (c === 12 && isNaN(tx)) tx = v; else if (c === 22) ty = v; else if (c === 32) tz = v;
        else if (c === 41 && !th) th = v; else if (c === 140 && !asz) asz = v; else if (c === 42) trot = v; else if (c === 43) tw = v;
        else if (c === 171) attach = v;
      }
    }
    const size = asz || this.ctx.arrow();
    for (const L of lines) {
      const pts = L.pts.slice();
      if (L.conn) pts.push(...L.conn);
      for (let i = 3; i < pts.length; i += 3) sink.seg(pts[i - 3], pts[i - 2], pts[i - 1], pts[i], pts[i + 1], pts[i + 2]);
      if (pts.length >= 6) { sink.fill(arrow(pts[0], pts[1], pts[2], pts[3], pts[4], size)); sink.snap(pts[0], pts[1], pts[2]); }
    }
    for (const [p, dx, dy, len] of landings) if (len > 0) sink.seg(p[0], p[1], p[2], p[0] + dx * len, p[1] + dy * len, p[2]);
    if (text && !isNaN(tx)) {
      const ax = attach === 2 ? 1 : attach === 3 ? 2 : 0;
      sink.text({ v: cleanText(text), x: tx, y: ty, z: tz, h: th || size, rot: trot, align: ax | (3 << 2) | 16, wf: 1, ww: tw });
    }
  }

  flushPoly(sink: Sink) {
    const p = this.poly!;
    this.poly = null;
    const { v, faces } = p;
    const nv = v.length / PV;
    if (!nv) return;
    sink.begin(p.layer, p.cs);
    const is3 = p.flags & (8 | 16 | 64);
    const W = (i: number): V3 => {
      const x = v[i * PV], y = v[i * PV + 1], z = is3 ? v[i * PV + 2] : p.elev, o = p.o;
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
      const w0: number[] = [], w1: number[] = [];
      for (let i = 0; i < nv; i++) { xs.push(v[i * PV]); ys.push(v[i * PV + 1]); bs.push(v[i * PV + 3]); w0.push(v[i * PV + 4]); w1.push(v[i * PV + 5]); }
      const pts = bulgePts(xs, ys, bs, (p.flags & 1) === 1);
      const o = p.o, z = p.elev;
      const T = (x: number, y: number): V3 => (o ? [o[0] * x + o[1] * y + o[2] * z, o[3] * x + o[4] * y + o[5] * z, o[6] * x + o[7] * y + o[8] * z] : [x, y, z]);
      for (let i = 2; i < pts.length; i += 2) sink.seg(...T(pts[i - 2], pts[i - 1]), ...T(pts[i], pts[i + 1]));
      for (let i = 0; i < nv; i++) sink.snap(...T(xs[i], ys[i]));
      if (w0.some((w) => w > 0) || w1.some((w) => w > 0)) sink.fill(this.wideBand(xs, ys, bs, w0, w1, (p.flags & 1) === 1, z, (x, y) => T(x, y)));
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
  const styles = new Map<string, TextStyle>();
  const ltypes = new Map<string, number[]>();
  let ltscale = 1, dimasz = 0, dimscale = 1;
  const er = new EntityReader(rd, { styles, arrow: () => (dimasz || 2.5) * (dimscale || 1) });
  const layerTable = new Map<string, { color: number; visible: boolean; lt: string }>();
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
      world = new WorldSink(layerColor, blocks, origin, {
        types: ltypes, scale: ltscale || 1,
        layerLt: (name) => (layerTable.get(name)?.lt ?? 'CONTINUOUS'),
      });
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
        layerTable.set(name, { color, visible: aci >= 0 && !(r.get(70) & 1), lt: (er.str(r, 6) || 'CONTINUOUS').toUpperCase() });
      } else if (r.type === 'LTYPE') {
        const name = (er.str(r, 2) ?? '').toUpperCase(), el: number[] = [];
        for (let i = 0; i < r.n; i++) if (r.codes[i] === 49) el.push(r.nums[i]);
        if (name) ltypes.set(name, el);
      } else if (r.type === 'STYLE') {
        const name = (er.str(r, 2) ?? '').toUpperCase();
        if (name) styles.set(name, { wf: r.get(41, 1) || 1, h: r.get(40, 0), font: er.str(r, 3) ?? '' });
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
      else if (headerVar === '$LTSCALE' && code === 40) ltscale = rd.num();
      else if (headerVar === '$DIMASZ' && code === 40) dimasz = rd.num();
      else if (headerVar === '$DIMSCALE' && code === 40) dimscale = rd.num();
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
    fills: w.fillB.map((b) => ({ layer: b.layer, color: b.color, alpha: b.alpha, data: b.f.out() })),
    bounds,
    skipped: er.skipped,
    entities: er.count,
  };
}
