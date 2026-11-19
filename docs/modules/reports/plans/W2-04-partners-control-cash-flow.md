# W2-04 Customers, suppliers and control: partner ledger and statement, balance trend, overdue and over-limit, collections and payments, user activity, cash flow

| | |
|---|---|
| **Issue** | [#179](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/179) |
| **Module** | reports (back-office screens and API, read only; one index migration) |
| **Status** | Owner answers given (2026-11-19): questions 1–7 as recommended, **question 8 against the recommendation** (the built reports move onto the frame in W2-04 if time allows). Waiting for acceptance |
| **Refs** | RPT-16, RPT-17, ACC-07 (cash flow); CLAUDE.md rules 1, 3, 4, 5, 10; D-085 (no limit = null), D-100 (no legacy bills), D-110 (reports read the ledgers), D-116 (reports before go-live), D-117 (the business date); PLT-08 (the audit log) |
| **Depends on** | W2-01 (the frame, periods, the Reports home, the cash book), W1-20 (ageing and its FIFO rule, `ageBalances`), W1-22 and W1-16 (the customer and supplier screens with their ledgers), W1-11 (counter collections and cash-outs), W1-19 (bank receipts, payments, expenses, transfers, vouchers) |
| **Size** | about 3 days: domain golden files ½; API with integration tests 1; screens and the statement's print 1; e2e and docs ½. **Plus about 1 day if time allows** to move the built reports onto the frame (answer 8) |
| **Test-first** | Yes: the opening line and running balance, the statement's ageing, the trend's dates, overdue by N days, the activity's kinds and changed fields, the cash flow's classes (golden, `packages/domain`); every report under RLS, its permission and its ties to the books (integration); a customer's statement printed, the overdue list, the collections register, user activity, the cash flow (e2e) |

## Goal

**The owner and the accountant can give any customer a statement they can check, see who owes what and for how long, see every rupee collected and paid, see who did what in the system, and see where the cash went, each figure opening the documents behind it, on the W2-01 frame.**

- **Partner ledger and statement (RPT-16):** one customer's or supplier's documents in a range, with the opening balance, a running balance and the closing; a statement to print or save as PDF, one customer at a time or every customer with a balance in one go.
- **Balance trend (RPT-16):** each party's balance today and 15 days, 1, 2, 3 and 6 months ago (the legacy *Business Partner Ageing*).
- **Control (RPT-17):** overdue customers, over-limit customers, the collections and payments register, user activity from the audit log.
- **Cash flow (ACC-07, W2-01 answer 7, last):** money in and out of cash and bank by what it was for, month by month.
- **If time allows (answer 8):** the reports built in W1-11 and W1-20 move onto the frame.

## Owner answers already given (D-116, 2026-11-18)

Four tasks; this is the fourth (1). Everything by go-live, the new analysis last (2): here, *the cash flow statement* (W2-01 answer 7). 2026 stays in the legacy app, read-only; every report starts at 1 Jan 2027 (3). Lists of documents or lines up to 92 days, summaries up to a year, statements "as on" any date (4). CSV and a print layout, PDFs from the browser (5). `reports.view` for these reports, `reports.financial` for the cash flow (6). Modern design; the legacy *Business Partner Ledger*, *Business Partner Activity* and *Business Partner Ageing* give meaning only.

## Owner answers (2026-11-19)

1. **The ledger goes back up to a year**, since it lists one party's documents (as the rates report, W2-03 answer 4). **The printed statement leaves out a voided bill and its void** (always the same day, netting to zero); the ledger on screen shows both, marked.
2. **The full statement:** the shop's header, the customer's name, code, address and phone, the period, the opening, the documents, the closing, and **the closing balance by how overdue it is**; a switch lists each bill's items; **statements for every customer with a balance** print one to a page. The owner sends the PDF (WhatsApp); no email service.
3. **The balance trend uses the legacy points:** as on a date (today by default), 15 days, 1, 2, 3 and 6 months before it; a date before go-live shows *before go-live*.
4. **Overdue = more than N days past due**, N = 30 by default (0, 15, 30, 60 or 90). **Over-limit** lists customers over their limit or within 10% of it.
5. **The register covers both sides:** money received from customers and money paid to suppliers, with a switch.
6. **User activity for the owner only** (`admin.users`), filtered by user and kind, with the fields an edit changed; passwords and PINs never shown, the data import left out.
7. **The cash flow is direct, month by month**, up to a year; transfers between the shop's own accounts are left out.
8. **The built reports move onto the frame in W2-04 if time allows**, after the cash flow, *against the recommendation* (after go-live, as a task of its own). If the days run out, the move follows after go-live; the reports work as they are.

## What the data looks like

- **`erp_dev` has no documents and no ledger entries yet** (no opening has been posted there; sales start at go-live, D-100), so the reports are designed on the documents the counter and the back office write, and timed on a generated year.
- **131 customers have an account, all with credit allowed, none with a limit and none with payment terms** (the import's defaults, W1-09 answer 5). A customer with no terms owes each credit bill on its own day (`sale.ts`: due = entry date + terms, 0 when none), so every unpaid bill is past due the next day: hence answer 4's *more than N days*. The owner sets limits and terms per customer in *Customers* (W1-22) at any time; the reports follow.
- **281 suppliers.** A goods receipt is due on the date the purchaser enters (W1-16); payments, returns and vouchers on their own date.
- **The party sub-ledger** (`party_ledger_entries`): one row per document and party, `amount` > 0 = owed more (a customer owes the shop, or the shop owes a supplier), with its entry date, due date, source type and id; indexed by (tenant, party, role, entry date). Its total per role equals `AR_CONTROL` and `AP_CONTROL` (W1-20). **Customers' sources:** `sale` (the on-account part; a return negative), `sales_void`, `payment` (a counter collection), `customer_receipt` (into a bank), `journal_voucher`, `opening`. **Suppliers':** `goods_receipt`, `purchase_return`, `supplier_payment` (from a bank), `cash_movement` (paid at the desk), `journal_voucher`, `opening`.
- **The customer and supplier screens already show a ledger** (W1-22, W1-16): every entry since the start, with a running balance, no range and no print.
- **The audit log** (`audit_log`, PLT-08): 126,300 rows on `erp_dev`, all from the catalog import (no user). Every audited table writes a row on create, update and delete with the row before and after (passwords and PIN verifiers removed by the trigger), plus named events (sign-ins and failures, lockouts, PIN and password changes, devices enrolled, voids, exceptions reviewed, period locks, posting rebuilds, the pilot wipe). Its only index is by entity, so a range by time reads the whole table: **a new index** (see Design).
- **Cash and bank** are the accounts the cash book uses (W2-01): the drawer, cash in transit, the safe, and every account a bank or wallet is linked to (5 bank accounts on `erp_dev`).

## Questions for the owner (each with a recommendation)

1. **The partner ledger: how far back, and voided bills.**
   *Recommended:* **up to a year**, since it lists one party's documents. A void is always the same day and nets to zero, so **the printed statement leaves out the voided bill and its void**; the ledger on screen shows both, marked.
   *Otherwise:* D-116's 92 days, voids shown everywhere.
2. **The statement: what goes on it.**
   *Recommended:* the shop's header (as on its bills), the customer's name, code, address and phone, the period, the opening, the documents, the closing, and **the closing balance split by how overdue it is** (not yet due, 1–30, 31–60, 61–90, over 90). A switch lists each bill's items. **Statements for everyone with a balance** print one per page at month end. Sent as a PDF by the owner (WhatsApp); no email service (no paid services).
   *Otherwise:* opening, documents and closing only, one at a time.
3. **The balance trend: which dates.**
   *Recommended:* **the legacy points**: as on a date, then 15 days, 1, 2, 3 and 6 months before it, for customers or suppliers, with a chart of the total; a date before go-live shows *before go-live*, not zero.
   *Otherwise:* the last six month-ends.
4. **Overdue and over-limit, while no customer has terms or a limit.**
   *Recommended:* **overdue by more than N days** (default 30; 0, 15, 30, 60, 90): the overdue amount, the oldest unpaid bill's date and age, the last payment, the phone and the limit. **Over-limit:** over the limit or within 10% of it, empty until limits are set.
   *Otherwise:* a shop-wide default for terms, which changes the due dates in the books (posting and ageing).
5. **The collections register: one side or both.**
   *Recommended:* **both**, with a switch: received from customers (counter collections, bank receipts) and paid to suppliers (bank payments, cash paid at the desk); totals by method and by person; up to 92 days. Cash sales stay in the sales register.
   *Otherwise:* customers only.
6. **User activity: who sees it.**
   *Recommended:* **the owner only** (`admin.users`), up to 92 days, by user and kind; an edit shows the fields it changed; passwords and PINs never; the data import left out.
   *Otherwise:* everyone with `reports.view`.
7. **The cash flow: which form.**
   *Recommended:* **direct, month by month**: opening cash and bank; in from sales and from customers; out to suppliers, expenses by category, drawings; other; closing, equal to the cash book. Transfers between the shop's own accounts left out.
   *Otherwise:* the indirect form, from net profit.
8. **The built reports onto the frame.**
   *Recommended:* **after go-live**, as a task of its own: they work and were tested on staging; moving eight screens before go-live adds risk and no figure.
   *Otherwise:* in W2-04 after the cash flow, if time allows. **(Chosen.)**

## Design

| Decision | Why |
|---|---|
| **Read only, computed on request** from `party_ledger_entries`, the documents they point at, `customer_accounts`, `parties`, `journal_entries`, `journal_lines`, `postings`, `accounts`, `bank_accounts`, `audit_log`, `users`, `devices`, inside `withTenant`. No report tables | Rule 4 and D-110: the ledgers are the truth |
| **One migration: an index on `audit_log (tenant_id, at)`** (and `(tenant_id, user_id, at)` if the timing test asks for it). Migrations are added, never changed | User activity reads a range of time; the log only has an index by entity, and it grows with every bill line |
| **The ledger** (one party, one role): the opening = Σ amounts before `from`; each entry in the range by entry date and posting order, with its document number, kind, a short description (the bill's or voucher's memo), due date, **debit and credit** (a customer's bill is a debit, a payment a credit; a supplier's receipt is a credit, a payment a debit, as in the books) and the running balance; the closing. The balance reads *owes you* / *you owe* / *in advance* in words beside the figure | Same sign as `party_ledger_entries`, so the closing equals the party's balance in the books at `to` |
| **Key figures above the ledger:** the opening, the totals by kind of document (bills, returns, payments, vouchers; the legacy *Business Partner Activity*), the closing | The legacy activity report's totals by document type, without a separate report |
| **A void on the statement:** a `sale` entry whose bill has a `sales_void`, and that void, are left out of the printed statement and its CSV (they net to zero on the same day); the ledger on screen shows both with *Voided* | Answer 1; the books are unchanged |
| **The statement** is the ledger's print layout plus: the branch's receipt header (name, address, phone), the customer's name, code, address and phone, *Statement for 1–30 Nov 2027*, and **the closing balance by due date** from W1-20's `ageBalances` as on `to` (one row). **With items:** each bill's lines under it (item code and name, quantity, price, line total). **For every customer:** every customer with a balance at `to` or a document in the range, one per A4 page (CSS page breaks), in name order | Answer 2; one ageing rule for the ageing report and the statement |
| **The balance trend:** the dates are pure (`trendDates(asOf)` in `packages/domain`: 15 days back, then 1, 2, 3, 6 months back, the day clamped to the month's end, so 31 May → 30 Apr, 31 Mar → 28 Feb); one query sums each party's entries up to each date (`sum(amount) FILTER (WHERE entry_date <= $n)`). Rows: parties with any balance at any of the dates; the change from a month ago; a total row equal to the control account at each date; a line chart of the total (W2-03's `TrendChart`). A date before go-live shows *before go-live* | Answer 3 |
| **Overdue:** credits settle the oldest debits first (W1-20's FIFO); a debit's unpaid part is overdue when `asOf − due > N`. Pure (`overdueOf` in `packages/domain`, reusing the allocation `ageBalances` uses). Rows: customer, phone, balance, overdue amount, oldest unpaid bill's date and days, last payment's date and amount, limit, terms. Sorted by overdue amount | Answer 4; agrees with the ageing report's buckets at N = 30, 60 and 90 |
| **Over-limit:** customers with a limit whose balance is over it or within 10% of it (`balance ≥ 0.9 × limit`, integer arithmetic), with the limit, the balance, what is left (negative when over), and the last time the counter's limit was approved past (W1-09's `credit_limit` overrides) | Answer 4; a null limit is no limit (D-085) |
| **The collections and payments register:** **received:** `payments` (counter collections: number, counter, cashier, method) and `customer_receipts` (bank); **paid:** `supplier_payments` (bank), `cash_movements` of kind `supplier_payment` (the desk) and goods receipts paid from a bank at once. Each row: date, number, party, how (cash at counter, the bank account or wallet), who took or paid it, reference, amount. Totals by method and by person. Vouchers stay in the ledger and the day book. Up to 92 days | Answer 5; its total equals the party sub-ledger's entries of those sources in the range, which the integration test checks |
| **User activity:** from `audit_log`, up to 92 days, newest first, rows with a user only (the import has none). **Kinds** (pure, `activityKind(entity, action)`): sign-ins (login, password, PIN, lockouts), sales and voids, approvals (overrides, credit, exceptions), prices and items, customers and suppliers, money (collections, receipts, payments, expenses, transfers, vouchers, cash desk), stock (receipts, returns, adjustments, transfers), users and settings, the books (period locks, rebuilds, the wipe). **Line rows** (`sales_lines` and other lines) **fold into their document's row**, so a bill is one row. An edit lists its changed fields, old → new (`changedFields`, pure, ignoring the version columns); a creation names the document (its number and amount). Each row: when (shop time), who, where (the counter's name, or *back office*), what, the record (linked) | Answer 6; `admin.users` (the owner today). The trigger already removes `password_hash` and `pin_verifier` |
| **Cash flow:** every journal entry in the range that touches cash or bank (the cash book's accounts); its cash change goes to **one class by its source**: `sale` and `sales_void` → *sales, less refunds*; `payment`, `customer_receipt` → *from customers*; `supplier_payment`, `cash_movement` (supplier) and receipts paid at once → *to suppliers*; `expense`, `cash_movement` (expense) and a transfer's charges → *expenses*, by category; `cash_session` variance → *cash short and over*; `journal_voucher` by its other accounts (customers, suppliers, an expense, equity → *owner's capital and drawings*, else *other*); `cash_handover`, deposits, the safe, `fund_transfer`'s amount and `void_cash` → **transfers, left out**; `opening` → part of the opening balance. Pure (`cashFlowClass` in `packages/domain`) | Answer 7; each month: opening + Σ classes = closing = the cash book's closing, checked in the tests |
| **Cash flow by month:** a column per month (the first and last part-months as they fall), a total column; up to a year; compared with nothing (a comparison would double the width; the profit and loss has one) | W2-01's summaries; prints on A4 landscape up to 12 months |
| **Permissions:** ledger, statement, trend, overdue, over-limit and the register need `reports.view`; **the supplier side also needs `cost.view`** (supplier amounts are purchase amounts, as W2-03); the cash flow `reports.financial`; user activity `admin.users`. Cashiers and salesmen see none | D-116 answer 6, answers 6 and 7 |
| **Drill-down:** a ledger line opens its document (W2-01's `documentHref`; a bill opens its trace); a party row in the trend, overdue and over-limit lists opens its ledger for the last 3 months; a register row its document; an activity row its record; a cash flow cell the cash book's lines of that class and month | The frame's rule: every figure opens what is behind it |
| **The customer and supplier screens** link to the ledger and the statement (*Statement…* button) instead of growing their own range and print | One ledger |
| **Moving the built reports (answer 8, if time):** sales register, overrides, voids and returns, stock and value, ageing, exceptions (W1-20), day reconciliation and cash variance (W1-11) move to `ReportPage` with their filters in the address, CSV and print, **with no change to a figure**; their API stays. One report per commit, each with its component test kept green, in that order, so the move stops cleanly wherever the time runs out | Answer 8; the owner tested them on staging, so the figures must not move |

## Scope

- **In:**
  - **Domain:** `partner-reports.ts` (`ledgerLines` with the opening and running balance, `statementAgeing` via `ageBalances`, `trendDates`, `overdueOf`, `nearLimit`, `activityKind`, `changedFields`, `cashFlowClass`, `cashFlowByMonth`), with golden files.
  - **Migration:** the `audit_log` time index in a new file in `packages/db/migrations/` (`schema.ts` mirrors tables and columns, not indexes, so it is unchanged).
  - **API** (`apps/api/src/reports/partners.ts`), each with `format=csv` and the date rules:
    - `GET /api/reports/partner-ledger` (`role`, `partyId`, `from`/`to` or `preset`, up to a year, `voids=hide` for the statement, `items=1`);
    - `GET /api/reports/statements` (customers with a balance or a document in the range, for the batch print);
    - `GET /api/reports/balance-trend` (`role`, `asOf`);
    - `GET /api/reports/overdue` (`asOf`, `days`) and `GET /api/reports/over-limit`;
    - `GET /api/reports/collections` (`side=received|paid`, `from`/`to`, `methodId`, `userId`);
    - `GET /api/reports/user-activity` (`from`/`to`, `userId`, `kind`), `admin.users`;
    - `GET /api/reports/cash-flow` (`from`/`to` or `preset`), `reports.financial`.
  - **Contracts:** the view types in `partner-reports.ts`.
  - **Back office:** the screens on the frame in the Reports home's *Customers and suppliers* section (ledger and statement, balance trend, overdue, over-limit), *Cash* (collections and payments) and *Support* (user activity); the cash flow in *Accounts*; the statement's print layout and the batch; the party picker from W2-03; the *Statement…* links on the customer and supplier screens; the i18n keys.
  - **If time (answer 8):** the eight built reports onto the frame.
  - **Docs:** this plan's results, the reports README, the glossary (*statement*, *balance trend*, *overdue*, *cash flow*), D-116's status.
- **Out:**
  - sending statements or reminders by email, SMS or WhatsApp from the system (no paid services; the owner sends the PDF);
  - interest or late fees on overdue balances;
  - a shop-wide default for credit terms (answer 4);
  - matching payments to particular bills (allocation stays FIFO, as the ageing);
  - the indirect cash flow, forecasts of cash;
  - anything from the legacy ledgers (D-100);
  - an audit-log export for an outside auditor beyond the CSV.

## Tests written first

- **Domain (golden):**
  - **Ledger:** an opening from before the range; bills, a return, a collection, a bank receipt, a voucher in the range; the running balance; a supplier's receipt, return and payments with the opposite debit and credit; an empty range (opening = closing).
  - **Statement:** a voided bill and its void left out, the closing unchanged; the closing's ageing equal to `ageBalances` on the same entries; an advance (credit balance).
  - **Trend dates:** an ordinary day; 31 May, 31 March, 29 February in a leap year and not; dates before go-live.
  - **Overdue:** N = 0, 30 and 90 on known due dates; a part payment settling the oldest first; a customer with an advance (nothing overdue); exactly N days (not overdue) and N + 1 (overdue).
  - **Near the limit:** at 89.99%, exactly 90%, at the limit, over, no limit.
  - **Activity:** each entity and named event to its kind; a sales line folded into its bill; changed fields with the version columns ignored, a field added, a field removed, a nested value (jsonb) changed.
  - **Cash flow:** each source type to its class; a voucher to each counter class; a fund transfer with charges (the charge an expense, the rest left out); months across a year end; part-months.
- **API (integration, under RLS):** a shop with an opening (customers, suppliers, cash and bank), credit sales to two customers, a return, a void, a counter collection and a bank receipt, a customer with a limit and terms, goods receipts with one paid from a bank at once, a supplier payment from the bank and one at the desk, a purchase return, an expense from the drawer and one from the bank, a handover, a deposit, a fund transfer with charges, a voucher for drawings, a cash short, over two months. Checks:
  - **the ledger's closing equals the party's balance in the books at `to`**, and Σ customers' closings equals `AR_CONTROL` (suppliers: `AP_CONTROL`);
  - the statement leaves out the voided bill and its void, its ageing equals the ageing report's row;
  - the balance trend's totals equal `AR_CONTROL` / `AP_CONTROL` at each date;
  - overdue by 30 days equals the ageing report's 31–60 + 61–90 + over 90 for the same customer;
  - over-limit lists the customer near their limit, not the ones without;
  - the register's total received equals the customers' credits from collections and receipts, its total paid the suppliers' debits from those payments;
  - user activity: a void, a price change and a failed sign-in appear with their user and kind; a sale's lines are one row; the import's rows don't; a password change shows no hash; a manager is refused;
  - **the cash flow: opening + Σ classes = closing = the cash book's closing, month by month**; the handover, deposit, safe and transfer are left out; the transfer's charges are an expense;
  - another tenant's documents never appear; a cashier is refused; without `cost.view`, the supplier side is refused;
  - ranges over the limit get `range_too_long` (the ledger over a year, the register and activity over 92 days, the cash flow over a year); the CSV has every row and the same totals;
  - timing on a generated year (300 bills a day, 131 customers with a third on account, 500,000 audit rows): each report under 2 s, the 131 statements under 5 s.
- **Back office (component):** the ledger's opening, running balance and words for the balance; the statement's header, ageing and item switch; the batch's page breaks; the trend's *before go-live*; the overdue days switch; the register's side switch; the activity's changed fields; the cash flow's months and totals; supplier screens hidden without `cost.view`; every string translated.
- **e2e** (`e2e/partner-reports.spec.ts`): after the counter's credit sale (counter.spec), the desk's collection (till.spec) and the supplier's bill (purchasing.spec):
  - the customer's ledger for this month shows the bill and the collection, and opens the bill's trace; the statement prints;
  - the overdue list with N = 0 shows the customer, and opens the ledger;
  - the register's *received* side shows the collection;
  - user activity shows the void and the sign-in;
  - the cash flow for this month shows the sale and the collection, and its closing equals the cash book's.

## Verify

- `pnpm check`, `pnpm test:integration`, `pnpm e2e`.
- On staging with the pilot's documents:
  - a customer's statement, read with the owner against what the customer is known to owe;
  - the ledgers' totals against Accounts receivable and Accounts payable on the trial balance;
  - the cash flow for the pilot's days against the cash book;
  - user activity for one pilot day, read with the owner;
  - each report prints on A4 and downloads as CSV.

## Order

1. Domain golden files, then `partner-reports.ts`.
2. The API and screens, report by report, the ones the shop uses today first: the ledger and statement (with the batch), then the balance trend, then overdue and over-limit, then the register, then user activity (with the index), **the cash flow last** (W2-01 answer 7). Integration tests with each.
3. e2e.
4. **If time (answer 8):** the built reports onto the frame, one per commit.
5. Docs: this plan's results, README, glossary, D-116.

## Risks

| Risk | Mitigation |
|---|---|
| A statement disagrees with what the customer was told at the counter | The ledger reads the same sub-ledger the counter's balance comes from; the integration test ties every closing to the books |
| User activity is slow on a big log | The new index; timed on 500,000 rows; 92 days at most |
| User activity shows something private | The trigger already removes password hashes and PIN verifiers; the report is the owner's only; a test checks a password change shows no hash |
| The cash flow puts something in the wrong class, or doesn't tie to the cash book | One pure rule by source type, golden-tested with every source; the integration test ties every month to the cash book |
| Every bill is overdue the next day for customers without terms | Answer 4: *more than N days*, 30 by default; the owner can set terms per customer at any time |
| The days run out | The cash flow is last among the new reports; the move of the built reports (answer 8) is after it and stops cleanly at any report; anything left follows after go-live (D-116's trade-off) |
| Moving a built report changes a figure the owner tested | Their API is unchanged; each keeps its component and e2e tests; one per commit |
