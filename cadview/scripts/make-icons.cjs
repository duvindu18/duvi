// Renders Android launcher icons + splash screens from public/icon.svg (uses the bundled Playwright Chromium).
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const svg = fs.readFileSync(path.join(__dirname, '../public/icon.svg'), 'utf8');
const glyph = svg.replace(/<rect width="512"[^>]*\/>/, '').replace(/<rect x="40"[^>]*\/>/, ''); // foreground only
const res = path.join(__dirname, '../android/app/src/main/res');
const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const shot = async (html, w, h, file) => {
    await p.setViewportSize({ width: w, height: h });
    await p.setContent(`<html><body style="margin:0;background:transparent">${html}</body></html>`);
    await p.screenshot({ path: file, omitBackground: true });
  };
  const img = (s, size, extra = '') => `<div style="width:${size}px;height:${size}px;${extra}">${s.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div>`;
  for (const [d, k] of Object.entries(dens)) {
    const L = Math.round(48 * k), F = Math.round(108 * k);
    await shot(img(svg, L), L, L, `${res}/mipmap-${d}/ic_launcher.png`);
    await shot(img(svg, L, 'border-radius:50%;overflow:hidden'), L, L, `${res}/mipmap-${d}/ic_launcher_round.png`);
    // adaptive foreground: glyph inside the 66% safe zone of a 108dp canvas
    const g = Math.round(F * 0.62);
    await shot(`<div style="width:${F}px;height:${F}px;display:grid;place-items:center">${img(glyph, g)}</div>`, F, F, `${res}/mipmap-${d}/ic_launcher_foreground.png`);
  }
  const splash = async (w, h, file) => shot(`<div style="width:${w}px;height:${h}px;background:#0b0d12;display:grid;place-items:center">${img(svg, Math.round(Math.min(w, h) * 0.28))}</div>`, w, h, file);
  for (const f of fs.readdirSync(res).filter((x) => x.startsWith('drawable'))) {
    const file = `${res}/${f}/splash.png`;
    if (!fs.existsSync(file)) continue;
    const { width, height } = await (async () => { const buf = fs.readFileSync(file); return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }; })();
    await splash(width, height, file);
  }
  await b.close();
  console.log('icons and splash screens written');
})();
