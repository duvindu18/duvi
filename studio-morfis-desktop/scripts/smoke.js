'use strict';
/* Starts the real app with a throwaway profile, optionally seeded with a backup file, clicks through the main views
   and saves screenshots. Usage: electron scripts/smoke.js <out-dir> [backup.json]
   (on Linux CI: xvfb-run -a npx electron --no-sandbox scripts/smoke.js out) */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const args = process.argv.slice(process.argv.findIndex((a) => /smoke\.js$/.test(a)) + 1).filter((a) => !a.startsWith('--'));
const out = path.resolve(args[0] || 'smoke-out');
const seed = args[1] ? JSON.parse(fs.readFileSync(args[1], 'utf8')) : null;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'morfis-smoke-'));
app.setPath('userData', profile);
fs.mkdirSync(out, { recursive: true });
if (seed) {
  const dir = path.join(profile, 'data', 'projects');
  fs.mkdirSync(dir, { recursive: true });
  const list = Array.isArray(seed.projects) ? seed.projects : Object.values(seed.projects || {});
  list.forEach((p) => fs.writeFileSync(path.join(dir, p.id + '.json'), JSON.stringify(p)));
  if (seed.settings) fs.writeFileSync(path.join(profile, 'data', 'settings.json'), JSON.stringify(seed.settings));
}
fs.writeFileSync(path.join(profile, 'desktop.json'), JSON.stringify({ splash: true }));

const errors = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(w, name) { const img = await w.webContents.capturePage(); fs.writeFileSync(path.join(out, name + '.png'), img.toPNG()); console.log('shot', name); }
const js = (w, code) => w.webContents.executeJavaScript(code);

/* a stand-in for Ollama on its usual port, so the AI paths run without downloading a model */
const fake = require('http').createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen2.5:3b', size: 1 }] }));
    if (req.url === '/api/version') return res.end(JSON.stringify({ version: 'smoke' }));
    if (req.url === '/api/chat') {
      const j = JSON.parse(body || '{}');
      const content = j.format === 'json'
        ? JSON.stringify({ items: [{ desc: 'Concept design', detail: 'Two options with sketches', qty: 1, unit: 'lump sum', rate: 450000 }, { desc: '3D renders', detail: 'Four interior views', qty: 4, unit: 'item', rate: 35000 }], notes: 'Assumes two rounds of changes.' })
        : '• Two invoices are overdue: call both clients this week.\n• Ratnayake Dental Clinic has three late tasks.';
      return res.end(JSON.stringify({ message: { content: content } }));
    }
    res.statusCode = 404; res.end('{}');
  });
});
fake.on('error', () => console.log('fake AI engine not started (port in use)'));
fake.listen(11434, '127.0.0.1');

