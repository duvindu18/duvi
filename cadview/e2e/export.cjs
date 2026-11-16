// Monochrome view and PDF/PNG export (whole drawing, selected area, 3D view).
const { chromium, devices } = require('playwright');
const { openSample } = require('./open.cjs');
const fs = require('fs');
const [url = 'http://localhost:4173/', out = '.'] = process.argv.slice(2);
const res = []; const check = (n, ok, i = '') => { res.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${i ? ' - ' + i : ''}`); };
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await b.newContext({ ...devices['Pixel 7'], acceptDownloads: true });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(() => { localStorage.setItem('cadview.coach', '1'); localStorage.setItem('cadview.welcome', '1'); });
  await p.goto(url);
  await openSample(p, 'detail.dwg'); await p.waitForSelector('#viewer.active'); await p.waitForFunction(() => !document.querySelector('#loading.show'));
  await p.waitForTimeout(1000);
  // monochrome
  await p.click('#dock [data-tool=more]'); await p.waitForTimeout(300);
  await p.click('.tile:has-text("Monochrome")'); await p.waitForTimeout(300);
  const monoOn = await p.evaluate(() => window.cadview.doc.s2.materials.every((m) => m.userData.orig === undefined || m.color.getHex() === window.cadview.doc.s2.materials[0].color.getHex() || m.userData.fill));
  check('monochrome makes every line one colour', monoOn);
  await p.click('#sheetClose'); await p.waitForTimeout(300);
  await p.screenshot({ path: `${out}/mono.png` });
  await p.click('#dock [data-tool=more]'); await p.waitForTimeout(300); await p.click('.tile:has-text("Monochrome")'); await p.waitForTimeout(200); await p.click('#sheetClose'); await p.waitForTimeout(200);
  // export whole drawing as PDF A3
  const exportNow = async () => { const dl = p.waitForEvent('download', { timeout: 120000 }); await p.click('#doExport'); const d = await dl; const f = `${out}/${d.suggestedFilename()}`; await d.saveAs(f); return f; };
  await p.click('#btnShare'); await p.waitForTimeout(300);
  await p.click('[data-key=format] [data-v=pdf]'); await p.waitForTimeout(200); await p.click('[data-key=paper] [data-v=A3]'); await p.waitForTimeout(200); await p.click('[data-key=area] [data-v=all]'); await p.waitForTimeout(200);
  const pdf = await exportNow();
  const head = fs.readFileSync(pdf).subarray(0, 8).toString();
  const pdfTxt = fs.readFileSync(pdf, 'latin1');
  check('PDF of the whole drawing', head.startsWith('%PDF-') && /\/Type\s*\/Page[^s]/.test(pdfTxt), `${pdf.split('/').pop()} ${(fs.statSync(pdf).size / 1024).toFixed(0)} KB`);
  // select an area and export PNG
  await p.click('#btnShare'); await p.waitForTimeout(300);
  await p.click('[data-key=area] [data-v=select]'); await p.waitForTimeout(300);
  const scr = (x, y) => p.evaluate(([x, y]) => { const v = window.cadview.viewer, d = window.cadview.doc, V = v.bounds.min.constructor; const s = v.toScreen(new V(x - d.origin[0], y - d.origin[1], 0)); const r = v.renderer.domElement.getBoundingClientRect(); return [r.left + s.x, r.top + s.y]; }, [x, y]);
  for (const [x, y] of [[-100, 200], [400, 1250]]) { const [sx, sy] = await scr(x, y); await p.touchscreen.tap(sx, sy); await p.waitForTimeout(400); }
  check('selecting two corners reopens Export with the area selected', await p.isVisible('[data-key=area] [data-v=select].on'));
  await p.click('[data-key=format] [data-v=png]'); await p.waitForTimeout(200);
  const png = await exportNow();
  const sig = fs.readFileSync(png).subarray(1, 4).toString();
  const w = fs.readFileSync(png).readUInt32BE(16), h = fs.readFileSync(png).readUInt32BE(20);
  check('PNG of the selected area', sig === 'PNG' && Math.max(w, h) === 4096, `${png.split('/').pop()} ${w}×${h}`);
  // 3D export
  await p.goto(url); await p.waitForTimeout(400); await openSample(p, 'house.skp'); await p.waitForSelector('#viewer.active'); await p.waitForTimeout(900);
  await p.click('#btnShare'); await p.waitForTimeout(300); await p.click('[data-key=format] [data-v=png]'); await p.waitForTimeout(200);
  const png3 = await exportNow();
  check('PNG of the 3D view', fs.readFileSync(png3).subarray(1, 4).toString() === 'PNG', png3.split('/').pop());
  check('no page errors', !errors.length, errors.join(' | '));
  console.log(`${res.filter(Boolean).length}/${res.length} passed`);
  await b.close();
})().catch((e) => { console.error(e); process.exit(2); });
