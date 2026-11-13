# Sync protocol: spec

| | |
|---|---|
| **Status** | Accepted v1 (with the W1-02 plan, D-089): pull (2026-10-25). Catalog datasets: accepted with the W1-03 plan (2026-10-26). Checkout datasets and the sale document (§6.1): with the W1-06 plan (2026-10-27). Push (§6.2), gaps and re-push (§7) and the SSE nudge (§8): with the W1-07 plan and owner answers (2026-10-28), D-094. Customer datasets, the customer on the sale document and the credit exceptions: with the W1-09 plan and owner answers (2026-10-31), D-096. The cash queue, handovers and sessions in push and `queue-changed`: with the W1-10 plan and owner answers (2026-11-01), D-097. The desk's four cash-out datasets, collections, cash movements and the counted close in push: with the W1-11 plan and owner answers (2026-11-02), D-098. Voids (family `V`), the reissue on the sale document and the bill status call: with the W1-12 plan and owner answers (2026-11-03), D-099. The 90-day bill datasets, `SaleDocumentV2` for returns and their exceptions: with the W1-13 plan and owner answers (2026-11-03), D-100. |
| **Refs** | SYN-01…SYN-06; architecture §4.1, §5; data model §10, §12; CLAUDE.md rules 6–9; D-009, D-011, D-042, D-047 |

The architecture (§5) sets the principles. This spec fixes the contracts precisely enough to build and test them. **v1 covers pull**, which W1-02 (users and settings for unlock) and W1-03 (the catalog) need. The **sale document** a counter writes to its outbox is fixed with W1-06 (§6.1); **push**, server acceptance and exceptions (§6.2), gaps and re-push after a restore (§7) and the SSE nudge (§8) with W1-07.

## 1. Who may sync

- Only an **enrolled, active device** with a valid device token (`Authorization: Device <tenantId>.<token>`, D-082). Revoking a device deletes its tokens, so its next call is a plain `401`; when it asks for a new token, the challenge answers **`401 { error: 'device_revoked' }`** (platform spec §2) and the counter stops with its bills kept (POS spec §4).
- **Re-enable** (owner answer 3 to W1-07): a manager with `admin.devices` re-enables a revoked counter in the back office; it gets tokens again and pushes its waiting bills. The revocation is kept (`devices.last_revoked_at`, `reenabled_at`), and a document **created between the two** is accepted with a `revoked_device_doc` exception (§6.2).
- The challenge and token calls are limited to 30 a minute **per device**, not per IP: a shop's counters and cash desk share one public IP, and a 429 reads as offline on the counter (fix of 2026-11-05).
- **Offline wins over a late answer:** an answer that arrives after the browser said offline does not show the counter online; the reconnect retry does (fix of 2026-11-05).
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
- **Errors:** `400 { error: 'unknown_dataset' | 'bad_cursor' | 'bad_limit' }`, `401` for a missing, expired or revoked device token. Pull changes no business data; it only records its time on the device's health (`device_status.last_pull_at`, W1-07).

## 3. Datasets (v1)

Each dataset lists its columns explicitly. **A column not listed never leaves the server.** A test fails if a dataset returns any other column.

| Dataset | Table | Scope | Columns |
|---|---|---|---|
| `tenant` | `tenants` | the tenant | `id, name, base_currency, currency_minor_units, timezone, locale, tax_mode, cash_rounding_increment, day_cutoff_hour, closing_time, cash_handover_mode, offline_warning_hours, offline_strong_warning_hours, return_window_days, status, row_version, deleted_at` (the two warnings: SYN-06, W1-07; the return window: W1-13) |
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
| `item_floors` | `item_floors` | `item_id, floor, row_version, deleted_at` (W1-14: the floor from cost, one row per item with a known cost, keyed by `item_id`; never the cost itself) |

`legacy` (on every catalog table) never leaves the server.

**Checkout datasets (W1-06):**

