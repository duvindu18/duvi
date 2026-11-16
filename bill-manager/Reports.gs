/**
 * Reports — Monthly Summary (A4 portrait) and Annual Summary (A4 landscape).
 *
 * Both pages are drawn by the script from the Bills ledger (no fragile array formulas), in a
 * black & white, print-ready layout with borders, margins and wrapped text.
 *
 *  • Monthly Summary: pick Month + Year in the dropdowns (C3, D3) → the page redraws at once.
 *  • Annual Summary:  pick Year (C3) → category × month breakdown with group subtotals.
 *  • Pages refresh automatically: when a dropdown changes, when the spreadsheet is opened, and
 *    every 5 minutes if any bill was added or changed (see refreshReportsIfDirty).
 *  • Menu → 🖨 Save … as PDF creates an A4 PDF in Drive → Reports.
 */

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const NUM_FMT = '#,##0.00;(#,##0.00);"–"';
const INK = '#000000', GREY_LINE = '#9e9e9e', GREY_FILL = '#eeeeee', GREY_TEXT = '#616161';

// ------------------------------------------------------------------ refresh plumbing

function markReportsDirty_() {
  try { PropertiesService.getScriptProperties().setProperty('REPORTS_DIRTY', String(Date.now())); } catch (e) { }
}

/** Time-driven (every 5 min) and on open: redraw the reports only if something changed. */
function refreshReportsIfDirty() {
  const props = PropertiesService.getScriptProperties();
  const flag = props.getProperty('REPORTS_DIRTY');
  if (!flag) return;
  refreshReports_();
  // Only clear the flag if nothing new arrived while drawing (and drawing succeeded).
  if (props.getProperty('REPORTS_DIRTY') === flag) props.deleteProperty('REPORTS_DIRTY');
}

/** Draws both summaries. A failure in one never leaves the other undrawn. */
function refreshReports_() {
  const errors = [];
  [[SHEET.SUMMARY, drawMonthlySummary_], [SHEET.ANNUAL, drawAnnualSummary_]].forEach(function (x) {
    try { x[1](); } catch (e) { errors.push(x[0] + ': ' + e.message); showReportError_(x[0], e); }
  });
  if (errors.length) throw new Error('Could not draw ' + errors.join(' | '));
}

function renderMonthlySummary_() {
  try { drawMonthlySummary_(); } catch (e) { showReportError_(SHEET.SUMMARY, e); throw e; }
}
function renderAnnualSummary_() {
  try { drawAnnualSummary_(); } catch (e) { showReportError_(SHEET.ANNUAL, e); throw e; }
}

/** Never leave a blank page: write what went wrong where the admin will see it. */
function showReportError_(sheetName, err) {
  try {
    const sh = getOrCreateSheet_(sheetName);
    sh.getRange('B2').setValue('This summary could not be drawn: ' + (err && err.message || err));
    sh.getRange('B3').setValue('Fix: Bill Manager menu → ↻ Refresh summaries. If it repeats, run ⚙️ Setup / repair and send a screenshot of this message.');
    sh.getRange('B2:B3').setFontColor('#000000').setFontWeight('bold').setWrap(false);
    audit_('REPORT_ERROR', sheetName, { error: String(err && err.message || err), stack: String(err && err.stack || '').slice(0, 500) });
  } catch (e) { console.error(e); }
}

function rebuildReports() {
  requireSheetAdmin_();
  try {
    refreshReports_();
    toast_('Monthly and Annual summaries refreshed.');
  } catch (e) {
    SpreadsheetApp.getUi().alert('Summaries', e.message, SpreadsheetApp.getUi().ButtonSet.OK);
  }
}

// Kept for compatibility with setup and older menu items.
function buildSummarySheet() { requireSheetAdmin_(); renderMonthlySummary_(); }
function buildAnnualSheet() { requireSheetAdmin_(); renderAnnualSummary_(); }

// ------------------------------------------------------------------ data

