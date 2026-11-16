// Store graphics: iOS app icon (1024, no alpha) + splash, Play icon (512) and feature graphic (1024×500).
// Run: node scripts/make-store-assets.cjs   (then node scripts/make-icons.cjs for Android launcher icons)
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'public/icon.svg'), 'utf8')
  .replace(/<rect width="512" height="512" rx="\d+"/, '<rect width="512" height="512"'); // full-bleed square: the stores round the corners
const glyph = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="96 112 320 288" width="100%" height="100%"><path d="M136 360V152h132l-132 208h240V240" fill="none" stroke="#fff" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/><circle cx="376" cy="200" r="28" fill="#facc15"/></svg>';
const sample = 'data:image/png;base64,' + fs.readFileSync(path.join(root, 'public/samples/thumbs/skp.png')).toString('base64');
const plan = 'data:image/png;base64,' + fs.readFileSync(path.join(root, 'public/samples/thumbs/plan.png')).toString('base64');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const shot = async (html, w, h, file) => {
    await p.setViewportSize({ width: w, height: h });
    await p.setContent(`<html><body style="margin:0;background:#000;font-family:Inter,'Helvetica Neue',Helvetica,Arial,sans-serif">${html}</body></html>`);
    await p.waitForTimeout(100);
    await p.screenshot({ path: file, omitBackground: false });
    console.log('wrote', path.relative(root, file));
  };
  const icon = (s) => svg.replace('<svg ', `<svg width="${s}" height="${s}" `);
  await shot(icon(1024), 1024, 1024, path.join(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'));
  await shot(icon(512), 512, 512, path.join(root, 'store/assets/play-icon-512.png'));
  await shot(icon(1024), 1024, 1024, path.join(root, 'store/assets/app-store-icon-1024.png'));
  for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png'])
    await shot(`<div style="width:2732px;height:2732px;display:grid;place-items:center"><div style="width:520px;height:468px">${glyph}</div></div>`, 2732, 2732, path.join(root, 'ios/App/App/Assets.xcassets/Splash.imageset', f));
  await shot(`<div style="width:1024px;height:500px;display:flex;align-items:center;gap:36px;padding:0 0 0 64px;box-sizing:border-box;color:#fff;overflow:hidden">
      <div style="flex:1">
        <div style="display:flex;align-items:center;gap:14px;font-size:30px;font-weight:600;letter-spacing:-.03em;margin-bottom:34px"><div style="width:40px;height:36px">${glyph}</div>CADView</div>
        <div style="font-size:50px;line-height:1.02;letter-spacing:-.045em;font-weight:500">Open <span style="color:#8b8b8b">DWG, DXF and</span> SketchUp <span style="color:#8b8b8b">files on your</span> phone.</div>
      </div>
      <div style="width:390px;height:500px;position:relative">
        <img src="${plan}" style="position:absolute;width:250px;height:250px;border-radius:22px;top:40px;left:0">
        <img src="${sample}" style="position:absolute;width:250px;height:250px;border-radius:22px;top:210px;left:120px">
      </div></div>`, 1024, 500, path.join(root, 'store/assets/play-feature-graphic-1024x500.png'));
  await b.close();
})();
