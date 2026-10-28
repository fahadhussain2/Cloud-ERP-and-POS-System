# Sync and offline (`SYN`)

| | |
|---|---|
| **Status** | In progress: spec v1 accepted; pull built (W1-02, W1-03, W1-06); push, gaps, re-push and the SSE nudge built with W1-07 (in review) |
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

## Push, gaps, the nudge (W1-07, D-094)

- `POST /api/sync/push` (`apps/api/src/sync/push.ts`): each document in its own transaction, claimed in `sync_inbox`, verified with its device's key, checked against `SaleDocumentV1`, re-checked with `reviewSale` (`packages/domain`) and stored with its exceptions; refused only when it can't be trusted or stored (spec §6.2). Audit events and the counter's health ride along.
- Every answer lists each series' `through` and missing ranges; the counter puts back what the server lacks from its 30-day copy, so a server restore heals itself (spec §7).
- `GET /api/sync/events` streams `changes-available` from the `erp_sync` notices (`createChangeFeed`, `packages/db/src/listen.ts`); Caddy passes it unbuffered (spec §8).
- The counter (`apps/pos/src/sync/push.ts`, `events.ts`, `db/outbox.ts`): push at start-up, after every finalize, on reconnect and every minute, with backoff; refused bills wait under *Needs attention* (POS spec §14).
- Runbooks: [a bill needs attention](../../runbooks/bill-needs-attention.md), [sequence gap](../../runbooks/sequence-gap.md).

## Work in this module

- `spec.md`: only if needed (see above), written before the first plan that depends on it.
- `plans/<wave>-<nn>-<slug>.md`: one accepted plan per task, before any code ([delivery process](../../07-DELIVERY-PROCESS.md) §3).
- `intent.md`: only for changes after the MVP.
