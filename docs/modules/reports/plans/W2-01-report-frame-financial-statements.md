# W2-01 The report frame and the financial statements: trial balance, profit and loss, balance sheet, cash book, day book, expenses

| | |
|---|---|
| **Issue** | To be opened when the plan is accepted |
| **Module** | reports (back-office screens and API, read only), with accounting (ACC-07) and platform (`/auth/me` gains the shop's name) |
| **Status** | Proposed (2026-11-18) |
| **Refs** | ACC-07, RPT-11; ACC-01, ACC-06 (fiscal year, lock date); posting rules §2 (system roles); CLAUDE.md rules 1, 4, 5, 10; D-100 (no legacy bills), D-101 (pilot wipe), D-110 (reports read the ledgers), D-114 (the back-office frame), D-116 (reports before go-live, owner answers 1–6) |
| **Depends on** | W1-08 (journals), W1-19 (account balances and ledger, periods, the document screen), W1-20 (report API helpers, CSV), W1-28 (the menu and the screen search) |
| **Size** | about 4 days: domain golden files ¾; API with integration tests 1; the frame 1; the six screens and the ledger on the frame ¾; e2e and docs ½ |
| **Test-first** | Yes: the statements' arithmetic and the period presets (golden, `packages/domain`); every report under RLS and its permission on a shop with a known month of documents (integration); trial balance → ledger → document, and print (e2e) |

## Goal

**The owner and the accountant see, for any period, whether the books balance, what the shop earned and spent, what it owns and owes on any date, and where the cash and bank money went. Every figure opens the lines behind it. The same frame then carries every later report (W2-02 to W2-04).**

- **The report frame:** filters with date presets, key figures on top, a sortable and searchable list with group subtotals, drill-down, Download CSV and a print layout. Every report from here on uses it.
- **Trial balance (ACC-07):** each account's opening, movement and closing, debit and credit, with group subtotals; debits always equal credits.
- **Profit and loss (ACC-07):** revenue, cost of goods sold, gross profit, expenses by group and net profit, for a period, compared with another period or month by month.
- **Balance sheet (ACC-07):** assets, liabilities and equity on a date, with this year's profit, compared with another date.
- **Cash book (ACC-07):** each cash and bank account by day (opening, in, out, closing) and the documents behind it.
- **Day book and expenses (RPT-11):** every voucher posted in a range with its lines; expense accounts month by month.
- **The account ledger (W1-19)** moves onto the frame, with CSV and print.

## Owner answers already given (D-116, 2026-11-18)

Four tasks, with this one first (1). Everything by go-live (2). 2026 history stays in the legacy app, read-only (3). Lists of lines up to 92 days, summaries up to a year with a comparison, statements as on any date (4). CSV and a print layout, PDFs from the browser (5). Financial reports for the owner and the accountant (`reports.financial`), as today (6). Modern design; the legacy samples give meaning only.

## Questions for the owner (each with a recommendation)

1. **Where do the reports live in the menu?**
   *Recommended:* a **Reports home**. The menu's *Reports* row opens one page that lists every report the person may open, in sections (Accounts, Stock, Sales and purchases, Customers and suppliers, Cash, Support). Each report has a one-line description, and a search box filters the list.
   - The top bar's screen search (Ctrl K) still finds each report by name.
   - With ~30 reports by go-live, the side menu would otherwise need a long list or sub-groups.
   - The eight built reports appear there too, unchanged.
2. **The profit and loss shape.**
   *Recommended:* the modern multi-step layout:
   - **Revenue:** sales less returns and discounts, plus rounding.
   - **Cost of goods sold**, then **gross profit and its margin**.
   - **Expenses** by group (salaries, utilities, general…), then **net profit and its margin**.
   - Under cost of goods sold, a small **"stock and purchases"** panel (opening stock + purchases − purchase returns ± adjustments − closing stock = stock used). It looks familiar from the legacy income statement, and it must equal the cost of goods sold; any difference is shown as its own named line, never hidden.
3. **Comparisons.**
   *Recommended:*
   - **Profit and loss** opens on *this month* compared with the **previous period**, with the change in rupees and %. Other choices: *same period last year*, *none*, and **month by month** (one column per month, up to 12, for a range of up to a year).
   - **Balance sheet** opens on *today*, compared with the **end of last month**; any other date can be picked.
4. **Trial balance: what shows by default?**
   *Recommended:*
   - **Every postable account, with group subtotals** from the chart's tree; a switch shows **groups only**.
   - **Accounts with no opening and no movement are hidden**, with a switch to show them.
   - It opens on *this month*: opening at the start, movement in the month, closing at the end, each split into debit and credit.
5. **Cash book: one account or all?**
   *Recommended:* **all cash and bank accounts on one screen**, one section each, each day showing opening, money in, money out and closing; a filter narrows it to one account.
   - The accounts are the cash drawer, cash in transit, the safe, and every bank and wallet account set up in *Money*.
   - A transfer between two of them shows in both, marked as a transfer.
6. **Remembering filters.**
   *Recommended:*
   - The filters live **in the screen's address**, so a link can be shared and *Back* returns to the last filters.
   - Each report also **remembers the last filters used**, in that browser.
   - No saved named views for now (they can come later if wanted).
7. **A cash flow statement too?**
   *Recommended:* **yes, as the last item of W2-04.**
   - It shows money in and out of cash and bank by what it was for (sales, customer receipts, supplier payments, expenses, drawings), with transfers between your own accounts left out.
   - The cash book already shows every movement, so the statement is a summary of it and can wait for the last task.

## Design

| Decision | Why |
|---|---|
| **Read only, computed on request** from `journal_entries`, `journal_lines` and `accounts`, inside `withTenant` under the app role. No report tables, no migration | Rule 4 and D-110: the ledgers are the truth; Delux's volume (a few hundred bills a day) needs no summaries |
| **One SQL shape for every statement:** per account, the sum of debits and credits *before* a date and *between* two dates (one query per period; a comparison or month-by-month is one more period each). The arithmetic is pure functions in `packages/domain` (`statements.ts`): `trialBalance`, `profitAndLoss`, `balanceSheet`, `stockAndPurchases`, `periodPresets`, golden-tested and used by the API and its CSV | Rule 1; one place for the sign rules, group subtotals and period edges, as `registerTotals` and `ageBalances` did (D-110) |
| **Sections come from the chart's tree, not from codes:** each top-level group's type gives its place. For the profit and loss: income groups are revenue, the expense group that holds the `COGS` account is cost of sales, other expense groups are expenses. For the balance sheet: asset, liability and equity groups. Contra accounts (`SALES_RETURNS`, `SALES_DISCOUNT`) are shown as negatives inside revenue | Works for Delux's chart (4000 / 5000 / 6000) and for any accounts the accountant adds (W1-19), with no code change |
| **This year's profit on the balance sheet** is income − expenses from the start of the fiscal year (`tenants.fiscal_year_start_month`) to the date, shown in equity as *Profit for the year*; profit of earlier fiscal years not yet closed is added to *Retained earnings*. No closing entry is posted | Assets = liabilities + equity on any date; the first year end is Dec 2027 and W1-19 left the closing entry out |
| **Stock and purchases panel:** read from the `INVENTORY` account's lines by their source (opening balances, goods receipts, purchase returns, sales and returns at cost, adjustments, counts); stock used = opening + in − closing, checked against the cost-of-sales group | The familiar view of the legacy income statement, made from the same books, so it can't disagree |
| **Cash book accounts:** the accounts with role `CASH_DRAWER`, `CASH_IN_TRANSIT`, `CASH_SAFE`, and every account linked to a bank or wallet (`bank_accounts.gl_account_id`). Each line's description and document come from its journal entry (the same as the account ledger) | One definition of "cash and bank" shared with the *Money* screen |
| **Day book:** every journal entry in the range, in posting order, with its lines, filtered by document type; reversals marked. **Expenses:** each expense account (and group subtotal) per month, up to 12 months | RPT-11; the accountant checks a day's or a month's postings in one place |
| **Drill-down everywhere:** an account's amount opens its ledger for the same period; a ledger or day book line opens its document (the existing document screen, a bill's trace, a goods receipt, a voucher). The link carries the period | Modern reports; no second report needed to find the lines behind a total |
| **Date rules** (D-116 answer 4) in `periodPresets`: presets *today, yesterday, this week, this month, last month, this quarter, last quarter, this fiscal year, last fiscal year, custom*; ranges up to 92 days for the day book and ledgers and up to 366 days for the trial balance, profit and loss and expenses; *as on* any date for the balance sheet. A longer range is refused by the API (`range_too_long`) and the screen explains why | One rule for all reports, fiscal-year aware (a year starting in July works) |
| **Permissions:** every report here needs `reports.financial` (owner, accountant), as the account ledger (W1-19). Salaries are expense accounts, so nobody else sees them | D-116 answer 6, D-110 |
| **The frame** (`apps/backoffice/src/reports/frame/`): `ReportPage` (title, filters, key figures, actions), `PeriodFilter` and `AsOnFilter` (presets, then dates), `AccountPicker` (search by code or name), `ReportTable` (sortable columns, a search box, group rows with subtotals, sticky header, right-aligned money with CSS logical properties, drill-down per row), Download CSV, Print. Filters in the address and remembered per report in the browser (question 6). Every string an i18n key (rule 10); money in the tenant's locale | Built once, used by every report of W2-02 to W2-04 and by the built ones when they move (W2-04) |
| **Print layout:** a print stylesheet hides the menu and filters and prints a header (shop name, report title, period and filters, printed by and when) and the table with its group rows kept together; long tables repeat their column headers on each page. Page numbers where the browser prints them. Always light (PLT-13) | D-116 answer 5: the browser's *Save as PDF* gives the PDF |
| **The shop's name** for the print header comes from `/auth/me`, which gains `shopName` | The frame had no source for it (D-114's trade-off); the theme switcher can use it later |
| **Until go-live** the statements show the pilot's postings; the pilot wipe (D-101) clears them with the documents | Nothing new to wipe |

