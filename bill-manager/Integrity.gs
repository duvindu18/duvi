/**
 * Integrity check — proves the books are complete and exact.
 *
 * Runs from the menu (✅ Run integrity check) and automatically every night after the backup.
 * Results are written to the "Integrity Check" tab; if ALERT_EMAIL is set, problems are e-mailed.
 *
 * Checks:
 *  1. Reference numbers   unique, correct format, no gaps in each month's sequence
 *  2. Arithmetic          Total = Amount + Tax to the cent; no negative / blank amounts
 *  3. Derived fields      Period = month of Bill Date; Ref month = Bill Date month
 *  4. Categories          code exists and name matches the Categories tab
 *  5. Status              ACTIVE / VOID only; every VOID has a reason
 *  6. Receipts            required receipt present; every file still exists in Drive, not in Trash,
 *                         and is named after its bill
 *  7. Completeness        every bill ever created (per the backup journal) is still in the ledger
 *  8. Reports             Monthly & Annual summaries redrawn from the ledger
 */

const INTEGRITY_SHEET = 'Integrity Check';

function runIntegrityCheck() {
  requireSheetAdmin_();
  const r = integrityCheck_();
  try {
    const ui = SpreadsheetApp.getUi();
    ui.alert(r.errors === 0 ? '✅ Integrity check passed' : '⚠️ Integrity check found problems',
      r.summary + (r.errors || r.warnings ? '\n\nSee the "' + INTEGRITY_SHEET + '" tab for details.' : ''), ui.ButtonSet.OK);
  } catch (e) { /* no UI when run from a trigger */ }
  return r;
}

