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
  ['VENDOR',      'Company / Person (Payee)',     190],
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

  ensureSettingsSheet_();
  ensureBillsSheet_();
  ensureCategoriesSheet_();
  ensureMethodsSheet_();
  ensureAuditSheet_();
  ensureUsersSheet_();
  buildSummarySheet();
  buildAnnualSheet();

  rootFolder_();
  backupFolder_();
  backupBook_();
  installTriggers_();
  removeEmptyDefaultSheet_();

  ss.setActiveSheet(ss.getSheetByName(SHEET.BILLS));
  audit_('SETUP', '', { version: '1.0' });
  toast_('Setup complete. Use the 🧾 Bill Manager menu to record bills.');
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
  sh.getRange(1, 1, 1, NCOLS).setValues([BILL_COLUMNS.map(function (c) { return c[1]; })]);
  styleHeader_(sh, NCOLS);
  sh.setFrozenRows(1);
  sh.setFrozenColumns(1);
  BILL_COLUMNS.forEach(function (c, i) { sh.setColumnWidth(i + 1, c[2]); });

  const cur = currencyFormat_();
  const rows = sh.getMaxRows() - 1;
  sh.getRange(2, COL.BILL_DATE, rows, 1).setNumberFormat('dd/MM/yyyy');
  sh.getRange(2, COL.DUE_DATE, rows, 1).setNumberFormat('dd/MM/yyyy');
  sh.getRange(2, COL.PERIOD, rows, 1).setNumberFormat('yyyy-mm');
  sh.getRange(2, COL.RECORDED_AT, rows, 1).setNumberFormat('dd/MM/yyyy HH:mm');
  sh.getRange(2, COL.AMOUNT, rows, 3).setNumberFormat(cur);
  sh.getRange(2, COL.DESCRIPTION, rows, 1).setWrap(true);
  sh.getRange(2, COL.FILE_NAMES, rows, 3).setWrap(false);

  // Dropdowns help when someone edits the sheet by hand.
  const v = function (list) { return SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(false).build(); };
  sh.getRange(2, COL.PAY_STATUS, rows, 1).setDataValidation(v(PAY_STATUSES));
  sh.getRange(2, COL.STATUS, rows, 1).setDataValidation(v(['ACTIVE', 'VOID']));

  // Visual cues: voided rows struck through; unpaid rows amber.
  const L = colLetter_;
  const all = sh.getRange(2, 1, rows, NCOLS);
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$' + L(COL.STATUS) + '2="VOID"')
      .setStrikethrough(true).setFontColor('#9aa0a6').setBackground('#f1f3f4')
      .setRanges([all]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($' + L(COL.STATUS) + '2="ACTIVE",$' + L(COL.PAY_STATUS) + '2<>"Paid",$' + L(COL.PAY_STATUS) + '2<>"")')
      .setBackground('#fef7e0')
      .setRanges([all]).build(),
  ]);

  // Technical columns are kept but hidden.
  sh.hideColumns(COL.FILE_IDS, 2);
  sh.hideColumns(COL.SUBMISSION_ID);
  if (!sh.getFilter()) sh.getRange(1, 1, sh.getMaxRows(), NCOLS).createFilter();
  protectWarn_(sh, 'Bills ledger — please record bills with the entry form; void instead of deleting');
}

function ensureCategoriesSheet_() {
  const sh = getOrCreateSheet_(SHEET.CATEGORIES);
  sh.getRange(1, 1, 1, CATEGORY_HEADERS.length).setValues([CATEGORY_HEADERS]);
  styleHeader_(sh, CATEGORY_HEADERS.length);
  sh.setFrozenRows(1);
  [90, 260, 220, 160, 70, 140, 140, 260].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  if (sh.getLastRow() < 2) {
    const now = new Date();
    const rows = DEFAULT_CATEGORIES.map(function (c, i) {
      return ['CAT-' + pad_(i + 1, 3), c[0], c[1], '', true, now, now, ''];
    });
    sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }
  sh.getRange('D2:D').setNumberFormat(currencyFormat_());
  sh.getRange('F2:G').setNumberFormat('dd/MM/yyyy HH:mm');
  sh.getRange('E2:E').insertCheckboxes();
  protectWarn_(sh, 'Categories — please use "Manage categories" so history stays consistent');
}

