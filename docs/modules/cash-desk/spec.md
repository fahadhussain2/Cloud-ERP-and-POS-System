# Cash desk: spec

| | |
|---|---|
| **Status** | Accepted v1 with the [W1-10 plan](plans/W1-10-cash-desk-handover.md) and owner answers 1–4 (2026-11-01), D-097: session, live queue, scan handover, refund payout. Collections, cash-out, the denomination close and the day reconciliation come with W1-11. |
| **Refs** | CSH-01, CSH-02, CSH-03, CSH-04; PRD W4, W7, W15; architecture §4.4–§4.7; data model §6, §12; posting rules §4.5; sync spec §3, §6.2, §8; CLAUDE.md rules 1, 3, 6, 7, 9, 10; D-001, D-024, D-047, D-049, D-055, D-059, D-097 |

The PRD (W4, W7) says what the cash desk does; this spec fixes how it behaves, precisely enough to build and test. The rules are `checkHandover`, `buildHandoverDocument`, `reviewHandover`, `queueGroups`, `expectedCash` and `buildSessionDocument` in `packages/domain`; the desk and the server use the same functions (rule 2).

## 1. The desk is the POS app

A device of kind `cash_desk` (`D01…`, platform spec §1) runs the same app as a counter. After unlock, someone who holds `cash.handover.receive` lands on the **Cash desk** screen; anyone else lands on selling. **`Alt+Q`** switches between the two: the desk also sells (D-001). A counter (`C…`) has no Cash desk screen.

## 2. The session (CSH-01)

- **Open** (`Alt+O`, needs `cash.handover.receive`): the **opening float**, whole rupees, 0 or more: the cash already in the drawer. One open session per desk; it belongs to the cashier who opened it.
- **While open**, only its cashier takes cash. Another cashier who unlocks sees *Ali's session is open since 10:02* and can only sell.
- **Close** (`Alt+X`, anyone with `cash.session.close`, owner answer 1): shows the **expected cash** = float + handovers in − payouts, and closes the session so the next cashier opens their own. No count yet: the denomination close, the variance and its acknowledgement come with W1-11 (CSH-07). Until then the drawer is counted the legacy way (D-090).
- **The float posts nothing**: it is cash already in the drawer. Moving cash from the safe is a cash movement (W1-11).

## 3. The live queue (CSH-02)

- **What it holds:** the pulled `cash_queue` (sync spec §3): the branch's bills with cash due ≠ 0, pending or of the last 7 days. The screen lists those still `pending` and not voided, **minus the bills this desk has handed over already** (so one leaves the queue at once, before the server confirms).
- **Grouped by salesman** (by name; one the desk has no name for comes last), each group with *Bring Rs X* and, for refunds, *Pay out Rs Y*. Bills oldest first. Each row: counter, bill number, time, the amount (green; a refund in orange as *Pay out Rs 450*), the salesman's cash received (*Exact* when left empty) and the change.
- **Updates within seconds:** the server sends `queue-changed` to the branch's desks after any change to a bill with cash (sync spec §8), and the desk pulls. Target: finalize to visible ≤ 5 s (architecture §4.6); the e2e checks it.
- **Keys:** `↑ ↓` select · **Enter** confirms the selected bill as shown · **`E`** corrects the cash received first · a click selects a row. The scan field always has the focus when no dialog is open; the queue scrolls inside its panel, the session bar and the scan field never move (POS-17).

## 4. Confirming: the handover check

`checkHandover` gives the first problem, in this order, as an i18n key `handover.<code>`:

| Code | When |
|---|---|
| `nothing_to_collect` | a code with amount 0: paid without cash |
| `no_session` | no session open on this desk |
| `not_session_cashier` | another cashier's session |
| `not_permitted` | without `cash.handover.receive` (a bill) or `cash.refund.pay` (a refund) |
| `already_handed_over` | this desk has a handover of the bill (with its number, cashier and time), or the server says it is received or paid out |
| `received_not_rounded` | a correction that isn't whole rupees |
| `received_short` | a correction below the amount due |

