/**
 * Backup & recovery — four independent layers so an accident never loses data:
 *
 *  1. LIVE JOURNAL   Every create / edit / void / category change is appended, as a full
 *                    copy of the row, to a SEPARATE spreadsheet ("… Backup Journal").
 *                    Even if the main file is damaged or rows are deleted, the ledger
 *                    can be rebuilt from it (menu → Rebuild Bills from live journal).
 *  2. NIGHTLY SNAPSHOT  At ~2 AM a complete copy of this spreadsheet is saved to
 *                    <Root>/_Backups/Snapshots (kept for SNAPSHOT_RETENTION_DAYS, 7 newest always kept).
 *  3. NIGHTLY CSV    The Bills ledger is also exported as CSV (plain text, readable by
 *                    Excel or any tool) to <Root>/_Backups/CSV.
 *  4. NO HARD DELETES  Bills are voided, not deleted; categories in use are archived;
 *                    old backups go to Drive Trash (recoverable 30 days); sheets carry
 *                    edit warnings; Google Sheets version history remains available.
 */

const JOURNAL_HEADERS = ['Timestamp', 'Action', 'Reference', 'User', 'Data (JSON)'];

function backupFolder_() {
  const s = settings_();
  if (s.BACKUP_FOLDER_ID) { try { return DriveApp.getFolderById(s.BACKUP_FOLDER_ID); } catch (e) { } }
  const f = childFolder_(rootFolder_(), '_Backups');
  setSetting_('BACKUP_FOLDER_ID', f.getId());
  return f;
}

function backupBook_() {
  const s = settings_();
  if (s.BACKUP_SPREADSHEET_ID) {
    try { return SpreadsheetApp.openById(s.BACKUP_SPREADSHEET_ID); } catch (e) { }
  }
  const book = SpreadsheetApp.create((s.COMPANY_NAME ? s.COMPANY_NAME + ' ' : '') + 'Bills — Backup Journal (do not edit)');
  DriveApp.getFileById(book.getId()).moveTo(backupFolder_());
  const sh = book.getSheets()[0].setName('Journal');
  sh.getRange(1, 1, 1, JOURNAL_HEADERS.length).setValues([JOURNAL_HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 160).setColumnWidth(2, 150).setColumnWidth(3, 160).setColumnWidth(4, 200).setColumnWidth(5, 900);
  sh.protect().setDescription('Backup journal — append only').setWarningOnly(true);
  setSetting_('BACKUP_SPREADSHEET_ID', book.getId());
  return book;
}

function journalSheet_() {
  const book = backupBook_();
  return book.getSheetByName('Journal') || book.insertSheet('Journal');
}

function journal_(action, ref, data) {
  journalMany_([[action, ref, data]]);
}

/** entries = [[action, ref, dataObject], …] */
function journalMany_(entries) {
  if (!entries || !entries.length) return;
  try {
    const user = userEmail_(), now = new Date();
    const rows = entries.map(function (e) { return [now, e[0], e[1] || '', user, JSON.stringify(e[2] || {})]; });
    const sh = journalSheet_();
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, JOURNAL_HEADERS.length).setValues(rows);
  } catch (err) {
    console.error('journal failed: ' + err);
    audit_('BACKUP_JOURNAL_ERROR', entries[0][1], { error: String(err) });
  }
}

// ---------------------------- Nightly backup --------------------------------

/** Time-driven trigger (installed by setup). */
function runNightlyBackup() {
  try {
    const result = createSnapshot_();
    audit_('BACKUP', '', result);
    try { integrityCheck_(); } catch (e) { audit_('INTEGRITY_ERROR', '', { error: String(e) }); }
  } catch (err) {
    audit_('BACKUP_ERROR', '', { error: String(err) });
    const to = settings_().ALERT_EMAIL;
    if (to) MailApp.sendEmail(String(to), 'Bill Manager: nightly backup FAILED', 'Error: ' + err + '\n\nSpreadsheet: ' + ss_().getUrl());
    throw err;
  }
}

/** Menu item. */
function backupNow() {
  const r = createSnapshot_();
  audit_('BACKUP_MANUAL', '', r);
  SpreadsheetApp.getUi().alert('Backup complete', 'Snapshot: ' + r.snapshot + '\nCSV: ' + r.csv + '\nBills backed up: ' + r.bills, SpreadsheetApp.getUi().ButtonSet.OK);
}

function createSnapshot_() {
  const ss = ss_();
  const s = settings_();
  const root = backupFolder_();
  const snapFolder = childFolder_(root, 'Snapshots');
  const csvFolder = childFolder_(root, 'CSV');
  const stamp = Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd_HHmm');

  SpreadsheetApp.flush();
  const copy = DriveApp.getFileById(ss.getId()).makeCopy(ss.getName() + ' — Snapshot ' + stamp, snapFolder);

  const sh = sheet_(SHEET.BILLS);
  const values = sh.getDataRange().getDisplayValues();
  const csvName = 'Bills_' + stamp + '.csv';
  csvFolder.createFile(csvName, toCsv_(values), MimeType.CSV);

  const catSh = sheet_(SHEET.CATEGORIES);
  csvFolder.createFile('Categories_' + stamp + '.csv', toCsv_(catSh.getDataRange().getDisplayValues()), MimeType.CSV);

  prune_(snapFolder, Number(s.SNAPSHOT_RETENTION_DAYS) || 60, 7);
  prune_(csvFolder, Number(s.CSV_RETENTION_DAYS) || 730, 14);

  setSetting_('LAST_BACKUP_AT', new Date());
  return { snapshot: copy.getName(), csv: csvName, bills: Math.max(values.length - 1, 0) };
}

