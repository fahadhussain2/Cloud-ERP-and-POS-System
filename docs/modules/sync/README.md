# Sync and offline (`SYN`)

| | |
|---|---|
| **Status** | Not started (build on hold, D-068) |
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

## Work in this module

- `spec.md`: only if needed (see above), written before the first plan that depends on it.
- `plans/<wave>-<nn>-<slug>.md`: one accepted plan per task, before any code ([delivery process](../../07-DELIVERY-PROCESS.md) §3).
- `intent.md`: only for changes after the MVP.
