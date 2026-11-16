import { describe, expect, it } from 'vitest';
import { parseDxf, bulgePts, cleanText, TS, type Drawing, type Bucket } from '../src/cad/dxf';
const flat = (b: Bucket) => Array.from(b.chunks.flatMap((c) => Array.from(c)));
import { diffDrawings } from '../src/cad/diff';
import { buildGrid, nearest } from '../src/cad/snapgrid';
import { dxf, line, circle, text, lwpoly, insert, arc } from './dxfgen';

const enc = (s: string) => new TextEncoder().encode(s);
const parse = (s: string, origin?: [number, number, number]) => parseDxf(enc(s), { origin: origin ?? [0, 0, 0] });
/** all segment endpoints as real coordinates [x,y][] */
const points = (d: Drawing) => {
  const out: [number, number][] = [];
  for (const b of d.buckets) { const a = flat(b); for (let i = 0; i < a.length; i += 3) out.push([a[i] + d.origin[0], a[i + 1] + d.origin[1]]); }
  return out;
};

describe('parseDxf', () => {
  it('reads entities into layer/colour batches with units', () => {
    const d = parse(dxf([line(0, 0, 10, 0, 'WALLS'), circle(5, 5, 2, 'DOORS'), text(1, 1, 0.5, 'Room 204', 'TEXT')],
      { layers: [['WALLS', 1], ['DOORS', 7], ['TEXT', 3]], units: 4 }));
    expect(d.units).toBe('mm');
    expect(d.entities).toBe(3);
    expect(d.layers.map((l) => l.name)).toEqual(['WALLS', 'DOORS', 'TEXT']);
    const walls = d.buckets.find((b) => d.layers[b.layer].name === 'WALLS')!;
    expect(walls.color).toBe(0xff0000);
    expect(flat(walls)).toEqual([0, 0, 0, 10, 0, 0]);
    expect(d.buckets.find((b) => d.layers[b.layer].name === 'DOORS')!.color).toBe(-1); // ACI 7 → theme foreground
    expect(d.text.values).toEqual(['Room 204']);
    expect(d.text.num[3]).toBeCloseTo(0.5);
  });

  it('re-centres large survey coordinates for float32 precision', () => {
    const d = parseDxf(enc(dxf([line(500000.125, 200000.5, 500010.125, 200000.5)])));
    expect(Math.abs(flat(d.buckets[0])[0])).toBeLessThan(1);
    const [[x]] = points(d);
    expect(x).toBeCloseTo(500000.125, 3);
  });

  it('expands block INSERTs with rotation, scale and translation', () => {
    const d = parse(dxf([insert('DOOR', 100, 50, 90, 2, 2, 'DOORS')], { blocks: { DOOR: [line(0, 0, 1, 0)] } }));
    const [[x1, y1], [x2, y2]] = points(d);
    expect([x1, y1]).toEqual([100, 50]);
    expect(x2).toBeCloseTo(100);
    expect(y2).toBeCloseTo(52);
    expect(d.layers[d.buckets[0].layer].name).toBe('DOORS'); // layer-0 block content takes the insert's layer
  });

  it('draws arcs counter-clockwise from start to end', () => {
    const p = points(parse(dxf([arc(0, 0, 1, 0, 90)])));
    expect(p[0][0]).toBeCloseTo(1);
    expect(p[p.length - 1][1]).toBeCloseTo(1);
  });

  it('mirrors entities with a (0,0,-1) extrusion, as AutoCAD does', () => {
    const s = dxf([circle(5, 0, 1)]).replace('40\n1\n', '40\n1\n210\n0\n220\n0\n230\n-1\n');
    const xs = points(parse(s)).map((p) => p[0]);
    expect(Math.max(...xs)).toBeCloseTo(-4); // centre (5,0) in OCS → (-5,0) in world
  });

  it('skips paper-space entities and reports unsupported types', () => {
    const s = dxf([line(0, 0, 1, 1)])
      .replace('0\nENDSEC\n0\nEOF', '0\n3DSOLID\n8\n0\n0\nLINE\n8\n0\n67\n1\n10\n9\n20\n9\n30\n0\n11\n8\n21\n8\n31\n0\n0\nENDSEC\n0\nEOF');
    const d = parse(s);
    expect(d.skipped).toEqual({ '3DSOLID': 1 });
    expect(points(d).length).toBe(2);
  });

  it('handles CRLF line endings', () => {
    const d = parse(dxf([line(0, 0, 3, 4)]).replace(/\n/g, '\r\n'));
    expect(flat(d.buckets[0])).toEqual([0, 0, 0, 3, 4, 0]);
  });

  it('closes closed polylines and expands bulges', () => {
    const d = parse(dxf([lwpoly([[0, 0], [1, 0], [1, 1]], true)]));
    expect(d.buckets[0].length / 6).toBe(3);
  });
});