function reportData_() {
  const sh = sheet_(SHEET.BILLS);
  const last = lastDataRow_(sh, COL.REF);
  const rows = last > 1 ? sh.getRange(2, 1, last - 1, NCOLS).getValues() : [];
  const bills = rows.filter(function (r) { return r[COL.REF - 1] && r[COL.STATUS - 1] === 'ACTIVE' && r[COL.BILL_DATE - 1] instanceof Date; })
    .map(function (r) {
      const d = r[COL.BILL_DATE - 1];
      return {
        ref: String(r[COL.REF - 1]), date: d, y: d.getFullYear(), m: d.getMonth(),
        vendor: String(r[COL.VENDOR - 1] || ''), description: String(r[COL.DESCRIPTION - 1] || '').replace(/^'/, ''),
        category: String(r[COL.CATEGORY - 1] || ''), method: String(r[COL.METHOD - 1] || ''),
        total: Math.round((Number(r[COL.TOTAL - 1]) || 0) * 100), tax: Math.round((Number(r[COL.TAX - 1]) || 0) * 100),
        paid: r[COL.PAY_STATUS - 1] === 'Paid', status: String(r[COL.PAY_STATUS - 1] || ''),
        by: String(r[COL.RECORDED_BY_NAME - 1] || r[COL.RECORDED_BY - 1] || ''),
      };
    });
  return { bills: bills, cats: categories_(true) };
}

const cents_ = function (c) { return c / 100; };

// ------------------------------------------------------------------ sheet helpers

/** Wipes a report sheet and sets its column grid. widths includes the margin columns. */
function resetReportSheet_(sh, widths, rows) {
  const maxC = sh.getMaxColumns(), maxR = sh.getMaxRows();
  const all = sh.getRange(1, 1, maxR, maxC);
  all.breakApart();
  all.clear();
  all.clearDataValidations();
  sh.setConditionalFormatRules([]);
  sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function (p) { p.remove(); });
  sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) { p.remove(); });
  sh.setFrozenRows(0); sh.setFrozenColumns(0);
  if (maxC < widths.length) sh.insertColumnsAfter(maxC, widths.length - maxC);
  else if (maxC > widths.length) sh.deleteColumns(widths.length + 1, maxC - widths.length);
  if (maxR < rows) sh.insertRowsAfter(maxR, rows - maxR);
  else if (maxR > rows) sh.deleteRows(rows + 1, maxR - rows);
  widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.setRowHeights(1, rows, 21);
  sh.setHiddenGridlines(true);
  sh.getRange(1, 1, rows, widths.length).setFontFamily('Arial').setFontSize(10).setFontColor(INK).setVerticalAlignment('middle');
}

function boxed_(range) {
  return range.setBorder(true, true, true, true, true, true, GREY_LINE, SpreadsheetApp.BorderStyle.SOLID);
}

function tableHeader_(range) {
  return range.setBackground(INK).setFontColor('#ffffff').setFontWeight('bold').setFontSize(9).setWrap(true)
    .setVerticalAlignment('middle').setBorder(true, true, true, true, true, true, INK, SpreadsheetApp.BorderStyle.SOLID);
}

