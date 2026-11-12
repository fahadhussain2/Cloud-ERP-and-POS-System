# Cash desk (`CSH`)

| | |
|---|---|
| **Status** | Cash desk 1 built in W1-10 (session, live queue, scan handover, refund payout), D-097; cash desk 2 built in W1-11 (collections, cash-out, the counted close, the day reconciliation), D-098; [W1-23](plans/W1-23-void-cash-settlement.md) done and verified on staging (voids and returns by payment, both refund guards, cash for a voided bill given back), D-111 |
| **Requirements** | 9 (CSH-01…CSH-09) |
| **Feature spec** | [spec.md](spec.md) (W1-10, W1-11) |

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

PRD W4, W7–W10; architecture §4.6; posting rules §4.5; D-003, D-024, D-025, D-047, D-049, D-059, D-097, D-098

## Work in this module

- [`spec.md`](spec.md): the cash desk's behaviour (W1-10, W1-11).
- Plans: [W1-10 cash desk 1](plans/W1-10-cash-desk-handover.md), [W1-11 cash desk 2](plans/W1-11-collections-cash-out-close.md).
- `plans/<wave>-<nn>-<slug>.md`: one accepted plan per task, before any code ([delivery process](../../07-DELIVERY-PROCESS.md) §3).
- `intent.md`: only for changes after the MVP.
