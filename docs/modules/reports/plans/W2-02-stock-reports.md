# W2-02 Stock reports: stock ledger, stock at a date, stock movement, reorder list, dead and slow stock, inventory analysis

| | |
|---|---|
| **Issue** | [#177](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/177) |
| **Module** | reports (back-office screens and API, read only), with inventory (the stock ledger behind the item's stock card) |
| **Status** | Accepted (owner, 2026-11-18): question 1 *start from go-live* (against recommendation), questions 2–8 as recommended |
| **Refs** | RPT-08, RPT-12, RPT-13, RPT-14, PUR-07 (the list only); INV-07 (stock card); CLAUDE.md rules 1, 4, 5, 10; D-017 (one average cost per item), D-100 (no legacy bills), D-101 (pilot wipe), D-102 (opening stock), D-110 (reports read the ledgers), D-116 (reports before go-live; this plan's answers 1–8) |
| **Depends on** | W2-01 (the report frame, periods, the Reports home), W1-18 (stock moves and the stock card), W1-20 (the stock report), W1-14 (opening stock) |
| **Size** | about 3 days: domain golden files ½; API with integration tests 1; item picker and six screens 1; e2e and docs ½ |
| **Test-first** | Yes: the movement buckets, the reorder quantity, dead and slow, ABC, turnover and days of cover (golden, `packages/domain`); every report under RLS, its permission and its ties to the books on a shop with known stock documents (integration); stock at a date → stock ledger → document, the reorder list printed (e2e) |

## Goal

**The owner, the manager and the purchaser see how much of each part the shop had on any date and what it was worth, what moved it and when, what to order from whom, and which stock is sitting still. Every figure opens the documents behind it, on the W2-01 frame.**

- **Stock ledger (RPT-12):** one item's documents in a range: an opening line, then each document with quantity in or out, the running balance and its value.
- **Stock at a date (RPT-13):** on hand and value of every item on any past date, grouped by category and vehicle make (the way the shop counts today).
- **Stock movement (RPT-13):** per item over a range: opening, purchases, purchase returns, sales, sales returns, adjustments and counts, transfers, closing.
- **Reorder list (PUR-07, the list only):** items at or below their minimum, the quantity to bring them up to the maximum, by supplier, with recent sales. Turning it into purchase orders stays with POs (Wave 2).
- **Dead and slow stock (RPT-08):** stock that hasn't sold in N days, or would take too long to sell at today's rate, with its value.
- **Inventory analysis (RPT-14, last):** ABC by sales and by profit, stock turnover and days of cover.

## Owner answers already given (D-116, 2026-11-18)

Four tasks; this is the second (1). Everything by go-live, the new analysis last (2). 2026 stays in the legacy app, read-only (3). Lists of lines up to 92 days, summaries up to a year, stock "as on" any date (4). CSV and a print layout, PDFs from the browser (5). Stock reports for `reports.view` (owner, manager, purchaser, accountant); cost, value and profit also need `cost.view` (6). Modern design; the legacy *Stock Ledger*, *Stock Summary*, *Item Wise Closing Stock* and *Item Order Register* give meaning only.

## Owner answers (2026-11-18)

1. **Start from go-live:** no legacy sales summary. Recent sales, dead and slow stock and the analysis count from the opening (1 Jan 2027) and say so until enough days have passed. D-116 answer 3 stands as it is.
2. **The books' value** everywhere; the W1-20 stock report switches to it.
3. Grouped by **category, then vehicle make**, with a switch to brand, location or supplier.
4. The **reorder list** as recommended: Shop + Godown at or below the minimum, up to the maximum, by supplier.
5. **Dead:** no sale in 90 days (30, 60, 180, 365 to choose); **slow:** more than 180 days of cover.
6. The **stock ledger one item at a time**.
7. **ABC at 80 / 15 / 5** over the last 12 months, with turnover and days of cover.
8. **Quantity and value side by side** with `cost.view`, quantities only without.

## What the shop's data looks like (`erp_dev`, from the last rehearsal)

- **19,552 items.** Every one has a minimum and a maximum: 19,442 have a maximum above 0, 10,626 a minimum above 0, 99 have both at 0, and 11 have a maximum below their minimum.
- **17,265 items fit one vehicle make** (21 makes); none fits more than one yet. 267 categories, none with sub-categories.
- **Three locations:** Shop, Godown, Damaged.
- **18,657 items have a default supplier**; the last supplier and last cost of each item come from the opening (W1-14) and then from goods receipts.

## Questions for the owner (each with a recommendation)

1. **Sales before go-live, for dead stock, reorder and the analysis.**
   On 1 Jan 2027 the new system knows no sales (D-100: no legacy bills). Without history, dead stock in January lists every item, the reorder list shows no recent sales, and ABC has nothing to rank until months pass.
   *Recommended:* **import a small summary from the legacy sales, not the bills:** for each item, its last sale date and last purchase date, and the quantity and amount sold in each month the final dump holds (from July 2026 on the last rehearsal).
   - It is used only by these reports, marked *before go-live*, and never by the books, the stock or the customer accounts.
   - The import already reads the legacy sale lines for its own checks (D-102), so this is about a day's work, rehearsed with the others.
   - It narrows D-116 answer 3 (no history import) to "no bills"; it would be recorded as a decision.
   *Otherwise:* every report counts from go-live and says *since 1 Jan 2027*; dead stock is useful from about April.
   **Owner's answer: start from go-live** (no summary).
2. **The value of stock.**
   *Recommended:* **the value in the books**: each item's value is the sum of its stock movements' values, so stock at any date equals Inventory on the balance sheet for the same date, to the paisa. The average cost shown is that value ÷ quantity.
   - **The stock report (W1-20) switches to the same value**, so *stock now* and *stock at today* never differ. Today it values each item at quantity × its rounded average cost, a few paisa off the books (6 paisa on the test shop, W2-01).
3. **How stock at a date and stock movement are grouped.**
   *Recommended:* **by category, then vehicle make**, the way the shop counts today, with subtotals; a switch groups by **brand, location or supplier** instead. Filters: category, make, brand, location, supplier, and a search by code or name.
   - Each item fits at most one make today. If an item is later set to fit several, it is counted once, under the first make it was given.
   - *Item list with negative* (legacy) becomes a switch: **only items below zero**.
4. **The reorder list.**
   *Recommended:* the shop's rule today:
   - **An item is on the list when its stock in the Shop and the Godown together is at or below its minimum**; the quantity to order is **maximum − that stock** (PUR-07). Damaged stock doesn't count.
   - **Grouped by supplier** (the item's last supplier, else its default supplier), so the purchaser can ring each one; the print of one supplier's group leaves out cost if the person may not see it.
   - Each line also shows the last cost, the last receipt date, the quantity sold in the last 30 and 90 days, and how many days the stock would last.
   - Items with *Exclude from reorder*, discontinued items, and items with both levels at 0 are left out. **An item whose maximum is below its minimum** (11 today) is listed with *levels need fixing* and ordered up to its minimum.
   - Open purchase orders are not subtracted yet: there are none until POs (Wave 2), which will add them.
5. **Dead and slow stock: the definitions.**
   *Recommended:*
   - **Dead:** in stock, and no sale in the last **N days** (90 by default; 30, 60, 180 or 365 to choose).
   - **Slow:** sold in the last 90 days, but at that rate the stock would last **more than 180 days**.
   - Each line shows on hand, value, last sale, last receipt, and the quantity sold in the last 90 days; the total value of dead and of slow stock is at the top.
6. **The stock ledger: one item, or many?**
   *Recommended:* **one item at a time**, picked by code, name, OEM number or scan, for up to 92 days, all locations or one.
   - For many items at once, the stock movement report shows each item's totals, and a click opens that item's ledger for the same period.
   - The item's stock card (W1-18) stays on the item screen, with a link to its stock ledger.
7. **Inventory analysis: ABC limits and period.**
   *Recommended:* the usual **80 / 15 / 5**: class A are the items that make the first 80% of sales (or of gross profit), B the next 15%, C the last 5%, and *none* for items with no sales.
   - Over the **last 12 months** by default (any period up to a year).
   - **Turnover** = cost of sales ÷ average stock value (opening and closing); **days of cover** = on hand ÷ average daily quantity sold.
   - ABC by profit needs `cost.view`, and uses go-live sales only (the legacy summary has no cost).
8. **Quantities only, or value too?**
   *Recommended:* **quantity and value side by side** for those with `cost.view`; others see quantities only (the API leaves value out, as W1-20).

## Design

| Decision | Why |
|---|---|
| **Read only, computed on request** from `stock_movements`, `stock_balances`, `item_costs`, `items` and `sales_lines`, inside `withTenant`. No report tables, no migration (unless the timing test needs an index; see Risks) | Rule 4 and D-110: the stock ledger is the truth |
| **One SQL shape:** per item and location, the sum of `qty_delta` and `value_delta` before a date and, by source, between two dates. Stock at a date is the first; stock movement both; the ledger lists one item's rows with running sums. **Dates are `business_date`**, as the statements | One definition of "on a date" for stock and the books, so stock at a date = Inventory on the balance sheet |
| **Movement buckets** (`movementSummary`, pure, golden): `opening` → opening; `goods_receipt` → purchases; `purchase_return` → purchase returns; `sale` lines out → sales, in → sales returns (an exchange gives both); `sales_void` → back into sales (a void undoes its sale); `stock_adjustment` → adjustments and counts; `stock_transfer` and `stock_transfer_receipt` → transfers out and in. Closing = opening + the buckets, checked on every row | One place for the sign rules; a void nets out of sales instead of looking like a return |
| **Transfers** show per location; over all locations they cancel out and the columns are hidden, except stock still in transit, shown as its own line | A transfer moves stock, it never changes how much there is |
| **Reorder, dead and slow, ABC, turnover, days of cover** are pure functions in `packages/domain` (`stock-reports.ts`), on integer thousandths and minor units, golden-tested | Rule 1; the reorder rule and the definitions in questions 4, 5 and 7 are written once |
| **Recent sales** (30 and 90 days, last sale date) come from `sales_lines` of finalized bills, less returns, by business date, **from the opening on** (answer 1). While the shop has been open on the new system for fewer days than a report looks back (N days for dead stock, 30 or 90 for recent sales, 12 months for ABC), the report says *since 1 Jan 2027*; an item not sold since go-live counts as dead only once N days have passed, and is shown as *not sold since go-live* before that | Same counting as the sales register (W1-20); no figure pretends to cover days the system didn't see |
| **Big lists:** stock at a date and stock movement can have ~19,500 rows. The screen shows the first 2,000 in the chosen order, with group subtotals and totals over **every** row; Download CSV has every row | As the W1-20 stock report; a browser can't usefully show 19,500 rows, and the print is for groups or filtered lists |
| **The item picker** (`reports/frame/ItemPicker.tsx`): search by code, name or OEM number, or a scan, using the catalog's search; the chosen item goes in the address | Needed by the stock ledger here and by W2-03's purchase and sale rates |
| **Drill-down:** an item's row opens its stock ledger for the same period; a ledger line opens its document (bill trace, goods receipt, purchase return, transfer, adjustment, opening); a reorder line opens the item | W2-01's `documentHref`, extended to the stock documents |
| **Permissions:** every report needs `reports.view`; quantities for everyone who has it, cost and value columns, value subtotals and ABC by profit only with `cost.view`, left out by the API | D-116 answer 6, D-110 |
| **Date rules** (W2-01's `periodOf`, `checkRange`): stock ledger up to 92 days; stock movement, dead and slow and the analysis up to 366; stock at a date and the reorder list on any date (the reorder list is always today) | D-116 answer 4 |
| **Until go-live** the reports show the pilot's documents; the pilot wipe (D-101) clears them | Nothing new to wipe |

## Scope

- **In:**
  - **Domain:** `stock-reports.ts` (`movementSummary`, `reorderLine`, `stockAge`, `abcClasses`, `turnover`, `daysOfCover`), with golden files.
  - **API** (`apps/api/src/reports/stock.ts`), each with `format=csv`, `reports.view`, values only with `cost.view`, and the date rules:
    - `GET /api/reports/stock-ledger` (`itemId`, `from`/`to` or `preset`, `locationId` optional);
    - `GET /api/reports/stock-at` (`at`, filters, `group`, `negative=only`);
    - `GET /api/reports/stock-movement` (`from`/`to` or `preset`, filters, `group`);
    - `GET /api/reports/reorder` (`supplierId`, `categoryId`, filters);
    - `GET /api/reports/dead-stock` (`days`, filters);
    - `GET /api/reports/inventory-analysis` (`from`/`to` or `preset`, `basis=sales|profit`);
    - the W1-20 stock report values stock from the stock ledger (question 2).
  - **Contracts:** the view types in `stock-reports.ts`.
  - **Back office:** the item picker; the six screens on the frame, in the Reports home's *Stock* section; the stock card's link to the ledger; drill-down to the stock documents; the i18n keys.
  - **Docs:** this plan's results, the reports README, the glossary (*stock at a date*, *reorder level*, *dead stock*, *slow stock*, *ABC class*, *days of cover*, *stock turnover*).
- **Out:**
  - purchase orders from the reorder list, and open POs in the reorder quantity (Wave 2, POs);
  - suggested minimum and maximum levels from sales;
  - stock forecasts and seasonality;
  - charts;
  - batch, serial or expiry tracking (none kept);
  - any legacy sales history: no bills (D-100) and no summary (answer 1).

## Tests written first

- **Domain (golden):**
  - **Movement summary:** one item with an opening, two receipts, a purchase return, sales, a return, an exchange, a void, an adjustment, a count and a transfer out and back; opening + buckets = closing in quantity and value, per location and over all; a transfer still in transit.
  - **Reorder:** at the minimum, below it, below zero, above it; both levels 0; maximum below minimum; excluded and discontinued; fractional quantities (1.5 m of hose).
  - **Dead and slow:** never sold, sold 91 days ago with N = 90, sold yesterday with 300 days of cover, sold out (nothing on hand); an item not sold since go-live, before and after N days have passed since the opening.
  - **ABC:** 80/15/5 on ten items, ties, an item exactly on a limit, no sales, negative profit; by sales and by profit.
  - **Turnover and days of cover:** zero average stock, no sales, a one-day period.
- **API (integration, under RLS):** a shop with opening stock (W1-14) in the Shop and the Godown, goods receipts and a purchase return, counter sales with a return, an exchange and a void, a transfer Godown → Shop, an adjustment and a count, over two months. Checks:
  - stock at today equals `stock_balances` per item and location;
  - stock at any date's value equals Inventory on the balance sheet for that date (W2-01), to the paisa, and the W1-20 stock report's total now equals it too;
  - stock movement's opening equals stock at the day before `from` and its closing equals stock at `to`, per item;
  - the stock ledger's closing equals stock at `to`, and each line opens its document;
  - the reorder list's quantities and supplier groups; dead and slow on known dates; ABC classes;
  - another tenant's stock never appears; a cashier is refused; someone without `cost.view` gets no value, cost or profit;
  - ranges over the limit get `range_too_long`; the CSV has every row and the same totals;
  - 19,500 items and a year of generated movements (100 bills a day): stock at a date, stock movement and the reorder list each answer in under 2 s.
- **Back office (component):** the item picker finds by code, name, OEM and scan; grouping and subtotals; *only below zero*; value columns hidden without `cost.view`; the 2,000-row note; drill-down links carry the period; every string translated.
- **e2e:** after the counter's sales (counter.spec) and the stock moves (stock.spec):
  - stock at today shows the same Shop and Godown stock as the items list;
  - a sold item's stock ledger opens the bill's trace;
  - the reorder list shows an item below its minimum under its supplier, and prints;
  - stock movement downloads as CSV.

## Verify

- `pnpm check`, `pnpm test:integration`, `pnpm e2e`.
- On a copy of `erp_dev` after the opening (W1-14): stock at 31 Dec 2026 equals the opening stock, item by item, and so the legacy *Item Wise Closing Stock* on the cutoff day (D-102); its value equals Inventory on the balance sheet.
- On staging with the pilot's documents:
  - stock at today's value equals the balance sheet's Inventory and the stock report's value;
  - the reorder list for one supplier, compared by the purchaser with the legacy *Item Order Register* on the same day (the legacy app is still in use until go-live);
  - each report prints on A4 and downloads as CSV.

## Order

1. Domain golden files, then `stock-reports.ts`.
2. The API: stock at a date and the stock ledger, stock movement, the reorder list, the W1-20 value change; then dead and slow stock; inventory analysis last. Integration tests with each.
3. The item picker and the screens, in the same order.
4. e2e.
5. Docs: this plan's results, README, glossary, task list.

## Risks

| Risk | Mitigation |
|---|---|
| Stock at a date disagrees with the balance sheet or the stock report | Both read the same movements' values (question 2); the integration test ties them to the paisa on several dates |
| Slow on 19,500 items and a year of movements | One aggregate per period over the existing index on (tenant, item, posting order); timed on a generated year, with statistics as autovacuum keeps them (W2-01's lesson). If it misses 2 s, one index on (tenant, business date) in a new migration |
| A void or exchange counted the wrong way in the movement | Buckets in one pure function, golden-tested with a void and an exchange; closing is checked against the ledger on every row |
| Dead stock, recent sales and ABC look empty or wrong in the first months | Answer 1: they say *since 1 Jan 2027*, and an item counts as dead only once N days have passed since the opening (golden-tested) |
| The 3 days run long | The order puts the reports the shop uses today first; dead and slow and the analysis are last and can follow in W2-04 |
