// Large SketchUp test model: a detailed component placed thousands of times plus big loose geometry.
// Usage: vite-node scripts/make-big-skp.ts <out.skp> [instances] [detail]
import { writeFileSync } from 'node:fs';
import { create } from 'openskp';
const out = process.argv[2], N = +(process.argv[3] ?? 3000), D = +(process.argv[4] ?? 12);
const M = 39.3701;
const b = create();
const wood = b.addMaterial('Wood', [150, 105, 60]), metal = b.addMaterial('Metal', [170, 175, 180]), ground = b.addMaterial('Ground', [110, 140, 90]);
const Lf = b.addLayer('Furniture'), Lg = b.addLayer('Site');
const box = (def: any, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, material: any, layer: any) => {
  const P = (x: number, y: number, z: number) => [x * M, y * M, z * M];
  const f = (p: number[][]) => def.addFace(p, { material, layer });
  f([P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0), P(x1, y0, z0)]); f([P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)]);
  f([P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1)]); f([P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1)]);
  f([P(x1, y1, z0), P(x0, y1, z0), P(x0, y1, z1), P(x1, y1, z1)]); f([P(x0, y1, z0), P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1)]);
};
// chair: seat + legs + D×D slatted back = ~6·(5 + D·D) faces
const chair = b.addComponentDefinition('Chair', (def: any) => {
  box(def, 0, 0, 0.45, 0.5, 0.5, 0.5, wood, Lf);
  for (const [x, y] of [[0, 0], [0.45, 0], [0, 0.45], [0.45, 0.45]]) box(def, x, y, 0, x + 0.05, y + 0.05, 0.45, metal, Lf);
  for (let i = 0; i < D; i++) for (let j = 0; j < D; j++) box(def, (i * 0.5) / D, 0.46, 0.5 + (j * 0.5) / D, ((i + 0.7) * 0.5) / D, 0.5, 0.5 + ((j + 0.7) * 0.5) / D, wood, Lf);
});
const side = Math.ceil(Math.sqrt(N));
for (let k = 0; k < N; k++) b.addInstance(chair, { translation: [(k % side) * 0.9 * M, Math.floor(k / side) * 0.9 * M, 0] });
// loose terrain grid
const G = 120;
for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) {
  const x = i * 0.5, y = j * 0.5, z = (a: number, c: number) => -0.02 - 0.01 * Math.sin(a * 0.3) * Math.cos(c * 0.2);
  const P = (a: number, c: number) => [a * M, c * M, z(a, c) * M];
  b.addFace([P(x, y), P(x + 0.5, y), P(x + 0.5, y + 0.5)], { material: ground, layer: Lg });
  b.addFace([P(x, y), P(x + 0.5, y + 0.5), P(x, y + 0.5)], { material: ground, layer: Lg });
}
writeFileSync(out, b.toBytes());
console.log(`wrote ${out}: ${N} chairs × ~${6 * (5 + D * D)} faces + ${2 * G * G} terrain faces`);
