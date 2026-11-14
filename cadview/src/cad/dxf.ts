// DXF → flat list of drawable primitives, entirely on-device (no network).
// Kept free of three.js so it can be unit-tested and reused by the diff engine.
import DxfParser from 'dxf-parser';

export interface Primitive {
  /** Source entity type, e.g. LINE, ARC, TEXT. */
  type: string;
  layer: string;
  /** 0xRRGGBB, or -1 for "foreground" (ACI 7: white on dark, black on light). */
  color: number;
  /** Line segments as x1,y1,z1,x2,y2,z2,… in world space. */
  segments: number[];
  /** Present for TEXT / MTEXT. */
  text?: { value: string; x: number; y: number; z: number; height: number; rotation: number };
}

export interface CadDrawing {
  primitives: Primitive[];
  layers: { name: string; color: number; visible: boolean }[];
  units: string;
  /** Entity types we saw but could not draw, with counts — shown to the user, never silently dropped. */
  skipped: Record<string, number>;
}

type P = { x: number; y: number; z?: number };
type Mat = [number, number, number, number, number, number]; // 2D affine a b c d e f: x' = a x + c y + e

const IDENT: Mat = [1, 0, 0, 1, 0, 0];
const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// $INSUNITS codes → label
const UNITS: Record<number, string> = { 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm', 7: 'km', 8: 'µin', 9: 'mil', 10: 'yd' };

const ACI7 = 0xffffff;

export function parseDxf(text: string): CadDrawing {
  const dxf: any = new DxfParser().parseSync(text);
  if (!dxf) throw new Error('Not a readable DXF file');

  const layerTable: Record<string, any> = dxf.tables?.layer?.layers ?? {};
  const layerColor = (name: string) => layerTable[name]?.color ?? ACI7;
  const out: Primitive[] = [];
  const skipped: Record<string, number> = {};
  const usedLayers = new Set<string>();

  const emit = (e: any, segs: number[], inherited: { layer: string; color: number } | null, text?: Primitive['text']) => {
    if (!segs.length && !text) return;
    let layer = e.layer ?? '0';
    if (layer === '0' && inherited) layer = inherited.layer; // block entities on layer 0 take the INSERT's layer
    let color: number;
    if (e.colorIndex === 0 && inherited) color = inherited.color; // ByBlock
    else if (e.color !== undefined && e.colorIndex !== 256) color = e.color;
    else color = layerColor(layer);
    usedLayers.add(layer);
    out.push({ type: e.type, layer, color: color === ACI7 ? -1 : color, segments: segs, text });
  };

  const walk = (entities: any[], m: Mat, z: number, depth: number, inherited: { layer: string; color: number } | null) => {
    if (depth > 16) return; // guard against recursive blocks
    for (const e of entities ?? []) {
      const segs: number[] = [];
      const push = (a: P, b: P) => {
        const [x1, y1] = apply(m, a.x, a.y);
        const [x2, y2] = apply(m, b.x, b.y);
        segs.push(x1, y1, (a.z ?? 0) + z, x2, y2, (b.z ?? 0) + z);
      };
      const poly = (pts: P[], closed: boolean) => {
        for (let i = 0; i + 1 < pts.length; i++) push(pts[i], pts[i + 1]);
        if (closed && pts.length > 2) push(pts[pts.length - 1], pts[0]);
      };
      switch (e.type) {
        case 'LINE':
          if (e.vertices?.length >= 2) push(e.vertices[0], e.vertices[1]);
          break;
        case 'LWPOLYLINE':
        case 'POLYLINE': {
          if (e.isPolyfaceMesh || e.is3dPolygonMesh) {
            // vertices are mesh nodes; draw as a point cloud of edges between consecutive nodes
            poly(e.vertices.filter((v: any) => v.x !== undefined), false);
            break;
          }
          poly(bulgedPolyline(e.vertices ?? [], !!e.shape), false);
          break;
        }
        case 'CIRCLE':
          poly(arcPoints(e.center, e.radius, 0, Math.PI * 2), false);
          break;
        case 'ARC':
          poly(arcPoints(e.center, e.radius, e.startAngle, e.endAngle), false);
          break;
        case 'ELLIPSE':
          poly(ellipsePoints(e), false);
          break;
        case 'SPLINE':
          poly(splinePoints(e), !!e.closed);
          break;
        case 'SOLID':
        case '3DFACE': {
          const pts = (e.points ?? e.vertices ?? []).filter(Boolean);
          // SOLID corner order is 1,2,4,3
          if (e.type === 'SOLID' && pts.length === 4) poly([pts[0], pts[1], pts[3], pts[2]], true);
          else poly(pts, true);
          break;
        }
        case 'POINT':
          if (e.position) {
            const s = 0.0; // a zero-length segment still gets a snap vertex
            push(e.position, { x: e.position.x + s, y: e.position.y, z: e.position.z });
          }
          break;
        case 'TEXT':
        case 'MTEXT': {
          const at = e.type === 'TEXT' ? (e.halign || e.valign ? e.endPoint ?? e.startPoint : e.startPoint) : e.position;
          const value = cleanText(e.text ?? '');
          if (!at || !value) break;
          const [x, y] = apply(m, at.x, at.y);
          const scale = Math.hypot(m[0], m[1]);
          const rot = ((e.rotation ?? 0) * Math.PI) / 180 + Math.atan2(m[1], m[0]);
          const height = (e.textHeight ?? e.height ?? 1) * scale;
          emit(e, [], inherited, { value, x, y, z: (at.z ?? 0) + z, height, rotation: rot });
          break;
        }
        case 'INSERT':
        case 'DIMENSION': {
          const name = e.type === 'INSERT' ? e.name : e.block;
          const block = dxf.blocks?.[name];
          if (!block) break;
          const base = block.position ?? { x: 0, y: 0, z: 0 };
          let bm: Mat = IDENT;
          if (e.type === 'INSERT') {
            const r = ((e.rotation ?? 0) * Math.PI) / 180;
            const sx = e.xScale ?? 1, sy = e.yScale ?? 1;
            const p = e.position ?? { x: 0, y: 0 };
            const cos = Math.cos(r), sin = Math.sin(r);
            // translate(p) · rotate(r) · scale(sx,sy) · translate(-base)
            bm = mul([cos, sin, -sin, cos, p.x, p.y], mul([sx, 0, 0, sy, 0, 0], [1, 0, 0, 1, -base.x, -base.y]));
            const cols = e.columnCount ?? 1, rows = e.rowCount ?? 1;
            for (let c = 0; c < cols; c++)
              for (let rr = 0; rr < rows; rr++) {
                const off: Mat = [1, 0, 0, 1, c * (e.columnSpacing ?? 0), rr * (e.rowSpacing ?? 0)];
                const layer = e.layer ?? '0';
                const color = e.colorIndex !== undefined && e.colorIndex !== 256 && e.color !== undefined ? e.color : layerColor(layer);
                walk(block.entities, mul(m, mul(off, bm)), z + ((p as P).z ?? 0), depth + 1, { layer, color });
              }
          } else {
            const layer = e.layer ?? '0';
            walk(block.entities, mul(m, [1, 0, 0, 1, -base.x, -base.y]), z, depth + 1, { layer, color: e.color ?? layerColor(layer) });
          }
          break;
        }
      }
      if (segs.length) emit(e, segs, inherited);
    }
  };

  walk(dxf.entities, IDENT, 0, 0, null);
  // The parser silently drops types it doesn't know (e.g. HATCH), so count from the raw file.
  for (const [type, n] of Object.entries(rawEntityCounts(text))) if (!DRAWN.has(type)) skipped[type] = n;

  const layers = [...usedLayers].sort().map((name) => {
    const l = layerTable[name];
    const c = layerColor(name);
    return { name, color: c === ACI7 ? -1 : c, visible: l ? l.visible !== false && !l.frozen : true };
  });

  return { primitives: out, layers, units: UNITS[dxf.header?.$INSUNITS as number] ?? 'units', skipped };
}

const DRAWN = new Set(['LINE', 'LWPOLYLINE', 'POLYLINE', 'CIRCLE', 'ARC', 'ELLIPSE', 'SPLINE', 'SOLID', '3DFACE', 'POINT', 'TEXT', 'MTEXT', 'INSERT', 'DIMENSION', 'VERTEX', 'SEQEND', 'ATTRIB', 'ATTDEF', 'VIEWPORT']);

/** Count top-level entity types in the ENTITIES section of an ASCII DXF. */
export function rawEntityCounts(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const lines = text.split(/\r?\n/);
  let inEntities = false;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (lines[i].trim() !== '0' && lines[i].trim() !== '2') continue;
    const v = lines[i + 1].trim();
    if (lines[i].trim() === '2') { if (v === 'ENTITIES') inEntities = true; continue; }
    if (v === 'ENDSEC') { if (inEntities) break; continue; }
    if (inEntities) counts[v] = (counts[v] ?? 0) + 1;
  }
  return counts;
}

