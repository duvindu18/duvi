# MAARAA Bill Manager (Google Apps Script)

A receipt-first expense register built on Google Sheets + Google Drive.

* **Entry screen only.** It shows the bill-entry form, and after each successful save it shows the
  record that was saved. It works on phone and desktop. You can take a photo, choose files, drag & drop, or **paste a screenshot**.
* **Automatic reference numbers:** `BILL-YYYYMM-NNNN` (e.g. `BILL-202611-0007`). Numbers run
  per month and never have gaps: voided bills keep their number.
* **Automatic file renaming & filing** in Drive:
  `MAARAA Bill Manager/Receipts/2026/11 - November/BILL-202611-0007_Printing_2026-11-16_Lanka-Prints.jpg`
  (multi-page bills get `_01`, `_02`, …). Large photos are reduced to 2000 px JPEG before upload.
* **All data in one Google Sheet**, with automatic monthly and annual reports.
* **Categories can be added, renamed, archived and deleted**, from the app or the sheet sidebar.
* **Four backup layers**, so an accident never loses data (see below).

---

## 1. Installation (10 minutes)

1. Create a new Google Sheet, e.g. **"MAARAA Bills"**.
2. **Extensions → Apps Script.** Delete the sample code, then create these files with the same names and
   paste in the contents from this folder:

   | Apps Script file | Type | From |
   |---|---|---|
   | `Code` | Script | `Code.gs` |
   | `Backup` | Script | `Backup.gs` |
   | `Integrity` | Script | `Integrity.gs` |
   | `Users` | Script | `Users.gs` |
   | `Index` | HTML | `Index.html` |
   | `Styles` | HTML | `Styles.html` |
   | `Common` | HTML | `Common.html` |
   | `CategoryManager` | HTML | `CategoryManager.html` |
   | `Sidebar` | HTML | `Sidebar.html` |

   Optional: **Project Settings → Show "appsscript.json"** and paste `appsscript.json`. It sets the time zone to
   Asia/Colombo and lists the permissions the script needs.
3. In the editor, select the function **`setup`** and press **Run**. Approve the permissions (Sheets, Drive,
   triggers, e-mail for backup alerts). Setup creates:
   * the tabs `Bills`, `Monthly Summary`, `Annual Summary`, `Categories`, `Payment Methods`, `Audit Log`, `Settings`
   * the Drive folder **MAARAA Bill Manager** with `Receipts/` and `_Backups/`
   * a separate spreadsheet **"MAARAA Bills — Backup Journal"**
   * a nightly backup at about 2 AM, plus the audit triggers
4. Reload the spreadsheet. A **🧾 Bill Manager** menu appears. You can already record bills from it.
5. **Deploy the web app.** Choose **Deploy → New deployment → type "Web app"** with these settings:
   * **Execute as: User accessing the web app**
   * **Who has access: Anyone with Google account**

   These two settings are what *force a Google sign-in* and let the system read each person's real account.
   No one is let in unless an Admin approved their account (step 6).
   Open the URL on your phone and choose **Add to Home screen**. Menu → **🔗 Show web app link** shows it again later.
6. **Add your staff.** Use menu → **👥 Users & access → Add user…**, then enter their Google e-mail, their name, and Admin or Staff.
   This adds them to the `Users` tab and shares the spreadsheet and the receipts folder with them.
   The first time each person opens the link, Google asks them to sign in and approve the app once.

> Re-running `setup` (menu → ⚙️ Setup / repair) is safe. It only adds what is missing and never deletes data.

---

## 2. Improved sheet design (accountant's notes)

Your original sheet had `NO, DATE, CATEGORY, DESCRIPTION, PAYMENT METHOD, AMOUNT, REMARKS, REFERENCE`.
The "Expenses Example" workbook also kept one tab per month (`April_25`), plus `Total` and `Expense Categories` tabs.
The new design keeps that information but follows standard bookkeeping practice.

**One ledger, not one tab per month.** All bills go into the single `Bills` tab. The month is a column
(`Period`). The monthly and annual reports are formulas, so nothing is copied between tabs and totals can't drift apart.

