# Accounting Posting Rules

| | |
|---|---|
| **Status** | Draft for owner and accountant review |
| **Related** | [PRD §6.7](01-PRD.md) · [Data model §9](03-DATA-MODEL.md) · [Migration](05-LEGACY-MIGRATION.md) |

---

## 1. Principles

1. **Staff never enter debits and credits** for operational work. Every operational document posts automatically. Only the accountant writes journal vouchers.
2. **Perpetual inventory:** every sale posts COGS at the moment of posting, and Inventory is a real balance-sheet account. The legacy system had no Inventory or COGS accounts.
3. **Derived and rebuildable:** journal entries reference their source document. A rebuild regenerates them identically.
4. **Balanced always:** total debits equal total credits per entry, enforced by the database.
5. **Immutable:** corrections are reversal entries (void, return, or a reversing journal), never edits.
6. **Period lock:** nothing posts on or before `tenants.lock_date`. A late-synced offline document dated inside a locked period posts on the first open date, with its original business date kept on the document, and raises an exception.
7. **Money** is integer minor units. Allocations (e.g. a bill discount spread across lines) use largest-remainder rounding, so line amounts always sum exactly to the total.

## 2. Default chart of accounts (retail template)

New tenants get this tree. Delux's legacy accounts are mapped into it ([migration §5](05-LEGACY-MIGRATION.md)). The legacy code stays searchable through `legacy_code`.

| Code | Account | Type | System role |
|---|---|---|---|
| **1000** | **Assets** | asset | |
| 1110 | Cash drawer (cash desk) | asset | `CASH_DRAWER` |
| 1120 | Cash in transit, counters (awaiting handover / payout) | asset | `CASH_IN_TRANSIT` |
| 1130 | Cash in safe | asset | |
| 1140 | Cheques in hand | asset | |
| 1150 | Bank: Soneri | asset | (bank_accounts) |
| 1160 | Bank: HBL | asset | (bank_accounts) |
| 1170 | Wallet: JazzCash | asset | (bank_accounts) |
| 1171 | Wallet: Easypaisa | asset | (bank_accounts) |
| 1180 | Card settlement clearing | asset | (bank_accounts) |
| 1200 | Accounts receivable (customers) | asset | `AR_CONTROL` |
| 1300 | Inventory | asset | `INVENTORY` |
| **2000** | **Liabilities** | liability | |
| 2100 | Accounts payable (suppliers) | liability | `AP_CONTROL` |
| 2300 | Output tax payable (future) | liability | `TAX_PAYABLE` |
| **3000** | **Equity** | equity | |
| 3100 | Owners' / partners' capital | equity | |
| 3110 | Partners' drawings | equity | |
| 3200 | Retained earnings | equity | `RETAINED_EARNINGS` |
| 3300 | Opening balance equity | equity | `OPENING_BALANCE_EQUITY` |
| **4000** | **Income** | income | |
| 4100 | Sales | income | `SALES` |
| 4110 | Sales returns (contra) | income | `SALES_RETURNS` |
| 4120 | Sales discounts (contra) | income | `SALES_DISCOUNT` |
| 4210 | Cash rounding | income | `ROUNDING` |
| **5000** | **Cost of sales** | expense | |
| 5100 | Cost of goods sold | expense | `COGS` |
| 5200 | Inventory adjustments / shrinkage | expense | `INVENTORY_ADJUSTMENT` |
| 5300 | Purchase price variance | expense | `PURCHASE_PRICE_VARIANCE` |
| **6000** | **Operating expenses** | expense | |
| 6100… | Salaries (one account per legacy salary head) | expense | |
| 6200… | Utilities | expense | |
| 6300… | General expenses | expense | |
| 6400… | Miscellaneous expenses | expense | |
| 6500 | Cash short / over | expense | `CASH_SHORT_OVER` |

Note: the legacy "Purchases" account sat under Liabilities. Purchases now go **into Inventory** and reach the P&L only as COGS.

## 3. Notation

`Dr X / Cr Y: amount`. `(party)` means the journal line carries `party_id`, and a matching `party_ledger_entries` row is written. "Cost" is the item's weighted average cost at posting time unless stated otherwise.

## 4. POS documents

