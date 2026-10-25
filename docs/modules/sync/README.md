# Sync and offline (`SYN`)

| | |
|---|---|
| **Status** | In progress: spec v1 (pull) accepted; pull built with W1-02 (in review) |
| **Requirements** | 6 (SYN-01…SYN-06) |
| **Feature spec needed** | Yes: the sync protocol (push/pull contracts, cursor, gap handling) |

## Scope

What each counter holds locally, outbox push, server acceptance and exceptions, change-feed pull, nudges, re-push after restore, offline warnings.

## Requirements

Full wording is in [the PRD](../../01-PRD.md). Wave 1 = critical path for go-live, Wave 2 = rest of the MVP.

| ID | Summary | Wave |
|---|---|---|
| SYN-01 | Each counter holds a local copy of: catalog, identifiers, vehicle tags, prices, floors, customers (with balance snapshot and limits), users/PIN verifiers,… | 1 |
| SYN-02 | Upload of finalized documents through an outbox. | 1 |
| SYN-03 | The server never rejects a completed sale on business-rule grounds. | 1 |
| SYN-04 | Incremental download of reference data changes, plus a "changes available" push when online. | 1 |
| SYN-05 | After a server restore, a counter can re-push its last 30 days of documents safely (deduplicated by ID). | 1 |
| SYN-06 | Warnings when offline beyond configurable thresholds (e.g. | 1 |

## Related

Architecture §4–§5; data model §10, §12; D-009, D-011, D-042

## Pull (W1-02, D-089)

- `GET /api/sync/pull?datasets=tenant,branch,users,roles,user_roles&cursor=…&limit=…` with `Authorization: Device <tenantId>.<token>` (`apps/api/src/sync/routes.ts`). The cursor is opaque (base64url JSON of `{ dataset: { txid, rowVersion } }`); rows come from `pullColumns` (`packages/db/src/sync.ts`) on the xid8 cursor (rule 8).
- Each dataset lists its columns; nothing else leaves the server (`password_hash` never does). Branch-scoped datasets are filtered to the device's branch.
- The counter (`apps/pos/src/sync/pull.ts`) pulls page by page and applies each page with its cursor in one local transaction (`repo.applyPull`). A refused token is renewed once.
- `POST /api/sync/pin`: the counter changes a temporary PIN to the person's own (spec §5).

## Work in this module

- `spec.md`: only if needed (see above), written before the first plan that depends on it.
- `plans/<wave>-<nn>-<slug>.md`: one accepted plan per task, before any code ([delivery process](../../07-DELIVERY-PROCESS.md) §3).
- `intent.md`: only for changes after the MVP.
