// Stress-test files: a large city-block DXF and a dense STL. Usage: vite-node scripts/make-big.ts <outdir> [scale]
import { writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { dxf, line, circle, text, lwpoly, insert, arc } from '../test/dxfgen';
const out = process.argv[2] ?? 'samples', k = +(process.argv[3] ?? 1);
// header + blocks from the small writer, then entities streamed straight to disk
const N0 = Math.round(60 * k);
const shell = dxf([], { ext: [500000, 200000, 500000 + N0 * 30, 200000 + N0 * 30], layers: [['WALLS', 7], ['GRID', 8], ['DOORS', 3], ['FURNITURE', 4], ['TEXT', 2]],
  blocks: { DOOR: [line(0, 0, 0.9, 0, '0'), arc(0, 0, 0.9, 0, 90, '0'), line(0, 0, 0, 0.9, '0')] } });
const [pre, post] = shell.split('2\nENTITIES\n');
const fd = openSync(`${out}/big-city.dxf`, 'w');
writeSync(fd, pre + '2\nENTITIES\n');
let ents: any[] = [], count = 0;
const flushEnts = () => { writeSync(fd, ents.map((e) => e.map(([c, v]: any) => `${c}\n${v}`).join('\n')).join('\n') + '\n'); count += ents.length; ents = []; };
const N = Math.round(60 * k);
for (let bx = 0; bx < N; bx++) for (let by = 0; by < N; by++) {
  if (ents.length > 5000) flushEnts();
  const ox = 500000 + bx * 30, oy = 200000 + by * 30; // survey-grid coordinates
  ents.push(lwpoly([[ox, oy], [ox + 25, oy], [ox + 25, oy + 25], [ox, oy + 25]], true, 'WALLS'));
  for (let i = 1; i < 5; i++) ents.push(line(ox + i * 5, oy, ox + i * 5, oy + 25, 'WALLS'), line(ox, oy + i * 5, ox + 25, oy + i * 5, 'GRID'));
  ents.push(insert('DOOR', ox + 2, oy, 0, 1, 1, 'DOORS'), circle(ox + 12, oy + 12, 2, 'FURNITURE'), arc(ox + 20, oy + 20, 3, 0, 180, 'FURNITURE'));
  ents.push(text(ox + 1, oy + 22, 0.8, `UNIT ${bx}-${by}`, 'TEXT'), text(ox + 6, oy + 6, 0.4, `R${bx * N + by}`, 'TEXT'));
}
flushEnts();
writeSync(fd, post);
closeSync(fd);
// dense binary STL: a wavy terrain grid
const G = Math.round(700 * Math.sqrt(k)), tris = (G - 1) * (G - 1) * 2;
const buf = Buffer.alloc(84 + tris * 50); buf.writeUInt32LE(tris, 80);
let o = 84; const h = (x: number, y: number) => Math.sin(x * 0.05) * Math.cos(y * 0.04) * 8 + Math.sin(x * 0.3 + y * 0.2);
const tri = (a: number[], b: number[], c: number[]) => { o += 12; for (const p of [a, b, c]) for (const v of p) { buf.writeFloatLE(v, o); o += 4; } o += 2; };
for (let x = 0; x < G - 1; x++) for (let y = 0; y < G - 1; y++) {
  const p = (i: number, j: number) => [i, j, h(i, j)];
  tri(p(x, y), p(x + 1, y), p(x + 1, y + 1)); tri(p(x, y), p(x + 1, y + 1), p(x, y + 1));
}
writeFileSync(`${out}/big-terrain.stl`, buf);
console.log('entities', count, 'triangles', tris);
