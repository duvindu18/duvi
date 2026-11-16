/**
 * MAARAA Bills — Entry link (Gateway)
 * --------------------------------------------------------------------------
 * A tiny, separate Apps Script project. It is the ONLY link employees receive.
 *
 *  • Deployed "Execute as: User accessing the web app" + "Who has access: Anyone with Google account",
 *    so Google makes every person sign in.
 *  • It asks each person for just two permissions: "see your e-mail address" and
 *    "connect to an external service". It cannot touch their Drive, Gmail or anything else.
 *  • It holds no data and no business logic. It forwards each request, together with Google's
 *    signed identity token for the signed-in person, to the main Bill Manager script (Api.gs),
 *    which verifies the token, checks the person is approved, and only then records the bill.
 *  • Employees therefore never get access to the spreadsheet, the receipts or other bills.
 *
 * Setup: paste the main Bill Manager web-app URL (…/exec) below, then deploy this project.
 */

const BACKEND_URL = 'PASTE_THE_MAIN_BILL_MANAGER_WEB_APP_URL_HERE';

function doGet() {
  let html;
  try {
    html = call_('page', []);
  } catch (e) {
    html = '<div style="font:16px system-ui;padding:40px"><h1>Unavailable.</h1><p>' +
      String(e.message).replace(/[<>&]/g, '') + '</p></div>';
  }
  return HtmlService.createHtmlOutput(html)
    .setTitle('MAARAA Bills')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

// Every function the form may call. Permissions are enforced by the main script, not here.
function getFormData()               { return call_('getFormData', []); }
function saveBill(payload)           { return call_('saveBill', [payload]); }
function checkReceiptHashes(hashes)  { return call_('checkReceiptHashes', [hashes]); }
function listMyBills(limit)          { return call_('listMyBills', [limit]); }
function updateBill(ref, payload)    { return call_('updateBill', [ref, payload]); }
function getCategories(all)          { return call_('getCategories', [all]); }
function addCategory(input)          { return call_('addCategory', [input]); }
function updateCategory(code, input) { return call_('updateCategory', [code, input]); }
function deleteCategory(code)        { return call_('deleteCategory', [code]); }
function restoreCategory(code)       { return call_('restoreCategory', [code]); }
function listUsers()                 { return call_('listUsers', []); }
function saveUser(input)             { return call_('saveUser', [input]); }
function deleteUser(email)           { return call_('deleteUser', [email]); }

function call_(action, args) {
  if (!/^https:\/\/script\.google\.com\//.test(BACKEND_URL)) {
    throw new Error('The Entry link is not configured yet (BACKEND_URL).');
  }
  const res = UrlFetchApp.fetch(BACKEND_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ action: action, args: args, token: ScriptApp.getIdentityToken() }),
    muteHttpExceptions: true,
    followRedirects: true,
  });
  let body;
  try { body = JSON.parse(res.getContentText()); }
  catch (e) { throw new Error('The bill server did not respond correctly (HTTP ' + res.getResponseCode() + '). Please try again.'); }
  if (!body.ok) throw new Error(body.error);
  return body.result;
}
