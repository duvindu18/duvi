/**
 * MAARAA Bill Manager — Google Apps Script
 * --------------------------------------------------------------------------
 * A receipt-first expense register for monthly bills.
 *
 *  • Bills are entered through a small web form (photo / screenshot / PDF).
 *  • Every bill gets an automatic, gap-free reference number
 *        BILL-YYYYMM-NNNN   (e.g. BILL-202611-0007)
 *    and its images are renamed to that reference and filed in Google Drive
 *        <Root>/Receipts/2026/11 - November/BILL-202611-0007_Printing_2026-11-16.jpg
 *  • All data lives in this Google Sheet (one ledger + reports).
 *  • Categories can be added, renamed (history follows), archived or deleted.
 *  • Nothing is ever hard-deleted: bills are VOIDED, every change is audited,
 *    every write is mirrored to a separate backup spreadsheet in real time,
 *    and a full snapshot + CSV is taken every night.
 *
 * Files in this project:
 *   Code.gs             – setup, ledger, categories, web app, menu
 *   Backup.gs           – live journal, nightly snapshots, restore tools
 *   Index.html          – bill entry user interface
 *   CategoryManager.html, Common.html, Styles.html, Sidebar.html – UI parts
 * --------------------------------------------------------------------------
 */

// ============================== CONFIGURATION ==============================

const SHEET = {
  BILLS: 'Bills',
  SUMMARY: 'Monthly Summary',
  ANNUAL: 'Annual Summary',
  CATEGORIES: 'Categories',
  METHODS: 'Payment Methods',
  AUDIT: 'Audit Log',
  SETTINGS: 'Settings',
  USERS: 'Users',
};

/** Ledger columns: [key, header, width]. Order = column order in the sheet. */
const BILL_COLUMNS = [
  ['REF',         'Ref No',                       150],
  ['BILL_DATE',   'Bill Date',                    95],
  ['PERIOD',      'Period',                       75],
  ['VENDOR',      'Company / Person (Payee)',     200],
  ['INVOICE_NO',  'Vendor Invoice / Receipt No',  140],
  ['CAT_CODE',    'Category Code',                90],
  ['CATEGORY',    'Expense Category',             190],
  ['DESCRIPTION', 'Description',                  300],
  ['PROJECT',     'Project / Client',             170],
  ['METHOD',      'Payment Method',               125],
  ['PAY_REF',     'Payment Ref (Cheque / Txn No)', 160],
  ['AMOUNT',      'Amount excl. Tax (LKR)',       130],
  ['TAX',         'Tax / VAT (LKR)',              110],
  ['TOTAL',       'Total (LKR)',                  130],
  ['PAY_STATUS',  'Payment Status',               110],
  ['DUE_DATE',    'Due Date',                     95],
  ['REMARKS',     'Remarks',                      220],
  ['RECEIPT',     'Receipt',                      200],
  ['FILE_NAMES',  'Attachment File Names',        260],
  ['FILE_LINKS',  'Attachment Links',             260],
  ['FILE_IDS',    'Attachment File IDs',          200],
  ['FILE_HASHES', 'File Fingerprints',            160],
  ['STATUS',      'Record Status',                105],
  ['RECORDED_BY', 'Recorded By (Google Account)', 220],
  ['RECORDED_BY_NAME', 'Recorded By (Name)',      160],
  ['RECORDED_AT', 'Recorded At',                  145],
  ['VOID_NOTE',   'Void Reason / Notes',          220],
  ['SUBMISSION_ID', 'Submission ID',              120],
  ['LAST_EDIT_BY', 'Last Edited By',             190],
  ['LAST_EDIT_AT', 'Last Edited At',             135],
];
const COL = {};
BILL_COLUMNS.forEach(function (c, i) { COL[c[0]] = i + 1; });
const NCOLS = BILL_COLUMNS.length;

const CATEGORY_HEADERS = ['Code', 'Category Name', 'Group', 'Monthly Budget (LKR)', 'Active', 'Created At', 'Updated At', 'Notes'];
const PAY_STATUSES = ['Paid', 'Unpaid', 'Partially Paid'];

/** Your existing chart of accounts (spelling corrected) + a few common additions. */
const DEFAULT_CATEGORIES = [
  ['Stationery',                       'Office & Administration'],
  ['Printing',                         'Office & Administration'],
  ['Postal and Courier',               'Office & Administration'],
  ['Office Refreshments & Consumables','Office & Administration'],
  ['Maintenance',                      'Office & Administration'],
  ['Rent',                             'Office & Administration'],
  ['Software & Subscriptions',         'Office & Administration'],
  ['Travelling - Taxi',                'Travel & Transport'],
  ['Travelling - Fuel',                'Travel & Transport'],
  ['Travelling - Overseas',            'Travel & Transport'],
  ['Travelling - Other',               'Travel & Transport'],
  ['Vehicle Loans and Expenses',       'Travel & Transport'],
  ['Electricity Bills',                'Utilities'],
  ['Water Bills',                      'Utilities'],
  ['Telecommunication Bills',          'Utilities'],
  ['Salaries and Bonus',               'Staff Costs'],
  ['Staff Welfare',                    'Staff Costs'],
  ['Other Consultants',                'Professional & Project Costs'],
  ['Council & Approval Fees',          'Professional & Project Costs'],
  ['Membership and Award Fees',        'Professional & Project Costs'],
  ['Bank Charges',                     'Finance & Statutory'],
  ['Taxes & Licences',                 'Finance & Statutory'],
  ['Equipment & Furniture (Capital)',  'Capital Expenditure'],
  ['Miscellaneous Expenses',           'Other'],
];

const DEFAULT_METHODS = ['Cash', 'Petty Cash', 'Bank Transfer', 'Cheque', 'Debit / Credit Card', 'Online / QR Payment', 'Standing Order'];

const DEFAULT_SETTINGS = [
  ['COMPANY_NAME',          'MAARAA',  'Shown on the entry form and folder names.'],
  ['REF_PREFIX',            'BILL',    'Reference format: PREFIX-YYYYMM-NNNN. Changing it affects new bills only.'],
  ['CURRENCY_SYMBOL',       'Rs.',     'Used for display and number formats.'],
  ['REQUIRE_ATTACHMENT',    true,      'TRUE = a bill cannot be recorded without a receipt image/PDF ("no receipt, no entry").'],
  ['MAX_FILES_PER_BILL',    10,        'Maximum images/PDFs attached to one bill.'],
  ['SNAPSHOT_RETENTION_DAYS', 60,      'Nightly full-spreadsheet snapshots older than this are moved to Drive trash (7 newest always kept).'],
  ['CSV_RETENTION_DAYS',    730,       'Nightly CSV exports of the Bills ledger kept this long.'],
  ['ALERT_EMAIL',           '',        'Optional: e-mail address notified if a nightly backup fails.'],
  ['ROOT_FOLDER_ID',        '',        'Auto-filled: Drive folder holding receipts and backups.'],
  ['BACKUP_FOLDER_ID',      '',        'Auto-filled: Drive folder for backups.'],
  ['BACKUP_SPREADSHEET_ID', '',        'Auto-filled: separate spreadsheet with the live backup journal.'],
  ['LAST_BACKUP_AT',        '',        'Auto-filled: time of the last successful nightly backup.'],
  ['EDIT_WINDOW_DAYS',      30,        'Employees can correct their own bills for this many days after recording (Admins: always).'],
];

// ================================ SETUP ====================================

/**
 * Run once from the editor (or menu → Setup / repair). Safe to run again:
 * it only creates what is missing and re-applies formats & triggers.
 */
function setup() {
  const ss = ss_();
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  ownerEmail_();

  const steps = [
    ['Settings tab', ensureSettingsSheet_], ['Categories tab', ensureCategoriesSheet_], ['Payment Methods tab', ensureMethodsSheet_],
    ['Bills tab', ensureBillsSheet_], ['Audit Log tab', ensureAuditSheet_], ['Users tab', ensureUsersSheet_],
    ['Monthly & Annual summaries', refreshReports_], ['Drive folders', function () { rootFolder_(); backupFolder_(); }],
    ['Backup journal', backupBook_], ['Automatic triggers', installTriggers_], ['Tidy up', removeEmptyDefaultSheet_],
  ];
  const failed = [];
  steps.forEach(function (st) {
    try { st[1](); } catch (e) { failed.push(st[0] + ' — ' + e.message); console.error(st[0], e); }
  });

  ss.setActiveSheet(ss.getSheetByName(SHEET.BILLS) || ss.getSheets()[0]);
  audit_('SETUP', '', { version: '1.3', failed: failed });
  const msg = failed.length ? 'Setup finished with problems:\n\n' + failed.join('\n') : 'Setup complete. Use the 🧾 Bill Manager menu to record bills.';
  try { SpreadsheetApp.getUi().alert('Bill Manager setup', msg, SpreadsheetApp.getUi().ButtonSet.OK); }
  catch (e) { console.log(msg); toast_(msg); }
  if (failed.length) console.error(msg);
}