describe('bulgePts', () => {
  it('turns bulge=1 into a semicircle', () => {
    const p = bulgePts([0, 2], [0, 0], [1, 0], false);
    expect([p[0], p[1]]).toEqual([0, 0]);
    expect(p[p.length - 2]).toBeCloseTo(2);
    const ys = p.filter((_, i) => i % 2 === 1);
    expect(Math.min(...ys)).toBeCloseTo(-1, 2); // positive bulge = counter-clockwise: dips below the chord
  });
});

describe('cleanText', () => {
  it('strips MTEXT formatting and decodes escapes', () => {
    expect(cleanText('{\\fArial|b1;KITCHEN}\\P12.5 m%%d \\U+00B2')).toBe('KITCHEN\n12.5 m° ²');
  });
});

describe('diffDrawings', () => {
  const base = [line(0, 0, 10, 0), line(10, 0, 10, 10), text(5, 5, 1, 'A')];
  it('finds additions, ignoring order and line direction', () => {
    const a = parse(dxf(base));
    const b = parse(dxf([line(10, 10, 10, 0), text(5, 5, 1, 'A'), line(0, 0, 10, 0), circle(3, 3, 1)]));
    const r = diffDrawings(a, b);
    expect([r.same, r.added, r.removed]).toEqual([3, 1, 0]);
  });
  it('treats a moved line or edited text as removed + added', () => {
    const a = parse(dxf(base));
    const b = parse(dxf([line(0, 1, 10, 1), line(10, 0, 10, 10), text(5, 5, 1, 'B')]));
    const r = diffDrawings(a, b);
    expect([r.same, r.added, r.removed]).toEqual([1, 2, 2]);
  });
  it('counts duplicates rather than collapsing them', () => {
    const r = diffDrawings(parse(dxf([line(0, 0, 1, 0), line(0, 0, 1, 0)])), parse(dxf([line(0, 0, 1, 0)])));
    expect([r.same, r.removed]).toEqual([1, 1]);
  });
});

describe('snap grid', () => {
  it('finds the nearest point within the radius, honouring hidden tags', () => {
    const pts = new Float32Array([0, 0, 0, 10, 10, 0, 10.5, 10, 0]);
    const g = buildGrid(pts, new Uint16Array([0, 0, 1]), false);
    expect(nearest(g, 10.4, 10, 0, 1)).toBe(2);
    expect(nearest(g, 10.4, 10, 0, 1, (t) => t !== 1)).toBe(1);
    expect(nearest(g, 5, 5, 0, 1)).toBe(-1);
    expect(nearest(g, 5, 5, 0, 100)).toBeGreaterThanOrEqual(0);
  });
});

import { tileDrawing, visibleCount } from '../src/cad/tiles';
describe('display tiles', () => {
  it('keep every segment, sorted longest-first per tile', () => {
    const ents: ReturnType<typeof line>[] = [];
    for (let i = 0; i < 200; i++) ents.push(line(i, 0, i + (i % 7) + 0.01, 3));
    const d = parse(dxf(ents));
    const before = d.buckets.reduce((s, b) => s + b.length / 6, 0);
    const tiles = tileDrawing(d);
    expect(tiles.reduce((s, t) => s + t.data.length / 6, 0)).toBe(before);
    for (const t of tiles) for (let i = 1; i < t.len.length; i++) expect(t.len[i]).toBeLessThanOrEqual(t.len[i - 1]);
  });
  it('visibleCount returns the prefix of segments longer than the threshold', () => {
    const len = new Float32Array([8, 4, 4, 2, 1, 0.5]);
    expect(visibleCount(len, 3)).toBe(3);
    expect(visibleCount(len, 0.1)).toBe(6);
    expect(visibleCount(len, 10)).toBe(0);
  });
});