function ensureMethodsSheet_() {
  const sh = getOrCreateSheet_(SHEET.METHODS);
  if (sh.getLastRow() < 2) {
    sh.getRange(1, 1, 1, 2).setValues([['Payment Method', 'Active']]);
    sh.getRange(2, 1, DEFAULT_METHODS.length, 2).setValues(DEFAULT_METHODS.map(function (m) { return [m, true]; }));
  }
  styleHeader_(sh, 2);
  sh.setColumnWidth(1, 220);
  sh.getRange('B2:B').insertCheckboxes();
}

function ensureAuditSheet_() {
  const sh = getOrCreateSheet_(SHEET.AUDIT);
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, 5).setValues([['Timestamp', 'User', 'Action', 'Reference', 'Details']]);
  styleHeader_(sh, 5);
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 150).setColumnWidth(2, 200).setColumnWidth(3, 150).setColumnWidth(4, 160).setColumnWidth(5, 700);
  sh.getRange('A2:A').setNumberFormat('dd/MM/yyyy HH:mm:ss');
  protectWarn_(sh, 'Audit log — do not edit');
}

/** Monthly report: KPIs + budget vs actual for the month typed in B3. */
function buildSummarySheet() {
  const sh = getOrCreateSheet_(SHEET.SUMMARY);
  const keepMonth = sh.getRange('B3').getValue();
  sh.clear();
  sh.setConditionalFormatRules([]);

  const B = "'" + SHEET.BILLS + "'!";
  const C = "'" + SHEET.CATEGORIES + "'!";
  const rng = function (key) { const l = colLetter_(COL[key]); return B + l + '2:' + l; };
  const TOTAL = rng('TOTAL'), TAX = rng('TAX'), PERIOD = rng('PERIOD'), CAT = rng('CATEGORY'), STATUS = rng('STATUS'), PAYST = rng('PAY_STATUS');
  const cur = currencyFormat_();

  sh.getRange('A1').setValue(settings_().COMPANY_NAME + ' — Monthly Expense Summary').setFontSize(16).setFontWeight('bold');
  sh.getRange('A3').setValue('Month (type e.g. 2026-11)').setFontWeight('bold');
  const month = keepMonth instanceof Date ? keepMonth : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  sh.getRange('B3').setValue(month).setNumberFormat('mmmm yyyy').setBackground('#e8f0fe').setFontWeight('bold');
  sh.getRange('C3').setValue('← change this month; only ACTIVE (non-void) bills are counted').setFontColor('#5f6368');

  const kpis = [
    ['Total expenses (month)', '=SUMIFS(' + TOTAL + ',' + PERIOD + ',$B$3,' + STATUS + ',"ACTIVE")', cur],
    ['Tax / VAT included',     '=SUMIFS(' + TAX + ',' + PERIOD + ',$B$3,' + STATUS + ',"ACTIVE")', cur],
    ['Number of bills',        '=COUNTIFS(' + PERIOD + ',$B$3,' + STATUS + ',"ACTIVE")', '0'],
    ['Unpaid / part-paid (month)', '=SUMIFS(' + TOTAL + ',' + PERIOD + ',$B$3,' + STATUS + ',"ACTIVE",' + PAYST + ',"<>Paid")', cur],
    ['Year-to-date expenses',  '=SUMIFS(' + TOTAL + ',' + PERIOD + ',">="&DATE(YEAR($B$3),1,1),' + PERIOD + ',"<="&$B$3,' + STATUS + ',"ACTIVE")', cur],
    ['Total monthly budget',   '=SUMIFS(' + C + 'D2:D,' + C + 'E2:E,TRUE)', cur],
  ];
  kpis.forEach(function (k, i) {
    sh.getRange(5 + i, 1).setValue(k[0]);
    sh.getRange(5 + i, 2).setFormula(k[1]).setNumberFormat(k[2]).setFontWeight('bold');
  });

  const hr = 13;
  sh.getRange(hr, 1, 1, 7).setValues([['Expense Category', 'Group', 'Monthly Budget', 'Actual (Month)', 'Variance (Budget − Actual)', '% of Budget Used', 'No. of Bills']]);
  styleHeaderRange_(sh.getRange(hr, 1, 1, 7));
  const r = hr + 1, A = 'A' + r + ':A';
  sh.getRange(r, 1).setFormula('=IFERROR(SORT(FILTER(' + C + 'B2:B,' + C + 'B2:B<>"",(' + C + 'E2:E=TRUE)+(COUNTIF(' + CAT + ',' + C + 'B2:B)>0))),"")');
  sh.getRange(r, 2).setFormula('=ARRAYFORMULA(IF(' + A + '="",,IFERROR(VLOOKUP(' + A + ',' + C + 'B2:D,2,FALSE),"")))');
  sh.getRange(r, 3).setFormula('=ARRAYFORMULA(IF(' + A + '="",,IFERROR(VLOOKUP(' + A + ',' + C + 'B2:D,3,FALSE),"")))');
  sh.getRange(r, 4).setFormula('=ARRAYFORMULA(IF(' + A + '="",,SUMIFS(' + TOTAL + ',' + CAT + ',' + A + ',' + PERIOD + ',$B$3,' + STATUS + ',"ACTIVE")))');
  sh.getRange(r, 5).setFormula('=ARRAYFORMULA(IF((' + A + '="")+(C' + r + ':C=""),,C' + r + ':C-D' + r + ':D))');
  sh.getRange(r, 6).setFormula('=ARRAYFORMULA(IF(' + A + '="",,IFERROR(D' + r + ':D/C' + r + ':C,"")))');
  sh.getRange(r, 7).setFormula('=ARRAYFORMULA(IF(' + A + '="",,COUNTIFS(' + CAT + ',' + A + ',' + PERIOD + ',$B$3,' + STATUS + ',"ACTIVE")))');
  sh.getRange(r, 3, 200, 3).setNumberFormat(cur);
  sh.getRange(r, 6, 200, 1).setNumberFormat('0%');

  const overBudget = SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND(ISNUMBER($E' + r + '),$E' + r + '<0)')
    .setFontColor('#c5221f').setBackground('#fce8e6').setRanges([sh.getRange(r, 1, 200, 7)]).build();
  sh.setConditionalFormatRules([overBudget]);

  sh.setColumnWidth(1, 280).setColumnWidth(2, 220);
  for (let c = 3; c <= 7; c++) sh.setColumnWidth(c, 150);
  sh.setFrozenRows(hr);
  protectWarn_(sh, 'Report — formulas');
}