### 4.1 Sale (positive lines)
| Line | Entry |
|---|---|
| Revenue | `Cr SALES`: Σ line_total of positive lines (at the negotiated price, after line discounts) |
| Bill discount | `Dr SALES_DISCOUNT`: bill_discount |
| Rounding | `Dr/Cr ROUNDING`: rounding difference |
| Cash tender | `Dr CASH_IN_TRANSIT`: cash portion (net of change) |
| Non-cash tender | `Dr <method's bank/wallet/card account>`: amount, per payment line |
| On account | `Dr AR_CONTROL (party)`: remainder put on the customer's account; party ledger due date = date + terms |
| Cost | `Dr COGS / Cr INVENTORY`: Σ qty × avg cost (stock movement out of SHOP) |
| Tax (future) | `Cr TAX_PAYABLE`: tax_total |

Line price concessions (negotiated below list) are **not** separate GL entries. Sales are recorded at the price actually charged. Concessions are a management report (RPT-03).

### 4.2 Returned lines (negative lines)
| Line | Entry |
|---|---|
| Revenue reversal | `Dr SALES_RETURNS`: refund value = original net unit price × qty. The original bill discount is allocated pro-rata to its lines, so the refund equals what was actually paid. |
| Settlement, cash | `Cr CASH_IN_TRANSIT`: refund due, paid out at the desk (§4.5) |
| Settlement, account customer | `Cr AR_CONTROL (party)` |
| Settlement, non-cash refund by transfer | `Cr <bank/wallet account>` |
| Cost reversal | `Dr INVENTORY / Cr COGS`: qty × **the original line's unit_cost** (for legacy-bill or no-receipt returns: the current avg cost). Stock goes into SHOP (resellable) or DAMAGED (defective). Both are Inventory until written off. |

### 4.3 Exchange (mixed lines)
§4.1 for the positive lines plus §4.2 for the negative lines, in **one** journal entry. Only the **net** settlement moves: `cash_due` > 0 is collected, < 0 is refunded.

### 4.4 Void
A reversing journal entry with every line of the original entry swapped, dated the void date. Stock movements are reversed at the same unit costs, and party ledger entries are reversed. A void is only allowed before the cash handover (D-002 / PRD W5), so `CASH_IN_TRANSIT` is cleared by the reversal itself.

### 4.5 Cash desk events
| Event | Entry |
|---|---|
| Handover in (salesman brings cash) | `Dr CASH_DRAWER / Cr CASH_IN_TRANSIT`: cash_due |
| Refund payout | `Dr CASH_IN_TRANSIT / Cr CASH_DRAWER`: refund amount |
| Sale on the cash desk device itself | Posted as §4.1, plus an automatic handover in the same entry |
| Customer collection, cash | `Dr CASH_DRAWER / Cr AR_CONTROL (party)` |
| Customer collection, non-cash | `Dr <bank/wallet account> / Cr AR_CONTROL (party)` |
| Supplier payment from the drawer | `Dr AP_CONTROL (party) / Cr CASH_DRAWER` |
| Expense from the drawer | `Dr <expense category account> / Cr CASH_DRAWER` |
| Bank deposit | `Dr <bank account> / Cr CASH_DRAWER` |
| Float in / out | `Dr CASH_DRAWER / Cr CASH (safe)`, or reversed |
| Drawer close, shortage | `Dr CASH_SHORT_OVER / Cr CASH_DRAWER`: variance |
| Drawer close, overage | `Dr CASH_DRAWER / Cr CASH_SHORT_OVER`: variance |

With `cash_handover_mode = off`, the automatic handover posts the same entry in the same transaction as the sale, so the posting logic is the same in both modes.

A handover always posts the bill's **cash due** (or refund amount). The salesman's "cash received", any correction by the cashier, and the change given are operational records only, and they don't post. If the drawer ends up short or over because of them, it shows in the drawer-close variance.

**Control property:** at the end of a fully synced business day, `CASH_IN_TRANSIT` should be **zero**. Any balance means cash bills that were never handed over, or refunds never paid out. This matches the "missing handover" list on the day reconciliation report.

## 5. Purchasing and inventory

### 5.1 Goods receipt with supplier bill
| Line | Entry |
|---|---|
| Stock | `Dr INVENTORY`: Σ qty × net_unit_cost. The bill discount is allocated into net unit costs (capitalized), not booked as income. |
| Supplier on credit | `Cr AP_CONTROL (party)`: bill total; party ledger due date = bill date + terms |
| Cash purchase from the drawer | `Cr CASH_DRAWER` |
| Paid by bank | `Cr <bank account>` |
| Tax (future) | `Dr TAX_RECOVERABLE` |

