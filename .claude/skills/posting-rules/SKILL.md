---
name: posting-rules
description: Accounting posting rules for this ERP. Use whenever writing or reviewing code that creates stock movements, party (customer/supplier) ledger entries or GL journal entries; touches packages/posting; adds a new document type; or changes COGS, average cost, cash desk, returns, purchases or opening balances.
---

# Posting rules

**Source of truth:** `docs/04-ACCOUNTING-POSTING-RULES.md`. Read the section for the document type you are touching before writing code. If the code and the doc disagree, stop and ask; don't silently pick one.

## Invariants (never break)
1. Only `packages/posting` writes `stock_movements`, `party_ledger_entries`, `journal_entries` and `journal_lines`, in the **same DB transaction** that accepts the source document.
2. Every journal entry balances (Σ debit = Σ credit). Every line has `debit = 0` or `credit = 0`. Every row references `source_type` + `source_id`.
3. Money is integer minor units. Allocations (bill discount across lines) use **largest remainder**, so parts sum exactly to the whole.
4. Corrections are **reversal entries**, never updates or deletes.
5. Nothing posts on or before `tenants.lock_date`. A late offline document dated in a locked period posts on the first open date and raises an exception.
6. A rebuild from documents must reproduce the live ledgers exactly. Add a test whenever you add a document type.

## Quick reference (details in doc 04)
| Document | Core entry |
|---|---|
| Sale | Cr SALES (net line totals) · Dr SALES_DISCOUNT (bill discount) · Dr CASH_IN_TRANSIT / bank-wallet-card account / AR_CONTROL(party) by tender · Dr COGS / Cr INVENTORY at average cost |
| Returned lines | Dr SALES_RETURNS at the original net price paid · Cr CASH_IN_TRANSIT / AR / bank · Dr INVENTORY / Cr COGS at the **original line's cost** (legacy or no-receipt: current average) |
| Exchange | Both of the above in **one** entry; only the net settles |
| Void | Full reversal entry; stock reversed at the same costs |
| Handover / payout | Dr CASH_DRAWER / Cr CASH_IN_TRANSIT (reverse for a payout). Posts **cash due**, never the cash-received or change figures |
| Collection | Dr CASH_DRAWER or bank / Cr AR_CONTROL(party) |
| Cash-out | Expense: Dr expense / Cr CASH_DRAWER · supplier payment: Dr AP(party) / Cr CASH_DRAWER · deposit: Dr bank / Cr CASH_DRAWER |
| Drawer variance | CASH_SHORT_OVER against CASH_DRAWER |
| Goods receipt | Dr INVENTORY at net unit cost (**bill discount capitalized**, D-057) · Cr AP(party) / CASH_DRAWER / bank |
| Purchase return | Dr AP(party) at return value · Cr INVENTORY at average cost · difference → PURCHASE_PRICE_VARIANCE |
| Adjustment / count | INVENTORY vs INVENTORY_ADJUSTMENT at average cost |
| Transfer | Stock movements only, **no GL** |
| Opening (cutover) | Inventory, AR/AP per party, cash, banks → balancing line to OPENING_BALANCE_EQUITY |

## Average cost (D-017)
- One average per item per tenant, valued in **posting order**.
- On receipt: `new_avg = (on_hand × avg + qty × net_unit_cost) / (on_hand + qty)` if `on_hand > 0`, otherwise `net_unit_cost`. Round to minor units.

## Checklist for a posting change
- [ ] Doc 04 section re-read; golden test with the exact expected lines
- [ ] Balanced, linked to source, inside the acceptance transaction
- [ ] Rebuild test still equals the live ledgers
- [ ] Decision-log entry if a rule changed
