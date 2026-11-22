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
/* the example studio from the dashboard, unless another backup file is given */
const seed = JSON.parse(fs.readFileSync(args[1] || path.join(__dirname, 'fixtures', 'sample-studio.json'), 'utf8'));
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

/* a failed step or a stall must end the run, never leave it waiting */
process.on('unhandledRejection', (e) => { console.error('SMOKE FAILED (error): ' + ((e && e.stack) || e)); app.exit(1); });
setTimeout(() => { console.error('SMOKE FAILED: timed out after 6 minutes'); app.exit(2); }, 6 * 60 * 1000).unref();

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
  await js(w, "document.querySelector('#wbarSide').click()"); await wait(500); await shot(w, '1b-side-collapsed');
  await js(w, "document.querySelector('#wbarSide').click()"); await wait(400);
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

  /* built-in preview: one sample file of each kind, in a real project folder shown in Files */
  const pv = path.join(base, 'MRF I 26 I 017 I Ratnayake Dental Clinic'), pv02 = path.join(pv, '02_Schematics_and_3D');
  fs.mkdirSync(pv02, { recursive: true });
  ['01_Brief_and_Site_Data', '03_Working_Drawings', '04_Schedules_BOQ', '05_Financials_and_Contracts', '06_Site_Photos_and_Minutes'].forEach((n) => fs.mkdirSync(path.join(pv, n), { recursive: true }));
  fs.writeFileSync(path.join(pv02, 'Reception_render.png'), require('electron').nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png')).resize({ width: 1200, height: 1200 }).toPNG());
  fs.copyFileSync(path.join(out, 'quotation.pdf'), path.join(pv02, 'Quotation_QT-2026-002.pdf'));
  fs.writeFileSync(path.join(pv02, 'Finishes_schedule.csv'), 'Room,Floor,Walls,Ceiling\nReception,Terrazzo,Lime plaster,Gypsum\n"Treatment 1",Vinyl,"Washable paint, white",Gypsum\nLab,Vinyl,Tile,Mineral fibre\n');
  fs.writeFileSync(path.join(pv02, 'model_settings.json'), '{"units":"mm","levels":[0,3200],"north":12}');
  fs.writeFileSync(path.join(pv02, 'Meeting_notes.md'), '# Site meeting 12 Oct\n- Client wants a second sink in Treatment 1\n- Confirm the lab extract route\n');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'sample-brief.docx'), path.join(pv02, 'Client_brief.docx'));
  fs.writeFileSync(path.join(pv02, 'Ground_floor.dwg'), 'AC1032 not a real drawing');
  const pid = await js(w, "(function(){var pg=window.__morfisPage,p=Object.values(pg.S.projects).find(function(x){return /Ratnayake/.test(x.name)});p.folderPath=" + JSON.stringify(pv) + ";p.foldersCreated=pg.today();pg.commit(p);return p.id})()");
  await js(w, "MorfisFiles.open(" + JSON.stringify(pid) + ")"); await wait(1500);
  await js(w, "(function(){var b=document.querySelector('#dkView [data-go-node$=\"|02\"]');b.click();})()"); await wait(1200);
  await js(w, "(function(){var b=document.querySelector('#dkView [data-layout=grid]');if(b)b.click();})()"); await wait(1500);
  await shot(w, '16-files-thumbnails');
  /* three dots on folder cards: project folder menu, then New folder inside a standard folder through the dialog */
  await js(w, "MorfisFiles.open(" + JSON.stringify(pid) + ")"); await wait(1200);
  const dotsCount = await js(w, "document.querySelectorAll('#dkView .fx-card .fx-more').length");
  await js(w, "document.querySelector('#dkView .fx-card .fx-more[data-card-menu^=\"f:\"][data-card-menu$=\"|02\"]').click()"); await wait(400);
  await shot(w, '16b-folder-menu');
  const menuItems = await js(w, "Array.from(document.querySelectorAll('.dk-menu button')).map(function(b){return b.textContent.trim()}).join(' | ')");
  await js(w, "Array.from(document.querySelectorAll('.dk-menu button')).find(function(b){return /New folder inside/.test(b.textContent)}).click()"); await wait(400);
  await js(w, "(function(){var i=document.getElementById('fxAsk');i.value='Concept options';document.getElementById('fxAskOk').click();})()"); await wait(1200);
  const madeDir = fs.existsSync(path.join(pv02, 'Concept options'));
  console.log('folder menu:', JSON.stringify({ dots: dotsCount, items: menuItems, madeDir: madeDir }));
  await js(w, "(function(){var b=document.querySelector('#dkView [data-go-node$=\"|02\"]');b.click();})()"); await wait(1200);
  const kinds = {};
  const look = async (name, probe, shotName) => {
    await js(w, "MorfisPreview.open(" + JSON.stringify(path.join(pv02, name)) + ", Array.from(document.querySelectorAll('#dkView .fx-main [data-file]')).map(function(r){return r.dataset.file}))");
    await wait(1800);
    kinds[name] = await js(w, probe);
    if (shotName) await shot(w, shotName);
  };
  await look('Reception_render.png', "(function(){var i=document.querySelector('.pv .pv-img');return !!(i&&i.naturalWidth===1200)})()", '17-preview-image');
  await look('Quotation_QT-2026-002.pdf', "!!document.querySelector('.pv iframe.pv-frame')", '18-preview-pdf');
  await look('Finishes_schedule.csv', "document.querySelectorAll('.pv .pv-table tbody tr').length===3&&/Washable paint, white/.test(document.querySelector('.pv .pv-table').textContent)", '19-preview-csv');
  await look('model_settings.json', "/\"units\": \"mm\"/.test(document.querySelector('.pv .pv-pre').textContent)");
  await look('Meeting_notes.md', "/second sink/.test(document.querySelector('.pv .pv-pre').textContent)");
  await look('Client_brief.docx', "(function(){var f=document.querySelector('.pv iframe.pv-frame');return !!(f&&/Two treatment rooms/.test(f.srcdoc||''))})()", '20-preview-docx');
  await look('Ground_floor.dwg', "!!document.querySelector('.pv .pv-none .btn')", '21-preview-other');
  /* the file before Ground_floor.dwg in the order on screen */
  const before = await js(w, "(function(){var l=Array.from(document.querySelectorAll('#dkView .fx-main [data-file]')).map(function(r){return r.dataset.file.split(/[\\\\/]/).pop()}).filter(function(v,i,a){return a.indexOf(v)===i});var i=l.indexOf('Ground_floor.dwg');return l[(i-1+l.length)%l.length]})()");
  await js(w, "document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))"); await wait(900);
  kinds.arrows = await js(w, "document.querySelector('.pv .pv-file b').textContent") === before;
  await js(w, "MorfisPreview.close()");
  /* project folder setup: switch 04 off, rename 03 on disk, add a folder of our own; then delete 05 of one project */
  await js(w, "MorfisFolders.openSetup(); true"); await wait(500);
  await js(w, "(function(){var rows=document.querySelectorAll('#overlay .fs-row');" +
    "rows[3].querySelector('[data-fs=on]').checked=false;" +
    "var n=rows[2].querySelector('[data-fs=name]');n.value='03_Drawings';" +
    "document.getElementById('fsAdd').click();" +
    "var last=document.querySelector('#overlay .fs-row:last-child [data-fs=label]');last.value='Client correspondence';last.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await wait(300); await shot(w, '22-folder-setup');
  await js(w, "document.getElementById('fsOk').click()"); await wait(3500);
  const setup = JSON.parse(await js(w, "JSON.stringify({ids:FOLDER_TEMPLATES.map(function(t){return t.id}),names:FOLDER_TEMPLATES.map(function(t){return t.name}),scan:Object.keys(window.__morfisPage.P(" + JSON.stringify(pid) + ").folders).filter(function(k){return window.__morfisPage.P(" + JSON.stringify(pid) + ").folders[k].exists})})"));
  setup.disk = fs.readdirSync(pv).sort();
  console.log('folder setup:', JSON.stringify(setup));
  await js(w, "MorfisFolders.deleteStandard(" + JSON.stringify(pid) + ", '05'); true"); await wait(400);
  await shot(w, '23-delete-folder');
  await js(w, "document.getElementById('fsOk').click()"); await wait(1500);
  const del05 = !fs.existsSync(path.join(pv, '05_Financials_and_Contracts'));
  console.log('delete 05 moved to Recycle Bin:', del05, '(Linux test machines may have no Recycle Bin)');
  await js(w, "MorfisFiles.open(" + JSON.stringify(pid) + ")"); await wait(1200); await shot(w, '24-files-after-setup');
  console.log('preview:', JSON.stringify(kinds));
  const menuOk = madeDir;
  for (const v of [{ status: 'in_progress', count: 3, kinds: ['PDF'] }, { status: 'completed', count: 0 }, { num: '03', count: 5, kinds: ['DWG'] }, { num: '06', count: 0 }]) {
    const u = await js(w, "MorfisArt.toPng(MorfisArt.explorerIcon(" + JSON.stringify(v) + "),256)");
    fs.writeFileSync(path.join(out, 'xicon-' + (v.status || v.num) + '.png'), Buffer.from(u.split(',')[1], 'base64'));
  }

  /* version 1.3: New project only on Home and Projects, Reminder settings, the accent picker, custom automations, empty Files filters */
  await go('settings', '25-settings-newproj');
  const extra = JSON.parse(await js(w, '(async function(){' +
    'var o={},nb=document.querySelector(".top>[data-act=newProject]"),wait=function(ms){return new Promise(function(r){setTimeout(r,ms)})};' +
    'o.newOnSettings=getComputedStyle(nb).display!=="none";' +
    'document.querySelector("#dkSide [data-go=projects]").click();await wait(300);o.newOnProjects=getComputedStyle(nb).display!=="none";' +
    'window.__morfisPage.openReminders();await wait(300);var ov=document.getElementById("overlay");o.overlayTop=ov.getBoundingClientRect().top;' +
    'var rb=ov.querySelector("[data-act=remSettings]");o.remBtn=!!rb;if(rb)rb.click();await wait(500);' +
    'o.remClosed=ov.hidden;o.remView=window.__morfisPage.S.ui.view;o.remCard=!!document.getElementById("remCard");' +
    'var pick=document.getElementById("lk-pick");pick.click();await wait(150);var cp=document.querySelector(".dk-cp");o.picker=!!cp;' +
    'if(cp){var hex=cp.querySelector(".dk-cp-hex");hex.value="#2E9E6A";hex.dispatchEvent(new Event("input",{bubbles:true}));await wait(100);cp.querySelector("[data-cp=ok]").click();await wait(400);}' +
    'o.accent=window.__morfisPage.S.settings.accent;o.accentVar=getComputedStyle(document.documentElement).getPropertyValue("--accent-fill").trim();o.mono=document.documentElement.classList.contains("style-mono");' +
    'return JSON.stringify(o)})().catch(function(e){return JSON.stringify({err:String(e&&e.stack||e)})})'));
  await shot(w, '26-accent-picked');
  await go('automations', '27-automations-own');
  const own = JSON.parse(await js(w, '(async function(){' +
    'var o={},wait=function(ms){return new Promise(function(r){setTimeout(r,ms)})},pg=window.__morfisPage;' +
    'document.querySelector("#dkView [data-au-new]").click();await wait(300);' +
    'document.querySelector("#overlay [data-preset]").click();await wait(300);' +
    'o.editor=!!document.getElementById("auSave");document.getElementById("auSave").click();await wait(400);' +
    'o.cards=document.querySelectorAll("#dkView .au-own").length;' +
    'var p=Object.values(pg.S.projects).filter(function(x){return MorfisArt.statusOf(x,pg.today())!=="completed"})[0];o.pname=p.name;' +
    'var before=(pg.S.settings.reminders||[]).length;Morfis.setWorkStatus(p.id,"completed");await wait(2500);' +
    'var rem=(pg.S.settings.reminders||[]).slice(before);o.added=rem.length;o.text=rem[0]?rem[0].title:"";' +
    'Morfis.setWorkStatus(p.id,"in_progress");await wait(600);' +
    'return JSON.stringify(o)})().catch(function(e){return JSON.stringify({err:String(e&&e.stack||e)})})'));
  await wait(400); await shot(w, '28-automation-made');
  await js(w, "document.querySelector('#dkView [data-au-edit]').click()"); await wait(400); await shot(w, '29-automation-editor');
  await js(w, "window.__morfisPage.closeModal()");
  await go('files', '30-files-all');
  const filesEmpty = await js(w, '(async function(){var b=document.querySelector("#dkView [data-filter=completed]");b.click();await new Promise(function(r){setTimeout(r,300)});var e=document.querySelector("#dkView .fx-main .fx-empty-col, #dkView .fx-main .fx-card");return e?e.className:"none"})()');
  await shot(w, '31-files-filter');
  console.log('v1.3 checks:', JSON.stringify(extra), JSON.stringify(own), filesEmpty);

  /* freelance: a job with its brief, deliverables and folder; a studio project moved to Freelance */
  await go('freelance', '50-freelance-empty');
  const fl = JSON.parse(await js(w, '(async function(){var o={},wait=function(ms){return new Promise(function(r){setTimeout(r,ms)})};' +
    'try{' +
    'var j=MorfisFreelance.newJob({title:"Living room renders",client:"Anna K.",platform:"Fiverr",fee:45000,brief:"Model the living room from the plan, 4 renders, day light."});await wait(600);' +
    'o.page=!!document.querySelector("#dkView .fl-h1");' +
    'document.querySelector("#dkView [data-fl-add=drawing]").click();await wait(200);' +
    'var cb=document.querySelector("#dkView .fl-del [data-fl-d=done]");cb.checked=true;cb.dispatchEvent(new Event("change",{bubbles:true}));await wait(200);' +
    'var p=document.querySelector("#dkView [data-fl-f=paid]");p.value="20000";p.dispatchEvent(new Event("change",{bubbles:true}));await wait(200);' +
    'document.querySelector("#dkView [data-fl-act=mkdir]").click();await wait(1200);' +
    'var jj=MorfisFreelance.all().find(function(x){return x.id===j.id});o.dels=jj.deliverables.length;o.done=jj.deliverables.filter(function(x){return x.done}).length;o.paid=jj.paid;o.folder=jj.folder;o.made=!!jj.folderMade;' +
    'await wait(600);o.saved=(await window.morfisDesktop.kvGet("freelance:jobs")).length;' +
    'window.confirm=function(){return true};var pg=window.__morfisPage,before=Object.keys(pg.S.projects).length,pid=Object.keys(pg.S.projects)[0];' +
    'var m=MorfisFreelance.fromProject(pid);await wait(800);o.moved=!!m&&!pg.P(pid)&&Object.keys(pg.S.projects).length===before-1;o.jobs=MorfisFreelance.all().length;' +
    'document.querySelector("#dkView [data-fl-act=back]").click();await wait(500);o.cards=document.querySelectorAll("#dkView .fl-card").length;' +
    '}catch(e){o.err=String(e&&e.stack||e)}return JSON.stringify(o)})()'));
  await shot(w, '51-freelance-list');
  await js(w, "document.querySelector('#dkView [data-fl-open]').click()"); await wait(600); await shot(w, '52-freelance-job');
  fl.onDisk = !!fl.folder && fs.existsSync(path.join(fl.folder, '03_Drawings'));
  console.log('freelance:', JSON.stringify(fl));

  /* phone access: pair, open the phone page, and check that changes travel both ways */
  const phone = {};
  const nProjects = await js(w, 'Object.keys(window.__morfisPage.S.projects).length');
  {
  const pst = JSON.parse(await js(w, "window.morfisDesktop.remoteSet(true).then(function(r){return JSON.stringify(r)})"));
  phone.on = pst.on; phone.err = pst.error;
  const pbase = 'http://127.0.0.1:' + pst.port;
  const phttp = require('http');
  const req = (method, url, body, headers) => new Promise((resolve, reject) => {
    const r = phttp.request(pbase + url, { method: method, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d })); });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
  phone.ping = JSON.parse((await req('GET', '/ping')).body).app;
  phone.unpaired = (await req('POST', '/api/storeLoad', '{"args":[]}')).status;
  phone.pairPage = /type the PIN/.test((await req('GET', '/app')).body);
  phone.wrongPin = JSON.parse((await req('POST', '/pair', JSON.stringify({ pin: '000000' === pst.pin ? '111111' : '000000', name: 'x' }))).body).ok;
  const paired = await req('POST', '/pair', JSON.stringify({ pin: pst.pin, name: 'Smoke phone' }));
  const cookie = String((paired.headers['set-cookie'] || [''])[0]).split(';')[0];
  phone.paired = JSON.parse(paired.body).ok && /^morfis_dev=[a-f0-9]{64}$/.test(cookie);
  phone.projects = Object.keys(JSON.parse((await req('POST', '/api/storeLoad', '{"args":[]}', { cookie: cookie })).body).v.projects).length;
  /* the Android app's way in: its own page address, a key in a header */
  const AO = { origin: 'http://studio.morfis' };
  const pre = await req('OPTIONS', '/api/storeLoad', null, AO);
  phone.cors = pre.status === 204 && pre.headers['access-control-allow-origin'] === AO.origin && /x-morfis-key/.test(pre.headers['access-control-allow-headers'] || '');
  const st2 = JSON.parse(await js(w, "window.morfisDesktop.remoteStatus().then(function(r){return JSON.stringify(r)})"));
  const ap = JSON.parse((await req('POST', '/pair', JSON.stringify({ pin: st2.pin, name: 'App phone' }), AO)).body);
  phone.appKey = /^[a-f0-9]{64}$/.test(ap.key || '') && !!ap.id;
  phone.appCall = Object.keys(JSON.parse((await req('POST', '/api/storeLoad', '{"args":[]}', Object.assign({ 'x-morfis-key': ap.key || '' }, AO))).body).v.projects).length === nProjects;
  phone.appTree = JSON.parse((await req('POST', '/api/syncTree', JSON.stringify({ args: [os.tmpdir()] }), { 'x-morfis-key': ap.key || '' })).body).v.exists === true;
  phone.pingId = JSON.parse((await req('GET', '/ping')).body).id === ap.id;
  phone.blocked = /Not available/.test((await req('POST', '/api/saveFile', '{"args":["a.txt",[1]]}', { cookie: cookie })).body);
  /* the phone page itself, in a phone-sized window */
  const { session } = require('electron');
  const ps = session.fromPartition('phone-smoke');
  await ps.cookies.set({ url: pbase, name: 'morfis_dev', value: cookie.split('=')[1], httpOnly: true });
  const phw = new BrowserWindow({ width: 412, height: 880, show: true, webPreferences: { session: ps, sandbox: true, contextIsolation: true } });
  phw.webContents.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 StudioMorfisAndroid/1.0');
  phw.webContents.on('console-message', (e) => { const m = e.message || ''; if (e.level === 'error' || /Uncaught/.test(m)) errors.push('phone: ' + m); });
  await phw.loadURL(pbase + '/app');
  await wait(3500);
  await shot(phw, '40-phone-home');
  const pj = (code) => phw.webContents.executeJavaScript(code);
  phone.remotePage = await pj("!!window.MORFIS_REMOTE && document.documentElement.classList.contains('remote') && !!window.__morfisPage && window.__morfisPage.S.ready");
  await pj("document.querySelector('.rb-menu').click()"); await wait(500); await shot(phw, '41-phone-menu');
  phone.drawer = await pj("getComputedStyle(document.getElementById('dkSide')).transform==='none'");
  await pj("document.querySelector('#dkSide [data-go=files]').click()"); await wait(1500); await shot(phw, '42-phone-files');
  phone.drawerClosed = await pj("!document.documentElement.classList.contains('rb-nav')");
  /* phone -> computer */
  const pid = await pj("Object.keys(window.__morfisPage.S.projects)[0]");
  await pj("Morfis.setWorkStatus(" + JSON.stringify(pid) + ",'on_hold')"); await wait(1500);
  phone.toComputer = await js(w, "window.__morfisPage.P(" + JSON.stringify(pid) + ").workStatus");
  /* computer -> phone */
  await js(w, "Morfis.setWorkStatus(" + JSON.stringify(pid) + ",'in_progress')"); await wait(1500);
  phone.toPhone = await pj("window.__morfisPage.P(" + JSON.stringify(pid) + ").workStatus");
  await pj("document.querySelector('.rb-menu').click()"); await wait(300);
  await pj("document.querySelector('#dkSide [data-go=automations]').click()"); await wait(1500); await shot(phw, '43-phone-automations');
  phone.back = await pj("window.__morfisBack()"); await wait(600);
  phone.backHome = await pj("!Morfis.current() && window.__morfisPage.S.ui.view==='home'");
  phone.devices = JSON.parse(await js(w, "window.morfisDesktop.remoteStatus().then(function(r){return JSON.stringify(r.devices)})")).map((d) => d.name + (d.online ? ' (online)' : '')).join(', ');
  await go('settings', '44-settings-phone');
  await js(w, "(function(){var c=document.querySelector('.dk-phone');if(c)c.scrollIntoView({block:'center'})})()"); await wait(500); await shot(w, '44-settings-phone');
  /* offline: the phone keeps working on its copy, and its changes reach the computer when it is back */
  const off = {};
  for (let i = 0; i < 20 && !(await pj("window.morfisDesktop.offline().folders")); i++) await wait(500);
  const roots = JSON.parse(await pj("JSON.stringify(window.morfisDesktop.offline().roots)"));
  off.folders = roots.length;
  const opid = await pj("(function(){var pg=window.__morfisPage,r=window.morfisDesktop.offline().roots.map(function(x){return x.toLowerCase()});var p=Object.values(pg.S.projects).find(function(p){return r.indexOf(pg.projDir(p).toLowerCase())!==-1});return p?p.id:''})()");
  if (opid) {
    const oroot = await pj("window.__morfisPage.projDir(window.__morfisPage.P(" + JSON.stringify(opid) + "))");
    const sub = await pj("window.__morfisPage.FOLDER_TEMPLATES[0].name");
    await pj("window.__morfisOffline(true)"); await wait(300);
    off.offline = !(await pj("window.morfisDesktop.offline().online"));
    off.made = !!(await pj("window.morfisDesktop.makeDir(" + JSON.stringify(oroot) + "," + JSON.stringify(sub) + ",'Offline folder').then(function(r){return r.path})"));
    off.listed = await pj("window.morfisDesktop.listDir(" + JSON.stringify(oroot) + "," + JSON.stringify(sub) + ").then(function(r){return r.entries.some(function(e){return e.name==='Offline folder'&&e.dir})})");
    off.renamed = await pj("window.morfisDesktop.renameItem(" + JSON.stringify(oroot) + "," + JSON.stringify(sub + '/Offline folder') + ",'Renamed offline').then(function(r){return r.rel})");
    await pj("(function(){var pg=window.__morfisPage,p=pg.P(" + JSON.stringify(opid) + ");p.client=Object.assign({},p.client,{name:'Phone client'});pg.commit(p);Morfis.setWorkStatus(p.id,'on_hold')})()"); await wait(800);
    /* a file added from the phone while offline: kept on the phone, then sent */
    off.added = await pj("new Promise(function(res){var rq=indexedDB.open('morfis-offline');rq.onsuccess=function(){var tx=rq.result.transaction('blobs','readwrite');tx.objectStore('blobs').put({name:'phone-note.txt',type:'text/plain',blob:new Blob(['written on the phone'])},'testblob');tx.oncomplete=function(){res(window.morfisDesktop.copyInto(" + JSON.stringify(path.join(oroot, sub)) + ",['phone-file:testblob/phone-note.txt']).then(function(r){return r.copied}))}}})");
    off.waiting = await pj("window.morfisDesktop.offline().waiting");
    off.notOnPcYet = !fs.existsSync(path.join(oroot, sub, 'Renamed offline'));
    /* meanwhile on the computer: another field of the same project */
    await js(w, "(function(){var pg=window.__morfisPage,p=pg.P(" + JSON.stringify(opid) + ");p.location='Changed on the PC';pg.commit(p)})()"); await wait(800);
    await shot(phw, '45-phone-offline');
    await pj("window.__morfisOffline(false)");
    for (let i = 0; i < 30 && (await pj("window.morfisDesktop.offline().waiting")); i++) await wait(500);
    await wait(1500);
    off.sent = (await pj("window.morfisDesktop.offline().waiting")) === 0;
    off.onDisk = fs.existsSync(path.join(oroot, sub, 'Renamed offline'));
    off.fileSent = fs.existsSync(path.join(oroot, sub, 'phone-note.txt')) && fs.readFileSync(path.join(oroot, sub, 'phone-note.txt'), 'utf8') === 'written on the phone';
    const pc = JSON.parse(await js(w, "JSON.stringify(window.__morfisPage.P(" + JSON.stringify(opid) + "))"));
    off.pcStatus = pc.workStatus; off.pcClient = pc.client && pc.client.name; off.pcLocation = pc.location;
    off.phoneLocation = await pj("window.__morfisPage.P(" + JSON.stringify(opid) + ").location");
    await shot(phw, '46-phone-back-online');
  }
  phone.offline = off;
  phw.destroy();
  await js(w, "window.morfisDesktop.remoteSet(false)");
  }
  console.log('phone access:', JSON.stringify(phone));
  console.log('window title after phone:', w.getTitle(), '|', await js(w, 'document.title'));

  /* a folder that is not a project, brought in by Import (standard folders made, a loose file sorted, an icon):
     "Not a project" takes it all back, and Import no longer offers it */
  const libRoot = path.join(out, 'lib-root'), libDir = path.join(libRoot, 'LIBRARY');
  fs.mkdirSync(path.join(libDir, 'HDRI'), { recursive: true }); fs.writeFileSync(path.join(libDir, 'a.jpg'), 'jpg'); fs.writeFileSync(path.join(libDir, 'HDRI', 'sky.hdr'), 'hdr');
  const np = JSON.parse(await js(w, '(async function(){var o={},pg=window.__morfisPage,H=window.morfisDesktop,wait=function(ms){return new Promise(function(r){setTimeout(r,ms)})};try{' +
    'var dir=' + JSON.stringify(libDir) + ';var src=pg.P(Object.keys(pg.S.projects)[0]);var p=JSON.parse(JSON.stringify(src));p.id="np-lib";p.name="LIBRARY";p.code="MRF I 26 I 099";p.folderPath=dir;p.foldersCreated=pg.today();p.folders={};pg.S.projects[p.id]=p;pg.commit(p);' +
    'await H.mkdirs(pg.FOLDER_TEMPLATES.map(function(t){return Morfis.jn(dir,t.name)}));' +
    'var ap=await H.applyOps(dir,[{from:"a.jpg",to:pg.FOLDER_TEMPLATES[1].name+"/a.jpg"}],"move","Import MRF I 26 I 099");o.sorted=ap.moved;' +
    'o.suspect=MorfisLog.suspects().some(function(x){return x.id==="np-lib"});o.logged=(await H.journalList({under:dir})).length;' +
    'MorfisFiles.open("");await wait(400);o.note=!!document.querySelector("#dkView [data-fx-act=notProjects]");' +
    '}catch(e){o.err=String(e&&e.stack||e)}return JSON.stringify(o)})()'));
  await shot(w, '58-files-not-projects-note');
  await js(w, 'MorfisLog.notProjects()'); await wait(800); await shot(w, '59-not-projects-dialog'); await js(w, 'window.__morfisPage.closeModal()'); await wait(300);
  await js(w, 'MorfisLog.open()'); await wait(1000); await shot(w, '60-change-log'); await js(w, 'window.__morfisPage.closeModal()'); await wait(300);
  Object.assign(np, JSON.parse(await js(w, '(async function(){var o={},pg=window.__morfisPage,H=window.morfisDesktop;try{' +
    'var r=await MorfisLog.revert(pg.P("np-lib"));pg.commitSettings(true);o.undone=r.undone;o.failed=r.failed;o.removed=r.removed;o.gone=!pg.P("np-lib");o.marked=MorfisLog.isNot(' + JSON.stringify(libDir) + ');' +
    'var sc=await H.scanRoot(' + JSON.stringify(libRoot) + ');o.importRows=sc.rows.length;' +
    '}catch(e){o.err2=String(e&&e.stack||e)}return JSON.stringify(o)})()')));
  np.fileBack = fs.existsSync(path.join(libDir, 'a.jpg')) && fs.existsSync(path.join(libDir, 'HDRI', 'sky.hdr'));
  np.left = fs.readdirSync(libDir).sort().join(',');
  console.log('not a project:', JSON.stringify(np));

  /* the split into Direct Projects and Freelance Projects: a completed project becomes a freelance job with the
     freelance folders, a direct project moves, the earlier job moves, and Undo puts everything back */
  const srcDir = path.join(out, 'src-files'); fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'view1.jpg'), 'jpg'); fs.writeFileSync(path.join(srcDir, 'scene.max'), 'max');
  const ro = JSON.parse(await js(w, '(async function(){var o={},pg=window.__morfisPage,H=window.morfisDesktop,wait=function(ms){return new Promise(function(r){setTimeout(r,ms)})};try{' +
    'window.confirm=function(){return true};var ids=Object.keys(pg.S.projects);var cp=pg.P(ids[0]),dp=pg.P(ids[1]);o.cpId=cp.id;o.dpId=dp.id;o.noDiskId=ids[2];' +
    'for(var p of [cp,dp]){var b=pg.projDir(p);await H.mkdirs([b].concat(pg.FOLDER_TEMPLATES.map(function(t){return Morfis.jn(b,t.name)})));p.folderPath=b;p.foldersCreated=pg.today();pg.commit(p);}' +
    'await H.copyInto(pg.projDir(cp),[' + JSON.stringify(path.join(srcDir, 'view1.jpg')) + ']);await H.copyInto(pg.subDir(cp,"02"),[' + JSON.stringify(path.join(srcDir, 'scene.max')) + ']);' +
    'Morfis.setWorkStatus(cp.id,"completed");await wait(300);o.cpOld=pg.projDir(cp);o.cp02=pg.subDir(cp,"02");o.dpOld=pg.projDir(dp);o.root0=pg.S.settings.root;o.jobs0=MorfisFreelance.all().length;o.needed=MorfisReorg.needed();' +
    'var pl=MorfisReorg.plan({});o.planFree=pl.free.length;o.planDirect=pl.direct.length;' +
    '}catch(e){o.err=String(e&&e.stack||e)}return JSON.stringify(o)})()'));
  await go('files', '53-files-split-offer');
  await js(w, 'MorfisReorg.open()'); await wait(900); await shot(w, '54-reorganise-dialog');
  await js(w, 'window.__morfisPage.closeModal()'); await wait(300);
  Object.assign(ro, JSON.parse(await js(w, '(async function(){var o={},pg=window.__morfisPage;try{' +
    'var r=await MorfisReorg.run({sort:true},function(){});o.failed=r.failed;o.mainRoot=pg.S.settings.mainRoot;o.root1=pg.S.settings.root;' +
    'var j=MorfisFreelance.all().find(function(x){return x.project&&x.project.id===' + JSON.stringify(ro.cpId) + '});o.jobId=j&&j.id;o.jobCode=j&&j.code;o.jobFolder=j&&j.folder;o.cpGone=!pg.P(' + JSON.stringify(ro.cpId) + ');' +
    'o.dpNew=pg.P(' + JSON.stringify(ro.dpId) + ').folderPath;var old=MorfisFreelance.all().find(function(x){return x.title==="Living room renders"});o.oldJob=old&&old.folder;o.jobs1=MorfisFreelance.all().length;o.canUndo=MorfisReorg.canUndo();' +
    '}catch(e){o.err=String(e&&e.stack||e)}return JSON.stringify(o)})()')));
  ro.renders = !!ro.jobFolder && fs.existsSync(path.join(ro.jobFolder, '04_Renders', 'view1.jpg'));
  ro.models = !!ro.jobFolder && fs.existsSync(path.join(ro.jobFolder, '02_3D_Models', 'scene.max'));
  ro.oldSubGone = !!ro.jobFolder && fs.existsSync(ro.jobFolder) && !fs.readdirSync(ro.jobFolder).some((n) => /^02_Schematics|^01_Brief_and_Site/.test(n));
  ro.five = !!ro.jobFolder && ['01_Brief_and_References', '02_3D_Models', '03_Drawings', '04_Renders', '05_Delivered'].every((n) => fs.existsSync(path.join(ro.jobFolder, n)));
  ro.cpOldGone = !fs.existsSync(ro.cpOld);
  ro.dpMoved = !!ro.dpNew && /Direct Projects/.test(ro.dpNew) && fs.existsSync(ro.dpNew) && !fs.existsSync(ro.dpOld);
  ro.oldJobMoved = !!ro.oldJob && /Freelance Projects/.test(ro.oldJob) && fs.existsSync(path.join(ro.oldJob, '03_Drawings'));
  await go('files', '55a'); await js(w, 'MorfisFiles.open(""); (function(){var b=document.querySelector("#dkView [data-filter=all]");if(b)b.click()})()'); await wait(700); await shot(w, '55-files-direct-freelance');
  ro.groups = await js(w, 'document.querySelectorAll("#dkView .fx-group").length');
  ro.jobCards = await js(w, 'document.querySelectorAll("#dkView [data-card-menu^=\\"j:\\"]").length');
  await js(w, 'MorfisFiles.openJob(' + JSON.stringify(ro.jobId) + ', "04_Renders")'); await wait(1200);
  ro.browse = await js(w, 'document.querySelectorAll("#dkView .fx-fcard, #dkView .fx-table [data-file]").length');
  await shot(w, '56-files-freelance-job');
  await js(w, 'MorfisFiles.openJob(' + JSON.stringify(ro.jobId) + ', "")'); await wait(1000);
  ro.jobRootDirs = await js(w, 'document.querySelectorAll("#dkView [data-card-menu^=\\"k:\\"]").length');
  await shot(w, '57-files-freelance-root');
  await js(w, 'MorfisFiles.open("")'); await wait(600);
  ro.delItem = await js(w, '(function(){var b=document.querySelector("#dkView [data-card-menu=\\"p:' + ro.noDiskId + '\\"]");if(!b)return "no card";b.click();var t=Array.from(document.querySelectorAll(".dk-menu button")).map(function(x){return x.textContent}).join("|");document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"}));return t})()');
  Object.assign(ro, JSON.parse(await js(w, '(async function(){var o={},pg=window.__morfisPage,wait=function(ms){return new Promise(function(r){setTimeout(r,ms)})};try{window.confirm=function(){return true};' +
    'await MorfisReorg.undo();await wait(500);o.root2=pg.S.settings.root;o.mainRoot2=pg.S.settings.mainRoot||"";o.cpBack=!!pg.P(' + JSON.stringify(ro.cpId) + ');o.jobs2=MorfisFreelance.all().length;o.dpBack=pg.projDir(pg.P(' + JSON.stringify(ro.dpId) + '));' +
    '}catch(e){o.err2=String(e&&e.stack||e)}return JSON.stringify(o)})()')));
  ro.undoDisk = fs.existsSync(path.join(ro.cp02, 'scene.max')) && fs.existsSync(path.join(ro.cpOld, 'view1.jpg')) && fs.existsSync(ro.dpOld) && !fs.existsSync(ro.dpNew) && !!fl.folder && fs.existsSync(path.join(fl.folder, '03_Drawings'));
  console.log('reorganise:', JSON.stringify(ro));

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
  expect(Object.keys(kinds).length === 8 && Object.values(kinds).every(Boolean), 'built-in preview of image, PDF, CSV, JSON, Markdown, Word, other, and arrows: ' + JSON.stringify(kinds));
  expect(/Open in File Explorer/.test(menuItems) && /New folder inside/.test(menuItems) && madeDir, 'folder card menu and New folder dialog');
  expect(setup.ids.join() === '01,02,03,05,06,07' && setup.disk.indexOf('03_Drawings') !== -1 && setup.disk.indexOf('03_Working_Drawings') === -1 && setup.disk.indexOf('07_Client_correspondence') !== -1 && setup.scan.indexOf('07') !== -1, 'project folder setup: ' + JSON.stringify(setup));
  expect(quote.done && quote.lines === 2 && quote.total === 590000, 'AI quotation assistant');
  expect(/overdue/.test(digest || ''), 'AI Monday summary');
  expect(pdf.length > 5000, 'quotation PDF');
  expect(edOk === 'LKR 250,000', 'editor totals while typing');
  expect(w.getTitle() === 'Morfis Atelier' && fs.existsSync(path.join(profile, 'branding', dp.branding.iconFile + '.ico')), 'app name and icon');
  expect(!extra.newOnSettings && extra.newOnProjects, 'New project shows on Projects only, not on Settings');
  expect(extra.overlayTop >= 40 && extra.remBtn && extra.remClosed && extra.remView === 'settings' && extra.remCard, 'Reminder settings opens Settings, and panels open below the window bar: ' + JSON.stringify(extra));
  expect(extra.picker && extra.accent === '#2E9E6A' && (extra.mono ? extra.accentVar.toUpperCase() !== '#2E9E6A' : extra.accentVar.toUpperCase() === '#2E9E6A'), 'custom accent colour picker (saved; Mono keeps ink): ' + JSON.stringify(extra));
  expect(own.editor && own.cards === 1 && own.added === 1 && own.text.indexOf(own.pname) !== -1, 'custom automation: status Completed adds the close-out reminder: ' + JSON.stringify(own));
  expect(phone.on && phone.ping === 'studio-morfis' && phone.unpaired === 401 && phone.pairPage && phone.wrongPin === false && phone.paired && phone.projects === nProjects && phone.blocked, 'phone access: pairing and the API: ' + JSON.stringify(phone));
  expect(phone.cors && phone.appKey && phone.appCall && phone.appTree && phone.pingId, 'phone access from the Android app (fixed page address, key header): ' + JSON.stringify(phone));
  expect(phone.remotePage && phone.drawer && phone.drawerClosed && phone.back && phone.backHome, 'phone page: drawer and Back: ' + JSON.stringify(phone));
  const po = phone.offline || {};
  expect(po.folders > 0 && po.offline && po.made && po.listed && po.renamed && po.waiting >= 3 && po.notOnPcYet, 'phone offline: folders and changes kept on the phone: ' + JSON.stringify(po));
  expect(po.sent && po.onDisk && po.added === 1 && po.fileSent && po.pcStatus === 'on_hold' && po.pcClient === 'Phone client' && po.pcLocation === 'Changed on the PC' && po.phoneLocation === 'Changed on the PC', 'phone offline: changes reach the computer and merge: ' + JSON.stringify(po));
  expect(phone.toComputer === 'on_hold' && phone.toPhone === 'in_progress', 'phone and computer stay in step: ' + JSON.stringify(phone));
  expect(fl.page && fl.dels === 3 && fl.done === 1 && fl.paid === 20000 && fl.made && fl.onDisk && fl.saved >= 1 && fl.moved && fl.jobs === 2 && fl.cards >= 1, 'freelance jobs: ' + JSON.stringify(fl));
  expect(!ro.err && !ro.err2 && ro.needed && ro.planFree === 1 && ro.mainRoot === ro.root0 && /Direct Projects$/.test(ro.root1) && ro.cpGone && /^FL I/.test(ro.jobCode || '') && ro.renders && ro.models && ro.five && ro.oldSubGone && ro.cpOldGone && ro.dpMoved && ro.oldJobMoved && ro.canUndo && !(ro.failed || []).length, 'reorganise into Direct Projects and Freelance Projects: ' + JSON.stringify(ro));
  expect(ro.groups === 2 && ro.jobCards >= 2 && ro.browse >= 1 && ro.jobRootDirs === 5 && /Delete the project/.test(ro.delItem || ''), 'Files: freelance jobs browsed like projects, Delete the project for a project with no folder: ' + JSON.stringify(ro));
  expect(ro.root2 === ro.root0 && !ro.mainRoot2 && ro.cpBack && ro.jobs2 === ro.jobs0 && ro.undoDisk && ro.dpBack === ro.dpOld, 'undoing the reorganisation: ' + JSON.stringify(ro));
  expect(!np.err && !np.err2 && np.sorted === 1 && np.suspect && np.logged >= 2 && np.note && np.gone && np.marked && np.undone >= 2 && !(np.failed || []).length && np.fileBack && np.left === 'HDRI,a.jpg' && np.importRows === 0, 'a folder that is not a project put back as it was: ' + JSON.stringify(np));
  console.log(fails.length ? 'SMOKE FAILED: ' + fails.join('; ') : 'SMOKE PASSED');
  app.exit(fails.length ? 1 : 0);
});
