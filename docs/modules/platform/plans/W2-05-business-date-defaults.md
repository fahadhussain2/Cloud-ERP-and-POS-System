# W2-05 Back-office documents default to the shop's business date

| | |
|---|---|
| **Issue** | none yet: opened when the owner accepts this plan (W2-05 is the next free number on 2026-11-19) |
| **Module** | platform (the shop's day), touching purchasing, inventory and accounting screens and their API |
| **Status** | Proposed (2026-11-19): waiting for the owner's answers 1–4 |
| **Refs** | GLOSSARY *Business date*; data model §tenants (`timezone`, `day_cutoff_hour`, `lock_date`); ACC-06; PUR-01, PUR-02, PUR-09; INV-04, INV-05; CLAUDE.md rules 2, 7, 10; D-108 (dates and the lock date); found during W2-02 (#183) |
| **Depends on** | W1-16 (purchasing), W1-18 (stock operations), W1-19 (back-office accounting, `shopDay`, `checkDocumentDate`) |
| **Size** | about 1 day: API and contracts ¼, six forms ¼, tests ½ |
| **Test-first** | Yes: a component test per form and an API integration test at 00:30 Karachi, committed failing before the change |

## The problem

The counters date a bill with the **business date** (`businessDate(now, timezone, day_cutoff_hour)`, 04:00 cut-off at Delux), so a sale at 00:30 counts to the day before. The back office does not do this everywhere. Between **00:00 and 04:00 Karachi**, a goods receipt typed then is dated a day *ahead* of that night's bills: stock "as on today" (W2-02) leaves it out until 04:00, and a receipt typed at 00:30 on the 1st of a month lands in the new month (or the new fiscal year) while the bills of the same night stay in the old one.

## What each form does today

| Form (screen) | Field | Default today | API check of the date |
|---|---|---|---|
| Goods receipt (`purchasing/ReceiptScreen.tsx:222-223`) | received on, supplier's bill date | browser calendar date, `today()` in `purchasing/data.ts` | lock date on post only; **no future check** |
| Purchase return (`purchasing/ReturnScreen.tsx:161`) | returned on | browser calendar date | lock date on post only |
| Supplier payment by bank (`purchasing/SuppliersScreen.tsx:608`) | paid on | browser calendar date | lock date only |
| Stock transfer, sending (`inventory/TransferScreen.tsx:220`) | moved on | browser calendar date, `today()` in `inventory/data.ts` | lock date on post only |
| Stock transfer, receiving (`inventory/TransferScreen.tsx:239`) | received on | browser calendar date | lock date only |
| Stock adjustment (`inventory/AdjustmentScreen.tsx:184`) | adjusted on | browser calendar date | lock date on post only |
| Customer receipt, expense, fund transfer (`accounting/MoneyScreen.tsx:230`) | date | **business date** from `/api/accounting/lookups` (`today`), `max` = today | `checkDocumentDate`: required, not after the business date, after the lock date |
| Journal voucher (`accounting/VoucherScreen.tsx:93`) | date | **business date** from lookups | `checkJournalVoucher` → `checkDocumentDate` |
| Reversal (`accounting/MoneyScreen.tsx:560`) | date | **business date** from lookups | `checkDocumentDate`, not before the original |

- The two `today()` helpers say *"the back office runs in the shop"*: they use the **browser's** time zone and **no cut-off**. On a laptop outside Pakistan (the owner travelling) they are off by hours more.
- The API already has the shop's day in one place: `shopDay()` in `apps/api/src/lock.ts` (the `@erp/domain` `businessDate`), used by accounting, the lock and its checklist. `shop()` in `apps/api/src/reports/financial.ts` works out the same date in SQL. Purchasing and inventory lookups send the lock date but not the day.
- Contracts accept any ISO date (`z.iso.date()`), so a purchasing or stock document can be dated next week, next year, and post.

## Lock date and fiscal year

- **No rule changes.** Moving the lock date already uses the business date (`checkLockMove`: `month_not_over` while the proposed month end is on or after the business date). At 00:30 on 1 December the business date is 30 November, so November can't be locked yet and the new default (30 November) is never refused by a fresh lock.
- **What changes in effect:** a document typed between 00:00 and 04:00 on the 1st falls in the **same month and fiscal year** as that night's counter bills, as accounting documents already do. Month-end and year-end stock (stock at a date, the balance sheet's Inventory) then agree with the counters.
- A user can still pick any open date by hand; the lock date is checked as today.

## Questions for the owner (each with a recommendation)

1. **Default date of every back-office document.**
   *Recommended:* **the shop's business date, from the API**, on all six purchasing and stock forms, as the accounting forms already do. Purchasing and inventory lookups gain `today` (from `shopDay`); the browser `today()` helpers go.
   *Otherwise:* keep the browser's calendar date (documents typed after midnight are dated a day ahead until 04:00).
2. **Refuse purchasing and stock documents dated after the business date.**
   *Recommended:* **yes, on post** (and when a supplier payment is saved), with the same `date_in_future` problem and message the accounting forms show; the date fields get `max` = today. D-108 already says back-office documents are never in the future; W1-16 and W1-18 were built before that check existed. A draft can keep any date until it is posted.
   *Otherwise:* defaults only; a receipt dated ahead by hand still posts.
3. **The supplier's bill date on a goods receipt.**
   *Recommended:* **default to the same business date, no new check:** it is the date printed on the supplier's paper and sets the due date (`billDate + terms`); the purchaser types what the bill says.
   *Otherwise:* also refuse a bill date after the business date.
4. **A screen left open across 04:00.**
   *Recommended:* **the default is fixed when the screen opens** (lookups are read then). A form opened at 03:55 still shows yesterday's date at 04:05, visible in the field and changeable; the API checks again on post.
   *Otherwise:* re-read the day when a new document starts (one more request per document).

## Design (with answers 1–4 as recommended)

| What | How |
|---|---|
| **The day** | `PurchasingLookups` and `InventoryLookups` (`packages/contracts`) gain `today: string`, filled by `shopDay(c, now())`, like `AccountingLookups`. No new endpoint, no new rule outside `packages/domain` (rule 2: `businessDate` and `checkDocumentDate` already live there) |
| **Forms** | Goods receipt (received on, bill date), purchase return, supplier payment, transfer sending and receiving, adjustment default to `lookups.today` and set `max={lookups.today}`. Remove `today()` from `purchasing/data.ts` and `inventory/data.ts` |
| **API** | On post of a goods receipt, purchase return, transfer (sending and receiving) and adjustment, and on saving a supplier payment: `checkDocumentDate(date, today, lockDate)` before `lockedOn`; `date_in_future` → `400 {error: 'invalid', problems: ['date_in_future']}`, as accounting returns it. Drafts are saved with any date |
| **Messages** | `purchasing.errors.date_in_future` and `inventory.errors.date_in_future` (i18n keys, rule 10), same wording as `accounting.problems.date_in_future` |
| **Counters** | Unchanged: the POS already dates by business date and is never refused (rule 7) |

## Tests written first

- **Component, one per form** (Vitest, Testing Library): the browser clock set with `vi.setSystemTime` to a day far from `lookups.today` (e.g. clock 2026-11-21 12:00 UTC, `today: '2026-11-19'`), so the test holds in any machine time zone; the date field shows `2026-11-19` and its `max` is `2026-11-19`. Goods receipt (both dates), purchase return, supplier payment, transfer sending, transfer receiving, adjustment; and the accounting receipt, expense, fund transfer, voucher and reversal, which already pass and keep it that way.
- **Component, refusal:** a receipt and an adjustment refused with `date_in_future` show the message.
- **Integration at 00:30 Karachi** (`apps/api`, `buildApp({ now: () => new Date('2026-11-19T19:30:00Z') })`, which is 00:30 on 20 November in Karachi):
  - purchasing, inventory and accounting lookups all return `today: '2026-11-19'`;
  - a goods receipt, purchase return, supplier payment, transfer (sent and received) and adjustment dated `2026-11-20` are refused with `date_in_future`; dated `2026-11-19` they post;
  - the receipt dated `2026-11-19` is in stock at `2026-11-19` (W2-02 stock at a date) with that night's counter bill;
  - at `2026-11-19T23:00:00Z` (04:00 Karachi) `today` is `2026-11-20` and the `2026-11-20` documents post.
- **e2e:** `e2e/ledger.spec.ts:173` types the UTC calendar date into *received on*; it uses the date the screen defaults to instead, so it cannot fail between 23:00 and 24:00 UTC once the future check exists.

## Verify

`pnpm check`, `pnpm test:integration` against PostgreSQL 17, `pnpm e2e` (purchasing, stock, ledger), output shown in the PR.

## Order

1. Failing tests (component and integration), committed.
2. Contracts and lookups (`today`), then the API date checks.
3. The six forms, the messages, the e2e fix.
4. A decision-log entry (next free number): *back-office documents default to the shop's business date and are never dated after it*, amending D-108's dates.

## Risks

- **A draft already dated ahead** (typed after midnight before this change) is refused on post until 04:00 or until its date is changed; the message names the problem. On staging only: production has no documents yet.
- **Tests with a fixed `now`** already date documents on that day, so the future check doesn't break them; tests on the real clock are the e2e ones, covered above.

## Out of scope (noted, not changed here)

- **Report screens** that pick their first date from the browser: *Day reconciliation* (`screens/ReportsScreens.tsx:83`, yesterday) and *Cash variance* (`:386`, the last 7 days to today). Reports read by business date in the API; only the pre-filled date is off between 00:00 and 04:00. A small follow-up, or part of W2-03 / W2-04 if they touch those screens.
- **The generated opening on staging** (`apps/api/src/generated-opening.ts:29`) dates itself by the UTC calendar date; staging only, never production.
- **A transfer received before it was sent** is not refused today; a separate question if it matters.