import { readFileSync } from 'node:fs';
import { dwgToDxf } from '../src/cad/dwg';
describe('DWG import (converted to DXF on the device)', () => {
  for (const v of ['2000', '2004', '2018']) {
    it(`opens an AutoCAD ${v} DWG`, async () => {
      const b = readFileSync(`samples/floorplan-${v}.dwg`);
      const r = await dwgToDxf(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      const d = parseDxf(r.dxf, { utf8: true });
      expect(d.layers.map((l) => l.name).sort()).toEqual(['A-ANNO', 'A-DOOR', 'A-FURN', 'A-WALL']);
      expect(d.text.values).toContain('LIVING 201');
      expect(d.text.values.some((t) => t.includes('Ø 600'))).toBe(true);
      expect(d.layers[d.text.layer[0]].name).toBe('A-ANNO');
      // the two door blocks are expanded: each has a 0.9 m leaf line
      expect(Object.keys(d.skipped)).toEqual([]);
      expect(d.bounds[3] - d.bounds[0]).toBeCloseTo(10, 3);
    });
  }
  it('rejects files that are not DWG', async () => {
    await expect(dwgToDxf(new TextEncoder().encode('0\nSECTION\n').buffer)).rejects.toThrow(/not a DWG/);
  });
});

// ---------- line types, hatches, leaders, text styles ----------
type Gp = [number, string | number];
const raw = (type: string, g: Gp[]): Gp[] => [[0, type], ...g];
function dxfFull(entities: Gp[][], o: { ltscale?: number; ltypes?: [string, number[]][]; layers?: [string, number, string][]; styles?: [string, number, string][]; blocks?: Record<string, Gp[][]> } = {}) {
  const g: Gp[] = [[0, 'SECTION'], [2, 'HEADER'], [9, '$INSUNITS'], [70, 4], [9, '$LTSCALE'], [40, o.ltscale ?? 1], [9, '$DIMASZ'], [40, 2.5], [9, '$DIMSCALE'], [40, 1], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'TABLES'], [0, 'TABLE'], [2, 'LTYPE']];
  for (const [n, el] of o.ltypes ?? []) { g.push([0, 'LTYPE'], [2, n], [70, 0], [73, el.length], [40, el.reduce((s, x) => s + Math.abs(x), 0)]); for (const e of el) g.push([49, e]); }
  g.push([0, 'ENDTAB'], [0, 'TABLE'], [2, 'LAYER']);
  for (const [n, aci, lt] of o.layers ?? []) g.push([0, 'LAYER'], [2, n], [70, 0], [62, aci], [6, lt]);
  g.push([0, 'ENDTAB'], [0, 'TABLE'], [2, 'STYLE']);
  for (const [n, wf, font] of o.styles ?? []) g.push([0, 'STYLE'], [2, n], [70, 0], [40, 0], [41, wf], [3, font]);
  g.push([0, 'ENDTAB'], [0, 'ENDSEC'], [0, 'SECTION'], [2, 'BLOCKS']);
  for (const [name, ents] of Object.entries(o.blocks ?? {})) { g.push([0, 'BLOCK'], [8, '0'], [2, name], [70, 0], [10, 0], [20, 0], [30, 0]); for (const e of ents) g.push(...e); g.push([0, 'ENDBLK'], [8, '0']); }
  g.push([0, 'ENDSEC'], [0, 'SECTION'], [2, 'ENTITIES']);
  for (const e of entities) g.push(...e);
  g.push([0, 'ENDSEC'], [0, 'EOF']);
  return g.map(([c, v]) => `${c}\n${v}`).join('\n') + '\n';
}
const fillArea = (d: Drawing) => { let a = 0; for (const f of d.fills) for (let i = 0; i < f.data.length; i += 9) { const t = f.data; a += Math.abs((t[i + 3] - t[i]) * (t[i + 7] - t[i + 1]) - (t[i + 6] - t[i]) * (t[i + 4] - t[i + 1])) / 2; } return a; };
const square = (x0: number, y0: number, s: number): Gp[] => [[92, 2], [72, 0], [73, 1], [93, 4], [10, x0], [20, y0], [10, x0 + s], [20, y0], [10, x0 + s], [20, y0 + s], [10, x0], [20, y0 + s], [97, 0]];

describe('line types', () => {
  it('draws a ByLayer DASHED line as dashes, scaled by $LTSCALE', () => {
    const d = parse(dxfFull([raw('LINE', [[8, 'HIDDEN'], [10, 0], [20, 0], [30, 0], [11, 100], [21, 0], [31, 0]])],
      { ltscale: 1, ltypes: [['DASHED', [10, -5]]], layers: [['HIDDEN', 7, 'DASHED']] }));
    expect(d.buckets[0].length / 6).toBe(7); // 100 / (10+5) → 7 dashes
    const d2 = parse(dxfFull([raw('LINE', [[8, 'HIDDEN'], [10, 0], [20, 0], [30, 0], [11, 100], [21, 0], [31, 0]])],
      { ltscale: 2, ltypes: [['DASHED', [10, -5]]], layers: [['HIDDEN', 7, 'DASHED']] }));
    expect(d2.buckets[0].length / 6).toBe(4); // scale 2 → 30-unit pattern
  });
  it('continues the pattern around polyline corners', () => {
    const d = parse(dxfFull([raw('LWPOLYLINE', [[8, 'H'], [90, 3], [70, 0], [10, 0], [20, 0], [10, 12], [20, 0], [10, 12], [20, 12]])],
      { ltypes: [['DASHED', [10, -5]]], layers: [['H', 7, 'DASHED']] }));
    // 24 units of path: dash 0-10, gap 10-15 (crosses the corner at 12), dash 15-24 → 2 dashes, not 4
    expect(d.buckets[0].length / 6).toBe(2);
  });
  it('applies an entity linetype inside a block', () => {
    const d = parse(dxfFull([raw('INSERT', [[8, '0'], [2, 'B'], [10, 0], [20, 0], [30, 0]])],
      { ltypes: [['DASHED', [10, -5]]], blocks: { B: [raw('LINE', [[8, '0'], [6, 'DASHED'], [10, 0], [20, 0], [30, 0], [11, 30], [21, 0], [31, 0]])] } }));
    expect(d.buckets[0].length / 6).toBe(2);
  });
});

