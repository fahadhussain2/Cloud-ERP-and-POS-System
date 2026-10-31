# Posting engine: specification

| | |
|---|---|
| **Status** | v1 accepted with the [W1-08 plan](plans/W1-08-posting-engine.md) (D-095); built in W1-08 for sales |
| **Refs** | INV-01, INV-02, INV-03, ACC-01, ACC-02, ACC-03, ACC-08, ACC-09; [posting rules](../../04-ACCOUNTING-POSTING-RULES.md); architecture §5.2, §7; data model §3, §4, §7, §9; CLAUDE.md rules 1, 3, 4, 5, 7; D-017, D-022, D-057, D-094, D-095 |

What every operational document becomes in the books, how that is written, and how it is proven. The posting rules say **which** lines a document posts; this spec says **how** the engine posts them. Each new document type (returns W1-13, voids W1-12, handovers W1-10, opening W1-14, receipts W1-16, stock operations W1-18, journal vouchers W1-19) adds a pure function and golden cases here, and nothing else changes.

## 1. Shape

| Part | Where | What it does |
|---|---|---|
| **Pure engine** | `packages/posting/src/sale.ts` (`postSale`), `cost.ts`, `replay.ts` | `postSale(sale, context, state)` → `{ ok: true, posting }` or `{ ok: false, error }`. No I/O, no clock. Golden cases in `packages/posting/golden/`, `fast-check` properties beside them. |
| **Database layer** | `packages/posting/src/db/` (`load.ts`, `write.ts`, `post.ts`, `rebuild.ts`) | Loads the document, its context and the state it touches; writes the rows the engine returns. The **only** writer of the ledger tables: a repo test (`ledger-writers.test.ts`) fails on any other. |
| **Callers** | push (`apps/api/src/sync/push.ts`), the worker's `posting-catch-up` job, `erp-tenant posting-check` / `posting-rebuild` | Push posts each accepted sale in its own transaction; the worker posts what push couldn't; the commands prove and repair the ledgers. |

**Inputs.** The *sale* is the stored document (lines with their id, location, quantity in thousandths, line total and tax; the bill discount, rounding and tax total; the payments in bill order, each with its method code). The *context* is the settings: the account for each role and for each payment method (null = routed by role: cash → `CASH_IN_TRANSIT`, on account → `AR_CONTROL`), the lock date, the customer's payment terms. The *state* is what earlier postings left: each item's average cost (`null` = none known yet) and tenant-wide on-hand, and each location's balance per item.

**Output.** The entry date; the journal entry (branch, memo = the bill number, lines); the stock movements; the party ledger entries; the exceptions; and the costs and balances the posting changed, as they are after it.

## 2. A sale (posting rules §4.1)

1. **Entry date** = the business date, or the day after the lock date when the business date is on or before it (`posted_after_lock`, medium).
2. **Tenders**, in payment order: debit each method's account; amounts on one account (Raast and bank transfer on HBL) make one line. An on-account payment debits `AR_CONTROL` with the customer as the line's party and writes a customer ledger entry (+amount, due = entry date + the customer's terms, the same day without terms). On account without a customer → error `on_account_without_customer`.
3. **Revenue**: credit `SALES` with Σ line totals; debit `SALES_DISCOUNT` with the bill discount; `ROUNDING` with the rounding (positive = the customer paid more = credit); credit `TAX_PAYABLE` with the tax total when it isn't 0.
4. **Suspense**: whatever still doesn't balance (a bill that doesn't add up, D-094) goes to `SUSPENSE` (1190 *Posting suspense*), so the stock and the cash are still right. The accountant clears it with a journal voucher (W1-19).
5. **Stock**, line by line, each line seeing the lines before it: a movement out of the line's location at the item's average (`value = qty × avg`, half away from zero, D-079); the average doesn't change; tenant-wide on-hand and the location balance go down. An item with no cost yet moves at 0 (`no_cost`, low, once per item per bill). A location balance going **from 0 or more to below 0** raises `negative_stock` (low); further sales while it stays negative don't. Never blocked (INV-03).
6. **Cost**: debit `COGS` and credit `INVENTORY` with Σ the movements' value, when it isn't 0.

Lines come out in this order: tenders, `SALES`, `SALES_DISCOUNT`, `ROUNDING`, `TAX_PAYABLE`, `SUSPENSE`, `COGS`, `INVENTORY`. Zero lines are left out. A role or method without an account is an error (`role_unmapped`, `method_unmapped`).

**A line's cost is on its movement only** (`stock_movements.source_line_id`): finalized lines are never updated (rule 3). A returned line (W1-13) reads its original cost from there.

**Average after a receipt** (`averageAfterReceipt`, posting rules §5.1): `(on_hand × avg + qty × net_unit_cost) / (on_hand + qty)`, half away from zero; the receipt's cost when on-hand was 0 or less or no cost was known. First used by the opening stock (W1-14) and goods receipts (W1-16).

## 3. Writing a posting

`postDocument(client, { tenantId, type, id, now })` runs inside the caller's tenant transaction:

