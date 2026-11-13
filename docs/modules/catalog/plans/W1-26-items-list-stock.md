# W1-26 The items list shows stock, cost and level

| | |
|---|---|
| **Issue** | [#160](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/160) |
| **Module** | catalog (reads the inventory module's balances and costs) |
| **Status** | Built (2026-11-14), in review. Plan accepted by the owner (PR #161, answers 1–3: yes) |
| **Refs** | CAT-01 (unit, min quantity, status), INV-01 (stock balances), INV-02 (average cost), INV-03 (negative stock), RPT-05 (stock and valuation); D-017 (one average per item); W1-15 (the items list), W1-18 (the stock card) |
| **Depends on** | W1-15 (the items list), W1-08 (balances and average cost), W1-18 (the stock card) |
| **Size** | about half a day to a day |
| **Test-first** | Yes: the list's stock, cost, value, level, filter, sort and total, with RLS and `cost.view` (integration); the table (unit); the items list after a posted receipt (e2e) |

## The problem

The back office's items list (Catalog → Items) shows **Code, Name, Brand, Category, Retail, Status**:
- **Category** repeats the category filter, and **Status** says *Active* on almost every row.
- **No quantity, no cost:** to see how many of an item the shop has, you open the stock card (Stock → Stock card) or the stock report (Reports → Stock and value), one item or one search at a time.
- **Nothing shows what's running low**, although the importer filled each item's minimum from the legacy *MinQuantity*: 10,626 of the 19,552 items have one.

## Goal

**One look at the items list answers: how many are in the shop and the godown, what they cost, what the stock is worth, and whether it's running low.** It stays one line per row (the owner chose this after a preview on staging), as fast as today.

## Design

**The columns** (agreed with the owner on 2026-11-13, mockup and staging preview):

| Code | Item | Brand | Unit | Cost\* | Sale price | Shop | Godown | Stock value\* | Level |
|---|---|---|---|---|---|---|---|---|---|

\* Only with `cost.view`.

| Choice | Why |
|---|---|
| **Item** is the name; a *Dormant* or *Discontinued* chip follows it. The **Status column goes** | Almost every row is Active; the chip shows only what's unusual |
| **Category goes** (it stays a filter); **Brand** stays as a narrow column | One line per row (owner); the legacy names already carry the vehicle and origin |
| **Unit** is the unit's code (*PCS*, *SET*, *FOOT*) | Short; the item screen has the name |
| **Cost** is the **average cost** (`item_costs.avg_cost`, D-017); blank when unknown, *No cost* as the stock report says it | The cost that posting and the floor use |
| **Sale price** is the **Retail** tier, as today | Mechanic and wholesale are fixed percentages of it (PRD Q1); the item screen shows all three |
| **Shop** and **Godown:** one column per **shop- and storage-kind location** of the branch, named after the location. Damaged and transit stay off the list (the stock card shows them) | The question at the counter is "on the shelf or in the godown?". Named from the data, so another shop's locations show their own names |
| **Quantities:** whole numbers for units that don't allow fractions; up to 3 decimals for those that do (*FOOT*, *METER*, *LITRE*). **0** greyed; **below zero in red** (INV-03) | Readable at a glance; a negative is a sale that ran ahead of a receipt or transfer |
| **Clicking a quantity opens the item's stock card** (only for someone who can open the stock card; otherwise plain text) | From "how many" to "why" in one click |
| **Stock value** = (Shop + Godown) × average cost, rounded as the stock report does (`mulQty`); an item without a cost counts 0. Question 1 | What's on the shelf and in the godown is worth this much |
| **Level**, from the item's minimum (`items.min_qty`), on Shop + Godown:<br>• **Out:** 0 or below<br>• **Low:** above 0 and at or below the minimum (question 2)<br>• **OK:** above the minimum, or above 0 with no minimum | Uses the minimums the legacy app already had; the reorder list (PUR-07, Wave 2) builds on the same field |
| **A Level filter** next to category and status: *All · Low · Out · Below zero* | "What's out in the shop?" in one click |
| **Sorting** by Code (default, as today), Shop, Godown and Stock value; clicking a header toggles the direction | "Where's the money tied up?" sorts by value |
| **A total row:** the stock value of **every item the search and filters match**, not only the page shown | The value of a search (e.g. all brake parts) |
| **One query:** the list joins `stock_balances`, `item_costs` and `units` and computes the level in SQL, so the filter, the sort and the paging stay on the server. The total is one aggregate over the same match | ~20,000 items; the page stays as fast as today |
| **Cost and value need `cost.view`:** without it the API doesn't send them and the columns don't show | The same rule as the item screen and the stock report. Every built-in role that can open the list has it today (owner, manager, purchaser); it matters for custom roles (Wave 2) |
| **Posted stock only:** sales from an offline counter count once they sync | The same as the stock card and the stock report; noted in the screen's help line |

## Scope

- **In:**
  - `packages/contracts`: `ItemRow` gains `unit`, `stock` (quantity per shown location), `avgCost`, `value`, `level`; `ItemList` gains the locations shown and `totalValue`; the list's query gains `level` and `sort`.
  - `apps/api/src/catalog/routes.ts`: `GET /catalog/items` returns them, with the level filter, the sort and the total; cost and value only with `cost.view`.
  - `apps/backoffice/src/catalog/ItemsScreen.tsx`: the new columns, the chip, the level filter, sortable headers, the total row, the links to the stock card; i18n keys (en); logical CSS.
  - Docs: catalog README (the list), the W1-26 row in `WAVE-1-TASKS.md`.
- **Out:**
  - **Stock in the POS** (the counter's search results, POS spec §8): a separate task, to discuss first.
  - **Damaged and transit** on the list; **several branches** (Delux has one).
  - **Editing the minimum from the list,** and the **maximum** (it's for the reorder list, Wave 2).
  - **Exporting the list** (CSV, CAT-09, Wave 2).
  - **The stock report and the stock card** stay as they are.

## Tests written first

- **Integration** (`apps/api/src/catalog.int.test.ts`):
  - After an opening and a transfer, the list gives each item's quantity in Shop and in Godown (not Damaged), its unit, average cost and value, and the locations shown.
  - The level: no stock → *Out*; below zero → *Out*; at the minimum → *Low*; above it → *OK*; stock with no minimum → *OK*.
  - The level filter (*Low*, *Out*, *Below zero*) and the sort by Shop, Godown and value, with paging.
  - The total value counts every match, not only the page.
  - Without `cost.view`: no cost, no value, no total value (as the existing item-detail test does).
  - Another shop's balances never show (RLS).
- **Unit** (`ItemsScreen.test.tsx`): the columns in order; cost and value hidden without them; the chip only when not active; a negative quantity in red; a quantity links to the stock card; fractional units show decimals; the total row.
- **e2e** (`e2e/stock.spec.ts`): after the flow posts a receipt, Catalog → Items shows the received quantity in Godown and the value.

## Verify

1. `pnpm check`, `pnpm test:integration`, `pnpm e2e`, output shown.
2. **On staging, by the owner:** in the `demo` shop, Catalog → Items: the columns, a Low and an Out item, the level filter, sorting by value, the total, a click through to the stock card.
3. **On production after a release:** the list shows the real catalog. Until the pilot opening (~28 Nov) every item shows 0 and *Out*, since no stock is loaded yet.

## Questions for you

1. **Stock value counts Shop + Godown only,** not Damaged? Damaged stock stays on the books at cost, so the list's total would be below the stock report's by the damaged value. *Recommended: yes, Shop + Godown, and the total row says so.*
2. **Low means at or below the minimum** (so an item with minimum 5 and 5 in stock shows *Low*)? *Recommended: yes, at the minimum is when to reorder.*
3. **The default order stays by code,** with stock and value as sorts you click? *Recommended: yes, as today.*

## Risks

| Risk | Mitigation |
|---|---|
| The list gets slower with three more joins | Balances and costs are keyed by item; the integration test runs the full query, and the list on staging is checked in Verify 2 |
| Until the pilot opening every item shows *Out* | Expected; noted in Verify 3. The level means something once the opening is loaded |
| The legacy minimums are stale or 0 for many items | Items without a minimum show only Out/OK; the owner fixes minimums in the item screen, and the review list can flag them later |
| Cost shows to someone who shouldn't see it | The API leaves it out without `cost.view`, tested |

## Results (2026-11-14)

- **Built** as planned. The list's query reads the balances of the shop- and storage-kind locations in one pass per item, and returns one row even past the last page, so the count and the total value always come back.
- **Without `cost.view`,** a sort by value falls back to the code order.
- **Tests first:** `apps/api/src/items-list.int.test.ts` (10 tests), 4 new screen tests in `catalog.test.tsx`, and a new flow in `e2e/stock.spec.ts`. All failed before the build.
- **Checks:** `pnpm check` (2,261 tests), `pnpm test:integration` (456) and `pnpm e2e` (59) passed.
