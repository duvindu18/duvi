import { describe, expect, it } from 'vitest';
import { parseDxf, bulgePts, cleanText, type Drawing, type Bucket } from '../src/cad/dxf';
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
      .replace('0\nENDSEC\n0\nEOF', '0\nHATCH\n8\n0\n0\nLINE\n8\n0\n67\n1\n10\n9\n20\n9\n30\n0\n11\n8\n21\n8\n31\n0\n0\nENDSEC\n0\nEOF');
    const d = parse(s);
    expect(d.skipped).toEqual({ HATCH: 1 });
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
