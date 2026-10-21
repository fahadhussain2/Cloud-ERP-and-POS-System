# Cloud ERP + Offline POS

Multi-tenant cloud ERP with an offline-first POS for retail SMBs. First tenant: **Delux Autos** (Karachi auto parts store, PKR). Go-live **1 Jan 2027**.

## Phase: requirements approved, build on hold

**Do not write application code or scaffold until the owner explicitly says to start Wave 0** (D-068). Until then: refine docs and prototypes; record every change of decision in `docs/06-DECISION-LOG.md`.

## Read first

- **How we work:** [docs/07-DELIVERY-PROCESS.md](docs/07-DELIVERY-PROCESS.md). Plan → tests first → build → verify → review. No code before the task's `plan.md` is accepted.
- **What we build:** PRD (`01`), architecture (`02`), data model (`03`), posting rules (`04`), migration (`05`), decisions (`06`), [glossary](docs/GLOSSARY.md). Check the decision log before proposing an alternative.
- **Module context:** `docs/modules/<module>/README.md`, plus its `spec.md` and `plans/`.
- Reference requirement and decision IDs (`POS-12`, `D-017`) in plans, commits and non-obvious code comments.

## Non-negotiable rules

1. Money is **integer minor units** (bigint / integer). Never floats. Quantities: `numeric(14,3)` in the DB, integer thousandths in `packages/domain`.
2. Checkout rules live **only in `packages/domain`** (pure, deterministic, golden-tested), shared by POS and API.
3. Finalized documents are **immutable**. Corrections = void/reissue, return or reversal.
4. Stock, party and GL ledgers are **append-only and derived** by `packages/posting`, and rebuildable.
5. Every tenant table has `tenant_id` + **forced RLS**. The app role never bypasses RLS.
6. POS writes are **local-first** (document + sequence + outbox in one local transaction, then print).
7. Sync is **idempotent by device-generated UUIDv7**. The server accepts completed sales and records exceptions; it never rejects them on business rules.
8. Change-feed cursor = **`xid8` / `pg_snapshot_xmin`**, never `updated_at`.
9. Never drop or rebuild the POS local DB while its outbox has unsynced documents.
10. No hard-coded UI strings (i18n keys), CSS logical properties, tenant-locale formatting.
11. **`sql_dump/` is off-limits** (personal data, legacy credentials). Only `tools/legacy-import` reads it. A hook enforces this.
12. The POS origin `pos.zorbixtechnologies.com` must never change (D-065).

## Working rules

- **Done = checks run and output shown** (lint, typecheck, test, build; e2e for UI flows). Never claim done without it.
- **Bug fix = failing test first**, committed, then lock it: `node .claude/hooks/bugfix-lock.mjs lock <test>`. Fix the code, then unlock.
- **Branches:** code → `staging` (auto-deploys to staging); release = merge `staging` → `main` (production, after 20:00 Karachi). Docs-only changes may go straight to `main`.
- **Reviews** follow [REVIEW.md](REVIEW.md). The owner approves merges.
- **Skills:** `posting-rules`, `checkout-rules`, `sync-protocol`, `legacy-migration`. **Agents:** `verifier` (runs checks, reports), `researcher` (read-only).

## Commands

Added in Wave 0, once the monorepo exists: `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm build` · `pnpm e2e`.

## Known mistakes to avoid

*(Add a line whenever the same mistake happens twice.)*
