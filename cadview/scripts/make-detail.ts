// Detail-drawing sample with linetypes, hatches, leaders, multileader, wrapped MTEXT, wide polylines and
// dimension-style arrows. Writes samples/detail.dxf and (through acad-ts) samples/detail.dwg.
import { writeFileSync } from 'node:fs';
import { DxfReader, DwgWriter, ACadVersion, CadDocument } from '@node-projects/acad-ts';
type G = [number, string | number];
const E = (type: string, g: G[]): G[] => [[0, type], [5, (++handle).toString(16).toUpperCase()], ...g];
let handle = 0x100;
const ent: G[][] = [];
const sq = (x0: number, y0: number, w: number, h: number): G[] => [[92, 2], [72, 0], [73, 1], [93, 4], [10, x0], [20, y0], [10, x0 + w], [20, y0], [10, x0 + w], [20, y0 + h], [10, x0], [20, y0 + h], [97, 0]];
// wall section: concrete (pattern), insulation (dense → tint), steel (solid)
ent.push(E('LWPOLYLINE', [[8, 'A-WALL'], [90, 4], [70, 1], [10, 0], [20, 0], [10, 200], [20, 0], [10, 200], [20, 1200], [10, 0], [20, 1200]]));
ent.push(E('HATCH', [[8, 'A-HATCH'], [10, 0], [20, 0], [30, 0], [210, 0], [220, 0], [230, 1], [2, 'ANSI31'], [70, 0], [71, 0], [91, 1], ...sq(0, 0, 200, 1200), [75, 0], [76, 1], [52, 0], [41, 20], [77, 0],
  [78, 1], [53, 45], [43, 0], [44, 0], [45, -44.9], [46, 44.9], [79, 0], [98, 0]]));
ent.push(E('LWPOLYLINE', [[8, 'A-WALL'], [90, 4], [70, 1], [10, 200], [20, 0], [10, 300], [20, 0], [10, 300], [20, 1200], [10, 200], [20, 1200]]));
ent.push(E('HATCH', [[8, 'A-INSUL'], [10, 0], [20, 0], [30, 0], [210, 0], [220, 0], [230, 1], [2, 'SOLID'], [70, 1], [71, 0], [91, 1], ...sq(200, 0, 100, 1200), [75, 0], [76, 1], [98, 0]]));
ent.push(E('HATCH', [[8, 'S-STEEL'], [10, 0], [20, 0], [30, 0], [210, 0], [220, 0], [230, 1], [2, 'SOLID'], [70, 1], [71, 0], [91, 1], ...sq(300, 1150, 260, 50), [75, 0], [76, 1], [98, 0]]));
// hidden and centre lines
ent.push(E('LINE', [[8, 'A-HIDDEN'], [10, 0], [20, 600], [30, 0], [11, 900], [21, 600], [31, 0]]));
ent.push(E('LINE', [[8, 'A-CENTER'], [10, 150], [20, -100], [30, 0], [11, 150], [21, 1350], [31, 0]]));
// leader + note (MTEXT right-attached, wrapped to its box)
ent.push(E('LEADER', [[8, 'A-ANNO'], [3, 'Standard'], [71, 1], [72, 0], [73, 3], [76, 3], [10, 250], [20, 900], [30, 0], [10, 650], [20, 1000], [30, 0], [10, 750], [20, 1000], [30, 0]]));
ent.push(E('MTEXT', [[8, 'A-ANNO'], [10, 770], [20, 1020], [30, 0], [40, 25], [41, 420], [71, 1], [72, 1], [7, 'Standard'], [1, '75MM RIGID INSULATION BOARD, MECHANICALLY FIXED TO MASONRY - SEE SPEC.']]));
ent.push(E('MTEXT', [[8, 'A-ANNO'], [10, -60], [20, 300], [30, 0], [40, 25], [41, 380], [71, 3], [72, 1], [7, 'Standard'], [1, '200MM REINFORCED CONCRETE WALL, MICROCEMENT FINISH BOTH FACES']]));
ent.push(E('LINE', [[8, 'A-ANNO'], [10, -50], [20, 290], [30, 0], [11, 60], [21, 290], [31, 0]]));
// thick polyline arrow and title
ent.push(E('LWPOLYLINE', [[8, 'A-ANNO'], [90, 2], [70, 0], [10, 600], [20, 300], [40, 0], [41, 30], [10, 650], [20, 300], [10, 900], [20, 300]]));
ent.push(E('TEXT', [[8, 'A-ANNO'], [10, 600], [20, 230], [30, 0], [40, 22], [41, 0.8], [7, 'Standard'], [1, 'FALL TO DRAIN 1:40']]));
ent.push(E('TEXT', [[8, 'A-TITLE'], [10, 0], [20, -200], [30, 0], [40, 45], [7, 'Standard'], [1, 'WALL SECTION DETAIL']]));
ent.push(E('TEXT', [[8, 'A-TITLE'], [10, 0], [20, -260], [30, 0], [40, 25], [7, 'Standard'], [1, 'SCALE 1:10']]));
ent.push(E('LWPOLYLINE', [[8, 'A-TITLE'], [90, 2], [70, 0], [43, 6], [10, 0], [20, -215], [10, 600], [20, -215]]));
// dimension-style arrows (SOLIDs)
ent.push(E('LINE', [[8, 'A-DIM'], [10, 0], [20, 1300], [30, 0], [11, 300], [21, 1300], [31, 0]]));
ent.push(E('SOLID', [[8, 'A-DIM'], [10, 0], [20, 1300], [30, 0], [11, 25], [21, 1304], [31, 0], [12, 25], [22, 1296], [32, 0], [13, 25], [23, 1296], [33, 0]]));
ent.push(E('SOLID', [[8, 'A-DIM'], [10, 300], [20, 1300], [30, 0], [11, 275], [21, 1304], [31, 0], [12, 275], [22, 1296], [32, 0], [13, 275], [23, 1296], [33, 0]]));
ent.push(E('TEXT', [[8, 'A-DIM'], [10, 150], [20, 1310], [30, 0], [40, 20], [72, 1], [11, 150], [21, 1310], [31, 0], [7, 'Standard'], [1, '300']]));