| Dataset | Table | Scope | Columns |
|---|---|---|---|
| `payment_methods` | `payment_methods` | the tenant | `id, code, name, is_cash, requires_reference, is_active, sort, row_version, deleted_at`. **Never `bank_account_id`** (posting only). |
| `print_profiles` | `print_profiles` | the tenant | `id, name, paper_format, code_type, copies, template_options, is_tenant_default, row_version, deleted_at` |
| `device` | `devices` | **only the calling device's own row** | `id, code, print_profile_id, status, row_version, deleted_at`. **Never `public_key`** or who enrolled or revoked it. |

**Customer datasets (W1-09):** all scoped to the tenant. Names and phones are personal data: only these columns leave the server, and none is logged.

| Dataset | Table | Columns |
|---|---|---|
| `customers` | `parties`, **only parties with a live customer account** | `id, code, name, phones, city, status, row_version, deleted_at`. **Never `email`, `address`, `contact_person`, `tax_id`, `notes`, `label_abbr`, `country`, `legacy`.** |
| `customer_accounts` | `customer_accounts` | `id, party_id, price_tier_id, credit_allowed, credit_limit, offline_daily_cap, row_version, deleted_at`. **Never `payment_terms_days`, `legacy`.** |
| `customer_balances` | `party_balances`, **`role = 'customer'` only** | `party_id, balance, updated_at, row_version, deleted_at` (keyed by `party_id` on the counter; no row = 0) |

A party that gets its customer account after its own row was pulled (a supplier who starts buying) is sent again: a trigger on `customer_accounts` (insert, or a removed account restored) touches its `parties` row. A removed account arrives as a tombstone, and the counter stops listing the party.

**Cash desk dataset (W1-10):** pulled **only by a cash desk**; a counter that asks for it is answered `403 { error: 'not_cash_desk' }`, so a counter leaves it out of its pull.

| Dataset | Table | Scope | Columns |
|---|---|---|---|
| `cash_queue` | `sales_documents`, **the device's branch, `cash_due ≠ 0`, `handover_status = 'pending'` or received in the last 7 days**; a voided bill whose cash was taken stays until it is given back, and comes once more when it is (W1-23) | the branch | `id, number, device_id, salesperson_user_id, created_at_device, business_date, cash_due, cash_received, change_due, handover_status, status, return_of_number, void_number, cash_given_back_number, row_version, deleted_at` (the last three from W1-23, local schema 13). **No lines, customer, payload or signature.** |

`cash_received` and `change_due` are the cash payment's figures, set once by push (migration 0011). A bill handed over comes once more with its new status (a new `txid`, rule 8), so every desk drops it from its queue.

**What cash-out names (W1-11):** also pulled only by a cash desk (`403 not_cash_desk` for a counter).

| Dataset | Table | Columns |
|---|---|---|
| `suppliers` | `parties`, **only parties with a live supplier account** | `id, code, name, phones, city, status, row_version, deleted_at`. **Never** contacts, address, tax id, notes or `legacy`. |
| `supplier_balances` | `party_balances`, **`role = 'supplier'` only** | `party_id, balance, updated_at, row_version, deleted_at` (keyed by `party_id`) |
| `expense_categories` | `expense_categories` | `id, code, name, is_active, row_version, deleted_at`. **Never `gl_account_id`.** |
| `bank_accounts` | `bank_accounts` | `id, code, name, kind, is_active, row_version, deleted_at`. **Never `gl_account_id`.** |

**The branch's 90-day bills (W1-13, SYN-01):** pulled by every device of the branch, for returns (POS spec §19). Business date within the last 90 days (a day more on the server, so a counter ahead of the server's date gets all 90; the counter prunes to its own business date at start-up). The lines and payments come with their bill. No legacy bills (owner answer 4 to W1-13, D-100).

