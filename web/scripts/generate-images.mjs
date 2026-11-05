// Generates the placeholder architectural photography in /public/images.
// Dev-only utility: renders procedural "architectural" compositions on a
// canvas inside headless Chromium (Playwright) and writes JPEGs.
//
//   node scripts/generate-images.mjs
//
// Replace the output with real project photography whenever it is ready —
// keep the file names (or update lib/projects.ts) and everything else follows.
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Works with a local or globally installed playwright.
const { chromium } = createRequire(import.meta.url)("playwright");

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "images");
mkdirSync(OUT, { recursive: true });

// [file, kind, width, height, palette, seed]
const P = {
  concrete: ["#d9d6d0", "#b9b5ae", "#8f8b84", "#4a4744", "#1d1c1b"],
  timber: ["#ead9c3", "#c9a885", "#a07c5a", "#6b4f37", "#2e2219"],
  stone: ["#e6e3dc", "#cfcac0", "#a9a296", "#6f695f", "#2a2723"],
  clay: ["#ecdcd0", "#d0ad97", "#a8806a", "#6e4c3c", "#2c1f19"],
  slate: ["#dfe1e1", "#b8bcbd", "#8d9394", "#4c5253", "#1b1e1f"],
  ink: ["#cfccc6", "#8e8a84", "#55524e", "#2a2826", "#0e0d0c"],
};

const jobs = [
  ["monolith-1.jpg", "slit", 1600, 2000, P.concrete, 11],
  ["monolith-2.jpg", "shaft", 1600, 2000, P.concrete, 12],
  ["monolith-3.jpg", "landscape", 2000, 1334, P.ink, 13],
  ["timber-1.jpg", "corridor", 1600, 2000, P.timber, 21],
  ["timber-2.jpg", "interior", 2000, 1334, P.timber, 22],
  ["timber-3.jpg", "fins", 1600, 2000, P.timber, 23],
  ["clay-1.jpg", "interior", 1600, 2000, P.clay, 31],
  ["clay-2.jpg", "landscape", 2000, 1334, P.clay, 32],
  ["clay-3.jpg", "slit", 1600, 2000, P.clay, 33],
  ["basalt-1.jpg", "fins", 1600, 2000, P.slate, 41],
  ["basalt-2.jpg", "corridor", 1600, 2000, P.slate, 42],
  ["basalt-3.jpg", "landscape", 2000, 1334, P.slate, 43],
  ["chapel-1.jpg", "shaft", 1600, 2000, P.stone, 51],
  ["chapel-2.jpg", "slit", 2000, 1334, P.stone, 52],
  ["chapel-3.jpg", "interior", 1600, 2000, P.stone, 53],
  ["courtyard-1.jpg", "landscape", 1600, 2000, P.stone, 61],
  ["courtyard-2.jpg", "fins", 2000, 1334, P.concrete, 62],
  ["courtyard-3.jpg", "corridor", 1600, 2000, P.stone, 63],
  ["studio-1.jpg", "interior", 1600, 2000, P.ink, 71],
  ["studio-2.jpg", "shaft", 2000, 1334, P.ink, 72],
];

