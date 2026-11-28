# Reports (`RPT`)

| | |
|---|---|
| **Status** | Done and verified on staging: [W1-20](plans/W1-20-reports-and-support.md) (sales register, overrides, voids and returns, stock and valuation, ageing, exceptions, Trace a bill); RPT-02 built in W1-11. **Every remaining report is pulled forward before go-live** (D-116) in four tasks, W2-01 to W2-04 ([catalog](#report-catalog-d-116)); W2-01 is built ([plan](plans/W2-01-report-frame-financial-statements.md), [#176](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/176)): the report frame, the Reports home and the financial statements, waiting for review. W2-02 is built ([plan](plans/W2-02-stock-reports.md), [#177](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/177)): the six stock reports, waiting for review. W2-03 is built ([plan](plans/W2-03-sales-purchase-analysis.md), [#178](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/178)): sales and gross profit, the purchase register, purchase and sale rates, sales over time, waiting for review. W2-04 is built ([plan](plans/W2-04-partners-control-cash-flow.md), [#179](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/179)): the partner ledger and statement, the balance trend, overdue and over-limit, collections and payments, user activity, the cash flow, waiting for review; moving the built reports onto the frame (its answer 8) is built in its own PR, waiting for review: all eight W1 reports are on the frame, with no figure changed. **Bill details** ([W2-10](plans/W2-10-bill-details.md), D-125): one bill's header, lines, totals, payments, approvals and related documents, read only, for anyone with `reports.view` (costs with `cost.view`); every bill number in the back office opens it. **Bills and Returns** ([W2-11](plans/W2-11-bills-returns-lists.md), D-126): the sales documents as lists under Sales, opening today, each row opening its bill's details |
| **Requirements** | 18 (RPT-01…RPT-18), plus ACC-07 (financial statements) and the list part of PUR-07 (reorder list) |
| **Feature spec needed** | No: the catalog below and each task's plan are enough |

## Scope

Daily sales register, day reconciliation, overrides, voids and returns, stock and valuation, ageing, exceptions (Wave 1, built). Before go-live (D-116): financial statements, day book and expenses; stock ledger, stock at a date and its movement; dead stock, the reorder list and inventory analysis; sales and gross profit, purchase analysis and sales over time; partner statements and control reports.

## Requirements

Full wording is in [the PRD](../../01-PRD.md). Wave 1 = critical path for go-live, Wave 2 = rest of the MVP. D-116 brings every Wave 2 report forward to go-live.

| ID | Summary | Wave |
|---|---|---|
| RPT-01 | Daily sales register (by bill, salesman, counter, tender) | 1 |
| RPT-02 | Day reconciliation and cash variance by session / cashier | 1 |
| RPT-03 | Overrides and below-list sales by salesman, item, approver | 1 |
| RPT-04 | Voids and reissues; returns by reason and condition, salesman, item | 1 |
| RPT-05 | Current stock by location; stock valuation | 1 |
| RPT-06 | Customer outstanding and ageing; supplier outstanding and ageing | 1 |
| RPT-07 | Sales and gross profit by item, category, brand, salesman, period | 2 (D-116: go-live) |
| RPT-08 | Dead/slow stock (no sale in N days, with value) | 2 (D-116: go-live) |
| RPT-09 | Purchase register; item purchase vs sale rate analysis (legacy parity) | 2 (D-116: go-live) |
| RPT-10 | Exceptions: below-floor sales without override, offline cap breaches, negative stock, clock skew, cash received for a voided bill, barcode amount not… | 1 |
| RPT-11 | Day book (every voucher in a range, with its lines) and expenses by category and month | 2 (D-116: go-live) |
| RPT-12 | Stock ledger: one item's movements in a range, with the opening, in, out, balance and value | 2 (D-116: go-live) |
| RPT-13 | Stock at any date, and its movement over a range (opening, purchases, returns, sales, adjustments, transfers, closing), in quantity and value | 2 (D-116: go-live) |
| RPT-14 | Inventory analysis: ABC by sales and by profit, stock turnover and days of cover | 2 (D-116: go-live) |
| RPT-15 | Sales over time: daily trend, hour × weekday, top and bottom items, discounts given | 2 (D-116: go-live) |
| RPT-16 | Customer and supplier ledger with its opening balance; printable statement; balance trend over past dates | 2 (D-116: go-live) |
| RPT-17 | Control: overdue and over-limit customers, collections register, user activity from the audit log | 2 (D-116: go-live) |
| RPT-18 | The owner's dashboard: key figures, the sales trend, what needs attention and the main reports' figures on one screen, each opening its report | 2 (D-118) |

## Report catalog (D-116)

The reports are designed the modern way: one frame for all of them (filters at the top, key figures, a sortable and searchable list, drill-down to the document, CSV and a print layout). The legacy reports in `legacy_reports/` (personal data, never committed) only show what each report is for and how its numbers are worked out; their layouts aren't copied (owner, 2026-11-18).

**Who:** financial reports need `reports.financial` (owner, accountant); the others `reports.view` (owner, manager, purchaser, accountant); cost, value and profit also need `cost.view`, left out by the API. Cashiers and salesmen see no reports. **Dates:** lists of documents or lines (registers, ledgers, day book) up to 92 days; summaries up to a year, with a comparison period; statements "as on" any date. **Output:** Download CSV and a print layout on every report; the browser's *Save as PDF* makes a PDF. **History:** 2026 stays in the legacy app, kept read-only for 3–6 months (D-100 stands): every report starts at the opening balances of 1 Jan 2027.

| Report | What it answers | Legacy equivalent | IDs | Task | State |
|---|---|---|---|---|---|
| **Accounts** | | | | | |
| Trial balance | Opening, movement and closing of every account, debit and credit, with group subtotals; always balances | Trial Balance | ACC-07 | W2-01 | Built |
| Profit and loss | Revenue, cost of goods sold, gross profit, expenses by group, net profit; compared with another period or month by month | Income Statement | ACC-07 | W2-01 | Built |
| Balance sheet | Assets, liabilities and equity on a date, with this year's profit; compared with another date | none | ACC-07 | W2-01 | Built |
| Account ledger | Every line of one account in a range, with its opening and running balance | Account Ledger | ACC-07 | W1-19, frame in W2-01 | Built, on the frame |
| Cash book | Each cash and bank account by day: opening, in, out, closing, and the documents | none | ACC-07 | W2-01 | Built |
| Day book | Every voucher posted in a range with its lines, by document type | none | RPT-11 | W2-01 | Built |
| Expenses | Expense accounts by month for up to a year | part of Income Statement | RPT-11 | W2-01 | Built |
| Cash flow | Money in and out of cash and bank by what it was for, transfers left out | none | ACC-07 | W2-04 (last) | Built; direct, month by month, each month equal to the cash book |
| **Stock** | | | | | |
| Stock now and its value | On hand by location, and its value in the books | Item Wise Closing Stock (today) | RPT-05 | W1-20 | Built, on the frame (W2-04 answer 8); since W2-02 valued from the stock ledger, equal to Inventory (W2-02 answer 2) |
| Stock ledger | One item's documents in a range: opening, in, out, balance, value | Stock Ledger | RPT-12 | W2-02 | Built; the stock card links to it |
| Stock at a date | On hand and value on any past date, by category and vehicle make | Item Wise Closing Stock | RPT-13 | W2-02 | Built |
| Stock movement | Per item: opening, purchases, purchase returns, sales, sales returns, adjustments and counts, transfers, closing | Stock Summary | RPT-13 | W2-02 | Built |
| Reorder list | Items at or below their minimum, the quantity to order up to the maximum, last supplier and cost, 30/90-day sales | Item Order Register | PUR-07 (list) | W2-02 | Built; turning it into POs stays with POs (Wave 2) |
| Dead and slow stock | Items with no sale in N days and their value | none | RPT-08 | W2-02 | Built |
| Inventory analysis | ABC by sales and by profit, turnover, days of cover | none | RPT-14 | W2-02 (last) | Built |
| **Sales and purchases** | | | | | |
| Sales register | Every bill of a day or range, totals by salesman, counter and tender | Daily Sales Register (bill-wise) | RPT-01 | W1-20 | Built, on the frame (W2-04 answer 8) |
| Sales and gross profit | Sales, cost and profit by item, category, brand, salesman, customer or period | Daily Sales Register (item list, bill-wise P&L) | RPT-07 | W2-03 | Built; equals net sales and cost of goods sold in the books, with the cost corrections for stock sold before it arrived on a line of their own (D-124, W2-09) |
| Purchase register | Every goods receipt and return in a range, by supplier | none | RPT-09 | W2-03 | Built |
| Purchase and sale rates | For an item or a party: every purchase and sale with its rate, and the spread | Item Purchase and Sale Rate Analysis (four variants become one report) | RPT-09 | W2-03 | Built; up to a year (W2-03 answer 4) |
| Sales over time | Daily trend, hour × weekday, top and bottom items, discounts | none | RPT-15 | W2-03 (last) | Built; the first charts |
| Overrides, voids and returns, exceptions | What was approved, undone or flagged | none | RPT-03, RPT-04, RPT-10 | W1-20 | Built, on the frame (W2-04 answer 8) |
| Day reconciliation, cash variance | The day's cash, by session and cashier | none | RPT-02 | W1-11 | Built, on the frame (W2-04 answer 8) |
| **Customers and suppliers** | | | | | |
| Outstanding and ageing | Each party's balance by how overdue it is (due-date buckets) | Business Partner Outstanding | RPT-06 | W1-20 | Built, on the frame (W2-04 answer 8) |
| Partner ledger and statement | One customer's or supplier's documents in a range with opening and running balance; a statement to print or send | Business Partner Ledger, Business Partner Activity | RPT-16 | W2-04 | Built: customers and suppliers, up to a year, the statement one at a time or for every customer |
| Balance trend | Each party's balance today and 15 days, 1, 2, 3 and 6 months ago | Business Partner Ageing (which shows balances at past dates, not overdue buckets) | RPT-16 | W2-04 | Built |
| Control | Overdue and over-limit customers, collections register, user activity | none | RPT-17 | W2-04 (last) | Built; user activity for the owner only |

**Order inside each task:** the reports the shop uses today first, the new analysis last (marked *last*), so anything that slips before 18 Dec is an extra, never the trial balance or the reorder list. **The built reports** (W1-11, W1-20) are on the frame too, moved in their own PR after W2-04 (its answer 8) with no figure changed: their APIs take two dates, so their presets are worked out on the shop's business date, and their dates aren't remembered, so each opens on the business date again (D-117).

## Tasks

| Task | What | Requirements | Depends on | Size |
|---|---|---|---|---|
| [W2-01](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/176) | The report frame (filters, presets, key figures, sortable list, drill-down, CSV, print) and the financial statements: trial balance, profit and loss, balance sheet, cash book, day book, expenses; the account ledger moves to the frame ([plan](plans/W2-01-report-frame-financial-statements.md)) | ACC-07, RPT-11 | W1-08, W1-19, W1-20 | 4 |
| [W2-02](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/177) | Stock reports: stock ledger, stock at a date, stock movement, reorder list, dead stock, inventory analysis ([plan](plans/W2-02-stock-reports.md), accepted) | RPT-08, RPT-12, RPT-13, RPT-14, PUR-07 (list) | W2-01 | 3 |
| [W2-03](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/178) | Sales and purchase analysis: sales and gross profit, purchase register, purchase and sale rates, sales over time ([plan](plans/W2-03-sales-purchase-analysis.md), built) | RPT-07, RPT-09, RPT-15 | W2-01 | 3 |
| [W2-04](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/179) | Customers and suppliers: partner ledger and statement, balance trend, control reports; the cash flow statement last; the built reports onto the frame ([plan](plans/W2-04-partners-control-cash-flow.md), built; the move of the built reports built in its own PR) | RPT-16, RPT-17, ACC-07 (cash flow) | W2-01 | 3 (+1 if time) |
| [W2-06](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/198) | The owner's dashboard: one screen for the owner with the key figures, the sales trend, what needs attention, and cards that open their reports ([plan](plans/W2-06-owner-dashboard.md), built, waiting for review) | RPT-18 | W2-01 to W2-04 | 3 days |

**Total ≈ 12 days**, from 23 Nov; go/no-go is 18 Dec. W2-02 to W2-04 each start with their own plan, after W2-01's frame exists.

## Related

PRD §6.8 and ACC-07; observability dashboards (architecture §11); D-110 (reports read the ledgers), D-116 (this catalog).

## Work in this module

- `spec.md`: only if needed (see above), written before the first plan that depends on it.
- `plans/<wave>-<nn>-<slug>.md`: one accepted plan per task, before any code ([delivery process](../../07-DELIVERY-PROCESS.md) §3).
- `intent.md`: only for changes after the MVP.
