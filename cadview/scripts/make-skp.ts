// Writes samples/house.skp with openskp's writer (legacy 2013–2020 container), used to test SketchUp import.
// SketchUp's internal unit is the inch; this house is 10 m × 8 m.
import { writeFileSync, mkdirSync } from 'node:fs';
import { create } from 'openskp';

const M = 39.3701; // inches per metre
const b = create();
const wall = b.addMaterial('Wall plaster', [226, 220, 205]);
const roof = b.addMaterial('Roof tiles', [150, 60, 45]);
const floor = b.addMaterial('Oak floor', [176, 132, 86]);
const glass = b.addMaterial('Glass', [140, 190, 220]);
const door = b.addMaterial('Door', [90, 60, 40]);
const Lwalls = b.addLayer('Walls', { color: [200, 200, 200] });
const Lroof = b.addLayer('Roof', { color: [180, 60, 40] });
const Lopen = b.addLayer('Doors & windows', { color: [60, 120, 200] });

const box = (def: any, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, material: any, layer?: any) => {
  const P = (x: number, y: number, z: number) => [x * M, y * M, z * M];
  const f = (pts: number[][]) => def.addFace(pts, { material, layer });
  f([P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0), P(x1, y0, z0)]);
  f([P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)]);
  f([P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1)]);
  f([P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1)]);
  f([P(x1, y1, z0), P(x0, y1, z0), P(x0, y1, z1), P(x1, y1, z1)]);
  f([P(x0, y1, z0), P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1)]);
};

// a door component (0.9 m × 2.1 m), placed several times
const Door = b.addComponentDefinition('Door 900', (def: any) => box(def, 0, -0.03, 0, 0.9, 0.03, 2.1, door, Lopen));
const Window = b.addComponentDefinition('Window 1200', (def: any) => box(def, 0, -0.02, 0, 1.2, 0.02, 1.2, glass, Lopen));
b.addGroup((def: any) => {
  const P = (x: number, y: number, z: number) => [x * M, y * M, z * M];
  def.addFace([P(-0.3, -0.3, 3), P(10.3, -0.3, 3), P(10.3, 4, 5), P(-0.3, 4, 5)], { material: roof, layer: Lroof });
  def.addFace([P(-0.3, 4, 5), P(10.3, 4, 5), P(10.3, 8.3, 3), P(-0.3, 8.3, 3)], { material: roof, layer: Lroof });
}, { name: 'Roof' });

b.addInstance(Door, { translation: [2 * M, 0, 0.2 * M] });
b.addInstance(Door, { translation: [6.5 * M, 0, 0.2 * M] });
b.addInstance(Door, { translation: [4 * M, 4 * M, 0.2 * M] });
for (const x of [1, 3.5, 7.5]) b.addInstance(Window, { translation: [x * M, 8 * M, 1 * M] });

const root = { addFace: (pts: number[][], o: any) => b.addFace(pts, o) };
box(root, 0, 0, 0, 10, 8, 0.2, floor);
box(root, 0, 0, 0.2, 10, 0.2, 3, wall, Lwalls);
box(root, 0, 7.8, 0.2, 10, 8, 3, wall, Lwalls);
box(root, 0, 0, 0.2, 0.2, 8, 3, wall, Lwalls);
box(root, 9.8, 0, 0.2, 10, 8, 3, wall, Lwalls);
box(root, 0.2, 3.95, 0.2, 9.8, 4.05, 3, wall, Lwalls);
b.addCircle([5 * M, 0, 2.5 * M], [0, -1, 0], 0.3 * M);

mkdirSync('samples', { recursive: true });
writeFileSync('samples/house.skp', b.toBytes());
console.log('wrote samples/house.skp');
