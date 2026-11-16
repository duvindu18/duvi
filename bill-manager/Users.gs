/**
 * Users, roles and PIN sign-in (no Google sign-in needed for staff).
 *
 *  Employee – can ONLY record bills and correct their own bills (entry app).
 *             No access to the spreadsheet, Drive folders, reports or other people's bills.
 *  Admin    – can also manage categories and users. The owner (the account that ran setup)
 *             is always Admin and cannot be removed.
 *
 * How sign-in works
 *  • Each person has a Login (a short name such as "kasun", or an e-mail) and a 6-digit PIN that
 *    an Admin sets in 👥 Users. Only a salted SHA-256 hash of the PIN is stored (hidden columns).
 *  • Signing in on a phone creates a long-lived session (180 days, or until the browser is
 *    cleared). Switching a person off, deleting them or resetting their PIN ends all their
 *    sessions immediately.
 *  • 5 wrong PINs lock that login for 15 minutes; many wrong PINs overall pause all sign-ins.
 *  • The owner working inside the spreadsheet is recognised by Google automatically (no PIN).
 */

const USER_HEADERS = ['Login (short name or e-mail)', 'Name', 'Role', 'Active', 'Added At', 'Added By', 'Last Seen', 'Updated At',
  'PIN Hash', 'PIN Salt', 'PIN Set At'];
const U_PIN_HASH = 9, U_PIN_SALT = 10, U_PIN_SET = 11;
const ROLES = ['Employee', 'Admin'];
const SESSION_DAYS = 180;

/**
 * The team when this system was set up. setup() adds them ONCE (only if no employees exist yet),
 * so people you later delete never come back. After that, manage the team in 👥 Users.
 */
const INITIAL_TEAM = ['Asindu', 'Asvida', 'Avera', 'Bhagya', 'Binudi', 'Duvindu', 'Isirie', 'Kaushan', 'Oshini',
  'Savidya', 'Senura', 'Tharangika', 'Uditha'];
let CURRENT_USER_ = null;

