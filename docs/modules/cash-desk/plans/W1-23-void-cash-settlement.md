# W1-23 Voids and returns by payment: check the payment first, guard refunds of unpaid bills, give back cash taken for a voided bill

| | |
|---|---|
| **Issue** | [#140](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/140) |
| **Module** | cash desk (the desk's screen, its payouts and cash movements) and the counter's void and return, with POS sync, posting and reports |
| **Status** | Accepted (2026-11-11) with the owner's answers 1–4 (below), the payment questions and both return guards |
| **Refs** | CSH-02, CSH-03, CSH-04 (refund payout), CSH-07 (expected cash), CSH-08 (day reconciliation), RPT-10, POS-11 (void and reissue), POS-12 (returns); POS spec §18 (the cash desk check), §19 (return and refund by transfer); posting rules §4.4 (void), §4.5 (cash in transit); cash desk spec §13; CLAUDE.md rules 2, 3, 4, 6, 7; D-024 (cash in transit), D-059 (`cash_received_for_void`), D-099 (void), D-108 (vouchers can't touch cash in transit); **D-111** (new) |
| **Found** | The owner's staging checks of W1-12 (2026-11-11): the offline clash raised `cash_received_for_void` correctly, but nothing in the system could settle it; and a bill paid by JazzCash was voided like an unpaid one, with no word about a return; and a bill not yet paid at the desk could be returned, its refund payable before the bill |
| **Depends on** | W1-10 and W1-11 (handovers, cash movements, the close), W1-12 (void and reissue), W1-13 (returns, refund by transfer), W1-20 (exceptions review) |
| **Size** | about 2 days: domain and posting golden files ¼; contracts, server and push ¼; the desk screen ¼; the counter's payment questions ½; the two return guards ½; reports, e2e and docs ¼ |
| **Test-first** | Yes: the void-or-return decision, the payout guard and the settlement check (golden, `packages/domain`); the settlement's posting (golden, `packages/posting`), including the rebuild; push, the automatic review of the exception and the day reconciliation (integration); the counter's questions and guard, the desk's guard and give-back (component and e2e) |

## The problem

**Cash taken for a voided bill can't be settled.** A counter voids a bill while offline, and the desk, also offline, takes the cash for it. When both sync, the server records `cash_received_for_void` (D-059), which is right. But:

- The sale was reversed by the void, but the handover still moved the cash from *Cash in transit* into the drawer. **Cash in transit stays below zero** by that amount, every day after.
- The drawer holds money the shop doesn't own, and the drawer's expected cash counts it.
- Neither the desk nor the accountant can fix it: no desk action exists, and a journal voucher can't touch *Cash in transit* (D-108).

**A bill paid by JazzCash, card or bank is voided like an unpaid one.** The rule *never after the cash handover* (D-099) only looks at the desk's cash. But a bank, wallet or card payment reaches the shop at the counter, when the bill is finalized. A void then reverses it in the books while the money is still in the shop's account; whatever is sent back to the customer leaves the shop with no record, reference or approval, and the account's statement no longer matches the books line by line.

**A bill not yet paid can be returned, and its refund paid first.** Nothing in a return looks at whether the original's cash reached the desk. The desk's queue then shows *Collect Rs 1,000* for the bill and *Pay out Rs 450* for the return, and nothing stops the refund being paid while the bill never is: the shop pays out money it never received.

## Goal

**Voids are for bills whose money hasn't reached the shop; anything else is a return.** Before a void, the counter checks each part of the bill's payment: the desk's cash with the server when it can (and asks the person when it can't), and a bank, wallet or card payment always by asking, because the system can't see the shop's accounts. If the money has arrived, the counter opens a return, whose refund is recorded the usual way: cash at the desk (offline too, by scanning its refund code) or by transfer with its reference and an approver.

**A return waits for its bill's payment.** On the bill's own day, a return of a cash bill not yet paid at the desk is sent to the void instead (an unpaid mistake is voided and reissued). And the desk never pays out a return's refund while its original bill is still waiting in its queue; offline, where the desk can't tell, the server flags it after sync.

**And when cash is still taken for a voided bill** (a wrong answer, an old printout paid at an offline desk, a few seconds' race), the cashier gives it back at the desk, and the books, the drawer and the exception agree again.

If the bill was reissued, the reissue is a bill like any other: it waits in the desk's queue and is collected the usual way. The cashier gives back the voided bill's cash and takes the reissue's; the drawer's expected cash moves by the difference, which is what the customer actually paid or got back.

## The owner's answers (2026-11-11, as recommended)

1. **Who may give it back?**
   The session's cashier, with `cash.refund.pay` (as for a refund payout), **and the PIN of someone holding `pos.void`** for this branch, who is **never the session's cashier**, with the PIN checked offline as on the counter. Without it, a cashier working with a salesman could void a paid bill offline, *give back* the cash to themselves, and the drawer would balance and the exception close by itself, hiding the leak of goods. It is rare enough that the extra step costs little.
2. **How much?**
   Always **the full amount the desk took** for that bill, never a part. A different real figure is a drawer variance at the close, with its reason.
3. **The exception:**
   Once the cash is given back, the server **marks the exception reviewed by itself**, with the note *"Given back on D01-M000012, approved by (the approver's name)"*, audited as `exception.settled`. An exception settled by mistake can still be reopened by hand (W1-20).
4. **When and where?**
   At **any desk of the branch, on any later day**, while the cashier's session is open. The settlement is dated the day it happens; the original day's reconciliation shows the bill as *given back on 12 Nov*.

## Design

### Before a void: void or return (owner, 2026-11-11)

| Decision | Why |
|---|---|
| **Each payment part of the bill is checked.** Desk cash: the server's answer (`GET /api/sync/bills/status`, 3 s) as today; offline or with no answer, the person is asked **"Has the customer already paid for this bill at the cash desk?"** (*Yes, they've paid* / *No, not yet*). A bank, wallet or card part: **always asked, online too:** **"Has the shop's JazzCash account received Rs 400 for this bill?"** (the method's name and the part's amount; *Yes, received* / *No, not received*). On account: no money moves, nothing is asked. A bill with no cash and no bank, wallet or card part asks nothing | The server knows the desk's cash; nobody but a person checking the account's app or SMS knows a bank, wallet or card payment. The questions replace today's offline warning (`void.approveUnknown`), on the void's approval screen, so the approver who enters their PIN sees them too |
| **The decision** (pure, `voidOrReturn`, golden), from the answers: **nothing has arrived → void**; **everything has arrived, or only the desk's cash is still to come → return**; **a bank, wallet or card part hasn't arrived while another part has → stop:** *Rs 400 by JazzCash hasn't reached the shop. Ask the customer to complete it, then return the bill.* | Rule 2: one rule, golden-tested, used by the counter and by the server to judge the void. A bill whose money has arrived needs its refund recorded, which only a return does (D-099's reasoning, now for every method). With only desk cash to come, the return's refund and the bill's cash due meet in the desk's queue as two rows; the cashier hands over the difference. Refunding money that never arrived would pay the customer for nothing |
| ***Return* opens *Return / exchange*** (`F3`, §19) on that bill, with no void written. Its refund follows W1-13: cash at the desk, credit to the customer's account, or by transfer with its reference and the PIN of someone with `pos.override.approve`; one refund method per return | Everything the return needs is built; the counter only takes the person there |
| **The void records the checks:** `paymentChecks` (`SaleVoidV2`), one per part: the method, the amount, how it was known (`server` or `asked`) and the answer. V1 voids still accepted. The server shows them in the details of `cash_received_for_void`, e.g. *voided offline; answered not paid yet, approved by …*, and on Trace a bill | A wrong answer is on record with who gave and approved it, so a repeated one shows up |

### Returns of unpaid bills: the two guards (owner, 2026-11-11)

| Decision | Why |
|---|---|
| **Guard 1, on the counter:** opening a cash bill for a return (`F3`) checks its desk cash the same way as a void: the server's answer, or offline the paid question. **On the bill's own business day, with nothing of it arrived** (`voidOrReturn` says *void*), the counter says *This bill hasn't been paid yet. Void it and reissue instead* and opens the void on it. On a later day (a void isn't allowed any more), or with part of it arrived (a split bill whose JazzCash was received), the return goes on | An unpaid mistake is a void and reissue (D-099, this plan); the return is for money that has arrived. One rule, `voidOrReturn`, decides both screens |
| **Guard 2, at the desk:** the desk refuses to pay out a return's refund, from the queue or by a scan, while **its original bill is still pending in the desk's queue**: *Collect C03-S000051 (Rs 1,000) first*. Once the bill is handed over, the payout goes on. The check is part of `checkHandover`; `cash_queue` rows gain `return_of_number` (the original's number, null for a plain bill) | The refund can't leave the drawer before the bill's cash came in. It also covers the split case above: the cashier collects the bill's cash first, then pays out the refund |
| **Offline, guard 2 doesn't block:** a refund slip's code carries only the return's own number and amount (Code 39, D-055), so an offline desk can't link it to its bill and pays out. The server flags **`refund_before_payment`** (high) when it has the payout and the original has no `in` handover, judged once both are in, in any push order (`reviewHandover`), and marks it reviewed by itself (`exception.settled`) if the original's handover arrives later | An honest offline flow (the bill paid, then returned) is never stopped; the bad one is seen the same day, with the bill also under *Cash bills never handed over* |

### After a void: give back cash taken for it

| Decision | Why |
|---|---|
| **A new cash movement kind, `void_cash`** (family `M`, `CashMovementV2`): `billNumber`, `voidNumber`, `amount` (the full amount taken) and `approvedByUserId` (question 1). Written in one local transaction with its outbox row (rule 6), signed, pushed at once, and printed as a slip. V1 movements stay accepted | Rule 3: the settlement is a document of its own, never an edit to the handover or the void. A cash movement already takes money out of a session's drawer and is in its expected cash (W1-11). A kind of its own keeps it apart from return refunds in every report |
| **Posting:** `Dr CASH_IN_TRANSIT / Cr CASH_DRAWER` for the amount, dated the movement's business date | It undoes what the handover did for the voided bill, so *Cash in transit* comes back to zero. The same entry as a refund payout; posting rules §4.5 gain a line |
| **The checks** (pure, `checkVoidCash`, golden): the bill is voided; the desk took cash for it (an `in` handover, not a duplicate, known locally or from the pulled queue); not already given back; the session is open and the cashier's; `cash.refund.pay`; an approver with `pos.void` for the branch who isn't the session's cashier (the PIN itself is checked on the desk, wrong PINs counting towards the approver's own lock) | Rule 2: the same rules on the desk and on the server |
| **The server accepts every settlement** (rule 7) and records an exception when it finds a problem: `void_cash_not_voided`, `void_cash_without_handover`, `void_cash_duplicate` | Like every desk document; a settlement is never refused on business rules |
| **The desk's screen:** a section **"Cash taken for voided bills"** above the queue: the bill, the void, the amount and the button **Give back Rs 1,000**, which asks for the approver and their PIN. It appears once the desk knows of the void (its own pull, or the void it made) | The cashier sees it at the desk where the drawer is |
| **Reports:** the day reconciliation lists *Cash taken for voided bills* with *given back on …* or *open*; the exception is reviewed by the server (question 3); Trace a bill shows *Cash given back* | Everything the owner checks in the evening says the same thing |

