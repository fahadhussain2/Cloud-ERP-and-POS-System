# W1-14 follow-up: the pilot wipe removes every counter

| | |
|---|---|
| **Module** | migration (the cutover's pilot wipe), with sync (device access) |
| **Status** | Accepted (owner, 2026-11-24, in chat) |
| **Refs** | D-101 (the pilot wipe), D-123 (this change), sync spec §1 (revoke and Re-enable) |
| **Size** | about ½ day: the wipe ¼, tests and docs ¼ |

## Why

On staging (24 Nov) the owner revoked the cash desk D01 while it still had documents waiting, ran the wipe, then re-enabled D01. The desk pushed its old pilot documents into the wiped books, and they showed on the dashboard.

Two gaps let that happen:

- The wipe revokes only **active** counters. An already revoked one stays revoked, and Re-enable still works on it.
- Re-enable can't tell a counter revoked by the wipe from one revoked by mistake.

On 31 Dec the same click would put pilot documents into the go-live books, after which the wipe is refused.

## What changes

- **The wipe marks every counter deleted** (`devices.deleted_at`), active or revoked, and revokes the active ones as before, in its one transaction. The rows stay (a soft delete).
- **Nothing else changes in code.** Device sign-in, tokens, the challenge and Re-enable already refuse a deleted counter (`deleted_at IS NULL`). The Counters screen, device health, the dashboard and Day reconciliation already hide one.
- **Codes are never reused.** A new code is the highest code ever used plus one, deleted counters included. After a pilot with C01–C03 and D01, go-live counters start at C04 and D02. So a pilot bill a customer brings back (`C03-S000045`) never matches a go-live bill; it is a no-receipt return (D-101).
- The wipe's report says *removed* instead of *revoked*. The day-to-day revoke and Re-enable are unchanged.

## Alternatives

- **Hard delete the counters:** codes would start again at C01, so pilot bill numbers on paper would match go-live bills, and the audit log would point at devices that no longer exist.
- **Refuse Re-enable for wipe revocations:** needs a new column and leaves the old counters on the screens.

## Tests (first, failing)

`apps/api/src/wipe.int.test.ts`:

- a second counter revoked **before** the wipe, with documents waiting, is deleted by it too;
- after the wipe, Re-enable of either counter is refused, and the old counter can't get a token;
- the next enrolment gets the next code (not C01 again);
- the report lists both counters as removed.

## Docs

- D-123 in the decision log (amends D-101);
- the go-live checklist's final run, and the `erp-tenant` help line.

## Results

To fill in after the build.
