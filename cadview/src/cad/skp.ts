// SketchUp → instanced geometry, in the worker. Each component definition is kept once and
// every placement is just a 4×4 matrix, so a chair placed 3,000 times costs one chair of
// memory instead of 3,000 (baking the placements out is what crashed phones on big models).
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { buildGrid, type SnapGrid } from './snapgrid';

export interface SkpPrim {
  res: number; material: number;
  positions: Float32Array; normals: Float32Array; uvs?: Float32Array; indices: Uint32Array;
  bvh?: { roots: ArrayBuffer[]; index: Uint32Array | Uint16Array; indirectBuffer: ArrayBuffer | null };
}
export interface SkpMaterial { color: [number, number, number, number]; texture: number; name: string }
export interface SkpModel {
  prims: SkpPrim[];
  /** per resource: placements (column-major 4×4, world space) and the tag of each placement */
  instances: { matrices: Float32Array; tags: Uint16Array }[];
  materials: SkpMaterial[];
  textures: { data: Uint8Array; mime: string }[];
  /** groups the panel switches: SketchUp tags, or (when a file uses just one tag) its top-level components */
  tags: { name: string; hidden: boolean }[];
  groupKind: 'tags' | 'parts';
  /** crease edges baked per tag (skipped for very heavily instanced components) */
  edges: { tag: number; data: Float32Array }[];
  grid: SnapGrid;
  tris: number; placedTris: number; placements: number;
}

const SNAP_BUDGET = 2_500_000; // snap points
const EDGE_BUDGET = 12_000_000; // floats of baked edge segments

function mul(a: Float64Array, b: ArrayLike<number>): Float64Array {
  const r = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + rr] * b[c * 4 + k];
    r[c * 4 + rr] = s;
  }
  return r;
}

