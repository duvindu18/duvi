// High-resolution export of a drawing area to PNG or PDF, rendered off-screen in tiles so it isn't
// limited by the phone's screen or maximum texture size.
import * as THREE from 'three';
import type { Viewer } from './render/viewer';
import { textUniforms } from './render/text';
import { visibleCount } from './cad/tiles';

export interface Rect { x0: number; y0: number; x1: number; y1: number }
export const PAPER: Record<string, [number, number]> = { A4: [210, 297], A3: [297, 420], A2: [420, 594], A1: [594, 841] };
const MAX_PIXELS = 16_000_000; // iOS canvases fail above ~16.7 MP
const MAX_SIDE = 8192;

/** Fit a pixel size to the limits, keeping the aspect ratio. */
export function fitPixels(w: number, h: number): [number, number] {
  let k = Math.min(1, MAX_SIDE / Math.max(w, h));
  if (w * h * k * k > MAX_PIXELS) k = Math.sqrt(MAX_PIXELS / (w * h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

/**
 * Render a world rectangle (2D) or the current 3D view to a canvas of W×H pixels.
 * `labels` draws notes/measurements on top in export pixel coordinates.
 */
export function renderRegion(v: Viewer, rect: Rect | null, W: number, H: number, labels?: (ctx: CanvasRenderingContext2D, toPx: (p: THREE.Vector3) => [number, number] | null, k: number) => void): HTMLCanvasElement {
  const r = v.renderer;
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const ctx = out.getContext('2d')!;
  let cam: THREE.OrthographicCamera | THREE.PerspectiveCamera;
  let ppu: number;
  if (rect) {
    const o = new THREE.OrthographicCamera(rect.x0, rect.x1, rect.y1, rect.y0, -1e7, 2e7);
    o.position.set(0, 0, 1e5); o.up.set(0, 1, 0); o.lookAt(0, 0, 0); o.updateMatrixWorld();
    cam = o; ppu = W / (rect.x1 - rect.x0);
  } else {
    const p = (v.cam3 as THREE.PerspectiveCamera).clone();
    p.aspect = W / H; p.updateProjectionMatrix();
    cam = p; ppu = v.pixelsPerUnit() * (H / (v.renderer.domElement.clientHeight || H));
  }
  // level of detail for the export resolution (more detail than on screen)
  const savedPPU = textUniforms.uPPU.value;
  textUniforms.uPPU.value = ppu;
  if (rect) for (const t of v.lod) {
    if (t.text) (t.geom as THREE.InstancedBufferGeometry).instanceCount = visibleCount(t.len, (textUniforms.uMinPx.value / ppu) * 0.999);
    else t.geom.setDrawRange(0, visibleCount(t.len, 0.5 / ppu) * 2);
  }
  const TILE = Math.min(2048, r.capabilities.maxTextureSize);
  const rt = new THREE.WebGLRenderTarget(TILE, TILE, { samples: 4 });
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  const prevRatio = r.getPixelRatio();
  for (let ty = 0; ty < H; ty += TILE) {
    for (let tx = 0; tx < W; tx += TILE) {
      const tw = Math.min(TILE, W - tx), th = Math.min(TILE, H - ty);
      cam.setViewOffset(W, H, tx, ty, tw, th);
      cam.updateProjectionMatrix();
      rt.setSize(tw, th);
      r.setRenderTarget(rt);
      r.render(v.scene, cam);
      const buf = new Uint8Array(tw * th * 4);
      r.readRenderTargetPixels(rt, 0, 0, tw, th, buf);
      const img = ctx.createImageData(tw, th);
      for (let row = 0; row < th; row++) img.data.set(buf.subarray((th - 1 - row) * tw * 4, (th - row) * tw * 4), row * tw * 4); // WebGL rows are bottom-up
      ctx.putImageData(img, tx, ty);
    }
  }
  r.setRenderTarget(null);
  r.setPixelRatio(prevRatio);
  rt.dispose();
  textUniforms.uPPU.value = savedPPU;
  cam.clearViewOffset();
  if (labels) {
    const toPx = (p: THREE.Vector3): [number, number] | null => {
      const q = p.clone().project(cam);
      if (q.z < -1 || q.z > 1) return null;
      return [((q.x + 1) / 2) * W, ((1 - q.y) / 2) * H];
    };
    labels(ctx, toPx, Math.max(1, Math.min(W, H) / 900));
  }
  v.requestRender(); // restore on-screen detail
  return out;
}

/** Put an image on a PDF page (with margins and a one-line footer). Returns the PDF and the image width on paper (mm). */
export async function toPdf(img: HTMLCanvasElement, paper: string, footer: (imgWidthMm: number) => string): Promise<{ blob: Blob; imgWidthMm: number }> {
  const { jsPDF } = await import('jspdf');
  const [pw, ph] = PAPER[paper] ?? PAPER.A4;
  const landscape = img.width >= img.height;
  const W = landscape ? ph : pw, H = landscape ? pw : ph;
  const m = 10, foot = 8;
  const aw = W - 2 * m, ah = H - 2 * m - foot;
  const k = Math.min(aw / img.width, ah / img.height);
  const iw = img.width * k, ih = img.height * k;
  const doc = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'mm', format: [pw, ph], compress: true });
  doc.addImage(img.toDataURL('image/png'), 'PNG', m + (aw - iw) / 2, m + (ah - ih) / 2, iw, ih, undefined, 'FAST');
  doc.setDrawColor(200); doc.setLineWidth(0.2); doc.line(m, H - m - foot + 2, W - m, H - m - foot + 2);
  doc.setFontSize(8); doc.setTextColor(60);
  doc.text(footer(iw), m, H - m - 1.5);
  return { blob: doc.output('blob'), imgWidthMm: iw };
}