| Column | Why it is there |
|---|---|
| **Ref No** | Unique voucher number (replaces `NO`/`Item No`). It is printed into the file name, so the paper/photo and the row always match. |
| Bill Date / **Period** | Date on the bill; Period (month) drives the reports. |
| **Company / Person (Payee)** | Who was paid. Needed for supplier analysis and duplicate detection. |
| **Vendor Invoice / Receipt No** | The supplier's own number. Strongest duplicate check, and needed for audit. |
| Category Code + Expense Category | The code is permanent; the name can be renamed safely. |
| Description, **Project / Client** | Lets you see costs per job (e.g. "Mr. Edward Samarasekara – council drawings"). Useful for re-billing clients. |
| Payment Method, **Payment Ref** | Cheque / bank transfer numbers, needed for bank reconciliation. |
| **Amount excl. Tax, Tax/VAT, Total** | Stored as real numbers in LKR format, not text like "Rs.2800.00", so they can be added up. Tax is kept separately for VAT/tax claims. |
| **Payment Status, Due Date** | Tracks unpaid bills (payables). Unpaid rows are highlighted amber. |
| Remarks | Free notes. |
| **Receipt** | A clickable "📎 View receipt" link (replaces the `N:\MAARAA\BILLS\…` network path, which only worked on the office PC). |
| Attachment names / links / IDs / fingerprints | Full trace to every file. A SHA-256 fingerprint blocks the same photo from being recorded twice. |
| **Record Status, Void Reason** | Bills are never deleted, only *voided* with a reason. The numbering stays complete for audit. |
| Recorded By / At | Who entered it and when (internal control). |

**Controls built in**
* *No receipt, no entry:* an attachment is required (setting `REQUIRE_ATTACHMENT`).
* Future dates, zero or negative amounts, and unknown categories are rejected.
* Duplicate warning if the same image, the same payee + invoice number, or the same payee + date + total is already recorded.
* Text starting with `=`, `+`, `-` or `@` is neutralised, so pasted text can't become a formula.
* Two people saving at once can't get the same reference number (script lock).
* If anything fails half-way, uploaded files are moved to Trash and no row is written.

**Default categories** are your 18 existing categories (spelling corrected: *Stationery, Electricity Bills,
Membership and Award Fees, Maintenance, Office Refreshments & Consumables, Staff Welfare …*), grouped for reporting.
A few common extras were added: *Rent, Software & Subscriptions, Council & Approval Fees, Bank Charges,
Taxes & Licences, Equipment & Furniture (Capital)*.
Capital items such as equipment are kept apart from running expenses because they are depreciated, not expensed.
You can rename or remove any of them.

**Reports**
* **Monthly Summary**: type a month in B3 (e.g. `2026-11`). It shows the month total, tax, number of bills,
  unpaid amount, year-to-date total, and *budget vs actual* per category. Over-budget categories are shown in red.
  Enter budgets in the category manager.
* **Annual Summary**: type a year in B3. It shows a category × month (Jan–Dec) grid with month totals and the
  **Total Annual Expenses**. This replaces your old `Total` tab.
* Voided bills are excluded everywhere.

---

## 3. Everyday use

* **Record a bill:** web app, or menu → ➕ Record a new bill. Attach the image, fill in the details, then **Record bill**.
  The confirmation screen shows the reference number, all details and links to the renamed files.
* **Categories:** the 🏷️ button in the app, or menu → 🏷️ Manage categories.
  * *Add*: new code `CAT-0NN`.
  * *Edit / rename*: every existing bill in that category is updated to the new name.
  * *Delete*: unused categories are deleted. Categories that already have bills are **archived** instead
    (hidden from the form, history kept) and can be restored any time.
* **Mistake on a bill?** Select its row → menu → 🚫 Void selected bill… (a reason is required), then record it again.
  Small corrections can also be typed into the sheet. Every manual edit is logged in `Audit Log` and copied to the backup journal.
* **Payment methods** are edited directly in the `Payment Methods` tab (untick *Active* to hide one).
* **Settings** (prefix, currency, file limits, backup retention, alert e-mail) are in the `Settings` tab.

---

## 4. Sign-in and who-entered-what

* **Google sign-in is compulsory.** The web app cannot be opened without signing in to a Google account.
* **Only approved accounts get in.** Accounts that are not Active in the `Users` tab see an *Access needed*
  screen with the account they are signed in as and a *Use another account* button. Nothing is recorded.
* **Identity comes from Google, not from the form.** Each bill stores **Recorded By (Google Account)**
  and **Recorded By (Name)**. The name is taken from the Users tab, and nobody can type in someone else's name.
  The confirmation screen shows "Recorded by Kasun Perera · kasun@gmail.com".
* **Roles.** *Staff* can record bills. *Admin* can also manage categories, void bills and add or remove users.
  The owner (the account that ran setup) is always Admin.
