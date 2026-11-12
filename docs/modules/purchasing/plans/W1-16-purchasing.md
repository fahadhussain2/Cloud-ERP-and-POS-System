# W1-16 Purchasing: suppliers, goods receipt, purchase return, supplier ledger and payments

| | |
|---|---|
| **Issue** | [#61](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/61) |
| **Module** | purchasing (back-office screens and API), with accounting (three new posting sources in `packages/posting`) and platform (permissions) |
| **Status** | Accepted (2026-11-06) with the owner's answers 1–5 (below). Built (2026-11-06) on `w1-16-purchasing` |
| **Refs** | PUR-01, PUR-02, PUR-03, PUR-09; PRD W11.4, W11.7, W12; data model §3, §8; posting rules §1, §5.1, §5.2, §6; CLAUDE.md rules 1, 2 (pure rules), 3, 4, 5, 10; D-015 (Shop, Godown, Damaged), D-017 (average cost), D-020, D-079 (rounding), D-095, D-101 (pilot wipe), D-104 |
| **Depends on** | W1-08 (posting engine), W1-11 (the desk's supplier payment, CSH-06), W1-15 (back-office catalog, item search) |
| **Size** | about 4½ days (the task list says 4): suppliers ½, goods receipt rules and posting 1, receipt screen and API 1¼, purchase return ¾, supplier ledger and bank payment ¾, e2e and docs ¼ |
| **Test-first** | Yes: receipt totals with the bill discount spread into net costs, the bill-total check and line warnings (golden, `packages/domain`); `postGoodsReceipt`, `postPurchaseReturn`, `postSupplierPayment` and the average from a receipt's value (golden, `packages/posting`); the API under RLS with permissions, drafts and posting (integration) |

## Goal

**The shop records what it buys and what it sends back, and always knows what it owes each supplier.** A purchaser types the supplier's bill as it is printed, line by line, and can't save it until the lines add up to the bill's total (PUR-02). Posting it puts the stock in Shop (or Godown) at its real cost, moves each item's average cost, and adds the bill to the supplier's account with its due date. A purchase return takes stock out and reduces what the shop owes (PUR-03). Each supplier has a ledger, and the shop pays suppliers by bank from the back office or in cash at the desk (PUR-09, CSH-06).

## Design

| Choice | Why |
|---|---|
| **Suppliers:** a list and a form on the existing `parties` (code, name, contact person, phones, address, terms in days, **label abbreviation**, status), with a supplier account (`supplier_accounts.payment_terms_days`). A party can also be a customer (PUR-01) | The tables exist (migration 0006) and the importer fills them; the label abbreviation feeds W1-17 |
| **Goods receipt = a draft, then posted.** The draft can be saved half-done while the goods are unpacked; **Post** checks everything and makes it final (rule 3), like the opening (D-101): a trigger refuses any change after posting | Bills are typed in pieces; a posted document is never edited, a mistake is a purchase return |
| **The bill header:** supplier, the supplier's bill number and date, location (Shop by default, or Godown), **how it's paid**: on account, or paid by bank (with the bank account, posting the payment with it); a cash payment is made by the cashier at the desk afterwards (owner answer 1), notes, and the **bill total as printed** | PUR-02's bill-total check needs the printed total |
| **Lines:** item (searched as in the catalog), quantity (thousandths; whole for pieces), unit cost in rupees and paisa (up to 2 decimals, PUR-02), line discount (amount); a bill discount for the whole bill | As on the supplier's paper |
| **Totals are pure rules in `packages/domain`** (`receiptTotals`): line totals, the bill discount spread over lines with `allocate` (largest remainder, D-079), each line's **net value** exact to the paisa, and the net unit cost shown rounded | The bill discount is capitalized into stock (posting rules §5.1); the value, not a rounded unit cost, goes into stock, so Σ lines = the bill exactly |
| **Bill-total check:** Post is refused until the typed bill total equals the computed total; the screen shows the difference as you type | PUR-02 |
| **Line warnings** (shown, not blocking): cost up or down more than 10 % against the item's last cost; Retail at or below the new net cost; a quantity of 0 | PUR-02 (the PO warnings wait for POs, PUR-04, Wave 2) |
| **Posting** (`postGoodsReceipt`, posting rules §5.1): stock movement per line into the location at its net value; `Dr INVENTORY` Σ net values; `Cr AP_CONTROL (supplier)` the bill total with due date = bill date + the supplier's terms; each item's average re-computed from the value (a value-based variant of `averageAfterReceipt`, exact); the last cost, supplier and date on `item_costs`; `item_floors` follow (W1-14) | One engine for every ledger (rule 4); rebuildable like any posting |
| **Purchase return** (`postPurchaseReturn`, §5.2): supplier, optionally the goods receipt it returns from (then its lines and costs are offered, and no more than was received less earlier returns), location, lines (item, qty, unit cost, defaulting to the receipt line's net unit cost, else the item's average), a reason from a list (owner answer 3: damaged, wrong item, excess quantity, poor quality, price dispute, other with a note). Posts `Dr AP_CONTROL (supplier)` the return value, `Cr INVENTORY` qty × current average, the difference to `PURCHASE_PRICE_VARIANCE`. Draft, then posted, like the receipt | Posting rules §5.2 as written |
| **Supplier payment by bank** (`postSupplierPayment`, posting rules §6): supplier, bank account, amount, date, reference; `Dr AP_CONTROL (supplier) / Cr <bank>`. Posted at once (no draft) | PUR-09; the cash payment at the desk is already built (W1-11) |
| **Supplier ledger:** per supplier, every entry (receipts, returns, payments by bank and at the desk, the opening) with the running balance, and the balance owed; a list of suppliers with their balances | PUR-09. **Ageing** (buckets by due date) is RPT-06 in W1-20, built on the same entries |
| **Numbers:** `GR000001`, `PR000001`, `SP000001` per shop, taken when a document is posted (a draft has none), from a per-tenant counter in the same transaction | Readable numbers for the supplier's statement; no gaps from abandoned drafts |
| **Permissions** (owner answer 2): suppliers, receipts and returns with `pur.receive` (owner, manager, purchaser templates); bank payments with `acc.payment.create` (owner, accountant); costs need `cost.view` | Existing permissions, nothing new to grant |
| **The pilot wipe** removes receipts, returns and bank payments with the other documents (D-101); suppliers stay | They change stock and the supplier ledgers, which the wipe resets |
| **Until go-live, purchases are entered in legacy** (owner answer 4): the purchasing screens show a notice while the shop isn't live, as the catalog does (D-104); practice bills on production in the last weeks of December are optional and removed by the wipe | No double typing for a month |
| **Not in this task:** purchase orders, sharing and the pickup run sheet (PUR-04…06), reorder and repricing suggestions (PUR-07, PUR-08), labels (W1-17), ageing (W1-20), tax (0 % for now) | Wave 2 or their own tasks |

## Scope

1. **Migration 0017:** `goods_receipts`, `goods_receipt_lines`, `purchase_returns`, `purchase_return_lines`, `supplier_payments`, a per-tenant `document_counters`; RLS and audit on all; the posted-document guard trigger; new `postings.source_type` values; mirrors in `schema.ts`.
2. **`packages/domain`:** `receiptTotals`, `receiptProblems` (header, lines, bill-total check), `receiptWarnings`, `returnProblems` (quantities against what was received and returned), with golden files.
3. **`packages/posting`:** `postGoodsReceipt`, `postPurchaseReturn`, `postSupplierPayment`, the value-based average; loaders, `postDocument` sources, the rebuild replay, the pilot wipe lists; golden files.
4. **API (`apps/api/src/purchasing/`):** suppliers (list, read, create, edit); goods receipts (list, read, create draft, edit draft, delete draft, post); purchase returns (the same); supplier payments (create = post); the supplier ledger; all inside `withTenant`, audited.
5. **Back office:** a **Purchasing** menu group: Suppliers (list, form, ledger with Pay by bank), Goods receipts (list, the receipt screen with the live bill-total check and warnings), Purchase returns. i18n keys, logical CSS, the shop's money format.
6. **Docs:** data model §8 as built; posting rules §5.1, §5.2, §6 as built; accounting spec (the new sources); purchasing README status; `WAVE-1-TASKS.md`; a decision for the owner's answers.

## Tests written first

- **Golden (`packages/domain`):** totals with line and bill discounts, the discount spread exactly (odd paisa, a line of 0), fractional quantities for litres, the bill-total check, the warnings at exactly 10 %, a return above what was received.
- **Golden (`packages/posting`):** a credit receipt (stock, average, AP with due date); a receipt into Godown; a receipt when on hand was negative (the average = its cost); a return at the purchase cost with a variance both ways; a bank payment; the entries always balance (property test).
- **Integration (`apps/api`):** a draft saved and edited, refused at Post until the bill total matches, then posted once with its number; a posted receipt can't be changed or deleted; the item's average, last cost and floor after posting; a return limited by what was received; a bank payment on the supplier's ledger; permissions (a salesman refused, a manager can't pay by bank); RLS.
- **Unit (back office):** the receipt screen's bill-total difference and warnings; the supplier ledger's running balance.
- **e2e:** a purchaser records a supplier's bill with a bill discount and posts it; the counter's floor for that item follows the new cost; a return and a bank payment show on the supplier's ledger.

## Verify

`pnpm check`, `pnpm test:integration`, `pnpm e2e`; the rebuild check (`posting-check`) on a database with receipts and returns finds no difference. On staging: a receipt, a return and a bank payment on a generated supplier, and the supplier's ledger.

## Order

Migration and schema → domain golden files → posting golden files → posting engine → API with integration tests → back-office screens → e2e → docs.

## Risks

| Risk | Mitigation |
|---|---|
| A rounded net unit cost × quantity doesn't add back to the bill | The stock movement carries the line's exact net value; the unit cost is only shown |
| A receipt posted twice, or edited after posting | `postDocument`'s lock and the posted-document trigger (as in D-101) |
| A return against an old receipt when the average has moved a lot | The difference goes to Purchase price variance, as the posting rules say; the return screen shows it before posting |
| A cash purchase paid from the drawer without the desk knowing breaks the drawer count | Cash is paid only at the desk, as a supplier payment (owner answer 1) |

## Changes during the build

| Change | Why |
|---|---|
| `checkReceipt` gives problems and warnings together (instead of `receiptProblems` and `receiptWarnings`) | The warnings need the totals the check computes |
| The return reasons are `PURCHASE_RETURN_REASONS` | `RETURN_REASONS` is the counter's (W1-13) |
| The document date columns are `business_date` (received, returned, paid on) | The posting engine reads every source's `business_date` |
| `GET /api/purchasing/items` searches items under `pur.receive` | The catalog's search needs a catalog permission a purchaser doesn't have |
| A supplier payment can't be deleted by the app role; a mistake is a journal voucher (W1-19) | Like a posted document |
| The item picker's result list has its own label ("Items found") | Two elements with one label (found by the e2e) |
| The return test returns 11 pieces, not 10.001 | 10.001 pieces is also a fraction of a piece |

## Owner review on staging (2026-11-07)

| Change | Why |
|---|---|
| A receipt line's cells align at the top; a line not filled in yet is not flagged and doesn't stop the totals (it isn't checked or saved until something is typed in it) | The fields slid down under the messages, and an empty new line blanked every line's net cost and value |
| Picking an item fills in its last purchase cost when the cost is empty; still editable | Most items come at the last price; the bill-total check catches a cost that changed |
| Add supplier, Edit details and Pay by bank open as dialogs (the staff screens' `FormDialog`) | As Staff → Add person; the list stays where it was |
| The suppliers table has an actions column: Edit, Deactivate or Reactivate, and Delete for a supplier never used | A supplier added by mistake can go; one that was used is deactivated, never deleted, so its documents keep pointing at it |
| Deactivate is refused while the shop owes the supplier anything (`balance_open`, with the amount) | An open balance must not drop out of sight |
| Delete only when the party appears nowhere (documents, ledgers, the opening, items' default supplier or last purchase, a customer account); it is marked deleted, not removed (rule 8) | Nothing may point at a deleted supplier |

## Checks (2026-11-06)

- `pnpm check` (format, lint, typecheck, tests with coverage, build): pass, 1,902 tests; `packages/domain` at 100 % branch coverage.
- `pnpm test:integration`: 330 passed (31 files), including the purchasing API (13) with the rebuild check finding no difference.
- `pnpm e2e` (Edge): 49 passed, including "the owner records a supplier bill with a bill discount, returns part of it and pays by bank".

## Owner answers (2026-11-06)

1. **Cash purchases are paid by the cashier at the desk** (Alt+M, supplier payment, W1-11), after the receipt puts the bill on the supplier's account, so the drawer count stays right. A receipt can be marked paid by bank.
2. **Suppliers, receipts and returns:** owner, manager and purchaser (`pur.receive`). **Bank payments:** owner and accountant (`acc.payment.create`). Cash at the desk: the cashier.
3. **Return reasons:** damaged, wrong item, excess quantity, poor quality, price dispute, other with a note.
4. **Until go-live, purchases go into legacy**; the screens say so. Practice bills on production late in December are optional (the wipe removes them).
5. **About 4½ days.**