| Dataset | Table | Columns |
|---|---|---|
| `bills` | `sales_documents`, the device's branch | `id, number, device_id, kind, status, business_date, created_at_device, customer_party_id, walkin_phone, total, return_of_id, row_version, deleted_at`. **Never** the payload, signature, cash figures or void fields. The walk-in phone is personal data: for the lookup by phone, never logged or printed. |
| `bill_lines` | `sales_lines` of those bills | `id, document_id, line_no, item_id, qty, unit_price, line_total, original_line_id, row_version, deleted_at` (a returned line has `qty` below 0 and its `original_line_id`, so the pulled lines say what came back already). **Never** cost, tax, location or the return's reason. |
| `bill_payments` | `sales_payments` of those bills | `id, document_id, method_id, amount, row_version, deleted_at`. **Never** a reference or the cash figures. |

A voided bill comes once more with its status (a new `txid`, rule 8). Quantities are sent as numeric text (`-1.000`) and kept as whole thousandths on the counter (ColumnType `qty`).

**Stock on the counter (W1-27, POS-02):** pulled by every device of the branch, scoped to **the device's branch and its shop- and storage-kind locations** (Shop, Godown; never Damaged or In transit). Never cost or value.

| Dataset | Table | Columns |
|---|---|---|
| `locations` | `locations`, the branch's `shop` and `storage` kinds | `id, code, name, kind, row_version, deleted_at` |
| `stock_balances` | `stock_balances` of those locations | `item_id, location_id, qty, row_version, deleted_at` (keyed by item and location on the counter; `qty` as numeric text, kept as thousandths). Posting gives every changed balance a new `txid`, so a sale anywhere reaches every online counter with the nudge |

**Bootstrap:** the first pull simply starts from the beginning, in full pages of 1,000 rows (about 125k catalog rows for Delux). An interrupted first load resumes from the last committed page. Measured in W1-03 on the real catalog: **31 seconds** from setup to search, under the 60-second rule, so there is no snapshot download. Revisit if a tenant's catalog is much larger.

## 4. When the counter pulls

- At startup (after the storage checks), after each unlock, on each SSE nudge (`changes-available`, §8), and with the **60-second timer**: every minute without the nudge, every 5 minutes while it is connected.
- A successful pull, like a successful push, is **contact**: `sync_state.last_contact_at`, which the offline warnings count from (POS spec §7). Its time is also recorded on the server for device health (§6.2).
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

**PIN events waiting for push:** locks and manager unlocks are kept in the counter's `pin_events` table (data model §12) with a device-made UUIDv7. **Push sends them** (§6.2) for the server's audit log (`pin.locked`, `pin.unlocked_by_manager`, with the device), idempotent by id, and sets `pushed_at`.

## 6. Documents and push

### 6.1 The sale document (W1-06)

What a counter writes to `local_documents` and the `outbox` when a bill is finalized (POS spec §12), and what push sends. `SaleDocumentV1` in `@erp/contracts` (zod) is the contract; `buildSaleDocument` in `@erp/domain` makes it, and a test checks every built document against the schema. Money is whole minor units and quantities are thousandths, as JSON integers (rule 1); ids are UUIDs; times are ISO 8601 UTC.

