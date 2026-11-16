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

## 1. Installation (about 15 minutes)

The system has **two parts**:

| Part | Runs as | Who uses it |
|---|---|---|
| **Main Bill Manager** script, inside the spreadsheet | **You (the owner)** | Only you, and any Admins you add. It holds all data, receipts and backups. |
| **Entry link**, a tiny separate script (`gateway/`) | **The signed-in person** | Employees. It only asks Google to confirm who they are, then passes the bill to the main script. |

Employees **never get access to the spreadsheet, Drive folders, reports or other people's bills**.
They can only open the Entry link, sign in with Google and record a bill.

### A. Main Bill Manager (inside the spreadsheet)
1. Create a Google Sheet, e.g. **"MAARAA Bills"**, then open **Extensions → Apps Script**.
2. Create these files and paste in the contents from this folder:

   | Apps Script file | Type | From |
   |---|---|---|
   | `Code` | Script | `Code.gs` |
   | `Api` | Script | `Api.gs` |
   | `Users` | Script | `Users.gs` |
   | `Backup` | Script | `Backup.gs` |
   | `Integrity` | Script | `Integrity.gs` |
   | `Reports` | Script | `Reports.gs` |
   | `Index` | HTML | `Index.html` |
   | `Styles` | HTML | `Styles.html` |
   | `Common` | HTML | `Common.html` |
   | `CategoryManager` | HTML | `CategoryManager.html` |
   | `UserManager` | HTML | `UserManager.html` |
   | `Sidebar` | HTML | `Sidebar.html` |

   Turn on **Project Settings → Show "appsscript.json"** and paste `appsscript.json`.
3. Select **`setup`** and press **Run**. Approve the permissions. You are added as the Owner (Admin).
4. Choose **Deploy → New deployment → Web app**, with:
   * **Execute as: Me**
   * **Who has access: Anyone**

   Copy the web-app URL (ends in `/exec`). This is the **server URL**. Don't give it to staff; on its own it only shows a notice.

### B. Entry link (the link employees use)
1. Go to <https://script.google.com> → **New project**, and name it **"MAARAA Bills Entry"**.
2. Replace the code with `gateway/Gateway.gs`. Paste the server URL from A-4 into `BACKEND_URL`.
3. Turn on **Project Settings → Show "appsscript.json"** and paste `gateway/appsscript.json`.
4. Choose **Deploy → New deployment → Web app**, with:
   * **Execute as: User accessing the web app**
   * **Who has access: Anyone with Google account**

   Copy this URL. **This is the Entry link.**
5. **Open the Entry link yourself, signed in as the owner.** This activates it. From then on the server only
   accepts sign-ins that come through *this* Entry link.
6. Add employees (section 4). Then send them the Entry link. On a phone, use **Add to Home screen**.
   The first time, Google asks each person to allow only *"See your email address"* and
   *"Connect to an external service"*. The link can't see their Drive, Gmail or anything else.

> If you ever re-create the Entry-link project, use menu → **Reset Entry link…** and open the new link once as the owner.
> Re-running `setup` (menu → ⚙️ Setup / repair) is always safe.

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

**Reports** (drawn by the script in a black & white, A4 print-ready layout with borders and wrapped text)
* **Monthly Summary:** pick the **Month** and **Year** from the dropdowns at the top and the page redraws. It shows:
  * total, number of bills, tax, unpaid, change against the previous month, and year to date;
  * expenses by category (grouped), with budget, actual and variance;
  * totals by payment method and by person;
  * a register of every bill in the month, with a signature line.
* **Annual Summary:** pick the **Year**. It shows every category for Jan–Dec, with shaded group subtotals,
  a TOTAL row, and each category's share of the year. This replaces your old `Total` tab.
* **🖨 Save as PDF:** the menu creates an A4 PDF (portrait for monthly, landscape for annual) in *Drive → MAARAA Bill Manager → Reports*.
* The summaries refresh by themselves every 5 minutes, when the sheet is opened, and when a dropdown changes.
  Voided bills are always excluded.

**Correcting entries**
* **Admin, in the sheet:** the white-header columns of `Bills` can be edited directly and have dropdowns or checks.
  The grey-header (system) columns are locked. Total, Period and Category Code are recalculated, and
  *Last Edited By / At* plus the Audit Log record who changed what.
* **Employees, in the app:** **My bills → Edit** lets them correct their own bills or add a missing page,
  within `EDIT_WINDOW_DAYS` (30 by default). Admins see **All bills** and can edit any active bill.
  The reference number never changes.

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

## 4. Who can record bills (users)

**You decide which Google accounts can record bills.** Manage them in the spreadsheet
(menu → **👥 Manage users**) or in the app (the **👥** button, shown to Admins only):

| Action | How |
|---|---|
| **Add** | Enter the Google e-mail, their name and the role → *Add account*. It works at once; no sharing needed. |
| **Edit** | *Edit* → change the name, role or e-mail (e.g. to fix a typo) → *Save changes*. |
| **Switch off / on** | Blocks or restores sign-in immediately, but keeps them in the list. Use this for leave or a temporary stop. |
| **Delete** | Removes the account from the list. Bills they recorded keep their name and e-mail. |
| **Search** | Filter by name or e-mail. Each person shows their bill count and when they last signed in. |

**Roles**
* **Employee: records bills, nothing else.** They see only the entry form and the confirmation of what they just recorded.
  The server refuses any other action for them, even if someone tries to call it directly.
* **Admin:** can also manage categories and users. The **Owner** (the account that ran setup) is always Admin,
  and can't be switched off, demoted or deleted. You also can't remove your own Admin access by mistake.

**How identity is guaranteed**
* Google sign-in is compulsory, and every request carries a Google-signed identity token.
* The server checks that token with Google every time. It must be issued by Google, for a verified e-mail,
  not expired, and *for our Entry link*. Then the e-mail is looked up in the Users list.
  Tokens from any other app, or accounts that are switched off or not listed, are refused.
* Each bill stores **Recorded By (Google Account)** and **Recorded By (Name)**. Nobody can type in someone else's name.
* The Audit Log records every bill, void, category change and user change with the account that made it.
* Receipt files are created by the owner's account, so employees can't delete or change them later.

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
