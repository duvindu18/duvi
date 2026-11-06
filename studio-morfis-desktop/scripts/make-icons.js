'use strict';
/* Draws the default app icon (build/icon.svg) into build/icon.png (256 px) and build/icon.ico (16 to 256 px).
   Needs Playwright with Chromium: `npm i -D playwright && npx playwright install chromium`, then `npm run icons`. */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BUILD = path.join(__dirname, '..', 'build');
const SIZES = [256, 64, 48, 32, 24, 16];

function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach((p, i) => {
    const e = 6 + i * 16, s = p.size >= 256 ? 0 : p.size;
    head.writeUInt8(s, e); head.writeUInt8(s, e + 1); head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(p.buf.length, e + 8); head.writeUInt32LE(off, e + 12);
    off += p.buf.length;
  });
  return Buffer.concat([head].concat(pngs.map((p) => p.buf)));
}

(async () => {
  const svg = fs.readFileSync(path.join(BUILD, 'icon.svg'), 'utf8');
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const pngs = [];
  for (const s of SIZES) {
    await page.setViewportSize({ width: s, height: s });
    await page.setContent('<html><body style="margin:0;background:transparent">' + svg.replace('<svg ', '<svg width="' + s + '" height="' + s + '" ') + '</body></html>');
    pngs.push({ size: s, buf: await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: s, height: s } }) });
  }
  await browser.close();
  fs.writeFileSync(path.join(BUILD, 'icon.png'), pngs[0].buf);
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico(pngs));
  console.log('Wrote build/icon.png and build/icon.ico');
})().catch((e) => { console.error(e); process.exit(1); });
