// Writes DWG test drawings with acad-ts (MIT; port of ACadSharp) in several AutoCAD versions.
// Usage: vite-node scripts/make-dwg.ts <outdir> [bigScale]
import { writeFileSync, mkdirSync } from 'node:fs';
import { CadDocument, DwgWriter, ACadVersion, Line, Arc, Circle, LwPolyline, LwPolylineVertex, TextEntity, MText, Insert, BlockRecord, Layer, Color, XYZ, XY } from '@node-projects/acad-ts';

const out = process.argv[2] ?? 'samples', big = +(process.argv[3] ?? 0);
mkdirSync(out, { recursive: true });

function plan(n: number) {
  const doc = new CadDocument();
  doc.header.insUnits = 6 as any; // metres
  const layer = (name: string, aci: number) => { const l = new Layer(); l.name = name; l.color = new Color(aci); doc.layers!.add(l); return l; };
  const walls = layer('A-WALL', 7), doors = layer('A-DOOR', 3), furn = layer('A-FURN', 4), text = layer('A-ANNO', 2);
  const door = new BlockRecord('DOOR-900');
  const dl = new Line(); dl.startPoint = new XYZ(0, 0, 0); dl.endPoint = new XYZ(0.9, 0, 0); door.entities.add(dl);
  const da = new Arc(); da.center = new XYZ(0, 0, 0); da.radius = 0.9; da.startAngle = 0; da.endAngle = Math.PI / 2; door.entities.add(da);
  doc.blockRecords!.add(door);
  const add = (e: any, l: Layer) => { e.layer = l; doc.modelSpace!.entities.add(e); };
  const poly = (pts: [number, number, number?][], closed: boolean, l: Layer) => {
    const p = new LwPolyline();
    p.vertices = pts.map(([x, y, b]) => { const v = new LwPolylineVertex(new XY(x, y)); v.bulge = b ?? 0; return v; });
    p.isClosed = closed;
    add(p, l);
  };
  for (let bx = 0; bx < n; bx++) for (let by = 0; by < n; by++) {
    const ox = bx * 12, oy = by * 10;
    poly([[ox, oy], [ox + 10, oy], [ox + 10, oy + 8], [ox, oy + 8]], true, walls);
    poly([[ox + 0.2, oy + 0.2], [ox + 9.8, oy + 0.2], [ox + 9.8, oy + 7.8], [ox + 0.2, oy + 7.8]], true, walls);
    const l1 = new Line(); l1.startPoint = new XYZ(ox + 6, oy + 0.2, 0); l1.endPoint = new XYZ(ox + 6, oy + 7.8, 0); add(l1, walls);
    const l2 = new Line(); l2.startPoint = new XYZ(ox + 0.2, oy + 4, 0); l2.endPoint = new XYZ(ox + 6, oy + 4, 0); add(l2, walls);
    for (const [x, y, r] of [[ox + 2, oy + 4, 0], [ox + 6, oy + 5, Math.PI / 2]] as const) {
      const ins = new Insert(door); ins.insertPoint = new XYZ(x, y, 0); ins.rotation = r; add(ins, doors);
    }
    const c = new Circle(); c.center = new XYZ(ox + 3, oy + 6, 0); c.radius = 0.6; add(c, furn);
    poly([[ox + 1, oy + 1], [ox + 3, oy + 1, 0.4], [ox + 3, oy + 2.5], [ox + 1, oy + 2.5]], true, furn);
    const t = (s: string, x: number, y: number) => { const e = new TextEntity(s); e.insertPoint = new XYZ(x, y, 0); e.height = 0.35; add(e, text); };
    t(n > 1 ? `LIVING ${bx}-${by}` : 'LIVING 201', ox + 1, oy + 5.2);
    t(n > 1 ? `BED ${bx}-${by}` : 'BED 202', ox + 1, oy + 3.4);
    const m = new MText(); m.value = n > 1 ? `KITCHEN\\P${bx * n + by}` : 'KITCHEN 203\\PØ 600 sink'; m.insertPoint = new XYZ(ox + 7, oy + 6.5, 0); m.height = 0.35; add(m, text);
  }
  return doc;
}

const small = plan(1);
for (const [name, v] of [['2018', 'AC1032'], ['2004', 'AC1018'], ['2000', 'AC1015']] as const) {
  small.header.version = (ACadVersion as any)[v];
  writeFileSync(`${out}/floorplan-${name}.dwg`, DwgWriter.writeToBuffer(small));
  console.log(`wrote ${out}/floorplan-${name}.dwg`);
}
if (big) {
  const doc = plan(big);
  doc.header.version = ACadVersion.AC1032;
  writeFileSync(`${out}/big-plan.dwg`, DwgWriter.writeToBuffer(doc));
  console.log(`wrote ${out}/big-plan.dwg (${big * big} units)`);
}
