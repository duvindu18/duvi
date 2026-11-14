import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import type { Drawing } from '../cad/dxf';
import { buildGrid, type SnapGrid } from '../cad/snapgrid';
import type { MeshOut } from '../worker';
import type { SkpModel } from '../cad/skp';
import { buildText } from './text';

export const WORKER_MESH = ['stl', 'obj', 'ply'];
export const MAIN_MESH = ['glb', 'gltf', 'dae', '3mf'];
export const MODEL_EXT = [...WORKER_MESH, ...MAIN_MESH];

// ---------------- 2D drawings ----------------
export interface LodItem { geom: THREE.BufferGeometry; len: Float32Array; text?: boolean }
export interface Scene2D { root: THREE.Group; layers: THREE.Group[]; fgMaterials: THREE.LineBasicMaterial[]; materials: THREE.LineBasicMaterial[]; bounds: THREE.Box3; lod: LodItem[] }

export function build2D(d: Drawing, fg: number, maxTex: number): Scene2D {
  const root = new THREE.Group();
  const layers = d.layers.map((l) => { const g = new THREE.Group(); g.name = l.name; g.visible = l.visible; root.add(g); return g; });
  const mats = new Map<number, THREE.LineBasicMaterial>();
  const fgMaterials: THREE.LineBasicMaterial[] = [];
  const matFor = (color: number) => {
    let mat = mats.get(color);
    if (!mat) {
      mat = new THREE.LineBasicMaterial({ color: color < 0 ? fg : color });
      mat.userData.orig = color;
      if (color < 0) fgMaterials.push(mat);
      mats.set(color, mat);
    }
    return mat;
  };
  const lod: LodItem[] = [];
  const add = (layer: number, color: number, data: Float32Array, len?: Float32Array, bounds?: number[]) => {
    if (!data.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(data, 3));
    if (bounds) {
      g.boundingBox = new THREE.Box3(new THREE.Vector3(bounds[0], bounds[1], bounds[2]), new THREE.Vector3(bounds[3], bounds[4], bounds[5]));
      g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    } else g.computeBoundingSphere();
    if (len) lod.push({ geom: g, len });
    layers[layer].add(new THREE.LineSegments(g, matFor(color)));
  };
  if (d.tiles) for (const t of d.tiles) add(t.layer, t.color, t.data, t.len, t.bounds);
  else for (const b of d.buckets) for (const chunk of b.chunks) add(b.layer, b.color, chunk);
  for (const t of buildText(d.text, maxTex)) { layers[t.layer]?.add(t.mesh); lod.push({ geom: t.mesh.geometry, len: t.heights, text: true }); }
  const [x0, y0, z0, x1, y1, z1] = d.bounds;
  return { root, layers, fgMaterials, materials: [...mats.values()], lod, bounds: new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1)) };
}

// ---------------- 3D models ----------------
/** Something the Parts/Tags panel can switch on and off. */
export interface Part { name: string; visible: boolean }
export interface Scene3D { root: THREE.Group; parts: Part[]; grid: SnapGrid; tris: number; kind?: 'tags' | 'parts'; note?: string; bounds?: THREE.Box3; /** per-frame level of detail */ update?: (cam: THREE.PerspectiveCamera, heightPx: number) => void }

const edgeMat = () => new THREE.LineBasicMaterial({ color: 0x1b1e24, transparent: true, opacity: 0.8 });
const surfaceMat = (color: number, vertexColors: boolean, opacity = 1) =>
  new THREE.MeshStandardMaterial({ color, vertexColors, roughness: 0.75, metalness: 0, side: THREE.DoubleSide, flatShading: true, transparent: opacity < 1, opacity });

