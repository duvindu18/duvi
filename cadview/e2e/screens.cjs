// Screenshot matrix across phone sizes, orientations and colour schemes; also checks for layout overflow.
const { chromium, devices } = require('playwright');
const [url = 'http://localhost:4173/', out = '.'] = process.argv.slice(2);
const targets = [
  ['iphone-se', { ...devices['iPhone SE'] }, 'dark'],
  ['galaxy-fold-folded', { viewport: { width: 344, height: 882 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }, 'dark'],
  ['pixel-7', { ...devices['Pixel 7'] }, 'light'],
  ['iphone-15-pro-max', { ...devices['iPhone 15 Pro Max'] }, 'dark'],
  ['pixel-7-landscape', { ...devices['Pixel 7 landscape'] }, 'dark'],
  ['ipad-mini', { ...devices['iPad Mini'] }, 'light'],
];
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  let bad = 0;
  for (const [name, dev, scheme] of targets) {
    const ctx = await b.newContext({ ...dev, colorScheme: scheme, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    await p.addInitScript(() => localStorage.setItem('cadview.coach', '1'));
    await p.goto(url);
    await p.click('[data-sample="floorplan-rev-A.dxf"]'); await p.waitForSelector('#viewer.active'); await p.waitForTimeout(600);
    await p.goto(url); await p.waitForTimeout(500);
    await p.screenshot({ path: `${out}/${name}-1-home.png` });
    await p.locator('#recent .open').first().click(); await p.waitForTimeout(800);
    await p.screenshot({ path: `${out}/${name}-2-plan.png` });
    await p.click('#dock [data-tool=more]'); await p.waitForTimeout(450);
    await p.screenshot({ path: `${out}/${name}-3-more.png` });
    // layout checks: nothing wider than the screen, dock & topbar fully on screen, tap targets ≥ 44px
    const issues = await p.evaluate(() => {
      const W = innerWidth, H = innerHeight, res = [];
      for (const sel of ['#topbar', '#dock', '#fabs', '#sheet']) {
        const r = document.querySelector(sel).getBoundingClientRect();
        if (r.left < -1 || r.right > W + 1 || r.top < -1 || r.bottom > H + 1) res.push(`${sel} off-screen ${JSON.stringify([r.left, r.top, r.right, r.bottom].map(Math.round))}`);
      }
      document.querySelectorAll('#dock button, #topbar button, .fab, .tile').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width && (r.width < 44 || r.height < 44)) res.push(`small target ${el.id || el.className} ${Math.round(r.width)}x${Math.round(r.height)}`);
      });
      if (document.documentElement.scrollWidth > W) res.push('horizontal scroll');
      return res;
    });
    console.log(`${name.padEnd(20)} ${dev.viewport.width}x${dev.viewport.height} ${scheme.padEnd(5)} ${issues.length ? 'ISSUES: ' + issues.join('; ') : 'ok'}`);
    bad += issues.length;
    await ctx.close();
  }
  await b.close();
  process.exit(bad ? 1 : 0);
})();
