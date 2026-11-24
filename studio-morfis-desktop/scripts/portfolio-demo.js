'use strict';
/* The portfolio maker, driven end to end in the real app with the example studio: adds three projects with
   pictures, takes screenshots of the editor and exports the PDF.
   Usage: electron scripts/portfolio-demo.js <out-dir> <pictures-dir>   (Linux: xvfb-run -a npx electron --no-sandbox …) */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const args = process.argv.slice(process.argv.findIndex((a) => /portfolio-demo\.js$/.test(a)) + 1).filter((a) => !a.startsWith('--'));
const out = path.resolve(args[0] || 'portfolio-out'), pics = path.resolve(args[1] || '.');
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-studio.json'), 'utf8'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'morfis-pf-'));
app.setPath('userData', profile);
fs.mkdirSync(out, { recursive: true });
const dir = path.join(profile, 'data', 'projects');
fs.mkdirSync(dir, { recursive: true });
(Array.isArray(seed.projects) ? seed.projects : Object.values(seed.projects)).forEach((p) => fs.writeFileSync(path.join(dir, p.id + '.json'), JSON.stringify(p)));
fs.writeFileSync(path.join(profile, 'data', 'settings.json'), JSON.stringify(Object.assign({}, seed.settings, { studio: 'Seedform', theme: 'light' })));
fs.writeFileSync(path.join(profile, 'desktop.json'), JSON.stringify({ splash: false }));
process.env.MORFIS_TEST_PDF = '1';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
process.on('unhandledRejection', (e) => { console.error('DEMO FAILED: ' + ((e && e.stack) || e)); app.exit(1); });
setTimeout(() => { console.error('DEMO FAILED: timed out'); app.exit(2); }, 4 * 60 * 1000).unref();
require('../src/shell/main.js');
app.whenReady().then(async () => {
  let w = null;
  for (let i = 0; i < 80 && !w; i++) { await wait(250); w = BrowserWindow.getAllWindows().find((x) => /^morfis:/.test(x.webContents.getURL()) && x.isVisible()); }
  if (!w) { console.error('no window'); app.exit(1); return; }
  w.webContents.on('console-message', (e) => { if (e.level === 'error' || /Uncaught/.test(e.message || '')) errors.push(e.message); });
  const js = (code) => w.webContents.executeJavaScript(code);
  const shot = async (name, rect) => { const img = await w.webContents.capturePage(rect); fs.writeFileSync(path.join(out, name + '.png'), img.toPNG()); console.log('shot', name); };
  w.setSize(1600, 1000);
  await wait(2500);
  await js("document.querySelector('#dkSide [data-go=portfolio]').click()");
  await wait(1200);
  await shot('pf-1-empty');
  /* the add-a-project chooser */
  await js("document.querySelector('[data-pf-act=add]').click()"); await wait(600);
  await shot('pf-2-add-project');
  await js("window.Morfis.page().closeModal()"); await wait(300);
  /* three projects, as a person would add them: picked from the app, details edited, pictures added */
  const P = (n) => path.join(pics, n + '.jpg');
  const plan = [
    { from: 'ex-galle', imgs: ['cafe-1', 'cafe-5', 'cafe-3', 'cafe-4', 'cafe-2'], set: { role: 'Architecture and interiors', status: 'Completed 2026', text: 'A coffee house in a restored Dutch-period shophouse inside Galle Fort. The thick lime-plastered walls stay; a new timber mezzanine sits free of them, so the old fabric can still breathe.\n\nDaylight comes from a reopened courtyard at the back, shaded by louvres in reclaimed jak, and the long narrow plan steps down to it like the street outside.' } },
    { from: 1, imgs: ['villa-1', 'villa-2', 'villa-3', 'villa-4', 'villa-5'], set: { role: 'Architecture', status: 'Under construction', text: 'Five pavilions under one long roof, set into the slope so each room looks out over the paddy fields. Deep eaves and cross-ventilated plans keep the house cool without air conditioning.' } },
    { from: 2, imgs: ['clinic-2', 'clinic-3', 'clinic-4', 'clinic-1'], set: { role: 'Interior architecture', status: 'Completed 2025', text: 'A calm, light clinic for a family dental practice: one timber wall runs the length of the plan and holds the storage, so the treatment rooms stay clear and easy to clean.' } }
  ];
  const ids = await js("Object.keys(window.Morfis.page().S.projects)");
  for (const it of plan) {
    const pid = typeof it.from === 'string' ? it.from : ids.filter((x) => x !== 'ex-galle')[it.from - 1];
    await js("document.querySelector('[data-pf-act=add]').click()"); await wait(400);
    await js("document.querySelector('[data-pf-from=\"p:" + pid + "\"]').click()"); await wait(500);
    const files = JSON.stringify(it.imgs.map(P));
    await js("(async function(){var D=window.MorfisPortfolio.data(),it=D.items[D.items.length-1];var a=await window.MorfisPortfolio.addImages(" + files + ");it.imgs=a;it.main=a[0].c;Object.assign(it," + JSON.stringify(it.set) + ");it.ed={text:1};return a.length})()");
  }
  /* the cover and the about page */
  await js("(async function(){var D=window.MorfisPortfolio.data();var a=await window.MorfisPortfolio.addImages(" + JSON.stringify([P('villa-3'), P('cafe-2')]) + ");D.cover=a[0];D.aboutImg=a[1];" +
    "D.about='Seedform is an architecture studio in Colombo. Every project starts from one clear idea, found in the site, the climate and the people who will use it, and grows from there.\\n\\nWe work on homes, places to eat and stay, and small public buildings across Sri Lanka, from the first sketch to the last day on site.\\n\\nThe work here is a small selection from the last few years.';" +
    "D.contact.email='hello@seedform.lk';D.contact.phone='+94 77 000 0000';D.contact.website='seedform.lk';D.contact.address='Colombo, Sri Lanka';" +
    "await window.Morfis.H.kvSet('portfolio',D);return 1})()");
  await js("window.MorfisPortfolio.reload()"); await wait(400);
  await js("document.querySelector('#dkSide [data-go=home]').click()"); await wait(400);
  await js("document.querySelector('#dkSide [data-go=portfolio]').click()"); await wait(2500);
  await shot('pf-3-editor-cover');
  const first = await js("window.MorfisPortfolio.data().items[0].id");
  await js("document.querySelector('[data-pf-sel=\"" + first + "\"]').click()"); await wait(1500);
  await shot('pf-4-editor-project');
  await js("document.querySelector('#dkView').scrollTop=600"); await wait(800);
  await shot('pf-5-editor-scrolled');
  /* reorder by dragging: the clinic's row dropped above the first project; pages, contents and numbers follow */
  await js("document.querySelector('#dkView').scrollTop=0");
  const before = await js("window.MorfisPortfolio.data().items.map(function(i){return i.title}).join(' | ')");
  await js("(function(){var D=window.MorfisPortfolio.data(),src=document.querySelector('[data-pf-drag=\"'+D.items[2].id+'\"]'),dst=document.querySelector('[data-pf-drag=\"'+D.items[0].id+'\"]');" +
    "var dt=new DataTransfer(),r=dst.getBoundingClientRect(),o={bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.left+20,clientY:r.top+3};" +
    "src.dispatchEvent(new DragEvent('dragstart',o));dst.dispatchEvent(new DragEvent('dragover',o));dst.dispatchEvent(new DragEvent('drop',o));src.dispatchEvent(new DragEvent('dragend',o));})()");
  await wait(400);
  const after = await js("window.MorfisPortfolio.data().items.map(function(i){return i.title}).join(' | ')");
  console.log('order before:', before); console.log('order after drag:', after);
  /* a project renamed in the app: the portfolio follows, the contents too */
  const ref = await js("window.MorfisPortfolio.data().items[0].ref");
  await js("(function(){var pg=window.Morfis.page(),p=pg.P('" + ref + "');p.name='Ratnayake Family Dental';pg.commit(p);})()"); await wait(900);
  await js("document.querySelector('#dkSide [data-go=home]').click()"); await wait(300);
  await js("document.querySelector('#dkSide [data-go=portfolio]').click()"); await wait(1500);
  await js("document.querySelector('[data-pf-sel=contents]').click()"); await wait(1500);
  const followed = await js("window.MorfisPortfolio.data().items[0].title");
  console.log('after renaming the project:', followed);
  await shot('pf-6-reordered-contents');
  if (!/^Ratnayake/.test(after) || followed !== 'Ratnayake Family Dental') errors.push('drag or follow did not work');
  /* the PDF */
  const pdf = path.join(out, 'Seedform Portfolio.pdf');
  const r = await js("window.Morfis.H.savePortfolioPdf(window.MorfisPortfolio.html('pdf'),'__test__:" + pdf.replace(/\\/g, '/') + "')");
  console.log('pdf', JSON.stringify(r), 'expected pages', await js('window.MorfisPortfolio.pages()'));
  console.log('page errors:', errors.length ? errors.join(' | ') : 'none');
  console.log(r && r.pages === (await js('window.MorfisPortfolio.pages()')) && !errors.length ? 'DEMO PASSED' : 'DEMO FAILED');
  app.exit(0);
});
