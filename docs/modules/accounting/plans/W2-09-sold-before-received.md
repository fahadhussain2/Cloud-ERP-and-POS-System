# W2-09 Stock sold before it arrived: the cost is settled when it comes in

| | |
|---|---|
| **Issue** | to open after the plan is accepted |
| **Module** | accounting (`packages/posting`: the cost rule), with inventory (the stock card) and reports (sales and gross profit) |
| **Status** | Built (2026-11-25) on branch `fix/sold-before-received`, waiting for review; accepted by the owner the same day, question 1 as recommended |
| **Refs** | INV-02 (average cost), INV-03 (negative stock allowed), ACC-02 (the rebuild), RPT-07 (sales and gross profit); posting rules §5.1; data model §7; CLAUDE.md rules 1, 3, 4; D-015, D-017, D-101; D-124 (new, below) |
| **Depends on** | W1-08 (the engine), W1-16 (goods receipts), W1-13 (returns), W2-02 and W2-03 (the stock and sales reports) |
| **Size** | about 2 days: the cost rule and golden files ¾; the migration and the ledger writer ¼; the stock card and the gross profit report ½; integration tests, rebuild on staging and docs ½ |
| **Test-first** | Yes: the cost rule (golden, `packages/posting`), every inbound posting into negative stock (golden), the books against the stock and gross profit reports (integration) |

## Why

The shop sells a part it doesn't have (borrowed from another shop, or simply not yet received). The sale is never blocked (INV-03) and the stock goes below zero, which is right. The bill is costed at whatever the system knows then: the item's average, or **0** if it was never bought (`no_cost`).

When the stock comes in (a goods receipt from the other shop, a return), nothing goes back to the cost of what was sold. The quantity returns to 0, but the money doesn't:

| Example: sold 1, received 1 at Rs 3,200 | Sale | Goods receipt | Left behind |
|---|---|---|---|
| The item's average was Rs 3,000 | COGS 3,000, Inventory −3,000 | Inventory +3,200 | **Rs 200 in Inventory with 0 on hand**; profit Rs 200 too high |
| Never bought before (cost 0) | COGS 0, Inventory 0 | Inventory +3,200 | **Rs 3,200 in Inventory with 0 on hand**; profit Rs 3,200 too high |

Inventory in the books then carries value for stock that isn't there, and profit is overstated by the same amount. Today only a journal voucher can fix it, by hand, every time. Borrowing between shops is routine for Delux, so this would build up from the first week after go-live.

## What changes

**The rule (D-124):** stock that comes in while an item's on-hand is below zero first **covers the shortfall**. The units that cover it were already sold, so the difference between what they really cost and what the sales were costed at goes to **cost of goods sold**, in the same posting as the receipt. The sale itself is never touched (rule 3).

Applied to the two examples: Dr COGS Rs 200 / Cr Inventory Rs 200, and Dr COGS Rs 3,200 / Cr Inventory Rs 3,200. Both leave Inventory at 0 with 0 on hand.

| Choice | Why |
|---|---|
| **Where:** one pure function in `packages/posting/src/cost.ts`, `settleShortfall(state, { qty, value })` → `{ after, correction }`, used by every posting that brings stock in at a cost: goods receipt (`postGoodsReceipt`), returned lines (`comeBack` in `postSale`), voids (`postVoid`) and opening stock (`postOpening`). Stock adjustments come in at the average, and transfers don't change the tenant-wide on-hand, so their correction is always 0 and they don't need it. | One rule in one place, so the live posting and the rebuild can't disagree (rule 4) |
| **The shortfall is tenant-wide**, like the average (D-017): Shop −1 with Godown +1 is 0 on hand, so nothing needs settling. The per-location `negative_stock` alert and *Transfer needed* are unchanged | Cost is per item, not per location |
| **The figure:** with on-hand *h* < 0 and *q* units of value *V* coming in, the units that cover it are *n* = min(−*h*, *q*). Correction = their real cost (*V* × *n* / *q*, rounded half away from zero; exactly *V* when *n* = *q*) − what they were sold at (*n* × the average, 0 when none is known). Positive: Dr COGS / Cr INVENTORY; negative: the reverse; 0: no lines | The sold units are revalued at what they really cost; the units left over keep the receipt's own cost |
| **The average stays as it is while on-hand stays below zero.** It changes only when stock comes back to 0 or above, and it then becomes the receipt's own cost, as today | Every unit short was then sold at the same average, so *n* × average is exactly what those sales took out. Without this, a partial receipt would change the average and the next correction would be wrong |
| **The correction is its own stock movement:** `qty_delta` 0, `unit_cost` 0, `value_delta` −correction, on the same source, line and location as the movement that brought the stock in. The incoming movement keeps its full value, so a receipt line still shows the supplier's price | The stock ledger (Σ `value_delta`) stays equal to Inventory in the books, and the correction can be seen and reported on its own |
| **Migration `0025_cost_correction.sql`:** `stock_movements`' check becomes `qty_delta <> 0 OR (unit_cost = 0 AND value_delta <> 0)`, mirrored in `schema.ts`. Earlier migrations stay as they are | The only schema change: a movement of value with no quantity |
| **The stock card** shows a correction row as *Cost correction* (an i18n key), with no quantity, its value, and a link to its document | The accountant can see why the value moved |
| **Sales and gross profit (W2-03)** adds a line, **Cost corrections: stock sold before it arrived**, by item, in the period the stock came in (question 1) | The report keeps equalling cost of goods sold on the profit and loss, to the paisa |
| **Nothing changes** at the counter, in sync, on the receipt screens or in the documents | It is a posting rule; the documents already have everything it needs |

### Worked cases (they become the golden files)

