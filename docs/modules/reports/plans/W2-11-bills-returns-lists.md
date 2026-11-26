# W2-11 Bills and Returns: the sales documents as lists

| | |
|---|---|
| **Issue** | to open after the plan is accepted |
| **Module** | reports (back-office screens and their API, read only), with platform (the menu) |
| **Status** | Built (2026-11-26) on branch `plan/w2-11-bills-returns`, waiting for review; accepted by the owner the same day, questions 1–3 as recommended |
| **Refs** | RPT-01 (the sales register), PLT-12; CLAUDE.md rules 1, 5, 10; D-116 (the report frame), D-125 (bill details), D-126 (new, below) |
| **Depends on** | W2-10 (the bill details page, its API and its links), W2-01 (the report frame) |
| **Size** | about 1 day: the two list queries with integration tests ⅓; the two screens on the report frame, the menu and the routes ½; e2e and docs ⅙ |
| **Test-first** | Yes: both lists under RLS, permissions and every filter (integration); the screens (component); from the menu to a bill and back (e2e) |

## Why

W2-10 put **Bill details** in the Sales menu as a box to type or scan a number. The owner (2026-11-26): the menu should hold the documents themselves, as **Bills** and **Returns** lists, the way Purchasing already lists its goods receipts and purchase returns. A box with nothing under it is a dead end; a list is where you start.

The Sales register stays under Reports: it is the day report (totals by salesman, counter and payment method), not a place to find a document.

## What changes

The Sales menu becomes **Customers · Bills · Returns**. *Bill details* leaves the menu; its page stays, and is what every row opens. Both lists are on the report frame (D-116), so they have its date presets, key figures, sorting, the quick search, CSV and print.

### Bills (`#/sales/bills`)

Sales bills (kind *sale*), voided ones included and marked, newest first. Columns as the owner chose them:

| Column | What it shows |
|---|---|
| **Bill number** | Opens the bill's details |
| **Date and time** | On the counter's clock |
| **Customer** | Name and code, *Walk-in*, or the walk-in's phone |
| **Items** | The number of lines |
| **Total** | What the customer paid |
| **Paid by** | Each method used, in bill order |
| **Status** | *Finalized*, or *Voided* with the void's number |

Key figures: bills and their total, voided bills left out (as the sales register counts them). Filters: the period, a search (bill number, customer name or code, walk-in phone), salesman, payment method, status (*All · Finalized · Voided*).

### Returns (`#/sales/returns`)

Returns and exchanges (kinds *return* and *exchange*), newest first:

| Column | What it shows |
|---|---|
| **Return number** | Opens its details |
| **Date and time** | On the counter's clock |
| **Type** | *Return* or *Exchange* |
| **Original bill** | Opens it, or *No receipt* |
| **Customer** | Name and code, or *Walk-in* |
| **Items back** | Units returned (fractional units with their decimals) |
| **Reason** | The returned lines' reason, or *Several* when they differ |
| **Refund / due** | The document's total: a refund below 0; for an exchange, the net (refunded or collected) |
| **Refund paid** | *Paid at {desk}* (the desk's payout), *Not yet*, or *—* when nothing is refunded in cash |
| **Status** | *Finalized* or *Voided* |

Key figures: returns and the total refunded (finalized only). Filters: the period, the search, salesman, type (*All · Return · Exchange*), reason.

## Design

| Choice | Why |
|---|---|
| **Two reads:** `GET /api/sales/bills` and `GET /api/sales/returns`, `reports.view` (D-125), under `withTenant` (rule 5), with the filters as query parameters and `format=csv`. Each answers `{ money, from, to, rows, truncated, total }`; contracts `BillListView` and `ReturnListView` in `packages/contracts` | The report frame's shape, so the screens reuse it |
| **The period** is the business date; up to 92 days (`LIST_DAYS`, as the sales register and the purchase register); the first 2,000 rows on screen, the CSV and the key figures count them all (`STOCK_ROWS`) | Delux makes about 100 bills a day: a quarter is about 9,000, too many to draw, few enough for one query |
| **The search runs on the server**, over the number, the customer's name and code and the walk-in phone, case-insensitive, `LIKE` with the user's `%` and `_` taken literally | A number from last month must be found without paging |
| **Each row is one query's row**: the document with its customer; `Items`, `Items back` and `Reason` aggregated from its lines; `Paid by` from its payments; *Refund paid* from its desk payout (`cash_handovers` kind *payout*) | One query per list, by business date then time, on the existing indexes |
| **Bill details stays at `#/sales/bills/<number>`**, for bills and returns alike; its back link goes to **Bills** or **Returns** by the document's kind, with the period it was opened from | One page for a sales document; the lists are only ways in |
| **The route `#/sales/bills` becomes the list** (it was the box to type a number). The box's job is the list's search: typing or scanning a number there finds it | Nothing is lost; no new address to learn |
| **Columns left out by the owner:** counter, salesman and cash handover on Bills; counter and salesman on Returns. They stay on the bill's details page, and salesman stays a filter on both lists | The owner's choice (2026-11-26): the lists stay narrow |
| **All words are i18n keys**, CSS logical properties, the shop's money and date format (rule 10) | As every screen |

## Questions for the owner

1. **The period a list opens on.** *Answer (owner, 2026-11-26): as recommended.* *Recommended:* **today**, like the sales register; a preset for this week and this month. *Alternative:* this month.
2. **Voided bills in Bills.** *Answer (owner, 2026-11-26): as recommended.* *Recommended:* **listed and marked Voided**, with the status filter to hide them; left out of the total. *Alternative:* hidden unless the filter asks for them.
3. **Profit on Bills.** *Answer (owner, 2026-11-26): as recommended.* *Recommended:* **not now** (you left it out of the columns); the bill's page shows it. *Alternative:* a Profit column for those with `cost.view`.

## Tests (first, failing)

- **Integration (`apps/api/src/reports-sales.int.test.ts`, on its seeded bills):**
  - Bills lists the sales, not the returns; each row's customer, items, total, payment methods and status as stored; the voided bill marked with its void number and left out of the total;
  - Returns lists the return and the no-receipt return (and an exchange, added to the seed); type, original bill or *No receipt*, units back, reason or *Several*, refund, refund paid;
  - every filter: period, search by number, by customer name and by walk-in phone, salesman, payment method, status, type, reason; a search with `%` finds nothing extra;
  - more than 92 days refused; the CSV has every row and the total;
  - without `reports.view`: refused; another shop's documents: none (RLS).
- **Component (`apps/backoffice`):** the columns in the owner's order; a row opens its bill; *No receipt*, *Several*, *Voided (C03-V000004)*; the key figures; the menu's Sales group lists Customers, Bills and Returns; the bill page's back link goes to Bills or Returns by kind; every string translated.
- **E2E:** Sales → Bills on the counter's bill's day → its row → the bill → back to Bills; Sales → Returns lists the return.

## Risks

| Risk | Mitigation |
|---|---|
| A wide search over a quarter is slow | Bounded by the period (92 days) and the 2,000 rows drawn; the test with a generated year answers under 500 ms |
| Two places show the same bills (Bills and the sales register) with different totals | Both leave voided bills out the same way; the test compares Bills' total with the register's for the same day |
| People miss the box to type a number | The list's search does it, and its label says *Bill number, customer or phone* |

## Docs

- D-126 in the decision log (amends D-125: the menu entry);
- W2-10's plan: a line pointing here; the reports README; the glossary (*Bills*, *Returns*).

## Results

Built as planned, with these details settled while building:

- **The API** is in `apps/api/src/reports/bill.ts` beside the bill's details: `GET /api/sales/bills` and `GET /api/sales/returns`. Bills' answer also carries the shop's payment methods, for the filter. A return's *Refund paid* is *paid* when the desk paid it out, *pending* when a refund is still waiting, else *none*; a return with no reason on its lines counts as *other*.
- **The screens** are `apps/backoffice/src/reports/SalesDocumentScreens.tsx` (`BillsScreen`, `SalesReturnsScreen`: Purchasing already has a `ReturnsScreen`). The payment methods stay in their filter while the list reloads after a change.
- **The bill page** lost its lookup box (the lists' search does it) and its back link goes to Bills or Returns by kind.
- **A regression from W2-09 fixed on the way:** the dashboard's cost corrections (D-124) scanned the whole stock ledger in two extra transactions, so W2-06's timing test (under 1.5 s on a generated year) failed at 1.6–1.8 s, on staging's code too. Migration `0026_cost_correction_index.sql` adds a partial index on movements with no quantity, and the dashboard reads them on its two existing connections; the test passes again. Its own commit, the existing test locked during the fix.

Checks (2026-11-26, local, Node 24):

- `pnpm check`: format, lint, typecheck, 2,734 tests in 142 files with coverage, builds: all passed.
- `pnpm test:integration` (PostgreSQL 17.9): 559 tests in 50 files passed, the four new list cases among them (with an exchange added to the seed).
- `pnpm e2e` (Edge): 81 passed. The first run failed four: the new step's *To* date matched the search box's label (*Bill number, customer or phone*), fixed with an exact match; sync, till and the partner ledger (which uses till's payment) were the flaky counter flows seen in W2-10 and passed on the rerun with no change.