require('../src/shell/main.js');
app.whenReady().then(async () => {
  await wait(300);
  const sp = BrowserWindow.getAllWindows().find((w) => /splash\.html/.test(w.webContents.getURL()));
  if (sp) { await wait(450); await shot(sp, '0-splash'); } else console.log('no splash window');
  let w = null;
  for (let i = 0; i < 60 && !w; i++) { await wait(250); w = BrowserWindow.getAllWindows().find((x) => /^morfis:/.test(x.webContents.getURL()) && x.isVisible()); }
  if (!w) { console.error('main window never showed'); app.exit(1); return; }
  w.webContents.on('console-message', (e) => { const m = e.message || ''; if (e.level === 'error' || /Uncaught|Error/.test(m)) errors.push(m); });
  w.setSize(1440, 900);
  await wait(2500);
  await shot(w, '1-home');
  const go = async (view, name) => { await js(w, "(function(){var b=document.querySelector('#dkSide [data-go=" + view + "]');if(b){b.click();return true}return false})()").then((ok) => { if (!ok) console.log('no nav button for', view); }); await wait(900); await shot(w, name); };
  await go('projects', '2-projects');
  await go('timeline', '3-timeline');
  await go('payments', '4-payments');
  await go('files', '5-files');
  const firstPid = await js(w, "(function(){var b=document.querySelector('#dkView .fx-card[data-go-node]');if(b){b.click();return b.dataset.goNode}return ''})()");
  await wait(900); await shot(w, '5b-files-project');
  await go('documents', '5c-documents');
  await js(w, "(function(){var b=document.querySelector('#dkView [data-doc-new=quote]');b.click();})()"); await wait(300);
  await js(w, "(function(){var b=document.querySelector('.dk-menu button[data-i]');b.click();})()"); await wait(900);
  const edOk = await js(w, "(function(){var d=document.querySelector('#dkView .pp-edit .pp-desc');if(!d)return 'no editor';d.value='Concept design and 3D views';d.dispatchEvent(new Event('input',{bubbles:true}));var r=document.querySelector('#dkView .pp-edit [data-l=rate]');r.value='250000';r.dispatchEvent(new Event('input',{bubbles:true}));return document.querySelector('#dkView .pp-grand b').textContent})()");
  console.log('editor total after typing:', edOk);
  await wait(800); await shot(w, '5d-editor');
  await go('automations', '5e-automations');
  await go('settings', '6-settings');
  const card = await js(w, "(function(){var c=document.getElementById('dkCard');if(!c)return 'missing';c.scrollIntoView();return 'ok'})()");
  console.log('desktop card:', card);
  await wait(500); await shot(w, '7-desktop-card');
  await js(w, "document.querySelector('#dkCard [data-dk=controls][data-v=windows]').click()"); await wait(500);
  await js(w, "document.getElementById('view').scrollTop=0"); await wait(300); await shot(w, '8-classic-controls');
  await js(w, "document.querySelector('#dkCard [data-dk=controls][data-v=mac]').click()"); await wait(500);
  await js(w, "document.getElementById('view').scrollTop=0"); await wait(300); await shot(w, '9-mac-controls');
  await js(w, "document.querySelector('#dkCard [data-dk=controls][data-v=pill]').click()"); await wait(300);
  await js(w, "document.querySelector('[data-act=toggleTheme]').click()"); await wait(700);
  await go('home', '10-home-light');
  const bar = await js(w, "JSON.stringify({wbar:!document.getElementById('wbar').hidden,title:document.getElementById('wbarTitle').textContent,cls:document.documentElement.className,mode:document.querySelector('.rail-logo')?'ok':'no-rail'})");
  console.log('window bar:', bar);
  await js(w, "document.querySelector('[data-act=winMax]').click()"); await wait(600);
  console.log('after maximize click:', await js(w, "document.documentElement.classList.contains('win-max')"));
  console.log('map library loaded:', await js(w, '!!(window.L && window.L.map)'));

  /* real folders: create, scan, sort, undo, rename, move, new folder; all through the same bridge the page uses */
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'morfis-folders-')), proj = path.join(base, 'MRF I 26 I 099 I Test House');
  fs.mkdirSync(proj);
  ['plan_ground_floor.dwg', 'invoice-01.pdf', 'IMG_20260411_101500.jpg', 'notes.txt'].forEach((n) => fs.writeFileSync(path.join(proj, n), 'x'));
  const ops = await js(w, '(async function(base, proj){' +
    'var H=window.morfisDesktop,o={},sep=proj.indexOf("\\\\")>=0?"\\\\":"/";' +
    'o.mk=(await H.mkdirs(FOLDER_TEMPLATES.map(function(f){return proj+sep+f.name}))).every(function(r){return r.ok});' +
    'o.loose0=(await H.scanProject(proj)).looseCount;' +
    'var t=await H.listTree(proj,{cap:15000}),plan=planArrangement(t.entries,{});o.planned=plan.ops.length;' +
    'var ap=await H.applyOps(proj,plan.ops.map(function(x){return{from:x.from,to:x.to}}),"move","Sort test");o.moved=ap.moved;' +
    'var sc=await H.scanProject(proj);o.loose1=sc.looseCount;o.in03=sc.subs["03"].count;o.in05=sc.subs["05"].count;o.in06=sc.subs["06"].count;' +
    'o.undo=(await H.undo(ap.id)).restored;o.loose2=(await H.scanProject(proj)).looseCount;o.undoAgain=(await H.undo(ap.id)).already;' +
    'var rn=await H.renameItem(base,proj.split(sep).pop(),"Renamed House");o.renamed=rn.rel;o.renameBack=(await H.undo(rn.id)).restored;' +
    'await H.makeDir(proj,"02_Schematics_and_3D","Concepts");' +
    'var mv=await H.moveItems(proj,["notes.txt"],"02_Schematics_and_3D/Concepts","Move test");o.movedNotes=mv.moved;' +
    'o.listed=(await H.listDir(proj,"02_Schematics_and_3D/Concepts")).entries.map(function(e){return e.name}).join(",");' +
    'try{await H.listDir(proj,"nope")}catch(e){o.enoent=e.code}' +
    'try{await H.renameItem(proj,"invoice-01.pdf","bad:name")}catch(e){o.badName=e.message}' +
    'o.rows=(await H.scanRoot(base)).rows.length;' +
    'return JSON.stringify(o)})(' + JSON.stringify(base) + ',' + JSON.stringify(proj) + ')');
  console.log('folder ops:', ops);

  /* app name typed into Settings, then a custom icon: the window title follows */
  await go('settings', '11-settings-again');
  await js(w, "(function(){var i=document.getElementById('br-name');i.value='Morfis Atelier';i.dispatchEvent(new Event('change',{bubbles:true}))})()");
  await wait(800);
  const ic = 'data:image/png;base64,' + require('electron').nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png')).resize({ width: 256, height: 256 }).toPNG().toString('base64');
  const br = await js(w, 'window.morfisDesktop.setBranding({name:"Morfis Atelier",icon:' + JSON.stringify(ic) + '})');
  await wait(400);
  const dp = JSON.parse(fs.readFileSync(path.join(profile, 'desktop.json'), 'utf8'));
  console.log('branding:', JSON.stringify({ windowTitle: w.getTitle(), docTitle: await js(w, 'document.title'), bar: await js(w, "document.getElementById('wbarTitle').textContent"), saved: dp.branding, icoWritten: fs.existsSync(path.join(profile, 'branding', dp.branding.iconFile + '.ico')), setResult: br }));
  await js(w, "document.getElementById('view').scrollTop=0"); await wait(300); await shot(w, '12-renamed');
  /* AI: quotation lines, Monday summary; PDF of the quotation; Explorer status icons */
  await go('automations', '13-automations');
  await wait(1200);
  const qid = await js(w, "(function(){var d=MorfisDocs.blank('quote',null);MorfisDocs.save(d,true);window.__q=d;MorfisAuto.draftQuote(d,function(){window.__qdone=true});return d.id})()");
  await wait(400);
  await js(w, "document.getElementById('auQ').value='Interior design for a clinic';document.getElementById('auQGo').click()");
  await wait(2500);
  const quote = JSON.parse(await js(w, "JSON.stringify({done:!!window.__qdone,lines:window.__q.items.length,total:MorfisDocs.totals(window.__q).total,notes:window.__q.notes})"));
  console.log('AI quotation:', JSON.stringify(quote));
  await js(w, "MorfisAuto.run('digest')"); await wait(2500);
  const digest = await js(w, "morfisDesktop.kvGet('auto:digest').then(function(d){return d?d.text:''})");
  console.log('AI digest:', JSON.stringify(digest));
  await go('automations', '14-automations-ai');
  const html = await js(w, "MorfisDocs.printHtml(window.__q)");
  const pw = new BrowserWindow({ show: false, width: 794, height: 1123, webPreferences: { javascript: false } });
  await pw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const pdf = await pw.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'none' }, preferCSSPageSize: true });
  fs.writeFileSync(path.join(out, 'quotation.pdf'), pdf);
  fs.writeFileSync(path.join(out, '15-quotation-print.png'), (await pw.webContents.capturePage()).toPNG());
  pw.destroy();
  console.log('PDF bytes:', pdf.length);
  for (const st of ['in_progress', 'on_hold', 'completed']) {
    const u = await js(w, "MorfisArt.toPng(MorfisArt.explorerIcon('" + st + "'),256)");
    fs.writeFileSync(path.join(out, 'icon-' + st + '.png'), Buffer.from(u.split(',')[1], 'base64'));
  }
  fake.close();

  console.log('page errors:', errors.length ? errors : 'none');
  const pdir = path.join(profile, 'data', 'projects');
  console.log('saved files:', fs.existsSync(pdir) ? fs.readdirSync(pdir).length : 0, 'projects,', fs.existsSync(path.join(profile, 'data', 'settings.json')) ? 'settings ok' : 'no settings');

  const o = JSON.parse(ops), fails = [];
  const expect = (ok, what) => { if (!ok) fails.push(what); };
  expect(!errors.length, 'no page errors');
  expect(card === 'ok', 'Desktop app card on the Settings page');
  expect(o.mk && o.loose0 === 4 && o.planned === 3 && o.moved === 3 && o.loose1 === 1, 'sorting loose files into the six folders');
  expect(o.undo === 3 && o.loose2 === 4 && o.undoAgain === true, 'undoing the sort');
  expect(o.renamed === 'Renamed House' && o.renameBack === 1, 'renaming a project folder and undoing it');
  expect(o.movedNotes === 1 && o.listed === 'notes.txt', 'new folder and moving a file into it');
  expect(o.enoent === 'ENOENT' && !!o.badName && o.rows === 1, 'error codes, name checks and reading the root');
  expect(quote.done && quote.lines === 2 && quote.total === 590000, 'AI quotation assistant');
  expect(/overdue/.test(digest || ''), 'AI Monday summary');
  expect(pdf.length > 5000, 'quotation PDF');
  expect(edOk === 'LKR 250,000', 'editor totals while typing');
  expect(w.getTitle() === 'Morfis Atelier' && fs.existsSync(path.join(profile, 'branding', dp.branding.iconFile + '.ico')), 'app name and icon');
  console.log(fails.length ? 'SMOKE FAILED: ' + fails.join('; ') : 'SMOKE PASSED');
  app.exit(fails.length ? 1 : 0);
});