/** Meshes parsed in the worker → scene, re-attaching the BVH built there. */
export function buildMeshes(meshes: MeshOut[], grid: SnapGrid, tris: number): Scene3D {
  const root = new THREE.Group();
  const parts: Part[] = [];
  const em = edgeMat();
  for (const m of meshes) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
    if (m.normal) g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
    if (m.color) g.setAttribute('color', new THREE.BufferAttribute(m.color, 3));
    if (m.uv) g.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
    if (m.index) g.setIndex(new THREE.BufferAttribute(m.index, 1));
    for (const gr of m.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
    if (m.bvh) (g as any).boundsTree = MeshBVH.deserialize({ roots: m.bvh.roots, index: m.bvh.index, indirectBuffer: m.bvh.indirectBuffer } as any, g, { setIndex: true });
    g.computeBoundingSphere();
    g.computeBoundingBox();
    const mats = m.materials.map((x) => {
      const mt = surfaceMat(x.vertexColors ? 0xffffff : x.color, x.vertexColors, x.opacity);
      if (m.normal) mt.flatShading = false;
      return mt;
    });
    const mesh = new THREE.Mesh(g, mats.length === 1 ? mats[0] : mats);
    mesh.name = m.name || `Part ${parts.length + 1}`;
    if (m.edges) {
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', new THREE.BufferAttribute(m.edges, 3));
      const e = new THREE.LineSegments(eg, em);
      e.raycast = () => {};
      mesh.add(e);
    }
    root.add(mesh);
    parts.push(mesh);
  }
  return { root, parts, grid, tris };
}

let gltf: GLTFLoader | null = null;
function gltfLoader(renderer: THREE.WebGLRenderer) {
  if (gltf) return gltf;
  const base = new URL('decoders/', document.baseURI).href;
  gltf = new GLTFLoader()
    .setDRACOLoader(new DRACOLoader().setDecoderPath(`${base}draco/`).setDecoderConfig({ type: 'wasm' }))
    .setKTX2Loader(new KTX2Loader().setTranscoderPath(`${base}basis/`).detectSupport(renderer))
    .setMeshoptDecoder(MeshoptDecoder);
  return gltf;
}

/** glTF / Collada / 3MF need the DOM (images, XML), so they parse here; then we optimise for touch. */
export async function loadMainThread(ext: string, buf: ArrayBuffer, renderer: THREE.WebGLRenderer, progress: (stage: string, f: number) => void): Promise<Scene3D> {
  progress('Reading model', 0.2);
  let obj: THREE.Object3D;
  if (ext === 'glb' || ext === 'gltf') {
    try { obj = (await gltfLoader(renderer).parseAsync(ext === 'gltf' ? new TextDecoder().decode(buf) : buf, '')).scene; }
    catch (e: any) { throw new Error(ext === 'gltf' && /fetch|load|URL/i.test(String(e?.message)) ? 'This .gltf refers to separate files. Export it as a single .glb instead.' : e?.message ?? String(e)); }
  } else if (ext === 'dae') {
    const r = new ColladaLoader().parse(new TextDecoder().decode(buf), '');
    if (!r) throw new Error('Could not read the .dae file');
    obj = r.scene;
  } else obj = new ThreeMFLoader().parse(buf);
  await frame();
  progress('Optimising for touch', 0.5);

  // parts = children of the first node that actually branches (SketchUp wraps everything in a few single-child nodes)
  let partsRoot = obj;
  while (partsRoot.children.length === 1 && !(partsRoot.children[0] as any).isMesh) partsRoot = partsRoot.children[0];
  obj.updateMatrixWorld(true);
  const root = new THREE.Group();
  const parts: Part[] = [];
  const topLevel = partsRoot.children.length ? partsRoot.children : [partsRoot];
  let tris = 0;
  for (const top of topLevel) {
    const merged = mergePart(top);
    if (!merged.children.length) continue;
    merged.name = prettyName(top.name) || `Part ${parts.length + 1}`;
    root.add(merged);
    parts.push(merged);
    merged.traverse((o: any) => { if (o.isMesh) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
  }
  await frame();
  progress('Preparing snapping', 0.8);
  root.updateMatrixWorld(true);
  let n = 0;
  root.traverse((o: any) => { if (o.isMesh) n += o.geometry.attributes.position.count; });
  const pts = new Float32Array(n * 3), tags = new Uint16Array(n);
  let off = 0;
  const v = new THREE.Vector3();
  parts.forEach((p, pi) => (p as THREE.Object3D).traverse((o: any) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); pts[off * 3] = v.x; pts[off * 3 + 1] = v.y; pts[off * 3 + 2] = v.z; tags[off++] = pi; }
  }));
  const grid = buildGrid(pts, tags, true);
  if (tris < 400_000) addEdgesProgressively(root);
  return { root, parts, grid, tris };
}

const frame = () => new Promise((r) => setTimeout(r, 0));

/**
 * Bake transforms and merge all meshes of one part by material: SketchUp exports often have
 * thousands of tiny meshes, and one draw call per material is far smoother on phones.
 */
