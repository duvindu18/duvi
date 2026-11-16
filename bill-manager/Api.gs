/**
 * Entry app API.
 *
 * The whole system is ONE web app, deployed "Execute as: Me" + "Who has access: Anyone".
 * Staff open its link, sign in with their Login + PIN (Users.gs), and the page then sends every
 * request through api(token, action, args):
 *    • the session token is checked (signed in, active, PIN not changed since),
 *    • the action must be on the list below, and Admin-only actions are refused for Employees.
 * The script does the work as the owner, so staff never need access to the spreadsheet or Drive.
 */

function api_() {
  return {
    // action:              [function,            who may call it]
    getFormData:            [getFormData,         'employee'],
    saveBill:               [saveBill,            'employee'],
    checkReceiptHashes:     [checkReceiptHashes,  'employee'],
    listMyBills:            [listMyBills,         'employee'],   // own bills only (Admins: all)
    updateBill:             [updateBill,          'employee'],   // own bills, within the edit window
    changeMyPin:            [changeMyPin,         'employee'],   // replace your own PIN
    getCategories:          [getCategories,       'admin'],
    addCategory:            [addCategory,         'admin'],
    updateCategory:         [updateCategory,      'admin'],
    deleteCategory:         [deleteCategory,      'admin'],
    restoreCategory:        [restoreCategory,     'admin'],
    listUsers:              [listUsers,           'admin'],
    saveUser:               [saveUser,            'admin'],
    deleteUser:             [deleteUser,          'admin'],
    setUserPin:             [setUserPin,          'admin'],
    addUsersBulk:           [addUsersBulk,        'admin'],
  };
}

/**
 * Single entry point used by the page. token = PIN session (entry app) or '' (inside the
 * spreadsheet, where Google identifies the Admin).
 */
function api(token, action, args) {
  const entry = api_()[action];
  if (!entry) throw new Error('Unknown action.');
  CURRENT_USER_ = null;
  if (token) CURRENT_USER_ = userFromSession_(token);
  const u = currentUser_();
  if (entry[1] === 'admin' && u.role !== 'Admin') throw new Error('Only an Admin can do this. Employees can record bills only.');
  return entry[0].apply(null, Array.isArray(args) ? args : []);
}

/** The entry app itself. */
function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle((settings_().COMPANY_NAME || 'MAARAA') + ' Bills')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** The old Google-sign-in Entry link (gateway) is retired. */
function doPost() {
  return ContentService.createTextOutput(JSON.stringify({ ok: false,
    error: 'This entry link has been replaced. Please use the new MAARAA Bills link from your admin.' }))
    .setMimeType(ContentService.MimeType.JSON);
}
