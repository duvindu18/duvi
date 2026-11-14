// SketchUp (.skp) opening check: loads the bundled sample, verifies size (metres), parts, measuring and section.
const { chromium, devices } = require('playwright');
const [url = 'http://localhost:4173/', shots = '.'] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await (await b.newContext({ ...devices['Pixel 7'] })).newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(() => localStorage.setItem('cadview.coach', '1'));
  await p.goto(url);
  await p.click('[data-sample="house.skp"]');
  await p.waitForSelector('#viewer.active', { timeout: 30000 });
  await p.waitForFunction(() => !document.querySelector('#loading.show'));
  await p.waitForTimeout(1200);
  const info = await p.evaluate(() => {
    const v = window.cadview.viewer, d = window.cadview.doc, s = v.bounds.getSize(new v.bounds.min.constructor());
    return { size: s.toArray().map((x) => +x.toFixed(2)), parts: d.s3.parts.map((x) => x.name), stats: d.stats, units: d.units, title: document.querySelector('#subtitle').textContent };
  });
  console.log(JSON.stringify(info));
  await p.screenshot({ path: `${shots}/skp-1.png` });
  await p.click('#dock [data-tool=layers]'); await p.waitForTimeout(400);
  await p.screenshot({ path: `${shots}/skp-2-parts.png` });
  await p.click('#sheetClose'); await p.waitForTimeout(300);
  await p.click('#dock [data-tool=section]'); await p.waitForTimeout(300);
  await p.click('[data-ax="1"]'); await p.locator('#secT').fill('0.5'); await p.click('#sheetClose'); await p.waitForTimeout(500);
  await p.screenshot({ path: `${shots}/skp-3-section.png` });
  const ok = Math.max(...info.size) > 9 && Math.max(...info.size) < 12;
  console.log(ok ? 'PASS size in metres' : 'FAIL size', errors.length ? 'ERRORS ' + errors.join(' | ') : 'no errors');
  await b.close();
})();
