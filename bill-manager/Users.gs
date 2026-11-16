/**
 * Approved users and roles.
 *
 *  Employee – can ONLY record bills (entry form). No access to the spreadsheet, Drive folders,
 *             reports, categories or other people's bills.
 *  Admin    – can also manage categories and users. The owner (the account that ran setup)
 *             is always Admin and cannot be removed.
 *
 * Employees never get the spreadsheet or folders shared with them. They open the Entry link
 * (a tiny separate "Gateway" script, see gateway/), sign in with Google, and the Gateway passes
 * Google's signed identity token to this script, which verifies it (see Api.gs) and then does
 * the work as the owner. Identity therefore always comes from Google, never from the form.
 *
 * The owner manages the list in menu → 👥 Manage users (or the 👥 button in the app).
 */

const USER_HEADERS = ['Google Account (e-mail)', 'Name', 'Role', 'Active', 'Added At', 'Added By', 'Last Seen', 'Updated At'];
const ROLES = ['Employee', 'Admin'];
let CURRENT_USER_ = null;

function ensureUsersSheet_() {
  const sh = getOrCreateSheet_(SHEET.USERS);
  sh.getRange(1, 1, 1, USER_HEADERS.length).setValues([USER_HEADERS]);
  styleHeader_(sh, USER_HEADERS.length);
  sh.setFrozenRows(1);
  [260, 200, 100, 70, 145, 220, 145, 145].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.getRange('C2:C').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(ROLES, true).build());
  sh.getRange('D2:D').insertCheckboxes();
  sh.getRange('E2:E').setNumberFormat('dd/MM/yyyy HH:mm');
  sh.getRange('G2:H').setNumberFormat('dd/MM/yyyy HH:mm');
  const owner = ownerEmail_();
  if (owner && !findUserRow_(owner)) sh.appendRow([owner, 'Owner', 'Admin', true, new Date(), 'setup', '', new Date()]);
  protectWarn_(sh, 'Users — manage with Bill Manager → Manage users');
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

/**
 * The signed-in, approved user. In the Gateway path Api.gs sets CURRENT_USER_ from the verified
 * Google token before anything runs. Inside the spreadsheet (menu, dialog, sidebar) the person is
 * running the script themselves, so Google's Session identity is used.
 */
function currentUser_() {
  if (CURRENT_USER_) return CURRENT_USER_;
  let email = '';
  try { email = String(Session.getActiveUser().getEmail() || ''); } catch (e) { }
  CURRENT_USER_ = resolveUser_(email);
  return CURRENT_USER_;
}

function resolveUser_(email) {
  email = String(email || '').toLowerCase().trim();
  if (!email) throw new Error('SIGN_IN_REQUIRED: Please sign in with your Google account to record bills.');
  let u = null;
  const row = findUserRow_(email);
  if (row) {
    const v = sheet_(SHEET.USERS).getRange(row, 1, 1, USER_HEADERS.length).getValues()[0];
    u = { email: email, name: String(v[1] || email), role: v[2] === 'Admin' ? 'Admin' : 'Employee',
          active: v[3] === true || String(v[3]).toUpperCase() === 'TRUE', row: row };
  }
  if (email === ownerEmail_()) u = { email: email, name: u ? u.name : 'Owner', role: 'Admin', active: true, row: u ? u.row : 0 };
  if (!u || !u.active) throw new Error('NOT_AUTHORISED: ' + email + ' is not on the approved users list.');
  return u;
}