| Field | Content |
|---|---|
| `version` | `1` |
| `id` | UUIDv7 made on the counter: the idempotency key (rule 7) |
| `family`, `seq`, `number` | `'S'`, the sequence from `local_series` (≥ 1), `C03-S000412` |
| `kind` | `'sale'` (a return or exchange is version 2, below) |
| `deviceId`, `branchId` | from `meta` |
| `createdAt`, `businessDate` | the counter's clock at finalize; `YYYY-MM-DD` with the tenant's cutoff (D-056) |
| `sellerId`, `tierId` | who was unlocked; the bill's tier |
| `customerId`, `walkinPhone` | the customer's party id, or `null` for a walk-in; the walk-in's phone through `normalizePhone`, only without a customer, else `null` (W1-09) |
| `lines[]` | `lineNo` (1…), `itemId`, `qty`, `listPrice` (null without one), `floorPrice` (null = unknown), `unitPrice`, `lineDiscount` (list amount − amount; negative above list), `billShare` (its part of the bill discount), `lineTotal` (amount − bill share) |
| `amounts` | `subtotal` (sum of list amounts), `lineDiscountTotal`, `billDiscount`, `rounding`, `taxTotal` (0), `total`. Always `subtotal − lineDiscountTotal − billDiscount + rounding = total` |
| `payments[]` | `method` (payment method code), `amount`, `cashReceived` and `changeDue` (cash only, else null), `reference` (null when none). Amounts add up to `total` |
| `cashDue`, `handoverStatus` | the cash amount (0 without cash); `'pending'` when above 0, else `'not_applicable'` |
| `overrides[]` | each approval on the bill (POS spec §10, §15): `kind` (`below_list` \| `below_floor` \| `credit_limit` \| `offline_cap`), `lineNo` (null for the bill discount and for credit), `requestedBy`, `approvedBy`, `reason`, `note`, `at`, `values` (a line: `list`, `floor`, `price`; the bill: `billDiscount` and `lines` as `lineNo`, `qty`, `unitPrice`; `credit_limit`: `limit`, `balance`, `unsynced`, `amount`; `offline_cap`: `cap`, `offlineToday`, `amount`) |
| `credit` | optional, only on a bill with an on-account payment (W1-09): `offline`, `balance`, `balanceAsOf`, `unsynced`, `offlineToday`, what the counter saw when it decided (POS spec §15) |
| `reissueOf` | optional, only on a reissue (W1-12): the voided bill's `id` and `number` (POS spec §18) |
| `clientVersion` | the app version |

**`SaleDocumentV2`** (W1-13, POS spec §19, D-100): a return or exchange, written only for a bill with returned lines (a plain sale stays V1, and push takes both). As V1, plus:

| Field | Content |
|---|---|
| `version`, `kind` | `2`; `'return'` (only returned lines) or `'exchange'` (sold lines too) |
| `lines[]` | **the returned lines first**: `qty` below 0, `listPrice` and `floorPrice` null, `unitPrice` the refund each, `lineDiscount` and `billShare` 0, `lineTotal` −refund, `returnOf` (`documentId`, `number`, `lineNo` of the original line; null without a receipt), `reason`, `condition` (`resellable` \| `defective`), `note`; then the sold lines as on a sale |
| `amounts.returnTotal` | the refunds, above 0: `subtotal − lineDiscountTotal − billDiscount − returnTotal + rounding = total` |
| `amounts.total`, `cashDue` | may be below 0 (a refund; a cash refund is a payout at the desk) or 0 (an even exchange, no payment). `handoverStatus` is `'pending'` whenever the cash due isn't 0 |
| `payments[]` | as on a sale; or one refund row (negative): `cash` (no cash received or change), `on_account`, or a bank or wallet method with its reference; none for an even exchange |
| `overrides[]` | as on a sale (lines numbered after the returned ones), then the return's: `return_permission`, `return_outside_policy` (values `{}`), `no_receipt_return` (values: each line's `suggested` and approved `price`), `refund_transfer` (values: `method`, `amount`); `lineNo` null, reasons as POS spec §19 |
| `returnOf` or `noReceipt` | the original bill's `id`, `number`, `businessDate`; or `{ ref }` (an old bill's number, or null) |

The outbox row's `signature` is the device's ECDSA signature over `canonicalJson(document)` (D-082), added right after the commit. A later version of the document adds a new schema next to v1; the server keeps accepting v1 (architecture §4.2). W1-09's fields are additive and optional, so every v1 bill written before still parses (D-096).

### 6.2 Push (W1-07)

SYN-02, SYN-03, PLT-09, D-011. The contract is `PushRequestSchema` / `PushResponseSchema` in `@erp/contracts`.

```
POST /api/sync/push   (device token, body up to 5 MB)
{ clientVersion, schemaVersion, deviceClock, health, documents: [{ id, family, seq, payload, signature }], events: [...] }
→ 200 { serverTime, results: [{ id, status, exceptions, error }], series: [{ family, through, missing }], events: [ids] }
→ 400 { error: 'invalid_request' } | 401
```

**The request.**