## Scope

- **In:**
  - **Domain:** `statements.ts` (`trialBalance`, `profitAndLoss`, `balanceSheet`, `stockAndPurchases`, `periodPresets`), with golden files.
  - **API** (`apps/api/src/reports/financial.ts`), each with `format=csv`, `reports.financial` and the date rules:
    - `GET /api/reports/trial-balance` (`from`, `to`, `level=accounts|groups`, `empty=show|hide`);
    - `GET /api/reports/profit-loss` (`from`, `to`, `compare=previous|last-year|none|months`);
    - `GET /api/reports/balance-sheet` (`at`, `compareAt`);
    - `GET /api/reports/cash-book` (`from`, `to`, `accountId` optional);
    - `GET /api/reports/day-book` (`from`, `to`, `type` optional);
    - `GET /api/reports/expenses` (`from`, `to`);
    - the account ledger (`/api/accounting/accounts/:id/ledger`) gains `format=csv`;
    - `/auth/me` gains `shopName`.
  - **Contracts:** the view types in `report-views.ts`.
  - **Back office:**
    - the frame, with its tests;
    - the Reports home (question 1);
    - the six screens;
    - the account ledger on the frame;
    - drill-down links to the existing document screens;
    - the print stylesheet;
    - the i18n keys.
  - **Docs:** the reports and accounting READMEs (done with D-116), this plan's results, the glossary (*day book*, *cash book*, *trial balance*, *profit for the year*).