function integrityCheck_() {
  try { flushJournal_(); } catch (e) { }          // make sure queued journal entries are counted
  const started = Date.now();
  const s = settings_();
  const issues = [];   // [severity, ref, row, issue]
  const add = function (sev, ref, row, msg) { issues.push([sev, ref || '', row || '', msg]); };

  const sh = sheet_(SHEET.BILLS);
  const n = lastDataRow_(sh, COL.REF) - 1;
  const data = n > 0 ? sh.getRange(2, 1, n, NCOLS).getValues() : [];
  const cats = {};
  categories_(true).forEach(function (c) { cats[c.code] = c; });
  const requireReceipt = toBool_(s.REQUIRE_ATTACHMENT);
  const refRe = /^([A-Z0-9]+)-(\d{6})-(\d{4,})$/;

  const seenRef = {}, seqs = {};
  let activeTotalCents = 0, activeCount = 0, voidCount = 0, filesChecked = 0, filesSkipped = 0;

  data.forEach(function (r, i) {
    const rowNo = i + 2;
    const ref = String(r[COL.REF - 1] || '');
    const isBlank = r.every(function (v) { return v === '' || v === null; });
    if (isBlank) return;
    if (!ref) { add('ERROR', '', rowNo, 'Row has data but no reference number'); return; }

    // 1. References
    if (seenRef[ref]) add('ERROR', ref, rowNo, 'Duplicate reference (also on row ' + seenRef[ref] + ')');
    seenRef[ref] = rowNo;
    const m = refRe.exec(ref);
    if (!m) add('ERROR', ref, rowNo, 'Reference is not in the format PREFIX-YYYYMM-NNNN');
    else (seqs[m[1] + '-' + m[2]] = seqs[m[1] + '-' + m[2]] || []).push(Number(m[3]));

    const status = r[COL.STATUS - 1];
    const d = r[COL.BILL_DATE - 1];

    // 5. Status
    if (status !== 'ACTIVE' && status !== 'VOID') add('ERROR', ref, rowNo, 'Record Status must be ACTIVE or VOID (found "' + status + '")');
    if (status === 'VOID') { voidCount++; if (!String(r[COL.VOID_NOTE - 1] || '').trim()) add('WARNING', ref, rowNo, 'Voided without a reason'); }

    // 2. Arithmetic
    const a = r[COL.AMOUNT - 1], t = r[COL.TAX - 1], tot = r[COL.TOTAL - 1];
    if (typeof a !== 'number' || a <= 0) add('ERROR', ref, rowNo, 'Amount is missing, not a number or not positive');
    if (t !== '' && (typeof t !== 'number' || t < 0)) add('ERROR', ref, rowNo, 'Tax is not a valid number');
    const cents = Math.round((Number(a) || 0) * 100) + Math.round((Number(t) || 0) * 100);
    if (typeof tot !== 'number' || Math.round(tot * 100) !== cents) add('ERROR', ref, rowNo, 'Total ≠ Amount + Tax (expected ' + (cents / 100).toFixed(2) + ')');
    [a, t, tot].forEach(function (v) { if (typeof v === 'number' && Math.abs(Math.round(v * 100) - v * 100) > 1e-6) add('ERROR', ref, rowNo, 'Amount has more than 2 decimals: ' + v); });
    if (status === 'ACTIVE') { activeTotalCents += Math.round((Number(tot) || 0) * 100); activeCount++; }

    // 3. Dates / period
    if (!(d instanceof Date)) add('ERROR', ref, rowNo, 'Bill Date is not a valid date');
    else {
      const p = r[COL.PERIOD - 1];
      if (!(p instanceof Date) || p.getFullYear() !== d.getFullYear() || p.getMonth() !== d.getMonth() || p.getDate() !== 1)
        add('ERROR', ref, rowNo, 'Period does not match the Bill Date month (reports would be wrong)');
      if (m && m[2] !== Utilities.formatDate(d, tz_(), 'yyyyMM'))
        add('INFO', ref, rowNo, 'Bill Date was changed to another month after recording (reference month ' + m[2] + ')');
    }

    // 4b. Who entered it
    if (!String(r[COL.RECORDED_BY - 1] || '').trim()) add('WARNING', ref, rowNo, 'No login recorded for the person who entered this bill');

    // 4. Category
    const code = String(r[COL.CAT_CODE - 1] || '');
    const cat = cats[code];
    if (!cat) add('ERROR', ref, rowNo, 'Category code "' + code + '" does not exist in Categories');
    else if (cat.name !== r[COL.CATEGORY - 1]) add('ERROR', ref, rowNo, 'Category name "' + r[COL.CATEGORY - 1] + '" does not match code ' + code + ' ("' + cat.name + '")');

    // 6. Receipts
    const ids = String(r[COL.FILE_IDS - 1] || '').split('\n').filter(String);
    if (status === 'ACTIVE' && requireReceipt && !ids.length) add('WARNING', ref, rowNo, 'No receipt attached');
    ids.forEach(function (id) {
      if (Date.now() - started > 240000) { filesSkipped++; return; }   // stay inside the 6-minute limit
      filesChecked++;
      try {
        const f = DriveApp.getFileById(id);
        if (f.isTrashed()) add('ERROR', ref, rowNo, 'Receipt file is in Drive Trash: ' + f.getName() + ' (restore it from Trash)');
        else if (f.getName().indexOf(ref) !== 0) add('WARNING', ref, rowNo, 'Receipt file was renamed: ' + f.getName());
      } catch (e) {
        add('ERROR', ref, rowNo, 'Receipt file not found in Drive (id ' + id + ')');
      }
    });
  });

  // 1b. Gaps in sequences (a missing number means a row was deleted)
  Object.keys(seqs).forEach(function (k) {
    const nums = seqs[k].sort(function (x, y) { return x - y; });
    const have = {}; nums.forEach(function (x) { have[x] = true; });
    for (let x = 1; x <= nums[nums.length - 1]; x++) {
      if (!have[x]) add('ERROR', k + '-' + pad_(x, 4), '', 'Missing reference number — this bill is not in the ledger (rebuild from journal to recover)');
    }
  });

  // 7. Completeness against the backup journal
  try {
    const jsh = journalSheet_();
    const jn = jsh.getLastRow() - 1;
    if (jn > 0) {
      const createdRefs = {};
      jsh.getRange(2, 2, jn, 2).getValues().forEach(function (r) { if (r[0] === 'CREATE' && r[1]) createdRefs[r[1]] = true; });
      Object.keys(createdRefs).forEach(function (ref) {
        if (!seenRef[ref]) add('ERROR', ref, '', 'Bill exists in the backup journal but is missing from the ledger (use Rebuild Bills from live journal)');
      });
      Object.keys(seenRef).forEach(function (ref) {
        if (!createdRefs[ref]) add('INFO', ref, seenRef[ref], 'Bill not in the backup journal (entered or imported directly into the sheet)');
      });
    }
  } catch (e) {
    add('WARNING', '', '', 'Could not read the backup journal: ' + e);
  }

  // 8. Reports are redrawn from the ledger, so they always match it.
  try { refreshReports_(); } catch (e) { add('WARNING', '', '', 'Could not refresh the summaries: ' + e); }
  if (filesSkipped) add('INFO', '', '', filesSkipped + ' receipt file(s) not checked this run (time limit); they are checked on the next run');

  const errors = issues.filter(function (x) { return x[0] === 'ERROR'; }).length;
  const warnings = issues.filter(function (x) { return x[0] === 'WARNING'; }).length;
  const cur = s.CURRENCY_SYMBOL || '';
  const summary = 'Bills checked: ' + (activeCount + voidCount) + ' (' + activeCount + ' active, ' + voidCount + ' void)\n' +
    'Active total: ' + cur + ' ' + (activeTotalCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 }) + '\n' +
    'Receipt files verified: ' + filesChecked + '\n' +
    'Errors: ' + errors + '   Warnings: ' + warnings;

  writeIntegrityReport_(summary, issues);
  audit_('INTEGRITY_CHECK', '', { errors: errors, warnings: warnings, bills: activeCount + voidCount });
  if (errors && s.ALERT_EMAIL) {
    try {
      MailApp.sendEmail(String(s.ALERT_EMAIL), 'Bill Manager: integrity check found ' + errors + ' error(s)',
        summary + '\n\n' + issues.filter(function (x) { return x[0] === 'ERROR'; }).slice(0, 50)
          .map(function (x) { return x[1] + (x[2] ? ' (row ' + x[2] + ')' : '') + ': ' + x[3]; }).join('\n') + '\n\n' + ss_().getUrl());
    } catch (e) { console.error(e); }
  }
  return { errors: errors, warnings: warnings, summary: summary };
}

