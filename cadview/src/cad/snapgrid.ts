// Uniform-grid spatial index for snap points. Built once (off the UI thread for 2D),
// queried on every tap / loupe move, so snapping stays instant even with millions of points.

export interface SnapGrid {
  pts: Float32Array; // x,y,z
  tags: Uint16Array; // layer or part index per point (to skip hidden ones)
  start: Uint32Array; // cell → first item (length cells+1)
  items: Uint32Array; // point indices sorted by cell
  min: [number, number, number];
  cell: number;
  dims: [number, number, number];
}

const MAX_CELLS = 2_000_000;

export function buildGrid(pts: Float32Array, tags: Uint16Array, is3d: boolean): SnapGrid {
  const n = pts.length / 3;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1], z = pts[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  if (!n) { x0 = y0 = z0 = 0; x1 = y1 = z1 = 1; }
  const ex = Math.max(x1 - x0, 1e-9), ey = Math.max(y1 - y0, 1e-9), ez = Math.max(z1 - z0, 1e-9);
  const target = Math.min(Math.max(1, n / 4), MAX_CELLS);
  const big = Math.max(ex, ey, is3d ? ez : 0);
  let cell = is3d ? Math.cbrt((ex * ey * ez) / target) : Math.sqrt((ex * ey) / target);
  cell = Math.max(cell, big / (is3d ? 128 : 1400), 1e-9);
  const gx = Math.min(Math.floor(ex / cell) + 1, 4096);
  const gy = Math.min(Math.floor(ey / cell) + 1, 4096);
  const gz = is3d ? Math.min(Math.floor(ez / cell) + 1, 4096) : 1;
  const cells = gx * gy * gz;
  const cellOf = new Uint32Array(n);
  const start = new Uint32Array(cells + 1);
  for (let i = 0; i < n; i++) {
    const cx = Math.min(gx - 1, Math.floor((pts[i * 3] - x0) / cell));
    const cy = Math.min(gy - 1, Math.floor((pts[i * 3 + 1] - y0) / cell));
    const cz = is3d ? Math.min(gz - 1, Math.floor((pts[i * 3 + 2] - z0) / cell)) : 0;
    const c = (cz * gy + cy) * gx + cx;
    cellOf[i] = c;
    start[c + 1]++;
  }
  for (let c = 0; c < cells; c++) start[c + 1] += start[c];
  const fill = start.slice(0, cells);
  const items = new Uint32Array(n);
  for (let i = 0; i < n; i++) items[fill[cellOf[i]]++] = i;
  return { pts, tags, start, items, min: [x0, y0, z0], cell, dims: [gx, gy, gz] };
}

/**
 * Nearest point to (x,y,z) within radius r, searching outward ring by ring so that
 * a huge radius (zoomed far out) still terminates quickly. Returns point index or -1.
 */
export function nearest(g: SnapGrid, x: number, y: number, z: number, r: number, accept?: (tag: number) => boolean, use3d = false): number {
  const [gx, gy, gz] = g.dims;
  if (!g.items.length) return -1;
  const cx = Math.floor((x - g.min[0]) / g.cell), cy = Math.floor((y - g.min[1]) / g.cell);
  const cz = use3d ? Math.floor((z - g.min[2]) / g.cell) : 0;
  const maxK = Math.ceil(r / g.cell) + 1;
  let best = -1, bestD = r * r;
  const visit = (ix: number, iy: number, iz: number) => {
    if (ix < 0 || iy < 0 || iz < 0 || ix >= gx || iy >= gy || iz >= gz) return;
    const c = (iz * gy + iy) * gx + ix;
    for (let k = g.start[c], e = g.start[c + 1]; k < e; k++) {
      const i = g.items[k];
      const dx = g.pts[i * 3] - x, dy = g.pts[i * 3 + 1] - y, dz = use3d ? g.pts[i * 3 + 2] - z : 0;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD && (!accept || accept(g.tags[i]))) { bestD = d; best = i; }
    }
  };
  for (let k = 0; k <= maxK; k++) {
    // once something is found, one more ring can't beat it if it's closer than the ring's inner edge
    if (best >= 0 && (k - 1) * g.cell > Math.sqrt(bestD)) break;
    if (k > 64 && best < 0 && k * g.cell > r) break;
    const zr = use3d ? k : 0;
    for (let iz = cz - zr; iz <= cz + zr; iz++)
      for (let iy = cy - k; iy <= cy + k; iy++) {
        const edgeYZ = Math.abs(iy - cy) === k || (use3d && Math.abs(iz - cz) === k);
        if (edgeYZ) for (let ix = cx - k; ix <= cx + k; ix++) visit(ix, iy, iz);
        else { visit(cx - k, iy, iz); if (k) visit(cx + k, iy, iz); }
      }
    if (k > 400) break; // hard stop: never stall the UI
  }
  return best;
}
