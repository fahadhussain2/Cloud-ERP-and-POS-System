# Legacy migration (`MIG`)

| | |
|---|---|
| **Status** | In progress: W0-12 (parse and stage) |
| **Requirements** | 4 (MIG-01…MIG-04) |
| **Feature spec needed** | Yes: importer design (parser, staging, transform, load) |

## Scope

Importer for the legacy SQL Server dumps: masters, opening balances, 90 days of bills, cleanup and reconciliation reports.

## Requirements

Full wording is in [the PRD](../../01-PRD.md). Wave 1 = critical path for go-live, Wave 2 = rest of the MVP.

| ID | Summary | Wave |
|---|---|---|
| MIG-01 | Repeatable importer for masters (items, categories, brands, origins, parties, chart of accounts) with cleanup reports. | 1 |
| MIG-02 | Opening balances at cutover: stock quantity (into Shop) and average cost, customer and supplier balances, GL opening entry. | 1 |
| MIG-03 | The last 90 days of legacy sale bills imported read-only for return lookup. | 1 |
| MIG-04 | Reconciliation report: counts, stock value, AR/AP totals and trial balance vs legacy. | 1 |

## Related

docs/05-LEGACY-MIGRATION.md (all); D-030, D-034, D-052, D-055

## Work in this module

- `spec.md`: only if needed (see above), written before the first plan that depends on it.
- `plans/<wave>-<nn>-<slug>.md`: one accepted plan per task, before any code ([delivery process](../../07-DELIVERY-PROCESS.md) §3).
- `intent.md`: only for changes after the MVP.
