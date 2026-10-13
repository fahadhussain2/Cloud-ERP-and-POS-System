# Decision Log

Decisions from the requirements interview on 2026-10-12, plus technical defaults proposed by the architect.

**Status values:**
- **Accepted**: the owner decided.
- **Accepted (against recommendation)**: the owner chose differently from the recommendation. The risk is recorded.
- **Proposed**: an architect default awaiting owner confirmation.

To change a decision, add a new entry that supersedes it. Never edit history.

---

## Checkout and POS

### D-001 Checkout model: salesman finalizes, single cash desk
- **Decision:** Any salesman finalizes and prints the bill at their own counter and collects payment. Cash is walked to the single cash desk, and change goes back to the customer through the salesman. The cash desk device also sells.
- **Alternatives:** order at the counter and pay at the cash desk; a drawer on every counter; hybrid by payment type.
- **Why:** This matches how the shop actually works today (legacy data plus the owner's description).
- **Status:** Accepted

### D-002 Printed bills are immutable: void and reissue, never edit
- **Decision:** A finalized bill cannot be edited. Mistakes caught before the cash handover and within the same business day are voided (PIN + reason), with an optional linked reissue. After that, use a return or exchange.
- **Alternatives:** editing with an audit log; editing the same day only.
- **Why:** 41% of legacy bills were edited, often days later by a shared account. Immutable documents are also what make offline sync conflict-free and keep the accounting stable.
- **Status:** Accepted

### D-003 Cash handover by signed QR, plus a live queue when online
- **Decision:** Every receipt carries a signed QR code. The cashier scans it to record the cash handover, which works offline. When online, the cash desk also shows a live queue of bills awaiting handover. The day close flags bills whose cash never arrived.
- **Alternatives:** live queue only (needs a LAN server); no tracking.
- **Status:** Accepted

### D-004 Pricing: tiers + floor + PIN override
- **Decision:** Price tiers (Retail / Mechanic / Wholesale). Salesmen can bargain down to their role limit and the floor price. Going below that needs a manager PIN. Every override is logged.
- **Alternatives:** one price with a role discount cap; free override with reporting only.
- **Why:** 33% of legacy lines were sold away from list price.
- **Status:** Accepted

### D-005 Returns are linked by default; no-receipt returns need a PIN
- **Decision:** Returns reference the original bill (QR, number, phone, date), including legacy bills from the last 90 days. Refunds are at the price paid. A no-receipt return needs a manager PIN and is refunded at the lowest 90-day selling price. Every return records a reason and a condition.
- **Status:** Accepted

### D-006 One-screen exchange: a single document with signed quantities
- **Decision:** Sales, returns and exchanges share one document type. Positive lines are sold, negative lines are returned, and only the net amount is settled.
- **Why:** Wrong-fit swaps and returned "options" are the most common cases. This gives one receipt and one cash movement.
- **Status:** Accepted (the screen); the single-document modelling is **Proposed**

### D-007 Refunds follow the payment method
- **Decision:** Cash refunds are paid out at the cash desk by QR (the reverse of the handover). Account customers get an account credit. Bank and wallet payers get a cash payout or a transfer, as the manager decides.
- **Status:** Accepted

### D-008 Warranty and supplier claims are deferred
- **Decision:** No claims workflow in the MVP. Returns still record the condition, and defective items go to a non-sellable DAMAGED location.
- **Status:** Accepted

### D-009 Offline architecture: each counter has its own local DB and syncs to the cloud
- **Decision:** Each counter is autonomous with a local database and outbox. There is no server in the shop. Every device has its own number series.
- **Alternatives:** a local store server plus cloud; a local server as primary.
- **Why:** Outages can last a full day or more. There is nothing to install on site, which is also better for SaaS.
- **Status:** Accepted

### D-010 POS delivered as a browser PWA
- **Decision:** Chromium PWA (not a desktop wrapper), with **mandatory guardrails**: persistent storage required to sell, SQLite on OPFS, browser policies against data clearing, kiosk printing, a visible unsynced count, and in-place local schema migrations.
- **Recommendation was:** a desktop-wrapped app, for durable storage and native printing.
- **Risk:** browser storage loss or eviction; printing only to the default printer.
- **Mitigation:** the guardrails above, plus a wrapper-ready codebase.
- **Status:** Accepted (against recommendation)

### D-011 Server accepts completed sales, then flags
- **Decision:** The server rejects only malformed, unauthenticated or badly signed documents. Rule violations are accepted and raised as exceptions.
- **Why:** A sale that happened offline is a fact; rejecting it would only lose data.
- **Status:** Proposed

### D-012 Payment methods and split tender
- **Decision:** Cash, bank transfer / Raast, JazzCash, Easypaisa, card, and on-account. Split tender is supported. Non-cash lines need a reference.
- **Status:** Accepted

### D-013 Credit control
- **Decision:** A credit limit per customer, checked against the synced balance plus local unsynced sales. While offline, an extra per-customer daily cap applies. Over the limit needs a manager PIN. Only allowed roles can sell on credit.
- **Status:** Accepted

## Catalog and inventory

### D-014 Light catalog structure
- **Decision:** Keep familiar names. Add multiple identifiers (barcode / OEM / alternate), brand, origin, variant, spec, bin location and optional vehicle tags (make / model / years). No full fitment database.
- **Status:** Accepted

### D-015 Locations: Shop, Godown and Damaged; sales come from Shop
- **Decision:** Sales always deduct from Shop. Moves are explicit transfers. Negative stock is allowed and raises alerts, including "transfer needed".
- **Status:** Accepted

### D-016 No unit-of-measure conversions in the MVP
- **Decision:** Items are bought and sold in the same unit.
- **Status:** Accepted

### D-017 Weighted average cost, valued in posting order
- **Decision:** One average per item per tenant. Outbound stock is valued at the average when posted, and inbound receipts re-average. Small differences from late-synced offline sales are accepted. A re-costing job is a Phase 2 option.
- **Status:** Accepted (method); the posting-order detail is **Proposed**

### D-018 Cycle counts on a phone, blind
- **Status:** Accepted

### D-019 Labels keep the legacy format, printed per goods receipt
- **Decision:** Code128 of the item code plus the supplier abbreviation of the delivering supplier. This preserves the per-unit supplier trace for future warranty claims.
- **Status:** Accepted

## Purchasing

### D-020 Purchase flow: optional PO, then receive with bill
- **Decision:** PO (optional) → shared by WhatsApp text, PDF or print → pickup run sheet → goods receipt with the supplier bill (partial deliveries, back-orders) → labels. Includes a reorder suggestion list.
- **Status:** Accepted

### D-021 Repricing is suggested; the purchaser approves
- **Status:** Accepted

## Money and accounting

### D-022 Automated double-entry GL with perpetual inventory
- **Status:** Accepted

### D-023 No sales tax in the MVP; extension points built in
- **Decision:** Delux is FBR-registered but not required to report POS sales. Tax codes (0%) and tax lines exist from day 1. A fiscal adapter interface lets FBR POS or UAE e-invoicing be added per tenant later.
- **Status:** Accepted

### D-024 Cash desk as a cash-management station with a Cash-in-transit account
- **Decision:** Handovers, refunds, collections, expenses, supplier payments, bank deposits and a denomination close. Counter cash sales post to *Cash in transit*, which must be zero at the end of a fully synced day.
- **Status:** Accepted (scope); the account design is **Proposed**

### D-025 Customer collections happen at the cash desk, offline-capable
- **Status:** Accepted

### D-035 Fiscal year is configurable per tenant
- **Decision:** The start month is chosen at onboarding (Delux: January). It locks after the first period close.
- **Status:** Accepted

## Platform

### D-026 Identity: device enrollment + personal PIN; role templates + custom roles
- **Decision:** Devices are enrolled by a manager. Staff unlock a device with a personal PIN, and manager overrides use the manager's PIN. Role templates can be copied into custom roles with permissions and numeric limits. The shared `admin` account is retired.
- **Status:** Accepted

### D-027 TypeScript end-to-end, with a Node.js backend
- **Decision:** React PWA + back-office SPA, a Node.js API, PostgreSQL, and a shared `packages/domain` for every checkout rule.
- **Alternatives:** a FastAPI (Python) backend. Rejected because checkout rules would have to be written twice, risking rounding and logic drift during offline sync. A Python service can be added later for AI or analytics.
- **Status:** Accepted

### D-028 Multi-tenancy: shared database with row-level security
- **Status:** Accepted

### D-029 Hosting: the owner's Hetzner VPS in Singapore
- **Decision:** Accepted for the MVP and pilot, with conditions:
  - continuous WAL backups to a different provider
  - monthly restore drills
  - hardening
  - Docker portability
  - counters able to re-push 30 days of documents
- **Revisit:** before onboarding UAE tenants (UAE region or managed Postgres).
- **Status:** Accepted

### D-032 English UI, ready for translation and right-to-left
- **Status:** Accepted

### D-036 Money stored as integer minor units; IDs are UUIDv7
- **Status:** Proposed (foundational; very costly to change later)

## Migration and delivery

### D-030 Migration scope
- **Decision:** Masters, opening balances (stock, AR, AP, cash/bank) and the last 90 days of sale bills (read-only, for returns). Older history stays in the read-only legacy DB.
- **Status:** Accepted

### D-031 Cutover: shadow pilot, then a full switch
- **Decision:** Shadow pilot on 1–2 counters plus the cash desk from 1–18 Dec. Go/no-go on 18 Dec. Full switch on 1 Jan 2027. Legacy becomes read-only.
- **Status:** Accepted

### D-033 Full MVP scope by 1 Jan 2027
- **Decision:** The full scope must be live on 1 Jan 2027.
- **Recommendation was:** fix the date and flex the scope (POs, financial statements, cycle counts and the custom role editor follow in Jan–Mar).
- **Risk:** about 8 weeks of build for one developer.
- **Mitigation:** build order by criticality (Wave 1 then Wave 2), go/no-go gate on 18 Dec, rollback plan.
- **Status:** Accepted (against recommendation)

### D-034 Opening stock from legacy, corrected by Q1 cycle counts
- **Status:** Accepted

## Proposed technical defaults (confirm in review)

| ID | Proposal | Main alternative |
|---|---|---|
| D-037 | **Fastify** API framework | Hono |
| D-038 | **Drizzle** ORM / migrations | Kysely, Prisma (Prisma is awkward with RLS) |
| D-039 | **SQLite WASM** (`opfs-sahpool`) in a Web Worker + in-memory search index | IndexedDB (Dexie) + MiniSearch |
| D-040 | Postgres-backed job queue (pg-boss / graphile-worker) | Redis + BullMQ |
| D-041 | Caddy + WAL-G/pgBackRest to off-site object storage | Nginx + cron `pg_dump` (no point-in-time recovery; not recommended) |
| D-042 | Custom sync protocol: outbox push + `xid8`-safe change-feed pull + SSE nudge | PowerSync / ElectricSQL (extra moving parts) |
| D-043 | New CoA template with legacy codes searchable | Keep the legacy `10-01-0001` structure |
| D-044 | Returns valued back into stock at the original sale line's cost | Current average cost |
| D-045 | Receipt QR signed with per-device ECDSA P-256 keys; ≤ 15 lines embedded | Unsigned QR (forgeable) |
| D-046 | Business-day cutoff at 04:00 local (late sales count to the same day) | Midnight |