function ensureSettingsSheet_() {
  const sh = getOrCreateSheet_(SHEET.SETTINGS);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 3).setValues([['Key', 'Value', 'Description']]);
  }
  const existing = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return r[0]; }) : [];
  const missing = DEFAULT_SETTINGS.filter(function (s) { return existing.indexOf(s[0]) < 0; });
  if (missing.length) sh.getRange(sh.getLastRow() + 1, 1, missing.length, 3).setValues(missing);
  styleHeader_(sh, 3);
  sh.setColumnWidth(1, 220).setColumnWidth(2, 320).setColumnWidth(3, 560);
  sh.getRange('B:B').setHorizontalAlignment('left');
  protectWarn_(sh, 'Settings — edit with care');
  SETTINGS_CACHE_ = null;
}

function ensureBillsSheet_() {
  const sh = getOrCreateSheet_(SHEET.BILLS);
  if (sh.getMaxColumns() < NCOLS) sh.insertColumnsAfter(sh.getMaxColumns(), NCOLS - sh.getMaxColumns());
  sh.getRange(1, 1, 1, NCOLS).setValues([BILL_COLUMNS.map(function (c) { return c[1]; })]);
  styleHeader_(sh, NCOLS);
  // System columns get a grey header so it is obvious they are filled in automatically.
  LOCKED_BILL_COLS.forEach(function (k) { sh.getRange(1, COL[k]).setBackground('#555555'); });
  sh.setRowHeight(1, 40);
  sh.setFrozenRows(1);
  sh.setFrozenColumns(1);
  BILL_COLUMNS.forEach(function (c, i) { sh.setColumnWidth(i + 1, c[2]); });

  const rows = sh.getMaxRows() - 1;
  const cur = currencyFormat_();
  sh.getRange(2, 1, rows, NCOLS).setFontFamily('Arial').setFontSize(10).setVerticalAlignment('top');
  sh.getRange(2, COL.BILL_DATE, rows, 1).setNumberFormat('dd/MM/yyyy');
  sh.getRange(2, COL.DUE_DATE, rows, 1).setNumberFormat('dd/MM/yyyy');
  sh.getRange(2, COL.PERIOD, rows, 1).setNumberFormat('mmm yyyy');
  sh.getRange(2, COL.RECORDED_AT, rows, 1).setNumberFormat('dd/MM/yyyy HH:mm');
  sh.getRange(2, COL.LAST_EDIT_AT, rows, 1).setNumberFormat('dd/MM/yyyy HH:mm');
  sh.getRange(2, COL.AMOUNT, rows, 3).setNumberFormat(cur).setHorizontalAlignment('right');

  // Dropdowns / checks on the columns an Admin may correct by hand.
  const list = function (l) { return SpreadsheetApp.newDataValidation().requireValueInList(l, true).setAllowInvalid(false).build(); };
  sh.getRange(2, COL.PAY_STATUS, rows, 1).setDataValidation(list(PAY_STATUSES));
  sh.getRange(2, COL.STATUS, rows, 1).setDataValidation(list(['ACTIVE', 'VOID']));
  sh.getRange(2, COL.CATEGORY, rows, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInRange(sheet_(SHEET.CATEGORIES).getRange('B2:B'), true).setAllowInvalid(false).build());
  sh.getRange(2, COL.METHOD, rows, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInRange(sheet_(SHEET.METHODS).getRange('A2:A'), true).setAllowInvalid(false).build());
  sh.getRange(2, COL.BILL_DATE, rows, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build());
  sh.getRange(2, COL.DUE_DATE, rows, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(true).build());
  sh.getRange(2, COL.AMOUNT, rows, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireNumberGreaterThan(0).setAllowInvalid(false).build());
  sh.getRange(2, COL.TAX, rows, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireNumberGreaterThanOrEqualTo(0).setAllowInvalid(false).build());

  // Black & white cues: voided rows struck through and grey; unpaid rows italic on light grey.
  const L = colLetter_;
  const all = sh.getRange(2, 1, rows, NCOLS);
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$' + L(COL.STATUS) + '2="VOID"')
      .setStrikethrough(true).setFontColor('#9e9e9e').setRanges([all]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($' + L(COL.STATUS) + '2="ACTIVE",$' + L(COL.PAY_STATUS) + '2<>"Paid",$' + L(COL.PAY_STATUS) + '2<>"")')
      .setItalic(true).setBackground('#eeeeee').setRanges([all]).build(),
  ]);

  // Borders + wrapping on every recorded row.
  const last = lastDataRow_(sh, COL.REF);
  if (last > 1) styleBillRows_(sh, 2, last - 1);

  // Technical columns are kept but hidden.
  sh.hideColumns(COL.FILE_IDS, 2);
  sh.hideColumns(COL.SUBMISSION_ID);
  if (!sh.getFilter()) sh.getRange(1, 1, sh.getMaxRows(), NCOLS).createFilter();
  protectBillsSheet_(sh);
}

/** Columns the system fills in. Only the owner can change them; the rest can be corrected by an Admin. */
const LOCKED_BILL_COLS = ['REF', 'PERIOD', 'CAT_CODE', 'TOTAL', 'RECEIPT', 'FILE_NAMES', 'FILE_LINKS', 'FILE_IDS', 'FILE_HASHES',
  'STATUS', 'RECORDED_BY', 'RECORDED_BY_NAME', 'RECORDED_AT', 'VOID_NOTE', 'SUBMISSION_ID', 'LAST_EDIT_BY', 'LAST_EDIT_AT'];

function protectBillsSheet_(sh) {
  sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function (p) { p.remove(); });
  sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) {
    if (/^(System column|Header row)/.test(p.getDescription())) p.remove();
  });
  const owner = ownerEmail_();
  const lockTo = function (range, desc) {
    const p = range.protect().setDescription(desc);
    try { p.removeEditors(p.getEditors()); if (owner) p.addEditor(owner); if (p.canDomainEdit()) p.setDomainEdit(false); } catch (e) { }
  };
  lockTo(sh.getRange(1, 1, 1, NCOLS), 'Header row — locked');
  const idx = LOCKED_BILL_COLS.map(function (k) { return COL[k]; }).sort(function (a, b) { return a - b; });
  // Protect contiguous runs of locked columns.
  let start = idx[0], prev = idx[0];
  for (let i = 1; i <= idx.length; i++) {
    if (idx[i] === prev + 1) { prev = idx[i]; continue; }
    lockTo(sh.getRange(2, start, sh.getMaxRows() - 1, prev - start + 1), 'System column — filled automatically');
    start = idx[i]; prev = idx[i];
  }
}

/** Borders, wrapping and alignment for ledger rows (called after every write). */
function styleBillRows_(sh, fromRow, n) {
  if (n < 1) return;
  const r = sh.getRange(fromRow, 1, n, NCOLS);
  r.setBorder(true, true, true, true, true, true, '#9e9e9e', SpreadsheetApp.BorderStyle.SOLID)
    .setVerticalAlignment('top').setFontFamily('Arial').setFontSize(10).setFontColor('#000000');
  ['VENDOR', 'CATEGORY', 'DESCRIPTION', 'PROJECT', 'REMARKS', 'VOID_NOTE', 'RECORDED_BY', 'RECORDED_BY_NAME', 'LAST_EDIT_BY', 'PAY_REF', 'INVOICE_NO']
    .forEach(function (k) { sh.getRange(fromRow, COL[k], n, 1).setWrap(true); });
  ['FILE_NAMES', 'FILE_LINKS'].forEach(function (k) { sh.getRange(fromRow, COL[k], n, 1).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP); });
  sh.getRange(fromRow, COL.REF, n, 1).setFontWeight('bold');
  sh.getRange(fromRow, COL.AMOUNT, n, 3).setHorizontalAlignment('right');
  sh.getRange(fromRow, COL.TOTAL, n, 1).setFontWeight('bold');
}

function ensureCategoriesSheet_() {
  const sh = getOrCreateSheet_(SHEET.CATEGORIES);
  sh.getRange(1, 1, 1, CATEGORY_HEADERS.length).setValues([CATEGORY_HEADERS]);
  styleHeader_(sh, CATEGORY_HEADERS.length);
  sh.setFrozenRows(1);
  [90, 260, 220, 160, 70, 140, 140, 260].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  if (lastDataRow_(sh, 1) < 2) {
    const now = new Date();
    const rows = DEFAULT_CATEGORIES.map(function (c, i) {
      return ['CAT-' + pad_(i + 1, 3), c[0], c[1], '', true, now, now, ''];
    });
    sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }
  compactTable_(sh, CATEGORY_HEADERS.length, [5]);
  const n = Math.max(lastDataRow_(sh, 1) - 1, 1);
  sh.getRange(2, 4, n, 1).setNumberFormat(currencyFormat_());
  sh.getRange(2, 6, n, 2).setNumberFormat('dd/MM/yyyy HH:mm');
  protectWarn_(sh, 'Categories — please use "Manage categories" so history stays consistent');
}

function ensureMethodsSheet_() {
  const sh = getOrCreateSheet_(SHEET.METHODS);
  sh.getRange(1, 1, 1, 2).setValues([['Payment Method', 'Active']]);
  if (lastDataRow_(sh, 1) < 2) {
    sh.getRange(2, 1, DEFAULT_METHODS.length, 2).setValues(DEFAULT_METHODS.map(function (m) { return [m, true]; }));
  }
  styleHeader_(sh, 2);
  sh.setColumnWidth(1, 220).setColumnWidth(2, 80);
  compactTable_(sh, 2, [2]);
}

