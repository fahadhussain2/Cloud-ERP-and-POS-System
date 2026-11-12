# W1-20 Reports and support: sales register, overrides, voids and returns, stock and valuation, outstanding and ageing, exceptions, "Trace a bill"

| | |
|---|---|
| **Issue** | [#65](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/65) |
| **Module** | reports (back-office screens and API, read only), with platform (PLT-12: "Trace a bill", "Send diagnostics" on the counter) |
| **Status** | Done (2026-11-10): built in PR #138, merged to staging; the owner verified it on staging (below) |
| **Refs** | RPT-01, RPT-03, RPT-04, RPT-05, RPT-06, RPT-10, PLT-12; PLT-09 (device health); PRD §6.8; architecture §11.3 (the counter's diagnostic log); CLAUDE.md rules 1, 5, 7, 10; D-059 (handover exceptions), D-090 (pilot order), D-100 (no legacy bills), D-101 (pilot wipe); D-110 (new, below) |
| **Depends on** | W1-11 (cash desk, handovers, day reconciliation and its CSV), W1-13 (returns), W1-08 (stock, cost and party ledgers), W1-16 (supplier ledger), W1-22 (customers) |
| **Size** | about 3½ days: report queries and API with integration tests 1¼; screens and CSV 1¼; "Trace a bill" ½; "Send diagnostics" ¼ (question 6); e2e and docs ¼ |
| **Test-first** | Yes: the ageing buckets and the register's totals (golden, `packages/domain`); every report under RLS and its permission, on a shop with known sales, voids, returns, overrides and exceptions (integration); the trace of one bill through sale, sync, handover, void and return (integration and e2e) |

## Goal

**The owner and the manager see each day what was sold, by whom and how it was paid; what was given away or undone; what stock is on the shelves and what it is worth; who owes the shop and whom the shop owes; and what went wrong. Support can follow any bill from the counter to the books.**

- **Sales register (RPT-01):** every bill of a day or a range, with totals by salesman, by counter and by tender.
- **Overrides (RPT-03):** below-list and below-floor sales, and the other approvals, by salesman, item and approver.
- **Voids and returns (RPT-04):** voids and reissues with their reasons; returns by reason and condition, salesman and item.
- **Stock (RPT-05):** what is on hand at each location, and its value at average cost.
- **Outstanding and ageing (RPT-06):** each customer's and supplier's balance, split by how overdue it is.
- **Exceptions (RPT-10):** what the server flagged while accepting counter documents (rule 7), to review and mark as seen.
- **Trace a bill (PLT-12):** one bill number's whole story on one screen.
- **Send diagnostics (PLT-12):** a manager sends the counter's log to support with one button.

Day reconciliation and cash variance (RPT-02) were built in W1-11 and stay as they are.

## Owner answers (2026-11-10)

The owner accepted every recommendation in the questions below (1–7). The trial balance, profit and loss, balance sheet and cash book stay in Wave 2 (ACC-07); W1-19's account balances at a date and the account ledger cover the pilot.

## Questions for the owner (each with a recommendation)

1. **Who sees which report?**
   *Recommended:* every report needs `reports.view` (owner, manager, purchaser, accountant).
   - Anything showing **cost or value** (stock valuation, the cost on a below-floor line) also needs `cost.view`. That's the same people today, but a custom role without it sees quantities only.
   - **Trace a bill** is for the owner (and the platform admin), as the PRD says.
   - The cashier and the salesman see no reports.
2. **Dates, branch and export.**
   *Recommended:*
   - every report opens on **today**, for one branch (Delux has one);
   - a **date range** of up to 92 days (a quarter);
   - **Download CSV** on every report, as on the day reconciliation;
   - no PDF: the browser's print is enough for the pilot.
3. **What the sales register counts.**
   *Recommended:* every finalized bill in the range, **returns and exchanges included** (net), each with its number, time, counter, salesman, customer, total and tenders.
   - **Voided bills are listed, struck through**, with their void number and reason, and are **left out of the totals**.
   - The totals by salesman, counter and tender sit above the list.
4. **Ageing buckets.**
   *Recommended:* by **due date**, in five columns: *not yet due*, *1–30*, *31–60*, *61–90* and *over 90 days overdue*.
   - A customer's bill is due after their credit terms; a supplier's after theirs.
   - Unallocated payments and returns count against the oldest balance first, as the legacy app does.
   - Only parties with a balance are listed; the totals equal Accounts receivable and Accounts payable.
5. **Exceptions: list only, or review too?**
   *Recommended:* **review too.**
   - The owner or the manager marks an exception **Reviewed** or **Dismissed**, with an optional note. It's audited and leaves the open list.
   - Filters: kind, severity, status, date.
   - The day's open high-severity count shows on the home screen.
6. **"Send diagnostics" on the counter now, or in Wave 2?**
   *Recommended:* **now** (about ¼ day).
   - A manager, after a PIN, sends the counter's last 5,000 log events and its health snapshot.
   - The server keeps them for 30 days, shown on the device's page and in "Trace a bill".
   - Without it, support can't see what happened on a counter that printed but never synced.
7. **Stock: today only, or at a past date?**
   *Recommended:* **today only** (on hand now, value at today's average cost).
   - Filters: location, category, search; "only below zero" and "only with stock".
   - Totals by location and by category.
   - Valuation at a past date needs the stock ledger replayed and waits for Wave 2 (RPT-07 and the financial statements).

## Design

| Decision | Why |
|---|---|
| **Read only, computed on request** from the tables that already hold the facts: `sales_documents`, `sales_lines`, `sales_payments`, `overrides`, `sales_voids`, `exceptions`, `stock_balances`, `item_costs`, `party_ledger_entries`, `cash_handovers`, `sync_inbox`, `device_status`. No report tables, nothing stored | Rule 4: the ledgers are the truth; a stored report could disagree with them. Delux's volume (a few hundred bills a day) needs no summaries |
| **Every query runs inside `withTenant`** under the app role (rule 5), filtered by branch and business date. Indexes added only where a query plan shows a scan on a large table (`sales_documents (tenant_id, business_date)`, `exceptions (tenant_id, status, business_date)`) | Forced RLS; the pilot's data is small, the year's isn't |
| **The money arithmetic is shared:** the register's totals and the ageing buckets are pure functions in `packages/domain` (`registerTotals`, `ageBalances`), golden-tested, used by the API and its CSV | Rule 1, and one place for the rules (bucket edges, voids left out) |
| **Ageing from the party ledger:** each customer's and supplier's open entries by due date (`party_ledger_entries.due_date`), with credits applied to the oldest debit first (FIFO) | Question 4. The sub-ledger already equals its control account |
| **Stock value = on hand × average cost** (`item_costs.avg_cost`), rounded per line to whole paisa; an item with no cost shows "no cost" and counts 0, as posting does (`no_cost`) | Rule 1; the same cost the books use, so the total matches the Inventory account |
| **Exceptions review:** a status change (`open` → `reviewed` / `dismissed`, and back to `open`) with a note, permission `exceptions.review` (new: owner, manager), written to the audit log. The exception itself never changes | Question 5. Rule 3: what the server recorded stays as recorded |
| **Trace a bill** (`GET /api/support/bills/:number`, owner only, permission `support.trace`, new): one timeline from the bill and everything that names it: created on the counter (device, user, device time, clock skew), each push attempt and the server's acceptance (`sync_inbox`), exceptions, overrides (reprints included), its posting (journal number), its handover or payout, a void and the reissue, returns of its lines. From the counter's log when diagnostics were sent: its print events. Each step shows its time and where it came from | PLT-12. Support answers "did it reach the server, was it handed over, why is the cash short" from one screen |
| **Send diagnostics** (question 6): the POS posts the last 5,000 `diagnostic_log` rows and a health snapshot to `POST /api/sync/diagnostics` (device-signed, like a push). They are stored in `device_diagnostics` (new, tenant table with forced RLS, not synced) and removed after 30 days by the worker. Shown on the device's page and in Trace | The log already exists on the counter (architecture §11.3); only the upload is missing |
| **The screens:** a **Reports** menu group (the day reconciliation and cash variance join it) with one screen per report: filters at the top, totals, then the list, and Download CSV. Money in tenant-locale formatting; every string an i18n key (rule 10) | Like the existing report screens |
| **Until go-live** the reports show the pilot's data; the pilot wipe (D-101) clears it with the documents | Nothing new to wipe except `device_diagnostics` |

## Scope

- **In:**
  - **Migration 0021:**
    - the table `device_diagnostics` (`enable_tenant_rls`, `enable_audit`; not synced);
    - the two indexes above, if the query plans need them;
    - the permissions `exceptions.review` (owner, manager) and `support.trace` (owner).
  - **Domain:** `registerTotals` and `ageBalances`, with golden files.
  - **API** (`apps/api/src/reports/`, `apps/api/src/support/`):
    - `GET /api/reports/sales-register`;
    - `GET /api/reports/overrides`;
    - `GET /api/reports/voids-returns`;
    - `GET /api/reports/stock`;
    - `GET /api/reports/ageing?side=customers|suppliers`;
    - `GET /api/reports/exceptions` and `POST /api/reports/exceptions/:id/review`;
    - `GET /api/support/bills/:number`;
    - `POST /api/sync/diagnostics`.

    Each report takes `from`, `to`, `branchId` and `format=csv`, and checks its permission.
  - **Back office:**
    - the Reports menu group;
    - the seven screens with their filters and CSV;
    - Trace a bill;
    - the open-exceptions count on the home screen;
    - the device page's last diagnostics.
  - **POS:** "Send diagnostics" in the manager menu, after a PIN; it says when it was sent, or that it will go when the counter is back online.
  - **Pilot wipe:** removes `device_diagnostics`.
- **Out:**
  - sales and gross profit (RPT-07), dead stock (RPT-08) and the purchase register (RPT-09), all Wave 2;
  - stock at a past date (question 7);
  - PDF export;
  - charts;
  - scheduled or emailed reports.

## Tests written first

- **Domain (golden):**
  - **Register totals:** a day with cash, card and split bills, a return, an exchange and a voided bill. The totals by salesman, counter and tender; the voided bill left out; the return netted.
  - **Ageing:** a customer with bills inside and past their terms in every bucket, a payment applied to the oldest first, a return, a credit balance. The bucket edges on the day itself and at 30, 31, 60, 61, 90 and 91 days. A supplier the same way.
- **API (integration, under RLS):** each report on a shop seeded with known documents, checking:
  - the rows and totals;
  - that another tenant's documents never appear;
  - that a role without `reports.view` (or `cost.view` for values) is refused;
  - that the CSV has the same rows.
  - **Exceptions review:** audited; the exception itself unchanged; a cashier refused.
  - **Trace a bill:** a sale pushed twice (the second attempt counted), handed over, voided and reissued, then a line returned; every step appears in order. Another shop's bill number isn't found.
  - **Diagnostics:** accepted only signed by an enrolled device; the oldest removed after 30 days.
- **Back office (component):**
  - the register's struck-through void;
  - the ageing columns;
  - stock without `cost.view` shows no value;
  - the review dialog.
- **e2e:**
  - a bill sold on the counter appears in the sales register;
  - its trace shows the sale, the sync and the handover;
  - an exception is marked reviewed;
  - "Send diagnostics" on the counter shows up on the device's page.

## Verify

- `pnpm check`, `pnpm test:integration`, `pnpm e2e`.
- The stock valuation total equals the Inventory account's balance, and the ageing totals equal Accounts receivable and Accounts payable, on a database with the generated test catalog and sales.
- On staging:
  - the day's register after a few counter sales, a return and a void;
  - an override and a void in their reports;
  - stock and its value for one location;
  - a customer's ageing after a credit sale and a part payment;
  - an exception reviewed;
  - one bill traced end to end;
  - diagnostics sent from a counter.

## Changes during the build

| Change | Why |
|---|---|
| The open high-severity count is a badge beside **Exceptions** in the menu, not on a home screen | The back office has no home page: it opens the first screen a person may use. The menu is on every screen |
| `exceptions.review_note` (new column) holds the reviewer's note; the status, who and when were there since 0008 | What the server recorded (kind, severity, details) never changes; only its review does |
| `device_diagnostics` is not audited row by row; each upload writes one `diagnostics.sent` audit row | A row is a log of up to 5,000 events; copying it into the audit log would double it for nothing |
| No new indexes: the reports use `sales_documents_day_idx`, `exceptions_open_idx` and `party_ledger_entries_party_idx` | They already cover the date and party lookups |
| The trace's *attempts* counts a refused document sent again; a bill already accepted and pushed again is answered as a duplicate and not counted | Sync stays idempotent (rule 7): a duplicate writes nothing |
| Send diagnostics while offline isn't queued: the counter says it is offline and to try again | A queued log would be stale by the time it went; support asks for it when it is needed |
| The counter drops any log key naming a phone, PIN, password, token, secret or signature before sending (`scrub`, tested) | Nothing personal or secret leaves the counter (the plan's risk table) |
| The stock report sends at most 2,000 lines and says so; its totals count every line | Delux has about 20,000 items; the search narrows it |
| Trace a bill also shows a logged reprint and a failed print, from the diagnostics, as their own steps | The counter's log is the only place a print is recorded |

## Checks (2026-11-10)

- `pnpm check` (format, lint, typecheck, tests with coverage, build): pass, 2,142 tests.
- `pnpm test:integration`: 429 passed (41 files), including the reports and support API (18) and migration 0021's role update.
- `pnpm e2e` (Edge): 54 passed; the new reports flow covers Send diagnostics on the counter, the register, a trace, an exception reviewed and the counter's diagnostics page.

## Owner review on staging (2026-11-10)

The owner tested the sales register, overrides, voids and returns, stock and value, ageing, exceptions with review, Trace a bill and Send diagnostics on staging: **working as expected**, with no changes needed.

## Order

1. Migration and schema.
2. Domain golden files.
3. API with integration tests, one report at a time.
4. Screens and CSV.
5. Trace a bill.
6. Send diagnostics.
7. e2e.
8. Docs and D-110.

## Risks

| Risk | Mitigation |
|---|---|
| A report that disagrees with the books | Computed from the same ledgers; the Verify step checks the stock and ageing totals against their accounts |
| Slow queries as a year of sales builds up | Range capped at 92 days; indexes where a query plan needs them; the integration test seeds a year of generated sales and times the register |
| Cost or value seen by someone who shouldn't | Values only with `cost.view`; the API leaves them out, not just the screen |
| Exceptions marked reviewed to hide them | Audited with who and when; the list can show reviewed and dismissed ones; the exception itself never changes |
| Diagnostics holding personal data | The log holds event kinds, document numbers and errors, never PINs or customer phones (checked by a test on the upload); kept 30 days only |
| A trace missing a step | Each source is read by its own query; the integration test walks one bill through every step |