function mergePart(top: THREE.Object3D): THREE.Group {
  const groups = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[] }>();
  const out = new THREE.Group();
  top.updateMatrixWorld(true);
  top.traverse((o: any) => {
    if (!o.isMesh || o.isSkinnedMesh) return;
    const mats: THREE.Material[] = Array.isArray(o.material) ? o.material : [o.material];
    const src: THREE.BufferGeometry = o.geometry;
    // split multi-material meshes by group
    const pieces: [THREE.BufferGeometry, THREE.Material][] = [];
    if (Array.isArray(o.material) && src.groups.length) {
      for (const gr of src.groups) {
        const idx = src.index ? src.index.array.slice(gr.start, gr.start + gr.count) : null;
        const g = src.clone();
        g.clearGroups();
        if (idx) g.setIndex(new THREE.BufferAttribute(idx, 1));
        else g.setDrawRange(gr.start, gr.count);
        pieces.push([g, mats[gr.materialIndex ?? 0]]);
      }
    } else pieces.push([src.clone(), mats[0]]);
    for (const [g0, mat] of pieces) {
      let g = g0;
      if (!g.index && g.drawRange.count !== Infinity) { g = g.toNonIndexed(); }
      g.applyMatrix4(o.matrixWorld);
      for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(name)) g.deleteAttribute(name);
      if (!g.attributes.normal) g.computeVertexNormals();
      const key = mat.uuid;
      let e = groups.get(key);
      if (!e) groups.set(key, (e = { mat, geos: [] }));
      e.geos.push(g);
    }
  });
  for (const { mat, geos } of groups.values()) {
    // mergeGeometries needs identical attribute sets and all-indexed or none
    const names = ['position', 'normal', 'uv', 'color'].filter((n) => geos.every((g) => g.attributes[n]));
    const indexed = geos.every((g) => g.index);
    const ready = geos.map((g) => {
      let x = indexed ? g : g.index ? g.toNonIndexed() : g;
      for (const n of Object.keys(x.attributes)) if (!names.includes(n)) x.deleteAttribute(n);
      return x;
    });
    let geo: THREE.BufferGeometry | null = null;
    try { geo = ready.length === 1 ? ready[0] : mergeGeometries(ready, false); } catch { geo = null; }
    const m = mat as THREE.MeshStandardMaterial;
    m.side = THREE.DoubleSide;
    if (geo) out.add(new THREE.Mesh(geo, m));
    else for (const g of ready) out.add(new THREE.Mesh(g, m));
  }
  return out;
}

/** Crease edges like SketchUp, computed a few meshes at a time after the model is already visible. */
function addEdgesProgressively(root: THREE.Object3D) {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o: any) => { if (o.isMesh) meshes.push(o); });
  const em = edgeMat();
  const step = () => {
    const t0 = performance.now();
    while (meshes.length && performance.now() - t0 < 10) {
      const m = meshes.pop()!;
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 30), em);
      e.raycast = () => {};
      m.add(e);
    }
    root.dispatchEvent({ type: 'edges' } as any);
    if (meshes.length) setTimeout(step, 16);
  };
  setTimeout(step, 30);
}

/** "Door_900_2" → "Door 900 (3)", "ROOT_MODEL" → "Model" (glTF exporters mangle names). */
function prettyName(n: string): string {
  if (!n) return '';
  let s = n.replace(/^ROOT_MODEL/, 'Model');
  const m = s.match(/^(.*?)_(\d+)$/);
  let suffix = '';
  if (m && m[1] && +m[2] < 100) { s = m[1]; suffix = ` (${+m[2] + 1})`; } // exporter de-dup suffix, not part of the name
  return s.replace(/_/g, ' ').trim() + suffix;
}

// ---------------- SketchUp (instanced, with level of detail) ----------------
const DETAIL_PX = 20; // a placement smaller than this on screen is drawn as a box in its main colour
const CULL_PX = 0.8; // smaller than this: not drawn at all

interface ResLod {
  meshes: THREE.InstancedMesh[]; // one per material primitive, all sharing `attr`
  attr: THREE.InstancedBufferAttribute;
  proxy: THREE.InstancedMesh | null;
  orig: Float32Array; tags: Uint16Array;
  centers: Float32Array; radii: Float32Array;
}

