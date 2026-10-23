# W0-10 Device enrollment and staff PIN

| | |
|---|---|
| **Issue** | [#11](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/11) |
| **Module** | platform |
| **Status** | Done on staging (PR [#32](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/pull/32)); waiting for the owner's merge |
| **Refs** | PLT-03, PLT-04, PLT-07; architecture §4.3, §6.3; [platform spec](../spec.md); D-026, D-081, D-082 |
| **Depends on** | W0-09 (users, roles, sessions, audit) |
| **Size** | about 2.5 days |
| **Test-first** | Yes for the security paths, the PIN rules and the cross-check between browser and server crypto |

## Goal

The server side of trusted counters, ready for the POS app in Wave 1:
- a manager enrolls a device with a one-time code, and the device proves it holds its key;
- the device gets short access tokens by signing a challenge;
- the server verifies a device's signatures;
- staff have PINs that a counter can check offline;
- a lost device is revoked in one click.

## Design (D-082, details in the spec)

| Choice | Why |
|---|---|
| **One-time enrollment code:** 8 Crockford base32 characters, 15 minutes, single use, hashed, rate-limited | Easy to type on a counter, impossible to guess within the limits |
| **The device key is the only long-lived credential:** a non-extractable ECDSA P-256 key. Access tokens (15 min) come from **signing a single-use server nonce**. There are no refresh tokens. | Nothing reusable to steal from storage or logs. Revocation takes effect immediately. |
| **Device auth header `Device <tenantId>.<token>`**, looked up under RLS | The same tenant-safe pattern as back-office sessions (D-081) |
| **Signatures:** ECDSA P-256 / SHA-256, IEEE P1363 encoding, over the **canonical JSON** from `packages/contracts` | WebCrypto's native format; one canonicalization shared by the POS and the API, so signatures always verify |
| **PIN verifier: PBKDF2-HMAC-SHA256, 600,000 iterations**, `pbkdf2-sha256$<iterations>$<salt>$<hash>` | Built into every browser (WebCrypto) and Node, so the counter can check the PIN offline, with no WebAssembly |
| **PIN rules and the 5-try device lockout are pure functions in `packages/domain`** | The POS (offline) and any server check use the same rules (rule 2) |
| **Device codes are auto-numbered per kind:** `C01…` counters, `D01…` cash desks, `M01…` mobile | They become the prefix of bill numbers (`C03-S000412`, architecture §4.4) |

## Scope

1. **[spec.md](../spec.md)** (with this plan).
2. **Migration `0004`:**
   - `devices` (synced, audited: public key, kind, code, status, revocation)
   - `device_enrollment_codes`, `device_challenges`, `device_tokens`
3. **`packages/domain`:**
   - `pinProblem(pin, shortCode)`
   - `nextPinState(state, correct)`: the lockout after 5 wrong tries, unlocked by a manager
   - `nextDeviceCode(kind, existingCodes)`
   - golden cases for all three
4. **`packages/contracts`:**
   - `canonicalJson()`
   - Zod schemas for enroll, challenge, token, set-PIN
   - the PIN verifier string format
5. **`apps/api`:**
   - `POST /api/devices/enrollment-codes` (`admin.devices`)
   - `POST /api/devices/enroll`
   - `POST /api/devices/challenge`
   - `POST /api/devices/token`
   - `GET /api/devices/me` (device auth)
   - `POST /api/devices/:id/revoke` (`admin.devices`)
   - `PUT /api/users/me/pin` (needs the current password)
   - `requireDevice()` for future sync routes
   - `verifyDeviceSignature()`
6. **`apps/pos/src/device/`, the browser side (no screens yet):**
   - generate the non-extractable key
   - export the public key
   - sign canonical JSON
   - make and verify PIN verifiers with WebCrypto
7. **Docs:** data model §2 (devices and the new tables), the platform README.

**Out of scope:**
- POS screens for enrollment and unlock, IndexedDB persistence, offline lockout UI (Wave 1 POS shell)
- syncing users and devices to counters (Wave 1 sync)
- print profiles (W0-11)
- manager reset of staff PINs (with user admin, Wave 1)

## Tests written first

**Domain (golden):**
- [x] PIN rules: 4–6 digits only; `1111`, `1234`, `9876` and the user's short code are refused; `4821` is accepted.
- [x] Lockout: the 5th wrong PIN locks; a right PIN before that resets the count; a locked user stays locked even with the right PIN until a manager unlock.
- [x] Device codes: the next number per kind, **never reused** (after `C01` and a revoked `C02` comes `C03`, so old bill numbers stay unique); a cash desk is `D01`.

**Cross-check between browser and server crypto (unit, Node's WebCrypto):**
- [x] A signature made by the POS library verifies in the API helper; a single changed byte fails.
- [x] A PIN verifier made by the API verifies in the POS library, and the reverse.
- [x] `canonicalJson` gives the same bytes for the same object, whatever the key order.

**API (integration, real database):**
- [x] Enrollment code: created only with `admin.devices`; shown once; expires after 15 minutes; works once; a wrong or reused code gives the same error; rate limit.
- [x] Enroll: a bad proof-of-possession signature is refused; a device gets `C01`, then `C02`; the audit log shows who created the code and which device used it.
- [x] Token: a correct challenge signature gives a 15-minute token that works on `GET /api/devices/me`; a wrong signature, an expired nonce, a reused nonce, or **another device's key** is refused.
- [x] Revoke: the token stops working at once, and a new challenge or token is refused.
- [x] Device tokens can't be used as back-office sessions, and the reverse.
- [x] Set PIN: needs the current password; refuses `1234`; the stored verifier is PBKDF2 (never the plain PIN); **the back-office login still refuses the PIN** (from W0-09).

## Order

1. Spec and plan accepted.
2. Failing tests, committed.
3. Domain rules, then contracts.
4. Migration `0004`.
5. API endpoints and the POS library.
6. Staging check with `deploy:staging`, enrolling a test device using Node as the "browser" against `staging-pos`.
7. Docs.

## Risks

| Risk | Mitigation |
|---|---|
| 600,000 PBKDF2 iterations is slow on old counter PCs | Measured in the Wave 1 POS shell on a Delux counter. The iterations are in the verifier, so they can be lowered per tenant if unlock takes over a second (security trade-off noted in the spec). |
| Browser and Node encode signatures differently (DER vs P1363) | Fixed to P1363 on both sides, with a cross-check test |
| Clock skew on counters | Token issuance uses a server nonce, not the device clock |
| A user's PIN verifier on a stolen device can be brute-forced | Accepted and documented (spec §4, "the honest limit"); revocation and accountability are the answer |

## Owner actions

None.

## Changes made while building

| Change | Why |
|---|---|
| **One WebCrypto implementation in `packages/contracts`** (`device-crypto.ts`), used by the POS and the API, instead of a POS library plus an API helper checked against each other | Browsers and Node 24 both have WebCrypto. With one implementation, a signature or PIN-verifier format mismatch between the two sides can't happen at all. The "cross-check" tests become direct tests of the shared code. |
| The API and contracts TypeScript configs include the `DOM` library | For the WebCrypto, `TextEncoder` and `atob`/`btoa` types; Node 24 provides these at runtime. |
| `devices` has no `last_seen_at`, `app_version` or `health` yet | Updating them on every check-in would write audit rows and sync versions all day. They go in a separate device-health table with PLT-09. |
| The token request signs the canonical JSON of `{ tenantId, deviceId, nonce }` (spec §2 updated) | One signing format (canonical JSON) for everything, instead of a second ad-hoc string format. |
| The per-shop enrollment limit (10 failures in 15 minutes → 429) counts `device.enroll_failed` audit rows | The audit trail is already there, so no extra table is needed. The per-IP limit is the route rate limit. |
| Setting a PIN writes an explicit `pin.changed` audit row | The audit trigger strips `pin_verifier`, so a PIN-only change would otherwise leave no trace. |

## Results (2026-10-23)

| Check | Result |
|---|---|
| Tests first | Committed failing (`3d741cc`). |
| Domain | 27 new golden cases (PIN rules, lockout, device codes); `packages/domain` stays at **100%** coverage. |
| Shared crypto (11 tests) | Canonical JSON key order and invalid values; P1363 64-byte signatures; tampered value / wrong key / broken key are refused; the **private key can't be exported**; PIN verifiers are PBKDF2 at 600,000 iterations, salted, never contain the PIN, and garbage is refused. |
| API (12 new integration tests) | Codes only with `admin.devices`, stored hashed, `K7Q2-M9XD` format. Enrollment `C01`, `C02`, `D01`; a reused, wrong or expired code and a **forged proof of key** all fail the same way; the per-shop limit; the audit trail names the manager. 15-minute tokens. Another device's key, a wrong signature, an expired nonce and a **reused nonce** are refused. Revocation stops the token at once. Session cookies and device tokens can't stand in for each other. PIN: needs the password, refuses `1234` and the short code, stores a PBKDF2 verifier, is audited, and **still can't log in**. |
| Mutation checks | No proof-of-key check: the forged-proof test fails. Reusable nonce: the nonce test fails. |
| Totals | `pnpm check` green with **217 unit tests**; **58 integration tests** pass. |
| **Staging, over HTTPS** (a Node script acting as a counter, using the shared device crypto) | Owner login → enrollment code (format ok) → enroll on `staging-pos` → device **C01**. The same code again → `enrollment_failed`. Signed challenge → token → `devices/me` 200 with the right tenant, branch and code. Revoke 204 → the same token **401**, a new token **401**. Migration `0004` applied by the deploy. |
