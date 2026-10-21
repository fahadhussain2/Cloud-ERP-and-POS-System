---
name: sync-protocol
description: Offline-first sync between POS devices and the server (outbox push, change-feed pull, idempotency, sequence gaps, signatures, bootstrap, SSE nudge, local SQLite/OPFS storage guardrails). Use whenever writing or reviewing sync endpoints, the POS outbox or local database, device enrollment, or anything that runs while a counter is offline.
---

# Sync protocol

**Source of truth:** `docs/02-ARCHITECTURE.md` §4–§5 (offline design, sync), `docs/03-DATA-MODEL.md` §10 and §12 (sync tables, POS local schema), D-009, D-010, D-011, D-042, D-047.

## Invariants
1. **Local-first writes:** in **one SQLite transaction**, allocate the sequence → insert the document → insert the outbox row → update overlays. Only then print.
2. **Push** in sequence order, batches ≤ 100, retried with backoff. An outbox row is removed only after an `accepted` or `duplicate` ack. `rejected` goes to quarantine, **never silently dropped**.
3. **Idempotency:** the document UUID (UUIDv7, made on the device) is the key. Re-sending is always safe and returns the stored result.
4. **The server accepts completed sales** and records exceptions for rule breaks. It rejects only malformed, unauthenticated or badly signed payloads.
5. **Server per document, one transaction:** verify device token + ECDSA signature → validate schema (`packages/contracts`) → re-validate rules (`packages/domain`) → insert → run posting (`packages/posting`) → record in `sync_inbox`.
6. **Pull cursor** = (`txid` `xid8`, `row_version`), returning only rows with `txid < pg_snapshot_xmin(pg_current_snapshot())`. **Never** `updated_at` or a plain sequence (they skip rows under concurrency). Deletes are soft (tombstones).
7. **Sequence gaps** are recorded and re-requested, and shown on the device health page.
8. **Never drop or rebuild the local DB while the outbox has rows.** Schema migrations run in place.
9. **Storage guardrails:** selling is blocked until `navigator.storage.persist()` is granted and the local DB health check passes.
10. **Online nudge:** push immediately on finalize. SSE `changes-available` / `queue-changed` triggers a pull; poll every 60 s without SSE.
11. **Disaster recovery:** devices keep 30 days of their own documents and can re-push them after a server restore.

## Test matrix (must exist)
Duplicate push · out-of-order batch · sequence gap · server restore + re-push · concurrent back-office edits during pull (no skipped rows) · offline handover scanned before the bill syncs · bad signature · revoked device.
