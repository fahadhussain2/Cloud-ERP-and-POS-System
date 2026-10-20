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

