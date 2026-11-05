# W1-14 Opening balances, reconciliation report, first migration rehearsal

| | |
|---|---|
| **Issue** | [#59](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/59) |
| **Module** | migration (the opening computed in `tools/legacy-import`, the pilot wipe), with accounting (`postOpening` in `packages/posting`), sync (the `item_floors` dataset) and pos (the counter takes the cost floor) |
| **Status** | Accepted (2026-11-04) with the owner's answers 1–5. Built (2026-11-04) on `w1-14-opening-balances`; rehearsal 1 run on `dec2025`; the stock quantity cross-check needs the owner (below) |
| **Refs** | MIG-02, MIG-04, INV-01, INV-02, CAT-06 (floor = cost + margin), PRD Q2 (5%), Q9 (all stock into Shop), Q11 (the 2026 dump); migration doc §4, §7, §8, §9; posting rules §5.1, §7; data model §3, §4, §7; accounting spec §2, §5; importer spec §1, §2; sync spec §3; CLAUDE.md rules 1, 3, 4, 5, 11; D-017, D-030 (masters and openings stay), D-031, D-076, D-079, D-084, D-085, D-090, D-092, D-095, D-100 |
| **Depends on** | W1-08 (posting engine, `averageAfterReceipt`), W0-13 (masters loaded by legacy key) |
| **Size** | about 3½ days (the task list says 3): opening document and posting ¾, the legacy computation 1, load, post and reports ¾, the cost floor on the counter ¾, the pilot wipe ¼ (owner answer 1), the rehearsal ¼ |
| **Test-first** | Yes: `postOpening` (golden, `packages/posting`); closing quantity, valuation rate and party balances from legacy rows (golden, `tools/legacy-import`); `costFloor` (golden, `packages/domain`); load, post, re-run and rebuild (integration) |

## Goal

**The new system starts from the legacy system's figures, and you can prove it.** Every item gets its quantity in Shop and its average cost, every customer and supplier their balance, and the books one balanced opening entry, all as postings (rule 4), so the stock, party and GL ledgers can be rebuilt from them like from any bill. A **reconciliation report** puts each figure next to the legacy one (MIG-04). Once costs exist, the counter knows each item's **floor = cost + 5%** (PRD Q2), so a bargain down to that needs no manager's PIN any more (D-092). The task ends with **the first rehearsal**: the whole run, timed, on a current dump, and (question 3) the pilot's opening on production before 1 Dec.

## Design

| Choice | Why |
|---|---|
| **The opening is a document** (migration `0015`): `opening_balances` (header: `label` (the dump's, unique per tenant), `branch_id`, `as_of` (the legacy cutoff), `entry_date`, `status` `draft` → `posted`, `posted_at`, `legacy` jsonb (dump file hashes, run id)) and `opening_balance_lines` (`kind` `stock` · `customer` · `supplier` · `account`; `item_id`, `location_id`, `qty` numeric(14,3), `unit_cost` (null = no cost known); `party_id`, `amount`; `account_id`, `amount`). Forced RLS and audit, not synced (server only). **A posted opening is never changed** (rule 3): a trigger refuses updates and deletes of a posted one. | The rebuild replays every posting from its document (accounting spec §5); an opening written straight into the ledgers would show up as a difference forever. A draft that the importer replaces on a re-run, and that posts once, keeps rehearsals cheap and the real one final. |
| **`postOpening(opening, context, state)`** (`packages/posting/src/opening.ts`, source `opening`), one journal entry dated `entry_date` (or the day after the lock date, `posted_after_lock`), memo `Opening <label>`: **stock** lines → a movement into the line's location (SHOP, PRD Q9) at its cost, `value = qty × cost` half away from zero (D-079), the average by `averageAfterReceipt` (the line's cost when nothing is on hand or no cost is known); a negative quantity (15 items in Dec 2025) moves out at its cost and sets the average when none was known; a line without a cost moves at 0, the average stays unknown, `no_cost` (low). `Dr INVENTORY` Σ value. **Customer** lines → `Dr AR_CONTROL` with the party and a customer ledger entry (due = entry date: ageing starts at go-live, migration doc §4.2); an advance (negative) is the other side. **Supplier** lines → `Cr AP_CONTROL` and a supplier entry, likewise. **Account** lines (the counted drawer float and the bank statement balances, posting rules §7) → their account. **The balance → `OPENING_BALANCE_EQUITY`.** `last_cost` and `last_supplier_id` on `item_costs` come from the latest legacy purchase (migration doc §5). | Posting rules §7, exactly. The accounting spec already planned one pure function plus golden cases per document type; push, catch-up and rebuild need only the new source type. |
| **The legacy side is pure, golden-tested functions** in `tools/legacy-import/src/transform/opening.ts`, on staged rows only (rule 11: the importer reads the dump; I read only the reports): **quantity** = the period's opening quantity + purchases − purchase returns − sales + sale returns ± physical-stock adjustments up to `as_of` (as legacy `fn_INV_ClosingStock`, migration doc §4.1); **cost** = the latest `INV_StockRecordTAB.ValuationRate` on or before `as_of`, else `CostPrice`, else `OpeningRate`, else none (flagged); **party balance** = Σ (`AmountDR − AmountCR`) on the customer (`10-03-0001`) and supplier (`20-02-0001`) control accounts per `SubAccountCode`, including the legacy opening voucher. Text to minor units and thousandths exactly, as in W0-13. **Which legacy document types add and which subtract is in the mapping file** (`docTypes`, codes and names only), and an unknown type stops the run. | Each judgement call becomes a readable case that can't regress. The document-type signs are the one fact I can't see without reading values, so the importer reports the types it finds (name and row count, nothing else) and you confirm them once. |
| **Two independent quantities, one cross-check.** Besides the sum above, the importer reads each item's own running balance in `INV_StockRecordTAB` (the last `StockQuantity` up to `as_of`) and lists every item where the two differ. | The legacy "Closing Stock" report is the gate (migration doc §8), but a second figure from the legacy's own ledger finds a wrong sign or a missed document type before you have to compare thousands of lines. |
| **Steps:** `pnpm legacy:import --label <l>` (masters, as now) then **`pnpm legacy:opening --label <l> --as-of <date> --entry-date <date>`**: computes, writes or replaces the **draft**, writes the reports; **`--post`** posts it through `postDocument` (one transaction, the posting lock) and writes `opening.posted` to the audit log. Re-running after it is posted changes nothing and lists the differences. Cash and banks come from `out/<label>/opening-inputs.json` (git-ignored: the counted float and each bank's statement balance); without it they are 0. | Same shape as W0-13: dry by default, idempotent, as the app role under RLS. Bank figures are yours and never go in git. |
| **The reconciliation report** (MIG-04, migration doc §8), `out/<label>/reports/reconciliation.html` plus CSVs, **after posting, from the tenant's ledgers** (not from the importer's own figures): item count loaded vs staged (exact) · Σ quantity and Σ value in `stock_balances` / `stock_movements` vs the legacy computation and vs the legacy Closing Stock report (exact quantity, value within Rs 1 per item) · Σ customer and Σ supplier balances in `party_balances` vs the legacy GL and vs the legacy Outstanding reports (exact) · the opening entry's trial balance (Dr = Cr) next to the legacy trial balance per mapped account (cash and banks compared only, migration doc §4.3; legacy equity and P&L marked *not carried*, posting rules §7) · **the top 20 customers and suppliers** for your sign-off (masked phones; I read only the totals) · the legacy report totals you type into `out/<label>/legacy-totals.json` (question 4). Each check shows *pass* or the difference. | The gate for go-live is a page you can sign, with every figure traceable to a ledger, not to the importer's own arithmetic. |
| **Cleanup reports added** (migration doc §7, deferred from W0-13): negative stock and zero stock with sales in the last 90 days (the first January cycle counts); items with no cost; items where the two legacy quantities differ; cost above the Retail price at the valuation rate. | They need the stock calculation, which exists now. |
| **The cost floor on the counter** (D-092, CAT-06): a new synced dataset **`item_floors`** (`item_id`, `floor`), one row per item with a known cost, `floor = costFloor(avg_cost, category floor_min_margin_bp)` = avg × (10,000 + bp) / 10,000, half away from zero (`packages/domain`, D-079; 500 bp on every imported category). The posting layer writes it in the same transaction whenever it sets an item's average (opening, returns, voids, later receipts), and the rebuild rewrites it. **The counter's floor** = the item's explicit `floor_price`, else its `item_floors` row, else the list price (unchanged rule). Local schema +1. The floor is never shown on the counter. | Keeps one change feed per table (rule 8): a floor that moves with the average must be its own synced row, not a computed column on `items`. The explicit floor (W1-15) still wins. It tells a salesman roughly the cost, which D-092 accepted. |
| **The pilot is throwaway and is wiped before go-live** (owner answer 1). The pilot (D-031) is a shadow run: legacy stays official and already has every pilot sale, so nothing the pilot posts is kept. On the night of 31 Dec, before the final run: (1) every counter's outbox is empty (checked on the device health page); (2) **`erp-tenant wipe-pilot prod delux`** deletes the shop's documents and everything derived from them (sales, voids, returns, holds, handovers, collections, cash movements and sessions, overrides, exceptions, postings, journals, stock and party ledgers and balances, item costs and floors, openings, document sequences), keeping items, prices, customers, suppliers, the chart, staff, PINs and counters; as `erp_owner`, in one transaction, written to the audit log with the counts; (3) each counter's local data is reset from its setup screen (allowed: nothing unsynced, rule 9), so bill numbers start again and no pilot bill is left for returns; (4) the final opening is posted dated 2027-01-01 and the lock date set to 2026-12-31. **Guard:** the command refuses once the tenant is marked live (`go_live_at` set by the final run) or if any outbox on the health page isn't empty, and asks for the shop code typed again. | The simplest cutover: no netting posting, and January starts from legacy alone. It **breaks rules 3 and 4 for pre-go-live pilot data only**, recorded as an exception in D-101 and unusable after go-live. A part bought during the pilot comes back in January as a no-receipt return, like any pre-go-live part (D-100). |
| **The pilot's opening** (question 3): dated 2026-11-30, from a dump taken just before; stock, costs and party balances only, **no cash or bank lines** (legacy keeps the money in December). | The counter needs costs for the floor and the books need costs for COGS during the pilot; the cash is reconciled the legacy way until W1-11 joins. |

## Scope

1. **Migration `0015`:** `opening_balances`, `opening_balance_lines` (RLS, audit, the posted-opening guard, lifted only for the pilot wipe), `item_floors` (RLS, sync); `tenants.go_live_at`; `postings.source_type` gains `opening`; the Drizzle mirror.
2. **`packages/posting`:** `postOpening` and its golden cases; load, write (with `item_floors`), push/catch-up untouched, `replay`/rebuild for the new type.
3. **`packages/domain`:** `costFloor` (golden).
4. **`tools/legacy-import`:** `transform/opening.ts` (golden), the `docTypes` mapping, the `opening` step (draft, `--post`), reconciliation and cleanup reports, `pnpm legacy:opening`. **`erp-tenant wipe-pilot`** (design above).
5. **API and POS:** the `item_floors` dataset in the catalog pull (`@erp/contracts`), local schema +1, the counter's floor lookup.
6. **Staging:** `erp-tenant seed-catalog` also posts a generated opening (random costs and quantities) so floors can be checked on staging without real data (D-076).
7. **Docs:** migration doc §4, §8 and §9 (as built, the wipe in the final-run steps), posting rules §7, accounting spec §5e, sync spec §3, data model §4 and §7, POS spec §10 (the floor), migration README (the new commands), the go-live checklist (the final-run steps), WAVE-1-TASKS, a decision entry (D-101).

**Out of scope:** the dormant flag and the 30/90-day sales figures for the first reorder suggestions (with reorder, Wave 2); editing floors and category margins (W1-15); the stock valuation and ledger screens (W1-20); setting the lock date in the back office (W1-19; the final run sets it with `erp-tenant`); rehearsal 2 and the final run (~22 Dec and 31 Dec, on the checklist); re-costing (Phase 2).

## Tests written first

- [ ] **`postOpening` (golden):** stock in at cost, value rounding, a negative line, a line without cost (`no_cost`, average unknown), an item that already had a cost (average blended); a customer, an advance, a supplier, a supplier in debit; cash and bank lines; the balance to Opening Balance Equity; after the lock date (`posted_after_lock`); a role or location missing (`role_unmapped`). Property: the entry always balances, Σ stock value = the `INVENTORY` line.
- [ ] **Pilot wipe (integration):** after an opening, sales, returns, voids and desk documents, the wipe leaves no document, posting, ledger row, balance, cost or floor, and every master, user, PIN and device as it was; refused when `go_live_at` is set, when an outbox isn't empty, or when the shop code isn't typed again; a final opening after it posts and `checkRebuild` is exact.
- [ ] **Legacy opening (golden):** closing quantity per document type and sign, the `as_of` cutoff, an unknown type stops; valuation rate latest on or before `as_of` with both fallbacks; party balances per `SubAccountCode` including the opening voucher, cash partners `0001`/`0002` excluded; decimals to minor units and thousandths exactly.
- [ ] **`costFloor` (golden):** 500 bp, 0 bp, rounding half away from zero, no cost → none.
- [ ] **Integration (synthetic staging schema):** draft written, re-run replaces it, `--post` posts once, a re-run after posting changes nothing; the posted opening refuses update and delete; `item_floors` written and pulled by a counter; `checkRebuild` exact after an opening and sales; the reconciliation report passes on matching data and shows the difference on a broken one; no unmasked phone in any report file.
- [ ] **POS (worker tests):** local schema migration; an item with a cost floor and no explicit floor needs no PIN down to it, and needs one below it.

## Verify

1. `pnpm check`, the integration tests, `pnpm e2e` (the bill-building flow with a cost floor).
2. **Rehearsal 1, on this PC** (`erp_dev` copy, as W1-11's Verify 2): `pnpm legacy:stage`, `legacy:import`, `legacy:opening --post`, timed end to end, on `dec2025` (owner answer 2; the 2026 dump re-runs it later, one command). Expected: every item loaded, the opening entry balanced, the reconciliation report all *pass* except the checks waiting for your legacy report totals; `posting-check` exact. I paste the counts, totals and timings here (no names).
3. **You review** the reconciliation report and sign off the top 20 (or list what's wrong); the document-type signs confirmed.
4. **Staging:** a generated opening; a counter shows no PIN down to cost + 5%.
5. **Production, for the pilot** (owner answer 3): the masters loaded before 1 Dec, and the pilot opening once its dump arrives, by you from this PC over an SSH tunnel as the app role (password given at run time, never in git), then `posting-check prod delux`; the reconciliation report kept on this PC.

## Order

1. Failing tests (posting, domain, importer).
2. Migration `0015`, `postOpening`, `item_floors` writes, the pilot wipe.
3. The legacy computation, the `opening` step, the reports.
4. The dataset and the counter's floor.
5. Rehearsal 1, your review, the production load.

## Risks

| Risk | Mitigation |
|---|---|
| The legacy closing-stock formula has a document type or sign I can't see | Types and counts reported, signs confirmed by you, a second quantity from the legacy's own running balance, and the legacy Closing Stock report as the final gate. |
| The 2026 dump arrives late, so rehearsal 1 runs on an 11-month-old copy | Everything is built and tested on `dec2025`; the dump only changes figures. The re-run on the 2026 dump and the pilot opening (a dump by ~28 Nov) are go-live checklist items (owner answer 2). Without a fresh dump the pilot starts from the newest one, or with no opening (the list price stays the floor, D-092). |
| A period database holds only half a year: the period's opening quantity may be in `INV_Item.OpeningQuantity` or in a document | Both are reported, and the cross-check catches a double count. Confirmed on the 2026 dump. |
| Personal data on production | Approved for the pilot (owner answer 3); over an SSH tunnel to the app role (RLS on); no dump, staging schema or report leaves this PC (importer spec §1). |
| A cost floor too low or too high blocks or frees bargains during the pilot | It is the PRD default (cost + 5%); an explicit floor wins; the margin is per category (W1-15 edits it). |
| The wipe deletes something it shouldn't, or runs after go-live | It keeps a fixed list of master tables and is tested on that; it refuses once `go_live_at` is set; production is backed up (pgBackRest) right before it; rehearsal 2 (~22 Dec) runs it on a copy of production. |
| A counter still holds an unsynced bill on the night | The wipe refuses until every outbox is empty, and the counter's reset is refused by the POS while its outbox has documents (rule 9). |

## Questions for you

1. ~~**The pilot's postings at cutover**~~: answered (below).
2. ~~**The dumps**~~: answered (below).
3. ~~**Production for the pilot**~~: answered (below).
4. ~~**The legacy report totals**~~: answered (below).
5. ~~**Size**~~: answered (below).

## Changes during the build

| Plan | Built | Why |
|---|---|---|
| Posting writes row by row | **One statement per kind of row** (journal lines, movements, party entries and balances, costs, stock balances, floors) for every posting | A 16,753-line opening posts in about 3 s locally; row by row over a tunnel to Helsinki would take hours. |
| The last purchase on `item_costs` | Carried on the posting (`lastPurchases`), so the rebuild writes it again | The rebuild deletes and rewrites `item_costs`. |
| Each counter is reset "from its setup screen" | **The wipe revokes the counters**; each is cleared (the browser's site data, with its outbox at 0 on the health page) and enrolled again | The POS has no reset action yet; a revoked counter that wasn't cleared can't push into the clean books. A reset button can be a small later task. |
| `erp-tenant cutover` | `erp-tenant wipe-pilot` and `erp-tenant go-live <env> <shop> <lock-date>` | The final run needs both: the wipe, then the go-live mark that refuses any later wipe and sets the lock date. |
| The wipe's table list | `WIPED_TABLES` and `KEPT_TABLES`, and a test that every table in the schema is in exactly one | A table added later must be decided, not silently kept or lost. |
| — | The opening step writes `doc-types.csv` before it stops on an unmapped document type | So the signs can be decided from the report. |
| — | `quantity-mismatch.csv` also shows the period opening quantity and the sum of the stock records' own quantities | Rehearsal 1 found the computed and running quantities differing; see below. |
| — | The staging catalog's categories get the 5% margin if they have none | So the generated opening shows floors on staging. |

## Rehearsal 1 (2026-11-04, this PC, `dec2025`)

Into a fresh database `erp_rehearsal1` (migrations to 0015, the Delux tenant from its spec), `erp_dev` untouched:

| Step | Result | Time |
|---|---|--:|
| `legacy:stage` | 217,495 rows from 79 files | 12 s |
| `legacy:import` | 19,552 items, 373 parties (as in W0-13) | 119 s |
| `legacy:opening --post` | posted: **16,753 items in stock, Rs 128,033,759.87**, 0 without a cost; **42 customers Rs 679,565.00**, **69 suppliers Rs 5,791,122.00** (the migration doc's reference: ≈ Rs 0.68 M and ≈ Rs 5.79 M) | 5 s |
| re-run with `--post` | unchanged, 0 lines differ | 3 s |
| rebuild check | 0 differences; 16,753 floors from cost | 17 s |

About 2½ minutes end to end (rehearsal 2's limit: 1 hour). Reconciliation: item count, stock quantity and value (ledger vs computation), customers and suppliers (ledger vs legacy GL), the entry balanced, every item and party found: **pass**. The four legacy report totals: **waiting** (owner answer 4).

**Open: the stock quantity.** For **6,770 items** the computed closing stock (opening quantity ± purchase, sale, return and physical-stock lines) is higher than the legacy running balance in `INV_StockRecordTAB`, typically by 2 to 11 units; the running balance is negative for 3,930 items, while the migration doc expected 15 negative items. The sum of the stock records' own quantities agrees with neither consistently. Which figure the legacy Closing Stock report shows decides the rule: the owner reads a few items (e.g. ABEA003, ABEA004, ABEA008) off the legacy Closing Stock report for this dump's date, and the signs in `opening.docTypes` are confirmed. Until then the opening's quantities are not to be trusted; costs and party balances are.

## Rehearsal 2 (2026-11-05, this PC, `nov2026`)

The 2026 dump (`sql_dump/DLX_Inventory_2026`: period 07-2026, documents 1 Jul to 5 Nov 2026, 175,366 rows) into a fresh `erp_rehearsal2`, dry run, against the owner's Item Wise Closing Stock report as on 05/11/2026 (858 pages, 45,224.50 units, Rs 45,266,175.84), extracted per item into `out/nov2026/legacy-closing.csv` (git-ignored):

| Rule | Units | Items equal to the report |
|---|--:|--:|
| Item opening ± document lines (rehearsal 1) | 130,334.5 | 14,205 |
| Item opening ± stock records | 45,400.5 | 20,118 |
| **Stock records, physical counts from the count sheet (D-102)** | **45,224.5** | **20,163 (all)** |

- Legacy stores sale-line quantities negative, so the document-line rule added every sale; that explains rehearsal 1's open item.
- The 45 items the stock records missed all had a counted shortage, which the stock record stores as a positive quantity.
- **Open: the stock value.** Rs 45,654,495.69 at our cost (the latest valuation rate) against the report's Rs 45,266,175.84 at its "Average Rate" (0.9% higher). Per item: 15,115 same rate; 81 where the report's rate is 0 (+Rs 306,224); 865 with another rate (net +Rs 82,102). Checked with the owner: LAMI001 (report 0, ours 7,800) was bought 8 times in 2026 at 7,500–7,800, so the report fails to average it (a legacy bug); CLCD022 (report 8,000, ours 3,000, Retail 3,950) has no 2026 purchase and `OpeningRate` 8,000 against `CostPrice` 3,000 (a typing error in legacy). Our cost was right in both. Then `cost-compare.csv` classified them: 863 of the 865 equal the item's opening rate (old stock, no 2026 purchase; the cost price came first); 2 within Rs 25.

**The cost order changed (D-103):** valuation rate, else last purchase, else opening rate unless above Retail, else cost price. Re-run: **15,976 items equal the report's rate**; the 81 the report shows at 0 (69 at their last purchase, 8 at the opening rate, 4 at the cost price, +Rs 306,166), 2 opening rates above Retail at the cost price (CLCD022, COIL024; −Rs 6,988), 2 within Rs 25. Stock value Rs 45,565,399.37 against the report's Rs 45,266,170.53, the difference being those items, on purpose.

## Checks (2026-11-04)

- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`: pass.
- `pnpm test`: 1,810 passed, after giving the W1-11 desk tests a 15 s limit: each waits up to 5 s for a dialog inside a 5 s test, and timed out in CI on W1-11 and W1-14.
- `pnpm test:integration`: 297 passed (28 files), including the new opening, wipe and generated-opening tests.
- `pnpm e2e` (Edge): 47 passed.

## Owner answers (2026-11-04)

1. **The pilot is throwaway:** keep it simple. No cutover posting; the pilot's documents and ledgers are wiped from production before the final run, keeping masters, staff and counters, and each counter's local data is reset once its outbox is empty (design above). Old bills, legacy or pilot, are looked up in the legacy system when needed.
2. **The dumps come later:** the task is built and rehearsed on `dec2025`. Two go-live checklist items wait for the owner's dumps: re-run rehearsal 1 on the 2026 dump, and the pilot's opening from a dump taken by ~28 Nov (from the database of the current period, after the day close).
3. **Load production for the pilot:** yes. The real masters (items, prices, customers and suppliers with names and phones) go onto production before 1 Dec, and the pilot opening when its dump arrives; run from this PC over an SSH tunnel as the app role. Dumps, staging and reports stay on this PC.
4. **Legacy report totals:** yes. On each dump day the owner reads Closing Stock quantity and value, Customer Outstanding and Supplier Outstanding off the legacy app into `out/<label>/legacy-totals.json` (git-ignored). Needed at rehearsal 2 and the final run; without the file those four checks show *waiting for legacy totals*.
5. **Size:** about 3½ days, accepted.
