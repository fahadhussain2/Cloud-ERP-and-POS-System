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
- **Status:** Accepted. **Partly superseded by D-047** (2026-10-14): the live queue is now the primary path, and scanning is the shortcut and offline fallback.

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
- **Status:** Accepted. **Partly superseded by D-047** (2026-10-14): cash refund payouts use the live queue or a scan.

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
- **Status:** Accepted; the barcode is **Code 39**, not Code128 (D-055, D-106). Built in W1-17.

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
| D-045 | Receipt QR signed with per-device ECDSA P-256 keys; ≤ 15 lines embedded. **Partly superseded by D-048:** applies only to print profiles that use the signed QR. | Unsigned QR (forgeable) |
| D-046 | Business-day cutoff at 04:00 local (late sales count to the same day) | Midnight |

## Decisions added during review

### D-047 Shared LAN printer and queue-first cash handover (2026-10-14)
- **Context:** Delux counters have no printers of their own. All of them print to one network-attached A4 dot-matrix printer at the cash counter, and the salesman brings the cash there.
- **Decision:**
  - The salesman finalizes the bill and enters the **cash received** (optional; Enter = exact amount).
  - The bill prints silently over the LAN at the cash counter, showing the cash received and the change.
  - The cashier confirms the bill from a **live queue** (online, ≤ 5 s after finalize) by pressing Enter, and can correct the cash received. The correction is logged on the handover record; the bill never changes.
  - Scanning the bill's code is an optional shortcut, and **the** method when the internet is down. Printing over the LAN keeps working offline.
  - Cash refund payouts follow the same queue / scan flow (replaces "by QR" in D-007).
- **Consequences:**
  - The live queue moves from Wave 2 to **Wave 1** (CSH-02).
  - Bills are pushed immediately on finalize (SYN-02).
  - Handovers become their own POS document (`H` series).
- **Alternatives:**
  - **Scan every bill** (the original D-003 flow): rejected as more work for the cashier on normal days.
  - **In-shop LAN hub**, so the queue also works offline: rejected for the MVP. It costs about 2–3 weeks plus a new failure point. It's a candidate for Phase 2 if outages stay frequent after the 4G failover router.
- **Status:** Accepted

### D-048 Configurable print profiles; barcode for dot-matrix printers (2026-10-14)
- **Decision:**
  - **Print profiles** (paper: A4 / A5 / 80 mm / 58 mm; bill code: barcode or signed QR; copies: 1–2), with a tenant default and an override per device.
  - The bill code is a **barcode** (bill number + amount due) on dot-matrix profiles, and a **signed QR** on thermal or laser profiles.
  - **Delux:** A4 dot matrix, barcode, 1 copy.
- **Why:** other tenants will use thermal printers. Dot matrix can't print a dense QR reliably. An unsigned barcode is safe when bills print on the shop's own printer at the cash counter.
- **Trade-off:** with the barcode profile there's no offline copy of the bill lines at the cash desk. An offline return of another counter's unsynced bill uses the no-receipt PIN flow.
- **Open:**
  - Browser printing on dot matrix (graphics mode) must pass a speed and scannability test in Wave 1 week 1.
  - The fallback is a small local plain-text print helper.
- **Status:** Accepted

### D-049 Cash handover confirmation is a tenant setting (2026-10-15)
- **Decision:** `cash_handover_mode` = **Required** or **Off**. **Delux: Required.**
  - **Required:** every cash bill and refund is confirmed at the cash desk (Enter in the queue, or a scan when offline), as in D-047.
  - **Off:** the server creates an automatic handover for every cash bill and refund. There is no per-bill cashier action.
- **Why:** finalizing a bill records the sale; confirming records that the cash actually reached the drawer. Required gives per-bill and per-salesman accountability and flags bills where the customer walked away. Off suits shops that are happy with drawer-level reconciliation. Supporting both is cheap and useful for SaaS tenants.
- **Trade-off of Off:** a shortage is known only per cash session; walk-away bills aren't flagged; the drawer's expected cash is provisional until all counters sync.
- **Build:** Required in Wave 1 (Delux). Off mode in Wave 2 (CSH-09).
- **Status:** Accepted

### D-050 POS platform: Windows PCs in the MVP, Android tablets in a later phase (2026-10-15)
- **Decision:** The MVP POS supports Chrome/Edge on Windows 10/11 only. Android tablet support (Chrome on Android) is a later phase.
- **Why:**
  - The local database and offline sync already work on Chrome for Android.
  - What's missing there is silent printing (Android always shows a print dialog and handles dot matrix poorly), a touch layout, and protection against staff clearing the app's storage.
  - Delux uses Windows PCs, so none of this is needed for go-live.
- **Later-phase scope:**
  - a touch layout with an on-screen number pad
  - silent printing to Bluetooth/USB thermal printers driven directly by the app
  - device management guidance.
- iPad/Safari is not targeted.
- **Status:** Accepted

### D-051 Returns are a role permission, with PIN approval as the fallback (2026-10-15)
- **Decision:**
  - "Can process returns" (`pos.return.create`) is an explicit role permission. **Delux default: the Salesman role has it.** The owner can remove it per role, e.g. allow only a "Senior Salesman" role.
  - A user without the permission can still prepare a return. They complete it with the PIN of a user who has the permission, recorded as an override.
  - Returns **outside the return window** or from a **non-returnable category** need the PIN of a user with `pos.return.outside_policy` (Manager by default).
  - No-receipt returns stay as in D-005 (`pos.return.no_receipt`, manager PIN).
- **Why:** returns are frequent, so requiring a manager for every one would create a bottleneck. The default controls are already strong: the return is linked to the original bill, the reason and condition are recorded, and the cashier pays out every cash refund. The permission lets the owner tighten this without code changes.
- **Not decided:** a refund value limit per role (e.g. a manager PIN above Rs 10,000). This can be added later as a role limit.
- **Status:** Accepted

### D-052 Open questions resolved; defaults accepted (2026-10-17)
- **Decision:** the owner accepted the defaults for PRD Q1–Q6, Q9 and Q12–Q15 (see PRD §11). Answers:
  - **Q8:** legacy "Cheque in hand", "Cash memo" and "Cash for payment" are unused (no transactions, zero balance), so they are **not migrated** unless they hold a balance at cutover. Customers don't pay by cheque, so there is **no cheque payment method**.
  - **Q10:** Windows 8 counters (Chrome/Edge frozen at v109 since 2023) will be **upgraded to Windows 10 before 1 Dec**. The supported counter platform stays Windows 10/11 with current Chrome/Edge (D-050).
  - **Q11:** the owner provides SSMS script dumps in the current format: a current 2026 dump by ~31 Oct, then the rehearsal dumps and the final dump on 31 Dec.
- **Still open:** Q7 (printer models and paper), to be found during the hardware spike.
- **Status:** Accepted

### D-053 Payment pad, quick cash inside the Cash popup, and clickable popup buttons (2026-10-17)
- **Context:** owner review of the clickable POS prototype (published as a private artifact, "Tijara POS Prototype").
- **Decision:**
  - **Payment pad** under the bill total: Cash (F9), Bank / Raast, JazzCash, Easypaisa, Card, On account (credit customers only), Split payment (Shift+F9). See POS-17.
  - **Quick cash lives inside the Cash popup**, not on the main screen: *Exact* plus the next three round amounts, each showing its change. One click finalizes.
  - **Payment popups show the amount large:** green for money in, orange for refunds. The change is shown large in the Cash popup.
  - **Every popup has a button bar**, *Cancel (Esc)* plus a main button named after its action, so every keyboard action can also be done with the mouse (POS-03).
- **Alternatives:**
  - **Quick-cash buttons on the main screen:** one click faster, but rejected. The amounts change with every bill, the screen gets busier, and a misclick would finalize a bill (which then needs a manager-approved void).
- **Status:** Accepted

### D-054 Windows 7 counters get the same upgrade as Windows 8 (2026-10-17)
- **Context:** the owner found that some Delux billing counters also run Windows 7. Chrome/Edge stopped updating there at version 109 (January 2023), the same situation as Windows 8 (D-052).
- **Decision:** Windows 7 counters are **upgraded to Windows 10 by 30 Nov**, together with the Windows 8 counters. The supported counter platform stays Windows 10/11 with current Chrome/Edge (D-050). Windows 7 is not supported.
- **Status:** Accepted

### D-055 Delux bill: A5 landscape with a Code 39 barcode, matching the legacy bill (2026-10-18)
- **Evidence:** a legacy bill exported to PDF from Crystal Reports. Page 210 × 148 mm (A5 landscape, half A4). It uses Windows fonts (Arial, Tahoma), a logo image and an IDAutomation **Code 39** barcode font. The PDF does not record the printer model.
- **Decision:**
  - The Delux print profile is **A5 landscape** with a **Code 39** barcode (bill number + amount due), 1 copy. This replaces the A4 / Code128 assumption in D-048 for Delux; other tenants still choose per profile.
- **Consequence:** the legacy app already prints graphics-mode output (TrueType fonts and an image) on this printer, so browser printing should be about as fast as today. Barcode scannability on this printer is already proven. The Wave 1 print test stays, now as a confirmation.
- **Still open (PRD Q7):** printer model, paper type, label printer and label size.
- **Status:** Accepted

### D-056 Business day: 04:00 date cutoff, 20:00 closing time (2026-10-21)
- **Decision:** the business-date cutoff stays at **04:00**, and a separate **closing time of 20:00** is added for the day-close reminder and auto-locking idle counters. Supersedes the "Proposed" status of D-046.
- **Why not cut off at 20:00:** the legacy data has 1,015 bills between 20:00 and 20:59 in Jul–Dec 2025 (about 5% of sales). A 20:00 cutoff would book them as the next day's sales. The cutoff must fall while the shop is closed (first sales are around 10:00).
- **Money display (same review):** bills are always whole rupees. Supplier costs accept up to 2 decimals, and averages are kept precise internally (legacy: 0 of 22,644 bill totals had decimals; 64 purchase lines did).
- **Status:** Accepted

### D-057 Accounting treatments (2026-10-21)
- **Decision:**
  - Supplier bill discounts are capitalized into inventory cost.
  - Partner expenses are drawings (equity).
  - Card settlements are moved to the bank by journal voucher until bank reconciliation exists.
- **Why:** these give an exact profit per item and a true business profit. Neither contradicts migration: legacy P&L balances are not migrated, and the partner-expense accounts have zero balance.
- **Status:** Accepted by the owner. The accountant may review them before go-live.

### D-058 Proposed technical defaults approved (2026-10-21)
- **Decision:** every decision previously marked **Proposed** is accepted:
  - **D-006:** single sales document with signed quantities.
  - **D-011:** accept completed sales, flag rule breaks.
  - **D-017:** weighted average valued in posting order.
  - **D-024:** the *Cash in transit* account design.
  - **D-036:** integer minor units, UUIDv7 IDs.
  - **D-037 to D-045:** Fastify, Drizzle, SQLite WASM + in-memory search, Postgres job queue, Caddy + WAL-G/pgBackRest, custom sync protocol, new CoA template, returns at original cost, signed QR for QR profiles.
  - **D-046:** business-day cutoff, as refined by D-056.
- **Status:** Accepted

### D-059 Two more handover exception types (2026-10-21)
- **Decision:** new exceptions on the day reconciliation:
  - **`cash_received_for_void`:** the cash desk recorded cash for a bill that was voided on the counter, so the cash must be returned or explained.
  - **`handover_amount_mismatch`:** an offline barcode scan's amount differs from the bill when it syncs.
- **Why:** both are possible cash leaks that only become visible after sync.
- **Status:** Accepted

### D-060 Requirements approved; Wave 0 starts (2026-10-21)
- **Decision:** the owner approved the documents in `docs/`. Implementation may start with **Wave 0** (foundations: repo, CI, VPS, database + RLS, auth/PIN/devices, roles, tenant setup, legacy importer).
- **Still open (do not block Wave 0):**
  - printer model and paper (PRD Q7)
  - a current 2026 legacy dump (by ~31 Oct)
  - the staff test of the prototypes
  - the optional accountant review of D-057.
- **Schedule note:** Wave 0 was planned for 12–25 Oct and starts on 21 Oct, about a week late. The release plan is unchanged: build order by criticality, go/no-go on 18 Dec.
- **Status:** Accepted

### D-061 Tenant onboarding: internal setup script in the MVP (2026-10-21)
- **Decision:** new tenants are onboarded by the platform owner with an internal, idempotent setup script (PLT-11, Wave 2). It creates the tenant, its branch and locations, the CoA template, payment methods, roles, the owner account and the print profile. Data comes in through CSV import (CAT-09).
- **Why:** Delux is created by the legacy importer, so go-live doesn't depend on this. A second shop, or any test/demo tenant, needs a repeatable setup instead of manual database work.
- **Later phases:** a self-service onboarding wizard in the back office, then self-signup with a free trial and subscription billing.
- **Status:** Accepted