- **Out:**
  - a year-end closing entry (first year end Dec 2027);
  - budgets and budget vs actual;
  - multi-branch consolidation (one branch);
  - charts (W2-03's sales over time adds the first);
  - the cash flow statement (question 7, W2-04);
  - saved named views;
  - server-made PDF and Excel files (D-116 answer 5);
  - scheduled or emailed reports;
  - moving the built reports onto the frame (W2-04).

## Tests written first

- **Domain (golden):**
  - **Trial balance:** a small chart with a group three levels deep, an opening balance, a month of movements and a reversal. Opening, movement and closing on each side; group subtotals; debits = credits at every level; *groups only*; accounts with nothing hidden.
  - **Profit and loss:** revenue net of returns, discounts and rounding; cost of sales found by the `COGS` role; gross and net profit with their margins (a zero-revenue period gives no margin, not a division by zero). Comparison with the previous period and the same period last year; month by month over 12 months; a month with no postings.
  - **Balance sheet:** assets = liabilities + equity on a date with a profit and on one with a loss; the profit for the year from a fiscal year starting in January and one starting in July; earlier years' profit in retained earnings; a date before the first posting.
  - **Stock and purchases:** opening + purchases − returns ± adjustments − closing = stock used = cost of sales; a difference shown as its own line.
  - **Period presets:** each preset on 1 Jan, 31 Mar, 29 Feb 2028 and a Sunday, with fiscal years starting in January and July; 92 and 366 days accepted, one more refused.
- **API (integration, under RLS):** a shop seeded with opening balances (W1-14), a month of sales with a return and a void, a goods receipt and a purchase return, an expense, a customer receipt, a supplier payment, a journal voucher and its reversal, a stock adjustment. Checks:
  - the trial balance balances and its closing equals W1-19's account balances;
  - net profit equals the balance sheet's profit for the year;
  - the balance sheet balances;
  - Inventory equals the stock valuation total (W1-20), and AR and AP equal the ageing totals;
  - each cash book account's closing equals its balance;
  - the day book lists every journal entry once;
  - another tenant's postings never appear;
  - a manager (no `reports.financial`) is refused;
  - a range over the limit gets `range_too_long`;
  - the CSV has the same rows and totals;
  - a year of generated postings answers the trial balance and the profit and loss in under 2 s.
- **Back office (component):**
  - presets give the right dates and address;
  - sorting and search;
  - group subtotals;
  - drill-down links carry the period;
  - the print header shows the shop and the filters;
  - every string is translated.
- **e2e:**
  - after a sale on the counter and an expense, the trial balance balances; a click on Sales opens its ledger, and a line opens the bill;
  - the profit and loss month by month;
  - the balance sheet balances;
  - Download CSV;
  - in print media the menu and filters are hidden and the header shows.

## Verify

- `pnpm check`, `pnpm test:integration`, `pnpm e2e`.
- On a copy of `erp_dev` with the opening balances posted: the trial balance balances, and its totals match the opening reconciliation report (W1-14).
- On staging with the pilot's postings:
  - the trial balance balances;
  - the month's net profit equals the balance sheet's profit for the year;
  - the cash drawer's cash book closing equals the desk's count;
  - Inventory equals the stock report's value, and AR and AP equal the ageing totals;
  - each report prints on A4 and downloads as CSV.

## Order

1. Domain golden files, then `statements.ts`.
2. The API, one report at a time, with integration tests; `/auth/me` gains `shopName`.
3. The frame and its tests.
4. The Reports home, the six screens, the ledger on the frame.
5. Print stylesheet.
6. e2e.
7. Docs: this plan's results, glossary, task list.

## Risks

| Risk | Mitigation |
|---|---|
| A statement that disagrees with the ledger or the other reports | Made from the same journal lines by one function per statement; the integration test ties the trial balance to W1-19's balances, profit to the balance sheet, Inventory to the stock report and AR/AP to the ageing |
| An account the accountant adds lands in the wrong section | Sections follow the chart's tree and types (Design); the golden files include an added group, and the chart's own checks (W1-19) keep types consistent with parents |
| Slow on a year of postings | One aggregate query per period on indexed `journal_entries.entry_date`; a year of generated postings is timed in the integration test; the 366-day cap |
| Salaries seen by someone who shouldn't | Every report here needs `reports.financial`, checked by the API, as the ledger |
| A frame that suits these reports but not stock or sales | Built with the W2-02 and W2-03 reports in mind (item and party pickers come there, as the account picker here); the table takes any columns and grouping |
| Print differs between browsers | Tested in Edge (the shop's browser) and Chromium (CI); the CSV is the exact copy |
| The plan's 4 days run long and squeeze W2-02 to W2-04 | The order above puts the trial balance, profit and loss and balance sheet first; the day book and expenses are last and can follow in W2-04 |
