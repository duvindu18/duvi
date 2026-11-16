// HATCH geometry: pattern lines clipped to the boundary (even-odd, like AutoCAD's "normal" style)
// and triangulated solid fills (outer loops with their holes).
import { ShapeUtils, Vector2 } from 'three';

/** One family of parallel pattern lines, exactly as stored in the DXF (already scaled and rotated). */
export interface PatternLine { angle: number; bx: number; by: number; ox: number; oy: number; dashes: number[] }

/** Budget per hatch: beyond this the pattern is too dense to see and is drawn as a light tint instead. */
export const MAX_PATTERN_LINES = 3000;
export const MAX_PATTERN_SEGS = 60000;

/**
 * Clip pattern lines to closed loops (flat x,y arrays). Returns x1,y1,x2,y2,… or null if too dense.
 */
export function patternSegments(loops: number[][], lines: PatternLine[]): number[] | null {
  const out: number[] = [];
  for (const pl of lines) {
    const a = (pl.angle * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a), nx = -dy, ny = dx;
    const spacing = pl.ox * nx + pl.oy * ny; // distance between neighbouring lines
    if (Math.abs(spacing) < 1e-12) continue;
    // range of the boundary across the lines
    let nmin = Infinity, nmax = -Infinity;
    for (const L of loops) for (let i = 0; i < L.length; i += 2) { const s = L[i] * nx + L[i + 1] * ny; if (s < nmin) nmin = s; if (s > nmax) nmax = s; }
    const b0 = pl.bx * nx + pl.by * ny;
    let k0 = Math.ceil((nmin - b0) / spacing), k1 = Math.floor((nmax - b0) / spacing);
    if (k0 > k1) [k0, k1] = [k1, k0];
    if (k1 - k0 + 1 > MAX_PATTERN_LINES) return null;
    const plen = pl.dashes.reduce((s, d) => s + Math.abs(d), 0);
    const ts: number[] = [];
    for (let k = k0; k <= k1; k++) {
      const ox = pl.bx + k * pl.ox, oy = pl.by + k * pl.oy;
      ts.length = 0;
      for (const L of loops) {
        const n = L.length / 2;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const px = L[i * 2] - ox, py = L[i * 2 + 1] - oy, qx = L[j * 2] - ox, qy = L[j * 2 + 1] - oy;
          const sp = px * nx + py * ny, sq = qx * nx + qy * ny;
          if ((sp > 0) === (sq > 0)) continue;
          const tp = px * dx + py * dy, tq = qx * dx + qy * dy;
          ts.push(tp + ((tq - tp) * sp) / (sp - sq));
        }
      }
      if (ts.length < 2) continue;
      ts.sort((u, v) => u - v);
      for (let i = 0; i + 1 < ts.length; i += 2) {
        const u0 = ts[i], u1 = ts[i + 1];
        if (u1 - u0 < 1e-12) continue;
        const emit = (s: number, e: number) => out.push(ox + dx * s, oy + dy * s, ox + dx * e, oy + dy * e);
        if (!pl.dashes.length || plen < 1e-12) emit(u0, u1);
        else {
          // the dash pattern starts at the line's origin, so neighbouring regions line up
          let pos = Math.floor(u0 / plen) * plen, di = 0;
          let guard = 0;
          while (pos < u1 && guard++ < 100000) {
            const d = pl.dashes[di], len = Math.abs(d);
            if (d > 0) { const s = Math.max(pos, u0), e = Math.min(pos + len, u1); if (e > s) emit(s, e); }
            else if (d === 0 && pos >= u0 && pos <= u1) emit(pos, pos + plen * 0.01); // dot
            pos += len;
            di = (di + 1) % pl.dashes.length;
            if (len === 0 && pl.dashes.every((x) => x === 0)) break;
          }
        }
        if (out.length / 4 > MAX_PATTERN_SEGS) return null;
      }
    }
  }
  return out;
}

function inside(x: number, y: number, L: number[]) {
  let c = false;
  for (let i = 0, n = L.length / 2, j = n - 1; i < n; j = i++) {
    const xi = L[i * 2], yi = L[i * 2 + 1], xj = L[j * 2], yj = L[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const area = (L: number[]) => { let a = 0; for (let i = 0, n = L.length / 2; i < n; i++) { const j = (i + 1) % n; a += L[i * 2] * L[j * 2 + 1] - L[j * 2] * L[i * 2 + 1]; } return a / 2; };

/** Triangulate loops with even-odd nesting (islands inside holes become fills again). Returns x,y triangles. */
export function fillTriangles(loops: number[][]): number[] {
  const open = (L: number[]) => { const n = L.length; return n >= 4 && Math.abs(L[0] - L[n - 2]) < 1e-12 && Math.abs(L[1] - L[n - 1]) < 1e-12 ? L.slice(0, n - 2) : L; };
  const ls = loops.map(open).filter((L) => L.length >= 6 && Math.abs(area(L)) > 0);
  const depth = ls.map((L, i) => ls.reduce((d, M, j) => (j !== i && Math.abs(area(M)) > Math.abs(area(L)) && inside(L[0], L[1], M) ? d + 1 : d), 0));
  const out: number[] = [];
  ls.forEach((outer, oi) => {
    if (depth[oi] % 2) return; // a hole
    const holes = ls.filter((H, hi) => depth[hi] === depth[oi] + 1 && inside(H[0], H[1], outer));
    const toV = (L: number[]) => { const v: Vector2[] = []; for (let i = 0; i < L.length; i += 2) v.push(new Vector2(L[i], L[i + 1])); return v; };
    const contour = toV(outer), hv = holes.map(toV);
    try {
      // triangulateShape drops repeated end points in place, so index into the arrays *after* the call
      const faces = ShapeUtils.triangulateShape(contour, hv);
      const all = [...contour, ...hv.flat()];
      for (const [a, b, c] of faces) out.push(all[a].x, all[a].y, all[b].x, all[b].y, all[c].x, all[c].y);
    } catch { /* degenerate boundary */ }
  });
  return out;
}