- `documents`: at most **100**, unique ids, in ascending `seq` within each family (`S`, `H`, `R`, `M`, `Z`, `V`). Any device sends its voids (`V`, `SaleVoidV1`, W1-12). A cash desk also sends its handovers (`H`, `CashHandoverV1`) and its sessions' open and close (`Z`, `CashSessionV2`; a W1-10 `CashSessionV1` close is still taken), its collections (`R`, `CustomerCollectionV1`) and its cash movements (`M`, `CashMovementV1`, W1-11). Each is an outbox row: the document's UUIDv7 (the idempotency key, rule 7), its family and seq, the payload exactly as the device stored it, and its `signature` (base64url P1363 over `canonicalJson(payload)`, D-082), or `null` when the counter couldn't sign it.
- `events`: at most 500 audit events (§5, POS spec §13): `pin.locked` `{ id, at, userId }`, `pin.unlocked_by_manager` `{ id, at, userId, byUserId }`, `bill.reprinted` `{ id, at, userId, documentId, number }`.
- `health` (PLT-09): `outboxCount` (refused bills included), `oldestUnsyncedAt`, `quarantinedCount`, `storagePersisted`, `storageUsage`, `storageQuota`, `lastPullAt`.
- **An empty push is the handshake:** no documents, no events. The counter sends one at start-up, so a restored server is noticed even when nothing is waiting (§7).
- A malformed request is `400` as a whole; a malformed **document** is answered on its own, so one bad bill never refuses the rest.

**Each document, in its own database transaction** (`apps/api/src/sync/push.ts`):

1. **Claim** its id in `sync_inbox` (`INSERT … ON CONFLICT DO NOTHING`). Two pushes of one id wait for each other on that row, so only one can accept it.
2. **Already accepted:** the same payload hash → `duplicate`, with the stored result; another hash → `rejected: id_conflict` (the stored document is kept). **Already rejected:** checked again, since it may come back fixed.
3. **Trusted and storable?** In this order, the first failure is the answer:

| Error | When |
|---|---|
| `unsigned` | `signature` is null |
| `bad_signature` | it doesn't verify with the key of the device the payload names. Also written as a `bad_signature` exception (severity high). Well signed by **another** device → `wrong_device` |
| `bad_schema` | the payload fails `SaleDocumentV1` (an unknown `version` included), or its `id`, `seq` or family differ from the row's |
| `wrong_device` | another device's document (a counter pushes only its own, owner answer 3 to W1-07), or another branch's; an `H`, `R`, `M` or `Z` from a device that isn't a cash desk; a `V` of a bill whose number isn't the pushing device's (owner answer 2 to W1-12) |
| `unknown_reference` | a seller, approver, requester, tier, item, payment method or customer that isn't this tenant's; a handover's, collection's or cash movement's cashier; a collection's payment method; a session close naming a session the server doesn't have (the desk pushes the open first); a void's voider or approver. A collection's customer and a cash movement's category, supplier or bank are not checked: such a document is stored and fails to post until they exist (D-095). **A handover's bill is never checked:** it is linked by number, now or when the bill arrives |
| `seq_conflict` | another id already holds this device's seq |

