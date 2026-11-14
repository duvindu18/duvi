import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import type { CadDrawing, Primitive } from './cad/dxf';
import type { DiffState } from './cad/diff';

export const MAX_TEXT = 4000;

export interface TextHit { value: string; pos: THREE.Vector3; height: number }

export interface Built2D {
  root: THREE.Group;
  layerGroups: Map<string, THREE.Group>;
  texts: TextHit[];
  hiddenText: number;
  /** Materials whose colour is ACI 7 (white on dark / black on light). */
  fgMaterials: THREE.Material[];
}

/**
 * Turn primitives into GPU-friendly geometry: one merged LineSegments per (layer, colour),
 * so even 100k-entity drawings are a handful of draw calls.
 * Coordinates are re-centred on `origin` because survey-grid drawings (x≈500000) lose
 * precision in 32-bit floats and visibly jitter.
 */
export function build2D(
  prims: Primitive[],
  origin: THREE.Vector3,
  fg: number,
  colorOf?: (p: Primitive, i: number) => number | null,
): Built2D {
  const root = new THREE.Group();
  const layerGroups = new Map<string, THREE.Group>();
  const buckets = new Map<string, { layer: string; color: number; segs: number[] }>();
  const texts: TextHit[] = [];
  let hiddenText = 0;
  const fgMaterials: THREE.Material[] = [];
  const groupFor = (layer: string) => {
    let g = layerGroups.get(layer);
    if (!g) { g = new THREE.Group(); g.name = layer; layerGroups.set(layer, g); root.add(g); }
    return g;
  };

  prims.forEach((p, i) => {
    const override = colorOf?.(p, i);
    const color = override ?? p.color;
    if (p.segments.length) {
      const key = `${p.layer}\u0000${color}`;
      let b = buckets.get(key);
      if (!b) { b = { layer: p.layer, color, segs: [] }; buckets.set(key, b); }
      for (let k = 0; k < p.segments.length; k += 3)
        b.segs.push(p.segments[k] - origin.x, p.segments[k + 1] - origin.y, p.segments[k + 2] - origin.z);
    }
    if (p.text) {
      const pos = new THREE.Vector3(p.text.x - origin.x, p.text.y - origin.y, p.text.z - origin.z);
      texts.push({ value: p.text.value, pos, height: p.text.height });
      if (texts.length > MAX_TEXT) { hiddenText++; return; }
      const mesh = textMesh(p.text.value, p.text.height, color < 0 ? fg : color);
      if (color < 0) fgMaterials.push(mesh.material as THREE.Material);
      mesh.position.copy(pos);
      mesh.rotation.z = p.text.rotation;
      groupFor(p.layer).add(mesh);
    }
  });

  for (const b of buckets.values()) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.segs, 3));
    const mat = new THREE.LineBasicMaterial({ color: b.color < 0 ? fg : b.color });
    if (b.color < 0) fgMaterials.push(mat);
    groupFor(b.layer).add(new THREE.LineSegments(g, mat));
  }
  return { root, layerGroups, texts, hiddenText, fgMaterials };
}

export function drawingOrigin(d: CadDrawing): THREE.Vector3 {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const p of d.primitives) {
    for (let k = 0; k < p.segments.length; k += 3) box.expandByPoint(v.set(p.segments[k], p.segments[k + 1], p.segments[k + 2]));
    if (p.text) box.expandByPoint(v.set(p.text.x, p.text.y, p.text.z));
  }
  return box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
}

const DIFF_COLORS: Record<DiffState, number> = { same: 0x8a8f98, added: 0x22c55e, removed: 0xef4444 };
export const diffColor = (s: DiffState) => DIFF_COLORS[s];

function textMesh(value: string, height: number, color: number): THREE.Mesh {
  const lines = value.split('\n');
  const px = 48;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = `${px}px sans-serif`;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width), 1);
  c.width = Math.ceil(w) + 8;
  c.height = Math.ceil(px * 1.25 * lines.length);
  ctx.font = `${px}px sans-serif`;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  lines.forEach((l, i) => ctx.fillText(l, 4, px + i * px * 1.25));
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, color, depthWrite: false });
  const scale = height / px;
  const geo = new THREE.PlaneGeometry(c.width * scale, c.height * scale);
  // anchor at the first line's baseline-left, like CAD insertion points
  geo.translate((c.width * scale) / 2 - 4 * scale, -(c.height * scale) / 2 + px * scale, 0);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.noSnap = true;
  return mesh;
}

// ---------------- 3D formats ----------------

export const MODEL_EXT = ['glb', 'gltf', 'obj', 'stl', 'dae', 'ply', '3mf'];

export async function load3D(name: string, data: ArrayBuffer): Promise<THREE.Object3D> {
  const ext = name.split('.').pop()!.toLowerCase();
  const text = () => new TextDecoder().decode(data);
  let obj: THREE.Object3D;
  switch (ext) {
    case 'glb':
    case 'gltf':
      obj = (await new GLTFLoader().parseAsync(ext === 'gltf' ? text() : data, '')).scene;
      break;
    case 'obj':
      obj = new OBJLoader().parse(text());
      break;
    case 'dae': {
      const r = new ColladaLoader().parse(text(), '');
      if (!r) throw new Error('Could not read the .dae file');
      obj = r.scene;
      break;
    }
    case 'stl':
      obj = meshOf(new STLLoader().parse(data));
      break;
    case 'ply':
      obj = meshOf(new PLYLoader().parse(data));
      break;
    case '3mf':
      obj = new ThreeMFLoader().parse(data);
      break;
    default:
      throw new Error(`.${ext} is not supported`);
  }
  // CAD exports frequently have no normals or single-sided faces; make them viewable,
  // and draw crease edges like SketchUp does so walls and corners read clearly on a small screen.
  const meshes: THREE.Mesh[] = [];
  let tris = 0;
  obj.traverse((o: any) => {
    if (!o.isMesh) return;
    meshes.push(o);
    const g: THREE.BufferGeometry = o.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    const noNormals = !g.attributes.normal;
    if (noNormals) g.computeVertexNormals();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) if (m) { m.side = THREE.DoubleSide; if (noNormals) m.flatShading = true; m.needsUpdate = true; }
  });
  if (tris < 1_500_000) {
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x1b1e24, transparent: true, opacity: 0.85 });
    for (const m of meshes) {
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 30), edgeMat);
      e.userData.noSnap = true;
      e.raycast = () => {};
      m.add(e);
    }
  }
  return obj;
}

function meshOf(g: THREE.BufferGeometry) {
  g.computeVertexNormals();
  const hasColor = !!g.attributes.color;
  return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: hasColor ? 0xffffff : 0xb8c2cc, vertexColors: hasColor, roughness: 0.7 }));
}