export async function readSkp(buf: ArrayBuffer, progress: (stage: string, f: number) => void): Promise<SkpModel> {
  const skp = await import('openskp');
  const scene = skp.buildInstancedScene(buf, {
    onProgress: (p: any) => progress('Reading SketchUp model', Math.min(0.7, 0.05 + 0.65 * (p.fraction ?? (p.total ? p.current / p.total : 0.5)))),
  } as any);
  progress('Preparing components', 0.72);

  // two ways to group placements for the Tags/Parts panel; we pick one after the walk
  const tagIdx = new Map<string, number>(), tagList: { name: string; hidden: boolean }[] = [];
  const tagOf = (name: string) => {
    let i = tagIdx.get(name);
    if (i === undefined) { i = tagList.length; tagList.push({ name: name === 'Layer0' ? 'Untagged' : name, hidden: !!scene.layerHidden?.[name] }); tagIdx.set(name, i); }
    return i;
  };
  const partIdx = new Map<string, number>(), partList: { name: string; hidden: boolean; n: number }[] = [];
  const partOf = (name: string) => {
    let i = partIdx.get(name);
    if (i === undefined) { i = partList.length; partList.push({ name, hidden: false, n: 0 }); partIdx.set(name, i); }
    partList[i].n++;
    return i;
  };

  // walk the placement tree, composing parent → child matrices
  const resIdx = new Map<string, number>();
  scene.meshResources.forEach((r, i) => resIdx.set(r.id, i));
  const mats: number[][] = scene.meshResources.map(() => []);
  const byTag: number[][] = scene.meshResources.map(() => []), byPart: number[][] = scene.meshResources.map(() => []);
  let placements = 0;
  const rootNode = scene.sceneHierarchy;
  const stack: [any, Float64Array, number][] = [[rootNode, Float64Array.from(rootNode.matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), -1]];
  while (stack.length) {
    const [n, m, top] = stack.pop()!;
    if (n.meshResourceId !== undefined) {
      const r = resIdx.get(n.meshResourceId);
      if (r !== undefined) {
        for (let k = 0; k < 16; k++) mats[r].push(m[k]);
        byTag[r].push(tagOf(n.layer || 'Layer0'));
        byPart[r].push(top >= 0 ? (partList[top].n++, top) : partOf('Loose geometry'));
        placements++;
      }
    }
    for (const c of n.children) {
      // a top-level child names the part everything below it belongs to
      const t = n === rootNode ? partOf((c.nameIsGenerated ? '' : c.name) || c.definitionName || 'Component') : top;
      if (n === rootNode) partList[t].n--; // counted again per placement below
      stack.push([c, mul(m, c.matrix), t]);
    }
  }
  const useTags = tagList.length > 1;
  const tags = useTags ? tagList : partList.map((p) => ({ name: p.n > 1 ? `${p.name} (×${p.n})` : p.name, hidden: false }));
  const tg = useTags ? byTag : byPart;
  const instances = mats.map((m, i) => ({ matrices: Float32Array.from(m), tags: Uint16Array.from(tg[i]) }));

  // unique geometry + BVH (built here, off the UI thread)
  const prims: SkpPrim[] = [];
  let tris = 0, placedTris = 0;
  scene.meshResources.forEach((r, ri) => {
    for (const p of r.primitives) {
      if (!p.indices.length) continue;
      const positions = p.positions.slice(), normals = p.normals.slice(), indices = p.indices.slice();
      const uvs = p.uvs?.length ? p.uvs.slice() : undefined;
      const prim: SkpPrim = { res: ri, material: p.materialIndex, positions, normals, uvs, indices };
      try {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        g.setIndex(new THREE.BufferAttribute(indices, 1));
        const s = MeshBVH.serialize(new MeshBVH(g, { maxLeafTris: 10 }), { cloneBuffers: false }) as any;
        prim.indices = s.index; // the BVH reorders triangles
        prim.bvh = { roots: s.roots, index: s.index, indirectBuffer: s.indirectBuffer ?? null };
      } catch { /* plain raycasting */ }
      prims.push(prim);
      tris += indices.length / 3;
      placedTris += (indices.length / 3) * instances[ri].tags.length;
    }
  });
  progress('Preparing snapping', 0.85);

  // snap points: every placement's vertices, thinned out evenly if a model is enormous
  let total = 0;
  for (const p of prims) total += (p.positions.length / 3) * instances[p.res].tags.length;
  const stride = Math.max(1, Math.ceil(total / SNAP_BUDGET));
  const pts: number[] = [], ptTags: number[] = [];
  const v = new THREE.Vector3(), M = new THREE.Matrix4();
  for (const p of prims) {
    const inst = instances[p.res];
    for (let k = 0; k < inst.tags.length; k += stride) {
      M.fromArray(inst.matrices, k * 16);
      for (let i = 0; i < p.positions.length; i += 3) {
        v.set(p.positions[i], p.positions[i + 1], p.positions[i + 2]).applyMatrix4(M);
        pts.push(v.x, v.y, v.z); ptTags.push(inst.tags[k]);
      }
    }
  }
  const grid = buildGrid(Float32Array.from(pts), Uint16Array.from(ptTags), true);

  // crease edges, baked per tag; components placed so often that this would blow the budget get none
  progress('Drawing edges', 0.93);
  const edgeParts = new Map<number, number[]>();
  let used = 0;
  for (const p of prims) {
    const inst = instances[p.res];
    if (placedTris > 3_000_000 && inst.tags.length > 1) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
    g.setIndex(new THREE.BufferAttribute(p.indices, 1));
    const e = new THREE.EdgesGeometry(g, 30).attributes.position.array as Float32Array;
    if (used + e.length * inst.tags.length > EDGE_BUDGET) continue;
    used += e.length * inst.tags.length;
    for (let k = 0; k < inst.tags.length; k++) {
      M.fromArray(inst.matrices, k * 16);
      let arr = edgeParts.get(inst.tags[k]);
      if (!arr) edgeParts.set(inst.tags[k], (arr = []));
      for (let i = 0; i < e.length; i += 3) { v.set(e[i], e[i + 1], e[i + 2]).applyMatrix4(M); arr.push(v.x, v.y, v.z); }
    }
  }
  const edges = [...edgeParts].map(([tag, a]) => ({ tag, data: Float32Array.from(a) }));

  const materials: SkpMaterial[] = (scene.gltfMaterials as any[]).map((m) => {
    const pbr = m?.pbrMetallicRoughness ?? {};
    const c = pbr.baseColorFactor ?? [0.8, 0.8, 0.8, 1];
    return { color: [c[0], c[1], c[2], c[3] ?? 1], texture: pbr.baseColorTexture?.index ?? -1, name: m?.name ?? '' };
  });
  const textures = scene.textures.map((t) => ({ data: t.data.slice(), mime: t.mimeType }));
  return { prims, instances, materials, textures, tags, groupKind: useTags ? 'tags' : 'parts', edges, grid, tris, placedTris, placements };
}
