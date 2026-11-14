// Large-file stress test: load time, interaction frame rate and snapping latency.
const { chromium, devices } = require('playwright');
const [url, ...files] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--js-flags=--max-old-space-size=4096'] });
  for (const f of files) {
    const ctx = await b.newContext({ ...devices['Pixel 7'] });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.addInitScript(() => localStorage.setItem('cadview.coach', '1'));
    await p.goto(url);
    const t0 = Date.now();
    await p.setInputFiles('#fileInput', f);
    // UI must stay responsive while parsing: sample main-thread stalls during loading
    const stall = await p.evaluate(() => new Promise((res) => {
      let worst = 0, last = performance.now();
      const tick = () => {
        const now = performance.now(); worst = Math.max(worst, now - last); last = now;
        if (document.querySelector('#loading.show') || now - performance.timeOrigin < 0) requestAnimationFrame(tick); else res(worst);
      };
      requestAnimationFrame(tick);
    }));
    await p.waitForSelector('#viewer.active', { timeout: 180000 });
    await p.waitForFunction(() => !document.querySelector('#loading.show'), null, { timeout: 180000 });
    const loadS = (Date.now() - t0) / 1000;
    await p.waitForTimeout(800);
    // drive a pinch + pan and measure frame intervals
    const cdp = await ctx.newCDPSession(p);
    const T = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    await p.evaluate(() => { window.__f = []; const t0 = performance.now(); const loop = (t) => { window.__f.push(t); if (t - t0 < 6000) requestAnimationFrame(loop); }; requestAnimationFrame(loop); });
    await T('touchStart', [[150, 400], [260, 480]]);
    for (let i = 0; i < 20; i++) { await T('touchMove', [[150 - i * 4, 400 - i * 6], [260 + i * 4, 480 + i * 6]]); await p.waitForTimeout(30); }
    await T('touchEnd', []);
    await T('touchStart', [[200, 450]]);
    for (let i = 0; i < 20; i++) { await T('touchMove', [[200 + i * 6, 450 + i * 2]]); await p.waitForTimeout(30); }
    await T('touchEnd', []);
    await p.waitForTimeout(1500);
    const fr = await p.evaluate(() => { const f = window.__f; const d = f.slice(1).map((t, i) => t - f[i]).filter((x) => x < 1000).sort((a, b) => a - b); return { med: d[d.length >> 1], p95: d[Math.floor(d.length * 0.95)] }; });
    const info = await p.evaluate(() => {
      const d = window.cadview.doc, v = window.cadview.viewer;
      const t0 = performance.now();
      for (let i = 0; i < 50; i++) v.pick(100 + i * 4, 300 + i * 5);
      const pickMs = (performance.now() - t0) / 50;
      return { stats: d.stats.join(' · '), openedIn: d.ms / 1000, pickMs, ratio: v.renderer.getPixelRatio() };
    });
    const mem = await p.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : -1));
    console.log(`\n${f.split('/').pop()}\n  total load ${loadS.toFixed(1)}s (parse+build ${info.openedIn.toFixed(1)}s)\n  ${info.stats}\n  worst UI stall while loading ${Math.round(stall)}ms\n  frame interval during gestures: median ${fr.med?.toFixed(1)}ms, p95 ${fr.p95?.toFixed(1)}ms (software GPU)\n  snap pick ${info.pickMs.toFixed(2)}ms · main-thread JS heap ${mem}MB\n  errors: ${errors.length ? errors.join(' | ') : 'none'}`);
    await p.screenshot({ path: `${process.env.SHOTS}/${f.split('/').pop()}.png` });
    await ctx.close();
  }
  await b.close();
})().catch((e) => { console.error(e); process.exit(2); });
