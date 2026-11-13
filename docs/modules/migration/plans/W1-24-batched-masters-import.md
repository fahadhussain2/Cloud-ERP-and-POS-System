# W1-24 Batch the masters import's writes

| | |
|---|---|
| **Issue** | [#151](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/151) |
| **Module** | migration (`tools/legacy-import`, the load step) |
| **Status** | Done (2026-11-13): built in PR #153; the masters loaded onto production with it (results below). Plan accepted in PR #152 |
| **Refs** | MIG-01; D-084 (the dump stays on the owner's PC), D-085 (the import runs as the app role under RLS); W0-13 (the importer); W1-14 owner answer 3 (the masters on production before 1 Dec); the runbook `docs/runbooks/load-masters-production.md` (#150) |
| **Depends on** | W0-13 |
| **Size** | about ½ day: the batched writes ¼, the tests and the comparison with the current importer ¼ |
| **Test-first** | Yes: the number of queries doesn't grow with the number of rows; every existing load test unchanged |

## The problem

`pnpm legacy:import` sends **one query per row**: an `INSERT` for each new item, identifier, vehicle tag and price, and an `UPDATE` for each changed one (`upsert` and `syncChildren` in `tools/legacy-import/src/load.ts`). The Delux masters are about 150,000 rows (`nov2026`):
- 20,163 items;
- about 29,000 identifiers and 19,000 vehicle tags;
- 60,489 prices;
- the parties and the reference data.

Locally that takes about 2 minutes. The production load runs over an SSH tunnel to Helsinki, where each query waits one round trip, measured at **about 0.17 s** from the owner's PC:
- the load would take **about 7 hours**;
- the dry run, which does everything in one transaction and rolls it back, would hold that transaction open on production for as long.

## Goal

**The masters load onto production in minutes,** with exactly the result the importer gives today: the same rows, the same counts (*created, updated, unchanged, retired*), the same idempotent second run, still as `erp_app` under RLS.

## Design

| Choice | Why |
|---|---|
| **The comparison stays as it is.** The importer still reads the table's existing rows once and decides in memory what is new, what changed and what is gone | That part is already one query per table; only the writes are row by row |
| **New rows go in batches of up to 2,000 rows per query:** `INSERT INTO erp.<table> (<columns>) SELECT <columns> FROM jsonb_populate_recordset(NULL::erp.<table>, $1) RETURNING id, <key>` | `jsonb_populate_recordset` takes the column types from the table itself, so there's no per-column cast to get wrong, and arrays and `jsonb` columns go through as they are. `RETURNING` the key gives each new row's id to the steps after it (items to their prices, parties to their accounts) |
| **Changed rows go in batches too:** one `UPDATE … FROM jsonb_populate_recordset(…)` per set of changed columns | Only what differs is written, as today, so no row is touched without a change |
| **Retired child rows:** one `UPDATE … SET deleted_at = now() WHERE id = ANY($1)` | The same soft delete as today |
| **The chart step stays row by row** | 44 accounts with their own code numbering; about 8 s over the tunnel |
| **Each run reports its number of queries** (`queries` in `summary.json` and on screen) | It makes the time over the tunnel predictable before a production run: queries × 0.17 s, plus the data itself |
| **Nothing else changes:** the groups and their transactions, the dry run (one transaction, rolled back), the reports, the mapping file and `legacy:opening` | The opening load already writes in batches (`unnest` in `opening-load.ts`) |

Expected over the tunnel, for the `nov2026` masters:
- **about 150 queries** (the reads, about 70 batches, the chart's 44 accounts and each group's transaction), about 25 to 30 s of round trips;
- **the data itself,** some tens of MB through SSH.

That's minutes, not hours, and the dry run's transaction lasts as long.

## Scope

- **In:**
  - `tools/legacy-import/src/load.ts`: batched inserts, updates and retirements in `upsert` and `syncChildren`; the query count.
  - Its tests.
  - The runbook (#150): the real timing and the query count, and the status from *not usable yet* to ready for a dry run.
  - `docs/WAVE-1-TASKS.md`: the W1-24 row.
- **Out:**
  - the staging step (`legacy:stage`) and the opening (`legacy:opening`);
  - running the importer anywhere but the owner's PC (D-084);
  - the production load itself: that's the runbook, run by the owner after this is merged.

## Tests written first

- **Integration (`load.int.test.ts`), failing first:**
  - The number of queries to the target doesn't grow with the rows: the fixture with its items, and the same with ten times as many generated items, use the same number of queries, give or take a batch per 2,000 rows.
  - Today it grows by one per row.
- **Every existing load test passes unchanged:**
  - the first import;
  - the second run changing nothing;
  - the dry run writing nothing;
  - a changed decision updating only the affected rows;
  - a retired identifier;
  - a missing item reported, not deleted;
  - the shop that doesn't exist;
  - the reports.
- **A batch boundary:** more than 2,000 new rows in one table, so a second batch runs. Every id goes to the right key, and the prices land on the right items.

## Verify

1. `pnpm check` and `pnpm test:integration`, output shown.
2. **The same result as today, on this PC:**
   - import `nov2026` into two fresh copies of the Delux shop, one with the current importer (`staging` before this change) and one with the new one;
   - compare every imported table's rows without ids and timestamps: no difference;
   - the counts in both `summary.json` files equal.
3. **The time, on this PC:** the local run and its query count. A run through a local `ssh -L` to the local database gives no real latency. The production estimate is the query count × 0.17 s, and the first dry run on production (the runbook) confirms it.

## Results (2026-11-12)

**The tests first:** the three new ones failed on the row-by-row importer, as planned:
- 2,105 items sent 10,500 more queries than 5 items;
- 2,100 changed prices sent 8,085 more than a run that changed nothing.

With the batched writes all 18 load tests pass, the 15 existing ones unchanged.

**The same result as the current importer** (`nov2026` into two fresh Delux shops on this PC):

| | Current (`staging`) | Batched |
|---|--:|--:|
| Time, locally | 309 s | 12 s |
| Queries to the target | about 150,000 | **153** |
| A second run | | 33 queries, nothing changed |
| A dry run on the loaded shop | | 21 queries |

- The counts per group and the findings are equal.
- Every imported table (units to expense categories, 14 tables) has the same rows, compared without ids, timestamps, `txid` and `row_version`, with the foreign keys compared by their codes: no difference.
- **`row_version` was left out on purpose:** it comes from one shared sequence, so its numbers follow the order of the writes. The batched insert numbers all customer accounts first, then the trigger touches their parties; row by row it alternated. In both shops every customer's party is still newer than its account (`row_version` and `txid`), which is what the touch is for: the counter's next pull sends it (W1-09).

**Over the tunnel:** 153 queries × 0.17 s ≈ 26 s of round trips, plus the data, so a few minutes instead of about 7 hours.

## On production (2026-11-13)

The owner ran the runbook from this PC, over the SSH tunnel as `erp_app`:
- **The dry run:** **1 min 24 s, 141 queries** (one transaction, so fewer than the 153 of a load), nothing written. Every count as in the runbook's table and the local comparison: 20,163 items, 29,175 identifiers, 19,109 vehicle tags, 60,489 prices, 377 parties (134 customer and 287 supplier accounts), 44 accounts (35 created, 9 updated), 35 expense categories; nothing retired.
- **The load:** succeeded; the items show in the production back office.
- **`erp-tenant posting-check prod delux`:** clean.

Found on the way and fixed in the runbook: the container-address command broke in PowerShell (now `{{json …}}`, no `$`); the other steps need Git Bash; the local database must be up (it had stopped by itself twice that evening).

## Questions for you

1. **Size:** about ½ day. Accept? *Accepted (PR #152).*

## Risks

| Risk | Mitigation |
|---|---|
| A batched write puts a value in the wrong row | The ids come back with their keys, not by position; the batch-boundary test and the whole-table comparison with the current importer |
| A column type `jsonb_populate_recordset` reads differently (an array, a `numeric`) | The comparison with the current importer covers every imported column |
| A large batch is too big for one query | 2,000 rows a batch, about 1 MB for items; far below PostgreSQL's limits |