function renderInPage({ kind, w, h, pal, seed }) {
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  const [l0, l1, m, d1, d0] = pal;
  const lin = (x0, y0, x1, y1, stops) => {
    const gr = g.createLinearGradient(x0, y0, x1, y1);
    stops.forEach(([o, col]) => gr.addColorStop(o, col));
    return gr;
  };
  const poly = (pts, fill) => {
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  };
  const glow = (x, y, r, col, a) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, col);
    gr.addColorStop(1, "rgba(0,0,0,0)");
    g.globalAlpha = a;
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
    g.globalAlpha = 1;
  };
  const boards = (x, y, bw, bh, step, alpha) => {
    g.save();
    g.beginPath();
    g.rect(x, y, bw, bh);
    g.clip();
    for (let yy = y; yy < y + bh; yy += step) {
      g.fillStyle = `rgba(0,0,0,${alpha * (0.5 + rnd())})`;
      g.fillRect(x, yy, bw, 1.5);
      g.fillStyle = `rgba(255,255,255,${alpha * 0.6})`;
      g.fillRect(x, yy + 2, bw, 1);
    }
    g.restore();
  };

  if (kind === "slit") {
    g.fillStyle = lin(0, 0, w, 0, [[0, d0], [0.45, d1], [1, d0]]);
    g.fillRect(0, 0, w, h);
    boards(0, 0, w, h * 0.78, h / 26, 0.08);
    const sx = w * (0.38 + rnd() * 0.24), sw = w * 0.035;
    glow(sx + sw / 2, h * 0.4, w * 0.5, l0, 0.22);
    g.fillStyle = lin(0, 0, 0, h, [[0, l0], [0.8, l1]]);
    g.fillRect(sx, 0, sw, h * 0.78);
    poly([[0, h * 0.78], [w, h * 0.78], [w, h], [0, h]], lin(0, h * 0.78, 0, h, [[0, d1], [1, d0]]));
    poly([[sx, h * 0.78], [sx + sw, h * 0.78], [sx + sw * 5, h], [sx - sw * 3, h]], "rgba(255,250,240,0.18)");
  } else if (kind === "corridor") {
    const vx = w * (0.48 + rnd() * 0.04), vy = h * 0.52;
    g.fillStyle = d1;
    g.fillRect(0, 0, w, h);
    poly([[0, 0], [w, 0], [vx + w * 0.07, vy - h * 0.08], [vx - w * 0.07, vy - h * 0.08]], lin(0, 0, 0, vy, [[0, l1], [1, m]]));
    poly([[0, h], [w, h], [vx + w * 0.07, vy + h * 0.1], [vx - w * 0.07, vy + h * 0.1]], lin(0, h, 0, vy, [[0, l1], [1, l0]]));
    poly([[0, 0], [vx - w * 0.07, vy - h * 0.08], [vx - w * 0.07, vy + h * 0.1], [0, h]], lin(0, 0, vx, 0, [[0, m], [1, l1]]));
    poly([[w, 0], [vx + w * 0.07, vy - h * 0.08], [vx + w * 0.07, vy + h * 0.1], [w, h]], lin(w, 0, vx, 0, [[0, d1], [1, m]]));
    g.fillStyle = l0;
    g.fillRect(vx - w * 0.07, vy - h * 0.08, w * 0.14, h * 0.18);
    for (let i = 1; i < 16; i++) {
      const t = 1 - Math.pow(i / 16, 0.7);
      const xL = vx - w * 0.07 + (0 - (vx - w * 0.07)) * t;
      const xR = vx + w * 0.07 + (w - (vx + w * 0.07)) * t;
      const top = vy - h * 0.08 + (0 - (vy - h * 0.08)) * t;
      const bot = vy + h * 0.1 + (h - (vy + h * 0.1)) * t;
      const fw = Math.max(2, 46 * t);
      g.fillStyle = `rgba(30,20,12,${0.35 * t + 0.05})`;
      g.fillRect(xL - fw / 2, top, fw, bot - top);
      g.fillStyle = `rgba(255,248,235,${0.25 * t})`;
      g.fillRect(xR - fw / 2, top, fw * 0.5, bot - top);
      const nb = vy + h * 0.1 + (h - vy - h * 0.1) * (1 - Math.pow((i + 0.5) / 16, 0.7));
      poly([[xR, bot], [vx + w * 0.07, vy + h * 0.1], [vx + w * 0.07, vy + h * 0.1], [xR, nb]], "rgba(255,248,235,0)");
      g.fillStyle = `rgba(255,248,235,${0.16 * t})`;
      g.fillRect(vx, bot - 4 * t, xR - vx, 8 * t + 2);
    }
    g.fillStyle = d0;
    g.fillRect(vx - w * 0.009, vy - h * 0.035, w * 0.018, h * 0.12);
    g.beginPath();
    g.arc(vx, vy - h * 0.045, w * 0.008, 0, Math.PI * 2);
    g.fill();
  } else if (kind === "interior") {
    const fy = h * 0.68;
    g.fillStyle = lin(0, 0, w, 0, [[0, l1], [1, m]]);
    g.fillRect(0, 0, w, fy);
    const wx = w * (0.12 + rnd() * 0.2), ww = w * 0.46, wy = h * 0.2;
    g.fillStyle = lin(0, wy, 0, fy, [[0, "#f6f5f2"], [0.55, l0], [0.56, l1], [1, m]]);
    g.fillRect(wx, wy, ww, fy - wy);
    g.fillStyle = d1;
    g.fillRect(wx + ww * 0.62, wy, 6, fy - wy);
    g.fillStyle = lin(0, fy, 0, h, [[0, m], [1, d1]]);
    g.fillRect(0, fy, w, h - fy);
    poly([[wx, fy], [wx + ww, fy], [wx + ww * 1.5, h], [wx + ww * 0.2, h]], "rgba(255,250,240,0.22)");
    g.fillStyle = d1;
    g.fillRect(w * 0.62, fy - h * 0.06, w * 0.32, h * 0.06);
    g.fillStyle = "rgba(0,0,0,0.25)";
    g.fillRect(w * 0.62, fy, w * 0.34, h * 0.015);
    g.fillStyle = lin(0, 0, w * 0.1, 0, [[0, d0], [1, d1]]);
    g.fillRect(0, 0, w * 0.06, h);
  } else if (kind === "fins") {
    g.fillStyle = lin(0, 0, 0, h, [[0, "#f4f3f0"], [1, l0]]);
    g.fillRect(0, 0, w, h);
    const top = h * 0.12, bot = h * 0.86;
    g.fillStyle = m;
    g.fillRect(0, top, w, bot - top);
    const n = 13, gap = w / n;
    for (let i = 0; i < n + 1; i++) {
      const x = i * gap;
      g.fillStyle = lin(x, 0, x + gap * 0.5, 0, [[0, l1], [1, l0]]);
      g.fillRect(x, top - h * 0.02, gap * 0.34, bot - top + h * 0.02);
      g.fillStyle = "rgba(0,0,0,0.28)";
      poly([[x + gap * 0.34, top], [x + gap * 0.62, top], [x + gap * 0.62, bot], [x + gap * 0.34, bot]], "rgba(0,0,0,0.22)");
    }
    g.fillStyle = d0;
    g.fillRect(0, top - h * 0.03, w, h * 0.012);
    g.fillStyle = lin(0, bot, 0, h, [[0, d1], [1, m]]);
    g.fillRect(0, bot, w, h - bot);
  } else if (kind === "shaft") {
    g.fillStyle = lin(0, 0, 0, h, [[0, d1], [1, d0]]);
    g.fillRect(0, 0, w, h);
    boards(0, 0, w, h, h / 30, 0.06);
    const ox = w * (0.3 + rnd() * 0.4);
    poly([[ox - w * 0.06, 0], [ox + w * 0.06, 0], [ox + w * 0.36, h], [ox - w * 0.02, h]], "rgba(255,250,240,0.13)");
    poly([[ox - w * 0.03, 0], [ox + w * 0.03, 0], [ox + w * 0.24, h], [ox + w * 0.06, h]], "rgba(255,250,240,0.12)");
    glow(ox + w * 0.15, h * 0.92, w * 0.35, l0, 0.35);
    const steps = 9;
    for (let i = 0; i < steps; i++) {
      const y = h * 0.55 + i * h * 0.05;
      g.fillStyle = i % 2 ? d1 : m;
      g.globalAlpha = 0.55;
      g.fillRect(0, y, w * (0.22 + i * 0.05), h * 0.05);
      g.globalAlpha = 1;
      g.fillStyle = "rgba(255,255,255,0.18)";
      g.fillRect(0, y, w * (0.22 + i * 0.05), 3);
    }
  } else if (kind === "landscape") {
    const hz = h * (0.55 + rnd() * 0.08);
    g.fillStyle = lin(0, 0, 0, hz, [[0, "#c9c8c4"], [1, "#efeeea"]]);
    g.fillRect(0, 0, w, hz);
    glow(w * 0.7, hz * 0.6, w * 0.6, "#ffffff", 0.5);
    g.fillStyle = lin(0, hz, 0, h, [[0, m], [1, d1]]);
    g.fillRect(0, hz, w, h - hz);
    poly([[0, hz], [w * 0.3, hz - h * 0.05], [w * 0.55, hz - h * 0.02], [w, hz - h * 0.07], [w, hz], [0, hz]], "rgba(90,90,88,0.25)");
    const bx = w * 0.2, bw = w * 0.6, bh = h * 0.07, by = hz + h * 0.02;
    g.fillStyle = d0;
    g.fillRect(bx, by - bh, bw, bh);
    g.fillStyle = l1;
    g.fillRect(bx - w * 0.02, by - bh - h * 0.012, bw + w * 0.04, h * 0.014);
    g.fillStyle = "rgba(255,250,235,0.55)";
    g.fillRect(bx + bw * 0.1, by - bh * 0.75, bw * 0.35, bh * 0.55);
    g.fillStyle = "rgba(0,0,0,0.3)";
    g.fillRect(bx, by, bw * 1.1, h * 0.012);
  }

  // vignette + film grain
  const vg = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,0,0,0.32)");
  g.fillStyle = vg;
  g.fillRect(0, 0, w, h);
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL("image/jpeg", 0.84);
}

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, kind, w, h, pal, seed] of jobs) {
  const url = await page.evaluate(renderInPage, { kind, w, h, pal, seed });
  writeFileSync(join(OUT, file), Buffer.from(url.split(",")[1], "base64"));
  console.log("wrote", file);
}
await browser.close();
