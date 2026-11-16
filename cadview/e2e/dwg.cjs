// DWG import check: open → converted to DXF on the device → drawn; reopen uses the cached DXF; compare DWG with DXF.
const { chromium, devices } = require('playwright');
const { openSample } = require('./open.cjs');
const [url = 'http://localhost:4173/', shots = '.'] = process.argv.slice(2);
const results = [];
const check = (n, ok, info = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? ' - ' + info : ''}`); };
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await (await b.newContext({ ...devices['Pixel 7'] })).newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(() => { localStorage.setItem('cadview.coach', '1'); localStorage.setItem('cadview.welcome', '1'); });
  await p.goto(url);
  await openSample(p, 'floorplan-2018.dwg');
  await p.waitForSelector('#viewer.active', { timeout: 30000 });
  await p.waitForFunction(() => !document.querySelector('#loading.show'));
  await p.waitForTimeout(800);
  const info = await p.evaluate(() => { const d = window.cadview.doc; return { layers: d.drawing.layers.map((l) => l.name), texts: d.drawing.text.values, stats: d.stats, w: d.s2.bounds.max.x - d.s2.bounds.min.x }; });
  check('DWG opens and is drawn', info.layers.length === 4 && Math.abs(info.w - 10) < 1e-3, `${info.layers.join(', ')} · ${info.stats[0]}`);
  check('text and layers come through', info.texts.includes('LIVING 201') && info.texts.some((t) => t.includes('Ø 600')));
  await p.screenshot({ path: `${shots}/dwg-1.png` });
  // measure snaps to a real corner in the DWG
  await p.click('#dock [data-tool=measure]');
  const tap = async (x, y) => { const s = await p.evaluate(([x, y]) => { const v = window.cadview.viewer, d = window.cadview.doc, V = v.bounds.min.constructor; return v.toScreen(new V(x - d.origin[0], y - d.origin[1], 0)); }, [x, y]); const r = await p.locator('#canvasHost canvas').boundingBox(); await p.touchscreen.tap(r.x + s.x + 4, r.y + s.y - 3); await p.waitForTimeout(400); };
  await tap(0, 0); await tap(10, 0);
  const lab = await p.locator('.label.dim').last().textContent();
  check('measuring a DWG wall snaps to corners', /^10(\.0+)? m/.test(lab.trim()), lab);
  await p.screenshot({ path: `${shots}/dwg-2-measure.png` });
  // File info → share as DXF button exists
  await p.click('#dock [data-tool=more]'); await p.waitForTimeout(300); await p.click('.tile:has-text("File info")'); await p.waitForTimeout(300);
  check('File info offers "Share as DXF"', await p.isVisible('#shareDxf'), (await p.textContent('#sheetBody')).replace(/\s+/g, ' ').slice(0, 140));
  await p.screenshot({ path: `${shots}/dwg-3-info.png` });
  // reopen from library → cached DXF
  await p.waitForTimeout(800);
  await p.goto(url); await p.waitForTimeout(600);
  await p.locator('#recent .open').first().click(); await p.waitForSelector('#viewer.active'); await p.waitForFunction(() => !document.querySelector('#loading.show'));
  const st = await p.evaluate(() => window.cadview.doc.stats[0]);
  check('reopening uses the cached DXF (no re-conversion)', /converted earlier/.test(st), st);
  check('measurement restored on reopen', (await p.locator('.label.dim').count()) >= 1);
  // compare DWG (current) with DXF rev B
  await p.setInputFiles('#compareInput', require('path').join(__dirname, '../samples/floorplan-rev-B.dxf'));
  await p.waitForSelector('#legend:not([hidden])', { timeout: 20000 });
  check('a DWG can be compared with another revision', true, (await p.textContent('#legend')).replace(/\s+/g, ' ').trim().slice(0, 90));
  check('no page errors', errors.length === 0, errors.join(' | '));
  console.log(`${results.filter(Boolean).length}/${results.length} passed`);
  await b.close();
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
