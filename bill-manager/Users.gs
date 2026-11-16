/**
 * Sign-in, approved users and roles.
 *
 * • The web app is deployed "Execute as: User accessing the web app" and
 *   "Who has access: Anyone with Google account". Google therefore forces every person to sign in,
 *   and the script sees their real, verified Google account e-mail (Session.getActiveUser()).
 * • Only people listed as Active in the "Users" tab can record bills. Everyone else sees an
 *   "Access needed" screen showing the account they are signed in with.
 * • Roles:  Admin – record bills, manage categories, void bills, add/remove users
 *           Staff – record bills
 * • Every bill stores the Google account AND the name of the person who entered it; every
 *   action in the Audit Log carries the same account.
 *
 * Adding a user (menu → 👥 Users & access → Add user…) also shares the spreadsheet and the
 * receipts folder with them, which the "execute as user" model requires.
 */

const USER_HEADERS = ['Google Account (e-mail)', 'Name', 'Role', 'Active', 'Added At', 'Added By', 'Last Seen'];
const ROLES = ['Admin', 'Staff'];
let CURRENT_USER_ = null;

function ensureUsersSheet_() {
  const sh = getOrCreateSheet_(SHEET.USERS);
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, USER_HEADERS.length).setValues([USER_HEADERS]);
  styleHeader_(sh, USER_HEADERS.length);
  sh.setFrozenRows(1);
  [260, 200, 90, 70, 145, 220, 145].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.getRange('C2:C').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(ROLES, true).build());
  sh.getRange('D2:D').insertCheckboxes();
  sh.getRange('E2:E').setNumberFormat('dd/MM/yyyy HH:mm');
  sh.getRange('G2:G').setNumberFormat('dd/MM/yyyy HH:mm');

  const owner = ownerEmail_();
  if (owner && !findUserRow_(owner)) {
    sh.appendRow([owner, 'Owner', 'Admin', true, new Date(), 'setup', '']);
  }
  protectWarn_(sh, 'Users — manage with Bill Manager → Users & access');
}

function ownerEmail_() {
  const props = PropertiesService.getScriptProperties();
  let owner = props.getProperty('OWNER_EMAIL');
  if (!owner) {
    try { owner = Session.getEffectiveUser().getEmail(); } catch (e) { owner = ''; }
    if (owner) props.setProperty('OWNER_EMAIL', owner.toLowerCase());
  }
  return String(owner || '').toLowerCase();
}

/** Signed-in, approved user, or throws SIGN_IN_REQUIRED / NOT_AUTHORISED. Called by every server entry point. */
function currentUser_() {
  if (CURRENT_USER_) return CURRENT_USER_;
  let email = '';
  try { email = String(Session.getActiveUser().getEmail() || '').toLowerCase().trim(); } catch (e) { }
  if (!email) {
    throw new Error('SIGN_IN_REQUIRED: Please sign in with your Google account to record bills.');
  }
  let u = null;
  try {
    const row = findUserRow_(email);
    if (row) {
      const v = sheet_(SHEET.USERS).getRange(row, 1, 1, USER_HEADERS.length).getValues()[0];
      u = { email: email, name: String(v[1] || email), role: ROLES.indexOf(v[2]) >= 0 ? v[2] : 'Staff',
            active: v[3] === true || String(v[3]).toUpperCase() === 'TRUE', row: row };
    }
  } catch (e) {
    // The account cannot even open the spreadsheet: it has not been granted access.
    throw new Error('NOT_AUTHORISED: ' + email + ' has not been given access to MAARAA Bills.');
  }
  if (!u && email === ownerEmail_()) u = { email: email, name: 'Owner', role: 'Admin', active: true, row: 0 };
  if (!u || !u.active) throw new Error('NOT_AUTHORISED: ' + email + ' is not on the approved users list.');
  CURRENT_USER_ = u;
  return u;
}

function requireAdmin_() {
  const u = currentUser_();
  if (u.role !== 'Admin') throw new Error('Only an Admin can do this. You are signed in as ' + u.email + ' (' + u.role + ').');
  return u;
}