/**
 * One InstancedMesh per unique component primitive: geometry once, a matrix per placement.
 * Every frame, placements are sorted into: off-screen/sub-pixel (skipped), far (box proxy) and
 * near (full detail), so a model with thousands of detailed components stays fluid.
 */
export function buildSkp(m: SkpModel): Scene3D {
  const root = new THREE.Group();
  const textures = m.textures.map((t) => {
    const tex = new THREE.Texture();
    const url = URL.createObjectURL(new Blob([t.data], { type: t.mime }));
    const img = new Image();
    img.onload = () => { tex.image = img; tex.needsUpdate = true; URL.revokeObjectURL(url); root.dispatchEvent({ type: 'edges' } as any); };
    img.src = url;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  });
  const mats = m.materials.map((x) => new THREE.MeshStandardMaterial({
    color: new THREE.Color().setRGB(x.color[0], x.color[1], x.color[2], THREE.SRGBColorSpace),
    opacity: x.color[3], transparent: x.color[3] < 1, side: THREE.DoubleSide, roughness: 0.8, metalness: 0,
    map: x.texture >= 0 ? textures[x.texture] ?? null : null,
  }));
  const fallback = new THREE.MeshStandardMaterial({ color: 0xc8ccd2, side: THREE.DoubleSide, roughness: 0.8 });
  const hidden = new Uint8Array(m.tags.length);
  m.tags.forEach((t, i) => (hidden[i] = t.hidden ? 1 : 0));

  const res: ResLod[] = [];
  const box = new THREE.Box3(), v = new THREE.Vector3(), M = new THREE.Matrix4(), sph = new THREE.Sphere();
  m.instances.forEach((inst, ri) => {
    const n = inst.tags.length;
    const prims = m.prims.filter((p) => p.res === ri);
    if (!n || !prims.length) return;
    // local bounds of the component
    box.makeEmpty();
    for (const p of prims) for (let i = 0; i < p.positions.length; i += 3) box.expandByPoint(v.set(p.positions[i], p.positions[i + 1], p.positions[i + 2]));
    box.getBoundingSphere(sph);
    const centers = new Float32Array(n * 3), radii = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      M.fromArray(inst.matrices, k * 16);
      v.copy(sph.center).applyMatrix4(M);
      centers[k * 3] = v.x; centers[k * 3 + 1] = v.y; centers[k * 3 + 2] = v.z;
      radii[k] = sph.radius * M.getMaxScaleOnAxis();
    }
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(n * 16), 16);
    attr.setUsage(THREE.DynamicDrawUsage);
    const meshes: THREE.InstancedMesh[] = [];
    let mainMat: THREE.Material = fallback, mainTris = -1;
    for (const p of prims) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(p.normals, 3));
      if (p.uvs) g.setAttribute('uv', new THREE.BufferAttribute(p.uvs, 2));
      if (p.bvh) (g as any).boundsTree = MeshBVH.deserialize({ roots: p.bvh.roots, index: p.bvh.index, indirectBuffer: p.bvh.indirectBuffer } as any, g, { setIndex: true });
      else g.setIndex(new THREE.BufferAttribute(p.indices, 1));
      g.computeBoundingBox(); g.computeBoundingSphere();
      const mat = mats[p.material] ?? fallback;
      const mesh = new THREE.InstancedMesh(g, mat, n);
      mesh.instanceMatrix = attr;
      mesh.frustumCulled = false; // culling is done per placement below
      meshes.push(mesh);
      root.add(mesh);
      const t = p.indices.length / 3;
      if (t > mainTris) { mainTris = t; mainMat = mat; }
    }
    // box proxy for components worth simplifying
    let proxy: THREE.InstancedMesh | null = null;
    const tris = prims.reduce((s2, p) => s2 + p.indices.length / 3, 0);
    if (n > 1 && tris > 48) {
      const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
      const bg = new THREE.BoxGeometry(Math.max(size.x, 1e-4), Math.max(size.y, 1e-4), Math.max(size.z, 1e-4)).translate(c.x, c.y, c.z);
      proxy = new THREE.InstancedMesh(bg, mainMat, n);
      proxy.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(n * 16), 16);
      proxy.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      proxy.frustumCulled = false;
      proxy.raycast = () => {};
      proxy.userData.noSnap = true;
      root.add(proxy);
    }
    res.push({ meshes, attr, proxy, orig: inst.matrices, tags: inst.tags, centers, radii });
  });

  const em = edgeMat();
  const edgeObjs: THREE.LineSegments[][] = m.tags.map(() => []);
  for (const e of m.edges) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(e.data, 3));
    g.computeBoundingSphere();
    const l = new THREE.LineSegments(g, em);
    l.raycast = () => {};
    l.visible = !hidden[e.tag];
    edgeObjs[e.tag].push(l);
    root.add(l);
  }

  // per-frame placement sorting
  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4(), camPos = new THREE.Vector3(), cw = new THREE.Vector3();
  const update = (cam: THREE.PerspectiveCamera, heightPx: number) => {
    root.updateMatrixWorld();
    const rw = root.matrixWorld; // "stand up" rotates the root
    pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).multiply(rw);
    frustum.setFromProjectionMatrix(pv);
    camPos.setFromMatrixPosition(cam.matrixWorld).applyMatrix4(new THREE.Matrix4().copy(rw).invert());
    const k = heightPx / (2 * Math.tan((cam.fov * Math.PI) / 360));
    for (const r of res) {
      const det = r.attr.array as Float32Array, prx = r.proxy ? (r.proxy.instanceMatrix.array as Float32Array) : null;
      let nd = 0, np = 0;
      for (let i = 0; i < r.tags.length; i++) {
        if (hidden[r.tags[i]]) continue;
        cw.set(r.centers[i * 3], r.centers[i * 3 + 1], r.centers[i * 3 + 2]);
        sph.center.copy(cw); sph.radius = r.radii[i];
        if (!frustum.intersectsSphere(sph)) continue;
        const px = (r.radii[i] / Math.max(cw.distanceTo(camPos), 1e-6)) * k;
        if (px < CULL_PX) continue;
        const src = r.orig.subarray(i * 16, i * 16 + 16);
        if (prx && px < DETAIL_PX) prx.set(src, (np++) * 16); else det.set(src, (nd++) * 16);
      }
      for (const mesh of r.meshes) mesh.count = nd;
      r.attr.needsUpdate = true;
      r.attr.clearUpdateRanges(); r.attr.addUpdateRange(0, nd * 16);
      if (r.proxy) { r.proxy.count = np; r.proxy.instanceMatrix.needsUpdate = true; r.proxy.instanceMatrix.clearUpdateRanges(); r.proxy.instanceMatrix.addUpdateRange(0, np * 16); }
    }
  };
  // whole-model bounds straight from the placements (Box3.setFromObject can't see instances):
  // each placement's local box corners, transformed
  const bounds = new THREE.Box3();
  m.instances.forEach((inst, ri) => {
    const prims = m.prims.filter((p) => p.res === ri);
    if (!prims.length) return;
    const lb = new THREE.Box3();
    for (const p of prims) lb.union(new THREE.Box3().setFromArray(p.positions));
    const tb = new THREE.Box3();
    for (let k = 0; k < inst.tags.length; k++) { M.fromArray(inst.matrices, k * 16); tb.copy(lb).applyMatrix4(M); bounds.union(tb); }
  });
  for (const e of m.edges) bounds.union(new THREE.Box3().setFromArray(e.data));
  const all = bounds.getBoundingSphere(new THREE.Sphere());
  // before the first frame: everything at full detail, so raycasting works immediately.
  // Fixed bounding volumes: the per-frame compaction changes which instances sit where.
  for (const r of res) {
    (r.attr.array as Float32Array).set(r.orig);
    for (const mesh of r.meshes) { mesh.count = r.tags.length; mesh.boundingSphere = all.clone(); mesh.boundingBox = bounds.clone(); }
    if (r.proxy) { r.proxy.count = 0; r.proxy.boundingSphere = all.clone(); r.proxy.boundingBox = bounds.clone(); }
  }

  const parts: Part[] = m.tags.map((t, ti) => ({
    name: t.name,
    get visible() { return !hidden[ti]; },
    set visible(on: boolean) { hidden[ti] = on ? 0 : 1; for (const l of edgeObjs[ti]) l.visible = on; },
  }));
  const note = `${m.placements.toLocaleString()} placements of ${res.length.toLocaleString()} unique components (${Math.round(m.tris).toLocaleString()} unique triangles, ${Math.round(m.placedTris).toLocaleString()} as placed)`;
  return { root, parts, grid: m.grid, tris: m.placedTris, kind: m.groupKind, note, update, bounds };
}