const layers: [string, number, string][] = [['0', 7, 'Continuous'], ['A-WALL', 7, 'Continuous'], ['A-HATCH', 8, 'Continuous'], ['A-INSUL', 254, 'Continuous'], ['S-STEEL', 5, 'Continuous'],
  ['A-HIDDEN', 1, 'HIDDEN'], ['A-CENTER', 3, 'CENTER'], ['A-ANNO', 7, 'Continuous'], ['A-TITLE', 7, 'Continuous'], ['A-DIM', 2, 'Continuous']];
const ltypes: [string, number[]][] = [['ByBlock', []], ['ByLayer', []], ['Continuous', []], ['HIDDEN', [6.35, -3.175]], ['CENTER', [31.75, -6.35, 6.35, -6.35]]];
const g: G[] = [[0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1032'], [9, '$INSUNITS'], [70, 4], [9, '$LTSCALE'], [40, 10], [9, '$DIMASZ'], [40, 2.5], [9, '$DIMSCALE'], [40, 10], [9, '$HANDSEED'], [5, 'FFFF'], [0, 'ENDSEC'],
  [0, 'SECTION'], [2, 'TABLES'], [0, 'TABLE'], [2, 'LTYPE'], [70, ltypes.length]];
for (const [n, el] of ltypes) { g.push([0, 'LTYPE'], [5, (++handle).toString(16)], [100, 'AcDbSymbolTableRecord'], [100, 'AcDbLinetypeTableRecord'], [2, n], [70, 0], [3, ''], [72, 65], [73, el.length], [40, el.reduce((s, x) => s + Math.abs(x), 0)]); for (const e of el) g.push([49, e], [74, 0]); }
g.push([0, 'ENDTAB'], [0, 'TABLE'], [2, 'LAYER'], [70, layers.length]);
for (const [n, c, lt] of layers) g.push([0, 'LAYER'], [5, (++handle).toString(16)], [100, 'AcDbSymbolTableRecord'], [100, 'AcDbLayerTableRecord'], [2, n], [70, 0], [62, c], [6, lt]);
g.push([0, 'ENDTAB'], [0, 'TABLE'], [2, 'STYLE'], [70, 1], [0, 'STYLE'], [5, (++handle).toString(16)], [100, 'AcDbSymbolTableRecord'], [100, 'AcDbTextStyleTableRecord'], [2, 'Standard'], [70, 0], [40, 0], [41, 1], [50, 0], [71, 0], [42, 2.5], [3, 'romans.shx'], [4, ''], [0, 'ENDTAB'], [0, 'ENDSEC']);
g.push([0, 'SECTION'], [2, 'ENTITIES']);
for (const e of ent) g.push(...e);
g.push([0, 'ENDSEC'], [0, 'EOF']);
const dxf = g.map(([c, v]) => `${c}\n${v}`).join('\n') + '\n';
writeFileSync('samples/detail.dxf', dxf);
console.log('wrote samples/detail.dxf');
try {
  const src = DxfReader.readFromStream(new TextEncoder().encode(dxf), () => {});
  // a complete document skeleton (block records, dictionaries…) with our entities copied in
  const doc = new CadDocument();
  doc.header.version = ACadVersion.AC1032;
  (doc.header as any).insUnits = 4;
  (doc.header as any).linetypeScale = 10;
  for (const e of [...(src.modelSpace!.entities as any)]) doc.modelSpace!.entities.add((e as any).clone());
  writeFileSync('samples/detail.dwg', DwgWriter.writeToBuffer(doc));
  console.log('wrote samples/detail.dwg');
} catch (e: any) { console.log('DWG write failed:', e.message); }
