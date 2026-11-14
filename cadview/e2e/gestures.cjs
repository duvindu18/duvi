// End-to-end check of gestures and tools on an emulated phone, using real multi-touch input.
// Usage: node e2e/gestures.cjs <baseUrl> <screenshotDir>
const { chromium, devices } = require('playwright');
const [url = 'http://localhost:4173/', shots = '.'] = process.argv.slice(2);
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ' - ' + info : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ ...devices['Pixel 7'] });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const cdp = await ctx.newCDPSession(p);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })) });
  const state = () => p.evaluate(() => { const c = window.cadview.viewer.controls; return { ...c.v2, v3: { dist: c.v3.dist, yaw: c.v3.yaw, pitch: c.v3.pitch } }; });
  const box = async () => p.locator('#canvasHost canvas').boundingBox();
  async function drag(pts0, pts1, steps = 10, ms = 12) {
    await touch('touchStart', pts0);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await touch('touchMove', pts0.map(([x, y], k) => [x + (pts1[k][0] - x) * t, y + (pts1[k][1] - y) * t]));
      await sleep(ms);
    }
    await touch('touchEnd', []);
  }

  await p.goto(url);
  await p.click('[data-sample="floorplan-rev-A.dxf"]');
  await p.waitForSelector('#viewer.active');
  await p.waitForSelector('#coach:not([hidden])');
  check('gesture guide shown on first open', true);
  await p.click('#coachOk');
  await sleep(400);
  const r = await box();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;

  // 1-finger pan
  let s0 = await state();
  await drag([[cx, cy]], [[cx + 100, cy + 60]], 10, 16);
  await sleep(500);
  let s1 = await state();
  const worldDx = (s0.x - s1.x) / s0.scale;
  check('one-finger drag pans with the finger', worldDx > 90, `moved ${worldDx.toFixed(0)}px of 100 (+fling)`);

  // fling: fast drag keeps moving after release
  s0 = await state();
  await drag([[cx, cy]], [[cx - 160, cy]], 4, 8);
  const sA = await state();
  await sleep(350);
  const sB = await state();
  check('fast swipe flings with momentum', Math.abs(sB.x - sA.x) > 0, `continued ${((sB.x - sA.x) / sA.scale).toFixed(0)}px after release`);
  await p.click('#btnFit'); await sleep(450);

  // pinch zoom about the fingers: the world point between the fingers must stay put
  s0 = await state();
  const wBefore = await p.evaluate(([x, y]) => window.cadview.viewer.controls.screenToWorld2D(x, y), [cx - r.x + 40, cy - r.y]);
  await drag([[cx - 40 + 40, cy - 60], [cx + 40 + 40, cy + 60]], [[cx - 120 + 40, cy - 180], [cx + 120 + 40, cy + 180]], 12);
  s1 = await state();
  const wAfter = await p.evaluate(([x, y]) => window.cadview.viewer.controls.screenToWorld2D(x, y), [cx - r.x + 40, cy - r.y]);
  const drift = Math.hypot(wAfter[0] - wBefore[0], wAfter[1] - wBefore[1]) / s1.scale;
  check('pinch zooms in ~3x', s0.scale / s1.scale > 2.6 && s0.scale / s1.scale < 3.4, `${(s0.scale / s1.scale).toFixed(2)}x`);
  check('pinch keeps the point between the fingers fixed', drift < 3, `drift ${drift.toFixed(1)}px`);

  // twist rotate
  s0 = await state();
  const R = 90, a0 = 0, a1 = Math.PI / 4;
  await drag([[cx + R * Math.cos(a0), cy + R * Math.sin(a0)], [cx - R * Math.cos(a0), cy - R * Math.sin(a0)]],
             [[cx + R * Math.cos(a1), cy + R * Math.sin(a1)], [cx - R * Math.cos(a1), cy - R * Math.sin(a1)]], 14);
  s1 = await state();
  check('two-finger twist rotates the drawing', Math.abs(s1.rot - s0.rot) > 0.4, `${((s1.rot - s0.rot) * 180 / Math.PI).toFixed(0)}°`);
  await sleep(300);
  check('compass appears when rotated', await p.isVisible('#btnCompass'));
  await p.click('#btnCompass'); await sleep(500);
  check('compass tap resets rotation', Math.abs((await state()).rot) < 0.01);

  // double-tap zoom in, two-finger tap zoom out
  await p.click('#btnFit'); await sleep(450);
  s0 = await state();
  await p.touchscreen.tap(cx, cy); await sleep(60); await p.touchscreen.tap(cx, cy);
  await sleep(450);
  s1 = await state();
  check('double-tap zooms in 2x', Math.abs(s0.scale / s1.scale - 2) < 0.1, `${(s0.scale / s1.scale).toFixed(2)}x`);
  await touch('touchStart', [[cx - 30, cy], [cx + 30, cy]]); await sleep(60); await touch('touchEnd', []);
  await sleep(450);
  const s2 = await state();
  check('two-finger tap zooms out 2x', Math.abs(s2.scale / s1.scale - 2) < 0.1, `${(s2.scale / s1.scale).toFixed(2)}x`);

  // long-press → context menu
  await p.click('#btnFit'); await sleep(450);
  await touch('touchStart', [[cx, cy]]); await sleep(650); await touch('touchEnd', []);
  await sleep(200);
  check('long-press opens the options menu', await p.isVisible('#popover.show'));
  await p.screenshot({ path: `${shots}/g-longpress.png` });
  await p.locator('#popover button').first().click(); // Measure from here
  check('"Measure from here" starts measuring', await p.evaluate(() => document.querySelector('#dock [data-tool=measure]').classList.contains('on')));

  // measuring with snapping: tap near (not on) a wall corner
  const corner = await p.evaluate(() => { const v = window.cadview.viewer, d = window.cadview.doc; const s = v.toScreen({ x: 10 - d.origin[0], y: 8 - d.origin[1], z: 0, clone() { return new v.bounds.min.constructor(this.x, this.y, this.z); } }); return s; });
  await p.touchscreen.tap(r.x + corner.x + 7, r.y + corner.y - 6); // just outside the corner
  await sleep(300);
  const label = await p.locator('.label.dim').last().textContent();
  const m = await p.evaluate(() => window.cadview.doc.meta.measures.at(-1).pts.at(-1));
  check('measurement point snaps to the real corner', Math.abs(m[0] - 10) < 1e-6 && Math.abs(m[1] - 8) < 1e-6, `${label}, end at (${m[0]}, ${m[1]})`);
  await p.screenshot({ path: `${shots}/g-measure.png` });

  // loupe precision placement
  await p.click('#dock [data-tool=measure]'); await p.click('#dock [data-tool=measure]');
  await touch('touchStart', [[cx + 30, cy + 30]]); await sleep(600);
  for (let i = 0; i < 8; i++) { await touch('touchMove', [[cx + 30 + i * 4, cy + 30 + i * 2]]); await sleep(20); }
  check('long-press while measuring shows the magnifier', await p.isVisible('#loupe'));
  await p.screenshot({ path: `${shots}/g-loupe.png` });
  await touch('touchEnd', []);
  await sleep(200);
  check('releasing places the point', (await p.locator('.label.dot').count()) >= 1 && !(await p.isVisible('#loupe')));
  await p.click('#dock [data-tool=measure]');

  // area
  await p.click('#dock [data-tool=area]');
  const pts = [[0.2, 0.2], [6, 0.2], [6, 4], [0.2, 4]]; // bedroom: inner wall corner to partition walls
  for (const [x, y] of pts) {
    const s = await p.evaluate(([x, y]) => { const v = window.cadview.viewer, d = window.cadview.doc; const V = v.bounds.min.constructor; return v.toScreen(new V(x - d.origin[0], y - d.origin[1], 0)); }, [x, y]);
    await p.touchscreen.tap(r.x + s.x, r.y + s.y); await sleep(380);
  }
  await p.click('#hint button.primary');
  await sleep(200);
  const area = await p.locator('.label.dim').last().textContent();
  check('area of the 5.8 × 3.8 m bedroom', area.includes('22.04'), area);
  await p.screenshot({ path: `${shots}/g-area.png` });

  // find text
  await p.click('#dock [data-tool=more]'); await sleep(350);
  await p.click('.tile:has-text("Find text")'); await sleep(350);
  await p.fill('#q', 'kitchen'); await sleep(300);
  check('find text lists matches', (await p.locator('#res [data-i]').count()) === 1);
  await p.locator('#res [data-i]').first().click(); await sleep(600);
  await p.screenshot({ path: `${shots}/g-find.png` });

  // layers sheet + swipe-down to close
  await p.click('#dock [data-tool=layers]'); await sleep(400);
  await p.locator('#sheetBody .row').first().locator('input').click();
  const hidden = await p.evaluate(() => window.cadview.doc.s2.layers.filter((l) => !l.visible).length);
  check('layer switch hides a layer', hidden === 1);
  await p.screenshot({ path: `${shots}/g-layers.png` });
  const g = await p.locator('#sheetGrab').boundingBox();
  await drag([[g.x + g.width / 2, g.y + 10]], [[g.x + g.width / 2, g.y + 260]], 8);
  await sleep(450);
  check('swiping the sheet down closes it', !(await p.evaluate(() => document.querySelector('#sheet').classList.contains('open'))));

  // note persists across reload
  await p.click('#dock [data-tool=note]');
  await p.touchscreen.tap(cx - 60, cy - 40); await sleep(500);
  await p.fill('#noteText', 'Check door swing'); await p.click('#noteSave'); await sleep(600);
  await p.reload(); await sleep(800);
  await p.locator('#recent .open').first().click(); await p.waitForSelector('#viewer.active'); await sleep(800);
  check('note and measurements survive an app restart', (await p.locator('.label.pin').count()) === 1 && (await p.locator('.label.dim').count()) >= 2);

  // revision compare
  await p.goto(url); await sleep(500);
  await p.click('[data-sample="compare"]');
  await p.waitForSelector('#legend:not([hidden])', { timeout: 15000 }); await sleep(500);
  const lg = (await p.textContent('#legend')).replace(/\s+/g, ' ');
  check('compare finds the changes', /Added\s*4/.test(lg) && /Removed\s*3/.test(lg), lg.trim());
  await p.screenshot({ path: `${shots}/g-compare.png` });
  await p.click('#exitCmp');

  // 3D: orbit, pinch, section, parts
  await p.goto(url); await sleep(400);
  await p.click('[data-sample="house.obj"]'); await p.waitForSelector('#viewer.active'); await sleep(900);
  s0 = await state();
  await drag([[cx, cy]], [[cx + 120, cy]], 10, 16); await sleep(500);
  s1 = await state();
  check('3D: one-finger drag orbits', Math.abs(s1.v3.yaw - s0.v3.yaw) > 0.5, `${((s1.v3.yaw - s0.v3.yaw) * 180 / Math.PI).toFixed(0)}°`);
  s0 = await state();
  await drag([[cx - 50, cy], [cx + 50, cy]], [[cx - 100, cy], [cx + 100, cy]], 10);
  s1 = await state();
  check('3D: pinch zooms toward the model', s1.v3.dist < s0.v3.dist * 0.6, `${(s0.v3.dist / s1.v3.dist).toFixed(2)}x`);
  await p.click('#dock [data-tool=more]'); await sleep(300); await p.click('.tile:has-text("Views")'); await sleep(300);
  await p.click('#zup'); await sleep(500);
  await p.click('#dock [data-tool=section]'); await sleep(350);
  await p.click('[data-ax="1"]'); await p.locator('#secT').fill('0.45'); await sleep(200);
  await p.click('#sheetClose'); await sleep(400);
  check('3D: section cut enabled', await p.evaluate(() => window.cadview.viewer.renderer.clippingPlanes.length === 1));
  await p.screenshot({ path: `${shots}/g-3d-section.png` });

  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await b.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
