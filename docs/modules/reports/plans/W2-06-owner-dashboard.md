# W2-06 The owner's dashboard

| | |
|---|---|
| **Issue** | [#198](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/198) |
| **Module** | reports (a back-office screen and one read endpoint) |
| **Status** | Accepted (owner, 2026-11-20): the design on the prototype, and questions 1–6 as recommended. Built, waiting for review |
| **Refs** | RPT-18 (new); CLAUDE.md rules 1, 4, 5, 10; D-066, D-067 (the look), D-110 (reports read the ledgers), D-114 (the frame, the first screen), D-116 (the reports), D-117 (the business date), D-118 (this dashboard) |
| **Depends on** | W2-01 to W2-04 (every figure's report and the report frame's filters in the address), W2-03 (the chart components), W1-20 (overrides, voids and returns, exceptions) |
| **Size** | about 3 days: domain golden files ½; extracting the report queries and the endpoint with integration tests 1; the screen and two new chart pieces 1; e2e and docs ½ |
| **Test-first** | Yes: the comparison windows, the change chips, *unusual*, the donut's slices and a loss month, the biggest balances and the rest (golden, `packages/domain`); every dashboard figure equals its report's, under RLS, and only the owner may read it (integration); the owner lands on the dashboard and a card opens its report, while a manager has no dashboard (e2e) |

## Goal

**When the owner signs in, one screen shows how the day is going, where the money is, and what needs them. Every figure is the same one its report shows, and a click opens that report with the same filters.**

The design is the agreed prototype (layout A, *today first*). It is a private design artifact, so the owner's choices are written out here.

## Owner answers already given (2026-11-20, on the prototype)

1. **Layout A:** today first, with what needs attention beside the sales trend.
2. **Only the owner sees it;** everyone else keeps today's first screen.
3. **Five key figures in one row**, evenly spaced: **net sales, gross profit, cash, bank, customers owe us.** Bills and average bill are not key figures; they appear in the net sales card's details. Cash and bank are separate cards.
4. **A minimal card:** label, an icon at the top right, the figure, one change chip. A coloured strip on the left is clipped by the rounded corners: orange for the two period figures and blue for the three balances. Details show on hover, not on the card. **No sparklines.** No group gap and no *Now* caption: the comparison text sits beside the period switch.
5. **Discounts, returns and voids** replaces the payment-method split. It has four plain rows (discounts given, sold below list, returns, voids and reissues), each with a count and an amount, and an amber *× usual* chip only when a figure is unusual.
6. **What customers owe us** has no ageing: the total, the five biggest balances, and the rest on one line.
7. **Expenses are shown as this month's gross profit split into net profit and the expenses**, as a donut above a full-width legend. *Other expenses* is grey.

## The screen

| Part | What it shows | Opens |
|---|---|---|
| **Header** | *Dashboard*, the business date, when the business day opened and when the figures were read. *Compared with …* beside the period switch: **Today · 7 days · 30 days** | |
| **Net sales** | Net sales in the period and the change against the comparison. Details: the comparison's figure, the number of bills and the average bill | Sales and gross profit (RPT-07), same period |
| **Gross profit** | Gross profit with its margin, and the change. Details: the comparison's figure and margin. Since W2-09 (D-124) it includes the period's cost corrections for stock sold before it arrived: Sales and gross profit's *Gross profit in the books* | Profit and loss, same period |
| **Cash** | Cash now, and the change since the business day began (question 1). Details: the open drawers and the cash in the safe | Cash book |
| **Bank** | Bank and wallet balances now, and the change today. Details: each account | Cash book (the bank accounts) |
| **Customers owe us** | What customers owe now, and the change over 30 days, in red when it rises. Details: the number of customers and what was received today | Customer outstanding (RPT-06) |
| **Sales trend** | This period's line against the comparison's (dashed): by hour today, by day for 7 and 30 days | Sales over time (RPT-15) |
| **Needs attention** | Up to six lines, the most serious first: open high-severity exceptions; counters not seen (question 5); items at or below their minimum; customers over their limit; items in negative stock; open cash sessions | Exceptions, Counters, Reorder list, Over limit, Stock, Day reconciliation |
| **Busy hours** | Bills per hour by weekday, averaged over the last 4 weeks (W2-03's grid) | Sales over time |
| **Top categories** | The top 6 categories by net sales in the period, and *Everything else* | Sales and gross profit, by category |
| **Discounts, returns and voids** | Four rows for the period, each with a count and an amount; the amber chip follows question 3. Details: the comparison's figures, who approved the overrides, the most common return reason | Overrides (RPT-03), voids and returns (RPT-04), discounts in sales over time |
| **Expenses and net profit** | This month's gross profit as a donut: net profit, the two biggest expense categories, and the rest as *Other expenses* (question 4). The centre shows the share kept as profit. The legend has every slice's amount and the gross profit total | Profit and loss, this month |
| **What customers owe us** | The total, the five biggest balances with bars, and the rest | Customer outstanding; each customer opens their ledger (RPT-16) |
| **We owe suppliers** | The total, overdue, and due in the next 7 days, with the next three due dates | Supplier outstanding, overdue |
| **Stock** | Value in the books, items at or below minimum, items in negative stock, items with no sale in 90 days | Stock, Reorder list, Dead stock |
| **Best-selling items** | The top items in the period by net sales | Sales and gross profit, by item |
| **Salesmen** | Net sales and bills by salesman in the period | Sales and gross profit, by salesman |

- **Narrow windows** stack the cards. On a phone, net sales comes first with its trend, then the other key figures two by two.
- **Every string is an i18n key.** CSS uses logical properties, and numbers use the tenant's format (rule 10).
- **Before go-live and in the pilot,** a comparison that reaches back before the first business day says *before go-live* instead of showing zeros, as the reports do (W2-03).

## Owner answers (2026-11-20)

1. **Cash** = the open drawers' expected cash + the cash in the safe + cash in transit; **Bank** = the bank and wallet accounts, with card clearing left out and shown in the details. Both change chips compare with the balance when the business day began.
2. **Today is compared with the same weekday last week, up to the same time of day.**
3. **Unusual** = at least 1.5 times the comparison's count, and at least 3.
4. **The donut** shows net profit, the month's two biggest expense categories by name, and *Other expenses*. A loss month shows the expenses only, with the loss in red in the centre.
5. **A counter needs attention** when it hasn't been seen for 10 minutes while its cash session is open; the line says for how long.
6. **The figures are read** on open, on a period change, and every 5 minutes while the tab is visible.

## Questions for the owner (each with a recommendation)

1. **What *Cash* and *Bank* include.**
   *Recommended:*
   - **Cash = the open drawers' expected cash + the cash in the safe + cash in transit between them**, from the books (`CASH_DRAWER`, `CASH_SAFE`, `CASH_IN_TRANSIT`).
   - **Bank = the balances of the bank and wallet accounts** (`bank_accounts` of kind `bank` and `wallet`). Card money not yet in the bank (`card_clearing`) is left out and shown in the bank card's details.
   - **The change chip compares with the balance when the business day began** (04:00).

   *Otherwise:* card clearing counted in Bank, or the change since yesterday's close.
2. **What *Today* is compared with.**
   *Recommended:* **the same weekday last week, up to the same time of day**, so a Friday morning is compared with last Friday morning (Friday prayers, a quiet Sunday).
   *Otherwise:* yesterday up to the same time (weekdays differ a lot in this shop), or the average of the last four of the same weekday (smoother, but harder to check against a report).
3. **When a discount, return or void figure is *unusual*.**
   *Recommended:* **at least 1.5 times the comparison period's count, and at least 3**, so 2 voids against 1 is not flagged. The chip says how many times, for example *2.5× usual*.
   *Otherwise:* any increase, or only when a figure is double.
4. **The donut's slices, and a month with a loss.**
   *Recommended:*
   - **The two biggest expense categories this month by name** (Salaries and Rent today), and the rest as *Other expenses*, so the donut never has more than four slices.
   - **In a month where expenses exceed gross profit,** the ring shows the expenses only, and the centre shows **the loss in red**. The legend's first line becomes *Net loss*.

   *Otherwise:* fixed slices (Salaries, Rent, Other) whatever the month.
5. **When a counter *needs attention*.**
   *Recommended:* **a counter enrolled in this shop that has not been seen for 10 minutes while its cash session is open** (from the device's last contact). The server can't know how many bills are waiting on a counter that can't reach it, so the line says how long it has been, not how many bills.
   *Otherwise:* any counter not seen for 10 minutes, open or not.
6. **How fresh the figures are.**
   *Recommended:* read **when the screen opens and when the period changes, then every 5 minutes while the tab is visible**, with *updated 18:05* in the header. Nothing is pushed live.
   *Otherwise:* only on open and on a refresh button.

## Design

| Decision | Why |
|---|---|
| **One endpoint, `GET /api/dashboard?period=today\|7d\|30d`,** returns the whole screen as one view (`DashboardView`), read inside one `withTenant`, at one moment. It needs `dashboard.view` | One request for one screen, and every figure is read at the same moment, so the cards agree with each other |
| **The endpoint calls the reports' own queries.** The queries behind the dashboard's figures move out of their route handlers into named functions in `apps/api/src/reports/` (for example sales totals, profit and loss, account balances, outstanding by party, overdue suppliers, reorder and negative-stock counts, exception counts, the hour grid). The report routes and the dashboard both call them | The dashboard can't drift from a report. The reports' integration tests run unchanged before and after the move |
| **No new tables, no migration, no cache,** computed on request | Rule 4 and D-110 |
| **Pure logic in `packages/domain` (`dashboard.ts`), golden-tested:** the period and comparison windows on the business date (*same time last week*), the change chip (a percentage in basis points, or an amount, with *good when up* or *down*), *unusual* (question 3), the donut's slices with the loss case (question 4), and the biggest balances with the rest | Rule 1 and rule 2's spirit: one definition each, shared by the screen and the tests |
| **The permission:** `dashboard.view` is added to the catalog; the owner holds it through `*`, and no other template gets it. The menu's first row is *Dashboard*, shown only with the permission, so the owner's first screen becomes the dashboard (D-114's rule, unchanged) | D-118 |
| **Charts:** W2-03's `TrendChart`, `HourGridChart` and `BarList`, plus a **`DonutChart`** and a **`StatCard`** (the key-figure card with its clipped strip) in `reports/frame/`. All are SVG we draw, with no chart library | As W2-03 |
| **Colours:** `--chart-1` (orange) and `--chart-2` (blue) as today, plus a new **`--chart-3`** (teal: `#008f82` light, `#22a99b` dark). The three hues passed the dataviz validator for every pair in both modes. *Other expenses* uses the muted grey | Purple failed against blue on the prototype, even for normal vision |
| **Details on hover and focus:** a small popover (Radix tooltip, shadcn/ui) on each key figure and row, reachable by keyboard; every card is a link to its report | Keeps the cards minimal (owner answer 4) without hiding the figures from keyboard users |
| **The links carry the filters:** each opens its report through the report frame's address (W2-04's filters in the address) with the dashboard's period | *Every card opens its report with the same filters* |
| **Permissions inside the view:** the owner holds everything, so the endpoint checks only `dashboard.view`. It still leaves out cost and profit for anyone without `cost.view`, so a role given the dashboard later can't see more than its reports | No leak if the permission is ever shared |

## Scope

- **In:**
  - **Domain:** `dashboard.ts` with golden files.
  - **API:**
    - the query functions extracted from the report routes, with no change in what they return;
    - `GET /api/dashboard`;
    - the `DashboardView` contract.
  - **Permissions:** `dashboard.view` in the catalog, and its menu row.
  - **Back office:**
    - the dashboard screen;
    - `StatCard` and `DonutChart`;
    - the `--chart-3` token;
    - the details popovers;
    - the i18n keys in `locales/en.json`.
  - **Docs:**
    - this plan's results;
    - the reports README (RPT-18 and this task);
    - the glossary (*key figure*, *needs attention*).
- **Out:**
  - dashboards for other roles, and choosing or moving cards;
  - targets and forecasts;
  - live updates pushed from the server;
  - anything from the legacy app's sales (D-100);
  - a printed or CSV dashboard (each report has its own).

## Tests written first

- **Domain (golden):**
  - **Windows:** today at 10:30 against last week's same weekday to 10:30; a business day across midnight (a bill at 02:00 belongs to the day before); 7 and 30 days against the periods before; a range that starts before the first business day (*before go-live*).
  - **Change chip:** up, down, a zero base, a figure where up is bad (what customers owe); rounding half away from zero.
  - **Unusual:** 5 against 2 (yes, 2.5×), 2 against 1 (no: fewer than 3), 3 against 2 (yes, 1.5×), against zero.
  - **Donut:** a month with profit (four slices adding up to the gross profit); a month with one expense category; a loss month; zero gross profit.
  - **Biggest balances:** five and the rest; fewer than five; credit balances left out of the five.
- **API (integration, under RLS):** a shop with opening balances, two salesmen's sales, a bill discount, an override, a return, a void and reissue, an expense voucher, a customer receipt, a supplier bill due in 3 days and one overdue, an item at its minimum, a negative-stock sale and an open cash session. Checks:
  - every dashboard figure equals its report's for the same filters: net sales, gross profit and margin (sales and gross profit, profit and loss), cash and bank (cash book and balance sheet), what customers owe and the top balances (outstanding), supplier overdue and due (overdue), discounts, overrides, returns and voids (sales over time, overrides, voids and returns), the attention counts (exceptions, reorder, over-limit, stock), the hour grid, the top categories, items and salesmen;
  - this month's donut adds up to gross profit on the profit and loss, and its expenses to the expenses report;
  - each period's comparison equals the same figure read over the comparison window;
  - the owner gets the view; a manager, an accountant and a cashier get 403; another tenant's figures never appear;
  - the reports' existing integration tests pass unchanged after the queries move;
  - **a year of generated sales** (W2-03's): the endpoint answers in under 1.5 s.
- **Back office (component):**
  - the period switch reloads and changes *Compared with …*;
  - a change chip in green or red by *good when up*;
  - the details popover by mouse and by keyboard;
  - the donut's legend, its loss state and its hover;
  - each card's link carries the filters;
  - every string translated.
- **e2e:** after the counter's sales (counter.spec):
  - the owner signs in and lands on the dashboard, and today's net sales equal the sales register's total;
  - the net sales card opens sales and gross profit for today;
  - a manager signs in, sees no *Dashboard* in the menu, and the dashboard's address opens their usual first screen instead.

## Verify

- `pnpm check`, `pnpm test:integration`, `pnpm e2e`.
- On staging with the pilot's documents, the owner compares the dashboard with the reports it opens for Today, 7 days and 30 days, in light and dark mode, on a laptop and a phone.

## Changes during the build

| Change | Why |
|---|---|
| **The dashboard's sales are read in one pass** (`salesSets`: totals, categories, salesmen, items, days and bills by grouping sets over the reports' own `LINES`), once for the period and once (twice for Today) for the comparison | Seven separate passes took 1.8 s on the generated year |
| **Four groups are read in parallel**, each in its own tenant transaction: sales (two connections), stock, customers and suppliers, the books. At most six of the pool's ten connections, so the counters' sync isn't starved | The plan's mitigation for a slow read: one transaction took 2.3 s on the generated year; now under 1.5 s (the integration test's limit) |
| **We owe suppliers shows the total, overdue and due in the next 7 days**, without the next three due dates. Due in 7 days = not yet due today − not yet due in 7 days, from the supplier outstanding report's own buckets (RPT-06) | The ageing rule settles the oldest bills first; listing the next due dates would need a second rule beside it |
| **For Today, discounts compare with last week to the same minute; price approvals, returns and voids with the whole of last week's day** | Approvals, returns and voids are read from their reports' queries, which are by date only |
| **Sold below list is (list − price) × quantity of the approved lines**; the overrides query also returns the line's quantity and the approver's id (for *approved by you*) | The overrides report shows prices, not quantities |
| **Negative stock counts items below zero across every location**; the reorder list and dead stock (no sale in 90 days, *dead* and *not sold since go-live*) are their reports' | As the stock report and the stock reports |
| **An unknown period is `invalid_preset`** (a 400), not a new error code | It is the same kind of mistake as an unknown report preset |
| **No migration for `dashboard.view`**: roles keep their permissions as a list of names, and the owner's is `*` | Nothing in the database lists permissions |
| **The shell's e2e flow** now expects the owner to land on the Dashboard | D-118 amends D-114's first screen for the owner |

## Order

1. Domain golden files, then `dashboard.ts`.
2. Move the report queries into functions, with the reports' integration tests green and unchanged.
3. The endpoint and its integration tests; time it on the generated year.
4. `dashboard.view`, the menu row, `StatCard`, `DonutChart` and `--chart-3`, then the screen card by card in the table's order.
5. e2e, then docs.

## Risks

| Risk | Mitigation |
|---|---|
| Moving the report queries changes a report | The move is its own commit, with the reports' integration and e2e tests unchanged and green before the dashboard uses them |
| One endpoint reading so much is slow | Timed on the generated year (under 1.5 s). If it is slower, the independent parts run in parallel on separate pooled connections, each still in `withTenant` |
| The dashboard disagrees with a report | Both call the same function; the integration test compares every figure with its report |
| A card opens its report with different filters | The links are built from the same address helpers as the report frame's, and tested |
| The owner's first screen changes under someone else's sign-in | Only `dashboard.view` shows the row, and only the owner holds it; tested with a manager in e2e |
| The 3 days run long | Best-selling items and salesmen are last and can follow in their own PR; the key figures, attention and donut come first |