export function arcPoints(c: P, r: number, a0: number, a1: number): P[] {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += Math.PI * 2;
  const n = Math.max(8, Math.ceil((sweep / (Math.PI * 2)) * 72));
  const pts: P[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    pts.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a), z: c.z });
  }
  return pts;
}

/** Expand LWPOLYLINE bulges (arc segments) into points. */
export function bulgedPolyline(vs: (P & { bulge?: number })[], closed: boolean): P[] {
  if (!vs.length) return [];
  const pts: P[] = [vs[0]];
  const count = closed ? vs.length : vs.length - 1;
  for (let i = 0; i < count; i++) {
    const a = vs[i], b = vs[(i + 1) % vs.length];
    const bulge = a.bulge ?? 0;
    if (Math.abs(bulge) > 1e-9) {
      const theta = 4 * Math.atan(bulge); // included angle, signed
      const chord = Math.hypot(b.x - a.x, b.y - a.y);
      const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const h = r * Math.cos(Math.abs(theta) / 2); // centre distance from chord midpoint
      const ux = -(b.y - a.y) / chord, uy = (b.x - a.x) / chord; // left normal
      const sgn = Math.sign(bulge) * (Math.abs(theta) > Math.PI ? -1 : 1);
      const cx = mx + ux * h * sgn, cy = my + uy * h * sgn;
      const s = Math.atan2(a.y - cy, a.x - cx);
      const n = Math.max(4, Math.ceil((Math.abs(theta) / (Math.PI * 2)) * 72));
      for (let k = 1; k <= n; k++) {
        const ang = s + (theta * k) / n;
        pts.push({ x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang), z: a.z });
      }
    } else pts.push(b);
  }
  return pts;
}

