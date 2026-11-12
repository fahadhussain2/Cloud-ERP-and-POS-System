---
name: legacy-migration
description: Importing the legacy SQL Server data (SSMS UTF-16 script dumps of DLX_Inventory) into the new system: parsing, staging, field mapping, cleanup reports, opening balances and reconciliation (no sale bills, D-100). Use whenever working on tools/legacy-import, migration rehearsals or opening balances.
---

# Legacy migration

**Source of truth:** `docs/05-LEGACY-MIGRATION.md` (mapping tables, rules, reconciliation), PRD MIG-01…04, D-030, D-034, D-052, D-055.

## Data protection (hard rule)
- `sql_dump/` holds customer contacts, employee names and legacy passwords. **Only `tools/legacy-import` reads it** (a hook blocks every other access).
- **Never** read, print, log or migrate `Admin_Users.UserPassword` or CNIC values. Never commit dumps, staging databases or reports with personal data.
- Reports shown to the owner mask phone numbers.

## Pipeline
`parse` (UTF-16 LE, `INSERT … VALUES`, `CAST(0x… AS DateTime)` = 4-byte days since 1900-01-01 + 4-byte ticks of 1/300 s) → `stage` (raw `legacy_*` tables, untouched) → `transform` (mapping rules) → `report` (cleanup + reconciliation) → `load` (one transaction per entity group).

- **Idempotent:** every loaded row keeps `legacy` JSONB with its original keys, so a re-run updates instead of duplicating. `--dry-run` writes reports only.
- **Never auto-delete or auto-merge.** Report it; the owner decides. Decisions go in a mapping file that is re-applied on every run.

## Key mapping rules (details in doc 05 §3)
- `ItemID` is kept **exactly** as the item code and barcode (labels on shelves use it).
- `Brand` values that are countries → the item's **origin**. `GENUINE` → brand "Genuine (OEM)".
- `Manufacture`: vehicle makes on the allow-list → `vehicle_makes`; everything else (H4, 6PK, 6203…) → `items.spec`.
- `Model`: year ranges → `year_from/to` (`ON` = open-ended); other text → model name.
- `PartNo`: looks like a part number → OEM identifier; otherwise → `spec` plus a cleanup report.
- Partners `0001`/`0002` (cash purchase/sale) are not parties. A partner with both roles = one party with two accounts.
- Opening stock = legacy closing quantity, all into **SHOP**; cost = latest `ValuationRate`, falling back to `CostPrice`.
- AR/AP = GL control-account balance per `SubAccountCode`.
- **No sale bills** are imported (D-100, MIG-03 dropped): a part bought before go-live is a no-receipt return priced by the manager.

## Reconciliation gate (doc 05 §8)
Exact item count · stock quantity and value vs the legacy closing-stock report · AR/AP totals vs the legacy outstanding reports · balanced opening journal. The owner signs off the top 20 AR/AP balances.