4. **Re-check the rules** with `reviewSale` (`packages/domain`, the counter's own functions, rule 2), and for a bill with an on-account payment `reviewCredit` against the customer's account, its balance, read under the tenant's posting order lock (`holdPostingOrder`, D-017), so no other posting moves it before this sale is posted, and the device's offline on-account total for that customer and business date. Neither refuses: their findings become exceptions (below).
5. **Store** `sales_documents` (with the payload, its hash and the signature), `sales_lines` (with the branch's SHOP location), `sales_payments`, `overrides` and the exceptions; `exception_count` on the document.
6. **Record** the result in `sync_inbox` and update the device's series (§7). Posting joins this transaction in W1-08.

An unexpected error rolls back that document and answers `500`; the documents before it stay stored, and the counter's next push sends the rest again (idempotent).

**The answer per document:** `{ id, status: 'accepted' | 'duplicate' | 'rejected', exceptions: [kind], error: <code> | null }`, in the request's order. `series` (§7) and the stored `events` ids follow; `serverTime` lets the counter show its clock difference.

**Exceptions** (data model §10), each with the document, the device, the seller, the business date and details:

| Kind | Severity | Raised by |
|---|---|---|
| `below_floor_no_override` | medium | a line below its floor, or without a list price, with no approval that covers it from someone holding `pos.price.below_floor` (`details.cause`: `no_approval`, `not_covered`, `not_permitted`) |
| `discount_over_limit` | medium | a line or the bill discount past the seller's limit, with no covering approval from someone whose `pos.override.approve` limit reaches it |
| `document_inconsistent` | high | figures that don't add up (`details.code`: `number`, `business_date`, `line_numbers`, `line_amounts`, `amounts`, `rounding`, `tender`, `payments`, `cash_due`, `handover_status`). Accepted and flagged (owner answer 2 to W1-07) |
| `credit_limit_exceeded` | medium | an on-account amount that takes the server's balance (every counter's sales) over the limit without a covering `credit_limit` approval from someone holding `pos.credit.over_limit` (`details.cause`: `no_approval`, `not_permitted`, `credit_not_allowed`, `seller_not_permitted`; with the server's and the counter's figures) |
| `offline_cap_exceeded` | medium | an offline bill that takes the device's offline on-account total for the customer on that business date over the cap without a covering `offline_cap` approval |
| `revoked_device_doc` | high | made between the device's revocation and its Re-enable (§1) |
| `seq_gap` | medium | a seq above the next expected one (§7) |
| `clock_skew` | low | `serverTime − deviceClock` over 5 minutes either way; once per device and business day, with the health, not on a document |
| `bad_signature` | high | on the refusal above |
| `handover_amount_mismatch` | medium | a handover whose amount, or direction, differs from its bill's cash due, once both are on the server (D-059; `details`: `amount`, `billCashDue`, `handoverKind`) |
| `duplicate_handover` | medium | a second handover of a bill and kind: stored with `duplicate_of_id`, never posted, the bill unchanged |
| `handover_not_permitted` | low | the server says the cashier lacks `cash.handover.receive` (or `cash.refund.pay` for a payout) |
| `cash_not_permitted` | low | a collection, cash movement, open or close by someone the server says lacks the permission, or a close acknowledged by someone without `cash.variance.approve` or by the session's own cashier (`details.ownVariance`); that acknowledgement isn't stored (W1-11) |
| `float_mismatch` | medium | an open's float differs from what stayed at the desk's last close (`details`: `openingFloat`, `floatExpected`) |
| `void_not_permitted` | medium | a void whose approver the server says lacks `pos.void` or has the window `none`, or of a bill of another business day (`details.cause`: `not_permitted`, `window_none`, `other_day`, W1-12). The void stands |
| `duplicate_void` | medium | a second void of a bill: stored with `duplicate_of_id`, never posted |
| `cash_received_for_void` | high | a handover in of a voided bill (D-059), on the void or on the handover, whichever arrives second (`details.order`: `before_void`, the desk took the cash before the void; `after_void`, after it). The handover still posts |
| `return_over_quantity` | high | a returned line takes more than was sold minus what other returns took, usually two counters offline (`details`: `lineNo`, `sold`, `returnedBefore`, `qty`; W1-13) |
| `return_original_invalid` | medium | a returned line's original isn't on the server, is voided, is another item, or is itself a returned line (`details.cause`: `missing`, `voided`, `other_item`, `returned_line`) |
| `return_price_mismatch` | medium | a linked refund other than `refundFor` gives on the server's figures, or a no-receipt refund other than its approved price (`details.cause`: `linked`, `no_receipt`; `expected`, `refund`) |
| `return_not_permitted` | medium | a return's need with no approval, or approved by someone the server says lacks the permission (`details.cause`: `permission`, `outside_policy`, `no_receipt`, `transfer`; `approval`: `missing`, `not_permitted`) |

**Handovers (W1-10, cash desk spec §13):** stored in `cash_handovers`, linked to their bill by number and the bill marked `received` or `paid_out`; one whose bill hasn't arrived waits and is linked when the bill is accepted, its amount compared then. A bill with cash and a handover of it take a **per-bill lock** first (`pg_advisory_xact_lock`), before the posting order lock, because a scan and its bill often arrive in overlapping transactions. Each handover that isn't a duplicate is posted in the same transaction. A session's open creates its `cash_sessions` row and its close sets the close fields and the count (W1-11); each posts (source `cash_session`): the open a float other than what stayed, the close its variance and what went to the safe. **Collections and cash movements (W1-11)** are stored in `payments` and `cash_movements` and posted in the accepting transaction (sources `payment`, `cash_movement`).

**From W1-23 (D-111)** a counter pushes voids as `SaleVoidV2` (with `paymentChecks`; one whose checks say the money had arrived is flagged `void_not_permitted`, cause `money_arrived`) and a desk its cash movements as `CashMovementV2` (the kind `void_cash`, cash desk spec §12a); push still takes V1 of both. A desk's payout of a return before its original bill's handover is flagged `refund_before_payment`.

**Voids (W1-12, POS spec §18):** stored in `sales_voids`, linked to their bill by number under the same per-bill lock as a handover (every sale takes it now); one whose bill hasn't arrived waits and is applied when the bill is accepted. Reviewed with `reviewVoid` against the server's roles, the bill (or the document's own dates before it arrives) and any handover in of the number, an offline scan included. The bill becomes `voided` (its void fields, an `overrides` row of kind `void`, the audit row `sale.voided`), its row comes again in `cash_queue` with its status, so every desk drops it, and its posting is reversed (source `sales_void`) once the bill has posted. A sale's `reissueOf` is stored on it as `reissue_of_id`, `reissue_of_number`.

**Returns (W1-13, POS spec §19):** a `SaleDocumentV2` goes through the same checks (`bad_schema` against V2 when its `version` is 2), then the **original bill's per-bill lock** too, so returns of one line are judged one after the other; `reviewReturn` (`packages/domain`) against the original as the server holds it (what other returns took of each line), the categories' policies, the tenant's `return_window_days` and the roles; `reviewSale` checks its figures, and a refund to account isn't judged as credit. Stored with `return_of_id`, `return_of_number`, `no_receipt`, `no_receipt_ref`; each returned line with its `original_line_id` (only when that is the same item and a sold line), reason, condition, note, and the branch's DAMAGED location for a defective line. Posted (source `sale`) at once, or, when its original hasn't posted, right after it (push and the catch-up).

**The bill status call (W1-12):**

```
GET /api/sync/bills/status?number=C03-S000412   (device token)
→ 200 { known, status, handoverStatus, handedOverAt, cashierName }   (BillStatusResponseSchema)
→ 400 { error: 'invalid_request' } | 403 { error: 'not_own_bill' } | 401
```

Only the device's own bills (the number carries its code). `handoverStatus` is the bill's, or `received` / `paid_out` from a handover of its number that the bill doesn't have yet (an offline scan); null when the server has neither. The counter asks it before a void, for at most 3 s (POS spec §18).

Prices and floors are judged on the **document's own snapshot**: a price changed in the back office during an outage is expected and not flagged (architecture §4.7). Approvals are judged against the roles the server holds now.

**Audit events** are written to `audit_log` with their device-made id as the row's id (`ON CONFLICT DO NOTHING`, so a re-send is stored once), the counter's time as `at`, and the device: `pin.locked` (entity `users`, the person), `pin.unlocked_by_manager` (`users`, the person; `user_id` the manager), `bill.reprinted` (`sales_documents`, the bill; `after` the number). The answer lists every id now stored; the counter marks them pushed.

**Health:** every push, the handshake included, upserts `device_status` with the health, the versions and the clock difference. The counter reports its outbox as it was before sending, so the server subtracts the bills this push delivered (and clears the oldest when none are left) and adds the ones it refused. Pull records its own time there too.

**Logs** (architecture §11.2): each document's result, kinds and duration against its id; each push's counts and client version. Never the payload, the signature or the token.

**The counter's side** (`apps/pos/src/sync/push.ts`, POS spec §12):

- One push at a time, in rounds of up to 100 until a short batch with nothing put back (at most 200 rounds). Unsigned rows are signed first and keep their signature.
- **When:** at start-up (the handshake), right after every finalize (SYN-02: the bill reaches the server in seconds, not on a timer), when the network comes back, and with the 60-second timer.
- **Failures:** offline or a server error retries after **2 s, doubling to 5 minutes, times a jitter of 50–100%**; the next finalize or reconnect tries at once. A refused token is renewed once. A revoked counter stops (§1); otherwise refused waits for the next trigger.
- **The answer in one local transaction** (`ackPush`): `accepted` and `duplicate` rows leave the outbox, their signature kept on the local document, and `pushed_through:<family>` rises; `rejected` rows become `quarantined` with the error and stay (rule 9) under *Needs attention* (POS spec §14). `last_push_at` and `last_contact_at` are recorded.

## 7. Sequence gaps and re-push after a restore (W1-07)

SYN-05, architecture §5.2 and §5.4.

**On the server**, per device and family, `device_series` keeps `through` (every seq from 1 to it has arrived) and `max_seq`. Arrived means present in `sync_inbox`, accepted or rejected: a rejected document is waiting on the counter, not missing.

- A seq above `max_seq + 1` opens a row in `sequence_gaps` (`from_seq`, `to_seq`) and a `seq_gap` exception.
- A seq inside an open gap resolves it once every seq of the range has arrived (`resolved_at`).
- `through` then moves up over every seq now present.

**Every answer** carries `series`: for each family the device has on the server, `{ family, through, missing: [[from, to], …] }`, the ranges above `through` the server lacks. A family the server doesn't list is one it has nothing of.

**On the counter** (`requeue`, `apps/pos/src/db/outbox.ts`), after every answer: for each family, the documents in `local_documents` that the server lacks (its missing ranges, and everything from its `through + 1` up to the counter's own `pushed_through`) go back into the outbox with their stored payload and signature, at most **30 days** old and never twice. The push loop sends them in the next round. Idempotency (rule 7) makes repeating this safe.

**After a server restore** to before some bills, the counter's next push, the start-up handshake at the latest, gets a lower `through` (or no family at all) and puts every lost bill back, and re-sends them. Bills older than 30 days stay as gaps on the server's side, shown on device health (PLT-09) and in the [sequence gap runbook](../../runbooks/sequence-gap.md).

## 8. The SSE nudge (W1-07)

SYN-04, architecture §5.3.

```
GET /api/sync/events   (device token)
→ 200 text/event-stream
: connected
event: changes-available
data: {}
```

- **On the server:** every pulled table (§3) has statement triggers that send its tenant's id on the `erp_sync` channel after a change (`pg_notify`; PostgreSQL folds repeats in one transaction, so a large import is one notice). The API holds **one `LISTEN` connection** (`createChangeFeed` in `packages/db`), opened by the first stream and reopened 5 s after it drops, and tells that tenant's streams, **at most once per 2 seconds** (a burst gives one event at its start and one at its end).
- The stream opens with a `: connected` comment, writes `: keep-alive` every 25 s, and **ends after 15 minutes**, the device token's life.
- **On the counter** (`apps/pos/src/sync/events.ts`): read with `fetch`, because `EventSource` can't send the device token. Each `changes-available` pulls at once. A stream that ends after running its course reconnects at once with a new token; one that fails or drops within a minute backs off like push. While the stream is up, the minute timer pulls only every 5 minutes as a safety net (§4).
- **Caddy** serves `/api/sync/events` on its own route, flushed at once and never compressed (`infra/edge/caddy/Caddyfile`).
- **`queue-changed` (W1-10):** a change to a bill with cash due ≠ 0 notifies its own channel, `erp_queue`, with `<tenant>:<branch>` (migration 0011); the API sends `event: queue-changed` only to that branch's **cash desk** streams, throttled like `changes-available`. `sales_documents` has no `erp_sync` trigger, so counters aren't woken by every bill. The desk pulls on it as on `changes-available`.