1. Takes the tenant's **`posting_state` row `FOR UPDATE`** (created on first use). A tenant's postings therefore run one at a time; the lock is held only for this step.
2. If the document already has a `postings` row → `already_posted`.
3. `SAVEPOINT posting`; loads the sale, the context as it is now and the state its lines touch; runs the engine.
4. On success: the next `seq` and, when there are journal lines, the next journal number (`J` + 6 digits, per tenant); writes the `postings` row with the **context it used**, the journal entry and lines, the movements, the party entries; sets `item_costs` and `stock_balances` to the new values and adds to `party_balances`; writes the posting's exceptions (raising the document's `exception_count`); notes `postedAt` on an earlier `posting_failed` exception.
5. On an engine error or any database error, including a lock that can't be had (the savepoint is taken before the lock): back to the savepoint, one `posting_failed` exception (high, `details.code`; never two for one document), `failed`. **The document stays accepted** (SYN-03). Push logs `posting.failed` as an error.

Push's answer to the counter doesn't change: posting exceptions are recorded on the server only (counters on an older app know no new kinds).

**Catch-up.** `postPending(pool, tenantId)` posts every accepted sale without a `postings` row in arrival order (oldest received first; a counter's bills from one push, which share a receive time, by their sequence), paging through all of them 500 at a time, so bills that never post can't hold back the ones behind them. The worker runs it for every shop at start-up and a minute after each run. It posts the bills accepted before W1-08 on its first run, and a bill held by `posting_failed` as soon as its cause is fixed (e.g. Raast mapped to a bank). The `posting_failed` exception stays open for review.

## 4. Tables (migration 0009, data model §4, §7, §9)

| Table | Kind | Notes |
|---|---|---|
| `posting_state` | per tenant | `last_seq`, `last_journal_no`; the posting lock |
| `postings` | append-only, order of record | `seq`, `source_type`, `source_id` (unique), `entry_date`, `posted_at`, `context` (jsonb: accounts by role and method, lock date, customer terms) |
| `journal_entries`, `journal_lines` | append-only | one-sided lines (`CHECK`); a deferred constraint trigger refuses an entry whose debits ≠ credits at commit; lines carry the branch and, on AR/AP, the party |
| `stock_movements` | append-only | `qty_delta`, `unit_cost`, `value_delta`, `avg_cost_after` (null while no cost is known), `source_line_id`, `business_date` = the entry date |
| `party_ledger_entries` | append-only | `role`, `entry_date`, `due_date`, `amount` (+ = owed more) |
| `stock_balances`, `party_balances` | balances, synced | updated in place; synced rows are never deleted (a rebuild zeroes them) |
| `item_costs` | balance | `avg_cost`, `on_hand` (tenant-wide), `last_cost`, `last_supplier_id`, `last_receipt_at` |

Every table has `tenant_id` and forced RLS. The app role may insert into the append-only tables but never update or delete them. Exceptions gain `no_cost`, `posting_failed`, `posted_after_lock`.

## 5. The rebuild (ACC-02, rule 4)

**Check** (`checkRebuild`, `erp-tenant posting-check <env> <shop>`): in one `REPEATABLE READ READ ONLY` snapshot, replay every posting in `seq` order from its document and **its recorded context**, starting from nothing; turn the result and the stored rows into comparable text (per seq for the ledgers, per item, location and party for the balances; journal lines in order) and list every difference. It takes no lock and writes nothing, so it can run during the shop's day. Because each posting replays with the context it used, moving Raast from HBL to Soneri doesn't make old bills look wrong.

**Apply** (`applyRebuild`, `erp-tenant posting-rebuild <env> <shop>`), as `erp_owner`, for after a posting-rule fix: takes the posting lock; **refused when any posting is on or before the lock date** (architecture §7: a locked period needs an explicit, audited unlock first); deletes the append-only ledger rows and `item_costs`, zeroes the synced balances, writes the replay back (keeping each posting's seq, context and posted time, renumbering the journals), writes `posting.rebuild` to the audit log, then the command runs the check. **Run it after shop hours:** it holds the posting lock for the whole rewrite, so bills pushed meanwhile are accepted but wait to post until it finishes.

The ledgers come only from postings: costs set any other way (a test, a manual fix) show up as differences. Opening stock (W1-14) is a posting like any other.

## 5a. A handover (posting rules §4.5, W1-10)

`postHandover(handover, context)` (`packages/posting/src/handover.ts`): an `in` posts `Dr CASH_DRAWER / Cr CASH_IN_TRANSIT`, a `payout` the reverse, for the handover's own `amount`, dated its business date (or the day after the lock date, `posted_after_lock`), memo `<handover number> <bill number>`. No stock, no party. A chart without either role is `role_unmapped`. Source type `cash_handover` in `postings`; a **duplicate is never posted** (`loadHandover` returns none for it). Push posts it in the accepting transaction, the catch-up posts what push couldn't, and the rebuild check replays it with its recorded context.

Because it posts its own amount, its order against its bill doesn't change the books: an offline scan often arrives first. Once every cash bill is handed over, `CASH_IN_TRANSIT` is back to 0 (posting rules §4.5's control property; tested in `handover.test.ts` and `cash-desk.int.test.ts`).

## 6. Known limits

- **Arrival order** sets the cost of a late offline sale (D-017): recorded and reproducible, not re-costed (re-costing is Phase 2).
- **Rounding drift:** Σ (on-hand × average) can differ from the `INVENTORY` balance by a few paisa; the stock valuation report (W1-20) shows it and an adjustment clears it.
- **Rebuild speed:** the replay reads each document separately; fine for a shop's months of bills, to be batched if a tenant's history grows large.
