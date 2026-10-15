# Product Requirements: Cloud ERP + Offline POS (MVP)

| | |
|---|---|
| **Status** | Draft for owner review. No implementation until approved. |
| **Owner** | Fahad Hussain |
| **First tenant** | Delux Autos, Karachi (auto parts retail, PKR) |
| **Target** | Build Oct–Nov 2026 · Shadow pilot Dec 2026 · Go-live **Fri 1 Jan 2027** |
| **Related** | [Architecture](02-ARCHITECTURE.md) · [Data model](03-DATA-MODEL.md) · [Posting rules](04-ACCOUNTING-POSTING-RULES.md) · [Migration](05-LEGACY-MIGRATION.md) · [Decisions](06-DECISION-LOG.md) |

---

## 1. Vision

A multi-tenant, cloud-based ERP with a built-in point of sale for small and mid-sized retailers. The first customer is our own auto parts store. Later it will be sold as SaaS, first in Pakistan, then in the UAE and wider Middle East.

Three things define the product:

1. **The checkout never stops.** Every counter keeps selling, printing and taking returns through a full day without internet, and syncs automatically when the connection returns.
2. **Keyboard-first speed.** A salesman finds a part and finishes a bill without touching the mouse.
3. **One platform.** POS, inventory, purchasing, cash control and double-entry accounting share one database. Nothing is re-keyed.

The MVP is deliberately narrow and must work in production. Features and AI agents are added in later phases, on a data model that does not need to be rebuilt.

## 2. Current state (evidence from the legacy database)

Analysis of the legacy SQL Server database (`DLX_Inventory2024`, 1 Jul – 6 Dec 2025) found:

| Area | Finding | Requirement it drives |
|---|---|---|
| Volume | 22,261 sale bills in 159 days, about 140 per day (peak 278). Busiest hour 18:00–19:00. Average bill Rs 2,487 with 2.5 units. | Load is modest. Speed is a UI/UX problem, not a server problem. |
| Bill edits | **41% of sale bills were edited after creation**, 90% of them by a different user, mostly the shared `admin` account on the `CASH` PC. 906 were edited a day or more later. The owner says the reason is fixing salesman mistakes. | Printed bills are immutable. Corrections are made by void and reissue, or by return. |
| Credit assignment | 41.5% of edited bills are credit sales, against 0.5% of unedited ones. | Selecting the customer at the counter must be fast and hard to forget. |
| Bargaining | 33% of sale lines were sold at a price different from the item's *current* list price. This overstates bargaining somewhat because list prices change over time. 74% of fast movers sold at 2 or more prices. | Price tiers, floor prices and PIN overrides, with every override logged. |
| Returns | 383 formal returns (1.7% of bills). **None are linked to the original bill** (only free text such as `RETURN A/G BILL 23956`) and none record a user. | Returns are linked by default, need a reason and a condition, and no-receipt returns need a PIN. |
| Catalog | 19,552 items, of which only 6,670 (34%) sold in 5 months. There is no barcode field; labels show the item code and the supplier abbreviation. `PartNo`, `Manufacture`, `Brand` and `Model` are overloaded. 1,781 item names contain an embedded part number. | A light-structure catalog with smart search and a migration with cleanup reports. |
| Accounting | Periodic accounting with no Inventory or COGS accounts. Purchases are classed under Liabilities. Customer receipts are entered as journal vouchers. No payment method or tax is recorded. | Automated double-entry with perpetual inventory. |
| Users | 17 users with inconsistent name casing. The shared `admin` account made 2,189 sales and 5,786 edits. | Personal accounts, a PIN per person, and an audit trail. |
| Counters | The `CASH` PC created 35% of bills itself and made most of the edits. | The cash desk device works both as a selling counter and as the cash station. |

## 3. Goals, non-goals and success metrics

### 3.1 MVP goals
- G1. Replace the legacy desktop application completely at Delux Autos on 1 Jan 2027.
- G2. No checkout downtime from internet outages lasting up to one full business day (and longer, with warnings).
- G3. Every rupee is traceable: who sold, who collected, who handed over, who approved each override.
- G4. True profit: perpetual inventory at weighted average cost, with COGS on every sale.
- G5. Multi-tenant from day one, so a second shop can be onboarded without re-architecting.

### 3.2 Non-goals for the MVP
Sales tax and FBR/e-invoicing integration, multi-currency, multiple branches in the UI (the data model supports them), e-commerce, loyalty, warranty and supplier claims, sale-on-approval challans, landed-cost allocation, bank reconciliation, payroll, native mobile apps, Arabic/Urdu UI, AI agents, self-service tenant signup and subscription billing. See §9.

