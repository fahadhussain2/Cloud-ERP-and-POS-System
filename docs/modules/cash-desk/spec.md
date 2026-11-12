# Cash desk: spec

| | |
|---|---|
| **Status** | Accepted v1 with the [W1-10 plan](plans/W1-10-cash-desk-handover.md) and owner answers 1–4 (2026-11-01), D-097: session, live queue, scan handover, refund payout. v2 with the [W1-11 plan](plans/W1-11-collections-cash-out-close.md) and owner answers 1–5 (2026-11-02), D-098: collections, cash-out and the safe, the counted close, the day reconciliation and the cash variance. |
| **Refs** | CSH-01…CSH-08, RPT-02; PRD W4, W7–W10, W15; architecture §4.4–§4.7; data model §6, §12; posting rules §4.5; sync spec §3, §6.2, §8; CLAUDE.md rules 1, 3, 6, 7, 9, 10; D-001, D-024, D-025, D-047, D-049, D-055, D-059, D-097, D-098 |

The PRD (W4, W7–W10) says what the cash desk does; this spec fixes how it behaves, precisely enough to build and test. The rules are `checkHandover`, `buildHandoverDocument`, `reviewHandover`, `queueGroups`, `expectedCash`, `buildSessionDocument`, `checkCollection`, `checkCashMovement`, `countDrawer`, `checkClose`, `reviewDeskDocument`, `reviewSession` and `reconcileDay` in `packages/domain`; the desk and the server use the same functions (rule 2).

## 1. The desk is the POS app

A device of kind `cash_desk` (`D01…`, platform spec §1) runs the same app as a counter. After unlock, someone who holds `cash.handover.receive` lands on the **Cash desk** screen; anyone else lands on selling. **`Alt+Q`** switches between the two: the desk also sells (D-001). A counter (`C…`) has no Cash desk screen.

## 2. The session (CSH-01)

- **Open** (`Alt+O`, needs `cash.handover.receive`): the **opening float**, whole rupees, 0 or more: the cash already in the drawer. It is filled in with what stayed in the drawer at this desk's last counted close (`floatExpected` on the document). One open session per desk; it belongs to the cashier who opened it.
- **While open**, only its cashier takes cash. Another cashier who unlocks sees *Ali's session is open since 10:02* and can only sell. The session bar shows the float, handed in, paid out, collected, cash out and the **expected cash** (§9).
- **Close** (`Alt+X`, anyone with `cash.session.close`, owner answer 1 to W1-10): the drawer count, §10. The next cashier opens their own.
- **The float posts nothing** when it is what stayed (or on a desk's first session). A float typed differently posts the difference between `CASH_SHORT_OVER` and `CASH_DRAWER` and is flagged `float_mismatch` (owner answer 3 to W1-11).

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
- **A voided bill** (the queue says so, or this desk voided it): refused with *C03-S000412 was voided: don't take cash for it* (`handover.bill_voided`, W1-12). Offline the desk can't know; the server flags it (`cash_received_for_void`, §13).
- **Not a bill code** (an item label, a typo): *That isn't a bill code*.

**Offline** the queue stays on screen but stops updating; a banner says *Offline since 14:05 · the queue is not updating · scan each bill*. Handovers keep being written and wait in the outbox (PRD W15).

## 6. Refund payouts (CSH-04)

A bill with cash due < 0 is a refund: in the queue in orange, recorded as a **payout** (`kind: payout`, `cash.refund.pay`), by the queue or by scanning its code, the same way as a handover. Refunds come from returns and exchanges (POS spec §19, W1-13): a counter's *Refund cash at desk* puts the return in the queue within seconds, and the bill says *Refund due Rs 450, collect at the cash desk*.

## 7. The desk's own sales

A cash sale (or refund) finalized on the desk itself is **handed over automatically** (method `auto`) in the same local transaction as the bill, to the open session and its cashier, whoever sold (owner answer 4). With no open session the bill waits in the queue like any other.

## 8. Collections (CSH-05, `Alt+R`)

Needs `cash.collection.receive` and the open session's cashier. Find the customer (the same search as `F4`: code, phone, name or city); the dialog shows what they **owe** as this desk knows it (the last synced balance, plus this desk's unsynced bills on account, minus its unsynced collections) and their last collection here. Type the amount and pick the method: any active method except on account; a method with `requiresReference` needs its reference (40 characters at most). Cash is whole rupees. Paying more than the balance is allowed: the rest is an **advance**. *Receive & print (Enter)* writes the document and prints the **receipt** (customer, amount, method and reference, balance before and after *as of the last sync*, cashier). Customer ageing at the desk comes with W1-20 (owner answer 4).

`checkCollection`'s first problem, as `collection.<code>`: `no_session`, `not_session_cashier`, `not_permitted`, `no_customer`, `invalid_method`, `amount_not_positive`, `amount_not_rounded`, `reference_required`, `reference_too_long`, `note_too_long`. Only cash collections count in the expected cash.

## 9. Cash-out and the safe (CSH-06, `Alt+M`)