## Scope

- **In:**
  - Contracts: `SaleVoidV2` with `paymentChecks`, and `CashMovementV2` with the `void_cash` kind; V1 of both still accepted; `return_of_number` in the `cash_queue` dataset.
  - Domain: `voidOrReturn` (for a void and for a return); the payout guard in `checkHandover` and `reviewHandover`; `checkVoidCash` and the movement's effect on a session's expected cash; golden.
  - Counter: the payment questions on the void's approval screen; *Return* opens the return on that bill; *stop* says which payment hasn't arrived; the checks on the void. Guard 1 on `F3`.
  - Posting: the `void_cash` movement, golden, and in the rebuild.
  - Server (migration 0022 for the new columns): the void's `paymentChecks` stored and judged with `voidOrReturn`; accepting the settlement in push, the three findings, the checks in the details of `cash_received_for_void`, its automatic review, the pull of the desk's open settlements; `refund_before_payment` and its automatic review.
  - Desk: local schema step, the section and its action, the printed slip; guard 2 on the queue and the scan.
  - Back office: the day reconciliation line; Trace a bill's new steps (the void's checks, *Cash given back*).
- **Out:**
  - **Using the voided bill's cash for its reissue** (one step that collects or gives back only the difference). The cashier gives the cash back and collects the reissue from the queue; netting can come later if cashiers find two steps clumsy;
  - **A bank, wallet or card payment that never arrives at all** while another part did (the *stop* case): the customer completes it; if they can't, it is the manager's matter, outside the counter;
  - **Refunding a split bill by two methods in one return** (one refund method per return, W1-13); the manager picks one, or makes two returns;
  - **Checking a bank, wallet or card account automatically:** the system has no connection to them;
  - **Blocking an early refund offline:** the refund slip's code would need its original's number, a longer barcode on the dot-matrix printer before the print test (W1-01);
  - Settling cash taken for a bill that was never voided (the normal handover covers it);
  - Partial settlements (question 2);
  - Fixing past days' *Cash in transit* by hand: a settlement on a later day fixes it from that day on.