function sectionTitle_(sh, row, col, span, text) {
  const r = sh.getRange(row, col, 1, span);
  r.merge().setValue(text.toUpperCase()).setFontWeight('bold').setFontSize(10)
    .setBorder(null, null, true, null, null, null, INK, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sh.setRowHeight(row, 26);
  return r;
}

function selectorStyle_(range) {
  return range.setBackground('#ffffff').setFontWeight('bold').setFontSize(11).setHorizontalAlignment('center')
    .setBorder(true, true, true, true, null, null, INK, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
}

function protectReport_(sh, unprotected) {
  const p = sh.protect().setDescription('Report — drawn automatically. Use the dropdowns to change the period.').setWarningOnly(true);
  if (unprotected && unprotected.length) p.setUnprotectedRanges(unprotected);
}

function yearOptions_(bills) {
  const now = new Date().getFullYear();
  const years = {};
  for (let y = now - 3; y <= now + 1; y++) years[y] = true;
  bills.forEach(function (b) { years[b.y] = true; });
  return Object.keys(years).map(Number).sort();
}

// ======================================================= MONTHLY SUMMARY (A4 portrait)

function drawMonthlySummary_() {
  const sh = getOrCreateSheet_(SHEET.SUMMARY);
  const s = settings_();

  // Selected period (keep the admin's choice across redraws).
  let mi = -1, yr = 0;
  try {
    mi = MONTH_NAMES.indexOf(String(sh.getRange('C3').getValue()));
    yr = Number(sh.getRange('D3').getValue()) || 0;
  } catch (e) { }
  const today = new Date();
  if (mi < 0) mi = today.getMonth();
  if (!yr) yr = today.getFullYear();

  const data = reportData_();
  const inMonth = data.bills.filter(function (b) { return b.y === yr && b.m === mi; })
    .sort(function (a, b) { return a.date - b.date || a.ref.localeCompare(b.ref); });
  const prevY = mi === 0 ? yr - 1 : yr, prevM = mi === 0 ? 11 : mi - 1;
  const sum = function (list, f) { return list.reduce(function (t, b) { return t + (f ? f(b) : b.total); }, 0); };
  const total = sum(inMonth), tax = sum(inMonth, function (b) { return b.tax; });
  const unpaidList = inMonth.filter(function (b) { return !b.paid; });
  const prevTotal = sum(data.bills.filter(function (b) { return b.y === prevY && b.m === prevM; }));
  const ytd = sum(data.bills.filter(function (b) { return b.y === yr && b.m <= mi; }));

  // Category rows (grouped): categories with spending this month or a budget.
  const byCat = {};
  inMonth.forEach(function (b) { const c = byCat[b.category] = byCat[b.category] || { n: 0, t: 0 }; c.n++; c.t += b.total; });
  const catMeta = {};
  data.cats.forEach(function (c) { catMeta[c.name] = c; });
  Object.keys(byCat).forEach(function (n) { if (!catMeta[n]) catMeta[n] = { name: n, group: 'Other', budget: '', active: false }; });
  const groups = {};
  Object.keys(catMeta).forEach(function (n) {
    const c = catMeta[n];
    const budget = c.budget === '' ? 0 : Math.round(Number(c.budget) * 100);
    if (!byCat[n] && !(c.active && budget > 0)) return;
    (groups[c.group || 'Other'] = groups[c.group || 'Other'] || []).push({ name: n, budget: budget, n: (byCat[n] || {}).n || 0, t: (byCat[n] || {}).t || 0 });
  });
  const groupNames = Object.keys(groups).sort();
  const byMethod = {}, byPerson = {};
  inMonth.forEach(function (b) {
    const m = byMethod[b.method || '—'] = byMethod[b.method || '—'] || { n: 0, t: 0 }; m.n++; m.t += b.total;
    const p = byPerson[b.by || '—'] = byPerson[b.by || '—'] || { n: 0, t: 0 }; p.n++; p.t += b.total;
  });

  const catRows = groupNames.reduce(function (t, g) { return t + 1 + groups[g].length; }, 0);
  const rowsNeeded = 16 + catRows + 4 + Object.keys(byMethod).length + 4 + Object.keys(byPerson).length + 4 + inMonth.length + 8;

  // Grid: A margin | B..G content (6 columns, ~ A4 portrait width) | H margin
  resetReportSheet_(sh, [18, 92, 130, 128, 118, 118, 118, 18], Math.max(rowsNeeded, 40));
  const cur = s.CURRENCY_SYMBOL || 'Rs.';
  let r = 2;

  // Title + period selector
  sh.getRange(r, 2, 1, 6).merge().setValue((s.COMPANY_NAME || 'MAARAA') + ' — Monthly Expense Summary')
    .setFontSize(18).setFontWeight('bold');
  sh.setRowHeight(r, 34);
  r++;
  sh.getRange(r, 2).setValue('Month ▸').setFontWeight('bold').setHorizontalAlignment('right');
  const monthCell = sh.getRange(r, 3), yearCell = sh.getRange(r, 4);
  monthCell.setValue(MONTH_NAMES[mi]).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(MONTH_NAMES, true).setAllowInvalid(false).build());
  yearCell.setNumberFormat('0').setValue(yr).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(yearOptions_(data.bills).map(String), true).setAllowInvalid(false).build());
  selectorStyle_(monthCell); selectorStyle_(yearCell);
  sh.setRowHeight(r, 28);
  sh.getRange(r, 5, 1, 3).merge().setValue('Amounts in ' + cur + ' · updated ' + Utilities.formatDate(new Date(), tz_(), 'dd/MM/yyyy HH:mm'))
    .setFontSize(8).setFontColor(GREY_TEXT).setHorizontalAlignment('right');
  r += 2;

  // KPI tiles (3 per row, each 2 columns wide)
  const change = prevTotal ? (total - prevTotal) / prevTotal : null;
  const tiles = [
    ['Total expenses', cents_(total), NUM_FMT],
    ['Number of bills', inMonth.length, '0'],
    ['Tax / VAT included', cents_(tax), NUM_FMT],
    ['Unpaid (' + unpaidList.length + ')', cents_(sum(unpaidList)), NUM_FMT],
    ['vs ' + MONTH_NAMES[prevM].slice(0, 3) + ' ' + prevY, change === null ? '–' : change, change === null ? '@' : '+0.0%;-0.0%;0.0%'],
    ['Year to date ' + yr, cents_(ytd), NUM_FMT],
  ];
  [0, 3].forEach(function (start) {
    for (let i = 0; i < 3; i++) {
      const t = tiles[start + i], col = 2 + i * 2;
      const lab = sh.getRange(r, col, 1, 2).merge().setValue(t[0].toUpperCase()).setFontSize(8).setFontColor(GREY_TEXT).setFontWeight('bold');
      const val = sh.getRange(r + 1, col, 1, 2).merge().setValue(t[1]).setNumberFormat(t[2]).setFontSize(16).setFontWeight('bold').setHorizontalAlignment('left');
      sh.getRange(r, col, 2, 2).setBorder(true, true, true, true, null, null, INK, SpreadsheetApp.BorderStyle.SOLID);
      lab.setVerticalAlignment('bottom'); val.setVerticalAlignment('top');
    }
    sh.setRowHeight(r, 22); sh.setRowHeight(r + 1, 32);
    r += 3;
  });

  // By category
  sectionTitle_(sh, r, 2, 6, 'Expenses by category');
  r++;
  sh.getRange(r, 2, 1, 6).setValues([['Category', '', 'Bills', 'Budget', 'Actual', 'Variance']]);
  sh.getRange(r, 2, 1, 2).merge();
  tableHeader_(sh.getRange(r, 2, 1, 6));
  sh.getRange(r, 4, 1, 4).setHorizontalAlignment('right');
  r++;
  const catStart = r;
  let budgetTotal = 0;
  if (!catRows) {
    sh.getRange(r, 2, 1, 6).merge().setValue('No bills recorded for this month.').setFontColor(GREY_TEXT).setFontStyle('italic');
    r++;
  }
  groupNames.forEach(function (g) {
    const items = groups[g].sort(function (a, b) { return b.t - a.t || a.name.localeCompare(b.name); });
    const gt = items.reduce(function (t, x) { return t + x.t; }, 0), gb = items.reduce(function (t, x) { return t + x.budget; }, 0);
    budgetTotal += gb;
    sh.getRange(r, 2, 1, 6).setValues([[g, '', items.reduce(function (t, x) { return t + x.n; }, 0), gb ? cents_(gb) : '', cents_(gt), gb ? cents_(gb - gt) : '']]);
    sh.getRange(r, 2, 1, 6).setBackground(GREY_FILL).setFontWeight('bold');
    r++;
    const vals = items.map(function (x) { return ['    ' + x.name, '', x.n, x.budget ? cents_(x.budget) : '', cents_(x.t), x.budget ? cents_(x.budget - x.t) : '']; });
    sh.getRange(r, 2, vals.length, 6).setValues(vals);
    r += vals.length;
  });
  if (catRows) {
    sh.getRange(catStart, 2, r - catStart, 2).mergeAcross();
    boxed_(sh.getRange(catStart, 2, r - catStart, 6)).setWrap(true);
    sh.getRange(catStart, 4, r - catStart, 1).setNumberFormat('0');
    sh.getRange(catStart, 5, r - catStart, 3).setNumberFormat(NUM_FMT);
    sh.getRange(catStart, 4, r - catStart, 4).setHorizontalAlignment('right');
  }
  // Grand total
  sh.getRange(r, 2, 1, 6).setValues([['TOTAL', '', inMonth.length, budgetTotal ? cents_(budgetTotal) : '', cents_(total), budgetTotal ? cents_(budgetTotal - total) : '']]);
  sh.getRange(r, 2, 1, 2).merge();
  tableHeader_(sh.getRange(r, 2, 1, 6)).setFontSize(10);
  sh.getRange(r, 4).setNumberFormat('0');
  sh.getRange(r, 5, 1, 3).setNumberFormat(NUM_FMT);
  sh.getRange(r, 4, 1, 4).setHorizontalAlignment('right');
  sh.setRowHeight(r, 26);
  r += 2;

  // Small two-up tables: payment method | recorded by
  const smallTable = function (title, map, col) {
    let rr = r;
    sectionTitle_(sh, rr, col, 3, title); rr++;
    sh.getRange(rr, col, 1, 3).setValues([[title === 'By payment method' ? 'Method' : 'Recorded by', 'Bills', 'Total']]);
    tableHeader_(sh.getRange(rr, col, 1, 3)); sh.getRange(rr, col + 1, 1, 2).setHorizontalAlignment('right'); rr++;
    const keys = Object.keys(map).sort(function (a, b) { return map[b].t - map[a].t; });
    if (keys.length) {
      sh.getRange(rr, col, keys.length, 3).setValues(keys.map(function (k) { return [k, map[k].n, cents_(map[k].t)]; }));
      boxed_(sh.getRange(rr, col, keys.length, 3)).setWrap(true);
      sh.getRange(rr, col + 2, keys.length, 1).setNumberFormat(NUM_FMT);
      sh.getRange(rr, col + 1, keys.length, 2).setHorizontalAlignment('right');
      rr += keys.length;
    } else {
      sh.getRange(rr, col, 1, 3).merge().setValue('—').setFontColor(GREY_TEXT); rr++;
    }
    return rr;
  };
  const end1 = smallTable('By payment method', byMethod, 2);
  const end2 = smallTable('By person', byPerson, 5);
  r = Math.max(end1, end2) + 1;

  // Bill register for the month
  sectionTitle_(sh, r, 2, 6, 'Bills in ' + MONTH_NAMES[mi] + ' ' + yr + ' (' + inMonth.length + ')');
  r++;
  sh.getRange(r, 2, 1, 6).setValues([['Date', 'Ref No', 'Payee — description', '', 'Category', 'Total']]);
  sh.getRange(r, 4, 1, 2).merge();
  tableHeader_(sh.getRange(r, 2, 1, 6));
  sh.getRange(r, 7).setHorizontalAlignment('right');
  r++;
  if (inMonth.length) {
    const vals = inMonth.map(function (b) {
      return [b.date, b.ref, b.vendor + (b.description ? ' — ' + b.description : '') + (b.paid ? '' : '  [' + b.status.toUpperCase() + ']'), '', b.category, cents_(b.total)];
    });
    const body = sh.getRange(r, 2, vals.length, 6);
    body.setValues(vals);
    sh.getRange(r, 4, vals.length, 2).mergeAcross();
    boxed_(body).setWrap(true).setVerticalAlignment('top');
    sh.getRange(r, 2, vals.length, 1).setNumberFormat('dd/MM/yyyy');
    sh.getRange(r, 3, vals.length, 1).setFontFamily('Roboto Mono').setFontSize(8);
    sh.getRange(r, 7, vals.length, 1).setNumberFormat(NUM_FMT).setHorizontalAlignment('right');
    r += vals.length;
  } else {
    sh.getRange(r, 2, 1, 6).merge().setValue('No bills recorded for this month.').setFontColor(GREY_TEXT).setFontStyle('italic');
    r++;
  }
  sh.getRange(r, 2, 1, 6).setValues([['', '', 'Total for ' + MONTH_NAMES[mi] + ' ' + yr, '', '', cents_(total)]]);
  sh.getRange(r, 4, 1, 3).merge().setHorizontalAlignment('right');
  tableHeader_(sh.getRange(r, 2, 1, 6)).setFontSize(10);
  sh.getRange(r, 7).setNumberFormat(NUM_FMT).setHorizontalAlignment('right');
  r += 2;

  sh.getRange(r, 2, 1, 6).merge().setValue('Prepared by ' + (s.COMPANY_NAME || 'MAARAA') + ' Bill Manager. Voided bills are excluded. Signature: ______________________   Date: ____________')
    .setFontSize(8).setFontColor(GREY_TEXT).setWrap(true);
  sh.setRowHeight(r, 30);

  protectReport_(sh, [monthCell, yearCell]);
}

