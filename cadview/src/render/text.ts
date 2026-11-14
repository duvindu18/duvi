// CAD text as GPU-instanced glyph quads from one shared atlas: 100k+ labels cost one draw call
// per layer. Labels smaller than a few pixels are dropped in the vertex shader, which keeps a
// zoomed-out plan readable instead of a grey smear.
import * as THREE from 'three';
import type { TextSet } from '../cad/dxf';

const CELL = 64, FONT = 44, BASE = 50; // px: atlas cell, font size, baseline inside cell
const CAP = 0.72; // cap height as a fraction of the em: CAD text height ≈ cap height
const LINE = 1.667; // MTEXT default line spacing

let atlas: { tex: THREE.CanvasTexture; cols: number; cell: Map<string, number>; adv: Map<string, number>; ctx: CanvasRenderingContext2D; next: number; canvas: HTMLCanvasElement } | null = null;

function getAtlas(maxTex: number) {
  if (atlas) return atlas;
  const size = Math.min(4096, maxTex);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: false })!;
  ctx.font = `${FONT}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.userData.shared = true; // survives disposal between files
  atlas = { tex, cols: size / CELL, cell: new Map(), adv: new Map(), ctx, next: 0, canvas };
  return atlas;
}

function glyph(a: NonNullable<typeof atlas>, ch: string): number {
  let c = a.cell.get(ch);
  if (c !== undefined) return c;
  if (a.next >= a.cols * a.cols) return a.cell.get('?') ?? 0; // atlas full (huge CJK sets)
  c = a.next++;
  const x = (c % a.cols) * CELL, y = Math.floor(c / a.cols) * CELL;
  a.ctx.fillText(ch, x + 8, y + BASE);
  a.cell.set(ch, c);
  a.adv.set(ch, a.ctx.measureText(ch).width / FONT);
  a.tex.needsUpdate = true;
  return c;
}

const vert = /* glsl */ `
  precision highp float;
  attribute vec4 iA; // x, y, rotation, quad size
  attribute vec4 iB; // cell, colour, text height, z
  uniform float uPPU, uCols, uMinPx, uDarken;
  uniform vec3 uFg;
  varying vec2 vUv;
  varying vec3 vCol;
  void main() {
    if (iB.z * uPPU < uMinPx) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vec2 l = position.xy * iA.w;
    float c = cos(iA.z), s = sin(iA.z);
    vec3 wp = vec3(iA.x + l.x * c - l.y * s, iA.y + l.x * s + l.y * c, iB.w);
    float col = mod(iB.x, uCols), row = floor(iB.x / uCols);
    vUv = vec2(col + position.x, row + 1.0 - position.y) / uCols;
    if (iB.y < 0.0) vCol = uFg;
    else {
      vCol = vec3(floor(iB.y / 65536.0), mod(floor(iB.y / 256.0), 256.0), mod(iB.y, 256.0)) / 255.0;
      // same rule as line colours: pale CAD colours get darker on a light canvas
      float lum = dot(vCol, vec3(0.299, 0.587, 0.114));
      if (uDarken > 0.5 && lum > 0.42) vCol *= 0.42 / lum * 0.92;
    }
    gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
  }`;
const frag = /* glsl */ `
  precision highp float;
  uniform sampler2D uMap;
  varying vec2 vUv;
  varying vec3 vCol;
  void main() {
    float a = texture2D(uMap, vUv).a;
    if (a < 0.03) discard;
    gl_FragColor = vec4(vCol, a);
  }`;

export interface TextLayer { mesh: THREE.Mesh; layer: number; heights: Float32Array }

export const textUniforms = { uPPU: { value: 1 }, uFg: { value: new THREE.Color(0xffffff) }, uMinPx: { value: 4 }, uDarken: { value: 0 } };

/** Build one instanced mesh per layer. `colorOf(i)` may override the stored colour (revision compare). */
export function buildText(t: TextSet, maxTex: number): TextLayer[] {
  const a = getAtlas(maxTex);
  const n = t.values.length;
  if (!n) return [];
  glyph(a, '?');
  // group texts by layer and spatial tile; inside a group sort by height (largest first) so the renderer
  // can draw just the prefix of glyphs that are big enough to read, and cull off-screen tiles entirely
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) { const x = t.num[i * 5], y = t.num[i * 5 + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const T = Math.max(1, Math.min(16, Math.round(Math.sqrt(n / 3000))));
  const tw = Math.max((x1 - x0) / T, 1e-9), th = Math.max((y1 - y0) / T, 1e-9);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const tx = Math.min(T - 1, Math.floor((t.num[i * 5] - x0) / tw)), ty = Math.min(T - 1, Math.floor((t.num[i * 5 + 1] - y0) / th));
    const key = t.layer[i] * 1024 + ty * T + tx;
    let arr = groups.get(key);
    if (!arr) groups.set(key, (arr = []));
    arr.push(i);
  }
  const quad = new THREE.BufferGeometry();
  quad.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
  quad.setIndex([0, 1, 2, 0, 2, 3]);
  const mat = new THREE.ShaderMaterial({
    vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false,
    uniforms: { ...textUniforms, uMap: { value: a.tex }, uCols: { value: a.cols } },
  });
  const out: TextLayer[] = [];
  for (const [key, ids] of groups) {
    const layer = Math.floor(key / 1024);
    ids.sort((p, q) => (t.num[q * 5 + 3] || 1) - (t.num[p * 5 + 3] || 1));
    let glyphs = 0;
    for (const i of ids) glyphs += t.values[i].replace(/\s/g, '').length;
    const buf = new Float32Array(glyphs * 8);
    const heights = new Float32Array(glyphs);
    let k = 0;
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz = 0;
    for (const i of ids) {
      const v = t.values[i];
      const x = t.num[i * 5], y = t.num[i * 5 + 1], z = t.num[i * 5 + 2], h = t.num[i * 5 + 3] || 1, rot = t.num[i * 5 + 4];
      bz = z;
      const al = t.align[i], ax = al & 3, ay = (al >> 2) & 3, multi = (al & 16) !== 0;
      const em = h / CAP;
      const lines = v.split('\n');
      const c = Math.cos(rot), s = Math.sin(rot);
      const block = h + (lines.length - 1) * LINE * h;
      let y0: number; // baseline of the first line relative to the anchor
      if (multi) y0 = ay === 3 ? -h : ay === 2 ? -h + block / 2 : (lines.length - 1) * LINE * h;
      else y0 = ay === 3 ? -h : ay === 2 ? -h / 2 : ay === 1 ? 0.3 * h : 0;
      const size = (CELL / FONT) * em;
      const color = t.color[i];
      lines.forEach((line, li) => {
        let w = 0;
        for (const ch of line) { glyph(a, ch); w += (a.adv.get(ch) ?? 0.6) * em; }
        let pen = ax === 1 ? -w / 2 : ax === 2 ? -w : 0;
        const by = y0 - li * LINE * h;
        for (const ch of line) {
          const adv = (a.adv.get(ch) ?? 0.6) * em;
          if (ch.trim()) {
            // quad's bottom-left corner in text space: the glyph is drawn 8px right of the cell edge, BASE px below its top
            const lx = pen - (8 / FONT) * em, ly = by - ((CELL - BASE) / FONT) * em;
            const gx = x + lx * c - ly * s, gy = y + lx * s + ly * c;
            if (gx < bx0) bx0 = gx; if (gx > bx1) bx1 = gx; if (gy < by0) by0 = gy; if (gy > by1) by1 = gy;
            heights[k / 8] = h;
            buf[k++] = gx; buf[k++] = gy; buf[k++] = rot; buf[k++] = size;
            buf[k++] = glyph(a, ch); buf[k++] = color; buf[k++] = h; buf[k++] = z;
          }
          pen += adv;
        }
      });
    }
    if (!k) continue;
    const g = new THREE.InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute('position', quad.getAttribute('position'));
    const ib = new THREE.InstancedInterleavedBuffer(buf.subarray(0, k), 8);
    g.setAttribute('iA', new THREE.InterleavedBufferAttribute(ib, 4, 0));
    g.setAttribute('iB', new THREE.InterleavedBufferAttribute(ib, 4, 4));
    g.instanceCount = k / 8;
    const pad = heights[0] * 40; // generous: glyph quads extend beyond their corner points
    g.boundingBox = new THREE.Box3(new THREE.Vector3(bx0 - pad, by0 - pad, bz - 1), new THREE.Vector3(bx1 + pad, by1 + pad, bz + 1));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    const mesh = new THREE.Mesh(g, mat);
    mesh.renderOrder = 2;
    mesh.userData.noSnap = true;
    mesh.raycast = () => {};
    out.push({ mesh, layer, heights: heights.subarray(0, k / 8) });
  }
  a.tex.needsUpdate = true;
  return out;
}