## Tests written first

- **Domain (golden, `void-or-return.json`):** cash only, not paid → void; paid → return; JazzCash only, not received → void; received → return; on account only → void, nothing asked; split cash + JazzCash in all four combinations (void; return; return with the cash still to come; stop); two bank or wallet parts, one received and one not → stop; the server's answer and the person's answer judged the same; for a return (guard 1): an unpaid cash bill on its day → void; on a later day → return; a split bill with JazzCash received → return.
- **Domain (golden, the handover files):** a refund payout refused while its original is pending; allowed once handed over, or for a return of a bill without cash; the server's review raising `refund_before_payment` for a payout before its bill's handover, in either push order, and settling it when the handover arrives.
- **Domain (golden, `void-cash-check.json`):** give back allowed; refused when the bill isn't voided, when no cash was taken, when already given back, without `cash.refund.pay`, with no open session, with no approver, an approver without `pos.void`, or the session's cashier approving; the session's expected cash after it.
- **Posting (golden, `post-void-cash.json`):** the movement's entry; the void, the handover and the settlement together leave *Cash in transit* at 0; the rebuild matches.
- **Integration:** an offline clash pushed in both orders, then a give-back: `cash_received_for_void` reviewed by the server, *Cash in transit* 0, the day reconciliation showing it given back. A reissue of the voided bill, collected in the queue: the close balances. A second settlement of the same bill: `void_cash_duplicate`. A void answered *not paid yet* that clashes: the exception's details say so. A void whose checks call for a return: flagged `void_not_permitted`. An offline payout of a return before its bill: `refund_before_payment`, reviewed by the server when the bill's handover arrives; with the bill handed over first, nothing. `cash_queue` carries `return_of_number`. V1 movements and voids still accepted.
- **Counter (component):** a JazzCash bill, online: the question appears; *Yes, received* opens the return and writes no void; *No, not received* writes the void with its check. A cash bill offline: the paid question; online with the server's answer: no question. A split bill with JazzCash received and the cash not paid: the return. Cash paid and JazzCash not received: the stop message, nothing written. `F3` on an unpaid cash bill of today: the message and the void; of yesterday: the return.
- **Desk (component):** a return's refund with its bill pending: *Collect … first*, nothing written; after the bill's handover, the payout. A scanned refund the desk can't link: paid out.
- **Desk (component):** the section appears for a voided bill with cash; Give back asks for the approver's PIN, refuses a wrong one and the cashier themselves, then records the movement and prints the slip; the bill leaves the section.
- **e2e:** a JazzCash bill answered *Yes, received* becomes a return refunded by transfer; a return of an unpaid bill of today is sent to the void; a return's refund waits at the desk until its bill is collected; an offline void answered *Yes, they've paid* becomes a return; the offline clash (answered *No, not yet*), then the cash given back at the desk; the exception leaves the open list and the day reconciliation shows *Cash in transit* 0.

