# Cloud ERP + Offline POS

Multi-tenant cloud ERP with an offline-first POS for retail SMBs. The first tenant is **Delux Autos** (Karachi auto parts store, ~20k SKUs, 8–9 counters, one cash desk, PKR). Later it will be sold as SaaS in Pakistan and the UAE/Middle East. Go-live target: **1 Jan 2027**.

## Current phase: requirements approved, build on hold

The owner approved the PRD and all documents in `docs/` (D-060, confirmed in D-068). **Do not start building (no application code, no scaffolding) until the owner explicitly says to start Wave 0.** Until then: answer questions, refine the docs and prototypes, and record every change of decision as a new entry in `docs/06-DECISION-LOG.md`. Once started, build in wave order (PRD §8): Wave 0 → Wave 1 → Wave 2.

## Source of truth

| Doc | Use it for |
|---|---|
| [docs/01-PRD.md](docs/01-PRD.md) | Workflows (W1–W15), requirement IDs (PLT/CAT/POS/CSH/INV/PUR/ACC/RPT/SYN/MIG), build waves, release plan, open questions |
| [docs/02-ARCHITECTURE.md](docs/02-ARCHITECTURE.md) | Offline design, sync protocol, tenancy/RLS, security, deployment |
| [docs/03-DATA-MODEL.md](docs/03-DATA-MODEL.md) | Tables, conventions, POS local schema |
| [docs/04-ACCOUNTING-POSTING-RULES.md](docs/04-ACCOUNTING-POSTING-RULES.md) | Exactly what every document posts to the GL, stock and party ledgers |
| [docs/05-LEGACY-MIGRATION.md](docs/05-LEGACY-MIGRATION.md) | Legacy → new mapping, opening balances, reconciliation |
| [docs/06-DECISION-LOG.md](docs/06-DECISION-LOG.md) | Why things are the way they are. Check here before proposing an alternative. |

Reference requirement and decision IDs (e.g. `POS-12`, `D-017`) in code comments only where the reason isn't obvious, and in commit messages.

## Non-negotiable rules

1. **Money is integer minor units** (`bigint` in the DB, integers in TS). Never use floats for money. Quantities are `numeric(14,3)` in the DB and integer thousandths in `packages/domain`.
2. **Checkout rules live only in `packages/domain`:** pure, deterministic TypeScript with no I/O, imported by both the POS and the API. Never re-implement a rule elsewhere. Every rule has golden test cases.
3. **Finalized documents are immutable.** Corrections are void/reissue, return, or reversal entries. Never update document lines or amounts.
4. **Ledgers are append-only and derived.** Stock, party and GL entries come only from the posting engine (`packages/posting`), reference their source document, and must be reproducible by a rebuild.
5. **Every tenant-owned table has `tenant_id` plus a forced RLS policy.** The app role never bypasses RLS. A CI test fails if a table lacks a policy.
6. **POS writes are local-first:** document + sequence + outbox in one local transaction, then print. Network calls are never on the checkout path.
7. **Sync is idempotent by document UUID (UUIDv7, generated on the device).** The server never rejects a completed sale on business rules; it accepts it and records an `exception`.
8. **Change-feed pulls use the `xid8` / `pg_snapshot_xmin` cursor.** Never use `updated_at` or a plain sequence as a sync cursor.
9. **Never drop or rebuild the POS local DB while its outbox has unsynced documents.**
10. **No hard-coded UI strings** (i18n keys). Use CSS logical properties (RTL-ready). Format currency and dates with the tenant locale.
11. **`sql_dump/` contains personal data and legacy credentials.** Never commit it, upload it, or print credential columns. Read legacy data only through `tools/legacy-import` and staging.

## Planned stack (see decision log for status)

TypeScript monorepo:
- `apps/pos`: React PWA with SQLite WASM on OPFS
- `apps/backoffice`: React SPA
- `apps/api`: Fastify
- `apps/worker`
- `packages/domain`, `packages/contracts` (Zod), `packages/db` (Drizzle + SQL migrations), `packages/posting`, `packages/ui` (shadcn/ui on Radix + Tailwind, themed with the prototype tokens)
- `tools/legacy-import`

PostgreSQL 17+, Docker Compose on a Hetzner CX33 (Helsinki), Caddy, WAL archiving off-site. Apps at `pos.zorbixtechnologies.com` and `app.zorbixtechnologies.com` (staging: `staging-pos.` / `staging-app.`); the POS origin must never change (D-065).

## Branches and deploys (D-063)

- `staging` branch → auto-deploys to staging. `main` branch → production (merge `staging` → `main` to release; production deploys run only outside 10:00–20:00 Karachi time).
- Application code goes to `staging` first, never straight to `main`.
- Docs-only changes (`docs/**`, `*.md`) may be committed straight to `main`; they don't deploy. Merge them into `staging` afterwards.
- TDD for `packages/domain`, `packages/posting`, sync and RLS: write the golden test cases first.

## Domain glossary

| Term | Meaning |
|---|---|
| Counter | A POS device where a salesman sells and prints bills |
| Cash desk | The single device with the cash drawer. It sells **and** receives handovers, pays refunds, takes collections and closes the drawer. |
| Handover | Salesman brings a bill's cash to the cash desk; the cashier confirms it from the live queue, or scans the bill code (always when offline). Tenant setting `cash_handover_mode`: Required (Delux) or Off (automatic). |
| Print profile | Per-tenant/per-device bill printing setup: paper format, bill code (barcode or signed QR), copies. Delux: shared network A4 dot matrix, barcode. |
| Cash in transit | GL account holding cash from finalized counter bills not yet handed over. It must be 0 after a fully synced day. |
| Floor price | Lowest price allowed without a manager PIN |
| Tier | Price list (Retail / Mechanic / Wholesale) |
| Shop / Godown / Damaged | Stock locations: sellable / storage / not sellable |
| Goods receipt | Receiving stock together with the supplier's bill (purchase invoice) |
| Party | Customer and/or supplier |
| Business date | Local date with a 04:00 cutoff (shop closes 20:00; late sales count to the same day) |