// ======================================================= ANNUAL SUMMARY (A4 landscape)

function drawAnnualSummary_() {
  const sh = getOrCreateSheet_(SHEET.ANNUAL);
  const s = settings_();
  let yr = 0;
  try { yr = Number(sh.getRange('C3').getValue()) || 0; } catch (e) { }
  if (!yr || yr < 2000) yr = new Date().getFullYear();

  const data = reportData_();
  const inYear = data.bills.filter(function (b) { return b.y === yr; });
  // category -> [12 months cents]
  const grid = {};
  inYear.forEach(function (b) { (grid[b.category] = grid[b.category] || new Array(12).fill(0))[b.m] += b.total; });
  const catMeta = {};
  data.cats.forEach(function (c) { catMeta[c.name] = c; });
  Object.keys(grid).forEach(function (n) { if (!catMeta[n]) catMeta[n] = { name: n, group: 'Other', active: false }; });
  const groups = {};
  Object.keys(catMeta).forEach(function (n) {
    const c = catMeta[n];
    if (!c.active && !grid[n]) return;                              // archived & unused this year: hide
    (groups[c.group || 'Other'] = groups[c.group || 'Other'] || []).push({ name: n, months: grid[n] || new Array(12).fill(0) });
  });
  const groupNames = Object.keys(groups).sort();
  const monthTotals = new Array(12).fill(0);
  inYear.forEach(function (b) { monthTotals[b.m] += b.total; });
  const yearTotal = monthTotals.reduce(function (a, b) { return a + b; }, 0);
  const nRows = groupNames.reduce(function (t, g) { return t + 1 + groups[g].length; }, 0);

  // Grid: A margin | B category | C..N months | O total | P % | Q margin
  const widths = [18, 220].concat(new Array(12).fill(74)).concat([96, 52, 18]);
  resetReportSheet_(sh, widths, Math.max(14 + nRows + 6, 30));
  const cur = s.CURRENCY_SYMBOL || 'Rs.';
  let r = 2;
  sh.getRange(r, 2, 1, 15).merge().setValue((s.COMPANY_NAME || 'MAARAA') + ' — Total Annual Expenses').setFontSize(18).setFontWeight('bold');
  sh.setRowHeight(r, 34);
  r++;
  sh.getRange(r, 2).setValue('Year ▸').setFontWeight('bold').setHorizontalAlignment('right');
  const yearCell = sh.getRange(r, 3);
  yearCell.setNumberFormat('0').setValue(yr).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(yearOptions_(data.bills).map(String), true).setAllowInvalid(false).build());
  selectorStyle_(yearCell);
  sh.setRowHeight(r, 28);
  sh.getRange(r, 9, 1, 8).merge().setValue('Amounts in ' + cur + ' · voided bills excluded · updated ' + Utilities.formatDate(new Date(), tz_(), 'dd/MM/yyyy HH:mm'))
    .setFontSize(8).setFontColor(GREY_TEXT).setHorizontalAlignment('right');
  r += 2;

  // KPI tiles
  const monthsWithData = monthTotals.filter(function (t) { return t > 0; }).length;
  let best = -1;
  monthTotals.forEach(function (t, i) { if (t > 0 && (best < 0 || t > monthTotals[best])) best = i; });
  const tiles = [
    [2, 1, 'Total annual expenses', cents_(yearTotal), NUM_FMT],
    [3, 4, 'Number of bills', inYear.length, '0'],
    [7, 4, 'Average per active month', monthsWithData ? cents_(Math.round(yearTotal / monthsWithData)) : 0, NUM_FMT],
    [11, 6, 'Highest month', best < 0 ? '–' : MONTH_NAMES[best] + '  ·  ' + Utilities.formatString('%s', (monthTotals[best] / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })), '@'],
  ];
  tiles.forEach(function (t) {
    sh.getRange(r, t[0], 1, t[1]).merge().setValue(t[2].toUpperCase()).setFontSize(8).setFontColor(GREY_TEXT).setFontWeight('bold').setVerticalAlignment('bottom');
    sh.getRange(r + 1, t[0], 1, t[1]).merge().setValue(t[3]).setNumberFormat(t[4]).setFontSize(15).setFontWeight('bold').setHorizontalAlignment('left').setVerticalAlignment('top');
    sh.getRange(r, t[0], 2, t[1]).setBorder(true, true, true, true, null, null, INK, SpreadsheetApp.BorderStyle.SOLID);
  });
  sh.setRowHeight(r, 22); sh.setRowHeight(r + 1, 30);
  r += 3;

  // Header
  const head = ['Expense category'].concat(MONTH_NAMES.map(function (m) { return m.slice(0, 3); })).concat(['Total', '%']);
  sh.getRange(r, 2, 1, 15).setValues([head]);
  tableHeader_(sh.getRange(r, 2, 1, 15));
  sh.getRange(r, 3, 1, 14).setHorizontalAlignment('right');
  sh.setRowHeight(r, 26);
  sh.setFrozenRows(r);
  r++;

  const bodyStart = r;
  const groupRows = [];
  groupNames.forEach(function (g) {
    const items = groups[g].sort(function (a, b) { return a.name.localeCompare(b.name); });
    const gm = new Array(12).fill(0);
    items.forEach(function (x) { x.months.forEach(function (v, i) { gm[i] += v; }); });
    const gsum = gm.reduce(function (a, b) { return a + b; }, 0);
    groupRows.push(r);
    sh.getRange(r, 2, 1, 15).setValues([[g].concat(gm.map(cents_)).concat([cents_(gsum), yearTotal ? gsum / yearTotal : 0])]);
    r++;
    const vals = items.map(function (x) {
      const t = x.months.reduce(function (a, b) { return a + b; }, 0);
      return ['    ' + x.name].concat(x.months.map(cents_)).concat([cents_(t), yearTotal ? t / yearTotal : 0]);
    });
    if (vals.length) { sh.getRange(r, 2, vals.length, 15).setValues(vals); r += vals.length; }
  });
  if (r > bodyStart) {
    const body = sh.getRange(bodyStart, 2, r - bodyStart, 15);
    boxed_(body).setWrap(true);
    sh.getRange(bodyStart, 3, r - bodyStart, 13).setNumberFormat(NUM_FMT).setHorizontalAlignment('right');
    sh.getRange(bodyStart, 16, r - bodyStart, 1).setNumberFormat('0%;-0%;"–"').setHorizontalAlignment('right');
    sh.getRange(bodyStart, 15, r - bodyStart, 1).setFontWeight('bold');
    groupRows.forEach(function (gr) { sh.getRange(gr, 2, 1, 15).setBackground(GREY_FILL).setFontWeight('bold'); });
  }
  // Month totals / grand total
  sh.getRange(r, 2, 1, 15).setValues([['TOTAL'].concat(monthTotals.map(cents_)).concat([cents_(yearTotal), yearTotal ? 1 : 0])]);
  tableHeader_(sh.getRange(r, 2, 1, 15)).setFontSize(9);
  sh.getRange(r, 3, 1, 13).setNumberFormat(NUM_FMT).setHorizontalAlignment('right');
  sh.getRange(r, 16).setNumberFormat('0%;-0%;"–"').setHorizontalAlignment('right');
  sh.setRowHeight(r, 26);
  r += 2;
  sh.getRange(r, 2, 1, 15).merge().setValue('Group rows (shaded) are subtotals of the categories below them. Prepared by ' + (s.COMPANY_NAME || 'MAARAA') + ' Bill Manager.')
    .setFontSize(8).setFontColor(GREY_TEXT);

  protectReport_(sh, [yearCell]);
}

