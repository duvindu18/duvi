import { describe, expect, it } from 'vitest';
import { parseDxf, bulgedPolyline, cleanText } from '../src/cad/dxf';
import { diffDrawings } from '../src/cad/diff';
import { dxf, line, circle, text, lwpoly, insert, arc } from './dxfgen';

const pts = (segs: number[]) => {
  const out: [number, number][] = [];
  for (let i = 0; i < segs.length; i += 3) out.push([segs[i], segs[i + 1]]);
  return out;
};

describe('parseDxf', () => {
  it('reads basic entities, layers, colours and units', () => {
    const d = parseDxf(dxf([line(0, 0, 10, 0, 'WALLS'), circle(5, 5, 2, 'DOORS'), text(1, 1, 0.5, 'Room 204', 'TEXT')],
      { layers: [['WALLS', 1], ['DOORS', 7], ['TEXT', 3]], units: 4 }));
    expect(d.units).toBe('mm');
    expect(d.primitives.map((p) => p.type)).toEqual(['LINE', 'CIRCLE', 'TEXT']);
    expect(d.primitives[0].color).toBe(0xff0000); // ACI 1 by layer
    expect(d.primitives[1].color).toBe(-1); // ACI 7 → theme foreground
    expect(d.primitives[2].text!.value).toBe('Room 204');
    expect(d.layers.map((l) => l.name)).toEqual(['DOORS', 'TEXT', 'WALLS']);
  });

  it('expands block INSERTs with rotation, scale and translation', () => {
    const d = parseDxf(dxf([insert('DOOR', 100, 50, 90, 2, 2, 'DOORS')], { blocks: { DOOR: [line(0, 0, 1, 0)] } }));
    const [[x1, y1], [x2, y2]] = pts(d.primitives[0].segments);
    expect([x1, y1]).toEqual([100, 50]);
    expect(x2).toBeCloseTo(100);
    expect(y2).toBeCloseTo(52); // 1 unit along x, scaled ×2, rotated 90°
    expect(d.primitives[0].layer).toBe('DOORS'); // layer-0 block content inherits the insert's layer
  });

  it('draws arcs counter-clockwise from start to end', () => {
    const d = parseDxf(dxf([arc(0, 0, 1, 0, 90)]));
    const p = pts(d.primitives[0].segments);
    expect(p[0][0]).toBeCloseTo(1);
    expect(p[p.length - 1][1]).toBeCloseTo(1);
  });

  it('reports entity types it cannot draw instead of hiding them', () => {
    const src = dxf([line(0, 0, 1, 1)]).replace('0\nENDSEC\n0\nEOF', '0\nHATCH\n8\n0\n0\nENDSEC\n0\nEOF');
    expect(parseDxf(src).skipped).toEqual({ HATCH: 1 });
  });
});

describe('bulgedPolyline', () => {
  it('turns bulge=1 into a semicircle through the expected apex', () => {
    const p = bulgedPolyline([{ x: 0, y: 0, bulge: 1 }, { x: 2, y: 0 }], false);
    expect([p[0].x, p[0].y]).toEqual([0, 0]);
    const last = p[p.length - 1];
    expect(last.x).toBeCloseTo(2);
    expect(last.y).toBeCloseTo(0);
    const ys = p.map((q) => q.y);
    // positive bulge = counter-clockwise from (0,0) to (2,0): the arc dips below the chord
    expect(Math.min(...ys)).toBeCloseTo(-1, 2);
  });
  it('closes closed polylines', () => {
    const d = parseDxf(dxf([lwpoly([[0, 0], [1, 0], [1, 1]], true)]));
    expect(d.primitives[0].segments.length / 6).toBe(3);
  });
});

describe('cleanText', () => {
  it('strips MTEXT formatting', () => {
    expect(cleanText('{\\fArial|b1;KITCHEN}\\P12.5 m%%d')).toBe('KITCHEN\n12.5 m°');
  });
});

describe('diffDrawings', () => {
  const base = [line(0, 0, 10, 0), line(10, 0, 10, 10), text(5, 5, 1, 'A')];
  it('finds added and removed entities, ignoring order and line direction', () => {
    const a = parseDxf(dxf(base));
    const b = parseDxf(dxf([line(10, 10, 10, 0), text(5, 5, 1, 'A'), line(0, 0, 10, 0), circle(3, 3, 1)]));
    const r = diffDrawings(a.primitives, b.primitives);
    expect([r.same, r.added, r.removed]).toEqual([3, 1, 0]);
  });
  it('treats a moved line as removed + added', () => {
    const a = parseDxf(dxf(base));
    const b = parseDxf(dxf([line(0, 1, 10, 1), line(10, 0, 10, 10), text(5, 5, 1, 'A')]));
    const r = diffDrawings(a.primitives, b.primitives);
    expect([r.same, r.added, r.removed]).toEqual([2, 1, 1]);
  });
  it('counts duplicates rather than collapsing them', () => {
    const a = parseDxf(dxf([line(0, 0, 1, 0), line(0, 0, 1, 0)]));
    const b = parseDxf(dxf([line(0, 0, 1, 0)]));
    const r = diffDrawings(a.primitives, b.primitives);
    expect([r.same, r.removed]).toEqual([1, 1]);
  });
});