/** Annual report: category × month matrix for the year typed in B3 (replaces the old "Total" tab). */
function buildAnnualSheet() {
  const sh = getOrCreateSheet_(SHEET.ANNUAL);
  const keepYear = Number(sh.getRange('B3').getValue()) || new Date().getFullYear();
  sh.clear();

  const B = "'" + SHEET.BILLS + "'!";
  const C = "'" + SHEET.CATEGORIES + "'!";
  const rng = function (key) { const l = colLetter_(COL[key]); return B + l + '2:' + l; };
  const TOTAL = rng('TOTAL'), PERIOD = rng('PERIOD'), CAT = rng('CATEGORY'), STATUS = rng('STATUS');
  const cur = currencyFormat_();

  sh.getRange('A1').setValue(settings_().COMPANY_NAME + ' — Total Annual Expenses').setFontSize(16).setFontWeight('bold');
  sh.getRange('A3').setValue('Year').setFontWeight('bold');
  sh.getRange('B3').setValue(keepYear).setNumberFormat('0').setBackground('#e8f0fe').setFontWeight('bold');
  sh.getRange('A4').setValue('Total annual expenses').setFontWeight('bold');
  sh.getRange('B4').setFormula('=SUMIFS(' + TOTAL + ',' + PERIOD + ',">="&DATE($B$3,1,1),' + PERIOD + ',"<"&DATE($B$3+1,1,1),' + STATUS + ',"ACTIVE")')
    .setNumberFormat(cur).setFontWeight('bold');

  const hr = 6, r = 7;
  sh.getRange(hr, 1).setValue('Expense Category');
  sh.getRange(hr, 2).setValue('Year Total');
  for (let m = 0; m < 12; m++) {
    sh.getRange(hr, 3 + m).setFormula('=DATE($B$3,' + (m + 1) + ',1)').setNumberFormat('mmm');
  }
  styleHeaderRange_(sh.getRange(hr, 1, 1, 14));

  const A = 'A' + r + ':A';
  sh.getRange(r, 1).setFormula('=IFERROR(SORT(FILTER(' + C + 'B2:B,' + C + 'B2:B<>"",(' + C + 'E2:E=TRUE)+(COUNTIF(' + CAT + ',' + C + 'B2:B)>0))),"")');
  sh.getRange(r, 2).setFormula('=ARRAYFORMULA(IF(' + A + '="",,SUMIFS(' + TOTAL + ',' + CAT + ',' + A + ',' + PERIOD + ',">="&DATE($B$3,1,1),' + PERIOD + ',"<"&DATE($B$3+1,1,1),' + STATUS + ',"ACTIVE")))');
  for (let m = 0; m < 12; m++) {
    const head = colLetter_(3 + m) + '$' + hr;
    sh.getRange(r, 3 + m).setFormula('=ARRAYFORMULA(IF(' + A + '="",,SUMIFS(' + TOTAL + ',' + CAT + ',' + A + ',' + PERIOD + ',' + head + ',' + STATUS + ',"ACTIVE")))');
  }
  // Monthly totals row above the header.
  sh.getRange(5, 1).setValue('Month total').setFontWeight('bold');
  for (let m = 0; m < 12; m++) {
    const l = colLetter_(3 + m);
    sh.getRange(5, 3 + m).setFormula('=SUM(' + l + r + ':' + l + ')').setFontWeight('bold');
  }
  sh.getRange(5, 2).setFormula('=SUM(B' + r + ':B)').setFontWeight('bold');
  sh.getRange(5, 2, 300, 13).setNumberFormat(cur);
  sh.getRange(hr, 3, 1, 12).setNumberFormat('mmm');

  sh.setColumnWidth(1, 280).setColumnWidth(2, 140);
  for (let c = 3; c <= 14; c++) sh.setColumnWidth(c, 115);
  sh.setFrozenRows(hr);
  sh.setFrozenColumns(2);
  protectWarn_(sh, 'Report — formulas');
}

