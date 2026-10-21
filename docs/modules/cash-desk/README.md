# Cash desk (`CSH`)

| | |
|---|---|
| **Status** | Not started (build on hold, D-068) |
| **Requirements** | 9 (CSH-01…CSH-09) |
| **Feature spec needed** | No: covered by the PRD and posting rules |

## Scope

Cash sessions, live handover queue, scan handover, refund payouts, collections, cash-out, denomination drawer close, business-day reconciliation, handover setting.

## Requirements

Full wording is in [the PRD](../../01-PRD.md). Wave 1 = critical path for go-live, Wave 2 = rest of the MVP.

| ID | Summary | Wave |
|---|---|---|
| CSH-01 | Cash session: open with float, belongs to one cash desk device and cashier. | 1 |
| CSH-02 | Live queue of cash bills awaiting handover and refunds awaiting payout, updated within seconds when online and grouped by salesman. | 1 |
| CSH-03 | Scan handover: scanning a bill's code jumps to it in the queue. | 1 |
| CSH-04 | Refund payout from the queue, or by scanning (W7). | 1 |
| CSH-05 | Customer collections with receipt print (W8). | 1 |
| CSH-06 | Cash-out: expense (category), supplier payment (party), bank deposit (bank account), each with a note and reference (W9). | 1 |
| CSH-07 | Drawer close by denomination, expected vs counted, variance with a reason and manager acknowledgement (W10.1). | 1 |
| CSH-08 | Business-day reconciliation report (W10.2): missing handovers (when Required), exceptions, provisional/final status. | 1 |
| CSH-09 | Handover confirmation Off mode: automatic handovers for all cash bills and refunds, and the drawer close expects every finalized cash bill (W4, W10). | 2 |

## Related

PRD W4, W7–W10; architecture §4.6; posting rules §4.5; D-003, D-024, D-025, D-047, D-049, D-059

## Work in this module

- `spec.md`: only if needed (see above), written before the first plan that depends on it.
- `plans/<wave>-<nn>-<slug>.md`: one accepted plan per task, before any code ([delivery process](../../07-DELIVERY-PROCESS.md) §3).
- `intent.md`: only for changes after the MVP.
