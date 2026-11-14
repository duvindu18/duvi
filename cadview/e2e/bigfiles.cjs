// Large-file stress test: load time, UI responsiveness while loading, frame times during gestures, snap latency.
// Usage: node e2e/bigfiles.cjs <baseUrl> <url-of-file>...   (files served over HTTP to avoid test-harness upload cost)
const { chromium, devices } = require('playwright');
const [url, ...files] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  for (const f of files) {
    const ctx = await b.newContext({ ...devices['Pixel 7'] });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.addInitScript(() => localStorage.setItem('cadview.coach', '1'));
    await p.goto(url);
    const res = await p.evaluate(async (f) => {
      const buf = await (await fetch(f)).arrayBuffer();
      // watch for main-thread stalls while the file loads (a setInterval that should tick every 16 ms)
      let worst = 0, last = performance.now();
      const iv = setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last); last = n; }, 16);
      const t0 = performance.now();
      await window.cadview.openBytes(f.split('/').pop(), buf);
      const ms = performance.now() - t0;
      clearInterval(iv);
      return { ms, worst, stats: window.cadview.doc.stats.join(' · ') };
    }, f);
    await p.waitForTimeout(1500);
    const cdp = await ctx.newCDPSession(p);
    const T = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    const frames = p.evaluate(() => new Promise((r) => { const f = []; const t0 = performance.now(); const loop = (t) => { f.push(t); if (t - t0 < 4000) requestAnimationFrame(loop); else r(f); }; requestAnimationFrame(loop); }));
    await T('touchStart', [[150, 400], [260, 480]]);
    for (let i = 0; i < 25; i++) { await T('touchMove', [[150 - i * 4, 400 - i * 6], [260 + i * 4, 480 + i * 6]]); await p.waitForTimeout(25); }
    await T('touchEnd', []);
    await T('touchStart', [[200, 450]]);
    for (let i = 0; i < 25; i++) { await T('touchMove', [[200 + i * 6, 450 + i * 2]]); await p.waitForTimeout(25); }
    await T('touchEnd', []);
    const fr = await frames;
    const d = fr.slice(1).map((t, i) => t - fr[i]).sort((a, z) => a - z);
    const pick = await p.evaluate(() => { const v = window.cadview.viewer; const t0 = performance.now(); for (let i = 0; i < 50; i++) v.pick(100 + i * 4, 300 + i * 5); return (performance.now() - t0) / 50; });
    const heap = await p.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : -1));
    console.log(`\n${f.split('/').pop()}\n  opened in ${(res.ms / 1000).toFixed(1)} s; longest UI-thread pause while loading ${Math.round(res.worst)} ms\n  ${res.stats}\n  frames during pinch+pan: ${d.length} in 4 s, median ${d[d.length >> 1].toFixed(0)} ms, p90 ${d[Math.floor(d.length * 0.9)].toFixed(0)} ms (software-rendered GPU)\n  snap pick ${pick.toFixed(2)} ms · UI-thread JS heap ${heap} MB · errors: ${errors.length ? errors.join(' | ') : 'none'}`);
    await p.screenshot({ path: `${process.env.SHOTS || '.'}/${f.split('/').pop()}.png` });
    await ctx.close();
  }
  await b.close();
})().catch((e) => { console.error(e); process.exit(2); });