function ensureAuditSheet_() {
  const sh = getOrCreateSheet_(SHEET.AUDIT);
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, 5).setValues([['Timestamp', 'User', 'Action', 'Reference', 'Details']]);
  styleHeader_(sh, 5);
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 150).setColumnWidth(2, 200).setColumnWidth(3, 150).setColumnWidth(4, 160).setColumnWidth(5, 700);
  sh.getRange('A2:A').setNumberFormat('dd/MM/yyyy HH:mm:ss');
  sh.getRange('A2:E').setFontFamily('Arial').setFontSize(9).setVerticalAlignment('top');
  sh.getRange('E2:E').setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  protectWarn_(sh, 'Audit log — do not edit');
}

/**
 * Repairs a small table: moves every real row up to start at row 2 (fixes rows that ended up at
 * 1001 because empty checkboxes filled the column), puts checkboxes ONLY on real rows, trims
 * surplus empty rows and draws borders.
 */
function compactTable_(sh, nCols, checkboxCols) {
  const last = sh.getLastRow();
  let vals = [];
  if (last >= 2) {
    vals = sh.getRange(2, 1, last - 1, nCols).getValues().filter(function (r) { return String(r[0]).trim() !== ''; });
    const area = sh.getRange(2, 1, sh.getMaxRows() - 1, nCols);
    area.clearContent().clearDataValidations().setBorder(false, false, false, false, false, false);
  }
  if (vals.length) {
    sh.getRange(2, 1, vals.length, nCols).setValues(vals);
    (checkboxCols || []).forEach(function (c) {
      sh.getRange(2, c, vals.length, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
    });
    styleTableRows_(sh, 2, vals.length, nCols);
  }
  const keep = vals.length + 1 + 100;
  if (sh.getMaxRows() > keep) sh.deleteRows(keep + 1, sh.getMaxRows() - keep);
}

function styleTableRows_(sh, fromRow, n, nCols) {
  if (n < 1) return;
  sh.getRange(fromRow, 1, n, nCols)
    .setBorder(true, true, true, true, true, true, '#9e9e9e', SpreadsheetApp.BorderStyle.SOLID)
    .setFontFamily('Arial').setFontSize(10).setFontColor('#000000').setVerticalAlignment('middle').setWrap(true);
}

/** Last row that has a real value in `col` (ignores empty cells and unticked checkboxes). */
function lastDataRow_(sh, col) {
  const last = sh.getLastRow();
  if (last < 2) return 1;
  const vals = sh.getRange(1, col, last, 1).getValues();
  for (let i = vals.length - 1; i >= 1; i--) {
    const v = vals[i][0];
    if (v !== '' && v !== null && v !== false) return i + 1;
  }
  return 1;
}

/** Writes a row directly below the last real row (never at row 1001). Returns the row number. */
function appendRowAt_(sh, keyCol, values, checkboxCols) {
  const row = lastDataRow_(sh, keyCol) + 1;
  if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 50);
  sh.getRange(row, 1, 1, values.length).setValues([values]);
  (checkboxCols || []).forEach(function (c) {
    sh.getRange(row, c).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  });
  styleTableRows_(sh, row, 1, values.length);
  return row;
}

