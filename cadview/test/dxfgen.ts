// Tiny ASCII DXF writer used to make test fixtures and the demo drawings.
type G = [number, string | number];
const ent = (type: string, layer: string, g: G[]): G[] => [[0, type], [8, layer], ...g];

export const line = (x1: number, y1: number, x2: number, y2: number, layer = '0') =>
  ent('LINE', layer, [[10, x1], [20, y1], [30, 0], [11, x2], [21, y2], [31, 0]]);
export const circle = (x: number, y: number, r: number, layer = '0') => ent('CIRCLE', layer, [[10, x], [20, y], [30, 0], [40, r]]);
export const arc = (x: number, y: number, r: number, a0: number, a1: number, layer = '0') =>
  ent('ARC', layer, [[10, x], [20, y], [30, 0], [40, r], [50, a0], [51, a1]]);
export const text = (x: number, y: number, h: number, s: string, layer = '0') =>
  ent('TEXT', layer, [[10, x], [20, y], [30, 0], [40, h], [1, s]]);
export const lwpoly = (pts: [number, number, number?][], closed: boolean, layer = '0') =>
  ent('LWPOLYLINE', layer, [[90, pts.length], [70, closed ? 1 : 0], ...pts.flatMap(([x, y, b]) => [[10, x], [20, y], ...(b ? [[42, b]] : [])] as G[])]);
export const insert = (name: string, x: number, y: number, rot = 0, sx = 1, sy = 1, layer = '0') =>
  ent('INSERT', layer, [[2, name], [10, x], [20, y], [30, 0], [41, sx], [42, sy], [50, rot]]);

export function dxf(entities: G[][], opts: { blocks?: Record<string, G[][]>; layers?: [string, number][]; units?: number; ext?: [number, number, number, number] } = {}): string {
  const g: G[] = [];
  g.push([0, 'SECTION'], [2, 'HEADER'], [9, '$INSUNITS'], [70, opts.units ?? 6]);
  if (opts.ext) g.push([9, '$EXTMIN'], [10, opts.ext[0]], [20, opts.ext[1]], [30, 0], [9, '$EXTMAX'], [10, opts.ext[2]], [20, opts.ext[3]], [30, 0]);
  g.push([0, 'ENDSEC']);
  g.push([0, 'SECTION'], [2, 'TABLES'], [0, 'TABLE'], [2, 'LAYER'], [70, (opts.layers ?? []).length]);
  for (const [name, aci] of opts.layers ?? []) g.push([0, 'LAYER'], [2, name], [70, 0], [62, aci], [6, 'CONTINUOUS']);
  g.push([0, 'ENDTAB'], [0, 'ENDSEC']);
  g.push([0, 'SECTION'], [2, 'BLOCKS']);
  for (const [name, ents] of Object.entries(opts.blocks ?? {})) {
    g.push([0, 'BLOCK'], [8, '0'], [2, name], [70, 0], [10, 0], [20, 0], [30, 0], [3, name]);
    for (const e of ents) g.push(...e);
    g.push([0, 'ENDBLK'], [8, '0']);
  }
  g.push([0, 'ENDSEC'], [0, 'SECTION'], [2, 'ENTITIES']);
  for (const e of entities) g.push(...e);
  g.push([0, 'ENDSEC'], [0, 'EOF']);
  return g.map(([c, v]) => `${c}\n${v}`).join('\n') + '\n';
}
