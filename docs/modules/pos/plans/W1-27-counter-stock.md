# W1-27 Stock on the counter: Shop and Godown in the search results

| | |
|---|---|
| **Issue** | [#164](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/164) |
| **Module** | pos (with sync for the new datasets) |
| **Status** | Built (2026-11-15), in review. Plan accepted by the owner (PR #165, answers 1–3: yes) |
| **Refs** | POS-02 (the search *"shows Shop and Godown stock, tier price and bin location"*), INV-01 (stock balances), INV-03 (negative stock allowed); POS spec §9; sync spec §3 (*"Stock balances are added by their task with the same rules"*); W1-26 (the same columns in the back office) |
| **Depends on** | W1-03 (the counter's search and the catalog pull), W1-08 (stock balances kept by posting), W1-09 (the counter's own bills against a pulled balance) |
| **Size** | about 1 day |
| **Test-first** | Yes: the new datasets and their columns (integration); the counter's quantities with its own unsynced bills, and the search speed (unit); a sale showing on the counter (e2e) |

## The problem

A customer asks *"do you have a front brake pad for a 2012 Corolla?"* The salesman searches and sees the item, its price and its bin, **but not whether the shop has any**. To find out they walk to the shelf, call the godown, or ask the owner to look in the back office.

The PRD asks for it from Wave 1 (POS-02), and POS spec §9 says *"Stock (Shop · Godown) is added with W1-08"*. W1-08 built the balances on the server, but **they never reached the counters**: the sync spec still says stock balances are *"added by their task"*.

## Goal

**Every search result on every counter shows how many the Shop and the Godown have,** for every salesman, the moment they search. A sale at this counter shows at once, offline too; a sale at another counter shows within seconds once it syncs.

## Design

**On the screen** (the owner chose these on 2026-11-15, after a mockup):

| Choice | Why |
|---|---|
| **One column, *Shop · Godown*,** in the search results between the item and the price: `8 · 4` | Seen at the moment of choosing the item, without opening anything |
| **Every salesman sees it** (owner) | The first thing a customer asks is whether the shop has it |
| **Only in the search results,** not on the bill lines or the printed bill (owner) | The decision is made while searching; the bill panel stays as it is |
| **Whole numbers,** decimals only for units that allow fractions (*METER*, *FOOT*, *LITRE*), as in the back office | Readable at a glance |
| **Colours:** Shop **0 in amber** when the Godown has some (*"send someone to the godown"*); **below zero in red**; **0 everywhere in grey** | The three cases a salesman acts on differently |
| **The column's heading uses the locations' own names** (*Shop · Godown*), from the back office | Another shop's locations show their own names |
| **No cost and no floor on the counter** (owner, 2026-11-15) | Unchanged: the floor stays hidden (POS spec §10), and cost never leaves the server |
| **It never blocks or warns on a sale** (INV-03): no check when a line is added beyond the shelf quantity | A sale is never refused; the number is information only |

**Where the numbers come from:**

| Choice | Why |
|---|---|
| **Two new pulled datasets** (sync spec §3), both scoped to **the device's branch, shop- and storage-kind locations only** (not Damaged, not In transit):<br>• `locations`: `id, code, name, kind, row_version, deleted_at`<br>• `stock_balances`: `item_id, location_id, qty, row_version, deleted_at`, keyed on the counter by item and location | The counter needs the numbers and the column names. Pulled like every other dataset: by `xid8` cursor (rule 8), in pages, resumable; **no cost or value** ever leaves the server (a test fails on any other column) |
| **Posting already gives each changed balance a new txid** (`stock_balances` is synced since W1-08, migration 0009), and the SSE nudge already tells online counters to pull | A sale posted from any counter reaches every online counter within seconds, with no new server work beyond the two datasets |
| **The counter takes off its own bills the balance can't include yet:** sales take from the Shop, voided ones put it back, returns of resellable lines add to the Shop. *"Can't include yet"* is the rule already used for a customer's credit (POS spec §15): still in the outbox, or accepted after the start of the last complete pull | After a sale the counter shows 7, not 8, at once, offline too, and never counts a bill twice. Held (parked) bills don't count: nothing is sold yet. Question 1 |
| **Sales at other counters show once they sync;** offline, the numbers can be behind | Expected: the status bar already says *Offline since HH:MM*. Nothing is reconciled or refused |
| **The local schema gains two tables** (migration 14): `locations` and `stock_balances` (primary key item and location). Adding tables only, so the local database is never dropped (rule 9) | The new datasets start from the beginning on the next pull |
| **The search reads the quantities for the shown results only** (at most 50), from the local table by item | The search stays within 100 ms (POS-02); the speed test covers it |
| **First load:** about 2 rows per item in stock (Shop and Godown), about 40,000 for Delux after the opening: a few seconds more on top of the measured 31 | Under the 60-second rule; no snapshot needed |

## Scope

- **In:**
  - `packages/contracts`: the `locations` and `stock_balances` datasets and their columns (`qty` as numeric text, kept as thousandths on the counter).
  - `apps/api/src/sync/routes.ts`: both datasets, scoped to the device's branch and to shop- and storage-kind locations.
  - `apps/pos`: local schema 14 (two tables); the pull keys `stock_balances` by item and location; a pure function for the counter's own unsynced quantities; the search results' column, colours and heading; i18n keys (en); logical CSS.
  - The cash desk's screens don't change.
  - Docs: sync spec §3 (the two datasets), POS spec §9 (the column), the W1-27 row in `WAVE-1-TASKS.md`.
- **Out:**
  - **Cost or floor on the counter** (owner, 2026-11-15).
  - **Stock on the bill line,** the printed bill or the cash desk (owner).
  - **A warning or block when selling beyond stock** (INV-03).
  - **Other branches' stock** (Delux has one branch; multi-branch later).
  - **Damaged and In transit** on the counter.

## Tests written first

- **Integration** (`apps/api/src/sync.int.test.ts`):
  - `locations` gives this branch's Shop and Godown, not Damaged, In transit or another branch's.
  - `stock_balances` gives exactly `item_id, location_id, qty, row_version, deleted_at` for those locations only; never another shop's (RLS) or Damaged.
  - After a sale is pushed and posted, the next pull from the old cursor brings the changed Shop balance.
- **Unit** (`apps/pos`):
  - The pull stores and updates balances keyed by item and location; a later page with the same key replaces the row.
  - The counter's quantity: the pulled balance minus this counter's sales still in the outbox or accepted after the last complete pull start; a voided sale doesn't count; a resellable return adds; a held bill doesn't count; never counted twice once a complete pull has it.
  - The search result shows `8 · 4`; an amber Shop 0 when the Godown has some; red below zero; grey when none; decimals for a fractional unit; the heading from the locations' names.
  - The search stays under 100 ms on the generated 20,000-item catalog with balances.
- **e2e** (`e2e/counter.spec.ts`): the counter searches an item and sees its Shop and Godown quantities; after a sale the Shop quantity drops by the quantity sold.

## Verify

1. `pnpm check`, `pnpm test:integration`, `pnpm e2e`, output shown.
2. **On staging, by the owner:** on a staging counter in the `demo` shop, search an item with stock and compare with Catalog → Items in the back office; sell one and see the Shop number drop; search one with only Godown stock (amber 0).
3. **On production after a release:** every counter shows 0 everywhere until the pilot opening (~28 Nov) loads stock. After the opening, a spot check of a few items against the shelf.

## Questions for you

1. **The counter's own unsynced sales count at once** (8 becomes 7 straight after the sale, offline too)? *Recommended: yes, as the customer credit already works.*
2. **A held (parked) bill doesn't reduce the stock** until it's paid? *Recommended: yes, nothing is sold yet.*
3. **An amber 0 for the Shop when the Godown has some?** *Recommended: yes, it tells the salesman to send someone to the godown.*

## Risks

| Risk | Mitigation |
|---|---|
| The search gets slower | Quantities are read for the shown results only, by key; the 100 ms speed test runs with balances |
| A busy day sends many balance changes to every counter | Each sale changes one or two small rows; the pull already pages and resumes |
| An offline counter shows old numbers | Expected and visible (*Offline since*); its own sales still count at once |
| Before the pilot opening, every number is 0 | Expected; Verify 3 |

## Results (2026-11-15)

- **Built** as planned:
  - `STOCK_COLUMNS` in `packages/contracts`, and the two sources in `apps/api/src/sync/routes.ts`.
  - On the counter: local schema 14, the pull keyed by item and location, `apps/pos/src/db/stock.ts`, and the database worker's search filling in each result's stock.
  - The column in `CounterScreen.tsx`.
- **The sale's location** on the counter is the branch's first shop location by code, the one posting takes a sale from.
- **An existing test** used `stock_balances` as its example of an unknown dataset; it now uses `item_costs`, which must never be one.
- **Tests first** (all failed before the build):
  - `apps/api/src/sync-stock.int.test.ts` (4 tests);
  - `apps/pos/src/db/stock.test.ts` (9 tests, including the speed test: 50 results out of 20,000 items);
  - 2 counter screen tests;
  - in `e2e/counter.spec.ts`, a sale coming off the Shop.
- **Checks:**
  - `pnpm check`: 2,273 tests;
  - `pnpm test:integration`: 460 tests;
  - `pnpm e2e`: 59 passed.
