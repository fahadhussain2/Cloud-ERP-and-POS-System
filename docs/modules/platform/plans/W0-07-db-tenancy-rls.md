# W0-07 Database foundations: tenancy, RLS and sync columns

| | |
|---|---|
| **Issue** | [#8](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/8) |
| **Module** | platform (with sync) |
| **Status** | Done on staging (PR [#27](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/pull/27)); waiting for the owner's merge |
| **Refs** | PLT-01, PLT-02, PLT-10; architecture §5.3, §6.2; data model §1–§2; CLAUDE.md rules 1, 5, 7, 8; D-028, D-036, D-075, D-078 |
| **Depends on** | W0-01, W0-02 (CI with PostgreSQL), W0-05 (databases on the server) |
| **Size** | about 2 days |
| **Test-first** | Yes: RLS and the sync cursor (architecture §12) |

## Goal

The multi-tenant base every module builds on:
- a tenant can never see or change another tenant's rows, enforced by PostgreSQL itself;
- every syncable row carries a cursor that **can't skip rows** under concurrency;
- migrations run in every deploy, with the least privilege possible.

## Design (D-078)

| Choice | Why |
|---|---|
| **Drizzle ORM 0.45 (stable)** with `node-postgres` (D-072). Tables are defined in TypeScript; `drizzle-kit generate` writes the SQL migrations, which are committed and reviewed. RLS policies, triggers, grants and functions are **hand-written SQL migrations** in the same folder. | Typed queries and reviewable SQL. Drizzle doesn't manage triggers, so they're explicit SQL anyway. 1.0 is still a release candidate. |
| **All tables live in the schema `erp`**; helper functions go there too. `ops` holds the backup canary (W0-05). | A clear boundary for the RLS check, and nothing in `public`. |
| **Three database roles:**<br>• `erp_owner` owns the schema and runs migrations<br>• `erp_app` is what the API and worker use: no `BYPASSRLS`, not an owner, data access only<br>• the `postgres` superuser only creates the roles (`infra/db`) | Rule 5: the app role can never switch RLS off. Migrations can't run as the app. |
| **The owner's password is given only to the migrate step** (`compose run --env-from-file …/migrate.env`). The running API holds only `erp_app`'s URL. | A bug in the running API can't alter tables or disable RLS. |
| **Tenant context per transaction:** `withTenant(pool, { tenantId, userId, deviceId, requestId }, fn)` opens a transaction, sets `app.tenant_id` etc. with `set_config(…, true)` (that is, `SET LOCAL`), runs `fn`, then commits. | Transaction-scoped, so it's safe with a connection pool: a context can't leak into the next request. |
| **The policy is the same on every tenant table:** `USING (tenant_id = erp.current_tenant_id()) WITH CHECK (same)`, **`FORCE ROW LEVEL SECURITY`**. `erp.current_tenant_id()` returns NULL when no tenant is set, so a query **outside `withTenant` sees nothing** and can't write. | Fail closed. Forgetting the context gives an empty result, never another tenant's data. |
| **One call adds the standard pieces to a table:**<br>• `erp.enable_tenant_rls('<table>')`<br>• `erp.enable_sync('<table>')`<br>• `erp.enable_audit('<table>')` | Every new table gets identical, tested behaviour. The CI checks below catch any table that misses them. |
| **Sync columns** (`row_version bigint`, `txid xid8`, `deleted_at`) are set by a trigger on every insert and update. `row_version` comes from one global sequence. **`DELETE` is refused** on syncable tables (soft delete only), so tombstones always sync. | Rule 8 and architecture §5.3. Pulls use `(txid, row_version)` with `txid < pg_snapshot_xmin(pg_current_snapshot())`. |
| **Audit columns** (`created_at/by`, `updated_at/by`) are filled by trigger from the transaction's `app.user_id` | Nobody can forget them, and the client can't fake them. |
| **IDs: UUIDv7.** `erp.uuid_v7()` is the column default for server-created rows (PostgreSQL 17 has none built in). Device-created documents send their own (D-036). | Time-ordered IDs are index-friendly and consistent with the POS. |
| **Status-like columns are `text` + `CHECK`**, not PostgreSQL enums | Adding a value is a simple, backward-compatible migration (D-075's rollback rule); removing an enum value isn't. |
| **Local development database:** `infra/dev/compose.yaml` (PostgreSQL 17.9 on `127.0.0.1:5432`), plus `pnpm db:up` / `pnpm db:down` | Integration tests and migrations work on the PC as well as in CI. It needs Docker Desktop running. |

## Scope

1. **`packages/db`:**
   - Drizzle config
   - schema for **`tenants`** (every PLT-01 setting from data model §2, with `CHECK`s: fiscal month 1–12, cutoff hour 0–23, minor units 0–3, tax mode, handover mode, status), **`branches`** and **`locations`** (PLT-02: `kind` shop / storage / damaged, `is_sellable`)
   - column helpers (`tenantId`, `syncColumns`, `auditColumns`)
   - `withTenant`
   - `migrate()`
   - a test helper that creates a throwaway database, roles and schema per test run
2. **Migrations:**
   - `0000`: schema, helper functions (`uuid_v7`, `current_tenant_id`, `enable_*`), the `row_version` sequence
   - `0001`: the three tables with RLS, sync and audit
   - grants and default privileges for `erp_app`
3. **`apps/api` `migrate` entry point:** runs `migrate()` with `MIGRATION_DATABASE_URL`. The no-op from W0-04 is replaced.
4. **Server:**
   - `infra/db` creates `erp_owner` and `erp_app` with generated passwords, and writes `/srv/erp/<env>/app.env` (`DATABASE_URL`, the app role) and `/srv/erp/<env>/migrate.env` (owner role, mode 600)
   - `erp-deploy` runs the migrate step with `--env-from-file migrate.env`
5. **CI integration tests** (written **first**; see the next section).
6. **Docs:**
   - `CLAUDE.md` commands (`db:up`, `db:generate`)
   - `docs/modules/platform/README.md` status
   - data model §1: the schema name and the standard helpers

**Out of scope:**
- users, roles and audit log (W0-09)
- devices (W0-10)
- the Delux seed (W0-11)
- any business tables
- the sync endpoints themselves (Wave 1)

## Tests written first (they must fail before the code exists)

**RLS (rule 5, PLT-10):**
- [x] **Every table has RLS:** every table in `erp` has RLS **enabled and forced**, at least one policy, and a `NOT NULL tenant_id` (or is on a short allow-list, e.g. `tenants` itself, policy on `id`). **A new table without them fails CI.**
- [x] **The app role is safe:** `erp_app` is not a superuser, has no `BYPASSRLS`, owns no table, and can't `ALTER` or `DROP` anything.
- [x] **Tenants are isolated:** in tenant A's context, tenant B's rows are invisible to `SELECT`, and `UPDATE` / `DELETE` touch 0 rows.
  - `INSERT` with B's `tenant_id` fails.
  - `UPDATE … SET tenant_id = B` fails.
- [x] **Fail closed:** with no context, every table returns 0 rows and inserts fail. A malformed context raises an error.
- [x] **No context leak:** after a `withTenant` transaction ends, the same pooled connection has no tenant set.

**Sync columns and cursor (rule 8, architecture §5.3):**
- [x] An insert sets `txid` and `row_version`, and an update moves both forward.
- [x] `DELETE` on a syncable table is refused; a soft delete moves the cursor.
- [x] **No skipped rows under concurrency:**
  1. Transaction T1 writes a row and stays open.
  2. Transaction T2 writes and commits.
  3. A pull at that moment returns **neither** row past the safe point.
  4. After T1 commits, the next pull returns **both**.
- [x] Pulls return rows in `(txid, row_version)` order, and resuming from a cursor returns each row exactly once.

**Audit, IDs, migrations:**
- [x] `created_by` / `updated_by` come from `app.user_id`; `updated_at` changes on update.
- [x] `erp.uuid_v7()` returns version-7 UUIDs that sort by creation time.
- [x] **Migrations:** running them again is a no-op; `drizzle-kit generate` finds no un-generated changes (schema and SQL can't drift).
- [x] **Deploy:** staging's deploy runs the real migrations as `erp_owner`, and the running API holds only `erp_app` (checked on the server: `migrate.env` isn't in the API container's environment).

## Order

1. Local dev database and test helper.
2. **Failing tests** (RLS, sync, audit, IDs), committed on their own.
3. Migrations and schema until they pass.
4. `withTenant` and `migrate()`, with unit tests where they don't need a database.
5. Server roles, env files and the `erp-deploy` migrate step. Deploy the PR to staging with the `deploy:staging` label.
6. Docs.

## Risks

| Risk | Mitigation |
|---|---|
| A table is added without RLS later | The CI check fails the build, and `REVIEW.md` already makes it a blocker. |
| Someone queries outside `withTenant` and gets confusing empty results | Fail-closed is intended. The API's request layer (W0-09) wraps every handler in `withTenant`; a lint rule against using the pool directly is added then. |
| `FORCE` RLS also applies to the owner, so data fixes need a context | Intended: seeds and data migrations set a tenant context too (W0-11). |
| Global `row_version` sequence contention | Negligible at our volume (about 140 bills a day per tenant). |
| Drizzle 1.0 arrives with breaking changes | Pinned to 0.45; upgrading is a planned task, not a surprise. |

## Owner actions

- None, except starting Docker Desktop on the PC when running integration tests locally.

## Changes made while building

| Change | Why |
|---|---|
| **Migrations are hand-written SQL only**, applied by a small runner in `packages/db` (`erp_meta.migrations`, an advisory lock, checksums). `drizzle-kit` isn't used. **Drift is caught by an integration test** that compares every table, column, type and `NOT NULL` in the Drizzle schema with the real database. | `drizzle-kit generate` puts `CREATE SCHEMA` and the tables in its first migration, but the tables need the helper functions (`erp.uuid_v7()`, the RLS and sync helpers) to exist first, which would mean hand-editing its output. The test against the real database is a stronger drift check than "generate finds nothing". |
| **Applied migrations are immutable:** the runner refuses to run if one was edited (tested) | A changed history would make servers differ. Fixes go in a new migration. |
| The API image ships `packages/db/migrations` next to `dist/`; `pg` is a runtime dependency of the API | The bundled `migrate` step finds the SQL files the same way in tests and in production. |
| **Mutation check:** removing the cursor's `txid < pg_snapshot_xmin` guard, or RLS on `locations`, each makes exactly the right test fail | Proves the tests guard what they claim to. |

## Results (2026-10-22)

| Check | Result |
|---|---|
| Tests first | Committed failing (`4605a51`): the modules didn't exist. |
| Integration tests | **25/25 pass**, locally (dev database) and in CI (PostgreSQL 17 service). |
| Mutation checks | Without the `pg_snapshot_xmin` guard, the concurrency test fails. Without RLS on `locations`, the RLS check reports "RLS not enabled / not forced / no policy". |
| `pnpm check` | Green: format, lint, typecheck, 16 unit tests, build. |
| Bundled `migrate` (production copy) | Applies both migrations, then "up to date"; without `MIGRATION_DATABASE_URL` it exits 1. |
| **Staging deploy** (PR #27, `deploy:staging`) | The migrations ran inside the deploy as `erp_owner`; all three tables have RLS enabled and forced and are owned by `erp_owner`. |
| Least privilege on staging | The API container's environment has only `DATABASE_URL`. It connects as `erp_app`, and without a tenant context sees **0** tenants. |
| Server roles | `erp_owner` and `erp_app` are created on staging and prod: not superusers, no `BYPASSRLS`. `app.env` and `migrate.env` are mode 600, owner `deploy`. Prod's are ready for its first real migration at the next release. |