### D-062 Production on the owner's Hetzner CX33 in Helsinki (2026-10-21)
- **Decision:** production runs on the owner's existing **Hetzner CX33** (4 vCPU, 8 GB RAM, 80 GB disk) in **Helsinki, Finland**. This supersedes the Singapore location in D-029; Singapore wasn't available. All conditions of D-029 still apply: off-site WAL backups, restore drills, hardening, Docker portability. Hetzner's own daily server backups are turned on as an extra layer.
- **Why it's fine:** counters sell from their local database, so distance to Karachi only makes back-office screens slightly slower. The capacity is far above what Delux needs (about 140 bills a day) and is enough for the first few dozen tenants. Vertical resize takes minutes.
- **Revisit:** before onboarding UAE tenants, as in D-029.
- **Status:** Accepted

### D-063 DevOps: GitHub Actions, `staging` → `main` branches, staging on demand, TDD for core logic (2026-10-21)
- **Decision:**
  - **CI:** GitHub Actions runs tests on every push and nightly end-to-end tests (free).
  - **Branches (option B):** the `staging` branch auto-deploys to staging. Merging `staging` → `main` releases to production, which deploys automatically only outside 10:00–20:00 Karachi time, with an emergency manual override.
  - **Docs-only changes** never deploy.
  - **Deploys:** automatic migrations, health check and auto-rollback.
  - **Staging** runs as a resource-limited copy on the same CX33, started only when testing. It moves to its own small CX23 before the pilot, for isolation.
  - **No deploy platform** on the server.
  - **TDD** for domain rules, posting, sync and RLS.
- **Alternatives considered:**
  - **Option A** (one `main` branch plus approved releases): simpler, but its approval button needs a paid GitHub plan on private repositories.
  - **Free cloud tiers / Vercel / Cloudflare for staging:** rejected. Vercel's free plan is non-commercial, these platforms can't host our worker, long-lived connections or PostgreSQL, and a staging setup unlike production proves little.
  - **Coolify / Dokploy:** rejected. They use 1–2 GB of the 8 GB server and add a web admin panel to the live server.
  - **Kamal:** possible later, if zero-downtime deploys are needed.
- **Status:** Accepted

### D-064 Observability: Sentry + Grafana Cloud via OpenTelemetry, Slack alerts, document timeline (2026-10-21)
- **Decision:**
  - **Tools:** errors in **Sentry**; logs, metrics and traces in **Grafana Cloud** (free tier), collected by a small **Grafana Alloy** agent on the server; apps instrumented with **OpenTelemetry**; uptime checks by UptimeRobot / Better Stack.
  - **Alerts:** to **Slack** (`#erp-critical` with phone notifications, `#erp-alerts`), with an email backup for critical alerts.
  - **Correlation:** every log and error carries tenant, device, user, request/trace ID and the bill number where relevant.
  - **POS:** counters keep an offline diagnostic log that's uploaded with the next sync, and a manager can send diagnostics on demand.
  - **Support:** a **"Trace a bill"** timeline in the back office (PLT-12). Runbooks for critical alerts.
  - **Privacy:** passwords, PINs, tokens and keys are never logged; customer phone numbers are masked.
- **Why:** the owner wants debugging-grade observability. Hosted tools keep the 8 GB production server free and keep working if that server fails. OpenTelemetry avoids lock-in.
- **Alternatives:**
  - **Self-hosted Grafana/Prometheus/Loki:** about 1–1.5 GB RAM on the production server, and it fails together with the server.
  - **Telegram alerts:** replaced by Slack.
- **Note:** free-tier limits (retention about 14 days, volume caps) are checked at setup. Paid tiers are only needed when there are many tenants.
- **Status:** Accepted

### D-065 Domains: app on zorbixtechnologies.com subdomains (2026-10-21)
- **Decision:**
  - **App addresses:** `pos.zorbixtechnologies.com` (POS) and `app.zorbixtechnologies.com` (back office), with `staging-pos.` / `staging-app.` for staging and an optional `status.` page. The API is served at `/api` on each origin.
  - **Marketing** uses the company site. A separate product domain is optional later, for marketing only.
- **Why:**
  - Each counter's offline data is tied to the POS origin, so the POS address must be permanent. A product domain bought now could turn out wrong, because the product name ("Tijara") is still a placeholder.
  - A separate POS origin isolates POS storage from the back office.
  - Hosting the app on the vendor's domain is a common pattern and costs nothing.
- **Alternatives:**
  - **Buy a product domain now:** rejected, the name isn't final.
  - **A single domain with path-based apps:** rejected, the POS and back office would share an origin and its storage.
- **Status:** Accepted

### D-066 UI library: shadcn/ui on Radix + Tailwind CSS (2026-10-21)
- **Decision:**
  - **Components:** **shadcn/ui** (Radix primitives, Tailwind CSS), copied into `packages/ui` and themed with the design tokens from the approved prototypes.
  - **Supporting libraries:** TanStack Table/Virtual, React Hook Form + Zod, TanStack Router/Query, i18next, Lucide, `Intl`.
  - **POS keyboard shortcuts:** our own small layer in `packages/ui`.
- **Why:**
  - We own the component code, so it can match the prototype look.
  - Radix gives accessible, keyboard-correct dialogs, menus and selects, which matters for the keyboard-first POS.
  - It's RTL-ready for Arabic/Urdu.
  - The bundle stays small, so the POS starts fast on old counter PCs.
  - Zod schemas are shared with the API.
- **Alternatives:**
  - **MUI / Ant Design:** heavy and strongly styled; harder to match the prototypes and slower on old PCs.
  - **Mantine:** good, but less control over the final look.
- **Status:** Accepted

### D-067 Light and dark themes with a switcher (2026-10-21)
- **Decision:**
  - Light and dark themes are supported everywhere through the colour tokens.
  - Switcher with Light / Dark / System: **per user** in the back office, **per counter (set by a manager, default Light)** on the POS.
  - Printed output is always light.
  - Tokens from Wave 0/1; the switcher in Wave 2 (PLT-13).
  - Per-tenant branding (logo, accent colour) is a later phase.
- **Why:**
  - The prototypes already use tokens for both themes, so the cost is near zero.
  - A per-counter POS setting avoids the theme flipping between shared users.
  - Light suits bright shop floors.
- **Status:** Accepted

### D-068 PRD approved; build start on hold (2026-10-21)
- **Decision:** the owner approves the PRD and all documents in `docs/`, including D-061 to D-067. **Building does not start yet.** Wave 0 begins only when the owner explicitly says so. This supersedes "Wave 0 starts" in D-060.
- **Schedule note:** every day of delay comes out of build time before the 1 Jan 2027 go-live. The release plan and go/no-go date (18 Dec) are unchanged for now.
- **Status:** Accepted

### D-069 Delivery process: AI-native SDLC playbook, module folders (2026-10-21)
- **Decision:**
  - Delivery follows the AI-native SDLC playbook, scaled for a solo developer ([07-DELIVERY-PROCESS.md](07-DELIVERY-PROCESS.md)).
  - **The loop:** the PRD is the MVP intent; feature specs only where needed; **one accepted `plan.md` per task before any code**; tests first for core logic; "done" only after the checks have run and been shown; Claude reviews against `REVIEW.md`, and the owner approves merges.
  - **Guardrails:** hooks (block `sql_dump/`, format/lint, no secrets, no test edits during bug fixes), skills, verifier/researcher subagents, and evals grown from real scenarios and incidents.
  - **Work is organized in module folders** (`docs/modules/<module>/` with README, optional intent/spec, `plans/`), not per task and not per file type.
- **Why:** everything about a module lives in one place, which gives Claude better context. Every change traces to requirement IDs. The plan gate and human merge approval keep a solo developer in control of AI-written code.
- **Status:** Accepted. Setup steps (07 §9) are prepared before Wave 0 code. Building is still on hold (D-068).


