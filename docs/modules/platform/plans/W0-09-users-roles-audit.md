# W0-09 Users, roles, permissions and audit log

| | |
|---|---|
| **Issue** | [#10](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/10) |
| **Module** | platform |
| **Status** | Done on staging (PR [#30](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/pull/30)); waiting for the owner's merge |
| **Refs** | PLT-04, PLT-05, PLT-08; PRD §4 (users and roles); architecture §6.3, §6.4; D-026, D-051, D-078, D-081 |
| **Depends on** | W0-07 (tenancy and RLS), W0-08 (domain package) |
| **Size** | about 2 days |
| **Test-first** | Yes for permissions (golden matrix), RLS and audit |

## Goal

People log in to the back office with their own account; what they may do comes from their roles; and every change to master data leaves a before/after record that nobody can edit. This is the base for PIN unlock and overrides (W0-10) and for every screen after it.

## Design (D-081)

| Choice | Why |
|---|---|
| **Login asks for a shop code + username + password.** The shop code (e.g. `delux`) is remembered on the device, so staff type it once. A small directory table `erp.tenant_directory (code → tenant_id)` is the only thing readable across tenants. | All tenants share one address (D-065), so the login needs to know which shop. The directory reveals only codes, never tenant data. |
| **Passwords: Argon2id** (`@node-rs/argon2`, prebuilt for the server image) with the OWASP parameters (19 MiB, 2 passes). The hash string carries its parameters, so they can be raised later and hashes upgraded at the next login. At least 10 characters, no composition rules, not containing the username. | Architecture §6.3. Long and memorable beats complex and written down (NIST guidance). |
| **Sessions in the database:** a random 32-byte token in an **HTTP-only, Secure, `SameSite=Strict` cookie** on `/api`; only its SHA-256 is stored. They expire after **12 h**, or **2 h idle**. Logout and a password change end the sessions. | A stolen database can't be used to log in. The idle limit protects an unattended back-office PC. |
| **The cookie is `<tenant id>.<token>`**: the request layer sets the tenant context from it, then looks the token up *under RLS* | The session lookup itself is tenant-isolated. A tampered tenant id simply finds no session. |
| **Brute-force protection:** 5 wrong passwords lock that account for 15 minutes; the login route also has a per-IP rate limit. An unknown username takes as long as a wrong password. | No password guessing, and no way to find out which usernames exist. |
| **State-changing requests must come from our own origin** (`Origin` header check), on top of `SameSite=Strict` | Defense in depth against cross-site request forgery. |
| **PINs never log in to the back office.** The user has a `pin_verifier` column for W0-10, but the login only ever checks `password_hash`. | Architecture §6.3: a 4–6 digit PIN is for unlocking an enrolled counter, not for remote access. |
| **Permissions are strings** (`pos.void`, `pos.return.create`, `cost.view`, …) from one **catalog in `packages/domain`**, plus **numeric limits** per role (`max_discount_bp`, `can_sell_below_floor`, `void_window`, …). `can()` and `effectiveLimits()` live in `packages/domain` too, so the POS and the API decide the same way (rule 2). | One place defines what a permission is. The POS needs the same checks offline. |
| **Role templates** (Owner, Manager, Cashier, Salesman, Purchaser, Accountant) are defined in `packages/domain` from PRD §4. Owner has `*` (every permission, including future ones). A user's roles can be limited to a branch. Several roles **combine to the most permissive** limit. | PLT-05. Custom roles (PLT-06, Wave 2) copy a template. |
| **The audit log is written by the database:** a trigger on each master-data table records insert / update / soft delete with **before and after** JSON, the user, device and request ID. Secret columns (`password_hash`, `pin_verifier`) are stripped. Logins, logouts and lockouts are written by the API. **`audit_log` is append-only:** no `UPDATE` or `DELETE`, not even for the owner role. | PLT-08: nobody can forget to log a change, and nobody can rewrite history. |

## Scope

1. **Migration `0003`:**
   - `tenant_directory` (allow-listed in the RLS test as the one cross-tenant table)
   - `users`, with `password_hash`, a nullable `pin_verifier`, the lockout fields, and per-tenant unique `username` (case-insensitive), `email` and `short_code`
   - `roles`, `user_roles`, `sessions`, `audit_log`
   - the `erp.enable_audit_log(table, secret_columns)` helper, applied to tenants, branches, locations, users, roles and user_roles
2. **`packages/domain`:**
   - the permission catalog
   - `ROLE_TEMPLATES`
   - `can(grants, permission, branchId)`
   - `effectiveLimits(grants, branchId)`
   - golden cases
3. **`packages/contracts`:** Zod schemas for the login request and the "me" response. `zod` is added.
4. **`apps/api`:**
   - a DB pool
   - a request context plugin (session → `withTenant`)
   - `requirePermission()`
   - `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
   - Argon2id helpers
   - the origin check
   - the login rate limit
   - `@fastify/cookie` and `@fastify/rate-limit`
5. **`packages/db/testing`** export, so the API's integration tests reuse the throwaway-database helper.
6. **Docs:** data model §2 (the directory and the columns), the platform README, `REVIEW.md` (an endpoint without `requirePermission` is a blocker, as now).

**Out of scope:**
- PIN set/verify and devices (W0-10)
- the owner account and Delux roles seed (W0-11)
- user and role admin screens (Wave 1/2)
- TOTP (Phase 2)

## Tests written first

**Permissions (domain, golden):**
- [x] **Permission matrix:** every template × every catalog permission gives the expected yes/no; Owner gets everything, including a permission added later.
- [x] Limits: two roles combine to the most permissive; a branch-scoped role counts only in its branch.
- [x] Salesman can process returns by default (D-051) and can't void; Accountant can't sell.

**Database (integration):**
- [x] The existing RLS check covers the new tables automatically; `tenant_directory` is the only allow-listed exception, and it exposes only `code` and `tenant_id`.
- [x] Usernames are unique per tenant, case-insensitive; the same username in two tenants is fine.
- [x] The audit trigger writes before/after for an update, with the user and request ID, and **without** `password_hash` / `pin_verifier`.
- [x] `audit_log` refuses `UPDATE` and `DELETE`, for the app role and the owner role alike.

**API (integration, real database):**
- [x] Login with the right password sets the cookie (`HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/api`); `/api/auth/me` returns the user and their effective permissions.
- [x] A wrong password, an unknown user, and a wrong shop code all give the same answer, and take about the same time.
- [x] Five wrong passwords lock the account for 15 minutes, even with the right password; each attempt is in the audit log.
- [x] **The user's PIN doesn't work as a password.**
- [x] A session expires after 12 h and after 2 h idle (clock injected); logout revokes it.
- [x] A cookie with another tenant's id and a real token from this tenant is rejected.
- [x] A state-changing request from another origin is rejected.
- [x] A route with `requirePermission('pos.void')` refuses a Salesman and allows a Manager.

## Order

1. Failing tests (domain golden, DB, API), committed on their own.
2. Domain catalog and templates.
3. Migration `0003`.
4. API auth.
5. Deploy the PR to staging (`deploy:staging`), log in there with a test tenant made by hand, check the cookie and the audit rows.
6. Docs.

## Risks

| Risk | Mitigation |
|---|---|
| Argon2 is CPU- and memory-heavy, and many logins at once could slow the API | About 20 ms per login at these parameters; the login rate limit caps bursts. The parameters are in the hash, so they can be tuned. |
| The native Argon2 package doesn't load in the Alpine image | `@node-rs/argon2` ships a prebuilt musl binary; the staging deploy proves it. |
| The audit log grows forever | About a few thousand rows a day at most. Partitioning or archiving when it matters (it's append-only, so that's straightforward). |
| A permission string is misspelled in a route | `requirePermission` only accepts catalog keys (a TypeScript type), so a typo doesn't compile. |

## Owner actions

None. W0-11 creates your owner account; until then, staging uses a test tenant.

## Changes made while building

| Change | Why |
|---|---|
| Login bookkeeping (failed count, lock, last login) is in its own table, `user_login_state` | On `users`, every login would write an audit row and bump the sync version that counters download. |
| **Yes/no abilities are permissions, not limits.** Limits are only `maxDiscountBp` and `voidWindow`. | "Can void", "can see cost", "can sell on credit" in the data model's example limits were permissions under another name. One concept each keeps the role editor simple. |
| An extra route, `GET /api/auth/can/:permission` (204 / 403) | Screens can ask "may I?" without knowing the role setup; it also tests `requirePermission`. |
| Bug found by the tests: with no trigger arguments, PostgreSQL passes `TG_ARGV` as **NULL**, so the audit row lost its tenant | Fixed with `coalesce(TG_ARGV, '{}')`, before any commit. |
| The role matrix is a reviewed snapshot file (`golden/role-matrix.snap.json`) | Changing a template changes that file, so the change shows up in review. |

**Default to confirm with the owner:** Salesman (and Cashier) can **sell on credit** (`pos.credit.sell`). Each customer's credit limit still applies, and over-limit needs a manager PIN. Remove it from the template if counters should never sell on credit without a manager.

## Results (2026-10-23)

| Check | Result |
|---|---|
| Tests first | Committed failing (`05dbb81`). |
| Domain | Permission golden cases (28), limits (8), template checks and the role matrix. `packages/domain` coverage stays at **100%**. |
| Database (integration) | Usernames, the directory, audit before/after without secrets, soft delete as `delete`, append-only for app and owner (and `TRUNCATE`), tenant isolation. The RLS check covers the 7 new tables automatically. |
| API (integration, 13 tests) | Secure cookie; identical failures; **PIN refused as the password**; 5-try lockout with the audit trail; idle and absolute expiry; logout; cookie moved to another tenant refused; garbage cookies; other-origin POST refused; `requirePermission` (Salesman 403, Manager 204). |
| Mutation checks | Lockout effectively off: the lockout test fails. Origin check off: the other-site test fails. |
| Totals | `pnpm check` green with 180 unit tests; **46 integration tests** pass. |
| **Staging, over HTTPS** (test shop `w0-test`, made by hand; test password in a git-ignored local file) | Migration `0003` applied by the deploy; Argon2 loads in the Linux image. Owner login → cookie `Max-Age=43200; Path=/api; HttpOnly; Secure; SameSite=Strict`, 38 permissions. `can/pos.void`: Owner 204, Salesman 403. Wrong password 401; other origin 403; logout 204, then `me` 401. The audit trail shows `login.success`, `login.failed` and `logout` with the **real client IP**, and no row contains a password hash. |