/** Moves files older than `days` to Drive Trash, always keeping the `keep` newest. */
function prune_(folder, days, keep) {
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) files.push(it.next());
  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  const cutoff = Date.now() - days * 86400000;
  files.slice(keep).forEach(function (f) {
    if (f.getDateCreated().getTime() < cutoff) f.setTrashed(true);
  });
}

function toCsv_(rows) {
  return rows.map(function (r) {
    return r.map(function (v) {
      const s = String(v == null ? '' : v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  }).join('\r\n');
}

// ------------------------------- Restore ------------------------------------
// Restores never overwrite the live ledger: they add a new tab for you to review,
// then you can copy rows back or rename the tab to "Bills" yourself.

function restoreFromLatestSnapshot() {
  const ui = SpreadsheetApp.getUi();
  const snapFolder = childFolder_(backupFolder_(), 'Snapshots');
  let latest = null;
  const it = snapFolder.getFilesByType(MimeType.GOOGLE_SHEETS);
  while (it.hasNext()) {
    const f = it.next();
    if (!latest || f.getDateCreated() > latest.getDateCreated()) latest = f;
  }
  if (!latest) { ui.alert('No snapshots found yet. Use "Back up now" first.'); return; }

  const ok = ui.alert('Restore from snapshot', 'Copy the Bills tab from:\n' + latest.getName() +
    '\n\ninto a NEW tab in this spreadsheet? (Your current Bills tab is not changed.)', ui.ButtonSet.OK_CANCEL);
  if (ok !== ui.Button.OK) return;

  const src = SpreadsheetApp.openById(latest.getId()).getSheetByName(SHEET.BILLS);
  if (!src) { ui.alert('That snapshot has no Bills tab.'); return; }
  const copied = src.copyTo(ss_());
  const name = 'Bills (restored ' + Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HHmm') + ')';
  copied.setName(name);
  audit_('RESTORE_SNAPSHOT', '', { from: latest.getName(), tab: name });
  ss_().setActiveSheet(copied);
  ui.alert('Restored into tab "' + name + '". Review it, then copy any missing rows back to "' + SHEET.BILLS + '".');
}

/** Replays the live journal: the latest saved state of every bill → a new tab. */
function rebuildFromJournal() {
  const ui = SpreadsheetApp.getUi();
  const jsh = journalSheet_();
  const n = jsh.getLastRow() - 1;
  if (n < 1) { ui.alert('The journal is empty.'); return; }

  const billActions = ['CREATE', 'EDIT', 'UPDATE', 'VOID', 'CATEGORY_RENAME'];
  const latest = {}, order = [];
  jsh.getRange(2, 1, n, JOURNAL_HEADERS.length).getValues().forEach(function (r) {
    if (billActions.indexOf(r[1]) < 0 || !r[2]) return;
    let obj;
    try { obj = JSON.parse(r[4]); } catch (e) { return; }
    if (!obj || !obj.REF) return;
    if (!latest[obj.REF]) order.push(obj.REF);
    latest[obj.REF] = obj;
  });
  if (!order.length) { ui.alert('No bill records found in the journal.'); return; }

  const isoDate = /^\d{4}-\d{2}-\d{2}T/;
  const rows = order.sort().map(function (ref) {
    const o = latest[ref];
    return BILL_COLUMNS.map(function (c) {
      const v = o[c[0]];
      return typeof v === 'string' && isoDate.test(v) ? new Date(v) : (v == null ? '' : v);
    });
  });

  const name = 'Bills (rebuilt ' + Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HHmm') + ')';
  const sh = ss_().insertSheet(name);
  sh.getRange(1, 1, 1, NCOLS).setValues([BILL_COLUMNS.map(function (c) { return c[1]; })]);
  styleHeader_(sh, NCOLS);
  sh.getRange(2, 1, rows.length, NCOLS).setValues(rows);
  sh.getRange(2, COL.BILL_DATE, rows.length, 1).setNumberFormat('dd/MM/yyyy');
  sh.getRange(2, COL.PERIOD, rows.length, 1).setNumberFormat('yyyy-mm');
  sh.getRange(2, COL.AMOUNT, rows.length, 3).setNumberFormat(currencyFormat_());
  sh.setFrozenRows(1);
  audit_('REBUILD_FROM_JOURNAL', '', { tab: name, bills: rows.length });
  ss_().setActiveSheet(sh);
  ui.alert('Rebuilt ' + rows.length + ' bill(s) into tab "' + name + '". Compare it with "' + SHEET.BILLS + '" and copy back anything missing.');
}

function openBackupFolder() {
  const f = backupFolder_();
  const html = HtmlService.createHtmlOutput('<p style="font:14px Arial">Backup folder: <a target="_blank" href="' + f.getUrl() +
    '">' + escapeHtml_(f.getName()) + '</a><br><br>Last nightly backup: ' + escapeHtml_(String(settings_().LAST_BACKUP_AT || 'not yet')) + '</p>')
    .setWidth(480).setHeight(140);
  SpreadsheetApp.getUi().showModalDialog(html, 'Backups');
}
