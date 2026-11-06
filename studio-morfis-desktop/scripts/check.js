'use strict';
/* Run after replacing src/dashboard/dashboard.html: confirms every place the desktop patch hooks into is still there,
   and that the page still calls only bridge methods the shell provides. */
const fs = require('fs');
const path = require('path');
const patch = require('../src/shell/patch');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'dashboard.html'), 'utf8');
const r = patch.build(html, { htmlClass: 'wc-fluent', tail: patch.tail('') });
let bad = 0;
if (r.missing.length) { bad++; console.error('Patch anchors not found in dashboard.html:\n  ' + r.missing.join('\n  ')); }

const bridge = fs.readFileSync(path.join(__dirname, '..', 'src', 'shell', 'renderer', 'bridge.js'), 'utf8');
const used = Array.from(new Set((html.match(/HOST\.[a-zA-Z]+/g) || []).map((s) => s.slice(5))));
const missing = used.filter((m) => bridge.indexOf("'" + m + "'") === -1 && bridge.indexOf('api.' + m + ' ') === -1);
if (missing.length) { bad++; console.error('The dashboard calls bridge methods the shell does not provide: ' + missing.join(', ')); }

if (!/id="wbarTitle"/.test(r.html) || !/data-act="winClose"/.test(r.html)) { bad++; console.error('Window bar markup was not replaced.'); }
console.log(bad ? 'check failed' : 'check passed: ' + used.length + ' bridge methods used by the dashboard, all provided; patch applied cleanly.');
process.exit(bad ? 1 : 0);
