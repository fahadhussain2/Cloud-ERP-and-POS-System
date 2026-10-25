# Cloud ERP + Offline POS

Multi-tenant cloud ERP with an offline-first POS for retail SMBs. First tenant: **Delux Autos** (Karachi auto parts store, PKR). Go-live **1 Jan 2027**.

## Phase: Wave 0 (foundations)

Building started (D-070). Work task by task from the Wave 0 issues; **no code before the task's plan is accepted**. Record every change of decision in `docs/06-DECISION-LOG.md`.

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
- **Branches:** everything (code and docs) → `staging` via a pull request (auto-deploys to staging); release = merge `staging` → `main` (production, after 20:00 Karachi). `main` moves only by releases (D-080).
- **Reviews** follow [REVIEW.md](REVIEW.md). The owner approves merges.
- **Skills:** `posting-rules`, `checkout-rules`, `sync-protocol`, `legacy-migration`. **Agents:** `verifier` (runs checks, reports), `researcher` (read-only).

## Commands

Node 24 LTS + pnpm 11 (D-071). Run from the repo root:

| Command | What it does |
|---|---|
| `pnpm install` | Install everything (one lockfile for the workspace) |
| `pnpm check` | **All checks:** format check, lint, typecheck, tests with coverage, build. Must pass before "done". |
| `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm build` | The single steps; `pnpm format` fixes formatting |
| `pnpm test:watch` | Vitest in watch mode |
| `pnpm test:integration` | Integration tests (`*.int.test.ts`) against PostgreSQL 17+ at `DATABASE_URL`. They fail without it, and CI always runs them. |
| `pnpm db:up` · `pnpm db:down` | Local PostgreSQL 17.9 on `127.0.0.1:54329` (Docker). Then: `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/postgres pnpm test:integration` |
| `pnpm --filter @erp/<app> dev` | Run one app (`api`, `worker`, `pos`, `backoffice`) |
| `pnpm e2e` | End-to-end flows (Playwright, `e2e/`): seeds a throwaway `erp_e2e` database at `DATABASE_URL`, starts the API and the built POS and back office. Locally `E2E_CHANNEL=msedge` uses the installed Edge; CI uses Playwright's Chromium. |

Packages are named `@erp/<folder>` and used as TypeScript source; only apps are built.

**Database (D-078):**
- Tables live in schema `erp` and are created only by SQL files in `packages/db/migrations/` (immutable once applied).
- Every new table calls `erp.enable_tenant_rls`, and synced tables also call `erp.enable_sync` and `erp.enable_audit`.
- Mirror each table in `packages/db/src/schema.ts`; a test fails if the two differ.
- App code queries only inside `withTenant(...)`.

## Known mistakes to avoid

*(Add a line whenever the same mistake happens twice.)*

- After `pnpm deploy` (e.g. testing a production bundle), run `CI=true pnpm install` before other pnpm commands; otherwise pnpm wants to rebuild `node_modules` and aborts without a TTY.
