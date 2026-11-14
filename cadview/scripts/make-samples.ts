// Generates demo files in samples/: a floor plan in two revisions (for Compare) and a 3D house (OBJ, Z-up like SketchUp).
import { writeFileSync, mkdirSync } from 'node:fs';
import { dxf, line, circle, text, lwpoly, insert, arc } from '../test/dxfgen';

mkdirSync('samples', { recursive: true });
const layers: [string, number][] = [['WALLS', 7], ['DOORS', 3], ['FURNITURE', 4], ['TEXT', 2], ['DIMS', 1]];
const door = [line(0, 0, 0.9, 0, '0'), arc(0, 0, 0.9, 0, 90, '0'), line(0, 0, 0, 0.9, '0')];
const walls = (w: number) => [
  lwpoly([[0, 0], [w, 0], [w, 8], [0, 8]], true, 'WALLS'),
  lwpoly([[0.2, 0.2], [w - 0.2, 0.2], [w - 0.2, 7.8], [0.2, 7.8]], true, 'WALLS'),
  line(6, 0.2, 6, 7.8, 'WALLS'),
  line(0.2, 4, 6, 4, 'WALLS'),
];
const common = [
  insert('DOOR', 2, 4, 0, 1, 1, 'DOORS'),
  insert('DOOR', 6, 5, 90, 1, 1, 'DOORS'),
  circle(3, 6, 0.6, 'FURNITURE'),
  lwpoly([[1, 1], [3, 1, 0.4], [3, 2.5], [1, 2.5]], true, 'FURNITURE'),
  text(1, 5.2, 0.35, 'LIVING 201', 'TEXT'),
  text(1, 3.4, 0.35, 'BED 202', 'TEXT'),
  text(7, 6.5, 0.35, 'KITCHEN 203', 'TEXT'),
];
writeFileSync('samples/floorplan-rev-A.dxf', dxf([...walls(10), ...common, text(7, 2, 0.35, 'STORE 204', 'TEXT')], { layers, blocks: { DOOR: door } }));
// Rev B: building 1 m wider, store becomes office, extra table
writeFileSync('samples/floorplan-rev-B.dxf', dxf([...walls(11), ...common, text(7, 2, 0.35, 'OFFICE 204', 'TEXT'), circle(9, 2.5, 0.5, 'FURNITURE')], { layers, blocks: { DOOR: door } }));

// Simple house, Z-up, metres
const v: number[][] = [], f: number[][] = [];
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
  const b = v.length + 1;
  for (const [x, y, z] of [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]) v.push([x, y, z]);
  for (const q of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) f.push(q.map((i) => i + b));
};
box(0, 0, 0, 10, 8, 0.2); // slab
box(0, 0, 0, 10, 0.2, 3); box(0, 7.8, 0, 10, 8, 3); box(0, 0, 0, 0.2, 8, 3); box(9.8, 0, 0, 10, 8, 3); box(6, 0, 0, 6.1, 8, 3);
const r = v.length + 1;
v.push([0, 0, 3], [10, 0, 3], [10, 4, 5], [0, 4, 5], [10, 8, 3], [0, 8, 3]);
f.push([r, r + 1, r + 2, r + 3], [r + 3, r + 2, r + 4, r + 5], [r, r + 3, r + 5], [r + 1, r + 4, r + 2]);
writeFileSync('samples/house.obj', '# CADView sample house (Z-up, metres)\no House\n' + v.map((p) => `v ${p.join(' ')}`).join('\n') + '\n' + f.map((q) => `f ${q.join(' ')}`).join('\n') + '\n');
console.log('samples written');
