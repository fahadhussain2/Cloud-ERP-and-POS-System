# Sync protocol: spec

| | |
|---|---|
| **Status** | Accepted v1 (with the W1-02 plan, D-089): pull (2026-10-25). Catalog datasets: accepted with the W1-03 plan (2026-10-26). Checkout datasets and the sale document (§6.1): with the W1-06 plan (2026-10-27). Push itself is added with W1-07. |
| **Refs** | SYN-01…SYN-06; architecture §4.1, §5; data model §10, §12; CLAUDE.md rules 6–9; D-009, D-011, D-042, D-047 |

The architecture (§5) sets the principles. This spec fixes the contracts precisely enough to build and test them. **v1 covers pull**, which W1-02 (users and settings for unlock) and W1-03 (the catalog) need. The **sale document** a counter writes to its outbox is fixed with W1-06 (§6.1); **push**, server acceptance, gaps and re-push after a restore are specified with W1-07.

## 1. Who may sync

- Only an **enrolled, active device** with a valid device token (`Authorization: Device <tenantId>.<token>`, D-082). A revoked device gets `401` on its next call; documents it made before are still accepted later (push, W1-07).
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

`legacy` (on every catalog table) never leaves the server.

**Checkout datasets (W1-06):**

| Dataset | Table | Scope | Columns |
|---|---|---|---|
| `payment_methods` | `payment_methods` | the tenant | `id, code, name, is_cash, requires_reference, is_active, sort, row_version, deleted_at`. **Never `bank_account_id`** (posting only). |
| `print_profiles` | `print_profiles` | the tenant | `id, name, paper_format, code_type, copies, template_options, is_tenant_default, row_version, deleted_at` |
| `device` | `devices` | **only the calling device's own row** | `id, code, print_profile_id, status, row_version, deleted_at`. **Never `public_key`** or who enrolled or revoked it. |

Customers (W1-09), stock balances (W1-08) and the 90-day bills (W1-13) are added by their tasks with the same rules.

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

**What a pull changes about PINs on the counter (W1-04):**
- A **new `pin_verifier`** for a person clears their lock on that counter: the lock protected the old PIN. This is how the owner unlocks someone remotely (a new temporary PIN from the back office).
- A person who comes back **disabled, deleted or without a PIN** is dropped from the staff list, and if they are the one unlocked, the counter **locks at once**.

**PIN events waiting for push:** locks and manager unlocks are kept in the counter's `pin_events` table (data model §12) with a device-made UUIDv7. **Push (W1-07) sends them** for the server's audit log (`pin.locked`, `pin.unlocked_by_manager`, with the device), idempotent by id, and sets `pushed_at`.

## 6. Documents and push

### 6.1 The sale document (W1-06)

What a counter writes to `local_documents` and the `outbox` when a bill is finalized (POS spec §12), and what push sends. `SaleDocumentV1` in `@erp/contracts` (zod) is the contract; `buildSaleDocument` in `@erp/domain` makes it, and a test checks every built document against the schema. Money is whole minor units and quantities are thousandths, as JSON integers (rule 1); ids are UUIDs; times are ISO 8601 UTC.

| Field | Content |
|---|---|
| `version` | `1` |
| `id` | UUIDv7 made on the counter: the idempotency key (rule 7) |
| `family`, `seq`, `number` | `'S'`, the sequence from `local_series` (≥ 1), `C03-S000412` |
| `kind` | `'sale'` (returns and exchanges come with W1-13) |
| `deviceId`, `branchId` | from `meta` |
| `createdAt`, `businessDate` | the counter's clock at finalize; `YYYY-MM-DD` with the tenant's cutoff (D-056) |
| `sellerId`, `tierId` | who was unlocked; the bill's tier |
| `customerId`, `walkinPhone` | `null` (W1-09) |
| `lines[]` | `lineNo` (1…), `itemId`, `qty`, `listPrice` (null without one), `floorPrice` (null = unknown), `unitPrice`, `lineDiscount` (list amount − amount; negative above list), `billShare` (its part of the bill discount), `lineTotal` (amount − bill share) |
| `amounts` | `subtotal` (sum of list amounts), `lineDiscountTotal`, `billDiscount`, `rounding`, `taxTotal` (0), `total`. Always `subtotal − lineDiscountTotal − billDiscount + rounding = total` |
| `payments[]` | `method` (payment method code), `amount`, `cashReceived` and `changeDue` (cash only, else null), `reference` (null when none). Amounts add up to `total` |
| `cashDue`, `handoverStatus` | the cash amount (0 without cash); `'pending'` when above 0, else `'not_applicable'` |
| `overrides[]` | each approval on the bill (POS spec §10): `kind` (`below_list` \| `below_floor`), `lineNo` (null for the bill discount), `requestedBy`, `approvedBy`, `reason`, `note`, `at`, `values` (a line: `list`, `floor`, `price`; the bill: `billDiscount` and `lines` as `lineNo`, `qty`, `unitPrice`) |
| `clientVersion` | the app version |

The outbox row's `signature` is the device's ECDSA signature over `canonicalJson(document)` (D-082), added right after the commit. A later version of the document adds a new schema next to v1; the server keeps accepting v1 (architecture §4.2).

### 6.2 Push (W1-07)

To be specified with W1-07, following the invariants already fixed in the architecture (§5.2) and the `sync-protocol` skill: local-first write, batches of ≤ 100 in sequence order, idempotency by document UUIDv7, accept completed sales and record exceptions, quarantine instead of drop, sequence gaps, re-push after a restore.