function installTriggers_() {
  const ss = ss_();
  const handlers = ['runNightlyBackup', 'onBillsEdit', 'onBillsChange', 'refreshReportsIfDirty'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (handlers.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runNightlyBackup').timeBased().everyDays(1).atHour(2).create();
  ScriptApp.newTrigger('onBillsEdit').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('onBillsChange').forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger('refreshReportsIfDirty').timeBased().everyMinutes(5).create();
}

function removeEmptyDefaultSheet_() {
  const ss = ss_();
  ['Sheet1', 'Sheet 1'].forEach(function (n) {
    const sh = ss.getSheetByName(n);
    if (sh && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });
}

// ============================== MENU & UI ==================================

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🧾 Bill Manager')
    .addItem('➕ Record a new bill', 'openEntryDialog')
    .addItem('🏷️ Manage categories', 'openCategorySidebar')
    .addSeparator()
    .addItem('🚫 Void selected bill…', 'voidSelectedBill')
    .addItem('↻ Refresh summaries', 'rebuildReports')
    .addItem('🖨 Save Monthly Summary as PDF (A4)', 'exportMonthlyPdf')
    .addItem('🖨 Save Annual Summary as PDF (A4 landscape)', 'exportAnnualPdf')
    .addItem('✅ Run integrity check', 'runIntegrityCheck')
    .addSeparator()
    .addSubMenu(ui.createMenu('🛟 Backup & restore')
      .addItem('Back up now', 'backupNow')
      .addItem('Restore Bills from latest snapshot (as new tab)', 'restoreFromLatestSnapshot')
      .addItem('Rebuild Bills from live journal (as new tab)', 'rebuildFromJournal')
      .addItem('Open backup folder', 'openBackupFolder'))
    .addItem('👥 Manage users (who can record bills)', 'openUserSidebar')
    .addItem('🔗 Show links', 'showLinks')
    .addItem('Reset Entry link…', 'resetEntryLink')
    .addSeparator()
    .addItem('⚙️ Setup / repair', 'setup')
    .addToUi();
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function openEntryDialog() {
  const html = HtmlService.createTemplateFromFile('Index').evaluate().setWidth(820).setHeight(860);
  SpreadsheetApp.getUi().showModalDialog(html, 'Record a bill');
}

function openCategorySidebar() {
  const t = HtmlService.createTemplateFromFile('Sidebar');
  t.panel = 'categories';
  const html = t.evaluate().setTitle('Manage categories');
  SpreadsheetApp.getUi().showSidebar(html);
}

function showLinks() {
  const url = ScriptApp.getService().getUrl();
  const root = rootFolder_();
  const html = HtmlService.createHtmlOutput(
    '<div style="font:14px Arial;line-height:1.6">' +
    '<p><b>Server URL</b> (paste into the Entry-link project, never give to staff):<br>' + (url ? '<code>' + url + '</code>' : 'not deployed yet — Deploy → New deployment → Web app') + '</p>' +
    '<p><b>Entry link</b> for staff: the web-app URL of the separate Entry-link (Gateway) project. Entry link activated: <b>' +
    (PropertiesService.getScriptProperties().getProperty('GATEWAY_AUDIENCE') ? 'yes' : 'not yet — open it once as the owner') + '</b></p>' +
    '<p><b>Receipts &amp; backups folder:</b> <a target="_blank" href="' + root.getUrl() + '">' + escapeHtml_(root.getName()) + '</a></p>' +
    '<p>Tip: on your phone, open the web app link and choose “Add to Home screen”.</p></div>'
  ).setWidth(620).setHeight(300);
  SpreadsheetApp.getUi().showModalDialog(html, 'Links');
}

// ======================== DATA FOR THE ENTRY FORM ===========================

function getFormData() {
  const u = currentUser_();          // sign-in + approved-user check
  touchLastSeen_(u);
  const s = settings_();
  return {
    company: s.COMPANY_NAME || '',
    currency: s.CURRENCY_SYMBOL || 'Rs.',
    refPrefix: s.REF_PREFIX || 'BILL',
    requireAttachment: toBool_(s.REQUIRE_ATTACHMENT),
    maxFiles: Number(s.MAX_FILES_PER_BILL) || 10,
    today: Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'),
    categories: categories_(false),
    methods: getPaymentMethods_(),
    statuses: PAY_STATUSES,
    vendors: recentDistinct_(COL.VENDOR, 300),
    projects: recentDistinct_(COL.PROJECT, 150),
    user: { email: u.email, name: u.name, role: u.role, isAdmin: u.role === 'Admin' },
    editWindowDays: editWindowDays_(),
  };
}

function getPaymentMethods_() {
  const sh = sheet_(SHEET.METHODS);
  if (sh.getLastRow() < 2) return DEFAULT_METHODS.slice();
  return sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues()
    .filter(function (r) { return r[0] && r[1] !== false; })
    .map(function (r) { return String(r[0]).trim(); });
}

function recentDistinct_(col, limit) {
  const sh = sheet_(SHEET.BILLS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const vals = sh.getRange(2, col, n, 1).getValues();
  const seen = {}, out = [];
  for (let i = vals.length - 1; i >= 0 && out.length < limit; i--) {
    const v = String(vals[i][0] || '').trim();
    const k = v.toLowerCase();
    if (v && !seen[k]) { seen[k] = true; out.push(v); }
  }
  return out.sort();
}

// ============================ RECORD A BILL =================================

/**
 * Called by the entry form.
 * payload = { submissionId, billDate:'yyyy-mm-dd', vendor, invoiceNo, categoryCode, description, project,
 *             paymentMethod, paymentRef, amount, tax, paymentStatus, dueDate, remarks,
 *             files:[{name, mimeType, data(base64), hash}], force:boolean }
 * Returns { ok:true, record } or { ok:false, duplicate:true, matches:[…] }.
 *
 * Precision guarantees:
 *  • Idempotent: the form sends a unique submissionId. If the same submission arrives twice
 *    (double tap, lost connection + retry) the first record is returned and nothing is duplicated.
 *  • Atomic: if any step fails, uploaded files are trashed and the half-written row is removed.
 *  • Verified: after writing, the row is read back from the sheet and every file is re-opened in Drive
 *    and its size compared byte-for-byte before the bill is confirmed to the user.
 */
function saveBill(payload) {
  payload = payload || {};
  const user = currentUser_();       // identity always comes from Google, never from the form
  const s = settings_();
  const submissionId = /^[A-Za-z0-9-]{8,64}$/.test(payload.submissionId || '') ? payload.submissionId : '';
  const cache = CacheService.getScriptCache();
  if (submissionId) {
    const cached = cache.get('SUB_' + submissionId);
    if (cached) return JSON.parse(cached);
  }

  const bill = validateBill_(payload, s);
  const files = (payload.files || []).map(function (f) {
    const bytes = Utilities.base64Decode(f.data);
    return { name: String(f.name || 'receipt'), mimeType: f.mimeType || 'application/octet-stream', bytes: bytes,
             hash: /^[0-9a-f]{64}$/.test(f.hash || '') ? f.hash : sha256Hex_(bytes) };
  });

  if (!payload.force) {
    const dups = findDuplicates_(bill, files.map(function (f) { return f.hash; }));
    if (dups.length) return { ok: false, duplicate: true, matches: dups };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('The system is busy recording another bill. Please press "Record bill" again — it will not be duplicated.');
  const created = [];
  let ref, row, rowIndex = 0, folder, sh;
  try {
    sh = sheet_(SHEET.BILLS);
    // Second line of defence for idempotency (cache may have expired).
    if (submissionId) {
      const existingRow = findRowByValue_(sh, COL.SUBMISSION_ID, submissionId);
      if (existingRow) {
        const v = sh.getRange(existingRow, 1, 1, NCOLS).getValues()[0];
        return { ok: true, alreadyRecorded: true, record: recordFromRow_(v, existingRow, true) };
      }
    }

    const next = nextRef_(bill.billDate);
    ref = next.ref;
    folder = monthFolder_(bill.billDate);
    files.forEach(function (f, i) {
      const name = buildFileName_(ref, bill, i, files.length, f);
      const file = folder.createFile(Utilities.newBlob(f.bytes, f.mimeType, name));
      file.setDescription(ref + ' | ' + fmtDate_(bill.billDate) + ' | ' + bill.vendor + ' | ' + bill.categoryName +
        ' | ' + (s.CURRENCY_SYMBOL || '') + bill.total.toFixed(2) + ' | original: ' + f.name);
      created.push({ id: file.getId(), name: name, url: file.getUrl(), hash: f.hash, mimeType: f.mimeType, size: f.bytes.length });
    });

    row = buildRow_(ref, bill, created, submissionId, user);
    rowIndex = lastDataRow_(sh, COL.REF) + 1;
    if (rowIndex > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 100);
    sh.getRange(rowIndex, 1, 1, NCOLS).setValues([row]);
    styleBillRows_(sh, rowIndex, 1);
    if (created.length) {
      const label = '📎 View receipt' + (created.length > 1 ? 's (' + created.length + ')' : '');
      sh.getRange(rowIndex, COL.RECEIPT).setRichTextValue(
        SpreadsheetApp.newRichTextValue().setText(label).setLinkUrl(created.length > 1 ? folder.getUrl() : created[0].url).build());
    }
    SpreadsheetApp.flush();
    verifySavedBill_(sh, rowIndex, ref, bill, created);
    next.commit();
  } catch (err) {
    created.forEach(function (c) { try { DriveApp.getFileById(c.id).setTrashed(true); } catch (e) { } });
    if (rowIndex && sh) {
      try { if (sh.getRange(rowIndex, COL.REF).getValue() === ref) sh.deleteRow(rowIndex); } catch (e) { }
    }
    audit_('CREATE_FAILED', ref || '', { error: String(err && err.message || err) });
    throw new Error('The bill was NOT recorded (nothing was saved). ' + String(err && err.message || err));
  } finally {
    lock.releaseLock();
  }

  const obj = rowToObject_(row);
  audit_('CREATE', ref, { row: rowIndex, vendor: bill.vendor, total: bill.total, category: bill.categoryName, files: created.length });
  journal_('CREATE', ref, obj);
  markReportsDirty_();

  const result = { ok: true, record: recordFromRow_(row, rowIndex, true) };
  if (submissionId) { try { cache.put('SUB_' + submissionId, JSON.stringify(result), 21600); } catch (e) { } }
  return result;
}

/** Reads the row and files back and compares them with what was intended. Throws on any mismatch. */
function verifySavedBill_(sh, rowIndex, ref, bill, created) {
  const back = sh.getRange(rowIndex, 1, 1, NCOLS).getValues()[0];
  const problems = [];
  const eqMoney = function (a, b) { return Math.round(Number(a) * 100) === Math.round(Number(b) * 100); };
  if (back[COL.REF - 1] !== ref) problems.push('reference');
  if (!(back[COL.BILL_DATE - 1] instanceof Date) || fmtDate_(back[COL.BILL_DATE - 1]) !== fmtDate_(bill.billDate)) problems.push('bill date');
  if (!eqMoney(back[COL.AMOUNT - 1], bill.amount)) problems.push('amount');
  if (!eqMoney(back[COL.TAX - 1], bill.tax)) problems.push('tax');
  if (!eqMoney(back[COL.TOTAL - 1], bill.total)) problems.push('total');
  if (back[COL.CAT_CODE - 1] !== bill.categoryCode) problems.push('category');
  if (String(back[COL.VENDOR - 1]) !== bill.vendor) problems.push('payee');
  if (!back[COL.RECORDED_BY - 1]) problems.push('recorded-by account');
  if (back[COL.STATUS - 1] !== 'ACTIVE') problems.push('status');
  created.forEach(function (c) {
    const f = DriveApp.getFileById(c.id);
    if (f.getSize() !== c.size) problems.push('file size of ' + c.name);
    if (f.getName() !== c.name) problems.push('file name of ' + c.name);
  });
  if (problems.length) throw new Error('Verification failed (' + problems.join(', ') + ').');
}

function recordFromRow_(v, rowIndex, verified) {
  const d = v[COL.BILL_DATE - 1], due = v[COL.DUE_DATE - 1];
  const names = String(v[COL.FILE_NAMES - 1] || '').split('\n').filter(String);
  const links = String(v[COL.FILE_LINKS - 1] || '').split('\n').filter(String);
  return {
    ref: v[COL.REF - 1], row: rowIndex, verified: !!verified,
    billDate: d instanceof Date ? fmtDate_(d) : String(d),
    period: d instanceof Date ? Utilities.formatDate(d, tz_(), 'MMMM yyyy') : '',
    vendor: v[COL.VENDOR - 1], invoiceNo: v[COL.INVOICE_NO - 1], category: v[COL.CATEGORY - 1],
    description: v[COL.DESCRIPTION - 1], project: v[COL.PROJECT - 1],
    paymentMethod: v[COL.METHOD - 1], paymentRef: v[COL.PAY_REF - 1],
    amount: Number(v[COL.AMOUNT - 1]) || 0, tax: Number(v[COL.TAX - 1]) || 0, total: Number(v[COL.TOTAL - 1]) || 0,
    paymentStatus: v[COL.PAY_STATUS - 1], dueDate: due instanceof Date ? fmtDate_(due) : '',
    remarks: v[COL.REMARKS - 1],
    files: names.map(function (n, i) { return { name: n, url: links[i] || '' }; }),
    recordedBy: v[COL.RECORDED_BY - 1], recordedByName: v[COL.RECORDED_BY_NAME - 1],
    recordedAt: v[COL.RECORDED_AT - 1] instanceof Date ? Utilities.formatDate(v[COL.RECORDED_AT - 1], tz_(), 'dd/MM/yyyy HH:mm') : '',
    sheetUrl: ss_().getUrl() + '#gid=' + sheet_(SHEET.BILLS).getSheetId() + '&range=A' + rowIndex,
  };
}

/** Called by the form as soon as a file is attached: warns early if this exact image is already recorded. */
function checkReceiptHashes(hashes) {
  currentUser_();
  hashes = (hashes || []).filter(function (h) { return /^[0-9a-f]{64}$/.test(h); });
  if (!hashes.length) return [];
  const sh = sheet_(SHEET.BILLS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const out = [];
  sh.getRange(2, 1, n, NCOLS).getValues().forEach(function (r) {
    if (r[COL.STATUS - 1] === 'VOID') return;
    const rh = String(r[COL.FILE_HASHES - 1] || '').split(/\s+/);
    hashes.forEach(function (h) {
      if (rh.indexOf(h) >= 0) out.push({ hash: h, ref: r[COL.REF - 1], vendor: r[COL.VENDOR - 1],
        billDate: r[COL.BILL_DATE - 1] instanceof Date ? fmtDate_(r[COL.BILL_DATE - 1]) : '' });
    });
  });
  return out;
}

// ======================= MY BILLS: VIEW & CORRECT OWN RECORDS ======================

/** Columns a person may correct from the app (everything else is system-controlled). */
const EDITABLE_FIELDS = ['BILL_DATE', 'VENDOR', 'INVOICE_NO', 'CAT_CODE', 'CATEGORY', 'DESCRIPTION', 'PROJECT', 'METHOD',
  'PAY_REF', 'AMOUNT', 'TAX', 'TOTAL', 'PAY_STATUS', 'DUE_DATE', 'REMARKS', 'PERIOD'];

function editWindowDays_() { return Math.max(0, Number(settings_().EDIT_WINDOW_DAYS) || 0); }

/** Can this user change this ledger row? Returns '' if yes, otherwise the reason. */
function editBlockReason_(u, r) {
  if (r[COL.STATUS - 1] !== 'ACTIVE') return 'Voided bills cannot be edited.';
  if (u.role === 'Admin') return '';
  if (String(r[COL.RECORDED_BY - 1] || '').toLowerCase() !== u.email) return 'You can only edit bills you recorded.';
  const at = r[COL.RECORDED_AT - 1], days = editWindowDays_();
  if (at instanceof Date && days && Date.now() - at.getTime() > days * 86400000)
    return 'Locked: bills can be corrected within ' + days + ' days. Ask an Admin.';
  return '';
}

/** The signed-in person's own bills (Admins: everyone's), newest first. */
function listMyBills(limit) {
  const u = currentUser_();
  const sh = sheet_(SHEET.BILLS);
  const last = lastDataRow_(sh, COL.REF);
  if (last < 2) return [];
  const iso = function (d) { return d instanceof Date ? Utilities.formatDate(d, tz_(), 'yyyy-MM-dd') : ''; };
  const out = [];
  const rows = sh.getRange(2, 1, last - 1, NCOLS).getValues();
  for (let i = rows.length - 1; i >= 0 && out.length < Math.min(Number(limit) || 60, 200); i--) {
    const r = rows[i];
    if (!r[COL.REF - 1]) continue;
    if (u.role !== 'Admin' && String(r[COL.RECORDED_BY - 1] || '').toLowerCase() !== u.email) continue;
    const reason = editBlockReason_(u, r);
    const rec = recordFromRow_(r, i + 2, false);
    rec.iso = { billDate: iso(r[COL.BILL_DATE - 1]), dueDate: iso(r[COL.DUE_DATE - 1]) };
    rec.categoryCode = r[COL.CAT_CODE - 1];
    rec.status = r[COL.STATUS - 1];
    rec.editable = !reason;
    rec.lockReason = reason;
    rec.lastEditBy = r[COL.LAST_EDIT_BY - 1] || '';
    out.push(rec);
  }
  return out;
}

/**
 * Correct a recorded bill. payload = same fields as saveBill (+ optional extra files).
 * Employees: own bills only, within EDIT_WINDOW_DAYS. Admins: any active bill.
 * The reference number never changes. Every changed field is written to the Audit Log.
 */
function updateBill(ref, payload) {
  payload = payload || {};
  const user = currentUser_();
  const s = settings_();
  const submissionId = /^[A-Za-z0-9-]{8,64}$/.test(payload.submissionId || '') ? payload.submissionId : '';
  const cache = CacheService.getScriptCache();
  if (submissionId) { const c = cache.get('UPD_' + submissionId); if (c) return JSON.parse(c); }

  const sh = sheet_(SHEET.BILLS);
  const rowIndex = findRowByValue_(sh, COL.REF, ref);
  if (!rowIndex) throw new Error('Bill ' + ref + ' was not found.');
  const before = sh.getRange(rowIndex, 1, 1, NCOLS).getValues()[0];
  const block = editBlockReason_(user, before);
  if (block) throw new Error(block);

  const existingIds = String(before[COL.FILE_IDS - 1] || '').split('\n').filter(String);
  const bill = validateBill_(payload, s, { existingFiles: existingIds.length, currentCategoryCode: before[COL.CAT_CODE - 1], isEdit: true });
  const files = (payload.files || []).map(function (f) {
    const bytes = Utilities.base64Decode(f.data);
    return { name: String(f.name || 'receipt'), mimeType: f.mimeType || 'application/octet-stream', bytes: bytes,
             hash: /^[0-9a-f]{64}$/.test(f.hash || '') ? f.hash : sha256Hex_(bytes) };
  });
  if (!payload.force) {
    const dups = findDuplicates_(bill, files.map(function (f) { return f.hash; }), ref);
    if (dups.length) return { ok: false, duplicate: true, matches: dups };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('The system is busy. Please press "Save changes" again — it will not be duplicated.');
  const created = [];
  let after;
  try {
    // Re-read inside the lock in case someone else changed it a moment ago.
    const current = sh.getRange(rowIndex, 1, 1, NCOLS).getValues()[0];
    if (current[COL.REF - 1] !== ref) throw new Error('The ledger changed while saving. Please reload and try again.');
    after = current.slice();
    const set = function (k, v) { after[COL[k] - 1] = v; };
    set('BILL_DATE', bill.billDate);
    set('PERIOD', new Date(bill.billDate.getFullYear(), bill.billDate.getMonth(), 1));
    set('VENDOR', bill.vendor); set('INVOICE_NO', bill.invoiceNo);
    set('CAT_CODE', bill.categoryCode); set('CATEGORY', bill.categoryName);
    set('DESCRIPTION', bill.description); set('PROJECT', bill.project);
    set('METHOD', bill.paymentMethod); set('PAY_REF', bill.paymentRef);
    set('AMOUNT', bill.amount); set('TAX', bill.tax); set('TOTAL', bill.total);
    set('PAY_STATUS', bill.paymentStatus); set('DUE_DATE', bill.dueDate || ''); set('REMARKS', bill.remarks);

    if (files.length) {
      const folder = monthFolder_(bill.billDate);
      const total = existingIds.length + files.length;
      files.forEach(function (f, i) {
        const name = buildFileName_(ref, bill, existingIds.length + i, Math.max(total, 2), f);
        const file = folder.createFile(Utilities.newBlob(f.bytes, f.mimeType, name));
        file.setDescription(ref + ' | added ' + fmtDate_(new Date()) + ' by ' + user.email + ' | original: ' + f.name);
        created.push({ id: file.getId(), name: name, url: file.getUrl(), hash: f.hash, size: f.bytes.length });
      });
      const join = function (k, extra) { return String(current[COL[k] - 1] || '').split('\n').filter(String).concat(extra).join('\n'); };
      set('FILE_NAMES', join('FILE_NAMES', created.map(function (c) { return c.name; })));
      set('FILE_LINKS', join('FILE_LINKS', created.map(function (c) { return c.url; })));
      set('FILE_IDS', join('FILE_IDS', created.map(function (c) { return c.id; })));
      set('FILE_HASHES', join('FILE_HASHES', created.map(function (c) { return c.hash; })));
    }
    set('LAST_EDIT_BY', user.email);
    set('LAST_EDIT_AT', new Date());

    const nonReceipt = after.slice();
    sh.getRange(rowIndex, 1, 1, NCOLS).setValues([nonReceipt]);
    const links = String(after[COL.FILE_LINKS - 1] || '').split('\n').filter(String);
    if (links.length) {
      const label = '📎 View receipt' + (links.length > 1 ? 's (' + links.length + ')' : '');
      sh.getRange(rowIndex, COL.RECEIPT).setRichTextValue(SpreadsheetApp.newRichTextValue().setText(label)
        .setLinkUrl(links.length > 1 ? monthFolder_(bill.billDate).getUrl() : links[0]).build());
    }
    styleBillRows_(sh, rowIndex, 1);
    SpreadsheetApp.flush();
    verifySavedBill_(sh, rowIndex, ref, bill, created);
  } catch (err) {
    created.forEach(function (c) { try { DriveApp.getFileById(c.id).setTrashed(true); } catch (e) { } });
    try { sh.getRange(rowIndex, 1, 1, NCOLS).setValues([before]); } catch (e) { }
    audit_('UPDATE_FAILED', ref, { error: String(err && err.message || err) });
    throw new Error('The changes were NOT saved. ' + String(err && err.message || err));
  } finally {
    lock.releaseLock();
  }

  // What changed (for the audit trail)
  const changes = {};
  EDITABLE_FIELDS.forEach(function (k) {
    const a = before[COL[k] - 1], b = after[COL[k] - 1];
    const fa = a instanceof Date ? fmtDate_(a) : String(a), fb = b instanceof Date ? fmtDate_(b) : String(b);
    if (fa !== fb) changes[k] = [fa, fb];
  });
  if (created.length) changes.FILES_ADDED = created.map(function (c) { return c.name; });
  audit_('UPDATE', ref, { row: rowIndex, by: user.email, changes: changes });
  journal_('UPDATE', ref, rowToObject_(after));
  markReportsDirty_();

  const result = { ok: true, updated: true, changes: Object.keys(changes).length, record: recordFromRow_(after, rowIndex, true) };
  if (submissionId) { try { cache.put('UPD_' + submissionId, JSON.stringify(result), 21600); } catch (e) { } }
  return result;
}

function validateBill_(p, s, opts) {
  opts = opts || {};
  const errs = [];
  const billDate = parseIsoDate_(p.billDate);
  const endToday = new Date(); endToday.setHours(23, 59, 59, 999);
  if (!billDate) errs.push('Bill date is required.');
  else if (billDate > endToday) errs.push('Bill date cannot be in the future.');

  const vendor = clean_(p.vendor, 150);
  if (!vendor) errs.push('Company / person (payee) is required.');
  const description = clean_(p.description, 1000);
  if (!description) errs.push('Description is required.');

  const cat = categories_(true).filter(function (c) { return c.code === p.categoryCode; })[0];
  if (!cat) errs.push('Please choose an expense category.');
  else if (!cat.active && cat.code !== opts.currentCategoryCode) errs.push('Category "' + cat.name + '" is archived. Restore it or choose another.');

  const methods = getPaymentMethods_();
  const paymentMethod = clean_(p.paymentMethod, 60);
  if (!paymentMethod || methods.indexOf(paymentMethod) < 0) errs.push('Please choose a payment method.');

  const amount = parseMoney_(p.amount);
  const tax = p.tax === '' || p.tax == null ? 0 : parseMoney_(p.tax);
  if (amount === null || amount <= 0) errs.push('Amount must be a number greater than zero.');
  if (tax === null || tax < 0) errs.push('Tax must be zero or a positive number.');

  const paymentStatus = PAY_STATUSES.indexOf(p.paymentStatus) >= 0 ? p.paymentStatus : 'Paid';
  const dueDate = p.dueDate ? parseIsoDate_(p.dueDate) : null;
  if (p.dueDate && !dueDate) errs.push('Due date is not valid.');

  const nFiles = (p.files || []).length;
  const max = Number(s.MAX_FILES_PER_BILL) || 10;
  const existing = opts.existingFiles || 0;
  if (toBool_(s.REQUIRE_ATTACHMENT) && !opts.isEdit && nFiles + existing === 0) errs.push('Please attach the bill photo, screenshot or PDF.');
  if (nFiles + existing > max) errs.push('A maximum of ' + max + ' files can be attached to one bill.');

  if (errs.length) throw new Error(errs.join('\n'));
  return {
    billDate: billDate, vendor: vendor, invoiceNo: clean_(p.invoiceNo, 80),
    categoryCode: cat.code, categoryName: cat.name, description: description,
    project: clean_(p.project, 150), paymentMethod: paymentMethod, paymentRef: clean_(p.paymentRef, 80),
    amount: round2_(amount), tax: round2_(tax), total: (Math.round(amount * 100) + Math.round(tax * 100)) / 100,
    paymentStatus: paymentStatus, dueDate: dueDate, remarks: clean_(p.remarks, 1000),
  };
}

function buildRow_(ref, b, files, submissionId, user) {
  const row = new Array(NCOLS).fill('');
  const set = function (k, v) { row[COL[k] - 1] = v; };
  set('REF', ref);
  set('BILL_DATE', b.billDate);
  set('PERIOD', new Date(b.billDate.getFullYear(), b.billDate.getMonth(), 1));
  set('VENDOR', b.vendor);
  set('INVOICE_NO', b.invoiceNo);
  set('CAT_CODE', b.categoryCode);
  set('CATEGORY', b.categoryName);
  set('DESCRIPTION', b.description);
  set('PROJECT', b.project);
  set('METHOD', b.paymentMethod);
  set('PAY_REF', b.paymentRef);
  set('AMOUNT', b.amount);
  set('TAX', b.tax);
  set('TOTAL', b.total);
  set('PAY_STATUS', b.paymentStatus);
  set('DUE_DATE', b.dueDate || '');
  set('REMARKS', b.remarks);
  set('RECEIPT', files.length ? '📎 View receipt' : '—');
  set('FILE_NAMES', files.map(function (f) { return f.name; }).join('\n'));
  set('FILE_LINKS', files.map(function (f) { return f.url; }).join('\n'));
  set('FILE_IDS', files.map(function (f) { return f.id; }).join('\n'));
  set('FILE_HASHES', files.map(function (f) { return f.hash; }).join('\n'));
  set('STATUS', 'ACTIVE');
  set('RECORDED_BY', user.email);
  set('RECORDED_BY_NAME', user.name);
  set('RECORDED_AT', new Date());
  set('SUBMISSION_ID', submissionId || '');
  return row;
}

/** Next gap-free reference for the bill's month. Caller must hold the script lock and call commit() after the row is written. */
function nextRef_(billDate) {
  const period = Utilities.formatDate(billDate, tz_(), 'yyyyMM');
  const prefix = String(settings_().REF_PREFIX || 'BILL').trim().toUpperCase() + '-' + period + '-';
  const props = PropertiesService.getScriptProperties();
  const key = 'SEQ_' + prefix;
  const stored = Number(props.getProperty(key) || 0);

  let maxInSheet = 0;
  const sh = sheet_(SHEET.BILLS);
  const n = sh.getLastRow() - 1;
  if (n > 0) {
    sh.getRange(2, COL.REF, n, 1).getValues().forEach(function (r) {
      const v = String(r[0]);
      if (v.indexOf(prefix) === 0) maxInSheet = Math.max(maxInSheet, parseInt(v.slice(prefix.length), 10) || 0);
    });
  }
  const seq = Math.max(stored, maxInSheet) + 1;
  return { ref: prefix + pad_(seq, 4), commit: function () { props.setProperty(key, String(seq)); } };
}

function buildFileName_(ref, bill, i, count, f) {
  const ext = extFor_(f.mimeType, f.name);
  const part = count > 1 ? '_' + pad_(i + 1, 2) : '';
  return ref + '_' + slug_(bill.categoryName, 30) + '_' + Utilities.formatDate(bill.billDate, tz_(), 'yyyy-MM-dd') +
    '_' + slug_(bill.vendor, 30) + part + '.' + ext;
}

function findDuplicates_(bill, hashes, excludeRef) {
  const sh = sheet_(SHEET.BILLS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const data = sh.getRange(2, 1, n, NCOLS).getValues();
  const norm = function (v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
  const out = [];
  data.forEach(function (r) {
    if (r[COL.STATUS - 1] === 'VOID' || !r[COL.REF - 1] || r[COL.REF - 1] === excludeRef) return;
    const reasons = [];
    const rowHashes = String(r[COL.FILE_HASHES - 1] || '').split(/\s+/).filter(String);
    if (hashes.some(function (h) { return rowHashes.indexOf(h) >= 0; })) reasons.push('the same receipt image was already uploaded');
    const sameVendor = norm(r[COL.VENDOR - 1]) === norm(bill.vendor);
    if (sameVendor && bill.invoiceNo && norm(r[COL.INVOICE_NO - 1]) === norm(bill.invoiceNo)) reasons.push('same payee and invoice number');
    const d = r[COL.BILL_DATE - 1];
    if (sameVendor && d instanceof Date && fmtDate_(d) === fmtDate_(bill.billDate) &&
        Math.abs(Number(r[COL.TOTAL - 1]) - bill.total) < 0.005) reasons.push('same payee, date and total');
    if (reasons.length) {
      out.push({ ref: r[COL.REF - 1], billDate: d instanceof Date ? fmtDate_(d) : String(d), vendor: r[COL.VENDOR - 1],
                 total: Number(r[COL.TOTAL - 1]) || 0, reason: reasons.join('; ') });
    }
  });
  return out.slice(0, 5);
}

// ============================= VOID A BILL ==================================

/** Accounting rule: never delete a recorded bill — void it with a reason (keeps the number sequence intact). */
function voidSelectedBill() {
  const ui = SpreadsheetApp.getUi();
  try { requireAdmin_(); } catch (e) { ui.alert(e.message); return; }
  const sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== SHEET.BILLS) { ui.alert('Select a row on the "' + SHEET.BILLS + '" sheet first.'); return; }
  const row = sh.getActiveRange().getRow();
  if (row < 2) { ui.alert('Select a bill row (not the header).'); return; }
  const values = sh.getRange(row, 1, 1, NCOLS).getValues()[0];
  const ref = values[COL.REF - 1];
  if (!ref) { ui.alert('That row has no bill.'); return; }
  if (values[COL.STATUS - 1] === 'VOID') { ui.alert(ref + ' is already void.'); return; }

  const resp = ui.prompt('Void ' + ref, 'Payee: ' + values[COL.VENDOR - 1] + '\nTotal: ' + values[COL.TOTAL - 1] +
    '\n\nReason for voiding (required):', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const reason = clean_(resp.getResponseText(), 300);
  if (!reason) { ui.alert('A reason is required to void a bill.'); return; }

  const note = 'VOID: ' + reason + ' — ' + userEmail_() + ', ' + Utilities.formatDate(new Date(), tz_(), 'dd/MM/yyyy HH:mm');
  sh.getRange(row, COL.STATUS).setValue('VOID');
  sh.getRange(row, COL.VOID_NOTE).setValue(note);
  const updated = sh.getRange(row, 1, 1, NCOLS).getValues()[0];
  audit_('VOID', ref, { row: row, reason: reason });
  journal_('VOID', ref, rowToObject_(updated));
  markReportsDirty_();
  try { refreshReports_(); } catch (e) { }
  toast_(ref + ' voided. Its receipt files are kept in Drive.');
}

// ============================== CATEGORIES ==================================

/** Returns categories. includeInactive=true also returns archived ones and usage counts (for the manager). */
function getCategories(includeInactive) {
  requireAdmin_();
  return categories_(includeInactive);
}

function categories_(includeInactive) {
  const sh = sheet_(SHEET.CATEGORIES);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  let usage = {};
  if (includeInactive) usage = categoryUsage_();
  return sh.getRange(2, 1, n, CATEGORY_HEADERS.length).getValues()
    .filter(function (r) { return r[0] && r[1]; })
    .map(function (r) {
      return { code: String(r[0]), name: String(r[1]), group: String(r[2] || ''), budget: r[3] === '' ? '' : Number(r[3]) || 0,
               active: r[4] !== false && String(r[4]).toUpperCase() !== 'FALSE', usage: usage[String(r[0])] || 0 };
    })
    .filter(function (c) { return includeInactive || c.active; })
    .sort(function (a, b) { return a.group.localeCompare(b.group) || a.name.localeCompare(b.name); });
}

function addCategory(input) {
  requireAdmin_();
  return withLock_(function () {
    const name = clean_(input && input.name, 80);
    if (!name) throw new Error('Category name is required.');
    const group = clean_(input.group, 60) || 'Other';
    const budget = input.budget === '' || input.budget == null ? '' : parseMoney_(input.budget);
    if (budget === null || (budget !== '' && budget < 0)) throw new Error('Budget must be a positive number or blank.');

    const all = categories_(true);
    const clash = all.filter(function (c) { return c.name.toLowerCase() === name.toLowerCase(); })[0];
    if (clash) {
      if (clash.active) throw new Error('A category named "' + clash.name + '" already exists.');
      setCategoryFields_(clash.code, { active: true });
      audit_('CATEGORY_RESTORE', clash.code, { name: clash.name });
      journal_('CATEGORY_RESTORE', clash.code, { name: clash.name });
      return { restored: true, code: clash.code, message: '"' + clash.name + '" was archived — it has been restored.' };
    }
    const maxNum = all.reduce(function (m, c) { return Math.max(m, parseInt(String(c.code).replace(/\D/g, ''), 10) || 0); }, 0);
    const code = 'CAT-' + pad_(maxNum + 1, 3);
    const now = new Date();
    appendRowAt_(sheet_(SHEET.CATEGORIES), 1, [code, name, group, budget, true, now, now, ''], [5]);
    markReportsDirty_();
    audit_('CATEGORY_ADD', code, { name: name, group: group, budget: budget });
    journal_('CATEGORY_ADD', code, { name: name, group: group, budget: budget });
    return { added: true, code: code, message: 'Category "' + name + '" added.' };
  });
}

/** Edit name / group / budget. A rename is applied to every existing bill so reports stay consistent. */
function updateCategory(code, input) {
  requireAdmin_();
  return withLock_(function () {
    const cat = categories_(true).filter(function (c) { return c.code === code; })[0];
    if (!cat) throw new Error('Category not found.');
    const name = clean_(input.name, 80);
    if (!name) throw new Error('Category name is required.');
    const clash = categories_(true).filter(function (c) { return c.code !== code && c.name.toLowerCase() === name.toLowerCase(); })[0];
    if (clash) throw new Error('Another category is already named "' + clash.name + '".');
    const budget = input.budget === '' || input.budget == null ? '' : parseMoney_(input.budget);
    if (budget === null || (budget !== '' && budget < 0)) throw new Error('Budget must be a positive number or blank.');
    const group = clean_(input.group, 60) || cat.group || 'Other';

    setCategoryFields_(code, { name: name, group: group, budget: budget });
    let updatedBills = 0;
    if (name !== cat.name) {
      const sh = sheet_(SHEET.BILLS);
      const n = sh.getLastRow() - 1;
      if (n > 0) {
        const codes = sh.getRange(2, COL.CAT_CODE, n, 1).getValues();
        const names = sh.getRange(2, COL.CATEGORY, n, 1).getValues();
        const touched = [];
        codes.forEach(function (r, i) { if (String(r[0]) === code) { names[i][0] = name; touched.push(i + 2); } });
        if (touched.length) {
          sh.getRange(2, COL.CATEGORY, n, 1).setValues(names);
          updatedBills = touched.length;
          const entries = touched.map(function (rowNo) {
            const v = sh.getRange(rowNo, 1, 1, NCOLS).getValues()[0];
            return ['CATEGORY_RENAME', v[COL.REF - 1], rowToObject_(v)];
          });
          journalMany_(entries);
        }
      }
    }
    const details = { from: { name: cat.name, group: cat.group, budget: cat.budget }, to: { name: name, group: group, budget: budget }, billsUpdated: updatedBills };
    audit_('CATEGORY_UPDATE', code, details);
    journal_('CATEGORY_UPDATE', code, details);
    return { message: 'Saved.' + (updatedBills ? ' ' + updatedBills + ' existing bill(s) moved to the new name.' : '') };
  });
}

/** Unused categories are deleted; categories with bills are archived (hidden from the form, history kept). */
function deleteCategory(code) {
  requireAdmin_();
  return withLock_(function () {
    const cat = categories_(true).filter(function (c) { return c.code === code; })[0];
    if (!cat) throw new Error('Category not found.');
    if (cat.usage > 0) {
      setCategoryFields_(code, { active: false });
      audit_('CATEGORY_ARCHIVE', code, { name: cat.name, bills: cat.usage });
      journal_('CATEGORY_ARCHIVE', code, { name: cat.name, bills: cat.usage });
      return { archived: true, message: '"' + cat.name + '" is used by ' + cat.usage + ' bill(s), so it was archived instead of deleted. You can restore it any time.' };
    }
    const sh = sheet_(SHEET.CATEGORIES);
    const row = findRowByValue_(sh, 1, code);
    sh.deleteRow(row);
    audit_('CATEGORY_DELETE', code, { name: cat.name, group: cat.group });
    journal_('CATEGORY_DELETE', code, cat);
    return { deleted: true, message: '"' + cat.name + '" deleted.' };
  });
}

function restoreCategory(code) {
  requireAdmin_();
  return withLock_(function () {
    setCategoryFields_(code, { active: true });
    audit_('CATEGORY_RESTORE', code, {});
    journal_('CATEGORY_RESTORE', code, {});
    return { message: 'Category restored.' };
  });
}

function setCategoryFields_(code, f) {
  const sh = sheet_(SHEET.CATEGORIES);
  const row = findRowByValue_(sh, 1, code);
  if (!row) throw new Error('Category not found.');
  if (f.name !== undefined) sh.getRange(row, 2).setValue(f.name);
  if (f.group !== undefined) sh.getRange(row, 3).setValue(f.group);
  if (f.budget !== undefined) sh.getRange(row, 4).setValue(f.budget);
  if (f.active !== undefined) sh.getRange(row, 5).setValue(f.active);
  sh.getRange(row, 7).setValue(new Date());
}

function categoryUsage_() {
  const sh = sheet_(SHEET.BILLS);
  const n = sh.getLastRow() - 1;
  const out = {};
  if (n < 1) return out;
  sh.getRange(2, COL.CAT_CODE, n, 1).getValues().forEach(function (r) {
    const c = String(r[0] || ''); if (c) out[c] = (out[c] || 0) + 1;
  });
  return out;
}

// ========================= AUDIT OF MANUAL EDITS ============================

/**
 * Installable onEdit trigger: logs every manual change to the ledger, keeps derived fields exact
 * (Total = Amount + Tax, Period = month of Bill Date, Category Code follows the Category name)
 * and mirrors the corrected row to the backup journal.
 */
function onBillsEdit(e) {
  try {
    if (!e || !e.range) return;
    const editor = (e.user && e.user.getEmail && e.user.getEmail()) || 'unknown (sheet edit)';
    const sh = e.range.getSheet();
    const name = sh.getName();
    // Report period dropdowns: redraw the page straight away.
    if (name === SHEET.SUMMARY) {
      const a1 = e.range.getA1Notation();
      if (a1 === 'C3' || a1 === 'D3') renderMonthlySummary_();
      return;
    }
    if (name === SHEET.ANNUAL) {
      if (e.range.getA1Notation() === 'C3') renderAnnualSummary_();
      return;
    }
    if (name === SHEET.CATEGORIES || name === SHEET.SETTINGS || name === SHEET.METHODS) {
      markReportsDirty_();
      audit_('MANUAL_EDIT', name + '!' + e.range.getA1Notation(), { oldValue: e.oldValue, newValue: e.value }, editor);
      SETTINGS_CACHE_ = null;
      return;
    }
    if (name !== SHEET.BILLS) return;
    const first = Math.max(2, e.range.getRow());
    const last = e.range.getLastRow();
    if (last < 2) return;
    const c1 = e.range.getColumn(), c2 = e.range.getLastColumn();
    const touched = function (key) { return COL[key] >= c1 && COL[key] <= c2; };
    const range = sh.getRange(first, 1, last - first + 1, NCOLS);
    const rows = range.getValues();
    const fixes = [];

    if (touched('REF')) fixes.push('WARNING: reference number edited by hand');
    const catByName = {};
    if (touched('CATEGORY')) categories_(true).forEach(function (c) { catByName[c.name.toLowerCase()] = c; });

    rows.forEach(function (r, i) {
      if (!r[COL.REF - 1]) return;
      const rowNo = first + i;
      if (touched('AMOUNT') || touched('TAX') || touched('TOTAL')) {
        const a = Math.round((Number(r[COL.AMOUNT - 1]) || 0) * 100), t = Math.round((Number(r[COL.TAX - 1]) || 0) * 100);
        const total = (a + t) / 100;
        if (Math.round(Number(r[COL.TOTAL - 1]) * 100) !== a + t) {
          sh.getRange(rowNo, COL.TOTAL).setValue(total);
          r[COL.TOTAL - 1] = total;
          fixes.push('row ' + rowNo + ': Total recalculated to ' + total.toFixed(2));
        }
      }
      if (touched('BILL_DATE') && r[COL.BILL_DATE - 1] instanceof Date) {
        const d = r[COL.BILL_DATE - 1];
        const p = new Date(d.getFullYear(), d.getMonth(), 1);
        sh.getRange(rowNo, COL.PERIOD).setValue(p);
        r[COL.PERIOD - 1] = p;
      }
      if (touched('CATEGORY')) {
        const c = catByName[String(r[COL.CATEGORY - 1]).toLowerCase()];
        if (c) {
          if (c.code !== r[COL.CAT_CODE - 1]) {
            sh.getRange(rowNo, COL.CAT_CODE).setValue(c.code);
            r[COL.CAT_CODE - 1] = c.code;
          }
        } else {
          fixes.push('row ' + rowNo + ': unknown category "' + r[COL.CATEGORY - 1] + '"');
        }
      }
    });

    // Stamp who corrected the row and when, and keep the row tidy.
    const now = new Date();
    rows.forEach(function (r, i) {
      if (!r[COL.REF - 1]) return;
      sh.getRange(first + i, COL.LAST_EDIT_BY, 1, 2).setValues([[editor, now]]);
      r[COL.LAST_EDIT_BY - 1] = editor; r[COL.LAST_EDIT_AT - 1] = now;
    });
    styleBillRows_(sh, first, rows.length);
    markReportsDirty_();

    audit_('MANUAL_EDIT', String(rows[0][COL.REF - 1] || ''), {
      range: e.range.getA1Notation(), oldValue: e.oldValue, newValue: e.value, rows: rows.length, autoFixes: fixes,
    }, editor);
    journalMany_(rows.filter(function (r) { return r[COL.REF - 1]; })
      .map(function (r) { return ['EDIT', r[COL.REF - 1], rowToObject_(r)]; }));
    if (fixes.length) toast_(fixes.slice(0, 3).join(' · '));
  } catch (err) {
    console.error('onBillsEdit: ' + err);
  }
}

/** Installable onChange trigger: flags structural changes such as deleted rows. */
function onBillsChange(e) {
  try {
    if (!e) return;
    if (['REMOVE_ROW', 'REMOVE_COLUMN', 'REMOVE_GRID'].indexOf(e.changeType) >= 0) {
      audit_('WARNING_' + e.changeType, ss_().getActiveSheet().getName(),
        { note: 'Rows/columns/sheets were removed manually. Recover with Backup & restore → Rebuild Bills from live journal.' });
    }
  } catch (err) {
    console.error('onBillsChange: ' + err);
  }
}

// ================================ HELPERS ===================================

let SETTINGS_CACHE_ = null;

function ss_() {
  try {
    const active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) return active;
  } catch (e) { }
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Run setup() from the spreadsheet first.');
  return SpreadsheetApp.openById(id);
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" is missing. Run 🧾 Bill Manager → Setup / repair.');
  return sh;
}

function getOrCreateSheet_(name) {
  const ss = ss_();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function settings_() {
  if (SETTINGS_CACHE_) return SETTINGS_CACHE_;
  const s = {};
  DEFAULT_SETTINGS.forEach(function (d) { s[d[0]] = d[1]; });
  const sh = ss_().getSheetByName(SHEET.SETTINGS);
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
      if (r[0]) s[String(r[0]).trim()] = r[1];
    });
  }
  SETTINGS_CACHE_ = s;
  return s;
}

function setSetting_(key, value) {
  const sh = getOrCreateSheet_(SHEET.SETTINGS);
  const row = findRowByValue_(sh, 1, key);
  if (row) sh.getRange(row, 2).setValue(value);
  else appendRowAt_(sh, 1, [key, value, '']);
  SETTINGS_CACHE_ = null;
}

function findRowByValue_(sh, col, value) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return 0;
  const vals = sh.getRange(2, col, n, 1).getValues();
  for (let i = 0; i < vals.length; i++) if (String(vals[i][0]) === String(value)) return i + 2;
  return 0;
}

function rootFolder_() {
  const s = settings_();
  if (s.ROOT_FOLDER_ID) { try { return DriveApp.getFolderById(s.ROOT_FOLDER_ID); } catch (e) { } }
  const f = DriveApp.createFolder((s.COMPANY_NAME ? s.COMPANY_NAME + ' ' : '') + 'Bill Manager');
  setSetting_('ROOT_FOLDER_ID', f.getId());
  return f;
}

function childFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function monthFolder_(date) {
  const receipts = childFolder_(rootFolder_(), 'Receipts');
  const year = childFolder_(receipts, Utilities.formatDate(date, tz_(), 'yyyy'));
  return childFolder_(year, Utilities.formatDate(date, tz_(), 'MM - MMMM'));
}

function audit_(action, ref, details, who) {
  try {
    const sh = ss_().getSheetByName(SHEET.AUDIT);
    if (!sh) return;
    sh.appendRow([new Date(), who || userEmail_(), action, ref || '', JSON.stringify(details || {})]);
  } catch (err) {
    console.error('audit_: ' + err);
  }
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('The system is busy. Please try again.');
  try { return fn(); } finally { lock.releaseLock(); }
}

function rowToObject_(row) {
  const o = {};
  BILL_COLUMNS.forEach(function (c, i) {
    const v = row[i];
    o[c[0]] = v instanceof Date ? v.toISOString() : v;
  });
  return o;
}

function styleHeader_(sh, n) { styleHeaderRange_(sh.getRange(1, 1, 1, n)); }
function styleHeaderRange_(r) {
  r.setFontWeight('bold').setBackground('#000000').setFontColor('#ffffff').setFontFamily('Arial').setFontSize(10)
    .setWrap(true).setVerticalAlignment('middle')
    .setBorder(true, true, true, true, true, true, '#000000', SpreadsheetApp.BorderStyle.SOLID);
}

function protectWarn_(sh, desc) {
  const existing = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET);
  if (existing.length) return;
  sh.protect().setDescription(desc).setWarningOnly(true);
}

function currencyFormat_() {
  const sym = String(settings_().CURRENCY_SYMBOL || 'Rs.').replace(/"/g, '');
  return '"' + sym + ' "#,##0.00;("' + sym + ' "#,##0.00)';
}

function colLetter_(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function tz_() { return Session.getScriptTimeZone() || 'Asia/Colombo'; }
function fmtDate_(d) { return Utilities.formatDate(d, tz_(), 'dd/MM/yyyy'); }
function pad_(n, w) { return String(n).padStart(w, '0'); }
function round2_(n) { return Math.round(n * 100) / 100; }
function toBool_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
/** Best-known identity for logging (the verified signed-in user when available). */
function userEmail_() {
  if (CURRENT_USER_) return CURRENT_USER_.email;
  try { return Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || 'unknown'; } catch (e) { return 'unknown'; }
}

function parseIsoDate_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d : null;
}

function parseMoney_(v) {
  if (typeof v === 'number') return isFinite(v) && v >= 0 && Math.abs(Math.round(v * 100) - v * 100) < 1e-6 ? v : null;
  const s = String(v == null ? '' : v).replace(/rs\.?|lkr|,|\s/gi, '');
  // Max 2 decimal places, max 12 digits: amounts are exact to the cent.
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(s)) return null;
  return Number(s);
}

/** Trim, cap length, and neutralise text that the sheet would treat as a formula. */
function clean_(v, max) {
  let s = String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, max || 500);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function slug_(s, max) {
  return String(s || '').replace(/^'/, '').normalize('NFKD').replace(/[^\w\s-]/g, '').trim()
    .replace(/[\s_-]+/g, '-').slice(0, max || 40).replace(/-+$/, '') || 'NA';
}

function extFor_(mime, name) {
  const map = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
                'image/gif': 'gif', 'application/pdf': 'pdf' };
  if (map[mime]) return map[mime];
  const m = /\.([a-z0-9]{2,5})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : 'bin';
}

function sha256Hex_(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function escapeHtml_(s) {
  return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}

function toast_(msg) {
  try { ss_().toast(msg, 'Bill Manager', 6); } catch (e) { }
}
