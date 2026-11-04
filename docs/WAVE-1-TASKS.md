# Wave 1 tasks

| | |
|---|---|
| **Status** | Accepted 2026-10-26 (D-090): option 1, a smaller pilot from 1 Dec |
| **Wave 1 window** | Mon 26 Oct – Sun 22 Nov (PRD §8); shadow pilot from Tue 1 Dec |
| **Rule** | One GitHub issue per task. Each task's `plan.md` is written and accepted only when the task starts (D-069). |

Sizes are rough working days for one developer. **P** = in the pilot from 1 Dec; **P+** = joins the pilot while it runs; **G** = needed by go/no-go on 18 Dec.

## Tasks, in build order

| Task | What | Requirements | Depends on | Size | Need |
|---|---|---|---|---|---|
| [W1-01](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/47) | Bill print test on the shop's HP P1005: speed, layout, bill code scans (the shop hour, after W1-06, D-093) | POS-09 (measure), POS-16 | W1-06; owner: printer connection, paper | 1 | P (by mid-Nov) |
| [W1-02](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/45) | POS shell: local database, setup, unlock, status bar *(built, PR #46)* | POS-01, POS-14, PLT-03, PLT-04 (counter), SYN-01 (users) | — | done | P |
| [W1-03](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/48) | Catalog on the counter: pull items, identifiers, vehicle tags, prices; omni-search. **Plus the design pass:** tokens from the Tijara POS prototype and the shared building blocks in `packages/ui` (layout, button, field, table, dialog, messages, shortcut hints); the counter screens restyled *(built, PR #68)* | POS-02, SYN-01 (catalog), CAT-02 (search), PLT-13 (tokens) | W1-02 | 4 | P |
| [W1-04](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/49) | Staff and user admin: add/edit/deactivate people, roles and branch, optional back-office password, manager unlock of a locked PIN. The back office gets the shared layout and menu; Staff PINs and Counters restyled *(built)* | PLT-04, PLT-05 (assign) | W1-02, W1-03 | 3 | P |
| [W1-05](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/50) | Bill building: lines, quantity, tier price, discounts, role limits, floor, manager override PIN; keyboard map *(built, PR #74)* | POS-03, POS-04, PLT-07 | W1-03 | 3 | P |
| [W1-06](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/51) | Finalize and print: payment pad, tender and split, cash rounding, numbering, local-first write to the outbox, print profiles, bill code, reprint *(built, PR #80)* | POS-06, POS-09, POS-10, POS-13, POS-15, POS-16, POS-17 | W1-05 (W1-01 follows it, D-093) | 4 | P |
| [W1-07](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/52) | Push sync: outbox push, server acceptance and exceptions, sequence gaps, re-push after restore, SSE nudge, offline warnings, device health page *(built, PR #81)* | SYN-02, SYN-03, SYN-04 (nudge), SYN-05, SYN-06, PLT-09 | W1-06 | 4 | P |
| [W1-08](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/53) | Posting engine: stock ledger, average cost, customer/supplier ledgers, GL for sales; payment-method accounts; tax lines at 0% | INV-01, INV-02, INV-03, ACC-01 (roles), ACC-02, ACC-03, ACC-08, ACC-09 | W1-07 | 4 | P |
| [W1-09](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/54) | Customers on the counter and credit control: customer pull with balance snapshot, search, walk-in phone, limit and offline daily cap *(built, PR #86)* | POS-05, POS-07, SYN-01 (customers) | W1-07, W1-08 | 2 | P |
| [W1-10](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/55) | Cash desk 1: cash session, live queue, scan handover (online and offline), refund payout | CSH-01, CSH-02, CSH-03, CSH-04 | W1-07 | 4 | P |
| [W1-11](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/56) | Cash desk 2: collections with receipt, cash-out, drawer close, day reconciliation | CSH-05, CSH-06, CSH-07, CSH-08, RPT-02 | W1-10, W1-08 | 3 | P+ |
| [W1-12](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/57) | Hold, void and reissue *(built)* | POS-08, POS-11 | W1-07 | 2 | P |
| [W1-13](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/58) | Return and exchange (no legacy bills: MIG-03 dropped, D-100) | POS-12 | W1-08, W1-12 | 4½ | G |
| [W1-14](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/59) | Opening balances, reconciliation report, first migration rehearsal. **Also:** each item's floor from cost (cost + the category margin) pulled as `item_floors`; the pilot wipe and the go-live mark (D-101) *(built)* | MIG-02, MIG-04 | W1-08 | 3½ | P |
| [W1-15](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/60) | Catalog maintenance in the back office: items, identifiers, vehicle tags, tiers, floors, price history | CAT-01, CAT-03, CAT-04, CAT-05, CAT-07 | W1-03 | 3 | G |
| [W1-16](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/61) | Purchasing: suppliers, goods receipt with supplier bill, purchase return, supplier ledger and payments | PUR-01, PUR-02, PUR-03, PUR-09 | W1-08 | 4 | G |
| [W1-17](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/62) | Labels in the legacy format, from an item list or a goods receipt | CAT-08 | W1-15, W1-16 | 1 | G |
| [W1-18](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/63) | Stock operations: transfers, adjustments, item stock card | INV-04, INV-05, INV-07 | W1-08 | 2 | G |
| [W1-19](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/64) | Back-office accounting: bank receipts and payments, expenses, transfers, journal vouchers, periods and lock date | ACC-04, ACC-05, ACC-06 | W1-08 | 3 | G |
| [W1-20](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/65) | Reports and support: sales register, overrides, voids/returns, stock and valuation, outstanding and ageing, exceptions, "Trace a bill" | RPT-01, RPT-03, RPT-04, RPT-05, RPT-06, RPT-10, PLT-12 | W1-11, W1-13 | 3 | G |

**Total ≈ 56 days** (W1-02 done). P tasks ≈ 34 days.

## Look and feel

No separate design task: the design pass is part of W1-03 (counter) and W1-04 (back office). The look comes from the owner's Tijara POS prototype, read only. The components are shadcn/ui on Radix + Tailwind CSS, themed with the prototype's colour tokens (D-066). Every later screen uses the same building blocks, and dark mode (PLT-13, Wave 2) is a second set of token values.

## Already covered in Wave 0

PLT-01, PLT-02, PLT-05 (templates), PLT-08, PLT-10, PLT-11 (Wave 2, done early), ACC-01 (chart), MIG-01.

## Wave 1 requirements not covered by any task

None: every Wave 1 requirement in PRD §6 is in a task above or in Wave 0.

## Schedule (decided: option 1)

The Wave 1 window has about 4 weeks, and the work above is about 8 weeks for one developer. Even the pilot tasks alone (≈ 37 days) don't fit before 1 Dec. PRD §8 already accepts this risk (D-033): build in order of go-live criticality. The options were:

1. **Keep 1 Dec for a smaller pilot:** counter sale, push, posting, cash desk 1 (W1-03 to W1-10, W1-12, W1-14, ≈ 33 days, still tight). The rest follows during the pilot; go/no-go on 18 Dec decides.
2. **Move the pilot start** (e.g. to 8 Dec) and shorten it, keeping the full P list.
3. **Move items to after go-live** that the shop can live without for a few weeks, e.g. back-office catalog editing (W1-15; the importer and corrections cover it), labels (W1-17, keep the legacy labels for a while), back-office accounting (W1-19).

**Decision (owner, 2026-10-26, D-090): option 1.** The pilot on Tue 1 Dec starts with the **P** tasks: the counter sale end to end (W1-01, W1-03 to W1-09), cash desk handover (W1-10), hold and void (W1-12) and opening balances (W1-14). Until W1-11 joins, the drawer is closed and reconciled the legacy way. **G** tasks follow in this order; anything not ready on 18 Dec is decided at go/no-go.