### 3.3 Success metrics (measured during the pilot)
| Metric | Target |
|---|---|
| Keyboard-only checkout of a 3-line cash bill, from search to finalized (sent to print) | ≤ 20 s for a trained salesman |
| Finalized cash bill visible in the cashier's live queue (online) | ≤ 5 s |
| Bill printed on the shared dot-matrix printer after finalize | Measured on the real printer in Wave 1. Target: before the salesman reaches the cash counter (≈ 15 s). |
| Search result latency on a counter PC (20k items) | ≤ 100 ms per keystroke |
| Lost or duplicated bills after offline periods | **0** |
| Time for an offline counter to fully sync after reconnecting | ≤ 2 min for one day of bills |
| Bills edited after printing | 0 (impossible by design) |
| Returns linked to the original bill or approved by PIN | 100% |
| Cash variance at day close traceable to a session and cashier | 100% |
| Bills whose cash never reached the drawer (handover confirmation **Required**) | Shown on the day-close report, every day |

## 4. Users and roles

Role **templates** ship with the product. Tenants can copy and adjust them, or create custom roles from a permission checklist plus **limits**.

| Role | Main jobs | Key limits / permissions |
|---|---|---|
| **Owner** | Everything, all reports, settings | All |
| **Manager** | Approvals (PIN overrides), voids, returns without a receipt, price changes, stock adjustments | Max override discount %, can approve below-floor sales, can void |
| **Cashier** | Cash desk: handovers, refunds, collections, cash-out, day close. Can also sell. | Cannot change prices beyond the role limit. Cannot approve their own variance. |
| **Salesman** | Sell, hold bills, start returns and exchanges, take payments | Discount down to the floor, credit sales only if allowed, cannot void |
| **Purchaser / Storekeeper** | POs, goods receipts, labels, transfers, counts, repricing proposals | Can see cost, cannot post journals |
| **Accountant** | Receipts, payments, expenses, journals, period close, financial reports | No POS selling |

Configurable role limits include: max discount % below list, whether the role can sell below floor, whether it can sell on credit, whether it can void (and within what window), whether it can refund without a receipt, whether it can view cost and margin, and whether it can approve overrides.

## 5. Core workflows