function ensureUsersSheet_() {
  const sh = getOrCreateSheet_(SHEET.USERS);
  if (sh.getMaxColumns() < USER_HEADERS.length) sh.insertColumnsAfter(sh.getMaxColumns(), USER_HEADERS.length - sh.getMaxColumns());
  sh.getRange(1, 1, 1, USER_HEADERS.length).setValues([USER_HEADERS]);
  styleHeader_(sh, USER_HEADERS.length);
  sh.setFrozenRows(1);
  [230, 200, 100, 70, 145, 220, 145, 145, 120, 120, 145].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  // Repair: older versions put empty checkboxes down the whole column, which pushed new
  // accounts to row 1001. Move all real rows back to the top and tidy the table.
  compactTable_(sh, USER_HEADERS.length, [4]);
  const owner = ownerEmail_();
  if (owner && !findUserRow_(owner)) appendRowAt_(sh, 1, [owner, 'Owner', 'Admin', true, new Date(), 'setup', '', new Date(), '', '', ''], [4]);
  const n = Math.max(lastDataRow_(sh, 1) - 1, 1);
  sh.getRange(2, 3, n, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(ROLES, true).build());
  sh.getRange(2, 5, n, 1).setNumberFormat('dd/MM/yyyy HH:mm');
  sh.getRange(2, 7, n, 2).setNumberFormat('dd/MM/yyyy HH:mm');
  sh.getRange(2, U_PIN_SET, n, 1).setNumberFormat('dd/MM/yyyy HH:mm');
  sh.hideColumns(U_PIN_HASH, 2);                   // PIN hash + salt are never shown
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
 * The signed-in, approved user. In the entry app, api() sets CURRENT_USER_ from the PIN session
 * before anything runs. Inside the spreadsheet (menu, dialog, sidebar) Google's Session identity
 * of the person using the sheet is used.
 */
function currentUser_() {
  if (CURRENT_USER_) return CURRENT_USER_;
  let email = '';
  try { email = String(Session.getActiveUser().getEmail() || ''); } catch (e) { }
  if (!email) throw new Error('SIGN_IN_REQUIRED: Please sign in with your login and PIN.');
  CURRENT_USER_ = resolveUser_(email);
  return CURRENT_USER_;
}

/** Looks a login up in the Users tab. Throws NOT_AUTHORISED if missing or switched off. */
function resolveUser_(login) {
  login = normLogin_(login);
  if (!login) throw new Error('SIGN_IN_REQUIRED: Please sign in with your login and PIN.');
  let u = null;
  const row = findUserRow_(login);
  if (row) {
    const v = sheet_(SHEET.USERS).getRange(row, 1, 1, USER_HEADERS.length).getValues()[0];
    u = { email: login, name: String(v[1] || login), role: v[2] === 'Admin' ? 'Admin' : 'Employee',
          active: v[3] === true || String(v[3]).toUpperCase() === 'TRUE', row: row,
          pinHash: String(v[U_PIN_HASH - 1] || ''), pinSalt: String(v[U_PIN_SALT - 1] || ''),
          pinSetAt: v[U_PIN_SET - 1] instanceof Date ? v[U_PIN_SET - 1].getTime() : 0 };
  }
  if (login === ownerEmail_()) u = Object.assign(u || { email: login, name: 'Owner', row: 0, pinHash: '', pinSalt: '', pinSetAt: 0 }, { role: 'Admin', active: true });
  if (!u || !u.active) throw new Error('NOT_AUTHORISED: "' + login + '" is not an active user. Ask the MAARAA admin.');
  return u;
}

function requireAdmin_() {
  const u = currentUser_();
  if (u.role !== 'Admin') throw new Error('Only an Admin can do this. Employees can record bills only.');
  return u;
}

/**
 * For menu, editor and maintenance functions: only an Admin working in the spreadsheet itself
 * (identified by Google) may run them — never the public entry app.
 */
function requireSheetAdmin_() {
  if (CURRENT_USER_ && CURRENT_USER_.viaPin) throw new Error('This can only be done from the spreadsheet.');
  let email = '';
  try { email = String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) { }
  if (!email) throw new Error('This can only be done from the spreadsheet by an Admin.');
  if (email === ownerEmail_()) return;
  if (resolveUser_(email).role !== 'Admin') throw new Error('Only an Admin can do this.');
}

function touchLastSeen_(u) {
  try { if (u.row) sheet_(SHEET.USERS).getRange(u.row, 7).setValue(new Date()); } catch (e) { }
}

function normLogin_(s) { return String(s || '').toLowerCase().trim().replace(/\s+/g, ''); }

function findUserRow_(login) {
  const sh = sheet_(SHEET.USERS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return 0;
  const vals = sh.getRange(2, 1, n, 1).getValues();
  const target = normLogin_(login);
  for (let i = 0; i < vals.length; i++) if (normLogin_(vals[i][0]) === target) return i + 2;
  return 0;
}

// ================================ PIN SIGN-IN ===============================

function pinHash_(salt, pin) { return sha256Hex_(Utilities.newBlob(salt + ':' + pin).getBytes()); }
function randomPin_() {
  let p;
  do { p = String(Math.floor(100000 + Math.random() * 900000)); } while (weakPin_(p));
  return p;
}
function weakPin_(p) {
  if (/^(\d)\1+$/.test(p)) return true;                                     // 0000, 111111
  const asc = '01234567890', desc = '09876543210';
  return asc.indexOf(p) >= 0 || desc.indexOf(p) >= 0;                       // 1234, 654321
}
function validatePin_(pin) {
  pin = String(pin || '').trim();
  if (!/^\d{4,6}$/.test(pin)) throw new Error('The PIN must be 4 to 6 digits.');
  if (weakPin_(pin)) throw new Error('That PIN is too easy to guess (e.g. 1234 or 0000). Choose another.');
  return pin;
}
/** The team-wide starting PIN from Settings (DEFAULT_PIN), or '' if not set. */
function defaultPin_() {
  const v = String(settings_().DEFAULT_PIN == null ? '' : settings_().DEFAULT_PIN).trim();
  return /^\d{4,6}$/.test(v) ? v : '';
}
/**
 * PIN for a new person / a reset: the given one, else the team PIN (DEFAULT_PIN), else random.
 * Admins never get the shared team PIN: anyone who knows it could otherwise act as an Admin.
 */
function pinOrDefault_(pin, role) {
  const team = defaultPin_();
  if (role === 'Admin') {
    if (pin && pin === team) throw new Error('Admins need their own PIN, not the team PIN ' + team + '.');
    return pin ? validatePin_(pin) : randomPin_();
  }
  if (pin) return validatePin_(pin);
  return team || randomPin_();
}

/** Called by the sign-in screen. Returns { token, user } or throws. */
function login(loginName, pin, device) {
  const cache = CacheService.getScriptCache();
  const login = normLogin_(loginName);
  if (Number(cache.get('LF_ALL') || 0) >= 40) throw new Error('Too many wrong PINs on this system. Please wait 10 minutes.');
  if (Number(cache.get('LF_' + login) || 0) >= 5) throw new Error('This login is locked for 15 minutes after 5 wrong PINs.');

  let u = null;
  try { u = resolveUser_(login); } catch (e) { u = null; }
  const ok = u && u.pinHash && /^\d{4,6}$/.test(String(pin || '')) && pinHash_(u.pinSalt, String(pin)) === u.pinHash;
  if (!ok) {
    cache.put('LF_' + login, String(Number(cache.get('LF_' + login) || 0) + 1), 900);
    cache.put('LF_ALL', String(Number(cache.get('LF_ALL') || 0) + 1), 600);
    Utilities.sleep(700);
    audit_('LOGIN_FAILED', login, { device: String(device || '').slice(0, 80) }, login || 'unknown');
    if (u && !u.pinHash) throw new Error('No PIN has been set for this login yet. Ask the MAARAA admin.');
    throw new Error('Login or PIN is not correct.');
  }
  cache.remove('LF_' + login);

  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const props = PropertiesService.getScriptProperties();
  props.setProperty(sessionKey_(token), JSON.stringify({ u: u.email, v: u.pinSetAt, exp: Date.now() + SESSION_DAYS * 86400000,
    d: String(device || '').slice(0, 60), at: Date.now() }));
  pruneSessions_(props);
  touchLastSeen_(u);
  audit_('LOGIN', u.email, { device: String(device || '').slice(0, 80) }, u.email);
  return { token: token, user: { email: u.email, name: u.name, role: u.role } };
}

function logout(token) {
  try { PropertiesService.getScriptProperties().deleteProperty(sessionKey_(token)); } catch (e) { }
  return true;
}

function sessionKey_(token) { return 'SESS_' + sha256Hex_(Utilities.newBlob(String(token)).getBytes()).slice(0, 40); }

/** Turns a session token into the signed-in user, or throws SIGN_IN_REQUIRED. */
function userFromSession_(token) {
  if (!/^[0-9a-f]{64}$/.test(String(token || ''))) throw new Error('SIGN_IN_REQUIRED: Please sign in with your login and PIN.');
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(sessionKey_(token));
  if (!raw) throw new Error('SIGN_IN_REQUIRED: Your sign-in has ended. Please sign in again.');
  const s = JSON.parse(raw);
  if (!(s.exp > Date.now())) { props.deleteProperty(sessionKey_(token)); throw new Error('SIGN_IN_REQUIRED: Your sign-in has expired. Please sign in again.'); }
  let u;
  try { u = resolveUser_(s.u); }
  catch (e) { props.deleteProperty(sessionKey_(token)); throw new Error('SIGN_IN_REQUIRED: Your access has been switched off. Ask the MAARAA admin.'); }
  if (u.pinSetAt !== s.v) { props.deleteProperty(sessionKey_(token)); throw new Error('SIGN_IN_REQUIRED: Your PIN was changed. Please sign in with the new PIN.'); }
  u.viaPin = true;
  return u;
}

function pruneSessions_(props) {
  const all = props.getProperties(), now = Date.now();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('SESS_') !== 0) return;
    try { if (!(JSON.parse(all[k]).exp > now)) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); }
  });
}

