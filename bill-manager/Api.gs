/**
 * Secure entry point used by the Entry link (gateway/Gateway.gs).
 *
 * This project is deployed as a web app that runs as the OWNER, so employees never need access
 * to the spreadsheet or Drive. Each request carries the caller's Google OpenID identity token,
 * which is verified with Google before anything happens:
 *    • signature/expiry checked by Google's tokeninfo endpoint
 *    • issuer must be Google, e-mail must be verified
 *    • audience must be OUR Entry-link project (learned once, when the owner first opens it)
 * The verified e-mail is then looked up in the Users tab. Each action states whether it is
 * open to Employees or Admin-only; anything not listed is refused.
 */

function api_() {
  return {
    // action:              [function,            who may call it]
    page:                   [renderEntryPage_,    'anyone'],     // the HTML of the form itself
    getFormData:            [getFormData,         'employee'],
    saveBill:               [saveBill,            'employee'],
    checkReceiptHashes:     [checkReceiptHashes,  'employee'],
    listMyBills:            [listMyBills,         'employee'],   // own bills only (Admins: all)
    updateBill:             [updateBill,          'employee'],   // own bills, within the edit window
    getCategories:          [getCategories,       'admin'],
    addCategory:            [addCategory,         'admin'],
    updateCategory:         [updateCategory,      'admin'],
    deleteCategory:         [deleteCategory,      'admin'],
    restoreCategory:        [restoreCategory,     'admin'],
    listUsers:              [listUsers,           'admin'],
    saveUser:               [saveUser,            'admin'],
    deleteUser:             [deleteUser,          'admin'],
  };
}

function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const entry = api_()[req.action];
    if (!entry) throw new Error('Unknown action.');

    let email = '';
    try { email = verifyIdentityToken_(req.token); }
    catch (err) { if (entry[1] !== 'anyone') throw err; }

    if (entry[1] !== 'anyone') {
      CURRENT_USER_ = resolveUser_(email);                 // throws NOT_AUTHORISED if not approved
      if (entry[1] === 'admin' && CURRENT_USER_.role !== 'Admin') throw new Error('Only an Admin can do this. Employees can record bills only.');
    }
    out = { ok: true, result: entry[0].apply(null, Array.isArray(req.args) ? req.args : []) };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** Direct visits to this (owner) web app only show a pointer to the Entry link. */
function doGet() {
  return HtmlService.createHtmlOutput('<div style="font:16px system-ui;padding:40px;max-width:520px">' +
    '<h1 style="font-size:36px;letter-spacing:-1px">MAARAA Bills server.</h1>' +
    '<p>This address is used by the system only. Please open the <b>Entry link</b> you were given to record bills.</p></div>')
    .setTitle('MAARAA Bills');
}

function renderEntryPage_() {
  return HtmlService.createTemplateFromFile('Index').evaluate().getContent();
}

/** Returns the verified, lower-case e-mail in a Google identity token, or throws. */
function verifyIdentityToken_(token) {
  if (!token || typeof token !== 'string') throw new Error('SIGN_IN_REQUIRED: Please sign in with your Google account.');
  const cache = CacheService.getScriptCache();
  const key = 'TOK_' + sha256Hex_(Utilities.newBlob(token).getBytes()).slice(0, 40);
  const hit = cache.get(key);
  if (hit) return hit;

  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('SIGN_IN_REQUIRED: Your Google sign-in could not be verified. Please reload the page.');
  const t = JSON.parse(res.getContentText());
  if (['accounts.google.com', 'https://accounts.google.com'].indexOf(t.iss) < 0) throw new Error('SIGN_IN_REQUIRED: Sign-in was not issued by Google.');
  if (String(t.email_verified) !== 'true' || !t.email) throw new Error('SIGN_IN_REQUIRED: Your Google account e-mail is not verified.');
  const exp = Number(t.exp) * 1000;
  if (!(exp > Date.now())) throw new Error('SIGN_IN_REQUIRED: Your sign-in has expired. Please reload the page.');
  const email = String(t.email).toLowerCase();

  // The token must have been issued to OUR Entry-link project. The first time the OWNER opens the
  // Entry link, its project id is recorded; after that, tokens from any other app are refused.
  const props = PropertiesService.getScriptProperties();
  let aud = props.getProperty('GATEWAY_AUDIENCE');
  if (!aud) {
    if (email !== ownerEmail_()) throw new Error('NOT_AUTHORISED: The Entry link has not been activated yet — the owner must open it once first.');
    props.setProperty('GATEWAY_AUDIENCE', t.aud);
    aud = t.aud;
    audit_('ENTRY_LINK_ACTIVATED', '', { audience: t.aud }, email);
  }
  if (t.aud !== aud) throw new Error('NOT_AUTHORISED: This sign-in came from an unrecognised app.');

  cache.put(key, email, Math.max(1, Math.min(300, Math.floor((exp - Date.now()) / 1000) - 5)));
  return email;
}

/** Menu: forget the activated Entry link (use after re-creating the Gateway project). */
function resetEntryLink() {
  const ui = SpreadsheetApp.getUi();
  if (ui.alert('Reset Entry link', 'Forget the current Entry-link project? The owner must then open the new Entry link once to activate it.', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
  PropertiesService.getScriptProperties().deleteProperty('GATEWAY_AUDIENCE');
  audit_('ENTRY_LINK_RESET', '', {});
  ui.alert('Done. Open the new Entry link while signed in as the owner to activate it.');
}