**Average cost update** per item:
- If on_hand > 0: `new_avg = (on_hand × avg + qty × net_unit_cost) / (on_hand + qty)`, rounded to minor units.
- If on_hand ≤ 0 before the receipt: `new_avg = net_unit_cost`.

### 5.2 Purchase return (debit note)
`Dr AP_CONTROL (party)`: return value at the return line's unit_cost (normally the original purchase cost).
`Cr INVENTORY`: qty × current avg cost.
Any difference goes to `PURCHASE_PRICE_VARIANCE` (Dr or Cr).

### 5.3 Stock adjustment and cycle count
- Gain: `Dr INVENTORY / Cr INVENTORY_ADJUSTMENT`: qty × avg cost.
- Loss: `Dr INVENTORY_ADJUSTMENT / Cr INVENTORY`.
- Writing off damaged goods is an adjustment out of DAMAGED with reason `write_off`.

### 5.4 Transfer between locations
Stock ledger only (out of one location, into another, at the same cost). **No GL entry**, because both locations are the same Inventory account.

## 6. Back-office documents
| Document | Entry |
|---|---|
| Customer receipt (bank) | `Dr <bank> / Cr AR_CONTROL (party)` |
| Supplier payment (bank) | `Dr AP_CONTROL (party) / Cr <bank>` |
| Expense (bank) | `Dr <expense> / Cr <bank>` |
| Bank-to-bank / bank-to-safe transfer | `Dr <to> / Cr <from>` |
| Journal voucher | As entered (must balance). The party is required on AR/AP lines. |

## 7. Opening balances at cutover (Delux, 1 Jan 2027)
A single opening entry dated **2027-01-01** with `source_type = 'opening'`, plus lock date **2026-12-31**:

| Line | Source |
|---|---|
| `Dr INVENTORY` | Σ (legacy closing qty × legacy valuation rate), as an opening stock movement into SHOP |
| `Dr AR_CONTROL (party)` per customer | Legacy customer balances (one opening party-ledger entry per customer, dated 2027-01-01) |
| `Cr AP_CONTROL (party)` per supplier | Legacy supplier balances |
| `Dr CASH_DRAWER` | Counted opening float |
| `Dr <bank accounts>` | **Bank statement** balances at 31 Dec (the legacy GL is not trusted for this) |
| `Cr OPENING_BALANCE_EQUITY` | The balancing figure |

The accountant later reclassifies Opening Balance Equity into partners' capital and drawings with a journal voucher. Legacy equity and P&L balances are **not** carried over: the legacy books were periodic with no inventory, so they do not reconcile with a perpetual-inventory balance sheet.

## 8. Worked example

Cost of the part = Rs 3,100. A walk-in buys it for Rs 4,350 cash, paying with a Rs 5,000 note.

| Step | Entry |
|---|---|
| Bill finalized at counter C03 | Dr Cash in transit 4,350 · Cr Sales 4,350 · Dr COGS 3,100 · Cr Inventory 3,100 |
| Salesman hands over at the cash desk (Rs 650 change goes back to the customer) | Dr Cash drawer 4,350 · Cr Cash in transit 4,350 |
| Next day the customer exchanges it for the correct part at Rs 4,800 | Dr Sales returns 4,350 · Cr Sales 4,800 · Dr Cash in transit 450 · Dr Inventory 3,100 · Cr COGS 3,100 · Dr COGS 3,400 · Cr Inventory 3,400 |
| Rs 450 collected at the desk | Dr Cash drawer 450 · Cr Cash in transit 450 |

Result: net sales 4,800, COGS 3,400, gross profit 1,400. Cash in transit is back to 0.

## 9. Questions for the accountant
1. Confirm that bill-level purchase discounts should be capitalized into inventory cost. (The legacy system had a "Purchase discount" income account.)
2. Confirm that partner expenses (legacy `40-05-*`) are **drawings** (equity), not business expenses.
3. Card settlements: in the MVP the accountant moves money from *Card settlement clearing* to the bank, net of fees, with a journal voucher. Is that acceptable until bank reconciliation arrives?
4. ~~Which legacy cash accounts are still used: "Cash memo" and "Cash for payment"?~~ **Resolved (PRD Q8):** unused in the legacy data, so not migrated unless they hold a balance at cutover.