/** Ends every session of one login (used when access is switched off or the PIN changes). */
function endSessionsFor_(login) {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('SESS_') !== 0) return;
    try { if (JSON.parse(all[k]).u === login) props.deleteProperty(k); } catch (e) { }
  });
}

/** Sets a person's PIN (Admin). Empty pin → a random strong PIN. Returns the PIN to hand over. */
function setUserPin(login, pin) {
  const me = requireAdmin_();
  return withLock_(function () {
    login = normLogin_(login);
    const row = findUserRow_(login);
    if (!row) throw new Error('User not found.');
    const sh = sheet_(SHEET.USERS);
    const isAdminTarget = sh.getRange(row, 3).getValue() === 'Admin' || login === ownerEmail_();
    pin = pinOrDefault_(pin, isAdminTarget ? 'Admin' : 'Employee');
    const salt = Utilities.getUuid();
    sh.getRange(row, U_PIN_HASH, 1, 3).setValues([[pinHash_(salt, pin), salt, new Date()]]);
    sh.getRange(row, 8).setValue(new Date());
    endSessionsFor_(login);
    audit_('PIN_SET', login, { by: me.email });
    return { pin: pin, message: 'New PIN for ' + sh.getRange(row, 2).getValue() + ': ' + pin + '. Give it to them privately. Their old sign-ins have ended.' };
  });
}

