// Android launcher icons (legacy, round, adaptive foreground + monochrome) and splash screens,
// rendered from public/icon.svg and public/icon-glyph.svg with the bundled Playwright Chromium.
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const pub = path.join(__dirname, '../public');
const icon = fs.readFileSync(path.join(pub, 'icon.svg'), 'utf8');
const glyph = fs.readFileSync(path.join(pub, 'icon-glyph.svg'), 'utf8');
const mono = glyph.replace(/#ffcc00/g, '#fff'); // themed icons use only the alpha channel
const res = path.join(__dirname, '../android/app/src/main/res');
const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
// the mark fills 60% of the glyph box; at 84% it stays inside the 66dp safe circle of the 108dp adaptive canvas
const FG = 0.84;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const shot = async (html, w, h, file) => {
    await p.setViewportSize({ width: w, height: h });
    await p.setContent(`<html><body style="margin:0;background:transparent">${html}</body></html>`);
    await p.screenshot({ path: file, omitBackground: true });
  };
  const img = (s, size, extra = '') => `<div style="width:${size}px;height:${size}px;${extra}">${s.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div>`;
  const centred = (s, box, size, bg = 'transparent') => `<div style="width:${box}px;height:${box}px;display:grid;place-items:center;background:${bg}">${img(s, size)}</div>`;
  for (const [d, k] of Object.entries(dens)) {
    const L = Math.round(48 * k), F = Math.round(108 * k);
    await shot(img(icon, L), L, L, `${res}/mipmap-${d}/ic_launcher.png`);
    await shot(`<div style="width:${L}px;height:${L}px;border-radius:50%;overflow:hidden">${centred(glyph, L, L, '#000')}</div>`, L, L, `${res}/mipmap-${d}/ic_launcher_round.png`);
    await shot(centred(glyph, F, Math.round(F * FG)), F, F, `${res}/mipmap-${d}/ic_launcher_foreground.png`);
    await shot(centred(mono, F, Math.round(F * FG)), F, F, `${res}/mipmap-${d}/ic_launcher_monochrome.png`);
  }
  for (const f of ['ic_launcher.xml', 'ic_launcher_round.xml'])
    fs.writeFileSync(`${res}/mipmap-anydpi-v26/${f}`, `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>
`);
  for (const f of fs.readdirSync(res).filter((x) => x.startsWith('drawable'))) {
    const file = `${res}/${f}/splash.png`;
    if (!fs.existsSync(file)) continue;
    const buf = fs.readFileSync(file), w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    await shot(centred(glyph, 0, Math.round(Math.min(w, h) * 0.5)).replace('width:0px;height:0px', `width:${w}px;height:${h}px`).replace('background:transparent', 'background:#000'), w, h, file);
  }
  await b.close();
  console.log('icons and splash screens written');
})();
