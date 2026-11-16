// Store screenshots at the exact pixel sizes each store asks for, rendered from the real app.
// Usage: npm run build && npx vite preview --port 4173 &  then  node scripts/make-screenshots.cjs [url]
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const url = process.argv[2] || 'http://localhost:4173/';
const out = path.join(__dirname, '../store/screenshots');
const SETS = [
  ['app-store/iphone-6.9in', 440, 956, 3],        // 1320 × 2868
  ['app-store/ipad-13in-portrait', 1032, 1376, 2], // 2064 × 2752
  ['app-store/ipad-13in-landscape', 1376, 1032, 2], // 2752 × 2064
  ['google-play/phone', 360, 640, 3],               // 1080 × 1920
  ['google-play/tablet-7in', 600, 960, 2],          // 1200 × 1920
  ['google-play/tablet-10in', 1280, 800, 2],        // 2560 × 1600
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scenes(p, dir) {
  const box = async () => p.locator('#canvasHost canvas').boundingBox();
  const scr = (x, y) => p.evaluate(([x, y]) => { const v = window.cadview.viewer, d = window.cadview.doc, V = v.bounds.min.constructor; return v.toScreen(new V(x - d.origin[0], y - d.origin[1], 0)); }, [x, y]);
  const tap = async (x, y) => { const r = await box(), s = await scr(x, y); await p.touchscreen.tap(r.x + s.x, r.y + s.y); await sleep(420); };
  const sample = async (s) => { await p.goto(url); await sleep(400); await p.click(`[data-sample="${s}"]`); await p.waitForSelector('#viewer.active'); await p.waitForFunction(() => !document.querySelector('#loading.show')); await sleep(900); };
  const shot = async (name) => { await sleep(500); await p.screenshot({ path: path.join(dir, name) }); };

  // 1. home with recent files
  await sample('floorplan-2018.dwg'); await sample('house.skp'); await sample('floorplan-rev-A.dxf');
  await p.goto(url); await sleep(900);
  await shot('1-home.png');

  // 2. floor plan with a measurement, an area and a note
  await sample('floorplan-rev-A.dxf');
  await p.click('#dock [data-tool=measure]'); await tap(0.2, 7.8); await tap(9.8, 7.8); await p.click('#dock [data-tool=measure]');
  await p.click('#dock [data-tool=area]'); for (const [x, y] of [[0.2, 0.2], [6, 0.2], [6, 4], [0.2, 4]]) await tap(x, y);
  await p.click('#hint button.primary'); await p.click('#dock [data-tool=area]');
  await p.click('#dock [data-tool=note]'); await tap(8, 2.5); await p.fill('#noteText', 'Check door clearance'); await p.click('#noteSave'); await sleep(400);
  await p.click('#dock [data-tool=note]');
  await shot('2-measure.png');

  // 3. SketchUp model
  await sample('house.skp');
  await p.evaluate(() => { const c = window.cadview.viewer.controls; c.v3.yaw = 0.9; c.v3.pitch = 0.42; c.v3.dist *= 0.9; c.apply(); });
  await shot('3-sketchup.png');

  // 4. section cut through the model
  await p.click('#dock [data-tool=section]'); await sleep(300); await p.click('[data-ax="1"]'); await p.locator('#secT').fill('0.55'); await p.click('#sheetClose'); await sleep(300);
  await p.evaluate(() => { const c = window.cadview.viewer.controls; c.v3.pitch = 0.75; c.apply(); });
  await shot('4-section.png');

  // 5. revision compare
  await p.goto(url); await sleep(400); await p.click('[data-sample="compare"]');
  await p.waitForSelector('#legend:not([hidden])'); await sleep(2800); // let the result toast fade
  await shot('5-compare.png');

  // 6. find text in light mode
  await p.evaluate(() => localStorage.setItem('cadview.theme', 'light'));
  await sample('floorplan-rev-A.dxf');
  await p.click('#dock [data-tool=more]'); await sleep(300); await p.click('.tile:has-text("Find text")'); await sleep(300);
  await p.fill('#q', '20'); await sleep(500);
  await shot('6-find-light.png');
}

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  for (const [name, w, h, dpr] of SETS) {
    const dir = path.join(out, name);
    fs.mkdirSync(dir, { recursive: true });
    const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: true, hasTouch: true, colorScheme: 'dark' });
    await ctx.addInitScript(() => { localStorage.setItem('cadview.coach', '1'); if (!localStorage.getItem('cadview.theme')) localStorage.setItem('cadview.theme', 'dark'); });
    const p = await ctx.newPage();
    try { await scenes(p, dir); console.log(`${name}: ${w * dpr}×${h * dpr}`); } catch (e) { console.log(`${name}: FAILED ${e.message.split('\n')[0]}`); }
    await ctx.close();
  }
  await b.close();
})();