// ============================ USER MANAGER API ==============================

/** All users, for the Users screen (Admin only). PIN hashes are never sent. */
function listUsers() {
  const me = requireAdmin_();
  const sh = sheet_(SHEET.USERS);
  const n = lastDataRow_(sh, 1) - 1;
  const owner = ownerEmail_();
  const bills = billsPerUser_();
  const fmt = function (d) { return d instanceof Date ? Utilities.formatDate(d, tz_(), 'dd/MM/yyyy HH:mm') : ''; };
  const rows = n > 0 ? sh.getRange(2, 1, n, USER_HEADERS.length).getValues() : [];
  return {
    me: me.email,
    teamPin: defaultPin_(),
    users: rows.filter(function (r) { return r[0]; }).map(function (r) {
      const login = normLogin_(r[0]);
      return { email: login, name: String(r[1] || ''), role: r[2] === 'Admin' ? 'Admin' : 'Employee',
               active: r[3] === true || String(r[3]).toUpperCase() === 'TRUE', isOwner: login === owner,
               addedAt: fmt(r[4]), lastSeen: fmt(r[6]), bills: bills[login] || 0,
               hasPin: !!r[U_PIN_HASH - 1], pinSetAt: fmt(r[U_PIN_SET - 1]) };
    }).sort(function (a, b) { return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }); }),   // alphabetical
  };
}

/**
 * Add or edit a user. input = { email (login), name, role, active, originalEmail?, pin? }
 * A new user gets the given PIN, or a random one, which is returned once so it can be handed over.
 */
function saveUser(input) {
  const me = requireAdmin_();
  const result = withLock_(function () {
    input = input || {};
    const login = normLogin_(input.email);
    if (!/^[a-z0-9._@+-]{2,60}$/.test(login)) throw new Error('Login: 2–60 letters, numbers, dots or dashes (e.g. "kasun" or an e-mail).');
    const name = clean_(input.name, 80);
    if (!name) throw new Error('Enter the person\'s name (it is shown on every bill they record).');
    let role = input.role === 'Admin' ? 'Admin' : 'Employee';
    let active = input.active !== false;
    const original = normLogin_(input.originalEmail);
    const owner = ownerEmail_();

    if (original === owner || login === owner) { role = 'Admin'; active = true; }
    if (original === owner && login !== owner) throw new Error('The owner\'s login cannot be changed.');
    if ((original || login) === me.email && (!active || role !== 'Admin')) throw new Error('You cannot remove your own Admin access.');

    const sh = sheet_(SHEET.USERS);
    const rowOrig = original ? findUserRow_(original) : 0;
    const rowNew = findUserRow_(login);
    if (rowNew && rowNew !== rowOrig) throw new Error('"' + login + '" is already in the list.');

    const now = new Date();
    let action, pin = '';
    if (rowOrig) {
      const prevRole = sh.getRange(rowOrig, 3).getValue();
      sh.getRange(rowOrig, 1, 1, 4).setValues([[login, name, role, active]]);
      if (role === 'Admin' && prevRole !== 'Admin') {
        const team = defaultPin_(), h = String(sh.getRange(rowOrig, U_PIN_HASH).getValue()), s = String(sh.getRange(rowOrig, U_PIN_SALT).getValue());
        if (team && h && pinHash_(s, team) === h) {         // still on the shared team PIN → private PIN
          pin = randomPin_();
          const salt = Utilities.getUuid();
          sh.getRange(rowOrig, U_PIN_HASH, 1, 3).setValues([[pinHash_(salt, pin), salt, now]]);
          endSessionsFor_(original);
        }
      }
      sh.getRange(rowOrig, 8).setValue(now);
      if (!active || login !== original) endSessionsFor_(original);     // sign them out everywhere
      if (login !== original) renameBillsLogin_(original, login);
      action = 'USER_UPDATE';
    } else {
      pin = pinOrDefault_(input.pin, role);
      const salt = Utilities.getUuid();
      appendRowAt_(sh, 1, [login, name, role, active, now, me.email, '', now, pinHash_(salt, pin), salt, now], [4]);
      action = 'USER_ADD';
    }
    sortUsersSheet_();
    const details = { login: login, previousLogin: original && original !== login ? original : undefined, name: name, role: role, active: active };
    audit_(action, login, details);
    journal_(action, login, details);
    return { pin: pin, message: action === 'USER_UPDATE' && pin
      ? name + ' is now an Admin and has been given a private PIN: ' + pin + '. Give it to them privately.'
      : action === 'USER_ADD'
      ? 'Added ' + name + ' as ' + role + '. Login: ' + login + '   PIN: ' + pin + '. Give the PIN to them privately; it will not be shown again.'
      : 'Saved ' + name + ' (' + login + ') as ' + role + (active ? '.' : ' — access switched off and signed out.') };
  });
  return result;
}

