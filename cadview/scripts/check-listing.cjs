// Checks the store listing texts against each store's character limits.
// Usage: node scripts/check-listing.cjs
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '../store/listing');
const LIMITS = {
  'google-play.md': { 'App name': 30, 'Short description': 80, 'Full description': 4000, 'Release notes for 1.0.0': 500 },
  'app-store.md': { Name: 30, Subtitle: 30, 'Promotional text': 170, Keywords: 100, Description: 4000, "What's New in This Version": 4000 },
};
let bad = 0;
for (const [file, limits] of Object.entries(LIMITS)) {
  const text = fs.readFileSync(path.join(dir, file), 'utf8');
  const sections = {};
  for (const part of text.split(/^## /m).slice(1)) {
    const nl = part.indexOf('\n');
    sections[part.slice(0, nl).replace(/\s*\(.*$/, '').trim()] = part.slice(nl + 1).trim();
  }
  console.log(file);
  for (const [name, max] of Object.entries(limits)) {
    const body = sections[name];
    if (body === undefined) { console.log(`  MISSING  ${name}`); bad++; continue; }
    const n = name === 'Keywords' ? Buffer.byteLength(body) : [...body].length;
    const ok = n <= max;
    if (!ok) bad++;
    console.log(`  ${ok ? 'ok  ' : 'LONG'}  ${name}: ${n}/${max}`);
  }
}
process.exit(bad ? 1 : 0);