### D-070 Build starts: Wave 0 (2026-10-21)
- **Decision:** the owner gives the go-ahead to start building. Wave 0 starts now, task by task (issues #2–#14). Each task still needs its accepted plan before any code (D-069). This ends the hold in D-068.
- **Status:** Accepted

### D-071 Monorepo tooling (2026-10-21)
- **Decision:**
  - Node.js 24 LTS and pnpm 11 workspaces, both pinned.
  - No Turborepo for now.
  - Internal packages are used as TypeScript source; only the apps are built.
  - ESM throughout and strict TypeScript.
  - ESLint (flat config) + Prettier; Vitest with a 100% coverage threshold on `packages/domain`.
  - Lint rules enforce the boundaries: no I/O, clock or float parsing in `packages/domain`, and no `packages/posting` in the POS.
- **Why:** the smallest setup that gives one-command checks for a solo developer, and some non-negotiable rules are enforced by the linter instead of by memory.
- **Status:** Accepted (with the W0-01 plan)

### D-072 PostgreSQL driver: node-postgres (`pg`) (2026-10-21)
- **Decision:** the API, worker and tools connect to PostgreSQL with `pg` (node-postgres), through Drizzle's node-postgres driver.
- **Why:**
  - It is the most mature Node driver and supports transactions with `SET LOCAL` for RLS.
  - pg-boss (the planned job queue) uses it too, so there is one driver to learn, configure and patch.
- **Alternative:** postgres.js is faster in benchmarks, but it would be a second driver next to pg-boss, and speed isn't a constraint at about 140 bills a day.
- **Status:** Accepted (with the W0-02 plan)

### D-073 Server setup: script in git, two firewalls, key-only SSH, shared Caddy (2026-10-21)
- **Decision:**
  - The production server runs **Ubuntu 24.04 LTS**, configured by one idempotent script in git (`infra/server/bootstrap.sh`).
  - **Hetzner Cloud Firewall + ufw**, both allowing only 22/80/443.
  - **SSH:** keys only, no root login, fail2ban. SSH stays open to any IP. This replaces "SSH from allowed IPs" in architecture §9.
  - **Users:** `admin` (sudo) and `deploy` (Docker only, for GitHub Actions).
  - **One shared Caddy ("edge")** in its own compose project serves production and staging.
  - Unattended security upgrades, with reboots at 04:30 Karachi time. 2 GB swap, Docker log rotation, server clock in UTC.
- **Why:**
  - Rebuildable from git.
  - The cloud firewall covers Docker's ufw bypass.
  - The owner's IP is dynamic and GitHub Actions uses many IPs, so an IP allowlist would break deploys. Key-only SSH makes password guessing useless.
- **Revisit:** a private network (e.g. Tailscale) for SSH once there is more than one admin.
- **Status:** Accepted (with the W0-03 plan)

### D-074 No Hetzner snapshots or server backups (2026-10-21)
- **Decision:** Hetzner's paid snapshots and daily server backups are **not used**. This changes D-062, which had them as an extra layer.
- **What protects data instead:**
  - The **off-site PostgreSQL backups** (continuous WAL + daily base backup at another provider, W0-05) are the only backup layer.
  - The server itself is rebuildable from git (D-073).
- **Consequences:**
  - W0-05 must be finished and a restore drilled **before any real data** (migration rehearsal, pilot) goes onto the server.
  - Recovering from a lost server means: rebuild, run the bootstrap, deploy, then restore the database. It takes longer than restoring a Hetzner image, but loses no data.
- **Why:** owner's cost decision; the off-site backups already meet the RPO ≤ 5 min requirement.
- **Status:** Accepted

### D-075 Deploys: images over SSH, tagged by tree hash, restricted deploy key (2026-10-22)
- **Decision:**
  - Each release is three images (`api`, `worker`, `web`), built in CI and sent to the server over SSH. No container registry.
  - **Images are tagged with the git tree hash.** Production reuses the exact image staging tested.
  - The GitHub deploy key can run only `erp-deploy` (`status`, `load`, `deploy`, `rollback`).
  - **Every deploy:** migrations → start → health check → automatic rollback on failure.
  - **Migrations must be backward-compatible** with the previous release.
  - **Production deploys starting 10:00–20:00 Karachi are deferred** to scheduled runs at 22:00 and 02:00; a manual `force` is the override.
  - Staging can also deploy any branch on demand.
- **Why:**
  - No token or paid storage on GitHub's registry.
  - "What was tested is what ships."
  - A leaked deploy key can't open a shell.
  - Rollback stays safe because old code works with the new schema.
- **Status:** Accepted (with the W0-04 plan)

### D-076 Backups with pgBackRest to Backblaze B2; drills in a throwaway container (2026-10-22)
- **Decision:**
  - PostgreSQL 17.9 runs per environment in its own compose project, never on a public port.
  - **pgBackRest** handles backups:
    - continuous WAL archiving every 60 s (RPO ≈ 1 min)
    - weekly full and daily differential backups at 03:00 Karachi, kept for 30 days (point-in-time)
    - a monthly full on the 1st, kept 12 months
    - encrypted with AES-256 before upload
  - **Off-site storage: Backblaze B2 US East** (owner's choice; the account region is fixed), with versioning and 30-day retention of deleted versions. Encryption before upload means the region doesn't affect privacy.
  - The backup passphrase is generated on the server and kept offline by the owner.
  - **Restore drills run in a throwaway container**, not in staging. This changes architecture §9.
  - A canary table measures the real RPO in every drill.
  - A nightly CI check fails on stale backups.
- **Why:**
  - Meets the PRD's durability (RPO ≤ 5 min, 30 days + 12 months).
  - Production data never lands in the less protected staging.
  - Deletes by an attacker can be undone for 30 days.
- **Status:** Accepted (with the W0-05 plan)

### D-077 Backups sized for Backblaze B2's free tier, no card (2026-10-22)
- **Decision:** the owner doesn't want a payment card on the B2 account, so B2 enforces its free daily limits as hard caps (2,500 downloads, 2,500 listings, 10 GB storage). The backup setup in D-076 is changed to fit inside them:
  - WAL is archived every **5 minutes** instead of every minute. Still RPO ≤ 5 min, as the PRD requires.
  - **One repository** instead of two:
    - a full backup on the 1st of each month and a differential every night
    - 12 monthly fulls kept
    - WAL kept from the previous month's full, so restore to any moment in the last 30+ days
  - Small files are bundled, so a backup or restore makes far fewer requests.
  - The 15-minute status reads PostgreSQL and the info saved by the nightly backup, so it makes no B2 requests.
  - **At most one restore drill a day** (about 1,500 requests).
- **Why:**
  - On the first day, test restores used up the free 2,500 downloads, and B2 then also refused the reads that archiving needs.
  - Normal use is now about 500 requests a day.
- **Risk accepted:** little margin. A drill on a very busy day could pause archiving until 00:00 UTC (05:00 Karachi). Nothing is lost while the server is healthy, and the backup check alerts.
- **Revisit before go-live:** add a card with caps (cost about $0.05 a month) when real shop data arrives, or when data nears 10 GB.
- **Status:** Accepted (changes D-076)

### D-078 Database foundations: Drizzle + SQL migrations, three roles, fail-closed RLS (2026-10-22)
- **Decision:**
  - **Drizzle ORM 0.45** (stable) on `node-postgres`. Tables are defined in TypeScript, and `drizzle-kit` writes SQL migrations that are committed and reviewed. RLS, triggers, grants and functions are hand-written SQL migrations.
  - Everything lives in the schema **`erp`**.
  - **Roles:**
    - `erp_owner` owns the schema and runs migrations
    - `erp_app` (API, worker) has no `BYPASSRLS` and owns nothing
    - `postgres` only creates the roles
  - **Only the deploy's migrate step holds the owner's credentials.**
  - **Tenant context is set per transaction** (`withTenant` → `set_config(…, true)`).
  - **Every tenant table:** `FORCE` RLS with `tenant_id = erp.current_tenant_id()`, which is NULL without a context, so the table **fails closed**.
  - **Standard helpers** (`enable_tenant_rls`, `enable_sync`, `enable_audit`) add the policy, the sync trigger (`txid` = `pg_current_xact_id()`, `row_version` from one global sequence, `DELETE` refused) and the audit columns.
  - `erp.uuid_v7()` is the default ID.
  - Status columns are `text` + `CHECK`, not enums.
  - **A CI test fails the build** for a table without forced RLS.
- **Why:** isolation is enforced by PostgreSQL itself, mistakes give empty results rather than leaks, the cursor can't skip rows, and the running app can't weaken any of it.
- **Status:** Accepted (with the W0-07 plan)

### D-079 Domain core: branded integer Money and Qty, one rounding rule, largest-remainder allocation (2026-10-22)
- **Decision:**
  - **Types:**
    - `Money` is a branded safe integer in minor units.
    - `Qty` is a branded integer in thousandths.
    - Products are computed in `bigint` and range-checked.
  - **One rounding rule: half away from zero**, everywhere.
  - **Allocation:** by largest remainder, so the parts always sum exactly to the total. Ties go to the larger weight, then the earlier line.
  - **Cash rounding** to the tenant's increment returns the adjustment for the rounding account.
  - **Parsing:** decimal text is parsed exactly; too many decimals is an error.
  - **Business date** = the tenant-local date, minus one day before the cutoff hour. The time is always passed in.
  - **Errors** are `DomainError` with a stable code.
  - **Tests:** golden JSON cases per rule, plus `fast-check` property tests.
- **Why:**
  - Exact money (rule 1).
  - Returns mirror sales.
  - The POS and the API get identical results (rule 2).
  - Type errors catch amount/quantity mix-ups at compile time.
- **Status:** Accepted (with the W0-08 plan)

### D-080 Hourly off-the-hour deploy schedule; docs go through staging (2026-10-23)
- **Decision:**
  - **Deferred production deploys:** GitHub's scheduled runs are best-effort, and the 22:00 run of the first release never happened. The schedule in D-075 changes from 22:00 and 02:00 to **every hour at :17 from 20:17 to 03:17 Karachi**. Each run exits in seconds when nothing is waiting.
  - **All changes, docs included, go through `staging`.** `main` moves only by release merges (`staging` → `main`). This replaces "docs-only changes may go straight to `main`" (CLAUDE.md, D-063).
- **Why:**
  - Eight off-peak chances a night instead of two peak ones, for about 4 Actions minutes a night.
  - Docs committed straight to `main` gave it a different file tree from staging, so production rebuilt its images instead of reusing the ones staging tested (D-075).
- **Status:** Accepted (owner, 2026-10-23)

### D-081 Back-office login, sessions, permissions and the audit log (2026-10-23)
- **Decision:**
  - **Login:** shop code + username + password. A cross-tenant `tenant_directory` maps the code to the tenant and holds nothing else.
  - **Passwords:** Argon2id (`@node-rs/argon2`, OWASP parameters, stored with the hash). At least 10 characters, no composition rules.
  - **Sessions** live in the database:
    - the token travels in an HTTP-only, Secure, `SameSite=Strict` cookie on `/api`, as `<tenant id>.<token>`; only its SHA-256 is stored
    - looked up under RLS
    - 12 h absolute, 2 h idle
  - **Defences:**
    - 5 wrong passwords lock the account for 15 minutes, plus a per-IP login rate limit
    - unknown users take as long as wrong passwords
    - state-changing requests must come from our own origin
    - **a PIN never logs in to the back office**
  - **Permissions:** strings from one catalog, plus numeric limits per role, evaluated by `can()` / `effectiveLimits()` in `packages/domain`.
  - **Roles:**
    - templates (Owner, Manager, Cashier, Salesman, Purchaser, Accountant); Owner has `*`
    - roles can be scoped to a branch
    - several roles combine to the most permissive
  - **The audit log is written by database triggers** (before/after, secrets stripped), plus API events for logins. It is append-only for every role.
- **Why:**
  - Shared addresses (D-065).
  - A stolen database can't be used to log in.
  - The POS and the API decide permissions identically (rule 2).
  - Changes can't go unlogged, and history can't be rewritten (PLT-08).
- **Status:** Accepted (with the W0-09 plan)

### D-082 Device enrollment, key-based device tokens, PBKDF2 staff PIN (2026-10-23)
- **Decision** (details in `docs/modules/platform/spec.md`):
  - **Enrollment:** a one-time code (8 Crockford base32 characters, 15 minutes, single use, hashed, rate-limited) created with `admin.devices`. The device generates a non-extractable ECDSA P-256 key and proves it holds it when enrolling.
  - **Device codes** (`C01…`, `D01…`, `M01…`) are numbered per kind and never reused.
  - **The key is the only long-lived device credential.** 15-minute access tokens are issued for a signature over a single-use, 60-second server nonce. There are no refresh tokens. Revoking a device ends its tokens at once.
  - **Signatures:** ECDSA P-256 / SHA-256 in IEEE P1363 form, over canonical JSON from one shared function.
  - **Staff PIN:**
    - 4–6 digits; trivial PINs refused
    - stored as PBKDF2-HMAC-SHA256 with 600,000 iterations, so the browser can check it offline with WebCrypto
    - 5 wrong tries lock the user on that device until a manager unlocks it
    - the rules live in `packages/domain`
    - a PIN never logs in to the back office
- **Why:**
  - Nothing reusable to steal on a counter except a key that can't be extracted.
  - Offline unlock and overrides work without the server.
  - The honest limit of short PINs is accepted and documented: they give accountability, not strong authentication.
- **Status:** Accepted (with the W0-10 plan and spec)

### D-083 Tenant setup from a reviewed spec; create-if-missing; owner sets their own password (2026-10-23)
- **Decision:**
  - A tenant is described by a JSON spec in git (no secrets) and created by one idempotent command (PLT-11):
    - settings, branch, locations
    - the retail chart-of-accounts template plus the tenant's banks and wallets
    - payment methods, price tiers, tax code, expense categories, print profile
    - the six role templates and the owner account
  - **Re-running changes nothing.** It creates only what's missing, never overwrites, and reports differences as drift.
  - **Chart of accounts:** `packages/domain` checks that every system role is mapped exactly once, children share their parent's type, and parents aren't postable.
  - **Payment methods:** cash isn't mapped to an account (the posting engine routes it by role). Non-cash methods map to a bank, wallet or card-clearing account; an unmapped one is reported as needing attention. For Delux, **Raast and bank transfer start unmapped** until the owner picks the bank.
  - **Owner password:** the owner types it at a hidden prompt on the server. Generated passwords (test tenants only) force a password change, which the API enforces.
  - **Delux:** shop code `delux`, owner `fahad`. The bill header is filled in later (by the legacy importer if the dump has it, otherwise in the back office).
- **Why:**
  - Repeatable shops for testing, demos and new customers.
  - A live shop's settings never change as a side effect.
  - Nobody else sees the owner's password.
- **Status:** Accepted (with the W0-11 plan)

### D-084 Legacy staging: local only, generic parser, credentials dropped while parsing (2026-10-24)
- **Decision:**
  - The importer stages the legacy dumps in a **separate local database** (`erp_legacy` on the owner's PC), one schema per dump copy (`legacy_<label>`). Never on the server or in the app database; rebuilt on every staging run.
  - A **generic parser** stages every table in the dump with its own columns. Values are kept as the source wrote them (text), with only the encoding undone; no floating point.
  - **Credential columns are dropped while parsing** (by name), and a CNIC-shaped value in any other column stops the run, naming only the column. Reviewed exceptions go in a committed column list (names only).
  - **Counts must agree** three ways (rows staged, rows parsed, a separate line scan), or the run fails.
  - Reports hold counts and column names only and stay out of git. Claude runs the importer and reads its reports, never the staged rows.
- **Why:**
  - The dump holds customer and staff personal data and legacy passwords (CLAUDE.md rule 11).
  - Separate copies allow comparing the Dec 2025 and 2026 dumps.
  - A count proof that doesn't depend on the parser.
- **Status:** Accepted (with the W0-12 plan)

### D-085 Legacy masters: tested mapping rules, a reviewed mapping file, idempotent load; no credit limit by default (2026-10-24)
- **Decision:**
  - Migration `0006` adds the catalog and party tables (data model §3, §4) with forced RLS, sync and audit.
  - Every legacy mapping rule (migration doc §3) is a pure, golden-tested function in `tools/legacy-import`.
  - The owner's decisions are kept in a reviewed mapping file in git (codes and catalog words only, never personal data) and re-applied on every run. Nothing is auto-deleted or auto-merged.
  - The load upserts by legacy key with `legacy jsonb` on every row, one transaction per entity group, as the app role inside `withTenant`. A re-run never duplicates; rows missing from a newer dump are reported, not deleted.
  - Until the rehearsals, the load target is a local dev database only.
  - Mechanic = Retail −5%, Wholesale = Retail −10%, rounded to Rs 1 (PRD Q1); floors follow the category rule cost + 5% (PRD Q2).
  - **Customers' `credit_limit` empty = no limit.** Migrated credit customers start without a limit; the review report lists them so the owner sets limits before go-live. The offline daily cap still applies.
  - Cleanup reports mask phone numbers; Claude reads only the summary and catalog reports.
- **Why:**
  - The legacy data needs many judgement calls; tested rules and a reviewed decision file make them visible and repeatable through the final run.
  - Credit customers keep buying on credit from day one.
  - Party contacts stay on the owner's PC until the real migration.
- **Status:** Accepted (with the W0-13 plan)

### D-086 Observability on free plans: Grafana sends the Slack alerts and runs the uptime checks (2026-10-24)
- **Decision:** (amends D-064)
  - **Uptime checks: Grafana Cloud Synthetic Monitoring** instead of UptimeRobot / Better Stack: HTTPS checks of the production app and POS health with certificate expiry, every 5 minutes from two places (about 35k of the free 100k checks a month). Staging isn't checked (amended 2026-10-25: its deploys health-check themselves, and nobody depends on it being up).
  - **Slack alerts come from Grafana alerting** (free), to `#erp-critical` (with an email copy) and `#erp-alerts`. Sentry's free plan alerts by email only; its Slack integration needs a paid plan.
  - **Sentry:** two projects (`erp-server`, `erp-web`) tagged by app, env, release and request ID. **EU regions** for Sentry and Grafana Cloud, next to the server in Helsinki.
  - Grafana Alloy reads Docker's log files and gets **no Docker socket**.
  - Secrets (Grafana token, Sentry DSNs) are typed by the owner at a hidden prompt on the server.
- **Why:**
  - UptimeRobot's free plan is non-commercial only and has no SSL monitoring.
  - Everything stays on free plans with no card (D-087).
  - The Docker socket would give the agent root on the server.
- **Status:** Accepted (with the W0-06 plan)

### D-087 No paid services (2026-10-24)
- **Decision:** the owner will not pay for any service. Every tool stays on a free plan, with no card on file.
  - **Backblaze B2 stays on the free tier for good:** the "add a card before go-live" note in D-077 is dropped. Restore drills stay at one a day. If backups near the free 10 GB, retention is reduced (fewer monthly fulls) rather than paying.
  - New tools are proposed only with their free-plan limits stated.
- **Why:** the owner's instruction.
- **Risk accepted:** an emergency restore on a day the B2 download cap is already used up waits until 05:00 Karachi, unless a recent backup has been copied off B2 beforehand.
- **Status:** Accepted (changes D-077)

### D-089 POS shell: SQLite on OPFS, blocking storage checks, column-listed pull, temporary PINs changed at the counter (2026-10-25)
- **Decision:**
  - The counter's database is **SQLite WASM in a dedicated worker on OPFS (`opfs-sahpool`)**, changed only by numbered in-place migrations; a rebuild from the server is refused while the outbox has rows (confirms D-039, D-010).
  - **Storage checks block selling:** persistent storage, a readable database, a known schema and a readable outbox, each with a stop screen.
  - **Pull** is one call for several datasets with one opaque cursor (architecture §5.3), and **every dataset lists the columns that may leave the server**; `password_hash` and other private columns never do. Specified in `docs/modules/sync/spec.md`.
  - **PINs:** a manager sets a **temporary PIN** in the back office; the person chooses their own at the counter on first unlock (online), so salesmen need no back-office login and only they know their PIN.
  - **Unlock** from a list of staff names (or the short code); 5 wrong PINs lock the user on that counter; **auto-lock after 3 minutes** idle and at closing time, not after each bill.
  - A minimal back office arrives with it: sign in, password change, Staff PINs, Counters.
- **Why:**
  - Unsynced bills must survive any app update or browser clean-up (CLAUDE.md rules 6, 9).
  - `SELECT *` would have sent password hashes to every counter.
  - Bills are credited to whoever unlocked the counter, so PINs must stay private.
- **Status:** Accepted (with the W1-02 plan)

### D-090 Wave 1 task list and a smaller pilot on 1 Dec (2026-10-26)
- **Decision:**
  - Wave 1 is the 20 tasks in [WAVE-1-TASKS.md](WAVE-1-TASKS.md), one GitHub issue each; each plan is still written and accepted when its task starts (D-069).
  - Staff and user admin is its own task (W1-04); the design pass (Tijara POS look, shared UI building blocks) is part of W1-03 and W1-04.
  - **The shadow pilot keeps 1 Dec** with a smaller scope: the counter sale end to end, sync, posting, cash desk handover, hold and void, opening balances. Cash desk close (W1-11) joins during the pilot; the remaining tasks follow by go-live criticality.
- **Why:** the full Wave 1 list is about 56 working days and the window about 20 (D-033 accepted this risk). Starting the pilot on time with the counter sale finds real problems earliest.
- **Status:** Accepted

### D-091 Staff and user admin: Owner manages people, managers give PINs, no one outranks themselves (2026-10-26)
- **Decision:**
  - **People are managed with `admin.users`** (Owner by template): add, edit, roles per branch, back-office password, deactivate. **Temporary PINs stay with `admin.devices`** (Manager and Owner, D-089). One *Staff* screen; actions follow the permissions.
  - **Nobody gives, removes or changes what they don't hold:** a role only by someone holding all of it in its branch (`canGrantRole` in `packages/domain`, a `*` role needs `*`); a person's password, status or details only by someone who could give all their roles. **A temporary PIN** goes to anyone from someone with `admin.devices`, except to a person holding `admin.users` or `*` whom they don't outrank (`canGivePinTo`): otherwise a manager could take over the Owner's PIN on the counters.
  - **Nobody locks the shop out:** no deactivating yourself, removing your own password or your own `admin.users`; an active Owner who can sign in always remains. Owner-affecting changes are serialized by a per-tenant advisory lock.
  - **Back-office password is optional**; giving or resetting one means a temporary password the person must change at sign-in (as D-083), and ends their sessions. **People are deactivated, never deleted.**
  - **Manager unlock on the counter, offline:** the manager's own PIN and `admin.devices` for the branch. A new temporary PIN clears a lock on every counter at its next pull; a pull that removes the person selling locks the counter. Locks and unlocks are kept on the counter (`pin_events`) for the audit log, pushed with W1-07.
  - **Back-office layout** from the Tijara Goods Receipt prototype: top bar, a side menu showing only screens that exist and are permitted, hash addresses (`#/staff/<id>`).
- **Why:**
  - PRD §4: managers run the floor; who works here and with which rights is the owner's (owner answer 1).
  - Without the "outranks" rule, anyone with user admin could reset the Owner's password and take over.
  - Without the last-Owner guard, one click would need platform support (D-083) to undo.
  - Locks hurt most when the internet is down, so the unlock works offline; the owner still has a remote path.
- **Status:** Accepted (with the W1-04 plan, owner answers 1–4)

### D-092 Bill building: list price as the floor until costs arrive, approvals by the approver's own PIN, the open bill kept per person (2026-10-27)
- **Decision:**
  - **Prices** (POS-04, D-004): down to the role limit and the floor needs nobody; past the seller's limit needs `pos.override.approve` with an own limit that covers the discount; below the floor, or an item with no list price, needs `pos.price.below_floor`. Compared as line totals after each line's share of the bill discount. A price **above list** is allowed and shown with a chip.
  - **An item without a known floor uses its list price as the floor** (all imported items until costs arrive). The server sends each item's effective floor from W1-14.
  - **Approvals on the same screen** (PLT-07): the approver's own PIN, checked offline; wrong PINs count towards their own lock. **The seller may approve their own price** when they hold the permission, still with their PIN and a reason. An approval keeps what it approved and stops holding when the price goes lower, the tier changes, or (for a bill discount) a line changes.
  - **Reasons are a fixed list** for now (customer bargain, old or slow stock, matching a market price, regular customer, other with a note), with stable codes a later tenant table can adopt.
  - **The open bill is kept on the counter per person** (local schema 4), saved after every change, never pushed.
  - **Keys:** the prototype's map, with `F7` for the price tier and `D` for a bill discount; `F6` and `Alt+D` are not used (Chrome keeps them).
- **Why:**
  - Without a floor, the Salesman limit (100%) would let any price through with nobody approving.
  - Every below-floor sale gets a reason, including a manager's own (RPT-10).
  - A lock or a reload must never lose a half-built bill (POS spec §6).
- **Status:** Accepted (with the W1-05 plan, owner answers 1–4)

### D-093 Finalize and print: one rounded total, number taken in the saving transaction, A5 bill with Code 39, reprint without a PIN (2026-10-27)
- **Decision:**
  - **Cash rounding applies to the bill total for every tender** (POS-15, Q5): Delux rounds to Rs 1, the difference is the document's `rounding`, and every payment is a multiple of the increment.
  - **Payment pad** as in the prototype (D-053), with tender rules in `packages/domain`. Pay is refused while a price still needs an approval. Quick cash: the next multiples of Rs 500, 1,000, 5,000 and 10,000 above the total, the three smallest, topped up with multiples of Rs 5,000.
  - **The number is taken in the same local transaction** that saves the document and its outbox row and removes the open bill; print comes after the commit. The sale document's shape (`SaleDocumentV1`) is fixed now for W1-07.
  - **Printing:** an HTML bill to the default printer with `--kiosk-printing`; **A5 landscape stays the Delux default** (A4 is built too); the bill code is Code 39 of the bill number and the cash due. **Thermal templates and the signed QR wait until a tenant needs them.**
  - **Reprint** (`Alt+P`): anyone unlocked, no PIN, marked REPRINT and logged for the audit log.
  - **W1-01 follows W1-06:** the shop test prints real bills from a staging counter.
- **Why:**
  - One total on screen, on paper, in the bill code and in every payment.
  - A number taken only when the bill is saved can't leave a gap (POS-13, rule 6).
  - The Delux printer is a laser (HP LaserJet P1005), its bills print at the cash counter and its scanners read Code 39, so a signed QR adds nothing there yet (D-048).
  - A jammed shared printer must not stop the shop; a reprinted barcode can't collect cash twice because a handover is unique per bill.
- **Status:** Accepted (with the W1-06 plan, owner answers 1–4)

### D-094 Push sync: accept and flag, a counter pushes its own bills, restores heal themselves, SSE nudge, health on both sides (2026-10-28)
- **Decision:**
  - **Push** (`POST /api/sync/push`) sends up to 100 documents in sequence order with the counter's audit events and health; each document in its own transaction. An empty push is the start-up handshake. The contract is in the [sync spec](modules/sync/spec.md) §6.2.
  - **Refused only when a document can't be trusted or stored:** unsigned, a bad signature, a malformed payload, an id or number already taken by another document, a reference that isn't the tenant's, another device's document. **Everything else is accepted** and re-checked with `reviewSale` in `packages/domain`; what looks wrong becomes an exception: below the floor or past a limit without a covering approval, **figures that don't add up (accepted and flagged, owner answer 2)**, clock skew, made while revoked, a sequence gap.
  - **A counter pushes only its own documents,** verified with its own key. Re-enrolling a PC as a new counter while carrying its old bills is not built.
  - **Refused bills wait on the counter under *Needs attention*;** a manager's own PIN (`admin.devices`) sends one again (owner answer 4). Anyone may open the counter's health page (`Alt+S`).
  - **Gaps and restores heal themselves:** every answer lists each series' `through` and missing ranges, and the counter puts back what the server lacks from its 30-day copy.
  - **A revoked counter is told so** (`device_revoked`), stops selling and keeps its bills; **Re-enable** in the back office brings it back, and documents made in between are flagged (owner answer 3).
  - **SSE nudge:** `pg_notify` from every pulled table, one `LISTEN` connection in the API, `changes-available` at most every 2 s per tenant; the counter pulls on it and polls every 5 minutes while it is up. Caddy passes the stream unbuffered.
  - **Offline warnings** after 8 and 48 hours without reaching the server, per tenant, never blocking a sale (owner answer 1).
  - **Device health** on the counter and, for every counter, on the back office's Counters list; the SSE nudge and the Counters columns both stay in this task (owner answer 5).
- **Why:**
  - A completed sale is a fact (SYN-03, D-011): refusing one the counter computed wrongly would hide it; flagging it keeps it in the books and on the exceptions report.
  - Verifying with the pushing device's own key keeps the trust model simple until a PC must carry another counter's bills.
  - A restore must not lose the bills made after its point (SYN-05); the counters already hold them, so they put them back without anyone asking.
  - The owner and managers should see a sick counter before the day's reconciliation does.
- **Status:** Accepted (with the W1-07 plan, owner answers 1–5)

### D-095 Posting engine: posted in the accepting transaction, an order of record, suspense for bills that don't add up, Raast and bank transfer on HBL (2026-10-31)
- **Decision:**
  - **One pure engine** (`postSale` in `packages/posting`) posts live and in the rebuild; the database layer only loads and writes. Every accepted sale is posted **in the transaction that accepts it**, under a savepoint ([accounting spec](modules/accounting/spec.md)).
  - **A sale that can't be posted is still accepted** (SYN-03), with one `posting_failed` exception; the worker's catch-up posts it every minute until it works. The push answer to the counter doesn't change.
  - **Order of record:** a per-tenant lock (`posting_state`) runs a tenant's postings one at a time; `postings` keeps each one's sequence and **the settings it used** (accounts by role and by method, lock date, terms). The rebuild check replays that in memory from one snapshot; the rewrite is owner-only and refused on a locked period.
  - **Raast and bank transfer post to HBL** (owner answer 1). The tenant setup now applies a payment method's bank account from the spec (audited), so moving to another bank is a spec edit and a re-run; bills already posted stay where they were.
  - **An item sold before its cost is known posts at cost 0** and is flagged `no_cost` (owner answer 2).
  - **A bill whose figures don't add up is posted, with the difference on 1190 *Posting suspense*** (`SUSPENSE` role, owner answer 3).
  - **Negative stock** is flagged once, when a location's balance crosses below zero; never blocked (INV-03).
  - **A line's cost lives on its stock movement**; `sales_lines.unit_cost` is dropped (rule 3). Lines record their tax code (the item's or the tenant's default, `tax_codes.is_default`).
  - **No screens in W1-08** (owner answer 4): the check result and a trial balance are recorded in the plan; reports come with W1-18 and W1-20.
- **Why:**
  - Live and rebuilt ledgers can't disagree when they come from the same function and the same recorded settings.
  - A completed sale is a fact: a configuration gap or a bug must hold back its posting, never the sale or the counter.
  - Suspense keeps stock and cash right and leaves only the difference for the accountant; cost 0 matches how the migration treats items without a cost.
- **Status:** Accepted (with the W1-08 plan, owner answers 1–4)

### D-096 Customers and credit on the counter: three pulled datasets, the limit against balance plus unsynced, a per-counter offline cap, flagged on the server (2026-10-31)
- **Decision:**
  - **The counter pulls `customers`, `customer_accounts` and `customer_balances`** with only the columns selling needs (name, code, phones, city, tier, credit terms, balance); addresses, tax numbers, notes and payment terms stay on the server. A party that gets a customer account later is re-sent (a trigger touches its row). Phones are shown by their last four digits (owner answer 4) and never logged.
  - **Choosing a customer sets the bill's tier**; back to walk-in returns to the default tier (owner answer 3). A walk-in may leave a phone, stored normalized (`normalizePhone`).
  - **The limit** is checked against the pulled balance plus this counter's on-account bills the balance can't include yet (in the outbox, or accepted after the last complete pull started). Exactly at the limit is allowed; no limit (null, D-085) is never over.
  - **The offline daily cap** counts this counter's on-account sales to the customer **made while offline on the business day**, plus the bill (owner answer 1). Online, only the limit applies.
  - **Over either needs an approver's own PIN** with `pos.credit.over_limit` and a reason (*Customer will pay soon, Regular customer, Owner's instruction, Other*, owner answer 2), taken at finalize for that amount and recorded as a `credit_limit` or `offline_cap` override.
  - **The sale document stays v1** with additive, optional fields: the customer, the walk-in phone, the credit overrides and a `credit` block with the counter's view. Bills already in outboxes still parse.
  - **The server re-checks every on-account sale** with `reviewCredit` and its own balance (all counters), and flags `credit_limit_exceeded` or `offline_cap_exceeded`; it never refuses one (D-011, owner answer 6).
  - **Credit terms come from the legacy mapping file** (`partyCredit`) and the importer re-run until a back-office customer screen exists (owner answer 5).
- **Why:**
  - Credit sales must work offline (D-013) without letting one customer run up a debt no one approved.
  - Counters can't see each other offline, so the cap is per counter and the server, which sees all of them, is where a combined breach is found.
  - A customer's contacts are personal data: the counter keeps only what it needs to find them.
- **Status:** Accepted (with the W1-09 plan, owner answers 1–6)

### D-097 Cash desk 1: a desk is the POS app, the queue is pulled and nudged per branch, handovers are desk documents linked by bill number (2026-11-01)
- **Decision:**
  - **The cash desk is the POS app on a `cash_desk` device:** someone with `cash.handover.receive` lands on the Cash desk screen, `Alt+Q` switches to selling and back (the desk also sells, D-001).
  - **A session** opens with a float (`Z` document, posts nothing) and belongs to its cashier; only they take cash. **It closes without a count** in W1-10, by anyone with `cash.session.close`, showing the expected cash; the denomination close comes with W1-11 (owner answer 1).
  - **The queue is a pulled dataset**, `cash_queue` (the branch's bills with cash due, pending or of 7 days, no lines or customer), sent only to cash desks; **`queue-changed`** goes on its own channel to the branch's desks only, so counters aren't woken by every bill.
  - **Enter confirms the selected bill as shown; `E` corrects** the cash received first. The correction is kept on the handover, never on the bill.
  - **A scan selects a queued bill; a bill not in the queue is recorded from its code after Enter** (owner answer 2), with no sale id, and the server links it when the bill arrives.
  - **Refund payouts are built now** (`kind: payout`, `cash.refund.pay`), first used with returns in W1-13 (owner answer 3).
  - **A cash sale on the desk is handed over automatically** to the open session in the same local transaction; with no session it waits in the queue (owner answer 4).
  - **Handovers (`H`) are desk documents**, local-first like bills, matched to the bill **by number**: the server never refuses one for its bill (it waits for it), flags a different amount (`handover_amount_mismatch`), keeps a second one as `duplicate_handover` (never posted) and flags a cashier without the permission (`handover_not_permitted`). A bill's cash and its handovers are judged under a per-bill lock.
  - **Each handover posts `Dr CASH_DRAWER / Cr CASH_IN_TRANSIT`** (a payout the reverse) for its own amount, so the order it arrives in against its bill doesn't matter.
- **Why:**
  - One app keeps one local database, one outbox and one push for a PC that both sells and takes cash.
  - Pulling the queue reuses the change feed (rule 8) and works the same online and after a reconnect; a per-branch nudge meets the 5-second target without waking every counter.
  - Matching by bill number is what makes an offline scan work before the counter syncs; linking later, and posting the handover's own amount, keeps the books right whichever arrives first.
  - A stray scan must not record cash that can't be taken back: documents are immutable (rule 3).
- **Status:** Accepted (with the W1-10 plan, owner answers 1–4)

### D-098 Cash desk 2: collections and cash-outs are desk documents, the close is a blind count with the safe, the day is reconciled on request (2026-11-02)
- **Decision:**
  - **A collection (`R`) and a cash-out (`M`) are desk documents** like a handover: local-first, in the desk's outbox, pushed only by a cash desk, reviewed and never refused (rule 7). A collection is any active method except on account, with its reference; paying more than the balance is kept as an advance. A cash-out is an expense (by category), a supplier payment, a bank deposit, or a move **to or from the safe**; one above the expected cash asks for a second Enter.
  - **Each desk family has its own table:** collections in `payments` (direction `in`; the back office's receipts and payments join it later), every cash movement in `cash_movements`, **supplier payments included** (data model §6 had them in `payments`). The supplier ledger reads `party_ledger_entries`.
  - **The close is a blind count by denomination** (owner answer 2): the expected cash shows only after the count, on the desk and in its session bar. A variance needs a reason and **a manager's PIN, or *Acknowledge later*** in the back office (owner answer 1); never the session's own cashier. The server keeps an acknowledgement only when it allows it. **The variance posts when the close arrives**, acknowledged or not.
  - **What doesn't stay in the drawer goes to the safe with the close** (owner answer 3): the close carries what stays, and posts the rest `Dr CASH_SAFE / Cr CASH_DRAWER`; **1130 Cash in safe gets the `CASH_SAFE` role**. The next open's float is filled in with what stayed; a different float posts the difference to `CASH_SHORT_OVER` and is flagged `float_mismatch`. So 1110 equals the cash in the drawer after every count.
  - **`CashSessionV2`** carries the count; push still takes W1-10's `CashSessionV1` closes, as *not counted*.
  - **The day reconciliation is computed on request** (`reconcileDay`), never stored: *Final* only when the day is over, every active device has been heard from since with nothing older unsynced, no gap is open and no session of the day is open. With handover confirmation Required it lists the cash bills never handed over by salesman. The missing handovers are not raised as exceptions: the bills and handovers already say it.
  - **A desk pulls four more datasets** (`suppliers`, `supplier_balances`, `expense_categories`, `bank_accounts`), never their GL accounts or a supplier's contacts.
  - **Customer ageing at the desk waits for W1-20** (owner answer 4); the desk shows the balance and the last collection.
- **Why:**
  - One trust path for every desk document; a cashier's record is kept and judged on the server (D-011).
  - Seeing the target while counting nudges the count towards it.
  - Without the safe, the drawer's account would drift from the drawer every time the cash left it at night.
  - A report computed from the documents can't go stale when a counter syncs late.
- **Status:** Accepted (with the W1-11 plan, owner answers 1–5)

### D-099 Hold and void: held bills stay on the counter per person, a void is its own document of family V, never after the handover (2026-11-03)
- **Decision:**
  - **A held bill is the open bill set aside on its counter** (`held_bills`), with an optional label, recalled only by the person who held it, at most 20 per counter, gone once its business day is over (04:00, owner answer 4). Never pushed.
  - **A void is a signed document of its own, family `V`** (`C03-V000001`, `SaleVoidV1`), in the outbox like every document; the bill is never changed (rule 3), keeps its number and prints again with a VOID band. A family of its own keeps the bill series gapless and gives the void the same push, idempotency and gap handling as every family. **`V` joins the families** of architecture §4.4.
  - **A bill is voided only on the device that made it** (owner answer 2), on its business day, with the PIN of someone holding `pos.void` and a reason (owner answer 5).
  - **Never after the cash handover, for any role** (owner answer 1, as D-002 and posting rules §4.4 say): after it, a return (W1-13). The Manager and Owner templates move from `same_day` to `same_day_before_handover`, and migration 0013 moves every role with `same_day`; the value stays valid and is judged the same. A desk's own cash bill is handed over at once, so it is corrected with a return.
  - **Before a void, the counter asks the server** whether the desk has the cash (`GET /api/sync/bills/status`, 3 s); offline it goes on with a warning. The server stores every void (rule 7) and flags `void_not_permitted`, `duplicate_void` and, for cash in the drawer for a voided bill, `cash_received_for_void` with which came first (D-059).
  - **The void's reversal swaps the sale's own posting** (source `sales_void`), and posts only once the bill has.
  - **A reissue is a new sale** with `reissueOf`, starting from the voided bill's customer, lines, prices and price approvals (owner answer 3).
- **Why:**
  - A printed, signed bill can't be edited, and a void decided offline must be a fact the server can't refuse.
  - Voiding after the cash reached the drawer would need the cash paid back at the desk; a return already does that properly.
  - The live check catches most leaks at the counter; the server catches the rest.
- **Status:** Accepted (with the W1-12 plan, owner answers 1–5)


### D-100 Return and exchange: one document of signed lines (V2 only for returns), refunds that add up, no legacy bills (2026-11-03)
- **Decision:**
  - **A return or exchange is an `S` document with negative lines** (D-006), written as **`SaleDocumentV2`** only when the bill has returned lines; a plain sale stays `SaleDocumentV1`, and push takes both. `kind` is derived: `return`, or `exchange` with sold lines too.
  - **One original bill per return** (owner answer 2); the return keeps that bill's customer. Replacement items follow every sale rule; a bill discount is on the sold lines only.
  - **A line returned in parts adds up to what was paid:** the refund for `k` of the `r` units left is the value left × `k` / `r`, half away from zero, and all that is left refunds exactly what is left (`refundFor`).
  - **The policy** (`returnNeeds`): the tenant's `return_window_days` (30), or the category's own window; non-returnable categories; approvals `return_permission`, `return_outside_policy`, `no_receipt_return`, one approver's own PIN covering them all, with the reasons *Regular customer, Manufacturer defect, Lost bill, Bought before go-live, Owner's instruction, Other* (owner answer 3).
  - **No receipt:** the counter suggests the lowest net price of the branch's last 90 days, else today's default-tier price; **the approver may set the price**, and the override keeps both. Cost back at the current average.
  - **Refunds:** cash at the desk (a payout in its queue, W1-10), credit to a customer's account (not counted as unsynced credit until the balance has it), or **by transfer** with a reference and the PIN of someone with `pos.override.approve` (override `refund_transfer`, owner answer 1); an even exchange takes no payment.
  - **No legacy bills** (owner answer 4): MIG-03 is dropped, and **D-030 is superseded in that part** (the masters and opening balances stay). A part bought before go-live is a no-receipt return; the manager checks the old bill in the read-only legacy system and sets the price; its number goes in the return's reference.
  - **Every counter pulls the branch's last 90 days of bills** (`bills`, `bill_lines`, `bill_payments`, SYN-01), pruned past 90 days; the pulled return lines say what came back already, so nothing is derived for it.
  - **The server never refuses a return** (rule 7): it judges it under the original bill's per-bill lock and flags `return_over_quantity`, `return_original_invalid`, `return_price_mismatch`, `return_not_permitted`. Stock comes back at the original line's cost (D-044), into Damaged for a defective line; a return posts only once its original has.
- **Why:**
  - One document keeps one number, one print and one cash movement for an exchange, and V2 only for returns keeps the pilot's sales untouched.
  - Refunding the share of what is left never drifts by a paisa, however a line comes back.
  - The legacy bills would have put a second kind of original through the lookup, the quantities, the review, the posting and the print, plus an importer step, for about a month's benefit.
- **Trade-off:** for about the first month after go-live, returns of pre-go-live parts need a manager's PIN, and nothing stops the same old part coming back twice beyond the manager's check of the legacy system.
- **Status:** Accepted (with the W1-13 plan, owner answers 1–5)


### D-101 Opening balances: a posted document, reconciled from the ledgers, the floor from cost on the counter, a throwaway pilot wiped before go-live (2026-11-04)
- **Decision:**
  - **The opening is a document** (`opening_balances` and its lines, migration 0015) posted by `postOpening` (source `opening`) like any other, so the ledgers stay rebuildable (rule 4): stock into Shop at the legacy cost (the latest valuation rate, else the cost price, else the opening rate, else none and `no_cost`), one AR or AP line and party entry per customer or supplier due on the entry date, the counted drawer and the bank statements, the balance to Opening balance equity (posting rules §7). The importer writes a **draft**, replaces it on a re-run, and posts it once (`pnpm legacy:opening … --post`); a posted opening is never changed (a trigger).
  - **The legacy figures are pure, golden-tested rules** (`tools/legacy-import/src/transform/opening.ts`); **which legacy document types add or take away stock is in the mapping file**, and an unmapped type stops the run after its report.
  - **The reconciliation report** (MIG-04) reads the tenant's own ledgers after posting, compares them with the legacy computation, the legacy running balance and the four legacy report totals the owner types in (owner answer 4), and lists the top 20 customers and suppliers for sign-off.
  - **The floor from cost** (CAT-06, D-092): `costFloor` = average × (1 + the category's margin), half away from zero, written by the posting layer as the synced `item_floors` whenever an average is set, and pulled by the counters. The counter's floor is the item's own floor, else this, else the list price.
  - **The pilot is throwaway** (owner answer 1): no cutover posting. Before the final run, `erp-tenant wipe-pilot` removes the shop's documents and everything derived from them (as erp_owner, one transaction, audited), keeps masters, staff, PINs and settings, and revokes the counters, which are cleared and enrolled again. **This is the one exception to rules 3 and 4, for pre-go-live data only:** refused while a counter has unsynced bills (rule 9) and once `erp-tenant go-live` has marked the shop live and set the lock date.
  - **Real data on production for the pilot** (owner answer 3): masters before 1 Dec and the pilot opening when its dump arrives, loaded from the owner's PC over an SSH tunnel as the app role. The task is built and rehearsed on the Dec 2025 copy (owner answer 2).
- **Why:**
  - An opening written straight into the ledgers would show up as a difference in every rebuild check.
  - A floor that moves with the average needs its own change feed (rule 8), and the item's own floor must still win.
  - The pilot's sales are already in legacy; netting them in the books would add a posting type, used once, for nothing the shop keeps.
- **Trade-off:** the wipe deletes finalized documents (rules 3 and 4) once, before go-live; and a part bought during the pilot comes back in January as a no-receipt return, like any pre-go-live part (D-100).
- **Status:** Accepted (with the W1-14 plan, owner answers 1–5)

### D-102 Opening stock from the legacy stock records, physical counts from the count sheet (2026-11-05)
- **Decision:** the opening's closing stock per item = `INV_Item.OpeningQuantity` ± the `INV_StockRecordTAB` rows up to the cutoff (their own `Quantity`, signed by document type in `opening.docTypes`), except physical-stock counts, which come from the count sheet's lines (`INV_PhysicalStockDetail.Quantity`, signed: a shortage is negative). Sale and purchase document lines are no longer summed; they still give the last purchase and the recent-sales report. The importer compares every item with the legacy Item Wise Closing Stock report when `out/<label>/legacy-closing.csv` (item, qty) is given, and reports each period and stock table's date range (`periods.csv`).
- **Why:** rehearsal 2 (2026 dump, 1 Jul to 5 Nov, against the owner's report as on 5 Nov 2026): this rule matches **all 20,163 items and the total of 45,224.5 units**. Summing the document lines gave 130,334.5 units, because legacy stores sale-line quantities negative; the stock records alone missed 45 items, because their physical-stock rows lose a shortage's sign.
- **Trade-off:** the opening now depends on legacy keeping a stock record for every stock document. The per-item comparison with the legacy report on each dump day is what proves that, so it is part of every rehearsal and the final run.
- **Status:** Accepted (owner, 2026-11-05). Replaces the quantity rule of D-101 and migration doc §4.1.

### D-103 Opening cost: valuation rate, else last purchase, else opening rate below Retail, else cost price (2026-11-05)
- **Decision:** an item's opening unit cost = the latest `INV_StockRecordTAB.ValuationRate` on or before the cutoff; else the last purchase rate in the period; else `INV_Item.OpeningRate` (legacy's carried-forward average), unless it is above the item's Retail price; else `INV_Item.CostPrice`; else the opening rate even above Retail; else none (`no_cost`). With the legacy report's Average Rate in `legacy-closing.csv`, the importer writes `cost-compare.csv`: each differing item, the legacy figure the report's rate equals (`report_zero`, `opening_rate`, `cost_price`, `last_purchase`, `unexplained`) and the value difference.
- **Why:** rehearsal 2 against the owner's Closing Stock report of 5 Nov 2026 (16,061 items in stock). The report values old stock (no 2026 purchase) at the opening rate: 863 items, where the cost price came first before. 81 items show a rate of 0 although 69 of them were bought in 2026 (LAMI001: 8 purchases at 7,500–7,800, checked with the owner); their last purchase is their cost. Two opening rates are above Retail and are typing errors (CLCD022: 8,000 against `CostPrice` 3,000 and Retail 3,950, checked with the owner). With this rule 15,976 items equal the report; the rest are those 81, the 2 typing errors and 2 items within Rs 25.
- **Trade-off:** our stock value is Rs 45.57 M against the report's Rs 45.27 M, on purpose (the 81 items the report values at 0). The owner reviews `cost-compare.csv` on each dump day.
- **Status:** Accepted (owner, 2026-11-05). Replaces the cost order of D-101 and migration doc §4.1.

### D-104 Catalog maintenance: legacy stays the master until go-live, only the owner prices, a price history (2026-11-06)
- **Decision:**
  - The back office maintains the catalog (W1-15): items, identifiers, vehicle tags, tier prices, the item's own floor and the category's floor margin, through `/api/catalog`, with the row version on every save (a stale save is refused with who saved in between). An item's code never changes; items are never deleted (dormant or discontinued).
  - **Until the shop is live (`tenants.go_live_at`, D-101), the legacy app is where items change** (owner answer 1): the importer is unchanged, the final import overwrites the catalog, and every catalog screen says so.
  - **Only the owner changes prices** (owner answer 3): `cat.price.edit` is no longer in the Manager template, and migration 0016 removes it from the Manager roles made from the template in every tenant. A manager adds an item without prices; the owner prices it.
  - **`price_history`** (migration 0016, CAT-07): every changed tier price and own floor with old → new, who, when and, when a price goes down, a reason from a fixed list (supplier price dropped, market price, slow stock, correction, other with a note; owner answer 2). Added to only.
  - A category's margin change re-writes its `item_floors` through `writeFloors` (`packages/posting`), in the same transaction.
- **Why:** one master at a time keeps the pilot simple; one person decides prices; the history answers "who changed this price and why".
- **Trade-off:** a price changed in the new back office before go-live is lost at the final import (the notice says so); managers can't fix a price without the owner.
- **Status:** Accepted (with the W1-15 plan, owner answers 1–4)

### D-105 Purchasing: receipts and returns as drafts posted once, the bill discount capitalized exactly, cash paid at the desk (2026-11-06)
- **Decision:**
  - **Goods receipts and purchase returns are typed as drafts** in the back office and **posted once** (rule 3; a trigger refuses any change after posting, the pilot wipe excepted, D-101). A draft has no number; posting takes `GR`, `PR` or `SP` + six digits from a per-tenant counter in the same transaction, so abandoned drafts leave no gap.
  - **A receipt can't be posted until its lines equal the bill total as printed** (PUR-02). The bill discount is spread over the lines' nets by largest remainder and capitalized into each line's exact value; the stock movement carries that value and the average is computed from it (`averageAfterValue`), so a rounded unit cost never shifts the books. Warnings (not blocking): a net cost more than 10 % off the last cost, Retail at or below the net cost.
  - **Cash purchases are paid by the cashier at the desk** (owner answer 1): the receipt puts the bill on the supplier's account and the desk's supplier payment (W1-11) pays it, so the drawer count stays right. A receipt can be marked paid by bank, posting the payment with it. A supplier payment by bank is its own document (`supplier_payments`, posted when made).
  - **A purchase return** goes out at the item's average; the supplier takes it back at the return's unit cost (offered from the receipt line's net cost); the difference goes to Purchase price variance (posting rules §5.2). Linked to a receipt, it can't return more than the line still has.
  - **Permissions** (owner answer 2): suppliers, receipts and returns with `pur.receive` (owner, manager, purchaser); payments by bank with `acc.payment.create` (owner, accountant). Return reasons (owner answer 3): damaged, wrong item, excess quantity, poor quality, price dispute, other with a note.
  - **Until go-live, purchases go into the legacy app** (owner answer 4); the purchasing screens say so, and anything entered here before then is removed by the pilot wipe.
- **Why:** the supplier's bill is what the shop checks against; exact values keep the stock ledger equal to the bills; one place handles cash.
- **Trade-off:** two steps for a cash purchase (receipt, then the desk), and a posted mistake is corrected by a return or a journal voucher, never an edit.
- **Owner review (2026-11-07):** a supplier is deactivated (only when nothing is owed) or, if never used anywhere, deleted (marked deleted); the forms open as dialogs; a receipt line takes the item's last purchase cost.
- **Status:** Accepted (with the W1-16 plan, owner answers 1–5)

### D-106 Item labels: the legacy 40 × 28 mm roll label, every piece of a receipt, a shop setting for the maker's barcode (2026-11-07)
- **Evidence:** the owner's photos and a legacy label PDF: a Zebra GX420t thermal-transfer printer with a roll of single 40 × 28 mm labels; on each label the shop's abbreviation (DCAC, Delux City Auto Corner) top left, the supplier's abbreviation top right, the item code as a Code 39 barcode with the code under it, and the item name on one line.
- **Decision:**
  - Labels print from the back office with the browser, one label per page of the roll, in the legacy layout. No A4 sheets (owner answer 1).
  - From a **posted goods receipt** (by its number, or its Print labels button): one label per piece received, the receipt's supplier abbreviation; an item sold in fractions gets one per line. A **relabel** of items picked on the items screen: one each, the last purchase supplier, else the default supplier. Every count and abbreviation can be changed before printing; nothing is stored about what was printed.
  - **The maker's barcode is a shop setting** ("label items that already carry the maker's barcode"). Off (a new shop's default, CAT-08), an item with a barcode other than its own code starts at 0. **Delux: on**, the shop labels every piece (owner answer 4).
  - The template (size, margin, shop abbreviation, the name, the maker's-barcode setting) lives in `tenants.settings.labels`, changed by the owner only (`admin.settings`, owner answer 5).
  - A code Code 39 can't carry is listed and not printed.
- **Why:** the shop keeps its labels and scanners as they are; another shop that relies on the maker's barcode doesn't waste labels; the browser prints the way the bill already does (D-055).
- **Trade-off:** the browser's print dialog must be set once per PC (the label printer, margins none, scale 100 %); printing straight to the Zebra without a dialog would need a local helper.
- **Status:** Accepted (with the W1-17 plan, owner answers 1–5)

### D-107 Stock operations: the storekeeper drafts, the owner or manager posts; the owner approves large losses; receiving per route (2026-11-08)
- **Context:** W1-18 (INV-04, INV-05, INV-07). Delux's Godown is in the same building as the shop; other shops keep stock elsewhere.
- **Decision:**
  - **Transfers:**
    - The purchaser/storekeeper (`inv.transfer`) types a transfer as a draft. Only the owner or the manager (`inv.transfer.post`, new) posts it (owner answer 2).
    - Each route (from → to) is either "moves at once" (the default) or "needs receiving", an owner's setting (`transfer_routes`, owner answer 4).
    - On a route that needs receiving, posting **sends** the stock into the branch's **In transit** location (new location kind `transit`, never sellable, one per branch). **Receiving** moves what arrived into the destination.
    - A shortfall becomes a loss adjustment out of In transit (reason *lost*), under the same approval rule.
  - **Adjustments:**
    - Adjustments are the owner's and the manager's (`inv.adjust`).
    - When the losses at the average come to more than the shop's limit (`tenants.settings.inventory.adjustmentApprovalLimit`, default Rs 10,000), and the poster can't approve (`inv.adjust.approve`, new, the owner only), it waits: stock and books don't move.
    - The owner approves it (it posts) or sends it back to a draft with a note. Gains never wait (owner answer 3).
  - **Postings:**
    - A transfer step moves stock at the item's average with no journal (posting rules §5.4).
    - An adjustment posts its net value against `INVENTORY_ADJUSTMENT` (§5.3). Each step is its own posting (`stock_transfer`, `stock_transfer_receipt`, `stock_adjustment`) and replays in a rebuild.
  - The adjustment reasons are the owner's list: found, lost / missing, broken / damaged, theft, count correction, write-off (damaged goods, only out of Damaged), other with a note (owner answer 1).
- **Why:**
  - A transfer is recorded when the goods move, but stock changes only on a responsible person's post.
  - A mistyped loss can't reach the books unseen.
  - A setting per route can't be picked wrongly on each transfer.
  - The same code serves a shop whose store is down the road.
- **Trade-off:**
  - Drafts can pile up unposted; the transfers list shows them first, and Transfer needed shows what that costs the Shop.
  - A route that needs receiving leaves stock invisible to both ends until it is received; the On the way list shows how long.
- **Status:** Accepted (with the W1-18 plan, owner answers 1–4)

### D-108 Back-office accounting: the accountant keeps the books, reversal is the only correction, one lock date that only the owner moves back (2026-11-08)
- **Context:** W1-19 (ACC-04, ACC-05, ACC-06, part of ACC-07). The legacy app entered customer receipts as journal vouchers and had no period lock.
- **Decision:**
  - **Who:** an Accountant login plus the owner keep the books (customer receipts, expenses and transfers by bank or the safe, journal vouchers, locking months). The manager gets no accounting; until Delux has an accountant, the owner does it (owner answer 1).
  - **Documents:** a customer receipt by bank (`CR`), an expense from a bank or the safe (`EX`) and a transfer between banks, wallets, card settlement and the safe (`FT`) post when saved. A journal voucher (`JV`) is a draft, then posted, with **no approval step** (owner answer 2).
  - **A voucher can't touch the accounts the system keeps:** `INVENTORY`, `CASH_DRAWER`, `CASH_IN_TRANSIT`. The party is required on AR/AP lines and refused elsewhere.
  - **Corrections are reversals only:** Reverse on any posted back-office money document or voucher (supplier payments by bank included) writes a journal voucher that swaps its journal and reverses its party entries, at most once.
  - **Fees on transfers:** a transfer takes optional charges with an expense category, so a card settlement or a bank fee posts in one entry (owner answer 6; replaces D-057 point 3).
  - **Periods** are computed from `fiscal_year_start_month`, not stored; `tenants.lock_date` is the only record. The accountant or the owner moves it forward to the end of a month that is over, after a checklist of what still looks open; **only the owner moves it back**, with a reason, audited (`acc.period.reopen`, owner answer 5). The first lock fixes the start month (D-035).
  - **Back-office documents dated on or before the lock date are refused** (purchasing and stock included); counter documents still post on the first open date (posting rules §1.6).
  - **Account balances and the account ledger** come now, for the owner and the accountant (owner answer 3); the other financial reports stay in Wave 2.
  - **The accountant adds accounts and expense categories** (`acc.chart.edit`); banks and wallets stay a setup job (owner answer 4).
- **Why:** each kind of money movement posts the same way every time; the books, the stock ledger and the drawer can't drift apart through a voucher; a closed month stays closed unless the owner says otherwise.
- **Trade-off:** a typing mistake costs a reversal and a new entry instead of an edit; a voucher needs no second pair of eyes, so the owner relies on the list and the audit log.
- **Status:** Accepted (with the W1-19 plan, owner answers 1–6)

### D-109 Customers in the back office: managers add them, only the owner sets tier and credit, codes `C0001`, deactivate only at zero (2026-11-09)
- **Context:** W1-22 (POS-05, POS-07, CAT-04, PUR-01, ACC-03). A new shop had no way to get customers: only the legacy import and the e2e seed created them. W1-09 left them to the mapping file "until a back-office customer screen exists" (D-096).
- **Decision:**
  - **A back-office Customers screen** on the existing `parties` + `customer_accounts`: list and search with balances, add, edit, deactivate, delete one never used, and the customer's ledger, read only (owner answer 7; ageing stays in W1-20). No new table and no change to the pull: the W1-09 datasets and nudge carry every change to the counters.
  - **Who** (owner answers 1, 2): **`cust.edit`** (owner, manager, accountant) adds and edits customers; **`cust.terms.edit`** (owner only) sets the price tier and credit terms, as only the owner changes prices (D-104). Migration 0020 grants `cust.edit` to the Manager and Accountant roles made from the templates.
  - **A new customer** (owner answer 3) starts on the default tier with credit off; credit on needs a limit or *No limit* ticked on purpose; the offline cap starts at Rs 25,000 (PRD Q6), one constant in `packages/domain`. Phones are stored normalized (`normalizePhone`).
  - **Codes** (owner answer 4): suggested `C0001`, `C0002`…, editable, unique across parties ignoring case, never changed after saving; legacy codes are numeric, so they never collide.
  - **Deactivate only at a zero balance**; a customer who owes has their credit turned off instead. **Delete** only a customer never used anywhere, marked deleted; a party that is also a supplier loses only its customer account (owner answer 5).
  - **Before go-live** (owner answer 6), imported customers show a notice that the next import overwrites changes made here; new customers are never touched by an import.
  - **A supplier can be made a customer** too, on the same party (owner answer 8, PUR-01).
  - **No customer creation at the counter** for now (owner answer 9): the walk-in phone covers it until a later task.
- **Why:** a shop must be able to start selling on account without the importer; the money-at-risk fields stay with the owner; an open balance stays collectable at the desk.
- **Trade-off:** a manager's new customer can't buy on account until the owner sets their terms; until go-live, imported customers are still changed in the legacy app or the mapping file.
- **Status:** Accepted (with the W1-22 plan, owner answers 1–9). Amends D-096: the back office now sets credit terms; until go-live, imported customers' terms still come from the mapping file.

### D-110 Reports read the ledgers on request; exceptions are reviewed, never changed; Trace a bill and Send diagnostics for support (2026-11-10)
- **Context:** W1-20 (RPT-01, RPT-03, RPT-04, RPT-05, RPT-06, RPT-10, PLT-12). The facts are already on the server: sales, payments, overrides, voids, returns, exceptions, stock and cost, party ledgers, handovers, sync attempts and device health. Only the counter's diagnostic log never leaves it.
- **Decision:**
  - **Reports are read only and computed on request** from those tables, inside `withTenant`; nothing is stored. The register's totals and the ageing buckets are pure functions in `packages/domain`, golden-tested.
  - **Who** (owner answer 1): every report needs `reports.view` (owner, manager, purchaser, accountant); cost and value also need `cost.view`, left out by the API, not only the screen. **Trace a bill** needs `support.trace` (new: owner). Cashiers and salesmen see no reports.
  - **Dates** (owner answer 2): today by default, one branch, a range of up to 92 days, Download CSV on every report, no PDF.
  - **The sales register** (owner answer 3): every finalized bill, returns and exchanges netted; voided bills listed struck through and left out of the totals; totals by salesman, counter and tender.
  - **Ageing** (owner answer 4): by due date in five buckets (not yet due, 1–30, 31–60, 61–90, over 90 days overdue), credits applied to the oldest debit first; the totals equal Accounts receivable and Accounts payable.
  - **Exceptions** (owner answer 5): the owner or manager marks one reviewed or dismissed, with a note (`exceptions.review`, new), audited; the exception itself never changes. The open high-severity count shows on the home screen.
  - **Send diagnostics** (owner answer 6): a manager, after a PIN, sends the counter's last 5,000 log events and its health snapshot, device-signed; kept 30 days in `device_diagnostics` (new, forced RLS, not synced), shown on the device's page and in Trace a bill.
  - **Stock** (owner answer 7): on hand now, valued at average cost (an item without a cost counts 0, as posting does); stock at a past date waits for Wave 2.
- **Why:** one source of truth (rule 4), so a report can't disagree with the books; support can follow a bill from the counter to the books without asking the shop what happened.
- **Trade-off:** no stock at a past date, no PDF and no financial statements (trial balance, profit and loss, balance sheet, cash book: ACC-07, Wave 2) before go-live; reports on a long range are slower than stored summaries would be, hence the 92-day cap.
- **Status:** Accepted (with the W1-20 plan, owner answers 1–7).

### D-111 No void once money has reached the shop; a refund waits for its bill's payment; cash taken for a voided bill is given back at the desk (2026-11-11)
- **Context:** W1-23, found in the owner's staging checks of W1-12. An offline clash (`cash_received_for_void`, D-059) left *Cash in transit* below zero with no way to settle it; a bill paid by JazzCash was voided like an unpaid one, so the refund sent back left the shop with no record; and a bill not yet paid at the desk could be returned and its refund paid before the bill.
- **Decision:**
  - **A void is only for a bill whose money hasn't reached the shop** (widens D-099's *never after the cash handover* to every method). Before a void the counter checks each payment part: the desk's cash with the server (offline, or with no answer in 3 s, it asks *Has the customer already paid for this bill at the cash desk?*); a bank, wallet or card part always by asking, online too (*Has the shop's JazzCash account received Rs 400 for this bill?*), since the system can't see those accounts; on account asks nothing. Nothing arrived → void; everything arrived, or only the desk's cash still to come → a return; a bank, wallet or card part not received while another part arrived → stop until the customer completes it. One pure rule, `voidOrReturn`, golden-tested, used by the counter and the server; the void records each answer and who approved it (`SaleVoidV2`).
  - **Returns of unpaid bills:** on the bill's own day, a return of a cash bill not yet paid at the desk is sent to the void instead; and the desk never pays out a return's refund while its original bill is pending in its queue (*Collect … first*). Offline the desk can't link a refund slip to its bill (Code 39 carries only the return's number and amount), so it pays out, and the server flags `refund_before_payment`, settled by itself if the bill's handover arrives later.
  - **Cash taken for a voided bill is given back at the desk** (a cash movement of kind `void_cash`, `Dr CASH_IN_TRANSIT / Cr CASH_DRAWER`), with the owner's answers: the session's cashier with `cash.refund.pay` **and the PIN of a `pos.void` holder who is never the session's cashier** (1); always the full amount taken (2); the server then marks `cash_received_for_void` reviewed with a note naming the approver, which can be reopened (3); at any desk of the branch, on any later day, while the session is open, dated the day it happens (4).
- **Why:** a refund must be recorded where the money really went; a void only undoes a bill that never brought money in. The give-back is the only way *Cash in transit* and the drawer agree again after a clash, and the second PIN stops a cashier and a salesman together from voiding a paid bill and taking its cash.
- **Trade-off:** a void of a bill with a JazzCash, card or bank payment always asks a question; the voided bill's cash isn't used for its reissue in one step (the reissue is collected from the queue as usual); an early refund isn't blocked offline, only flagged after sync; handover confirmation stays **Required** for Delux (D-049).
- **Status:** Accepted (with the W1-23 plan, owner answers 1–4). Amends D-099.

### D-112 The shop's name and bill header are the owner's once the shop exists (2026-11-13)
- **Context:** W1-25, found after the Wave 1 release: production still said *Delux Autos* (the shop is *Delux City Auto Corner*) and the bill header was empty, and nothing after setup could change either. D-083's setup never overwrites a live shop, and reported every difference from the spec as drift.
- **Decision:**
  - **The owner sets them in the back office** (Shop → *Shop and bill*, `admin.settings`): the shop name (`tenants.name`), the branch's address, phone and up to 3 extra header lines (`branches.receipt_header.lines`), and the bill's policy line (the default print profile's `template_options.policyText`; empty = the default). Each line up to 60 characters, to fit the A5 bill (owner answer 2). One audited transaction; the counters and the cash desk pull and print it from their next sync.
  - **The header's order is one rule,** `billHeaderLines` in `packages/print` (address, phone, extra lines, then the profile's own `headerLines`), used by the counter, the cash desk and the back office's preview.
  - **Setup no longer reports these fields as drift.** A spec still gives a new shop its first name and header; after that they're the shop's. The branch's own name, the legal name and the rest of the print profile are still compared with the spec.
  - **Bills already printed don't change;** a reprint prints the header as it is now (the header isn't part of the bill's data, rule 3).
- **Why:** the name and header are what customers see on every bill, and the shop changes them (a new phone, a new line) without support or a release.
- **Trade-off:** the spec in git can differ from a live shop's name and header without anyone being told; the audit log is the record of what changed. The shop code (`delux`) and the POS origin never change (D-065).
- **Status:** Accepted (with the W1-25 plan, owner answers 1–3). Amends D-083.

### D-113 No go-live notices in the back office (2026-11-15)
- **Context:** until go-live the back office showed a notice on the catalog, imported customers, purchasing, stock and accounting screens: items and imported customers still change in the legacy app (the next import overwrites them, D-104, D-109), and purchases, stock movements and accounting entries made here are practice, removed by the pilot wipe (D-105, D-107, D-108). After the W1-26 release review the owner found the box repeated something they already know.
- **Decision:** **remove the notices from every screen, for everyone** (owner, 2026-11-15). The rules themselves don't change: the final import still overwrites the catalog and imported customers, and the pilot wipe still removes practice documents. The `live` flag stays in the lookups; no screen uses it now.
- **Why:** the owner runs the back office and knows the rules; the box took space on every screen.
- **Trade-off:** staff who use the back office during the pilot (1–31 Dec) aren't warned on screen. The owner tells them before the pilot (go-live checklist): items and imported customers still change in the legacy app, and back-office purchases, stock movements and accounting entries are practice until go-live.
- **Status:** Accepted (owner, 2026-11-15). Amends D-104, D-105, D-107, D-108 and D-109 (the notice parts only).

### D-114 The back-office frame: a side menu in groups that open and close, and a slim top bar (2026-11-14)
- **Context:** W1-28. Since W1-04 the back office followed the Tijara prototype's frame: a top bar with the brand, the signed-in name and Sign out, and a flat side menu with every group's heading and every entry always showing. One entry per task later, it held 28 links under 8 headings, two of them with one link each, and the setup screens spread over three groups. The owner asked for a minimal, modern frame and agreed the look from a mockup (2026-11-14).
- **Decision:**
  - **Seven rows:** Customers, Catalog, Purchasing, Stock, Accounting, Reports and **Settings** (Staff, Counters, Shop and bill, Stock settings; it replaces *People* and *Shop*). A group opens and closes; the current screen's group opens by itself. A group with one entry the person may open is a direct link.
  - **A full-height sidebar** with the brand on top, which **folds into a rail** of icons with flyouts; narrow windows always show the rail. Open groups and the fold are remembered in the browser only.
  - **The top bar** holds where you are (the menu's group and entry) and **a search for screens** (Ctrl K; screens only).
  - **The account sits at the foot of the sidebar** (avatar, name, username). Its menu opens beside the sidebar with **theme buttons** (System · Light · Dark; System only until the switcher, PLT-13) and **Sign out**.
  - **The first screen after sign-in** is still the first one the person may open, now in the new order: Customers for an owner or manager.
  - **Colours, fonts and building blocks stay** (D-066, D-067): the prototype's tokens, shadcn/ui on Radix, Lucide icons. Only the frame departs from the prototype.
- **Why:** the menu reads at a glance and keeps the working group in view; wide tables get room back from the rail; the search reaches any screen by name with groups closed.
- **Trade-off:** a screen in a closed group is one click further away than before. Each person's open groups and fold are per browser, not per user, and are lost when browser data is cleared. The shop's name is not in the frame yet (the API's `/auth/me` doesn't return it); it comes with the theme switcher (PLT-13), whose buttons are already in the account menu.
- **Status:** Accepted (owner, with the W1-28 plan, answers 1–3). Amends the W1-04 layout; its menu rule (owner answer 4: only screens that exist and that the person may open) is unchanged.

### D-115 A release merged in shop hours is queued on the server and switched by its own timer at 20:05 Karachi (2026-11-14)
- **Context:** W1-29. A production release merged between 10:00 and 20:00 waits for `deploy.yml`'s schedule (every hour 20:17–03:17, D-080). GitHub ran that schedule once or twice a night, never before 23:26 Karachi and as late as 08:06 (40 runs, 24 Oct–14 Nov). PR #172, merged 16:22 on 14 Nov, was still not deployed at 22:46 and was started by hand at 22:50.
- **Decision:**
  - **At merge time CI builds or reuses the images, loads them, and queues the release** on the server (`erp-deploy queue prod <tag>`, with the `infra/app` bundle). Nothing running changes.
  - **A systemd timer on the server** (`erp-release.timer`, 20:05 Karachi, retried hourly to 03:05) runs `erp-deploy release prod`: the same migrate → start → health check → rollback code as `deploy`, then the **public HTTPS check from the server**, rolling back if it fails. `release` does nothing between 10:00 and 20:00 itself, and the deploy key can't start it.
  - **A failed release isn't retried;** the newest queued release replaces an older one; any prod deploy clears what is waiting. Admins can `cancel` a waiting release on the server.
  - **Reporting:** Grafana alerts to Slack from a textfile metric (release failed or rolled back: critical; still waiting after 20:30: warning), and `deploy.yml`'s schedule becomes **one morning check (08:17) that never deploys** and fails if a release is waiting or the last one didn't end `ok`.
  - **Outside hours and "Run workflow" with force are unchanged:** CI deploys at once, with its check from the internet.
- **Alternatives:** more or denser GitHub schedules (GitHub drops them in busy hours); an external cron calling `workflow_dispatch`, or the server calling GitHub (a token stored outside GitHub, or on the server); a sleeping job or environment wait timer (6-hour limit; wait timers need a paid plan, D-087); keeping the old schedule as a second deployer (two clocks that may switch production).
- **Why:** the server's clock is exact; GitHub's schedule is best-effort. Everything slow or risky (build, upload) happens at merge time, and the switch at 20:05 runs code every staging deploy has already exercised.
- **Trade-off:** no GitHub run shows the 20:05 deploy; its result is in `releases.log`, Grafana and Slack, and the morning check emails if it failed. The check from the server can't see the Hetzner firewall or outside routes; the Grafana uptime checks (every 5 minutes, two probes) cover those. Production may now switch at 20:05 instead of 22:00 (D-075) or 20:17 (D-080).
- **Status:** Proposed (with the W1-29 plan). Supersedes the deferred-deploy schedule in D-075 and D-080; amends D-063 (how "a merge during hours waits until after closing" is done, not the window).

### D-116 Every remaining report is built before go-live, the modern way, in four tasks (2026-11-18)
- **Context:** the owner wants every report a modern ERP has, before go-live, and not only the Wave 1 ones (RPT-01 to RPT-06, RPT-10, built in W1-11 and W1-20). The legacy app's reports, shared as samples, answered what each one is for: its *Item Order Register* is the reorder list (at or below the minimum, order up to the maximum), its supplier *ageing* shows balances at past dates rather than overdue buckets, and its trial balance doesn't balance because the legacy books keep no stock account (its income statement works profit out from opening and closing stock). The rest of Wave 2 isn't started.
- **Decision:**
  - **Pull the reports forward from Wave 2, alone:** ACC-07 (trial balance, profit and loss, balance sheet, account ledger, cash book), RPT-07 to RPT-09, the list part of PUR-07 (the reorder list; POs stay in Wave 2), and new requirements RPT-11 to RPT-17 (day book and expenses, stock ledger, stock at a date and its movement, inventory analysis, sales over time, partner ledger and statement with the balance trend, control reports). The catalog is in [the reports module](modules/reports/README.md).
  - **Four tasks**, each with its own plan and PR (owner answer 1): W2-01 the report frame and the financial statements; W2-02 stock; W2-03 sales and purchase analysis; W2-04 customers, suppliers and control.
  - **All of it by go-live** (owner answer 2, against the recommendation of the 14 core reports first and the analysis extras in January). Inside each task the reports the shop uses today come first and the new analysis last.
  - **Modern, not legacy copies** (owner, 2026-11-18): one frame for every report (filters with presets, key figures, a sortable and searchable list, drill-down to the account, item, party and document, CSV and a print layout). The legacy samples (`legacy_reports/`, personal data, never committed) give meaning and numbers only.
  - **History** (owner answer 3): 2026 stays in the legacy app, kept read-only for look-ups for 3–6 months; no history import (D-100 stands). Every report starts from the opening balances of 1 Jan 2027.
  - **Dates** (owner answer 4): lists of documents or lines (registers, ledgers, the day book) up to 92 days, as D-110; summaries up to a year, with a comparison period; statements and stock at a date "as on" any date. Amends D-110's cap for summaries.
  - **Output** (owner answer 5): Download CSV and a print layout on every report; PDFs come from the browser's *Save as PDF*. No server-made PDF, no Excel file.
  - **Who** (owner answer 6): as D-110 and W1-19: financial reports need `reports.financial` (owner, accountant), the others `reports.view`, and cost, value and profit `cost.view`, left out by the API. Cashiers and salesmen see no reports.
  - **Our books won't match the legacy trial balance or income statement** and aren't compared with them: they reconcile item by item and party by party at cutover (W1-14).
- **Why:** the reports are how the owner runs the shop and checks the new system in its first month; they read the ledgers that already exist (D-110), so they need no new posting and don't touch the counter or sync.
- **Trade-off:** about 12 days of report work between 23 Nov and the go/no-go on 18 Dec, with little slack beside the pilot (from 1 Dec) and the cutover rehearsals. If time runs short the last items of each task (inventory analysis, sales over time, control reports) slip into January; nothing that the shop's books depend on does. The rest of Wave 2 (POs, repricing, cycle counts, custom roles, the theme switcher) waits.
- **Status:** Accepted (owner, 2026-11-18, answers 1–6); answer 2 **against recommendation**. Amends D-110 (the 92-day cap, for summaries) and PRD §6.8 and §8 (the reports' wave). The W2-01 plan was accepted the same day with every recommendation in its questions 1–7 (a Reports home, the multi-step profit and loss, comparisons with the previous period, a cash flow statement last in W2-04); issues [#176](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/176) to [#179](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/179). The W2-02 plan was accepted the same day: stock reports start from go-live with no legacy sales summary (its question 1, against recommendation; answer 3 stands), the books' value for stock everywhere, and questions 3–8 as recommended. The W2-03 plan was accepted on 2026-11-19, all six questions as recommended; its answer 4 widens answer 4 here for one report: **purchase and sale rates may cover up to a year**, since it lists the lines of one item or one party. W2-03 was built the same day. The W2-04 plan was accepted on 2026-11-19, questions 1–7 as recommended: **the partner ledger may also cover up to a year** (one party's documents), overdue means more than N days past due (30 by default) while customers have no terms, user activity is for the owner only (`admin.users`), and the cash flow is direct, month by month. Its question 8 **against recommendation**: the built reports (W1-11, W1-20) move onto the frame in W2-04 if time allows, after the cash flow; otherwise after go-live. W2-04 was built the same day; the move follows in its own PR.

### D-117 Back-office documents are dated by the shop's business date, never after it (2026-11-19)
- **Context:** the counters date a bill with the business date (local date with a 04:00 cut-off, GLOSSARY). The accounting forms already took that date from the API (W1-19), but the goods receipt, purchase return, supplier payment, transfer and adjustment forms took the browser's calendar date, and the API accepted any date for them. Between 00:00 and 04:00 Karachi a receipt was dated a day ahead of that night's bills, and stock "as on today" (W2-02) left it out until 04:00. Found during W2-02.
- **Decision:**
  - **Every back-office document form defaults to the shop's business date**, sent by the API in the purchasing and inventory lookups (`today`, from `shopDay`), as the accounting lookups already do; no form reads this browser's calendar (owner answer 1 to W2-05).
  - **A purchasing or stock document dated after the business date is refused on post** (`date_in_future`, with the business date), and the date fields go no later than it; drafts keep any date (owner answer 2). D-108 already said back-office documents are never in the future; now purchasing and stock check it too.
  - **The supplier's bill date** defaults to the business date too, with no new check: it is what the supplier's paper says (owner answer 3).
  - **The default is read when a screen opens**; a screen left open across 04:00 keeps its date, and the API checks again on post (owner answer 4).
  - **Report screens start on it too** (owner, 2026-11-19): the day reconciliation on the business day before, the cash variance on the 7 days up to it, the registers, exceptions and ageing on it, from `GET /api/shop/today`. On the report frame (W2-04 answer 8) their dates stay in the address but are never remembered, so they still start on it; a preset or another filter is remembered as on every report (W2-01 answer 6).
  - The lock date and the fiscal year are unchanged: a document typed after midnight lands in the same month and year as that night's counter bills.
- **Why:** one shop day for the counters and the back office, so stock, the books and the reports agree at any hour; a mistyped year can't post into the future.
- **Trade-off:** a draft dated ahead must be re-dated before it posts; the counters are not affected (they are never refused, rule 7).
- **Status:** Accepted (owner, 2026-11-19, the W2-05 plan's answers 1–4 as recommended). Amends D-108 (dates of purchasing and stock documents).

### D-118 An owner's dashboard is the back office's first screen, built from the reports' own figures (2026-11-20)
- **Context:** the back office has no home page: after sign-in it opens the first screen the person may open (D-114), and the owner checks the shop by opening several reports one by one. The owner asked for a modern, minimal dashboard with charts and agreed its design on a clickable prototype (2026-11-20), choosing layout A, *today first*, over an *attention first* layout.
- **Decision:**
  - **For the owner only:** a new permission, **`dashboard.view`**, that only the owner role holds (its `*`). The dashboard is the **first row of the menu and the owner's first screen** after sign-in. Everyone else keeps today's first screen; with custom roles (Wave 2) the permission can be given to others.
  - **A period switch** (Today · 7 days · 30 days) for sales and profit, compared with the same time before. Balances (cash, bank, what customers owe, what the shop owes suppliers, stock) always show **the position now**; expenses and net profit show **this month**.
  - **What it shows:**
    - **Five key figures in one row:** net sales, gross profit (margin beside the change), cash, bank and what customers owe. Each card has an icon, the figure and one change chip, plus a coloured strip on the left that the card's rounded corners clip.
    - **Cards, each opening its report with the same filters:**
      - the sales trend;
      - what needs attention;
      - busy hours;
      - top categories;
      - discounts, returns and voids;
      - where this month's gross profit went (a donut);
      - what customers owe us (no ageing; the biggest balances);
      - what the shop owes suppliers;
      - stock;
      - best-selling items;
      - salesmen.
  - **Every figure is the report's figure:** one read endpoint composes the report queries the reports already use (D-110). It adds no tables and no posting, and caches nothing.
  - **Charts stay ours:** the W2-03 SVG components plus a donut, with no chart library. Colours are theme tokens checked with the dataviz validator in both modes.
- **Alternatives:** a dashboard for every role with its own cards (the owner wants it for themself only); an *attention first* layout; sparklines on the key figures, ageing on what customers owe, and a payment-method split (each tried on the prototype and dropped by the owner).
- **Why:** the owner sees the day, the money and what needs them on one screen, and each figure opens the report that explains it. Since the figures come from the same queries, the dashboard can't disagree with the reports.
- **Trade-off:** one more endpoint that reads much of the shop's data on every load (timed in the plan). Other roles get nothing new until custom roles exist.
- **Status:** Accepted (owner, 2026-11-20): the design on the prototype, and the [W2-06 plan](modules/reports/plans/W2-06-owner-dashboard.md) with its questions 1–6 as recommended (cash = drawers, safe and cash in transit; bank = bank and wallet accounts; Today compared with the same weekday last week to the same time; *unusual* at 1.5 times and at least 3; the donut names the two biggest expenses and shows a loss in red; a counter needs attention after 10 minutes unseen with its session open; figures re-read every 5 minutes while visible). Issue [#198](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/198). Amends D-114 (the first screen after sign-in, for the owner).