/** Removes the user from the list and ends their sessions. Their bills keep their name. */
function deleteUser(login) {
  const me = requireAdmin_();
  return withLock_(function () {
    login = normLogin_(login);
    if (login === ownerEmail_()) throw new Error('The owner cannot be deleted.');
    if (login === me.email) throw new Error('You cannot delete your own account.');
    const row = findUserRow_(login);
    if (!row) throw new Error('User not found.');
    const v = sheet_(SHEET.USERS).getRange(row, 1, 1, 3).getValues()[0];
    sheet_(SHEET.USERS).deleteRow(row);
    endSessionsFor_(login);
    const details = { login: login, name: v[1], role: v[2] };
    audit_('USER_DELETE', login, details);
    journal_('USER_DELETE', login, details);
    return { message: 'Deleted ' + (v[1] || login) + '. Their past bills are unchanged.' };
  });
}

/** A login was renamed: keep "Recorded By" and "My bills" pointing at the same person. */
function renameBillsLogin_(from, to) {
  const sh = sheet_(SHEET.BILLS);
  const n = lastDataRow_(sh, COL.REF) - 1;
  if (n < 1) return 0;
  const vals = sh.getRange(2, COL.RECORDED_BY, n, 1).getValues();
  let changed = 0;
  vals.forEach(function (r) { if (normLogin_(r[0]) === from) { r[0] = to; changed++; } });
  if (changed) {
    sh.getRange(2, COL.RECORDED_BY, n, 1).setValues(vals);
    audit_('USER_LOGIN_RENAMED', to, { from: from, to: to, billsUpdated: changed });
  }
  return changed;
}

/** Keeps the Users tab in alphabetical order of name. */
function sortUsersSheet_() {
  const sh = sheet_(SHEET.USERS);
  const n = lastDataRow_(sh, 1) - 1;
  if (n > 1) sh.getRange(2, 1, n, USER_HEADERS.length).sort({ column: 2, ascending: true });
}

/** A login made from a name: "Tharangika" → "tharangika" (made unique if needed). */
function loginFromName_(name) {
  const base = String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 40) || 'user';
  let login = base, i = 2;
  while (findUserRow_(login)) login = base + i++;
  return login;
}

/**
 * Add several people at once (Admin). text = names separated by commas or new lines.
 * Everyone gets the default PIN (Settings → DEFAULT_PIN, 2018) unless pin is given.
 * Names already in the list are skipped. Returns a summary.
 */