function ellipsePoints(e: any): P[] {
  const c = e.center, maj = e.majorAxisEndPoint;
  const a = Math.hypot(maj.x, maj.y), b = a * (e.axisRatio ?? 1);
  const rot = Math.atan2(maj.y, maj.x);
  let t0 = e.startAngle ?? 0, t1 = e.endAngle ?? Math.PI * 2;
  let sweep = t1 - t0;
  while (sweep <= 0) sweep += Math.PI * 2;
  const n = Math.max(16, Math.ceil((sweep / (Math.PI * 2)) * 96));
  const pts: P[] = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + (sweep * i) / n;
    const x = a * Math.cos(t), y = b * Math.sin(t);
    pts.push({ x: c.x + x * Math.cos(rot) - y * Math.sin(rot), y: c.y + x * Math.sin(rot) + y * Math.cos(rot), z: c.z });
  }
  return pts;
}

/** Evaluate a (possibly rational) B-spline with de Boor's algorithm; fall back to fit points. */
export function splinePoints(e: any): P[] {
  const cps: P[] = e.controlPoints ?? [];
  const knots: number[] = e.knotValues ?? [];
  const p: number = e.degreeOfSplineCurve ?? 3;
  const w: number[] = e.weights ?? cps.map(() => 1);
  if (cps.length < p + 1 || knots.length !== cps.length + p + 1) return e.fitPoints ?? cps;
  const lo = knots[p], hi = knots[knots.length - p - 1];
  const n = Math.max(16, cps.length * 12);
  const pts: P[] = [];
  for (let i = 0; i <= n; i++) {
    const t = lo + ((hi - lo) * i) / n;
    let k = p;
    while (k < cps.length - 1 && t >= knots[k + 1]) k++;
    const d: number[][] = [];
    for (let j = 0; j <= p; j++) {
      const c = cps[k - p + j], ww = w[k - p + j] ?? 1;
      d.push([c.x * ww, c.y * ww, (c.z ?? 0) * ww, ww]);
    }
    for (let r = 1; r <= p; r++)
      for (let j = p; j >= r; j--) {
        const den = knots[j + 1 + k - r] - knots[j + k - p];
        const alpha = den === 0 ? 0 : (t - knots[j + k - p]) / den;
        for (let q = 0; q < 4; q++) d[j][q] = (1 - alpha) * d[j - 1][q] + alpha * d[j][q];
      }
    const [x, y, z, ww] = d[p];
    pts.push({ x: x / ww, y: y / ww, z: z / ww });
  }
  return pts;
}

/** Strip MTEXT formatting codes like \P, {\fArial|b0;…}, \H2.5x; */
export function cleanText(s: string): string {
  return s
    .replace(/\\P/g, '\n')
    .replace(/\\[ACcFfHhQTWp][^;]*;/g, '')
    .replace(/\\[LlOoKk]/g, '')
    .replace(/\\S([^;]*)[#^/]([^;]*);/g, '$1/$2')
    .replace(/%%[cC]/g, 'Ø')
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/[{}]/g, '')
    .trim();
}
