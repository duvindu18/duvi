# TERB Tracker

A single-page tracker for the SLIA **Trainees' Experience Record Book** (BAE107,
3rd edition, ratified 06.02.2024). It checks your practical training against the
rules in the book, as you enter it:

- **Table 1**: credited weeks toward Graduate membership (52 after Part I) and
  Part III (104 after Part I, 52 of them after Part II). Part-time weeks count at half value.
- **Table 2**: phase minimums (PP, SDP, DDP, CDP, BNP, CAP, PCP) for during Part I,
  post Part I and post Part II, with the hours each phase still needs and whether
  they fit in the weeks you have left.
- Log sheets of at least 120 h and weekly records of at least 30 h.
- §5.2: at least 20 consecutive weeks in one office. §2: the practice category
  must suit your stage, and the mentor needs the required post-charter years.
- §5.4.i: ARB stamp expiry for the mentor and the DOT. §3.6.ix: late submission
  (two months at most, with an excuse letter). §5.4.iv: monthly counselling.
- §6(c): interim reports at 12, 24 and 36 weeks. §6(e): employment summaries. §5.6: overseas weeks.

Pages: overview, log sheets (four-weekly records with weekly detail), the
cumulative summary sheet, overall records 1 and 2, every TERB rule with its
status, your profile, and import/export.

**Import** accepts the TERB_ACTIVITY workbook (sheets named `1-4`, `5-8` …, activity
codes in row 2) and the cumulative summary workbook (`WEEK NOS.` header). When
both give totals for a sheet and they differ, the summary totals are kept and
the sheet is flagged. **Export** writes a JSON backup or an .xlsx that re-imports cleanly.

## Files

- `app.html`: the page body, published as a claude.ai artifact. There, data syncs
  through the artifact's owner-only store.
- `index.html`: the same page wrapped as a standalone document. Open it in any
  browser. Data stays in that browser's localStorage, so export backups.