function addUsersBulk(text, pin, role) {
  const me = requireAdmin_();
  return withLock_(function () {
    const names = String(text || '').split(/[,\n;]+/).map(function (s) { return clean_(s, 80); }).filter(String);
    if (!names.length) throw new Error('Type at least one name.');
    role = role === 'Admin' ? 'Admin' : 'Employee';
    pin = pinOrDefault_(pin, role);
    const sh = sheet_(SHEET.USERS);
    const n = lastDataRow_(sh, 1) - 1;
    const existingNames = n > 0 ? sh.getRange(2, 2, n, 1).getValues().map(function (r) { return String(r[0]).toLowerCase().trim(); }) : [];
    const added = [], skipped = [];
    names.forEach(function (name) {
      if (existingNames.indexOf(name.toLowerCase()) >= 0) { skipped.push(name); return; }
      const login = loginFromName_(name);
      const salt = Utilities.getUuid(), now = new Date();
      appendRowAt_(sh, 1, [login, name, role, true, now, me.email, '', now, pinHash_(salt, pin), salt, now], [4]);
      existingNames.push(name.toLowerCase());
      added.push(name);
    });
    sortUsersSheet_();
    audit_('USERS_BULK_ADD', '', { added: added, skipped: skipped, role: role, by: me.email });
    journal_('USERS_BULK_ADD', '', { added: added, role: role });
    return { added: added, skipped: skipped, pin: added.length ? pin : '',
      message: (added.length ? 'Added ' + added.length + ': ' + added.join(', ') + '. PIN for all of them: ' + pin + '.' : 'Nobody new to add.') +
               (skipped.length ? ' Already in the list: ' + skipped.join(', ') + '.' : '') };
  });
}

/** setup(): load the current team once, the first time (never re-adds people you deleted). */
function seedInitialTeam_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('TEAM_SEEDED')) return;
  const sh = sheet_(SHEET.USERS);
  const n = lastDataRow_(sh, 1) - 1;
  const roles = n > 0 ? sh.getRange(2, 3, n, 1).getValues().map(function (r) { return r[0]; }) : [];
  if (roles.indexOf('Employee') < 0) addUsersBulk(INITIAL_TEAM.join(','), '', 'Employee');
  props.setProperty('TEAM_SEEDED', String(Date.now()));
}

/** Public: names for the sign-in dropdown (active people with a PIN), alphabetical. No secrets. */
function listLoginNames() {
  const sh = sheet_(SHEET.USERS);
  const n = lastDataRow_(sh, 1) - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, USER_HEADERS.length).getValues()
    .filter(function (r) { return r[0] && (r[3] === true || String(r[3]).toUpperCase() === 'TRUE') && r[U_PIN_HASH - 1]; })
    .map(function (r) { return { login: normLogin_(r[0]), name: String(r[1] || r[0]) }; })
    .sort(function (a, b) { return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }); });
}

/** Anyone signed in can replace their PIN with a private one. Returns a fresh sign-in token. */
function changeMyPin(oldPin, newPin) {
  const u = currentUser_();
  if (!u.row) throw new Error('Set the owner PIN in 👥 Users.');
  if (!u.pinHash || pinHash_(u.pinSalt, String(oldPin || '')) !== u.pinHash) throw new Error('Your current PIN is not correct.');
  newPin = validatePin_(newPin);
  if (newPin === String(oldPin)) throw new Error('The new PIN must be different.');
  if (newPin === defaultPin_()) throw new Error('Choose a private PIN, not the team PIN.');
  const salt = Utilities.getUuid(), now = new Date();
  sheet_(SHEET.USERS).getRange(u.row, U_PIN_HASH, 1, 3).setValues([[pinHash_(salt, newPin), salt, now]]);
  endSessionsFor_(u.email);
  audit_('PIN_CHANGED_BY_USER', u.email, {});
  CacheService.getScriptCache().remove('LF_' + u.email);
  return login(u.email, newPin, 'after PIN change');
}

function billsPerUser_() {
  const sh = sheet_(SHEET.BILLS);
  const n = lastDataRow_(sh, COL.REF) - 1;
  const out = {};
  if (n < 1) return out;
  sh.getRange(2, COL.RECORDED_BY, n, 1).getValues().forEach(function (r) {
    const e = normLogin_(r[0]); if (e) out[e] = (out[e] || 0) + 1;
  });
  return out;
}

function openUserSidebar() {
  requireSheetAdmin_();
  const t = HtmlService.createTemplateFromFile('Sidebar');
  t.panel = 'users';
  SpreadsheetApp.getUi().showSidebar(t.evaluate().setTitle('Manage users'));
}
