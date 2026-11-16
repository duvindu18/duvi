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

The whole system is **one Apps Script project inside the spreadsheet**, published as **one link**.
Staff don't need Google accounts: each person signs in with a **Login** and a **6-digit PIN** that you set.
Follow **`SETUP-STEPS.txt`** (step-by-step, with an *Upgrading* section). In short:

1. Create a Google Sheet ("MAARAA Bills") → **Extensions → Apps Script**. Paste these files:

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
2. Run **`setup`** and approve the permissions (owner only, once). The message at the end shows **your Login and PIN**.
3. Choose **Deploy → New deployment → Web app**, with **Execute as: Me** and **Who has access: Anyone**.
   The web-app URL is the **entry link** for everyone.
4. Add your team in **👥 Users** and give each person their Login + PIN privately.

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

**Summary tab in the app** (Admins only, next to *All bills*): a phone-friendly monthly summary in the app's own
black & white style. It has a month picker with ‹ › arrows; headline figures (total, bills, change against last month,
unpaid, tax, year to date, and budget use for budgeted categories); a 12-month bar chart (hover or tap for the amount,
tap to open that month); spending by category, with a budget tick and an "over budget" warning; totals by payment method
and by person; and the month's bills. Employees never see it, and the server refuses it for them.

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

* **Record a bill:** the entry link (sign in with Login + PIN), or menu → ➕ Record a new bill in the spreadsheet. Attach the image, fill in the details, then **Record bill**.
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

## 4. Who can record bills (users and PINs)

**Current team** (added by setup, alphabetical): Asindu, Asvida, Avera, Bhagya, Binudi, Duvindu, Isirie, Kaushan,
Oshini, Savidya, Senura, Tharangika, Uditha. They start with the **team PIN 2018** (Settings → `DEFAULT_PIN`).
Each person picks their name from the alphabetical list on the sign-in screen, and can change to a private PIN
under their initials → *Change my PIN*. Admins always get their own random PIN, never the team PIN.
Setup adds this list only once; after that the team is managed entirely in 👥 Users, so people you remove
never come back. *Add several people at once* takes a comma-separated list of names.

> While several people share 2018, any of them can pick someone else's name, so "Recorded by" depends on trust.
> Ask everyone to change to a private PIN in the first week. The team PIN then only matters for newcomers.


**You decide who can record bills.** Manage the list in the app (the **👥** button, Admins only)
or in the spreadsheet (menu → **👥 Manage users**):

| Action | How |
|---|---|
| **Add** | Enter a Login (e.g. `kasun`), their name and role, and optionally a PIN → *Add account*. If you leave the PIN empty, a random one is made. The Login + PIN are shown **once**; give them privately. |
| **Edit** | Change the name, role or login. Renaming a login also moves their past bills to it. |
| **New PIN** | Forgotten PIN: makes a new one and signs that person out on every device. |
| **Switch off / on** | Blocks or restores sign-in immediately (signs them out), but keeps them in the list. |
| **Delete** | Removes them and signs them out. Bills they recorded keep their name. |
| **Search** | Filter by name or login. Each person shows their bill count and when they were last seen. |

**Roles**
* **Employee:** records bills and corrects their own (within the edit window), nothing else.
  They see only the entry form, their confirmations and *My bills*.
  The server refuses any other action for them, even if someone tries to call it directly.
* **Admin:** can also manage categories and users. The **Owner** (the Google account that ran setup) is always Admin,
  and can't be switched off, demoted or deleted.

**How sign-in is protected**
* The PIN is never stored as written: only a salted SHA-256 hash, in hidden columns of the Users tab.
* "Keep me signed in" keeps a phone signed in for 180 days. A new PIN, switching someone off, or deleting them
  ends their sign-ins immediately. **Sign out** is in the menu under the initials at the top.
* 5 wrong PINs lock that login for 15 minutes. Many wrong PINs overall pause all sign-ins for 10 minutes.
  Every sign-in and failed attempt is written to the Audit Log.
* Every request from the app is checked on the server (signed in, still active, PIN unchanged), and only listed actions run.
  Maintenance (setup, backups, restore, reports) only runs for an Admin working in the spreadsheet.
* Staff never get the spreadsheet or Drive folders; the script does the work as the owner.
  Receipt files are owned by the owner's account, so staff can't delete them.
* Each bill stores **Recorded By (Login)** and **Recorded By (Name)**, taken from the sign-in, not typed.

> A PIN can be shared or seen, so it proves identity less strongly than a Google account.
> For a small, trusted team this is a good balance. Ask staff never to share their PIN, and use *New PIN* if one leaks.

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
