# Inventory (`INV`)

| | |
|---|---|
| **Status** | Not started (build on hold, D-068) |
| **Requirements** | 7 (INV-01…INV-07) |
| **Feature spec needed** | No |

## Scope

Stock ledger and balances per location, weighted average cost, negative-stock alerts, transfers, adjustments, phone cycle counts, item stock card.

## Requirements

Full wording is in [the PRD](../../01-PRD.md). Wave 1 = critical path for go-live, Wave 2 = rest of the MVP.

| ID | Summary | Wave |
|---|---|---|
| INV-01 | Append-only stock ledger per item and location, written from documents. | 1 |
| INV-02 | Weighted average cost per item (tenant-wide), updated on receipt. | 1 |
| INV-03 | Negative stock allowed (sales are never blocked) and creates alerts. | 1 |
| INV-04 | Transfers between locations (Godown ↔ Shop, any → Damaged). | 1 |
| INV-05 | Stock adjustments with reason codes (manager), valued and posted. | 1 |
| INV-06 | Cycle counts on a phone browser, blind, scope-based, auto-adjusting for sales during the count, with a variance approval step (W14). | 2 |
| INV-07 | Item stock card: every movement with document link, quantity, cost and running balance. | 1 |

## Related

PRD W13–W14; data model §7; posting rules §5.3–5.4; D-015, D-017, D-018

## Work in this module

- `spec.md`: only if needed (see above), written before the first plan that depends on it.
- `plans/<wave>-<nn>-<slug>.md`: one accepted plan per task, before any code ([delivery process](../../07-DELIVERY-PROCESS.md) §3).
- `intent.md`: only for changes after the MVP.