* **Audit trail.** Every save, void, category change, user change and manual sheet edit is written to the
  `Audit Log` with the Google account that did it. The nightly integrity check flags any bill without an account.
* **Removing someone** (👥 Users & access → Remove a user's access…) takes away their sign-in and sharing.
  The bills they already recorded keep their name.

> Note: because the app runs as the signed-in person, receipt files they upload are owned by their account
> (inside your shared folder). The nightly integrity check reports any receipt that is later deleted or moved,
> and Drive Trash keeps it for 30 days.

---

## 5. Speed and 100 % precise tracking

**Quick and smooth**
* Photos are compressed and fingerprinted **the moment they are attached**, so pressing *Record bill* only uploads.
  A 6 MB phone photo goes up as roughly 400 KB.
* A duplicate receipt is flagged on the thumbnail immediately ("⚠ Already recorded as BILL-…"), before any typing.
* Payee and project names auto-complete from earlier bills, and the last payment method used is remembered.
* **Ctrl + Enter** records the bill. On the confirmation screen, *Record another bill* opens a fresh form at once.

**Precise**
| Safeguard | What it prevents |
|---|---|
| Each submission carries a unique ID; the server records it once | Double taps, or a retry after a dropped connection, can never create two bills. Pressing *Record bill* again after an error is always safe. |
| All-or-nothing save | If any step fails, the uploaded files are trashed and the row is removed. You get a clear "NOT recorded" message, never a half-saved bill. |
| Read-back verification | After saving, the row is read back from the sheet (ref, date, amount, tax, total, category, payee, status) and every file is reopened in Drive and its size and name checked. The screen shows "✓ Verified" only after this passes. |
| Exact money | Amounts are limited to 2 decimals and totals are calculated in whole cents, so there are no rounding drifts. |
| Self-correcting sheet edits | If someone edits Amount, Tax or Total by hand, Total is recalculated. Changing Bill Date updates Period. Changing Category updates the code. Every edit is logged. |
| **Integrity check** (menu → ✅ Run integrity check, and automatically every night) | Checks for: duplicate or missing reference numbers (a gap means a deleted row); Total ≠ Amount + Tax; Period/date mismatches; unknown categories; voids without a reason; missing, trashed or renamed receipt files; any bill in the backup journal that has disappeared from the ledger; and whether the Monthly Summary total equals the ledger total. Results go to the *Integrity Check* tab, and errors are e-mailed to `ALERT_EMAIL`. |

**Recommended routine (5 minutes a month):** at month-end, run the integrity check, set Monthly Summary B3 to the
month, and compare the "Cash"/"Bank Transfer" totals with your petty-cash book and bank statement.

---

## 6. Backup & recovery

| Layer | What | Where |
|---|---|---|
| 1. Live journal | Every create / edit / void / category change, saved as a full copy of the row, **at the moment it happens** | Separate spreadsheet *"Bills — Backup Journal"* in `_Backups` |
| 2. Nightly snapshot | Complete copy of the whole spreadsheet, about 2 AM daily (60 days kept, 7 newest always kept) | `_Backups/Snapshots` |
| 3. Nightly CSV | Bills + Categories as plain CSV that opens in Excel (2 years kept) | `_Backups/CSV` |
| 4. Nothing hard-deleted | Void instead of delete; archive instead of delete; old backups go to Drive Trash (recoverable 30 days); every tab warns before manual edits; Google Sheets *version history* still works | n/a |

**Restore** (menu → 🛟 Backup & restore). Restores never overwrite your live data. They create a new tab for you to review:
* *Restore Bills from latest snapshot*: copies last night's `Bills` tab into a new tab.
* *Rebuild Bills from live journal*: rebuilds every bill up to the last saved change.
  Use this if rows were deleted or the file was damaged today.
* *Back up now*: take a snapshot immediately (for example, before a big clean-up).

Tips: set `ALERT_EMAIL` in Settings to be e-mailed if a nightly backup fails. For off-site safety, share or copy the
`_Backups` folder to a second Google account, or sync it to the office NAS (`\\192.168.1.200`) with Google Drive for Desktop.

---

## 7. Moving your existing entries

Copy your old rows into `Bills` under the matching headers. Give each one a reference number in the same format
(e.g. `BILL-202607-0001`), set `Record Status` = `ACTIVE`, and set `Period` = the first day of the bill's month.
New bills continue numbering after the highest existing number for that month.
