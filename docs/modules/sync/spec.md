# Sync protocol: spec

| | |
|---|---|
| **Status** | Accepted v1 (with the W1-02 plan, D-089): pull (2026-10-25). Catalog datasets: accepted with the W1-03 plan (2026-10-26). Push is added with W1-06. |
| **Refs** | SYN-01…SYN-06; architecture §4.1, §5; data model §10, §12; CLAUDE.md rules 6–9; D-009, D-011, D-042, D-047 |

The architecture (§5) sets the principles. This spec fixes the contracts precisely enough to build and test them. **v1 covers pull**, which W1-02 (users and settings for unlock) and W1-03 (the catalog) need. **Push**, server acceptance, gaps and re-push after a restore are specified with W1-06, in a section below.

## 1. Who may sync

- Only an **enrolled, active device** with a valid device token (`Authorization: Device <tenantId>.<token>`, D-082). A revoked device gets `401` on its next call; documents it made before are still accepted later (push, W1-06).
- Every query runs inside `withTenant` with the device's tenant (RLS, rule 5). Branch-scoped datasets are also filtered to the device's branch.

## 2. Pull

```
GET /api/sync/pull?datasets=users,roles,user_roles,tenant,branch&cursor=<opaque>&limit=500
→ 200 { "changes": { "<dataset>": [ <row>, … ] }, "cursor": "<opaque>", "hasMore": true|false }
```

- **One call, several datasets, one opaque cursor** (architecture §5.3). The cursor is base64url JSON of `{ "<dataset>": { "txid": "<xid8>", "rowVersion": "<bigint>" } }`; clients store it as is (`sync_state`) and never read inside it. A missing cursor, or a dataset missing from it, starts that dataset from the beginning.
- **No skipped rows (rule 8):** per dataset, rows with `(txid, row_version) > cursor` **and** `txid < pg_snapshot_xmin(pg_current_snapshot())`, ordered by `(txid, row_version)`. This is `pullChanges` from W0-07. Never `updated_at`.
- **Paging:** at most `limit` rows in total per call (default 500, max 1,000), filled dataset by dataset in the requested order. `hasMore` is true while any dataset has more; the client repeats the call with the new cursor until it's false.
- **Tombstones:** soft-deleted rows (`deleted_at` set) are returned like any change; the client deletes or hides them locally.
- **Rows contain only their dataset's listed columns** (§3), as JSON: `bigint` and `numeric` as strings, timestamps as ISO 8601, `bytea` as base64url. Sync and audit bookkeeping (`txid`, `created_by_user_id`…) is left out; `row_version` and `deleted_at` are kept.
- **Errors:** `400 { error: 'unknown_dataset' | 'bad_cursor' | 'bad_limit' }`, `401` for a missing, expired or revoked device token. Pull never changes server data.

## 3. Datasets (v1)

Each dataset lists its columns explicitly. **A column not listed never leaves the server.** A test fails if a dataset returns any other column.

| Dataset | Table | Scope | Columns |
|---|---|---|---|
| `tenant` | `tenants` | the tenant | `id, name, base_currency, currency_minor_units, timezone, locale, tax_mode, cash_rounding_increment, day_cutoff_hour, closing_time, cash_handover_mode, status, row_version, deleted_at` |
| `branch` | `branches` | the device's branch | `id, code, name, address, phone, receipt_header, status, row_version, deleted_at` |
| `users` | `users` | the tenant | `id, username, full_name, short_code, pin_verifier, pin_must_change, status, row_version, deleted_at`. **Never `password_hash`, `email`, `password_changed_at`, `must_change_password`.** |
| `roles` | `roles` | the tenant | `id, name, template_key, permissions, limits, row_version, deleted_at` |
| `user_roles` | `user_roles` | the tenant; branch-specific rows only for the device's branch | `id, user_id, role_id, branch_id, row_version, deleted_at` |

**Catalog datasets (W1-03):** all scoped to the tenant.

| Dataset | Table | Columns |
|---|---|---|
| `price_tiers` | `price_tiers` | `id, code, name, sort, is_default, row_version, deleted_at` |
| `units` | `units` | `id, code, name, allows_fraction, row_version, deleted_at` |
| `categories` | `categories` | `id, code, name, parent_id, pricing_rule, return_policy, row_version, deleted_at` |
| `brands` | `brands` | `id, name, row_version, deleted_at` |
| `origins` | `origins` | `id, name, row_version, deleted_at` |
| `vehicle_makes` | `vehicle_makes` | `id, name, row_version, deleted_at` |
| `items` | `items` | `id, code, name, category_id, brand_id, origin_id, unit_id, variant, spec, bin_location, floor_price, tax_code_id, status, row_version, deleted_at`. **Never `legacy`, `default_supplier_id`, `min_qty`, `max_qty`, `exclude_from_reorder`.** |
| `item_identifiers` | `item_identifiers` | `id, item_id, kind, value, normalized_value, is_primary, row_version, deleted_at` |
| `item_compatibility` | `item_compatibility` | `id, item_id, make_id, model, year_from, year_to, note, row_version, deleted_at` |
| `item_prices` | `item_prices` | `id, item_id, tier_id, price, row_version, deleted_at` |

`legacy` (on every catalog table) never leaves the server. Customers (W1-09), stock balances (W1-08) and the 90-day bills (W1-13) are added by their tasks with the same rules.

**Bootstrap:** the first pull simply starts from the beginning, in full pages of 1,000 rows (about 125k catalog rows for Delux). An interrupted first load resumes from the last committed page. Measured in W1-03 on the real catalog: **31 seconds** from setup to search, under the 60-second rule, so there is no snapshot download. Revisit if a tenant's catalog is much larger.

## 4. When the counter pulls

- At startup (after the storage checks), after each unlock, and **every 60 seconds** while online. The SSE nudge (`changes-available`) replaces most polling later (W1-07).
- A pull that fails (offline, server error) is retried at the next trigger; the counter keeps working from its local copy. The status bar shows the last successful sync time.
- Rows are applied to the local database **in one transaction per page**, together with the new cursor, so a crash never leaves a cursor ahead of the data.

## 5. PIN changes from a counter (the one write before push)

Owner answer 2 to W1-02: a temporary PIN set by a manager is changed to the user's own PIN at the counter.

```
POST /api/sync/pin   { userId, currentPin, newPin }   (device token)
→ 204 | 400 { error: 'weak_pin', problem } | 401 | 403 { error: 'pin_locked' } | 409 { error: 'not_temporary' }
```

- Only while `users.pin_must_change` is true. The server checks `currentPin` against the stored verifier and the W0-10 PIN rules (`pinProblem`) for `newPin`, stores the new verifier, clears `pin_must_change`, and writes `pin.changed` to the audit log with the device.
- Wrong `currentPin` counts towards the same 5-try lock as unlocking.
- Other counters learn the new verifier at their next pull.

## 6. Push (W1-06)

To be specified with W1-06, following the invariants already fixed in the architecture (§5.2) and the `sync-protocol` skill: local-first write, batches of ≤ 100 in sequence order, idempotency by document UUIDv7, accept completed sales and record exceptions, quarantine instead of drop, sequence gaps, re-push after a restore.
