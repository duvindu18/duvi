// Opens a test file from samples/ the way a user does: through the file picker.
const path = require('path');
const dir = path.join(__dirname, '../samples');
async function openSample(p, name) {
  if (name === 'compare') {
    await openSample(p, 'floorplan-rev-A.dxf');
    await p.waitForFunction(() => !document.querySelector('#loading.show'));
    await p.setInputFiles('#compareInput', path.join(dir, 'floorplan-rev-B.dxf'));
    return;
  }
  await p.setInputFiles('#fileInput', path.join(dir, name));
}
module.exports = { openSample };