function requireAdmin_() {
  const u = currentUser_();
  if (u.role !== 'Admin') throw new Error('Only an Admin can do this. Employees can record bills only.');
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

// ============================ USER MANAGER API ==============================

/** All approved accounts, for the Users screen (Admin only). */
function listUsers() {
  const me = requireAdmin_();
  const sh = sheet_(SHEET.USERS);
  const n = sh.getLastRow() - 1;
  const owner = ownerEmail_();
  const bills = billsPerUser_();
  const fmt = function (d) { return d instanceof Date ? Utilities.formatDate(d, tz_(), 'dd/MM/yyyy HH:mm') : ''; };
  const rows = n > 0 ? sh.getRange(2, 1, n, USER_HEADERS.length).getValues() : [];
  return {
    me: me.email,
    users: rows.filter(function (r) { return r[0]; }).map(function (r) {
      const email = String(r[0]).toLowerCase().trim();
      return { email: email, name: String(r[1] || ''), role: r[2] === 'Admin' ? 'Admin' : 'Employee',
               active: r[3] === true || String(r[3]).toUpperCase() === 'TRUE', isOwner: email === owner,
               addedAt: fmt(r[4]), lastSeen: fmt(r[6]), bills: bills[email] || 0 };
    }).sort(function (a, b) { return (b.isOwner - a.isOwner) || (b.active - a.active) || a.name.localeCompare(b.name); }),
  };
}

/**
 * Add or edit an account. input = { email, name, role, active, originalEmail? }
 * originalEmail is set when editing, so an address typo can be corrected.
 */
function saveUser(input) {
  const me = requireAdmin_();
  return withLock_(function () {
    input = input || {};
    const email = String(input.email || '').toLowerCase().trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid Google account e-mail address.');
    const name = clean_(input.name, 80);
    if (!name) throw new Error('Enter the person\'s name (it is shown on every bill they record).');
    let role = input.role === 'Admin' ? 'Admin' : 'Employee';
    let active = input.active !== false;
    const original = String(input.originalEmail || '').toLowerCase().trim();
    const owner = ownerEmail_();

    if (original === owner || email === owner) { role = 'Admin'; active = true; }
    if (original === owner && email !== owner) throw new Error('The owner\'s e-mail cannot be changed.');
    if ((original || email) === me.email && (!active || role !== 'Admin')) throw new Error('You cannot remove your own Admin access.');

    const sh = sheet_(SHEET.USERS);
    const rowOrig = original ? findUserRow_(original) : 0;
    const rowNew = findUserRow_(email);
    if (rowNew && rowNew !== rowOrig) throw new Error(email + ' is already in the list.');

    const now = new Date();
    let action;
    if (rowOrig) {
      sh.getRange(rowOrig, 1, 1, 4).setValues([[email, name, role, active]]);
      sh.getRange(rowOrig, 8).setValue(now);
      action = 'USER_UPDATE';
    } else {
      sh.appendRow([email, name, role, active, now, me.email, '', now]);
      sh.getRange(sh.getLastRow(), 4).insertCheckboxes().setValue(active);
      action = 'USER_ADD';
    }
    const details = { email: email, previousEmail: original && original !== email ? original : undefined, name: name, role: role, active: active };
    audit_(action, email, details);
    journal_(action, email, details);
    return { message: (action === 'USER_ADD' ? 'Added ' : 'Saved ') + name + ' (' + email + ') as ' + role + (active ? '.' : ' — access switched off.') };
  });
}

/** Removes the account from the list. Bills they recorded keep their name and e-mail. */
function deleteUser(email) {
  const me = requireAdmin_();
  return withLock_(function () {
    email = String(email || '').toLowerCase().trim();
    if (email === ownerEmail_()) throw new Error('The owner cannot be deleted.');
    if (email === me.email) throw new Error('You cannot delete your own account.');
    const row = findUserRow_(email);
    if (!row) throw new Error('Account not found.');
    const v = sheet_(SHEET.USERS).getRange(row, 1, 1, USER_HEADERS.length).getValues()[0];
    sheet_(SHEET.USERS).deleteRow(row);
    const details = { email: email, name: v[1], role: v[2] };
    audit_('USER_DELETE', email, details);
    journal_('USER_DELETE', email, details);
    return { message: 'Deleted ' + (v[1] || email) + '. Their past bills are unchanged.' };
  });
}

function billsPerUser_() {
  const sh = sheet_(SHEET.BILLS);
  const n = sh.getLastRow() - 1;
  const out = {};
  if (n < 1) return out;
  sh.getRange(2, COL.RECORDED_BY, n, 1).getValues().forEach(function (r) {
    const e = String(r[0] || '').toLowerCase(); if (e) out[e] = (out[e] || 0) + 1;
  });
  return out;
}

function openUserSidebar() {
  const t = HtmlService.createTemplateFromFile('Sidebar');
  t.panel = 'users';
  SpreadsheetApp.getUi().showSidebar(t.evaluate().setTitle('Manage users'));
}
