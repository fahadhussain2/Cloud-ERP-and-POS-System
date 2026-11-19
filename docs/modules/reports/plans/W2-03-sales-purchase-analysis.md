# W2-03 Sales and purchase analysis: sales and gross profit, purchase register, purchase and sale rates, sales over time

| | |
|---|---|
| **Issue** | [#178](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/178) |
| **Module** | reports (back-office screens and API, read only) |
| **Status** | Written, waiting for the owner's answers to questions 1–6 |
| **Refs** | RPT-07, RPT-09, RPT-15; CLAUDE.md rules 1, 3, 4, 5, 10; D-017 (one average cost per item), D-044 (a return's cost), D-100 (no legacy bills), D-105 (purchase discounts in the cost), D-110 (reports read the ledgers), D-116 (reports before go-live) |
| **Depends on** | W2-01 (the frame, periods and comparisons, the Reports home), W2-02 (the item picker, the report choices), W1-20 (the sales register), W1-16 (goods receipts and purchase returns); **the bill-discount posting fix** (see Risks) for the tie to the profit and loss |
| **Size** | about 3 days: domain golden files ½; API with integration tests 1; four screens and the first charts 1; e2e and docs ½ |
| **Test-first** | Yes: line profit and margin, the grouping by period, returns against their original bill, rate statistics, the hour × weekday grid, top and bottom (golden, `packages/domain`); every report under RLS, its permission and its ties to the books (integration); sales and gross profit → bill, purchase register → receipt, the rates for an item, a chart printed (e2e) |

## Goal

**The owner and the manager see what sold, at what price and what profit, who sold it and to whom; the purchaser sees what was bought from whom and at what rate against what it sells for; and the owner sees when the shop is busy and what discounts are given. Every figure opens the bills or receipts behind it, on the W2-01 frame.**

- **Sales and gross profit (RPT-07):** sales, cost, profit and margin by item, category, brand, vehicle make, salesman, customer, bill, day or month, compared with another period.
- **Purchase register (RPT-09):** every goods receipt and purchase return in a range, by supplier.
- **Purchase and sale rates (RPT-09, legacy parity):** for an item, a supplier or a customer, every purchase and sale with its rate, and the spread between them. The legacy app's four variants (item purchase rate, item sale rate, partner purchase rate, partner sale rate) become one report.
- **Sales over time (RPT-15, last):** the daily trend, the busy hours of the week, the top and bottom items, and the discounts given. The first charts.

## Owner answers already given (D-116, 2026-11-18)

Four tasks; this is the third (1). Everything by go-live, the new analysis last (2): here, *sales over time*. 2026 stays in the legacy app, read-only; every report starts at 1 Jan 2027 (3). Lists of documents or lines up to 92 days, summaries up to a year with a comparison period (4). CSV and a print layout, PDFs from the browser (5). Sales reports for `reports.view`; cost and profit also need `cost.view`, left out by the API (6). Modern design; the legacy *Daily Sales Register* (its item list and bill-wise profit) and *Item Purchase and Sale Rate Analysis* give meaning only.

## What the data looks like

- **`erp_dev` has no bills and no purchases**: the new system's sales start at go-live (D-100), so the reports are designed on the documents the counter and the back office write, and timed on a generated year.
- From the catalog: 19,552 items in 267 categories; **12,899 have a brand** (300 brands), the rest are grouped under *No brand*; 17,265 fit a vehicle make (21 makes); 131 customers with an account and 281 suppliers.
- **Who reads them:** `reports.view` and `cost.view` are both held by the owner, manager, purchaser and accountant, so all four see cost and profit; the API still leaves them out for anyone without `cost.view` (custom roles later).
- **What a bill line holds** (`sales_lines`): quantity, list price (the bill tier's), the price charged, the line discount (list − price), its share of the bill discount, and **`line_total` = the amount after both discounts**, which is what the customer paid for that line. Its cost is its stock movement's value (`stock_movements`, the average at the time, D-017). No tax and no rounding on any bill so far (the e2e shop's 27 bills).
- **Returns and exchanges** are bills with negative lines (W1-13), each linked to the line it returns when the receipt is known. **A void** reverses its bill in the books on the bill's own date (W1-12), so a voided bill nets to nothing.
- **Purchases** (`goods_receipts`, `purchase_returns`): the supplier, the supplier's bill number and date, the location, each line's quantity, its cost on the bill, its line discount, and **its net value after the bill discount** (D-105: purchase discounts go into the cost).

## Questions for the owner (each with a recommendation)

1. **The cost behind gross profit.**
   *Recommended:* **the cost in the books**: each line's cost is the average cost when it was sold (its stock movement), so the report's gross profit for a period equals gross profit on the profit and loss, to the paisa.
   *Otherwise:* the current average cost or the last purchase cost. Those change after the sale, so last month's profit would change every time stock is bought, and wouldn't match the books.
2. **Returns and voids: which day, and whose figures.**
   *Recommended:*
   - **A return counts on the day it was made** (as in the books), as negative sales and negative cost.
   - **It counts against the salesman and customer of the bill it returns**, when that bill is known; a return with no receipt counts against whoever took it back. So a salesman's figures are what they sold and kept sold.
   - **A voided bill is left out entirely**, and its reissue counts (the books net them the same way).
   *Otherwise:* a return counts against the salesman who took it back.
3. **Sales and gross profit: the views.**
   *Recommended:*
   - **Group by** item, category, brand, vehicle make, salesman, customer (walk-ins together as *Walk-in*), bill, day or month. **The first view is by category**; a click on a category opens its items, a click on an item opens its bills, a bill opens its trace.
   - **Columns:** quantity, sales (what the customers paid), discount given, cost, gross profit, margin %; and the same period's sales and profit before, with the change (*compared with the previous period* by default, or *the same period last year*, or none, as the profit and loss).
   - **Up to a year**; *by bill* is a list of bills, so up to 92 days (the legacy bill-wise profit).
   - Filters: category, brand, make, salesman, customer, location, and a search by item.
4. **Purchase and sale rates: one report, and how far back.**
   *Recommended:* **one report for an item, a supplier or a customer** (or an item and a party together):
   - **Purchases:** date, supplier, the supplier's bill number, quantity, the rate on the supplier's bill, and the **net rate** after the line and bill discounts (what it cost the shop).
   - **Sales:** date, customer or walk-in, salesman, bill, quantity, list price, price charged, and the net rate after the bill discount.
   - **At the top, for each side:** the last, lowest, highest and average net rate, and **the spread**: average net sale rate − average net purchase rate, and as a margin %.
   - **Up to a year**, although it lists lines: it is for one item or one party, so a year is a few hundred lines at most. This widens D-116 answer 4 (lists up to 92 days) for this report only.
   - Purchase rates and the spread need `cost.view`; without it, sale rates only.
5. **Sales over time: what each view shows.**
   *Recommended:*
   - **Daily trend:** sales and gross profit by day, with the comparison period as a second line; by week when the range is over 92 days, by month over a year.
   - **Busy hours:** a grid of weekday × hour, **counting bills** (a switch shows sales instead), from each bill's time on the counter. The shop's day starts at 04:00, so 00:00–03:59 counts in the previous day, as everywhere else.
   - **Top and bottom items:** the **top 20 by sales** (switches: by profit, by quantity); the **bottom 20 are the items that sold least but did sell**. Items that didn't sell at all are in *dead and slow stock* (W2-02).
   - **Discounts given:** see question 6.
   - **Every chart has its table beneath it**, prints with the report, and the CSV has the table.
6. **Discounts given: what counts.**
   *Recommended:* **list price × quantity − what the customer paid**, so both the line's discount and its share of the bill discount count. Shown by salesman and by day, in rupees and as a % of sales at list price, with the number of approvals (each opens the overrides report, W1-20).
   - A price above the list counts as a negative discount, so a salesman's figure is their net discount.
   - A line with no list price (an item without a price on that tier) counts no discount.

## Design

| Decision | Why |
|---|---|
| **Read only, computed on request** from `sales_documents`, `sales_lines`, `stock_movements`, `goods_receipts`, `goods_receipt_lines`, `purchase_returns`, `purchase_return_lines`, `items`, `parties`, `users`, inside `withTenant`. No report tables, no migration (unless the timing test needs an index; see Risks) | Rule 4 and D-110: the bills and the ledgers are the truth |
| **A sale line's figures:** sales = `line_total` (after both discounts, negative for a return); cost = −its stock movements' value (positive for a sale, negative for a return); profit = sales − cost; discount = list × quantity − `line_total`. Finalized bills only, **by the bill's business date** | Over a period, Σ sales = net sales on the profit and loss (sales − returns − discounts) and Σ cost = cost of goods sold, once the bill-discount fix is in |
| **Line figures, the grouping by day, week and month, margin, the comparison's change, rate statistics, the hour × weekday grid, top and bottom** are pure functions in `packages/domain` (`sales-reports.ts`), on integer minor units and thousandths, golden-tested; margin and shares in basis points, rounded half away from zero | Rule 1; one definition each, shared by the screens, the CSV and the tests |
| **Returns** follow question 2: the return's own date; the original bill's salesman and customer when `original_line_id` is set | One rule, golden-tested with an exchange and a no-receipt return |
| **Groups reuse W2-02's `groupRows`** and its choices (category, brand, make, location from `/api/reports/stock-choices`), plus salesmen and customers | Same grouping and subtotals as the stock reports |
| **Comparison** uses W2-01's periods (`previous`, `last-year`, `none`); until the shop has been open for the comparison period, it says *before go-live* instead of showing zeros | D-116 answer 4; no figure pretends to cover days the system didn't see |
| **Purchase register:** posted receipts and returns only (drafts are not purchases yet), each with its supplier, supplier's bill number and date, location, total, paid by bank or on account, and due date; subtotals by supplier; a switch to show each document's lines. A return is negative | Ties to the Inventory debits from purchases in the books over the period |
| **Rates:** the purchase net rate = line value ÷ quantity, the sale net rate = `line_total` ÷ quantity, both shown rounded to the paisa; averages are weighted by quantity (total value ÷ total quantity), never an average of rates | An average of rates gives a one-piece sale the weight of a carton |
| **Charts:** three small components in the back office (bars and lines over time, the hour × weekday grid, a horizontal bar list for top and bottom), drawn as SVG by us, with no chart library. Colours from the theme tokens, CSS logical properties, numbers in the tenant's format, readable in black and white on A4 | Three simple shapes don't need a library's weight; prints and right-to-left come for free |
| **Hours** come from the bill's time on the counter (`created_at_device`) in the shop's time zone; the weekday is the business date's | The counter's clock is when the customer was there; the 04:00 cut-off keeps late bills on their business day |
| **Drill-down:** a group row opens the next level (category → items → bills); a bill opens its trace; a receipt or return opens its document; a rate line opens its document | W2-01's `documentHref` |
| **Permissions:** every report needs `reports.view`; cost, profit, margin, purchase amounts and purchase rates only with `cost.view`, left out by the API | D-116 answer 6, D-110 |
| **Big lists:** by item can have ~19,500 rows over a year. The screen shows the first 2,000 in the chosen order with totals over every row; the CSV has every row | As the stock reports |
| **Until go-live** the reports show the pilot's documents; the pilot wipe (D-101) clears them | Nothing new to wipe |

## Scope

- **In:**
  - **Domain:** `sales-reports.ts` (`saleLineFigures`, `periodBuckets`, `margin`, `change`, `rateStats`, `hourGrid`, `topAndBottom`, `discountGiven`), with golden files.
  - **API** (`apps/api/src/reports/sales.ts`), each with `format=csv`, `reports.view`, cost and profit only with `cost.view`, and the date rules:
    - `GET /api/reports/sales-profit` (`from`/`to` or `preset`, `group`, `compare`, filters);
    - `GET /api/reports/purchase-register` (`from`/`to` or `preset`, `supplierId`, `lines=1`);
    - `GET /api/reports/rates` (`itemId` and/or `partyId`, `side=purchases|sales|both`, range up to a year);
    - `GET /api/reports/sales-over-time` (`from`/`to` or `preset`, `compare`, `measure`);
    - `GET /api/reports/sales-choices` (salesmen and customers for the filters, with `reports.view`).
  - **Contracts:** the view types in `sales-reports.ts`.
  - **Back office:** the four screens on the frame, in the Reports home's *Sales and purchases* section; a party picker (supplier or customer) beside W2-02's item picker; the three chart components; the item screen and the customer and supplier screens link to their rates; the i18n keys.
  - **Docs:** this plan's results, the reports README, the glossary (*gross profit*, *margin*, *net rate*, *spread*, *discount given*).
- **Out:**
  - sales targets and commissions;
  - forecasts and seasonality;
  - sales by counter or cashier (the sales register and day reconciliation have them, W1-20, W1-11);
  - purchase orders and what was ordered against received (Wave 2, POs);
  - customer profitability after payment terms, or anything from the legacy sales (D-100);
  - the built reports onto the frame (W2-04).

## Tests written first

- **Domain (golden):**
  - **Line figures:** a plain line; a line below list with a bill discount; a line above list; a line with no list price; a return with its cost (D-044); an exchange (one return, one sale); a fractional quantity (1.5 m of hose).
  - **Returns:** against the original bill's salesman and customer; a no-receipt return against the one who took it.
  - **Periods:** days, weeks and months over a range across a month and a year end; the comparison's change, with a zero base.
  - **Margin:** zero sales, a loss, rounding half away from zero.
  - **Rates:** weighted averages, lowest, highest, last; a single line; no purchases; the spread and its margin.
  - **Hour grid:** a bill at 03:30 on a Monday counts on Sunday's business day at 03; a bill at 23:59.
  - **Top and bottom:** ties, fewer than 20 items, items with zero or negative sales left out of the bottom.
  - **Discount given:** line discount plus bill share; above list; no list price.
- **API (integration, under RLS):** a shop with opening stock, goods receipts with a bill discount and a purchase return, counter sales by two salesmen to a customer and walk-ins, with a line discount, a bill discount, a return of a known bill, a no-receipt return, an exchange and a void, over two months. Checks:
  - **sales and gross profit over the period equal the profit and loss**: Σ sales = net sales, Σ cost = cost of goods sold, Σ profit = gross profit, to the paisa (after the bill-discount fix);
  - every grouping adds up to the same totals; the comparison column equals the report run on the previous period;
  - a return counts on its own day against the original salesman; the voided bill is nowhere, its reissue is;
  - the purchase register's total equals the Inventory debits from receipts less the returns' credits; drafts are left out;
  - the rates for an item: each line's net rate and the averages; for a supplier and for a customer;
  - the hour × weekday grid on known bill times around 04:00;
  - another tenant's sales never appear; a cashier is refused; someone without `cost.view` gets no cost, profit, purchase amounts or purchase rates;
  - ranges over the limit get `range_too_long` (by bill over 92 days, others over 366); the CSV has every row and the same totals;
  - a year of generated sales (19,500 items, 300 lines a day): each report answers in under 2 s.
- **Back office (component):** group switches and drill-down; the comparison columns; cost and profit hidden without `cost.view`; the party picker; each chart has its table and its labels; every string translated.
- **e2e:** after the counter's sales (counter.spec) and the supplier's bill (purchasing.spec):
  - sales and gross profit for today, by category, opens an item and then its bill's trace;
  - the purchase register shows the supplier's receipt and opens it;
  - the rates for an item sold and bought show both sides and the spread;
  - sales over time prints with its charts, and downloads as CSV.

## Verify

- `pnpm check`, `pnpm test:integration`, `pnpm e2e`.
- On staging with the pilot's documents:
  - sales and gross profit for the pilot's days equal the profit and loss's net sales and gross profit for the same days;
  - the purchase register for one supplier, compared by the purchaser with the receipts entered;
  - the rates for a few common items, read with the owner against what they know they pay and charge;
  - each report prints on A4 and downloads as CSV.

## Order

1. Domain golden files, then `sales-reports.ts`.
2. The API: sales and gross profit, then the purchase register, then the rates; sales over time last. Integration tests with each.
3. The party picker and the screens in the same order; the charts with sales over time.
4. e2e.
5. Docs: this plan's results, README, glossary.

## Risks

| Risk | Mitigation |
|---|---|
| **The bill discount is counted twice in the books today.** The counter stores each line's total after its share of the bill discount (`soldLinesOf`), and the sale's posting credits Sales with those totals *and* debits Sales discount with the bill discount (posting rules §4.1 assume totals before it). A Rs 9,700 bill with a Rs 200 bill discount posts Sales 9,500, Sales discount 200, and the 200 gap to Suspense. Net sales on the profit and loss come out too low by every bill discount | Found while writing this plan; a separate fix (failing test first, then the posting and a rebuild of the ledgers on staging; no live shop yet). This report reads the bills, so its figures are right either way; its tie to the profit and loss is checked after the fix |
| The report disagrees with the profit and loss | Both read the same lines and movements; the integration test ties sales, cost and profit to the paisa over a period with every kind of document |
| A return or exchange counted on the wrong side or for the wrong salesman | One pure rule (question 2), golden-tested with an exchange and both kinds of return |
| Slow on a year of sales | One aggregate per request over `sales_lines` joined to its movement by `source_line_id`; timed on a generated year. If it misses 2 s, an index on (tenant, business date) for bills, in a new migration |
| Charts are hard to read, print or translate | Three simple shapes, each with its table; checked in print and in the component tests |
| The 3 days run long | Sales over time is last and can follow in W2-04 (D-116 answer 2) |