function installTriggers_() {
  const ss = ss_();
  const handlers = ['runNightlyBackup', 'onBillsEdit', 'onBillsChange'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (handlers.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runNightlyBackup').timeBased().everyDays(1).atHour(2).create();
  ScriptApp.newTrigger('onBillsEdit').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('onBillsChange').forSpreadsheet(ss).onChange().create();
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
    .addItem('↻ Rebuild reports', 'rebuildReports')
    .addItem('✅ Run integrity check', 'runIntegrityCheck')
    .addSeparator()
    .addSubMenu(ui.createMenu('🛟 Backup & restore')
      .addItem('Back up now', 'backupNow')
      .addItem('Restore Bills from latest snapshot (as new tab)', 'restoreFromLatestSnapshot')
      .addItem('Rebuild Bills from live journal (as new tab)', 'rebuildFromJournal')
      .addItem('Open backup folder', 'openBackupFolder'))
    .addSubMenu(ui.createMenu('👥 Users & access')
      .addItem('Add user…', 'addUserPrompt')
      .addItem('Remove a user\'s access…', 'deactivateUserPrompt')
      .addItem('Open Users tab', 'openUsersSheet'))
    .addItem('🔗 Show web app link / receipts folder', 'showLinks')
    .addSeparator()
    .addItem('⚙️ Setup / repair', 'setup')
    .addToUi();
}

/** Web app entry point (Deploy → New deployment → Web app). */
function doGet() {
  let email = '';
  try { email = Session.getActiveUser().getEmail(); } catch (e) { }
  if (!email) {
    return HtmlService.createHtmlOutput('<div style="font:16px system-ui;padding:40px;max-width:520px">' +
      '<h1 style="font-size:40px;letter-spacing:-1px">Sign in required.</h1>' +
      '<p>MAARAA Bills records who enters every bill, so you must open this page signed in to your Google account.</p>' +
      '<p><a href="https://accounts.google.com/ServiceLogin" target="_top">Sign in with Google</a></p></div>')
      .setTitle('Sign in required');
  }
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle((settings_().COMPANY_NAME || '') + ' Bill Manager')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function openEntryDialog() {
  const html = HtmlService.createTemplateFromFile('Index').evaluate().setWidth(820).setHeight(860);
  SpreadsheetApp.getUi().showModalDialog(html, 'Record a bill');
}

function openCategorySidebar() {
  const html = HtmlService.createTemplateFromFile('Sidebar').evaluate().setTitle('Manage categories');
  SpreadsheetApp.getUi().showSidebar(html);
}

function rebuildReports() {
  buildSummarySheet();
  buildAnnualSheet();
  toast_('Reports rebuilt.');
}

function showLinks() {
  const url = ScriptApp.getService().getUrl();
  const root = rootFolder_();
  const html = HtmlService.createHtmlOutput(
    '<div style="font:14px Arial;line-height:1.6">' +
    '<p><b>Web app:</b> ' + (url ? '<a target="_blank" href="' + url + '">' + url + '</a>' : 'not deployed yet — Deploy → New deployment → Web app') + '</p>' +
    '<p><b>Receipts &amp; backups folder:</b> <a target="_blank" href="' + root.getUrl() + '">' + escapeHtml_(root.getName()) + '</a></p>' +
    '<p>Tip: on your phone, open the web app link and choose “Add to Home screen”.</p></div>'
  ).setWidth(560).setHeight(220);
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
  if (!lock.tryLock(60000)) throw new Error('The system is busy recording another bill. Please press "Record bill" again — it will not be duplicated.');
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
    rowIndex = sh.getLastRow() + 1;
    sh.getRange(rowIndex, 1, 1, NCOLS).setValues([row]);
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

function validateBill_(p, s) {
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
  else if (!cat.active) errs.push('Category "' + cat.name + '" is archived. Restore it or choose another.');

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
  if (toBool_(s.REQUIRE_ATTACHMENT) && nFiles === 0) errs.push('Please attach the bill photo, screenshot or PDF.');
  if (nFiles > max) errs.push('A maximum of ' + max + ' files can be attached to one bill.');

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

function findDuplicates_(bill, hashes) {
  const sh = sheet_(SHEET.BILLS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const data = sh.getRange(2, 1, n, NCOLS).getValues();
  const norm = function (v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
  const out = [];
  data.forEach(function (r) {
    if (r[COL.STATUS - 1] === 'VOID' || !r[COL.REF - 1]) return;
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
  toast_(ref + ' voided. Its receipt files are kept in Drive.');
}

// ============================== CATEGORIES ==================================

/** Returns categories. includeInactive=true also returns archived ones and usage counts (for the manager). */
function getCategories(includeInactive) {
  currentUser_();
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
    sheet_(SHEET.CATEGORIES).appendRow([code, name, group, budget, true, now, now, '']);
    sheet_(SHEET.CATEGORIES).getRange(sheet_(SHEET.CATEGORIES).getLastRow(), 5).insertCheckboxes().setValue(true);
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
    if (name === SHEET.CATEGORIES || name === SHEET.SETTINGS || name === SHEET.METHODS) {
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
  else sh.appendRow([key, value, '']);
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
  r.setFontWeight('bold').setBackground('#1f3864').setFontColor('#ffffff').setWrap(true).setVerticalAlignment('middle');
}

function protectWarn_(sh, desc) {
  const existing = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET);
  if (existing.length) return;
  sh.protect().setDescription(desc).setWarningOnly(true);
}

function currencyFormat_() {
  const sym = String(settings_().CURRENCY_SYMBOL || 'Rs.').replace(/"/g, '');
  return '"' + sym + ' "#,##0.00;[Red]-"' + sym + ' "#,##0.00';
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
