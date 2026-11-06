# Purchasing (`PUR`)

| | |
|---|---|
| **Status** | W1-16 built (D-105): suppliers, goods receipts with the bill-total check, purchase returns, the supplier ledger, payments by bank. POs, sharing, the run sheet, reorder and repricing are Wave 2 |
| **Requirements** | 9 (PUR-01…PUR-09) |
| **Feature spec needed** | No: the prototype and PRD are enough |

## Scope

Suppliers, goods receipts with the supplier's bill, purchase returns, purchase orders with WhatsApp/PDF sharing, pickup run sheet, reorder list, repricing suggestions, supplier ledger.

## Requirements

Full wording is in [the PRD](../../01-PRD.md). Wave 1 = critical path for go-live, Wave 2 = rest of the MVP.

| ID | Summary | Wave |
|---|---|---|
| PUR-01 | Supplier records with terms, label abbreviation, contacts. | 1 |
| PUR-02 | Goods receipt with supplier bill (W11.4): partial quantities, line and bill discounts, cash or credit purchase. | 1 |
| PUR-03 | Purchase return / debit note (W12). | 1 |
| PUR-04 | Purchase orders: draft → sent → partially received → received / closed / cancelled. | 2 |
| PUR-05 | PO sharing: WhatsApp-ready text (opens WhatsApp with a prefilled message), PDF, print. | 2 |
| PUR-06 | Pickup run sheet across open POs, grouped by supplier, mobile-friendly. | 2 |
| PUR-07 | Reorder suggestion list (W11.1). | 2 |
| PUR-08 | Repricing suggestions on receipt, with approval (W11.5). | 2 |
| PUR-09 | Supplier ledger and ageing; payments from the back office (bank) or the cash desk (CSH-06). | 1 |

## Related

PRD W11–W12; data model §8; posting rules §5.1–5.2; D-020, D-021; prototype: Tijara Goods Receipt

## Work in this module

- `spec.md`: only if needed (see above), written before the first plan that depends on it.
- `plans/<wave>-<nn>-<slug>.md`: one accepted plan per task, before any code ([delivery process](../../07-DELIVERY-PROCESS.md) §3).
- `intent.md`: only for changes after the MVP.