Needs `cash.movement.create` and the open session's cashier. Five kinds, each naming exactly what it needs:

| Kind | Names | Note |
|---|---|---|
| `expense` | an active expense category | required |
| `supplier_payment` | a supplier (shown with what we owe them) | required |
| `bank_deposit` | an active bank account of kind `bank` | required |
| `to_safe`, `from_safe` | nothing | optional |

Amounts are whole rupees; a reference is optional. Money out above the **expected cash** asks for a second Enter (*Only Rs 3,200 should be in the drawer*), it never refuses: the figure may be what is wrong. The **voucher** prints for the three cash-outs, with a line for the receiver to sign. `checkCashMovement`'s problems, as `cashOut.<code>`: `no_session`, `not_session_cashier`, `not_permitted`, `amount_not_positive`, `amount_not_rounded`, `missing_target`, `extra_target`, `note_required`, `note_too_long`, `reference_too_long`, `over_drawer`.

**Expected cash** = float + handovers in − payouts + cash collections − expenses − supplier payments − bank deposits − to safe + from safe.

## 10. The drawer close (CSH-07, `Alt+X`)

1. **The count, blind** (owner answer 2): a row per note and coin of the currency (PKR 5000 … 1; the Rs 10 note and coin are one row), count × note = line total, the counted total below. The expected cash shows nowhere meanwhile, not even in the session bar. *Count done (Enter)*.
2. **The variance** = counted − expected: *Exact* (green), *Short Rs 300* (red), *Over Rs 50* (orange). A variance needs a **reason** (`change_error`, `wrong_bill_confirmed`, `unrecorded_cash_out`, `counterfeit_note`, `unknown`, `other` with a note) and a **manager's acknowledgement** (owner answer 1): a person with `cash.variance.approve`, never the session's cashier, picks their name and enters their PIN (checked offline like an approval, POS spec §10); or *Acknowledge later*, which closes anyway and leaves the variance *waiting* for the back office.
3. **What stays in the drawer** for the next session (default: all of the count, whole rupees, 0 to the count); the rest goes to the safe with the close (owner answer 3).
4. *Close & print (Enter)* writes the close and prints the **close slip** (the count by note, expected, variance and reason, what stayed, what went to the safe, the cashier, who acknowledged or *to acknowledge*, signature lines).

`checkClose`'s problems, as `close.<code>`: `no_session`, `not_permitted`, `invalid_count`, `left_invalid`, `reason_required`, `note_required`, `note_too_long`, `own_variance`, `not_acknowledger`. An exact count carries no reason and no acknowledgement.

## 11. The day reconciliation and the cash variance (CSH-08, RPT-02)

Back office, *Reports*, with `reports.view`; each with a CSV.