function touchLastSeen_(u) {
  try { if (u.row) sheet_(SHEET.USERS).getRange(u.row, 7).setValue(new Date()); } catch (e) { }
}

function findUserRow_(email) {
  const sh = sheet_(SHEET.USERS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return 0;
  const vals = sh.getRange(2, 1, n, 1).getValues();
  const target = String(email).toLowerCase().trim();
  for (let i = 0; i < vals.length; i++) if (String(vals[i][0]).toLowerCase().trim() === target) return i + 2;
  return 0;
}

// --------------------------------------------------------------- menu actions

function addUserPrompt() {
  const ui = SpreadsheetApp.getUi();
  try { requireAdmin_(); } catch (e) { ui.alert(e.message); return; }

  const a = ui.prompt('Add user (1/3)', 'Google account e-mail of the person (e.g. name@gmail.com):', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK) return;
  const email = a.getResponseText().trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { ui.alert('That is not a valid e-mail address.'); return; }

  const b = ui.prompt('Add user (2/3)', 'Full name (shown on every bill they record):', ui.ButtonSet.OK_CANCEL);
  if (b.getSelectedButton() !== ui.Button.OK) return;
  const name = clean_(b.getResponseText(), 80) || email;

  const c = ui.alert('Add user (3/3)', 'Make ' + name + ' an ADMIN?\n\nYes = Admin (can manage categories, void bills and add users)\nNo = Staff (can record bills only)', ui.ButtonSet.YES_NO_CANCEL);
  if (c === ui.Button.CANCEL || c === ui.Button.CLOSE) return;
  const role = c === ui.Button.YES ? 'Admin' : 'Staff';

  const res = addOrUpdateUser_(email, name, role);
  ui.alert('User added', name + ' (' + email + ') can now sign in as ' + role + '.\n\n' + res.shared +
    '\n\nSend them the web app link (menu → 🔗 Show web app link).', ui.ButtonSet.OK);
}

function addOrUpdateUser_(email, name, role) {
  const admin = requireAdmin_();
  const sh = sheet_(SHEET.USERS);
  const row = findUserRow_(email);
  if (row) {
    sh.getRange(row, 2, 1, 3).setValues([[name, role, true]]);
  } else {
    sh.appendRow([email, name, role, true, new Date(), admin.email, '']);
    sh.getRange(sh.getLastRow(), 4).insertCheckboxes().setValue(true);
  }
  // "Execute as user" means the person needs edit access to the sheet and the receipts folder.
  const notes = [];
  try { ss_().addEditor(email); notes.push('Spreadsheet shared.'); } catch (e) { notes.push('Could not share the spreadsheet: ' + e.message); }
  try { rootFolder_().addEditor(email); notes.push('Receipts & backup folder shared.'); } catch (e) { notes.push('Could not share the folder: ' + e.message); }
  audit_('USER_ADD', email, { name: name, role: role, by: admin.email });
  journal_('USER_ADD', email, { name: name, role: role });
  return { shared: notes.join(' ') };
}

function deactivateUserPrompt() {
  const ui = SpreadsheetApp.getUi();
  let admin;
  try { admin = requireAdmin_(); } catch (e) { ui.alert(e.message); return; }
  const a = ui.prompt('Remove access', 'Google account e-mail to deactivate:', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK) return;
  const email = a.getResponseText().trim().toLowerCase();
  if (email === ownerEmail_()) { ui.alert('The owner cannot be deactivated.'); return; }
  if (email === admin.email) { ui.alert('You cannot deactivate yourself.'); return; }
  const row = findUserRow_(email);
  if (!row) { ui.alert(email + ' is not in the Users list.'); return; }

  // Their past bills keep their name — only future access is removed.
  sheet_(SHEET.USERS).getRange(row, 4).setValue(false);
  try { ss_().removeEditor(email); } catch (e) { }
  try { rootFolder_().removeEditor(email); } catch (e) { }
  audit_('USER_DEACTIVATE', email, { by: admin.email });
  journal_('USER_DEACTIVATE', email, {});
  ui.alert(email + ' can no longer sign in. Bills they recorded are unchanged.');
}

function openUsersSheet() {
  ss_().setActiveSheet(sheet_(SHEET.USERS));
}