### W1. Counter sale (cash)
1. The salesman unlocks the counter with a **personal PIN**. The bill is attributed to them.
2. They search by name words, code, OEM part number or vehicle, or scan a label, then add lines with the keyboard (quantity, price within the allowed range).
3. Optionally they choose the customer (walk-in by default) and price tier (Retail by default; a customer's tier applies automatically).
4. On **Pay**, they choose the tender: cash. **Cash received** is optional. Pressing Enter means the exact amount; the salesman types a figure only when the customer hands over more, and the change is calculated.
5. The bill is **finalized** and printed silently to the counter's default printer, using the device's print profile (POS-16). **Delux:** all counters print to one shared network dot-matrix printer at the cash counter. The bill shows the cash received and the change, plus a scannable code (barcode or signed QR, per the print profile).
6. The salesman takes the customer's cash to the cash desk, where the bill is already printed (W4). The salesman returns to the customer with the change and the bill.

### W2. Credit sale (customer account)
As W1, but the customer is a credit account. The counter checks:
- the **credit limit** against the last-synced balance plus this counter's unsynced credit sales, and
- the **offline daily cap** while offline.

If either is exceeded, a manager PIN is needed. No cash moves, and the receipt shows "On account".

### W3. Split and non-cash tender
A bill can have several payment lines, for example cash + Raast, or JazzCash + card. Every non-cash line needs a **reference** (transaction ID or slip number). Only the cash portion goes through the handover.

### W4. Cash handover at the cash desk
1. **Live queue (normal path):** the cash desk shows finalized cash bills awaiting handover, and refunds awaiting payout, within seconds of finalizing. They are grouped by salesman and show counter, bill number, time, amount due, cash received and change.
2. The cashier matches the salesman and the printed bill to the queue entry and presses **Enter** to confirm. No scan is needed. Scanning the bill's code is an optional shortcut that jumps straight to the exact bill.
3. If the cash counted differs from the salesman's "cash received" (e.g. a typing mistake), the cashier corrects it while confirming. The correction is stored on the handover record with the cashier's name. The bill itself never changes.
4. The bill is marked **cash received** and the change given is recorded.
5. Bills sold on the cash desk device itself are handed over automatically.

**Offline:** the queue stops updating while the internet is down. The cashier reads the change from the printed bill and **scans its code** to record the handover (one beep). The code carries the bill number and amount due, so this works before the counter has synced, and the server matches it later.

**Handover confirmation setting (tenant):** steps 1–4 apply when it is **Required** (default; **Delux: Required**). When it is **Off**, every finalized cash bill and cash refund counts as handed over automatically: no queue, no confirmation and no scan. The trade-offs:
- A shortage is known only per cash session, not per bill or salesman.
- Bills where the customer walked away aren't flagged as unpaid.
- The drawer's expected cash only becomes final once all counters have synced (W10).

### W5. Void and reissue
A finalized bill is never edited. A Manager or Cashier with the permission voids it, with a **PIN and a reason**, and optionally issues a corrected bill linked to it. Default rule: voids are allowed until the business day closes **and** before the cash handover. After that, use a return. The voided bill keeps its number and prints as VOID.

### W6. Return and exchange (one screen)
1. Scan the bill's code, or search the bill by number, phone or date. This includes pre-cutover legacy bills from the last 90 days.
2. Mark the lines coming back (up to the quantity originally sold, minus earlier returns). For each, record a **reason** (wrong part, unused option, defective, changed mind, other) and a **condition** (resellable goes back to Shop; defective goes to the Damaged location).
3. Optionally add replacement items. The screen shows the net amount: the customer pays the difference or receives a refund.
4. Refunds are at the **price originally paid**.
5. **No-receipt return:** needs a manager PIN. It is refunded at the lowest selling price for that item in the last 90 days, falling back to the current price.
6. The return window and non-returnable categories are tenant settings.

### W7. Refund payout
Refunds follow the original payment method:
- **Cash refund:** the receipt shows "Refund due Rs X, collect at cash desk". The refund appears in the cashier's live queue. The cashier confirms it there (or scans the code, e.g. when offline) and pays out. This is the reverse of the handover.
- **Credit customer:** the account is credited.
- **Bank or wallet payers:** a manager decides between a cash payout and a transfer, with a reference.

### W8. Customer collection (mechanic pays dues)
At the cash desk, the cashier searches for the customer, sees the balance and ageing, records the payment (any method, with reference) and prints a receipt. Works offline.

### W9. Cash-out from the drawer
The cashier records each cash-out with a category, amount, note and an optional reference:
- **shop expense:** tea, petrol, generator, and so on (each category maps to a GL account)
- **supplier payment:** to a supplier account, for example cash given to the pickup runner
- **bank deposit:** to a bank account.

### W10. Day close (two-step)
1. **Drawer close (cash desk):** the cashier counts the drawer by **denomination**. The system calculates expected cash as: opening float + cash handovers + collections − refunds − cash-outs. The variance is recorded on the cash session. A manager acknowledges it.
   - *Handover setting Off:* "cash handovers" means every finalized cash bill of the session's period, from any counter. If some counters haven't synced yet, the variance is **provisional** until they do.
2. **Business-day reconciliation (cloud):** once all counters have synced, the day report lists offline cap breaches, below-floor sales without a valid override and negative stock events. With the handover setting **Required**, it also lists any **finalized cash bill without a handover** (by salesman). If a counter is still offline, the day stays *provisional*.

### W11. Purchasing
1. Draft a PO, optionally from the **reorder suggestion list**. The list shows items below minimum with 30 and 90 day sales, stock in Shop and Godown, open PO quantity and last supplier and cost, grouped by supplier.
2. **Share the PO** as a WhatsApp-ready text, a PDF, or a print.
3. **Pickup run sheet:** when the shop's runner collects goods from several suppliers, print or show a phone-friendly list of what to collect from whom.
4. **Goods receipt with bill:** enter the supplier bill number and date, the quantities received and the actual costs, and any discounts. Partial receipts leave PO lines open (back-ordered). Market purchases without a PO are entered the same way.
5. **Repricing suggestion:** if cost changed, show suggested list, tier and floor prices from the category markup rules. The purchaser approves or edits each line, and approved prices sync to every counter.
6. **Print labels** for the received quantity (legacy format: item code barcode + supplier abbreviation).
7. Payment terms flow into supplier ageing. A cash purchase pays from the drawer or the bank.

### W12. Purchase return
Return items to a supplier, linked to a goods receipt where possible. This reduces stock and the supplier balance.

### W13. Stock movement between locations
Locations are **Shop** (sellable), **Godown** (storage) and **Damaged** (not sellable).
- Sales always deduct from Shop.
- A transfer is a quick keyboard entry (Godown → Shop).
- If Shop goes negative while Godown has stock, the system raises a **transfer needed** alert.

### W14. Cycle count (phone)
1. Start a count for a scope: category, shelf, supplier or an item list.
2. Staff count **blind** with a phone browser, using the camera or manual entry.
3. Sales during the count are accounted for automatically.
4. A manager reviews the variances (quantity and value) and posts the adjustment.

### W15. The offline day
With no internet, every counter still:
- sells, prints, holds bills, voids within policy, and processes returns and exchanges
- searches the full catalog, applies prices and tiers, and enforces credit limits using cached balances plus the offline cap
- verifies PINs locally.

Printing to the shared network printer keeps working, because it only needs the LAN. The cash desk still handles handovers and refund payouts (by scanning the bill's code), collections, cash-outs and the drawer close. The following need the internet: the back office (purchasing, receiving, reports, master data), the live cash queue, and cross-counter stock accuracy. A status bar always shows *Offline since HH:MM · N bills waiting to sync*. On reconnect, everything syncs automatically with no user action.

## 6. Functional requirements

**Wave** is the build order: **1** is the critical path for go-live, **2** completes the MVP scope. Both are in scope for 1 Jan 2027 (see D-033).

### 6.1 Platform (PLT)
| ID | Requirement | Wave |
|---|---|---|
| PLT-01 | Tenant with base currency, timezone, locale, fiscal year start month (fixed once the first period is closed), cash rounding rule, receipt header, and **cash handover confirmation** (Required / Off; Delux: Required; see W4). | 1 |
| PLT-02 | Branch → Locations (Shop / Godown / Damaged, flagged sellable or not). One branch in the MVP UI, many in the model. | 1 |
| PLT-03 | Device enrollment: a manager registers a counter or cash desk browser to a branch with a one-time code. Devices can be named, given a type (counter / cash desk) and revoked. | 1 |
| PLT-04 | Users with personal accounts. Back-office login by username/email and password. **POS unlock by personal PIN** on an enrolled device. Auto-lock after inactivity. | 1 |
| PLT-05 | Role templates (§4) with permissions and limits. | 1 |
| PLT-06 | Custom role editor (copy a template, edit the permission checklist and limits). | 2 |
| PLT-07 | Manager override = manager's PIN on the same screen, with a reason. Recorded on the document. | 1 |
| PLT-08 | Append-only audit log for master data changes (before and after), logins, overrides, voids, settings. | 1 |
| PLT-09 | Device health page: last sync, unsynced documents, app version, persistent-storage status, clock skew. | 1 |
| PLT-10 | Tenant data isolation enforced in the database (row-level security). | 1 |

### 6.2 Catalog and pricing (CAT)
| ID | Requirement | Wave |
|---|---|---|
| CAT-01 | Item: code (unique, scannable), name, category, brand, origin, unit, position/variant (L/R/Front/Rear/Set…), bin location, default supplier, min and max quantity, exclude-from-reorder flag, active/dormant status. | 1 |
| CAT-02 | Multiple **identifiers** per item: barcodes, OEM part numbers, alternate or supplier references. Searched in normalized form (case, spaces and dashes ignored). | 1 |
| CAT-03 | Optional **vehicle tags** per item: make, model, year range, free-text note. | 1 |
| CAT-04 | **Price tiers** per tenant (default Retail / Mechanic / Wholesale). A price per item per tier. A customer has a default tier. | 1 |
| CAT-05 | **Floor price** per item, or a category rule (floor = cost × (1 + min margin)). | 1 |
| CAT-06 | Category markup rules for repricing suggestions (tier prices and floor from cost). | 2 |
| CAT-07 | Price change history (who, when, old → new, reason/source). | 1 |
| CAT-08 | Label printing in the legacy format (Code128 item code + supplier abbreviation), from an item list or a goods receipt. Configurable template. | 1 |
| CAT-09 | Bulk import and export of items and prices via CSV. | 2 |

### 6.3 POS counter (POS)
| ID | Requirement | Wave |
|---|---|---|
| POS-01 | Installable PWA on Chromium (Chrome/Edge). Refuses to start selling unless persistent storage is granted and the local database passes a health check. | 1 |
| POS-02 | **Omni-search:** one input that matches code, barcode scan, OEM/alternate numbers (normalized), name words in any order, and vehicle tags. Ranked: exact code/barcode → identifier → name/vehicle. Shows Shop and Godown stock, tier price and bin location. ≤ 100 ms. | 1 |
| POS-03 | Fully keyboard-driven: function-key map, no mouse needed, visible shortcut hints. | 1 |
| POS-04 | Bill lines: quantity, unit price (from tier). A price below list requires a role limit or override; below floor requires a manager PIN. Optional bill-level discount under the same rules. | 1 |
| POS-05 | Customer selection: walk-in by default, fast search by name, phone or code. Optional phone capture for walk-ins (so bills can be found later without a receipt). | 1 |
| POS-06 | Tender: cash (optional cash received, Enter = exact amount → change), bank/Raast, JazzCash, Easypaisa, card. **Split tender**, with a reference on non-cash lines. Credit account. | 1 |
| POS-07 | Credit control: limit check (synced balance + local unsynced) and offline daily cap per customer. Over the limit requires a manager PIN. | 1 |
| POS-08 | **Hold / park** bills and resume them on the same device. Held bills expire at day close. | 1 |
| POS-09 | Finalize → print the bill silently to the device's default printer (local or shared network printer) using its print profile (POS-16). The bill shows the shop header, bill number, date and time, salesman, lines, totals, tender, cash received and change, return policy line, and a scannable **bill code** (barcode or signed QR). | 1 |
| POS-10 | Reprint (marked REPRINT, logged). | 1 |
| POS-11 | **Void** with permission, PIN and reason within the void window; optional linked **reissue**. | 1 |
| POS-12 | **Return / exchange** screen per W6, including legacy bill lookup (90 days), reason and condition, no-receipt flow with PIN, return window and non-returnable category rules. | 1 |
| POS-13 | Per-device document numbering, gapless and never reused (e.g. `C03-S000412`). | 1 |
| POS-14 | Status bar: online/offline, last sync, unsynced count, warnings when offline longer than a threshold. | 1 |
| POS-15 | Cash rounding per tenant rule (e.g. to the nearest whole rupee), posted to a rounding account. | 1 |
| POS-16 | **Print profiles:** a tenant default, overridable per device. Paper format: A4, A5/half page, 80 mm or 58 mm thermal. Bill code: barcode (bill number + amount due) or signed QR. Copies: 1 or 2. Templates suited to dot-matrix and thermal printers. **Delux:** A4 dot matrix, barcode, 1 copy. | 1 |

### 6.4 Cash desk (CSH)
| ID | Requirement | Wave |
|---|---|---|
| CSH-01 | Cash session: open with float, belongs to one cash desk device and cashier. Can hand over to another cashier (close/open). | 1 |
| CSH-02 | **Live queue** of cash bills awaiting handover and refunds awaiting payout, updated within seconds when online and grouped by salesman. Confirm with Enter; the cashier can correct the cash received (logged); change given is recorded. Duplicate confirmations are detected. This is the primary handover path (W4). Only active when handover confirmation is Required. | 1 |
| CSH-03 | **Scan handover:** scanning a bill's code jumps to it in the queue. When offline, the scan records the handover from the code's bill number and amount. Only active when handover confirmation is Required. | 1 |
| CSH-04 | Refund payout from the queue, or by scanning (W7). | 1 |
| CSH-05 | Customer collections with receipt print (W8). | 1 |
| CSH-06 | Cash-out: expense (category), supplier payment (party), bank deposit (bank account), each with a note and reference (W9). | 1 |
| CSH-07 | Drawer close by denomination, expected vs counted, variance with a reason and manager acknowledgement (W10.1). | 1 |
| CSH-08 | Business-day reconciliation report (W10.2): missing handovers (when Required), exceptions, provisional/final status. | 1 |
| CSH-09 | Handover confirmation **Off** mode: automatic handovers for all cash bills and refunds, and the drawer close expects every finalized cash bill (W4, W10). Not needed by Delux at go-live. | 2 |

### 6.5 Inventory (INV)
| ID | Requirement | Wave |
|---|---|---|
| INV-01 | Append-only stock ledger per item and location, written from documents. Stock balances per item and location. | 1 |
| INV-02 | Weighted average cost per item (tenant-wide), updated on receipt. COGS valued at posting (see posting rules). | 1 |
| INV-03 | Negative stock **allowed** (sales are never blocked) and creates alerts. | 1 |
| INV-04 | Transfers between locations (Godown ↔ Shop, any → Damaged). | 1 |
| INV-05 | Stock adjustments with reason codes (manager), valued and posted. | 1 |
| INV-06 | Cycle counts on a phone browser, blind, scope-based, auto-adjusting for sales during the count, with a variance approval step (W14). | 2 |
| INV-07 | Item stock card: every movement with document link, quantity, cost and running balance. | 1 |

### 6.6 Purchasing (PUR)
| ID | Requirement | Wave |
|---|---|---|
| PUR-01 | Supplier records with terms, label abbreviation, contacts. A party can be supplier and customer at once. | 1 |
| PUR-02 | **Goods receipt with supplier bill** (W11.4): partial quantities, line and bill discounts, cash or credit purchase. Without a PO, or against a PO. | 1 |
| PUR-03 | Purchase return / debit note (W12). | 1 |
| PUR-04 | Purchase orders: draft → sent → partially received → received / closed / cancelled. Back-ordered quantity tracking. | 2 |
| PUR-05 | PO sharing: WhatsApp-ready text (opens WhatsApp with a prefilled message), PDF, print. | 2 |
| PUR-06 | Pickup run sheet across open POs, grouped by supplier, mobile-friendly. | 2 |
| PUR-07 | Reorder suggestion list (W11.1). Ticked lines become POs per supplier. | 2 |
| PUR-08 | Repricing suggestions on receipt, with approval (W11.5). | 2 |
| PUR-09 | Supplier ledger and ageing; payments from the back office (bank) or the cash desk (CSH-06). | 1 |

### 6.7 Accounting (ACC)
| ID | Requirement | Wave |
|---|---|---|
| ACC-01 | Chart of accounts (tree) from a retail template plus tenant-specific accounts. System account roles (AR, AP, Inventory, COGS, Cash Drawer, Cash Clearing…) mapped once. | 1 |
| ACC-02 | **Automatic posting** of every operational document to the GL per [posting rules](04-ACCOUNTING-POSTING-RULES.md). Idempotent and rebuildable. | 1 |
| ACC-03 | Customer and supplier sub-ledgers with balances and ageing (from cutover onward). | 1 |
| ACC-04 | Back-office receipts and payments (bank), expenses, bank-to-bank transfers. | 1 |
| ACC-05 | Journal vouchers (accountant), with reversal. | 1 |
| ACC-06 | Fiscal years and periods from the tenant setting. Period lock date (no postings on or before it). | 1 |
| ACC-07 | Reports: account ledger, cash book, trial balance, profit & loss, balance sheet (any date range). | 2 |
| ACC-08 | Payment-method → GL account mapping (e.g. Raast → HBL clearing, JazzCash → wallet account). | 1 |
| ACC-09 | Tax code on items (all 0% in the MVP) and tax lines on documents, so VAT/sales tax can be switched on later without schema changes. | 1 |

### 6.8 Reports (RPT)
| ID | Report | Wave |
|---|---|---|
| RPT-01 | Daily sales register (by bill, salesman, counter, tender) | 1 |
| RPT-02 | Day reconciliation and cash variance by session / cashier | 1 |
| RPT-03 | Overrides and below-list sales by salesman, item, approver | 1 |
| RPT-04 | Voids and reissues; returns by reason and condition, salesman, item | 1 |
| RPT-05 | Current stock by location; stock valuation | 1 |
| RPT-06 | Customer outstanding and ageing; supplier outstanding and ageing | 1 |
| RPT-07 | Sales and gross profit by item, category, brand, salesman, period | 2 |
| RPT-08 | Dead/slow stock (no sale in N days, with value) | 2 |
| RPT-09 | Purchase register; item purchase vs sale rate analysis (legacy parity) | 2 |
| RPT-10 | Exceptions: below-floor sales without override, offline cap breaches, negative stock, clock skew | 1 |

All reports filter by date range and export to CSV. PDF/print is offered where it makes sense.

### 6.9 Sync and offline (SYN)
| ID | Requirement | Wave |
|---|---|---|
| SYN-01 | Each counter holds a local copy of: catalog, identifiers, vehicle tags, prices, floors, customers (with balance snapshot and limits), users/PIN verifiers, roles and settings, its own documents for 30 days, and 90 days of the branch's sale bills (headers + lines, for returns). | 1 |
| SYN-02 | Upload of finalized documents through an outbox. Idempotent, ordered per device, retried with backoff, no user action. When online, a finalized bill is pushed **immediately** (not on a timer), so it reaches the cashier's live queue within seconds. | 1 |
| SYN-03 | **The server never rejects a completed sale on business-rule grounds.** It accepts it and raises an exception for review. It rejects only malformed, unauthenticated or tampered payloads. | 1 |
| SYN-04 | Incremental download of reference data changes, plus a "changes available" push when online. | 1 |
| SYN-05 | After a server restore, a counter can re-push its last 30 days of documents safely (deduplicated by ID). | 1 |
| SYN-06 | Warnings when offline beyond configurable thresholds (e.g. 8 h warning, 48 h strong warning). Selling is never blocked. | 1 |

### 6.10 Legacy migration (MIG)
| ID | Requirement | Wave |
|---|---|---|
| MIG-01 | Repeatable importer for masters (items, categories, brands, origins, parties, chart of accounts) with cleanup reports. | 1 |
| MIG-02 | Opening balances at cutover: stock quantity (into Shop) and average cost, customer and supplier balances, GL opening entry. | 1 |
| MIG-03 | The last 90 days of legacy sale bills imported read-only for return lookup. | 1 |
| MIG-04 | Reconciliation report: counts, stock value, AR/AP totals and trial balance vs legacy. | 1 |

## 7. Non-functional requirements

| Area | Requirement |
|---|---|
| **Performance** | POS cold start ≤ 5 s, warm ≤ 1 s. Search ≤ 100 ms. Finalize and send to the printer ≤ 2 s (the physical print time depends on the printer). Back-office pages ≤ 2 s at p95. |
| **Offline** | Full POS and cash desk operation offline for at least 1 business day without data loss. Longer works, with warnings. |
| **Durability** | A finalized document is committed to local storage before printing. Server RPO ≤ 5 min (continuous WAL archiving), plus counters re-pushing 30 days. RTO ≤ 4 h. |
| **Integrity** | Money in integer minor units. Documents immutable after finalization. GL and stock ledgers append-only and rebuildable from documents. |
| **Security** | Tenant isolation by RLS. Passwords hashed with Argon2id. PINs never stored in plain text. TLS everywhere. Least-privilege roles. Audit log. Legacy passwords are not migrated. |
| **Scale (design)** | 1,000 tenants. 100k items per tenant. 2,000 bills/day per tenant. 30 devices per tenant. Without re-architecture. |
| **Browser / hardware** | Chrome or Edge (current), Windows 10/11 counters (Android tablets are a later phase, §9). Each counter's **default Windows printer** receives its bills. This can be a local printer or a shared network printer, thermal or A4/A5 (print profiles, POS-16). **Delux:** one network-attached A4 dot-matrix printer at the cash counter, the default printer on every counter. Keyboard-wedge barcode scanners (including one at the cash desk). Labels and other A4 documents print from the back office. |
| **i18n** | English only, but all UI strings go through translation keys, CSS uses logical properties (RTL-ready), and numbers, dates and currency are formatted by locale. |
| **Observability** | Structured logs, error tracking, uptime monitoring, device health telemetry. |

## 8. Release plan

| Dates (2026) | Phase | Content |
|---|---|---|
| Mon 12 Oct – Sun 25 Oct | **Wave 0: foundations** | Monorepo, CI, VPS + Docker + backups, database + RLS, auth (users, devices, PIN), roles, tenant setup, **legacy importer first** (so all development uses the real 19.5k items). |
| Mon 26 Oct – Sun 22 Nov | **Wave 1: critical path** | POS PWA (local DB, search, bill, tender, print profiles + bill code, hold, void, return/exchange), sync, cash desk (**live queue** + scan handover), credit control, stock ledger, goods receipt, purchase return, supplier/customer ledgers, posting engine, labels. **First week: print test on the shop's dot-matrix printer** (speed, layout, barcode scannability). |
| Mon 23 Nov – Sun 6 Dec | **Wave 2: rest of MVP** | POs, sharing, pickup sheet, reorder list, repricing, cycle counts, custom roles, financial statements, remaining reports. |
| Tue 1 Dec – Fri 18 Dec | **Shadow pilot** | 1–2 counters + the cash desk run the new system in parallel (legacy remains official). Daily reconciliation. Includes a deliberate **8-hour offline drill**. |
| **Fri 18 Dec** | **Go / no-go** | Checklist below. |
| Sat 19 Dec – Thu 31 Dec | Freeze and prepare | Bug fixes only. Staff training and PINs. Counter PC setup (browser policies, kiosk printing). 4G failover router. Two migration rehearsals. **Final migration on the night of 31 Dec** after the legacy day close. |
| **Fri 1 Jan 2027** | **Go-live** | All counters on the new system. Legacy becomes read-only. |
| Jan – Mar 2027 | Stabilize | Cycle counts by category (fast movers first), fixes, Phase 2 planning. |

> **Timeline risk (accepted by owner, D-033):** the full scope in about 8 weeks of build time is aggressive for one developer. Mitigation: build in order of go-live criticality (Wave 1 before Wave 2), so anything unfinished on 18 Dec is Wave 2, which does not stop the shop. Wave 2 items not ready by go-live ship in January without data loss: GL entries are derived from documents, POs are not used today, and counts can use adjustments.

### Go / no-go checklist (18 Dec)
- [ ] Pilot: 0 lost or duplicated bills (system vs printed paper count) on every pilot day.
- [ ] Offline drill: counters offline ≥ 8 h, then synced cleanly with no manual fixes.
- [ ] Every pilot day's cash variance explained.
- [ ] Migration rehearsal: item count, stock value, AR and AP totals match legacy within agreed tolerance. Trial balance balances.
- [ ] Restore drill from the off-site backup completed and timed.
- [ ] All counter PCs pass the device check (browser version, persistent storage, kiosk printing, policies).
- [ ] All staff have personal accounts and PINs. Role limits configured.
- [ ] Rollback plan agreed: if there is a critical failure on go-live day, return to legacy and re-enter the day's bills from printed receipts.

## 9. Later phases (not in the MVP)
Warranty and supplier claims · sale-on-approval challans · quotations · bank and wallet statement reconciliation · landed-cost allocation · FBR POS integration and UAE e-invoicing, VAT · multi-currency · multi-branch UI and inter-branch transfers · LAN peer sync between counters · full vehicle fitment database and item images · customer loyalty and SMS/WhatsApp receipts · salesman commissions · AI agents (reorder, pricing, catalog cleanup, anomaly detection) · Arabic/Urdu UI · tenant self-signup and subscription billing · native or desktop-wrapped POS if the PWA proves limiting · **Android tablet POS** (Chrome on Android): a touch layout with an on-screen number pad, silent printing to Bluetooth/USB thermal printers driven directly by the app, and device management so staff can't clear the app's storage. The local database and offline sync already work there (iPad/Safari not targeted).

## 10. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Aggressive timeline, solo developer | Bugs at go-live | Build order by criticality. Strict scope. Pilot + go/no-go gate. Rollback plan. |
| Browser storage wiped (cleaners, "clear history") | Unsynced bills lost | Persistent storage required. Chrome policies on counters. Unsynced count always visible. Printed bills as a backstop. |
| Counter PC dies during a long outage | Its unsynced bills exist only on paper | With a signed-QR profile, the full bill is encoded in the QR (when short), so the cash desk holds a copy. With a barcode profile (Delux), only the bill number and amount are captured at handover. Re-entry tool from paper. |
| Single shared printer (Delux) | If it jams or runs out of paper, no counter can print | Bills are saved before printing and can be reprinted (POS-10) once it's fixed. Keep a spare printer and paper stock. |
| Browser printing on dot matrix | Browsers print as graphics, which is slower than the plain-text printing older apps use. Barcodes may scan poorly. | Test on the real printer in Wave 1 week 1. Light layout, half-page paper. Fallback: a small local print helper sending plain text to the printer (adds an install step). |
| Staff resist "no edits" and personal PINs | Workarounds, shared PINs | Training. Fast void/reissue. Overrides by PIN are faster than calling admin. Audit reports reviewed weekly. |
| Legacy data quality | Bad search, wrong stock | Cleanup reports. Opening stock from legacy, then Q1 cycle counts. |
| Single VPS | Back office down, data risk | Counters keep selling offline. WAL backups off-site. Restore drills. Portable Docker setup. |
| Old Windows / browsers on some counters | PWA will not run | Device check before the pilot (open question Q10). |
| December is a busy month for a pilot | Staff overload | Shadow pilot on 1–2 counters only. |

## 11. Open questions for the owner

| # | Question | Default if not answered |
|---|---|---|
| Q1 | How should **Mechanic and Wholesale tier prices** be set initially? The legacy system has one sale price. | Mechanic = Retail −5%, Wholesale = Retail −10%, editable |
| Q2 | **Floor price** default: minimum margin over cost per category? | Floor = cost + 5% |
| Q3 | **Return window** (days) and non-returnable categories (e.g. electricals once fitted)? | 30 days, none excluded |
| Q4 | **Void window**: until handover and same business day, as proposed? | Yes |
| Q5 | **Cash rounding**: to the nearest whole rupee? | Nearest Rs 1 |
| Q6 | Default **credit limits** and the **offline daily cap** for credit customers? | Limit set per customer; offline cap Rs 25,000/day |
| Q7 | Model of the shared dot-matrix printer and the label printer. Is the paper continuous (tractor-feed) or single sheets? Full A4 or half page per bill? Label size? | Needed before the Wave 1 print test |
| Q8 | Are the legacy accounts "Cheque in hand", "Cash memo" and "Cash for payment" still used? | Migrate them as asset accounts |
| Q9 | How should stock be split between **Shop and Godown** at go-live? Legacy has a single figure. | All in Shop. Godown counted and transferred in January. |
| Q10 | Counter PCs: Windows version and browser? (Chrome no longer supports Windows 7/8.) | Windows 10/11 + Chrome |
| Q11 | Where will the **final legacy database** for 31 Dec 2026 come from? Legacy appears to create a new DB per period. | Fresh SSMS script dump on 31 Dec |
| Q12 | **Receipt content**: NTN, address, phone, return policy text, any Urdu line? | Name, address, phone, policy line in English |
| Q13 | **Expense categories** for cash-out (initial list)? | From legacy expense accounts |
| Q14 | Which bank or wallet account receives each **payment method** (Raast, JazzCash, Easypaisa, card)? | Ask during setup |
| Q15 | Partner drawings are not taken from the drawer. How are they recorded (bank)? | Journal voucher by the accountant |
