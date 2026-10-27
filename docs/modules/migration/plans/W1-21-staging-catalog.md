# W1-21 A generated catalog on staging

| | |
|---|---|
| **Issue** | to be opened when the plan is accepted |
| **Module** | migration (test data), with devops for the server command |
| **Status** | Draft, for the owner's review (2026-10-27). Replaces the first draft (the real Delux catalog): the owner chose a generated catalog to keep it simple |
| **Refs** | D-076 (no production data on staging: unchanged), D-083 (`erp-tenant`), D-087 (no paid services); sync spec §3; W1-03, W1-05 Verify 3 |
| **Depends on** | W0-11 (`erp-tenant`, the `demo` shop), W1-03 (`seedCatalog`) |
| **Size** | about half a day |
| **Test-first** | Yes: the generated catalog's shape, and the command refusing production |

## Goal

**Staging has a catalog big and varied enough to try every counter screen on**: about 20,000 made-up items in Delux's shape, in the `demo` shop. No real data goes anywhere. Real searches and speed stay checked on the owner's PC against `erp_dev` (as in the W1-03 and W1-05 Verify 2).

## Design

| Choice | Why |
|---|---|
| **Generated, not real data.** Nothing leaves the owner's PC, so D-076 stays as it is and no new decision is needed. | Owner's choice (2026-10-27): the least to keep safe and to explain. |
| **A generator in `@erp/db/testing`** (`generateCatalog({ items, seed })`) builds on `seedCatalog`, which the E2E already uses: Delux-like codes (`BRPD001`), names (part + car + origin, e.g. *BRAKE PADS FRONT COROLLA JAPAN*), OEM and alternate numbers, vehicle tags with year ranges, three tiers, about 1 in 20 items with a floor, some dormant ones, and hoses and oils sold by the metre or litre. **Deterministic:** the same seed gives the same catalog. | One code path for test catalogs; a fixed seed makes staging reproducible and tests exact. |
| **On the server:** `sudo erp-tenant seed-catalog staging demo [items]` (default 20,000) runs in the staging API image like `erp-tenant setup`, as the owner role, in one transaction with the tenant set. **It refuses `prod`**, and refuses a shop that already has items (run once; to start again, a new staging shop). | The existing, reviewed path onto the server; production can't get test data. |
| **Counters on staging** pull it like any catalog. | Nothing changes in the POS. |

## Scope

1. **`packages/db/src/testing`:** `generateCatalog`, tests.
2. **`apps/api`:** the seed entry point for the one-off container (like the tenant setup's).
3. **`infra/db/bin/erp-tenant`:** `seed-catalog <env> <shop> [items]`, refusing `prod`.
4. **Docs:** infra README (*Tenants*: a test catalog on staging); migration README.
5. **Then (owner, with Claude):** run it on staging after the deploy, and try a search on a staging counter.

**Out of scope:** real Delux data on staging (stays local, D-076); customers and suppliers (with their tasks); refreshing or replacing the generated catalog.

## Tests written first

- [ ] **Generator:** the same seed gives the same items; the counts asked for; every item has a code, a barcode identifier and a Retail price; some have floors, OEM numbers, vehicle tags, fractional units and a dormant status; codes are unique.
- [ ] **Seed (integration):** seeds a test tenant with RLS on; a second run is refused without writing; `prod` is refused.
- [ ] **Search on it:** the counter's search index finds a generated item by code, OEM number, words and car + year.

## Verify

1. `pnpm check` and `pnpm test:integration`, output shown.
2. On staging: the command reports 20,000 items; a staging counter's first catalog load finishes; the W1-05 checklist runs on it.

## Risks

| Risk | Mitigation |
|---|---|
| Test data reaches production | `erp-tenant seed-catalog` refuses `prod`; tested. |
| Generated names don't feel real | Staging is for checking that screens and sync work; real searches are checked locally on `erp_dev`. |
| 20,000 items take long to insert | Batched inserts in one transaction; timed in Verify 2. |
