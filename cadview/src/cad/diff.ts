// Revision compare on the streaming Drawing format. Each drawn piece (one entity, or one
// block part) gets an order- and direction-independent 53-bit geometric hash, so the result
// survives re-saves, handle changes and entity reordering. Both drawings must share an origin.
import { CHUNK, type Drawing, type Bucket } from './dxf';

export const SAME = 0, REMOVED = 1, ADDED = 2;
export interface DiffResult { drawing: Drawing; added: number; removed: number; same: number }

const mix = (h: number, v: number) => Math.imul(h ^ v, 0x01000193) >>> 0;
const mix2 = (h: number, v: number) => Math.imul(h ^ v, 0x5bd1e995) >>> 0;

function segHash(q: number[], seed: number, m: (h: number, v: number) => number) {
  let h = seed;
  for (const v of q) h = m(h, v | 0);
  return h;
}

/** Per-piece keys. Uses sums of per-segment hashes so segment order inside a piece doesn't matter. */
function pieceKeys(d: Drawing, tol: number): Float64Array {
  const np = d.pieces.length / 3;
  const keys = new Float64Array(np);
  const qa = [0, 0, 0], qb = [0, 0, 0];
  for (let p = 0; p < np; p++) {
    const bk = d.buckets[d.pieces[p * 3]], s = d.pieces[p * 3 + 1], e = d.pieces[p * 3 + 2];
    let s1 = 0, s2 = 0;
    for (let i = s; i < e; i += 6) {
      const data = bk.chunks[(i / CHUNK) | 0], o = i % CHUNK; // segments never straddle chunks
      for (let k = 0; k < 3; k++) { qa[k] = Math.round(data[o + k] / tol); qb[k] = Math.round(data[o + 3 + k] / tol); }
      const swap = qa[0] > qb[0] || (qa[0] === qb[0] && (qa[1] > qb[1] || (qa[1] === qb[1] && qa[2] > qb[2])));
      const q = swap ? [...qb, ...qa] : [...qa, ...qb];
      s1 = (s1 + segHash(q, 0x811c9dc5, mix)) >>> 0;
      s2 = (s2 + segHash(q, 0x2545f491, mix2)) >>> 0;
    }
    const n = (e - s) / 6;
    keys[p] = ((s1 ^ Math.imul(n, 0x9e3779b9)) >>> 0) * 2097152 + (s2 & 0x1fffff);
  }
  return keys;
}

function textKeys(d: Drawing, tol: number): Float64Array {
  const t = d.text, keys = new Float64Array(t.values.length);
  for (let i = 0; i < t.values.length; i++) {
    let h1 = 0x811c9dc5, h2 = 0x2545f491;
    const s = t.values[i];
    for (let k = 0; k < s.length; k++) { h1 = mix(h1, s.charCodeAt(k)); h2 = mix2(h2, s.charCodeAt(k)); }
    h1 = mix(mix(h1, Math.round(t.num[i * 5] / tol)), Math.round(t.num[i * 5 + 1] / tol));
    h2 = mix2(mix2(h2, Math.round(t.num[i * 5] / tol)), Math.round(t.num[i * 5 + 1] / tol));
    keys[i] = h1 * 2097152 + (h2 & 0x1fffff);
  }
  return keys;
}

/** state per item of A (SAME/REMOVED) and of B (SAME/ADDED), multiset-aware. */
function match(ka: Float64Array, kb: Float64Array): [Uint8Array, Uint8Array] {
  const pool = new Map<number, number>();
  for (const k of kb) pool.set(k, (pool.get(k) ?? 0) + 1);
  const sa = new Uint8Array(ka.length), sb = new Uint8Array(kb.length);
  const used = new Map<number, number>();
  for (let i = 0; i < ka.length; i++) {
    const left = pool.get(ka[i]) ?? 0;
    if (left > 0) { pool.set(ka[i], left - 1); used.set(ka[i], (used.get(ka[i]) ?? 0) + 1); sa[i] = SAME; }
    else sa[i] = REMOVED;
  }
  for (let i = 0; i < kb.length; i++) {
    const u = used.get(kb[i]) ?? 0;
    if (u > 0) { used.set(kb[i], u - 1); sb[i] = SAME; } else sb[i] = ADDED;
  }
  return [sa, sb];
}

