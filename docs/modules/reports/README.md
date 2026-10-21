# Reports (`RPT`)

| | |
|---|---|
| **Status** | Not started (build on hold, D-068) |
| **Requirements** | 10 (RPT-01…RPT-10) |
| **Feature spec needed** | No |

## Scope

Daily sales register, day reconciliation, overrides, voids and returns, stock and valuation, ageing, profit by item/category/salesman, dead stock, purchase analysis, exceptions.

## Requirements

Full wording is in [the PRD](../../01-PRD.md). Wave 1 = critical path for go-live, Wave 2 = rest of the MVP.

| ID | Summary | Wave |
|---|---|---|
| RPT-01 | Daily sales register (by bill, salesman, counter, tender) | 1 |
| RPT-02 | Day reconciliation and cash variance by session / cashier | 1 |
| RPT-03 | Overrides and below-list sales by salesman, item, approver | 1 |
| RPT-04 | Voids and reissues; returns by reason and condition, salesman, item | 1 |
| RPT-05 | Current stock by location; stock valuation | 1 |
| RPT-06 | Customer outstanding and ageing; supplier outstanding and ageing | 1 |
| RPT-07 | Sales and gross profit by item, category, brand, salesman, period | 2 |
| RPT-08 | Dead/slow stock (no sale in N days, with value) | 2 |
| RPT-09 | Purchase register; item purchase vs sale rate analysis (legacy parity) | 2 |
| RPT-10 | Exceptions: below-floor sales without override, offline cap breaches, negative stock, clock skew, cash received for a voided bill, barcode amount not… | 1 |

## Related

PRD §6.8; observability dashboards (architecture §11)

## Work in this module

- `spec.md`: only if needed (see above), written before the first plan that depends on it.
- `plans/<wave>-<nn>-<slug>.md`: one accepted plan per task, before any code ([delivery process](../../07-DELIVERY-PROCESS.md) §3).
- `intent.md`: only for changes after the MVP.
