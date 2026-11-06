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
    'o.accent=window.__morfisPage.S.settings.accent;o.accentVar=getComputedStyle(document.documentElement).getPropertyValue("--accent-fill").trim();' +
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
  expect(extra.picker && extra.accent === '#2E9E6A' && extra.accentVar.toUpperCase() === '#2E9E6A', 'custom accent colour picker');
  expect(own.editor && own.cards === 1 && own.added === 1 && own.text.indexOf(own.pname) !== -1, 'custom automation: status Completed adds the close-out reminder: ' + JSON.stringify(own));
  console.log(fails.length ? 'SMOKE FAILED: ' + fails.join('; ') : 'SMOKE PASSED');
  app.exit(fails.length ? 1 : 0);
});