**What is recorded:** the cash received is the cashier's correction, else the salesman's figure, else the exact amount; the change is cash received − amount. When the cashier changes the figure, the salesman's is kept as `correctedFrom`. A bill known only from its code records no cash received or change unless the cashier types one. A payout records neither. **The bill itself is never changed** (rule 3).

## 5. Scanning (CSH-03)

The scanner types the bill code (`C03-S000412 4320`, POS spec §13) and Enter into the scan field; `parseBillCode` reads it (a refund has a minus: `C03-S000415 -450`; `-0` is refused).

- **In the queue:** the bill is selected; Enter then records it (method `scan`).
- **Not in the queue** (its counter hasn't synced, or the desk is offline): *C04-S000077 isn't in the queue yet. Record Rs 1,250 from the bill?* Enter records it from the code's number and amount, with no sale id (owner answer 2). Esc cancels.
- **Already handed over here:** refused with *Already handed over: D01-H000031 by Ali at 10:16*; nothing is written.
- **Not a bill code** (an item label, a typo): *That isn't a bill code*.

**Offline** the queue stays on screen but stops updating; a banner says *Offline since 14:05 · the queue is not updating · scan each bill*. Handovers keep being written and wait in the outbox (PRD W15).

## 6. Refund payouts (CSH-04)

A bill with cash due < 0 is a refund: in the queue in orange, recorded as a **payout** (`kind: payout`, `cash.refund.pay`), by the queue or by scanning its code, the same way as a handover. The first real refunds come with returns (W1-13).

## 7. The desk's own sales

A cash sale (or refund) finalized on the desk itself is **handed over automatically** (method `auto`) in the same local transaction as the bill, to the open session and its cashier, whoever sold (owner answer 4). With no open session the bill waits in the queue like any other.

## 8. The documents

Each is written with its outbox row in **one local transaction** (rule 6), signed after the commit like a bill (POS spec §12), and pushed at once. Contracts: `CashHandoverV1`, `CashSessionV1` in `@erp/contracts`.

**Handover** (family `H`, `D01-H000001`): `id` (UUIDv7), `seq`, `number`, `kind` (`in` | `payout`), `deviceId`, `branchId`, `sessionId`, `cashierId`, `billNumber`, `saleDocumentId` (null when known only from the code), `amount` (the cash due or the refund, positive: **the posted figure**), `cashReceived`, `changeGiven`, `correctedFrom`, `method` (`queue` | `scan` | `auto`), `createdAt`, `businessDate` (04:00 cutoff, D-056), `clientVersion`.

**Session** (family `Z`, `D01-Z000001`): `event` (`open` | `close`), `sessionId` (the open document's id), `userId` (who opened or closed), `openingFloat` (open only), `expectedCash` (close only), and the same identity, time and version fields.

## 9. On the server

Push (sync spec §6.2) takes `H` and `Z` only from a cash desk. A handover is **linked to its bill by number**, now or when the bill arrives, and the bill becomes `received` or `paid_out`. A bill's cash and its handovers are judged one transaction at a time (a per-bill lock), because a scan and its bill often arrive together. Findings, never refusals (D-011):

| Exception | Severity | When |
|---|---|---|
| `handover_amount_mismatch` | medium | the amount (or its direction) differs from the bill's cash due, once both are there (D-059) |
| `duplicate_handover` | medium | the bill already has a handover of that kind: kept with `duplicate_of_id`, **never posted** |
| `handover_not_permitted` | low | the server says the cashier lacks the permission |

Each handover posts `Dr CASH_DRAWER / Cr CASH_IN_TRANSIT` (a payout the reverse) for its own amount (posting rules §4.5), so its order against the bill doesn't matter. Cash received, corrections and change never post.

## 10. Not built yet

Collections, cash-out, the denomination close and the day reconciliation with its missing handovers (W1-11); `cash_handover_mode = off` (CSH-09, Wave 2: the desk shows the queue regardless); voids before the handover and `cash_received_for_void` (W1-12); undoing a handover confirmed by mistake (it shows in the drawer variance); a printed handover slip.
