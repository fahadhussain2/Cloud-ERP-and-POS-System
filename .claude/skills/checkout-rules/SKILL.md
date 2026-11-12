---
name: checkout-rules
description: POS checkout business rules (prices, tiers, floors, discounts, overrides, credit limits, tender and change, rounding, returns and exchanges, voids, numbering, permissions). Use whenever writing or reviewing packages/domain, POS checkout or cash-desk code, or the server-side validation of synced sales.
---

# Checkout rules

**Source of truth:** PRD W1–W7, POS-02…17, CSH-01…09 and decisions D-001…D-013, D-047…D-053 (`docs/01-PRD.md`, `docs/06-DECISION-LOG.md`).

## Where rules live
- **Only in `packages/domain`:** pure functions, no I/O, deterministic, **golden-tested**. The POS calls them to compute; the API calls the same functions to re-validate synced documents.
- **Never** re-implement a rule in a component, API handler or SQL.
- Server re-validation **flags exceptions**; it never rejects a completed sale (D-011).

## Rules
- **Money:** integer paisa. Bills are whole rupees; cash rounding to Rs 1 goes to a rounding line. Quantities are integer thousandths.
- **Prices:** the customer's tier sets the list price (Retail / Mechanic / Wholesale). Down to the **floor** without approval; below the floor needs a **manager PIN override** (recorded with approver + reason). Role limits (max discount %) come from the role.
- **Bill discount** goes through the same floor and role checks. It's allocated to lines by largest remainder for returns and posting.
- **Tender:** cash (optional cash received, Enter = exact → change), bank/Raast, JazzCash, Easypaisa, card (reference required), on account (credit customers only), split.
- **Credit:** limit vs (synced balance + this device's unsynced credit sales). While offline, also the **per-customer daily cap**. Over either needs a manager PIN.
- **Returns** (W1-13, D-100): one `S` document of signed lines (`SaleDocumentV2`), one original bill per return, linked to the original line, **quantity ≤ sold − already returned**, refunded at the **original net price paid** (`refundFor`: a line returned in parts adds up exactly). No receipt (also every pre-go-live part: no legacy bills): manager PIN, the counter **suggests the lowest price in 90 days** and the approver may set it. Outside the window or a non-returnable category: PIN with `pos.return.outside_policy`. Without `pos.return.create`: an approver's PIN. Condition resellable → Shop, defective → Damaged.
- **Exchange:** one document with signed quantities; only the net settles (D-006). A refund goes back one way: cash at the desk (a payout), credit to account, or by transfer with a manager's PIN (`refund_transfer`); an even exchange takes no payment.
- **Void:** permission + PIN + reason, only before the cash handover and on the same business day. The number is kept and prints as VOID.
- **Numbering:** `{device}-{family}{seq:6}` (S sales, H handovers, R collections, M cash movements, Z close). Gapless per device, allocated in the same local transaction as the document and outbox row.
- **Business date:** local date of `created_at − 4h` (D-056).
- **Cash handover:** posts cash due; the cashier's correction of cash received is stored on the handover only. Unique per bill number and kind.

## Checklist
- [ ] Golden cases cover normal, boundary (exactly at floor or limit), over-limit with and without override, and rounding
- [ ] The same function is used by the POS and the API validation
- [ ] No floats, no `Date.now()` or randomness inside rules (inject the clock)
