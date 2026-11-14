// Revision compare: which entities were added, removed or kept between two drawings.
// Works purely on geometry, so it survives re-saves, handle changes and layer renames.
import type { Primitive } from './dxf';

export type DiffState = 'same' | 'added' | 'removed';
export interface DiffResult {
  items: { prim: Primitive; state: DiffState }[];
  added: number;
  removed: number;
  same: number;
}

/** Order-independent geometric signature of a primitive, quantised to `tol`. */
export function signature(p: Primitive, tol: number): string {
  const q = (v: number) => Math.round(v / tol);
  const segs: string[] = [];
  for (let i = 0; i < p.segments.length; i += 6) {
    const a = `${q(p.segments[i])},${q(p.segments[i + 1])},${q(p.segments[i + 2])}`;
    const b = `${q(p.segments[i + 3])},${q(p.segments[i + 4])},${q(p.segments[i + 5])}`;
    segs.push(a < b ? `${a}|${b}` : `${b}|${a}`); // direction-independent
  }
  segs.sort();
  const t = p.text ? `T:${p.text.value}@${q(p.text.x)},${q(p.text.y)}` : '';
  return segs.join(';') + t;
}

/** Tolerance = 1e-6 of the larger drawing's extent (absorbs float noise from re-saves). */
export function autoTolerance(a: Primitive[], b: Primitive[]): number {
  let lo = Infinity, hi = -Infinity;
  for (const list of [a, b])
    for (const p of list) {
      for (const v of p.segments) { if (v < lo) lo = v; if (v > hi) hi = v; }
      if (p.text) { lo = Math.min(lo, p.text.x, p.text.y); hi = Math.max(hi, p.text.x, p.text.y); }
    }
  const ext = isFinite(hi - lo) ? hi - lo : 1;
  return Math.max(ext * 1e-6, 1e-9);
}

export function diffDrawings(oldP: Primitive[], newP: Primitive[], tol = autoTolerance(oldP, newP)): DiffResult {
  // multiset: duplicates (two identical lines) are counted, not collapsed
  const pool = new Map<string, number>();
  for (const p of newP) {
    const s = signature(p, tol);
    pool.set(s, (pool.get(s) ?? 0) + 1);
  }
  const items: DiffResult['items'] = [];
  let removed = 0, same = 0;
  const matched = new Map<string, number>();
  for (const p of oldP) {
    const s = signature(p, tol);
    const left = pool.get(s) ?? 0;
    if (left > 0) {
      pool.set(s, left - 1);
      matched.set(s, (matched.get(s) ?? 0) + 1);
      items.push({ prim: p, state: 'same' });
      same++;
    } else {
      items.push({ prim: p, state: 'removed' });
      removed++;
    }
  }
  let added = 0;
  for (const p of newP) {
    const s = signature(p, tol);
    const m = matched.get(s) ?? 0;
    if (m > 0) matched.set(s, m - 1); // already shown as 'same'
    else {
      items.push({ prim: p, state: 'added' });
      added++;
    }
  }
  return { items, added, removed, same };
}