export function autoTolerance(a: Drawing, b: Drawing) {
  const ext = Math.max(a.bounds[3] - a.bounds[0], a.bounds[4] - a.bounds[1], b.bounds[3] - b.bounds[0], b.bounds[4] - b.bounds[1], 1e-6);
  return Math.max(ext * 1e-6, 1e-9);
}

/** Build a display Drawing with three "layers": Unchanged, Removed, Added. */
export function diffDrawings(a: Drawing, b: Drawing, tol = autoTolerance(a, b)): DiffResult {
  const [pa, pb] = match(pieceKeys(a, tol), pieceKeys(b, tol));
  const [ta, tb] = match(textKeys(a, tol), textKeys(b, tol));
  const COLORS = [0x8a8f98, 0xef4444, 0x22c55e];
  const counts = [0, 0, 0];
  // two passes (size, then fill) so huge drawings never build giant JS number arrays
  const sizes = [0, 0, 0];
  const each = (d: Drawing, states: Uint8Array, skipSame: boolean, fn: (st: number, b: Bucket, s: number, e: number) => void) => {
    for (let p = 0; p < states.length; p++) {
      if (skipSame && states[p] === SAME) continue;
      fn(states[p], d.buckets[d.pieces[p * 3]], d.pieces[p * 3 + 1], d.pieces[p * 3 + 2]);
    }
  };
  const size = (st: number, _b: Bucket, s: number, e: number) => { sizes[st] += e - s; counts[st]++; };
  each(a, pa, false, size);
  each(b, pb, true, size);
  const arrs = sizes.map((n) => new Float32Array(n));
  const fill = [0, 0, 0];
  const put = (st: number, b: Bucket, s: number, e: number) => {
    for (let i = s; i < e; ) { // copy chunk by chunk
      const c = (i / CHUNK) | 0, o = i % CHUNK, k = Math.min(e - i, CHUNK - o);
      arrs[st].set(b.chunks[c].subarray(o, o + k), fill[st]);
      fill[st] += k; i += k;
    }
  };
  each(a, pa, false, put);
  each(b, pb, true, put);
  const buckets: Bucket[] = arrs.map((data, i) => ({ layer: i, color: COLORS[i], chunks: splitChunks(data), length: data.length })).filter((x) => x.length);
  // texts
  const values: string[] = [], num: number[] = [], align: number[] = [], color: number[] = [], layer: number[] = [];
  const addText = (d: Drawing, states: Uint8Array, skipSame: boolean) => {
    for (let i = 0; i < states.length; i++) {
      if (skipSame && states[i] === SAME) continue;
      if (states[i] !== SAME) counts[states[i]]++;
      else counts[SAME]++;
      values.push(d.text.values[i]);
      for (let k = 0; k < 5; k++) num.push(d.text.num[i * 5 + k]);
      align.push(d.text.align[i]); color.push(COLORS[states[i]]); layer.push(states[i]);
    }
  };
  addText(a, ta, false);
  addText(b, tb, true);
  const snap = new Float32Array(a.snap.length + b.snap.length);
  snap.set(a.snap); snap.set(b.snap, a.snap.length);
  const bb = a.bounds, cb = b.bounds;
  const drawing: Drawing = {
    origin: a.origin, units: a.units,
    layers: [{ name: 'Unchanged', color: COLORS[0], visible: true }, { name: 'Removed', color: COLORS[1], visible: true }, { name: 'Added', color: COLORS[2], visible: true }],
    buckets, pieces: new Uint32Array(0),
    text: { values, num: Float32Array.from(num), align: Uint8Array.from(align), color: Int32Array.from(color), layer: Uint16Array.from(layer) },
    snap, snapLayer: new Uint16Array(snap.length / 3),
    bounds: [Math.min(bb[0], cb[0]), Math.min(bb[1], cb[1]), Math.min(bb[2], cb[2]), Math.max(bb[3], cb[3]), Math.max(bb[4], cb[4]), Math.max(bb[5], cb[5])],
    skipped: {}, entities: a.entities + b.entities,
  };
  return { drawing, same: counts[SAME], removed: counts[REMOVED], added: counts[ADDED] };
}

function splitChunks(a: Float32Array): Float32Array[] {
  const out: Float32Array[] = [];
  for (let i = 0; i < a.length; i += CHUNK) out.push(a.subarray(i, Math.min(a.length, i + CHUNK)));
  return out;
}