## Verify

- `pnpm check`, `pnpm test:integration`, `pnpm e2e`.
- On staging:
  - a JazzCash bill: *Void* asks whether the shop's JazzCash received it; *Yes* opens the return; *No* voids;
  - a split cash + JazzCash bill with the JazzCash received and the cash not yet paid: the return, and the desk's queue shows the bill and the refund;
  - `F3` on a cash bill not yet paid, the same day: the counter sends it to the void;
  - a split bill returned with its cash still pending: the desk asks to collect the bill first, then pays out the refund;
  - both offline: a bill paid by scan, then returned and its refund paid by scan: nothing flagged after sync; the same without the bill paid: `refund_before_payment`;
  - an offline void of a paid cash bill, answered **Yes, they've paid**: the counter opens the return, and the desk pays out its refund by scanning it;
  - an offline clash, settled by **Give back**: the exception reviewed, *Cash in transit* back to 0, the drawer's expected cash down by the amount;
  - another offline clash with a reissue at a different price: the cash given back, the reissue collected from the queue, the close balances.

## Order

1. Contracts and domain golden files (`voidOrReturn`, the payout guard, `checkVoidCash`).
2. Posting golden files and the rebuild.
3. Server, push and integration tests.
4. The counter's payment questions and guard 1.
5. The desk: local schema, guard 2, the section and its action.
6. Reports and Trace a bill.
7. e2e.
8. Docs and D-111.

## Risks

| Risk | Mitigation |
|---|---|
| A question is answered *No* when the money has arrived | Two people see it (the person voiding and the approver). For desk cash, the clash that follows is found by the server and settled here; for a bank, wallet or card payment, the account's statement shows the money with no bill. Either way the void records what was answered and who approved, so a repeated wrong answer shows up |
| A refund is paid offline before its bill | Not blocked (the desk can't tell); the server flags `refund_before_payment` the same day, and the bill shows under *Cash bills never handed over* with its salesman |
| Staff find the JazzCash question a nuisance | It appears only on a void of a bill with such a payment, which is rare; the answer is one check of the shop's app or SMS |
| Cash given back twice for one bill | One settlement per bill: the desk checks its own and the pulled ones; the server flags a second (`void_cash_duplicate`) and posts only the first |
| The drawer still doesn't balance | The settlement is in the session's expected cash; anything else is a counted variance with its reason, as today |
| A cashier gives back cash the desk never took | Allowed only when the desk took cash for that bill; otherwise the server flags `void_cash_without_handover` |
| A cashier and a salesman together void a paid bill and give the cash back to themselves | The give-back needs the PIN of a `pos.void` holder who isn't the cashier (question 1); the void and the give-back are both audited with who approved them, and the server's note names the approver |
| Two steps for a reissue feel clumsy | Both are the desk's usual actions; netting stays a possible later change (Out of scope) |
