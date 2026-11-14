// Everything heavy happens here, off the UI thread, so gestures stay smooth while big files load.
// Results go back as transferable typed arrays (zero-copy).
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { MeshBVH } from 'three-mesh-bvh';
import { parseDxf, type Drawing } from './cad/dxf';
import { diffDrawings } from './cad/diff';
import { buildGrid, type SnapGrid } from './cad/snapgrid';
import { tileDrawing } from './cad/tiles';

export const EDGE_TRI_LIMIT = 600_000;

export type Req =
  | { type: 'dxf'; id: number; buf: ArrayBuffer }
  | { type: 'compare'; id: number; base: ArrayBuffer; other: ArrayBuffer; origin: [number, number, number] }
  | { type: 'mesh'; id: number; ext: string; buf: ArrayBuffer }
  | { type: 'skp'; id: number; buf: ArrayBuffer };

export interface MeshOut {
  name: string; part: number;
  position: Float32Array; normal?: Float32Array; color?: Float32Array; uv?: Float32Array; index?: Uint32Array | Uint16Array;
  groups: { start: number; count: number; materialIndex?: number }[];
  materials: { color: number; name: string; vertexColors: boolean; opacity: number }[];
  bvh?: { roots: ArrayBuffer[]; index: Uint32Array | Uint16Array; indirectBuffer: ArrayBuffer | null };
  edges?: Float32Array;
}

const post = (msg: any, transfer: Transferable[] = []) => (self as any).postMessage(msg, transfer);
const progress = (id: number, stage: string, f: number) => post({ type: 'progress', id, stage, f });

function collect(o: any, out: Set<ArrayBuffer>) {
  if (!o) return;
  if (ArrayBuffer.isView(o)) out.add(o.buffer as ArrayBuffer);
  else if (o instanceof ArrayBuffer) out.add(o);
  else if (Array.isArray(o)) o.forEach((v) => collect(v, out));
  else if (typeof o === 'object') for (const k in o) collect(o[k], out);
}
const transferables = (o: any) => [...collect2(o)];
function collect2(o: any) { const s = new Set<ArrayBuffer>(); collect(o, s); return s; }

function dxfGrid(d: Drawing): SnapGrid { return buildGrid(d.snap, d.snapLayer, false); }

self.onmessage = async (e: MessageEvent<Req>) => {
  const m = e.data;
  try {
    if (m.type === 'skp') {
      // SketchUp: open-source reverse-engineered reader (openskp, MIT), loaded only when needed.
      // Reads both the 2021+ (VFF/zip) and 2013–2020 (MFC CArchive) containers, entirely on the device.
      progress(m.id, 'Reading SketchUp model', 0.05);
      const skp = await import('openskp');
      let glb: Uint8Array;
      try {
        const scene = skp.buildInstancedScene(m.buf, {
          onProgress: (p: any) => progress(m.id, 'Reading SketchUp model', Math.min(0.9, 0.1 + 0.8 * (p.fraction ?? (p.total ? p.current / p.total : 0.5)))),
        } as any);
        progress(m.id, 'Building 3D model', 0.92);
        glb = skp.toInstancedGLB(scene);
      } catch (err: any) {
        // fall back to the preview image SketchUp stores inside the file, so the user still sees the model
        let thumb: { data: Uint8Array; mimeType: string } | null = null;
        try { thumb = skp.extractThumbnail(m.buf); } catch { /* no preview either */ }
        const data = thumb ? thumb.data.slice() : null;
        post({ type: 'skpfail', id: m.id, error: String(err?.message ?? err).slice(0, 200), thumb: data, mime: thumb?.mimeType }, data ? [data.buffer] : []);
        return;
      }
      const out = glb.byteOffset === 0 && glb.byteLength === glb.buffer.byteLength ? glb : glb.slice();
      post({ type: 'skp', id: m.id, glb: out }, [out.buffer]);
      return;
    }
    if (m.type === 'dxf') {
      const w0 = performance.now();
      const d = parseDxf(new Uint8Array(m.buf), { onProgress: (f) => progress(m.id, 'Reading drawing', f) });
      const w1 = performance.now();
      progress(m.id, 'Optimising for touch', 1);
      d.tiles = tileDrawing(d);
      const w2 = performance.now();
      d.pieces = new Uint32Array(0); // compare re-reads the file, so these aren't needed for display
      progress(m.id, 'Preparing snapping', 1);
      const grid = dxfGrid(d);
      const res = { type: 'dxf', id: m.id, drawing: d, grid, ms: [w1 - w0, w2 - w1, performance.now() - w2] };
      post(res, transferables(res));
    } else if (m.type === 'compare') {
      const a = parseDxf(new Uint8Array(m.base), { origin: m.origin, onProgress: (f) => progress(m.id, 'Reading current revision', f) });
      const b = parseDxf(new Uint8Array(m.other), { origin: m.origin, onProgress: (f) => progress(m.id, 'Reading other revision', f) });
      progress(m.id, 'Comparing', 1);
      const r = diffDrawings(a, b);
      r.drawing.tiles = tileDrawing(r.drawing);
      const grid = dxfGrid(r.drawing);
      const res = { type: 'compare', id: m.id, drawing: r.drawing, grid, added: r.added, removed: r.removed, same: r.same, units: b.units };
      post(res, transferables(res));
    } else if (m.type === 'mesh') {
      progress(m.id, 'Reading model', 0.1);
      const meshes = parseMesh(m.ext, m.buf);
      const out: MeshOut[] = [];
      let tris = 0;
      for (const mm of meshes) tris += (mm.geometry.index ? mm.geometry.index.count : mm.geometry.attributes.position.count) / 3;
      meshes.forEach((mesh, i) => {
        progress(m.id, 'Optimising for touch', 0.3 + (0.6 * i) / meshes.length);
        out.push(packMesh(mesh, i, tris < EDGE_TRI_LIMIT));
      });
      progress(m.id, 'Preparing snapping', 0.95);
      let n = 0;
      for (const o of out) n += o.position.length;
      const pts = new Float32Array(n), tags = new Uint16Array(n / 3);
      let off = 0;
      for (const o of out) { pts.set(o.position, off); tags.fill(o.part, off / 3, (off + o.position.length) / 3); off += o.position.length; }
      const grid = buildGrid(pts, tags, true);
      const res = { type: 'mesh', id: m.id, meshes: out, grid, tris };
      post(res, transferables(res));
    }
  } catch (err: any) {
    post({ type: 'error', id: m.id, error: String(err?.message ?? err) });
  }
};