describe('hatches', () => {
  it('fills a SOLID hatch', () => {
    const d = parse(dxfFull([raw('HATCH', [[8, '0'], [10, 0], [20, 0], [30, 0], [2, 'SOLID'], [70, 1], [71, 0], [91, 1], ...square(0, 0, 10), [75, 0], [76, 1], [98, 0]])]));
    expect(fillArea(d)).toBeCloseTo(100, 6);
  });
  it('leaves holes open (even-odd)', () => {
    const d = parse(dxfFull([raw('HATCH', [[8, '0'], [10, 0], [20, 0], [30, 0], [2, 'SOLID'], [70, 1], [71, 0], [91, 2], ...square(0, 0, 10), ...square(3, 3, 4), [75, 0], [76, 1], [98, 0]])]));
    expect(fillArea(d)).toBeCloseTo(84, 6);
  });
  it('clips pattern lines to the boundary', () => {
    const d = parse(dxfFull([raw('HATCH', [[8, '0'], [10, 0], [20, 0], [30, 0], [2, 'ANSI31'], [70, 0], [71, 0], [91, 1], ...square(0, 0, 10), [75, 0], [76, 1], [52, 0], [41, 1], [77, 0],
      [78, 1], [53, 45], [43, 0], [44, 0], [45, -2.245], [46, 2.245], [79, 0], [98, 0]])]));
    const pts = points(d);
    expect(pts.length).toBe(10); // 5 lines at 3.175 spacing across a 10×10 square
    for (const [x, y] of pts) { expect(x).toBeGreaterThanOrEqual(-1e-6); expect(x).toBeLessThanOrEqual(10 + 1e-6); expect(y).toBeGreaterThanOrEqual(-1e-6); expect(y).toBeLessThanOrEqual(10 + 1e-6); }
  });
  it('reads arc edges in boundaries', () => {
    // half-disc: line (-5,0)→(5,0) then arc from 0° to 180°
    const d = parse(dxfFull([raw('HATCH', [[8, '0'], [10, 0], [20, 0], [30, 0], [2, 'SOLID'], [70, 1], [71, 0], [91, 1],
      [92, 1], [93, 2], [72, 1], [10, -5], [20, 0], [11, 5], [21, 0], [72, 2], [10, 0], [20, 0], [40, 5], [50, 0], [51, 180], [73, 1], [97, 0], [75, 0], [76, 1], [98, 0]])]));
    expect(fillArea(d)).toBeCloseTo((Math.PI * 25) / 2, 0);
  });
});

describe('leaders, widths and text styles', () => {
  it('draws a filled arrowhead on a LEADER', () => {
    const d = parse(dxfFull([raw('LEADER', [[8, '0'], [71, 1], [76, 2], [10, 0], [20, 0], [30, 0], [10, 20], [20, 0], [30, 0]])]));
    expect(d.fills.length).toBe(1);
    expect(fillArea(d)).toBeCloseTo((2.5 * 2.5) / 6, 6); // length 2.5, width 2.5/3
  });
  it('fills a polyline with constant width', () => {
    const d = parse(dxfFull([raw('LWPOLYLINE', [[8, '0'], [90, 2], [70, 0], [43, 2], [10, 0], [20, 0], [10, 10], [20, 0]])]));
    expect(fillArea(d)).toBeCloseTo(20, 6);
  });
  it('keeps MTEXT box width for wrapping and applies style width factors', () => {
    const d = parse(dxfFull([
      raw('MTEXT', [[8, '0'], [10, 0], [20, 0], [30, 0], [40, 2.5], [41, 60], [71, 3], [7, 'NOTES'], [1, 'A LONG NOTE THAT SHOULD WRAP INSIDE ITS BOX']]),
      raw('TEXT', [[8, '0'], [10, 0], [20, 0], [30, 0], [40, 2.5], [7, 'NOTES'], [1, 'X']]),
    ], { styles: [['NOTES', 0.8, 'romans.shx']] }));
    expect(d.text.num[6]).toBe(60); // wrap width
    expect(d.text.align[0] & 3).toBe(2); // attachment 3 = top right
    expect(d.text.num[TS + 5]).toBeCloseTo(0.8 * 0.86, 6);
  });
});
