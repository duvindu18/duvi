// Display-side re-organisation of 2D line geometry for smooth viewing of huge drawings:
//  • spatial tiles  → off-screen tiles are frustum-culled when zoomed in
//  • longest-first  → each tile's segments are sorted by length, so when zoomed out the
//                     renderer draws only the prefix of segments longer than ~1 pixel
//                     (sub-pixel detail is invisible anyway). One draw call per tile.
import { CHUNK, type Drawing } from './dxf';

export interface Tile {
  layer: number;
  color: number;
  data: Float32Array; // segments, longest first
  len: Float32Array; // per segment: upper edge of its length class, descending (conservative for culling)
  bounds: [number, number, number, number, number, number];
}

const MAX_TILE_SEGS = 400_000;

const BINS = 160; // quarter-octave length classes covering 2^-40 … 1 of the drawing size

export function tileDrawing(d: Drawing): Tile[] {
  const [x0, y0, , x1, y1] = d.bounds;
  let total = 0;
  for (const b of d.buckets) total += b.length / 6;
  const T = Math.max(1, Math.min(32, Math.round(Math.sqrt(total / 40000))));
  const tw = Math.max((x1 - x0) / T, 1e-9), th = Math.max((y1 - y0) / T, 1e-9);
  const ext = Math.max(x1 - x0, y1 - y0, 1e-9);
  const binLen = (k: number) => ext * Math.pow(2, (BINS - 1 - k - (BINS - 1)) / 4); // lower edge of bin k (k=0 longest)
  const tiles: Tile[] = [];
  for (const b of d.buckets) {
    const n = b.length / 6;
    if (!n) continue;
    // one pass: key = tile * BINS + lengthClass(longest first); counting sort, no comparisons
    const keys = new Uint32Array(n);
    const K = T * T * BINS;
    const start = new Uint32Array(K + 1);
    for (let s = 0; s < n; s++) {
      const i = s * 6, c = b.chunks[(i / CHUNK) | 0], o = i % CHUNK;
      const mx = (c[o] + c[o + 3]) / 2, my = (c[o + 1] + c[o + 4]) / 2;
      const tx = Math.min(T - 1, Math.max(0, Math.floor((mx - x0) / tw))), ty = Math.min(T - 1, Math.max(0, Math.floor((my - y0) / th)));
      const L = Math.hypot(c[o + 3] - c[o], c[o + 4] - c[o + 1], c[o + 5] - c[o + 2]);
      const cls = L > 0 ? Math.min(BINS - 1, Math.max(0, Math.floor(-Math.log2(L / ext) * 4))) : BINS - 1;
      const key = (ty * T + tx) * BINS + cls;
      keys[s] = key;
      start[key + 1]++;
    }
    for (let k = 0; k < K; k++) start[k + 1] += start[k];
    const cur = start.slice(0, K);
    const order = new Uint32Array(n);
    for (let s = 0; s < n; s++) order[cur[keys[s]]++] = s;
    for (let t = 0; t < T * T; t++) {
      const t0 = start[t * BINS], t1 = start[(t + 1) * BINS];
      for (let p0 = t0; p0 < t1; p0 += MAX_TILE_SEGS) {
        const p1 = Math.min(t1, p0 + MAX_TILE_SEGS), m = p1 - p0;
        const data = new Float32Array(m * 6), len = new Float32Array(m);
        let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
        for (let j = 0; j < m; j++) {
          const s = order[p0 + j], i = s * 6, c = b.chunks[(i / CHUNK) | 0], o = i % CHUNK;
          for (let q = 0; q < 6; q++) data[j * 6 + q] = c[o + q];
          len[j] = binLen(keys[s] % BINS);
          for (let q = 0; q < 6; q += 3) {
            const x = c[o + q], y = c[o + q + 1], z = c[o + q + 2];
            if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; if (z < bz0) bz0 = z; if (z > bz1) bz1 = z;
          }
        }
        tiles.push({ layer: b.layer, color: b.color, data, len, bounds: [bx0, by0, bz0, bx1, by1, bz1] });
      }
    }
    b.chunks = []; // release the original chunks as we go (keeps peak memory down)
  }
  return tiles;
}

/** Number of leading segments longer than minLen (len is sorted descending). */
export function visibleCount(len: Float32Array, minLen: number): number {
  let lo = 0, hi = len.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (len[m] > minLen) lo = m + 1; else hi = m; }
  return lo;
}
