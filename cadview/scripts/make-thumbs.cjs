// Renders the sample-card images (public/samples/thumbs) with the app itself, in light mode.
const { chromium } = require('playwright');
const path = require('path');
const out = path.join(__dirname, '../public/samples/thumbs');
const url = process.argv[2] || 'http://localhost:4173/';
const items = [['plan', 'floorplan-rev-A.dxf'], ['dwg', 'floorplan-2018.dwg'], ['skp', 'house.skp'], ['obj', 'house.obj'], ['compare', 'compare']];
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  for (const [name, sample] of items) {
    const p = await (await b.newContext({ viewport: { width: 480, height: 480 }, deviceScaleFactor: 2, colorScheme: 'light' })).newPage();
    await p.addInitScript(() => { localStorage.setItem('cadview.coach', '1'); localStorage.setItem('cadview.theme', 'light'); });
    await p.goto(url);
    await p.click(`[data-sample="${sample}"]`);
    await p.waitForSelector('#viewer.active');
    if (sample === 'compare') await p.waitForSelector('#legend:not([hidden])');
    await p.waitForTimeout(900);
    await p.addStyleTag({ content: '#topbar,#dock,#fabs,#scalebar,#hint,#legend,#toast,#labels{display:none!important}' });
    await p.evaluate((n) => {
      const v = window.cadview.viewer;
      v.padding = { top: 30, right: 30, bottom: 30, left: 30 };
      if (n === 'obj') { const r = window.cadview.doc.s3.root; r.rotation.x = -Math.PI / 2; r.updateMatrixWorld(true); v.bounds.setFromObject(v.content, true); }
      v.fit(false);
      if (v.mode === '3d') v.controls.v3.dist *= 0.82, v.controls.apply();
    }, name);
    await p.waitForTimeout(1200);
    await p.screenshot({ path: `${out}/${name}.png` });
    await p.context().close();
  }
  await b.close();
  console.log('thumbs written');
})();