function parseMesh(ext: string, buf: ArrayBuffer): THREE.Mesh[] {
  if (ext === 'stl' || ext === 'ply') {
    const g = ext === 'stl' ? new STLLoader().parse(buf) : new PLYLoader().parse(buf);
    if (ext === 'stl') g.deleteAttribute('normal'); // flat shading from derivatives: saves 12 bytes/vertex
    const hasColor = !!g.attributes.color;
    return [new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: hasColor ? 0xffffff : 0xb8c2cc, vertexColors: hasColor }))];
  }
  const obj = new OBJLoader().parse(new TextDecoder().decode(buf));
  const meshes: THREE.Mesh[] = [];
  obj.updateMatrixWorld(true);
  obj.traverse((o: any) => {
    if (o.isMesh) { o.geometry.applyMatrix4(o.matrixWorld); meshes.push(o); }
    if (o.isLineSegments || o.isLine || o.isPoints) {/* ignore OBJ lines/points */}
  });
  return meshes;
}

function packMesh(mesh: THREE.Mesh, part: number, withEdges: boolean): MeshOut {
  const g = mesh.geometry as THREE.BufferGeometry;
  const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[];
  const edges = withEdges ? (new THREE.EdgesGeometry(g, 30).attributes.position.array as Float32Array) : undefined;
  let bvh: MeshOut['bvh'];
  try {
    const b = new MeshBVH(g, { maxLeafTris: 10 });
    const s = MeshBVH.serialize(b, { cloneBuffers: false }) as any;
    bvh = { roots: s.roots, index: s.index, indirectBuffer: s.indirectBuffer ?? null };
  } catch { /* fall back to plain raycasting */ }
  const attr = (n: string) => (g.attributes[n] ? (g.attributes[n].array as Float32Array) : undefined);
  return {
    name: mesh.name, part,
    position: attr('position')!, normal: attr('normal'), color: attr('color'), uv: attr('uv'),
    index: bvh ? undefined : (g.index?.array as Uint32Array | undefined),
    groups: g.groups.map((x) => ({ ...x })),
    materials: mats.map((mt) => ({ color: mt?.color?.getHex() ?? 0xb8c2cc, name: mt?.name ?? '', vertexColors: !!mt?.vertexColors, opacity: mt?.opacity ?? 1 })),
    bvh, edges,
  };
}
