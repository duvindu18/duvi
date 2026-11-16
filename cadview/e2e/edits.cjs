// Notes with a real finger tap, moving placed points by holding them, and removing a file from the list.
const { chromium, devices } = require('playwright');
const { openSample } = require('./open.cjs');
const [url = 'http://localhost:4173/', shots = '.'] = process.argv.slice(2);
const res = [];
const check = (n, ok, info = '') => { res.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? ' - ' + info : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await b.newContext({ ...devices['Pixel 7'] });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(() => { localStorage.setItem('cadview.coach', '1'); localStorage.setItem('cadview.welcome', '1'); });
  const cdp = await ctx.newCDPSession(p);
  const T = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  const tap = async (x, y) => { await T('touchStart', [[x, y]]); await sleep(70); await T('touchEnd', []); await sleep(450); };
  const hold = async (x0, y0, x1, y1) => { await T('touchStart', [[x0, y0]]); await sleep(650); for (let i = 1; i <= 10; i++) { await T('touchMove', [[x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10]]); await sleep(25); } await sleep(100); await T('touchEnd', []); await sleep(400); };
  const scr = (x, y) => p.evaluate(([x, y]) => { const v = window.cadview.viewer, d = window.cadview.doc, V = v.bounds.min.constructor, s = v.toScreen(new V(x - d.origin[0], y - d.origin[1], 0)); const r = v.renderer.domElement.getBoundingClientRect(); return [r.left + s.x, r.top + s.y]; }, [x, y]);

  await p.goto(url);
  await openSample(p, 'floorplan-rev-A.dxf'); await p.waitForSelector('#viewer.active'); await sleep(800);

  // 1. note with a real tap
  await p.click('#dock [data-tool=note]');
  const [nx, ny] = await scr(3, 2);
  await tap(nx, ny);
  check('tapping in note mode keeps the note panel open', await p.evaluate(() => document.querySelector('#sheet').classList.contains('open')));
  await p.fill('#noteText', 'Check skirting');
  await p.click('#noteSave'); await sleep(500);
  check('note saved and pinned', (await p.locator('.label.pin').count()) === 1);
  await p.click('#dock [data-tool=note]'); // leave note mode

  // 2. tap the pin opens it
  await tap(nx, ny - 20);
  check('tapping a pin opens the note', (await p.evaluate(() => document.querySelector('#sheet.open #noteText')?.value)) === 'Check skirting');
  await p.click('#sheetClose'); await sleep(400);

  // 3. measurement, then move one end by holding it
  await p.click('#dock [data-tool=measure]');
  const [ax, ay] = await scr(0.2, 0.2), [bx, by] = await scr(6, 0.2);
  await tap(ax, ay); await tap(bx, by);
  const before = await p.locator('.label.dim').last().textContent();
  const [cx, cy] = await scr(9.8, 0.2);
  await hold(bx, by, cx + 3, cy - 2); // drop it near the far inner corner: it snaps there
  const m = await p.evaluate(() => window.cadview.doc.meta.measures.at(-1).pts);
  const after = await p.locator('.label.dim').last().textContent();
  check('holding a measurement end lets you move it, with snapping', Math.abs(m[1][0] - 9.8) < 1e-4 && Math.abs(m[1][1] - 0.2) < 1e-4, `${before.trim()} → ${after.trim()}`);
  await p.screenshot({ path: `${shots}/edit-moved.png` });

  // 4. move the note pin
  const [px, py] = await scr(3, 2), [qx, qy] = await scr(8, 6);
  await hold(px, py - 20, qx, qy);
  const n = await p.evaluate(() => window.cadview.doc.meta.notes[0]);
  check('holding a note pin moves it', Math.hypot(n.x - 8, n.y - 6) < 0.6, `now at (${n.x.toFixed(2)}, ${n.y.toFixed(2)})`);

  // 5. changes persist
  await sleep(600);
  await p.reload(); await sleep(600);
  await p.locator('#recent .open').first().click(); await p.waitForSelector('#viewer.active'); await sleep(800);
  const saved = await p.evaluate(() => ({ m: window.cadview.doc.meta.measures.at(-1).pts[1], n: window.cadview.doc.meta.notes[0] }));
  check('moved points are saved', Math.abs(saved.m[0] - 9.8) < 1e-4 && Math.hypot(saved.n.x - 8, saved.n.y - 6) < 0.6);

  // 6. remove from list keeps notes by default; reopening the same file restores them
  await p.click('#btnBack'); await sleep(500);
  await p.locator('#recent [data-del]').first().click(); await sleep(400);
  const txt = (await p.textContent('#sheetBody')).replace(/\s+/g, ' ');
  check('remove dialog says the original file is not deleted', /not changed or deleted/.test(txt), txt.slice(0, 110));
  await p.click('#yes'); await sleep(500);
  check('file removed from the list', (await p.locator('#recent .card').count()) === 0);
  await openSample(p, 'floorplan-rev-A.dxf'); await p.waitForSelector('#viewer.active'); await sleep(800);
  check('reopening the same file brings its notes back', (await p.locator('.label.pin').count()) === 1);

  check('no page errors', !errors.length, errors.join(' | '));
  console.log(`${res.filter(Boolean).length}/${res.length} passed`);
  await b.close();
  process.exit(res.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
