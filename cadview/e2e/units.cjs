// Display-unit conversion: a 600 mm line must read 600 mm / 60 cm / 0.60 m / 23 5/8" depending on the chosen unit.
const { chromium, devices } = require('playwright');
const [url = 'http://localhost:4173/'] = process.argv.slice(2);
const res = []; const check = (n, ok, i = '') => { res.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${i ? ' - ' + i : ''}`); };
const dxf = (units) => `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n${units}\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\n0\n20\n0\n30\n0\n11\n600\n21\n0\n31\n0\n0\nLINE\n8\n0\n10\n0\n20\n0\n30\n0\n11\n0\n21\n400\n31\n0\n0\nENDSEC\n0\nEOF\n`;
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await (await b.newContext({ ...devices['Pixel 7'] })).newPage();
  await p.addInitScript(() => { localStorage.setItem('cadview.coach', '1'); localStorage.setItem('cadview.welcome', '1'); });
  await p.goto(url);
  const open = (name, text) => p.evaluate(([n, t]) => window.cadview.openBytes(n, new TextEncoder().encode(t).buffer), [name, text]);
  await open('mm-plan.dxf', dxf(4)); await p.waitForTimeout(700);
  const r = await p.locator('#canvasHost canvas').boundingBox();
  const scr = (x, y) => p.evaluate(([x, y]) => { const v = window.cadview.viewer, d = window.cadview.doc, V = v.bounds.min.constructor; return v.toScreen(new V(x - d.origin[0], y - d.origin[1], 0)); }, [x, y]);
  await p.click('#dock [data-tool=measure]');
  for (const [x, y] of [[0, 0], [600, 0]]) { const s = await scr(x, y); await p.touchscreen.tap(r.x + s.x + 3, r.y + s.y - 3); await p.waitForTimeout(400); }
  const label = () => p.locator('.label.dim').last().textContent().then((t) => t.trim());
  check('a 600 mm line in a mm drawing reads 600 mm', (await label()) === '600 mm', await label());
  check('subtitle shows the drawing unit', /drawn in mm/.test(await p.textContent('#subtitle')), await p.textContent('#subtitle'));
  const pick = async (u) => { await p.click('#dock [data-tool=more]'); await p.waitForTimeout(300); await p.click('.tile:has-text("Units")'); await p.waitForTimeout(300); await p.click(`[data-show="${u}"]`); await p.waitForTimeout(300); await p.click('#sheetClose'); await p.waitForTimeout(300); };
  await pick('m');  check('shown in m it reads 0.60 m (converted, not relabelled)', (await label()) === '0.60 m', await label());
  check('scale bar converts too', / m$/.test(await p.textContent('#scalebar span')), await p.textContent('#scalebar span'));
  await pick('cm'); check('shown in cm: 60 cm', (await label()) === '60 cm', await label());
  await pick('in'); check('shown in inches: 23 5/8"', (await label()) === '23 5/8"', await label());
  check('drawing unit stays mm', /drawn in mm/.test(await p.textContent('#subtitle')));
  // a file without units: show raw numbers until the user says what they are
  await pick('m');
  await p.click('#dock [data-tool=measure]');
  await open('nounits.dxf', dxf(0)); await p.waitForTimeout(700);
  await p.click('#dock [data-tool=measure]');
  for (const [x, y] of [[0, 0], [600, 0]]) { const s = await scr(x, y); await p.touchscreen.tap(r.x + s.x + 3, r.y + s.y - 3); await p.waitForTimeout(400); }
  check('no units in file: raw number', (await label()) === '600', await label());
  await p.click('#dock [data-tool=more]'); await p.waitForTimeout(300); await p.click('.tile:has-text("Units")'); await p.waitForTimeout(300);
  await p.click('[data-du="mm"]'); await p.waitForTimeout(300); await p.click('#sheetClose'); await p.waitForTimeout(300);
  check('after setting drawing unit = mm, shown in the chosen m: 0.60 m', (await label()) === '0.60 m', await label());
  console.log(`${res.filter(Boolean).length}/${res.length} passed`);
  await b.close();
})();