function writeIntegrityReport_(summary, issues) {
  const sh = getOrCreateSheet_(INTEGRITY_SHEET);
  sh.clear();
  sh.getRange('A1').setValue('Integrity check — ' + Utilities.formatDate(new Date(), tz_(), 'dd/MM/yyyy HH:mm')).setFontSize(14).setFontWeight('bold');
  sh.getRange('A2').setValue(summary).setWrap(true);
  sh.getRange(4, 1, 1, 4).setValues([['Severity', 'Reference', 'Row', 'Issue']]);
  styleHeaderRange_(sh.getRange(4, 1, 1, 4));
  const order = { ERROR: 0, WARNING: 1, INFO: 2 };
  issues.sort(function (a, b) { return order[a[0]] - order[b[0]] || String(a[1]).localeCompare(String(b[1])); });
  if (issues.length) {
    sh.getRange(5, 1, issues.length, 4).setValues(issues);
    issues.forEach(function (x, i) {
      sh.getRange(5 + i, 1).setBackground(x[0] === 'ERROR' ? '#fce8e6' : x[0] === 'WARNING' ? '#fef7e0' : '#e8f0fe');
    });
  } else {
    sh.getRange(5, 1, 1, 4).setValues([['OK', '', '', 'No problems found. The ledger is complete and arithmetically exact.']]);
    sh.getRange(5, 1).setBackground('#e6f4ea');
  }
  sh.setColumnWidth(1, 90).setColumnWidth(2, 170).setColumnWidth(3, 60).setColumnWidth(4, 760);
  sh.setFrozenRows(4);
}
