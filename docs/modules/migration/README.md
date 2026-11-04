# Legacy migration (`MIG`)

| | |
|---|---|
| **Status** | In progress: W0-12, W0-13 done; W1-14 (opening balances, reconciliation, rehearsal 1) built |
| **Requirements** | 4 (MIG-01…MIG-04) |
| **Feature spec needed** | Yes: importer design (parser, staging, transform, load) |

## Scope

Importer for the legacy SQL Server dumps: masters, opening balances, cleanup and reconciliation reports. No sale bills (D-100).

## Requirements

Full wording is in [the PRD](../../01-PRD.md). Wave 1 = critical path for go-live, Wave 2 = rest of the MVP.

| ID | Summary | Wave |
|---|---|---|
| MIG-01 | Repeatable importer for masters (items, categories, brands, origins, parties, chart of accounts) with cleanup reports. | 1 |
| MIG-02 | Opening balances at cutover: stock quantity (into Shop) and average cost, customer and supplier balances, GL opening entry. | 1 |
| MIG-03 | ~~The last 90 days of legacy sale bills imported read-only for return lookup.~~ Dropped (D-100): pre-go-live returns are no-receipt returns. | – |
| MIG-04 | Reconciliation report: counts, stock value, AR/AP totals and trial balance vs legacy. | 1 |

## Running the importer

On the owner's PC only (D-084). Staging goes into the `erp_legacy` database on the local PostgreSQL:

```bash
pnpm db:up
pnpm legacy:stage --label dec2025
```

- The dump is read from `sql_dump/` at the repo root; `--dump <folder>` picks another copy (e.g. a 2026 dump in its own folder, with its own label).
- The report is `tools/legacy-import/out/<label>/staging-report.md`: counts per table, the dropped credential columns and every staged column name. No values.
- A run stops, and stages nothing, if a statement is unknown, the counts disagree, or a value looks like a CNIC in a column that isn't dropped. Reviewed exceptions go in `tools/legacy-import/columns.json` (column names only).

### Loading the masters (W0-13)

```bash
pnpm dev:db
pnpm legacy:import --label dec2025
```

- Staging gets a **generated** catalog, never the real one (W1-21, D-076): `erp-tenant seed-catalog staging demo` (see the infra README).
- `pnpm dev:db` creates the local `erp_dev` database with the migrations and the Delux tenant (from `infra/db/tenants/delux.json`). Safe to run again.
- `pnpm dev:reset-password fahad "<temporary password>"` gives the owner (or anyone, by username) a temporary back-office password on `erp_dev`, to change at the next sign-in. Optional third and fourth arguments: another local database (e.g. a copy) and shop code.
- `pnpm legacy:import` loads units, categories, brands, origins, vehicle makes, parties, items (identifiers, vehicle tags, tier prices) and the legacy expense accounts into it, as the app role under RLS. A second run prints `unchanged` everywhere. `--dry-run` (or the `transform` step) compares and reports without writing.
- The owner's decisions live in `tools/legacy-import/mapping/delux.json` (codes and catalog words only). Edit it after the review and run the import again.
- Reports: `tools/legacy-import/out/<label>/reports/index.html` (with CSVs for Excel). Party reports have names and masked phones; `summary.json` has counts only.

### Opening balances (W1-14)

```bash
pnpm legacy:opening --label dec2025 --as-of 2025-12-31 --date 2026-01-01 --dry-run
pnpm legacy:opening --label dec2025 --as-of 2025-12-31 --date 2026-01-01
pnpm legacy:opening --label dec2025 --as-of 2025-12-31 --date 2026-01-01 --post
```

- Run after `pnpm legacy:import` for the same label. `--as-of` is the legacy cutoff (inclusive), `--date` the day the opening posts on.
- Without `--dry-run` it writes or replaces the **draft**; `--post` posts it, once. A re-run after posting changes nothing and counts the lines that differ.
- **Document types:** each legacy stock document type needs a sign in `opening.docTypes` of the mapping file. An unmapped one stops the run after writing `reports/opening/doc-types.csv`.
- **Inputs** (git-ignored, next to the label's reports in `out/<label>/`): `opening-inputs.json` = the counted drawer and the bank statement balances by account code in rupees (`{"accounts": {"1110": "5000", "1160": "250000"}}`); `legacy-totals.json` = the four totals read off the legacy reports (`closingStockQty`, `closingStockValue`, `customerOutstanding`, `supplierOutstanding`).
- **Reports:** `out/<label>/reports/opening/reconciliation.html` (the checks to sign) and CSVs; `opening/parties/` holds names and amounts and stays on this PC; `summary.json` holds totals and counts only.
- **Another database:** `LEGACY_TARGET_URL` (as the app role), e.g. a rehearsal copy, or production over an SSH tunnel.

## Related

docs/05-LEGACY-MIGRATION.md (all); D-030, D-034, D-052, D-055

## Work in this module

- `spec.md`: only if needed (see above), written before the first plan that depends on it.
- `plans/<wave>-<nn>-<slug>.md`: one accepted plan per task, before any code ([delivery process](../../07-DELIVERY-PROCESS.md) §3).
- `intent.md`: only for changes after the MVP.