- **Day reconciliation** (one branch and business date, computed on request by `reconcileDay`): **Final** when the day is over (the next day's 04:00), every active device has been heard from since with nothing older unsynced, no sequence gap is open and no session of the day is open; otherwise **Provisional**, saying what holds it. Then each session (float, handed in, collected, out, expected from the server's documents, the desk's figure if it differs, counted, variance with its reason, acknowledgement); with handover confirmation Required, **the cash bills never handed over, by salesman**; the scans whose bill never arrived; the day's open exceptions by kind and severity; cash in transit at the end of the day (0 when every bill reached the drawer). A waiting variance has **Acknowledge** for `cash.variance.approve` (never the session's cashier; audited, `cash.variance.acknowledged`).
- **Cash variance** (a date range): one row per session, and each cashier's total.

## 12. The documents

Each is written with its outbox row in **one local transaction** (rule 6), signed after the commit like a bill (POS spec §12), and pushed at once. Contracts: `CashHandoverV1`, `CashSessionV1` in `@erp/contracts`.

**Handover** (family `H`, `D01-H000001`): `id` (UUIDv7), `seq`, `number`, `kind` (`in` | `payout`), `deviceId`, `branchId`, `sessionId`, `cashierId`, `billNumber`, `saleDocumentId` (null when known only from the code), `amount` (the cash due or the refund, positive: **the posted figure**), `cashReceived`, `changeGiven`, `correctedFrom`, `method` (`queue` | `scan` | `auto`), `createdAt`, `businessDate` (04:00 cutoff, D-056), `clientVersion`.

**Session** (family `Z`, `D01-Z000001`, `CashSessionV2`): `event` (`open` | `close`), `sessionId` (the open document's id), `userId` (who opened or closed); an open carries `openingFloat` and `floatExpected`; a close carries `expectedCash`, `countedCash`, `denominations` (count per note, keyed by minor units), `variance`, `varianceReason`, `varianceNote`, `acknowledgedByUserId` (null = later) and `leftInDrawer`; and the same identity, time and version fields. Push still takes a W1-10 close (`CashSessionV1`, no count).

**Collection** (family `R`, `D01-R000001`, `CustomerCollectionV1`): `partyId`, `customerCode`, `customerName` (for a reprint), `methodId`, `methodCode`, `amount`, `reference`, `note`, `balanceBefore` (printed, never posted), with the session, cashier, identity, time and version fields.

**Cash movement** (family `M`, `D01-M000001`, `CashMovementV1`): `kind`, `amount`, exactly one of `expenseCategoryId`, `partyId` (the supplier) and `bankAccountId` (none for the safe), `targetName` (for a reprint), `note`, `reference`, and the same fields. **`CashMovementV2`** (W1-23) adds the kind `void_cash`, with `billNumber` and `approvedByUserId` on it and only on it; the desk writes every movement as V2 from then on, and push still takes V1.

## 12a. Cash taken for a voided bill (W1-23, D-111)

When a counter voids a bill offline and the desk takes its cash meanwhile, the server flags `cash_received_for_void` (§13). A section **Cash taken for voided bills** above the queue lists each voided bill whose cash this desk, or another (as the queue says), took and that isn't given back yet: the bill, its void and the amount, with **Give back Rs 1,000**. It needs the PIN of someone holding `pos.void` who is **never the session's cashier** (owner answer 1), and gives back **the full amount taken** (owner answer 2), at any desk of the branch, on any later day, in an open session (owner answer 4). It is a cash movement of kind `void_cash`, written with its outbox row in one transaction, printed as a voucher and in the session's expected cash. A reissued bill is collected from the queue as usual.

**A refund waits for its bill (guard 2):** the desk won't pay out a return's refund while its original bill's cash is still pending in its queue: *This refund's bill hasn't been handed over yet: collect the bill's cash first, then pay out the refund.* A refund slip scanned offline carries only the return's own number, so it can't be linked and is paid out; the server flags `refund_before_payment` (§13).

## 13. On the server

Push (sync spec §6.2) takes `H` and `Z` only from a cash desk. A handover is **linked to its bill by number**, now or when the bill arrives, and the bill becomes `received` or `paid_out`. A bill's cash and its handovers are judged one transaction at a time (a per-bill lock), because a scan and its bill often arrive together. Findings, never refusals (D-011):

| Exception | Severity | When |
|---|---|---|
| `handover_amount_mismatch` | medium | the amount (or its direction) differs from the bill's cash due, once both are there (D-059) |
| `duplicate_handover` | medium | the bill already has a handover of that kind: kept with `duplicate_of_id`, **never posted** |
| `handover_not_permitted` | low | the server says the cashier lacks the permission |
| `cash_received_for_void` | high | the bill was voided (W1-12, D-059): before the handover was made, or after it while the counter was offline. The handover still posts, so cash in transit shows it until the cash is given back (§12a), which marks it reviewed by itself (`exception.settled`, owner answer 3); `cashKnown` says whether the counter's void was checked with the desk or answered by a person (W1-23) |
| `refund_before_payment` | high | a return's refund was paid out while its original bill's cash was still pending (W1-23, guard 2): judged once both are in, in any push order; marked reviewed by the server when the original's handover arrives |

Each handover posts `Dr CASH_DRAWER / Cr CASH_IN_TRANSIT` (a payout the reverse) for its own amount (posting rules §4.5), so its order against the bill doesn't matter. Cash received, corrections and change never post.

**Collections and cash movements** (W1-11) come only from a cash desk, are stored in `payments` and `cash_movements`, and posted in the accepting transaction (posting rules §4.5). **A session's open and close** set its `cash_sessions` row and post too: the open a float other than what stayed, the close its variance and what went to the safe. Findings, never refusals:

| Exception | Severity | When |
|---|---|---|
| `cash_not_permitted` | low | the server says the cashier lacks the permission (collection, cash-out, open or close), or the acknowledger lacks `cash.variance.approve`, or is the session's own cashier (`ownVariance`): that acknowledgement isn't stored, so the variance waits |
| `float_mismatch` | medium | an open's float differs from what stayed at the desk's last close |

A collection for a customer, or a cash-out naming a category, supplier or bank the server doesn't have, is stored and fails to post (`posting_failed`, D-095) until it can.

**Cash given back for a voided bill** (W1-23) posts `Dr CASH_IN_TRANSIT / Cr CASH_DRAWER` and sets the bill's `cash_given_back_number`, so the bill leaves every desk's section. Findings, never refusals:

| Exception | Severity | When |
|---|---|---|
| `void_cash_duplicate` | high | the bill's cash was already given back: kept with `duplicate_of_id`, **never posted** |
| `void_cash_without_handover` | high | no handover in for the bill |
| `void_cash_not_voided` | medium | the bill isn't voided |
| `void_cash_amount_mismatch` | medium | another amount than the handover took |
| `cash_not_permitted` | low | the cashier lacks `cash.refund.pay`, or the approver lacks `pos.void` or is the session's cashier (`ownVariance`) |

## 14. Not built yet

`cash_handover_mode = off` and its provisional drawer variance (CSH-09, Wave 2: the desk shows the queue regardless); customer ageing at the desk (W1-20); undoing a handover, collection or cash-out recorded by mistake (it shows in the drawer variance, or the accountant reverses it, W1-19); a printed handover slip; amounts in words on the slips.