// ======================================================= A4 PDF EXPORT

function exportMonthlyPdf() { exportReportPdf_(SHEET.SUMMARY, true); }
function exportAnnualPdf() { exportReportPdf_(SHEET.ANNUAL, false); }

function exportReportPdf_(sheetName, portrait) {
  requireSheetAdmin_();
  refreshReports_();
  SpreadsheetApp.flush();
  const ss = ss_();
  const sh = sheet_(sheetName);
  const params = {
    format: 'pdf', size: 'A4', portrait: portrait, fitw: true, gridlines: false, printtitle: false, sheetnames: false,
    pagenum: 'CENTER', fzr: true, horizontal_alignment: 'CENTER', vertical_alignment: 'TOP',
    top_margin: 0.5, bottom_margin: 0.5, left_margin: 0.4, right_margin: 0.4, gid: sh.getSheetId(),
  };
  const qs = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
  const res = UrlFetchApp.fetch('https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?' + qs, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('PDF export failed (HTTP ' + res.getResponseCode() + ').');

  let label;
  if (sheetName === SHEET.SUMMARY) label = sh.getRange('C3').getValue() + ' ' + sh.getRange('D3').getValue();
  else label = String(sh.getRange('C3').getValue());
  const name = (settings_().COMPANY_NAME || 'MAARAA') + ' ' + sheetName + ' — ' + label + '.pdf';
  const folder = childFolder_(childFolder_(rootFolder_(), 'Reports'), String(new Date().getFullYear()));
  const file = folder.createFile(res.getBlob().setName(name));
  audit_('REPORT_PDF', sheetName, { file: name });

  const html = HtmlService.createHtmlOutput('<div style="font:14px Arial;line-height:1.6"><p><b>' + escapeHtml_(name) +
    '</b> saved (A4 ' + (portrait ? 'portrait' : 'landscape') + ').</p><p><a target="_blank" href="' + file.getUrl() +
    '">Open the PDF</a> · <a target="_blank" href="' + folder.getUrl() + '">Reports folder</a></p></div>').setWidth(520).setHeight(160);
  SpreadsheetApp.getUi().showModalDialog(html, 'PDF ready');
}

// ======================================================= IN-APP SUMMARY (Admin)

/**
 * Monthly summary for the app's "Summary" tab. year/month (0–11) default to the current month.
 * Uses the same ledger rules as the sheet reports (ACTIVE bills only, exact to the cent).
 */
function getMonthSummary(year, month) {
  requireAdmin_();
  const today = new Date();
  const yr = Number(year) || today.getFullYear();
  const mi = month === 0 || month ? Math.min(11, Math.max(0, Number(month))) : today.getMonth();
  const data = reportData_();
  const C = function (c) { return c / 100; };
  const sum = function (list, f) { return list.reduce(function (t, b) { return t + (f ? f(b) : b.total); }, 0); };

  const inMonth = data.bills.filter(function (b) { return b.y === yr && b.m === mi; })
    .sort(function (a, b) { return b.date - a.date || b.ref.localeCompare(a.ref); });
  const prevY = mi === 0 ? yr - 1 : yr, prevM = mi === 0 ? 11 : mi - 1;
  const prevTotal = sum(data.bills.filter(function (b) { return b.y === prevY && b.m === prevM; }));
  const total = sum(inMonth);
  const unpaid = inMonth.filter(function (b) { return !b.paid; });

  const months = new Array(12).fill(0);
  data.bills.forEach(function (b) { if (b.y === yr) months[b.m] += b.total; });
  const ytd = months.slice(0, mi + 1).reduce(function (a, b) { return a + b; }, 0);

  const meta = {};
  data.cats.forEach(function (c) { meta[c.name] = c; });
  const byCat = {};
  inMonth.forEach(function (b) { const c = byCat[b.category] = byCat[b.category] || { n: 0, t: 0 }; c.n++; c.t += b.total; });
  let budgetTotal = 0;
  data.cats.forEach(function (c) { if (c.active && c.budget !== '' && Number(c.budget) > 0) budgetTotal += Math.round(Number(c.budget) * 100); });
  const categories = Object.keys(byCat).map(function (n) {
    const m = meta[n] || {};
    const budget = m.budget === '' || m.budget == null ? 0 : Math.round(Number(m.budget) * 100);
    return { name: n, group: m.group || 'Other', bills: byCat[n].n, total: C(byCat[n].t), budget: budget ? C(budget) : null };
  }).sort(function (a, b) { return b.total - a.total || a.name.localeCompare(b.name); });
  // Budgeted categories with nothing spent yet, so the admin sees them too.
  data.cats.forEach(function (c) {
    if (c.active && c.budget !== '' && Number(c.budget) > 0 && !byCat[c.name])
      categories.push({ name: c.name, group: c.group, bills: 0, total: 0, budget: Number(c.budget) });
  });

  // Budget use compares like with like: spending in budgeted categories vs their budgets.
  const budgetSpent = categories.reduce(function (t, c) { return t + (c.budget != null ? Math.round(c.total * 100) : 0); }, 0);

  const group = function (key) {
    const m = {};
    inMonth.forEach(function (b) { const k = b[key] || '—'; const x = m[k] = m[k] || { n: 0, t: 0 }; x.n++; x.t += b.total; });
    return Object.keys(m).map(function (k) { return { name: k, bills: m[k].n, total: C(m[k].t) }; })
      .sort(function (a, b) { return b.total - a.total || a.name.localeCompare(b.name); });
  };

  return {
    year: yr, month: mi, label: MONTH_NAMES[mi] + ' ' + yr, prevLabel: MONTH_NAMES[prevM].slice(0, 3) + ' ' + prevY,
    years: yearOptions_(data.bills),
    kpi: { total: C(total), bills: inMonth.length, tax: C(sum(inMonth, function (b) { return b.tax; })),
           unpaid: C(sum(unpaid)), unpaidBills: unpaid.length, prevTotal: C(prevTotal),
           change: prevTotal ? (total - prevTotal) / prevTotal : null, ytd: C(ytd), budget: budgetTotal ? C(budgetTotal) : null,
           budgetSpent: C(budgetSpent) },
    months: months.map(C),
    categories: categories,
    methods: group('method'),
    people: group('by'),
    bills: inMonth.map(function (b) {
      return { ref: b.ref, date: Utilities.formatDate(b.date, tz_(), 'dd/MM/yyyy'), vendor: b.vendor, category: b.category,
               total: C(b.total), status: b.status, paid: b.paid, by: b.by };
    }),
    updated: Utilities.formatDate(new Date(), tz_(), 'dd/MM/yyyy HH:mm'),
  };
}