| On-hand, average | Comes in | Correction | After |
|---|---|---|---|
| −1, Rs 3,000 | 1 at Rs 3,200 | +200 | 0, Rs 3,200 |
| −1, none | 1 at Rs 3,200 | +3,200 | 0, Rs 3,200 |
| −3, Rs 3,000 | 5 for Rs 16,000 | 3 × (3,200 − 3,000) = +600 | 2, Rs 3,200 (value 6,400) |
| −3, Rs 3,000 | 1 at Rs 2,900 | −100 | −2, **Rs 3,000** (unchanged) |
| −2, Rs 3,000 (after the line above) | 2 at Rs 3,100 | +200 | 0, Rs 3,100 |
| 2, Rs 3,000 | 1 at Rs 3,300 | none | 3, Rs 3,100 (as today) |

## Question for the owner

1. **Where the correction shows in Sales and gross profit.** *Answer (owner, 2026-11-25): as recommended.* *Recommended:* a separate line, *Cost corrections: stock sold before it arrived*, in the period the stock came in, grouped by item. The profit on each bill stays what it was on the day, and the period's total matches the books. *Alternative:* add it to the original bills. The report would then disagree with the profit and loss of a period already closed, and a bill's profit would change after the fact.

## Tests (first, failing)

- **Golden, `packages/posting/golden/settle-shortfall.json`:** the six cases above; fractional quantities (−1.5 m of hose, 2 m in); a value that doesn't divide evenly (rounding).
- **Golden, updated:** in `post-goods-receipt.json` the *"on hand was below 0"* case gains its correction; `post-return.json` *"a return into a shelf below zero"* and `post-void.json`'s below-zero case get their corrections and the average they now keep. Each new case says why its figures changed.
- **Property (`fast-check`, `properties.test.ts`):** for any sequence of sales, receipts, returns and voids of one item, whenever on-hand is 0, Σ `value_delta` is 0 up to the average's own rounding (a few paisa, as today), and never a shortfall's whole cost; and every entry balances.
- **Integration, `apps/api/src/posting.int.test.ts`:** a sale of an item never received, then a goods receipt → Inventory in the books equals the stock report's value (0), COGS is the receipt's cost, and the rebuild check finds no difference.
- **Integration, `reports-sales.int.test.ts`:** with corrections in the period, Σ cost (bills plus corrections) still equals cost of goods sold on the profit and loss.
- **Integration, `inventory.int.test.ts`:** the stock card lists the correction row with its value and document.
- **Back office (component):** the correction row and the report line are translated and show no quantity.

## Existing data

The ledgers are derived (rule 4), so the rebuild check on staging will report differences for items that were sold below zero. After the deploy, run `posting-check` and then `posting-rebuild` on staging (both shops) and confirm the stock report equals Inventory in the books. The pilot is wiped before go-live (D-101), so production starts under the new rule.

## Risks

| Risk | Mitigation |
|---|---|
| Code that reads `stock_movements` assumes a quantity: dividing by `qty_delta`, counting movements as receipts or sales (stock age, turnover, days of cover, rates, the stock card) | Check every reader (`apps/api/src/reports/stock.ts`, `inventory/routes.ts`, `packages/posting/src/db/*`) and add one case with a correction row to each report's tests |
| Rounding with fractional quantities leaves a paisa in Inventory at 0 on hand | The same as the average's rounding today; the property test bounds it at under 1 paisa per correction |
| A partial receipt of an item never bought keeps it at no cost, so the next sales still post at 0 and flag `no_cost` | Rare (part of a borrowed order arrives). The next receipt settles them, and the flag is correct, because their cost isn't known yet |
| The owner reads the correction as a loss | The line's name says what it is; it moves profit to where it belongs, and the total is unchanged |

## Docs

- D-124 in the decision log (amends INV-02 and posting rules §5.1);
- posting rules §5.1: the shortfall rule and the correction movement;
- data model §7: a movement may have value and no quantity;
- the reports README: the new line in Sales and gross profit;
- the glossary: *Cost correction*.

## Results

Built as planned, with these details settled while building:

- **One rule, four callers.** `shortfallCorrection` and `settleShortfall` in `cost.ts`; the average freezes inside `averageAfterReceipt` and `averageAfterValue`, so every caller gets it. Goods receipts, returned lines, voids and opening stock post the correction; a void reverses a correction its sale carried as it was.
- **Load order.** A posting's movements now load with a correction after its line's movement (`ORDER BY line_no, qty_delta = 0, id`), so a void replays the same way live and in the rebuild.
- **`schema.ts` needed no change.** It mirrors columns, not checks, and no column changed; only migration `0025_cost_correction.sql` relaxes the check.
- **Stock movement report:** a correction counts with the **sales** bucket (value only), since it is cost of goods sold; the stock ledger and stock card call it *Cost correction: sold before it arrived*.
- **Sales and gross profit:** line costs leave corrections out; `corrections` lists them by item with their total and gross profit in the books, under the item filters; none with a salesman or customer filter; null without cost.view. The CSV ends with the items' lines, `cost_corrections` and `profit_in_books`. The screen shows the list under the table and a *Gross profit in the books* figure when there is a correction.
- **Not changed:** the dashboard's profit figure still counts the bills only. A correction is rare and it can follow if the owner wants it.

Checks (2026-11-25, local, Node 24):

- `pnpm check`: format, lint, typecheck, 2,724 tests in 140 files with coverage, builds: all passed.
- `pnpm test:integration` (PostgreSQL 17.9): 549 tests in 50 files passed, including the new lamp case (the bills' cost plus the corrections equal COGS; the stock report equals Inventory; the lamp leaves 0 on hand and 0 value).
- `pnpm e2e` (Edge): 81 passed.

After the deploy to staging: run `posting-check`, then `posting-rebuild` for both shops, and confirm the stock report equals Inventory in the books.
