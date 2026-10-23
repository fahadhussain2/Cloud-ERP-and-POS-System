# Platform spec: device enrollment, device tokens and staff PIN

| | |
|---|---|
| **Status** | Accepted with the W0-10 plan (D-082, 2026-10-23) |
| **Refs** | PLT-03, PLT-04, PLT-07; architecture §4.3, §4.5, §6.3; D-026, D-081 |

This spec defines how a counter becomes a trusted shop device, how it talks to the server, and how staff unlock it with a personal PIN. It's the security base for sync (Wave 1), signed bills (§4.5) and overrides (PLT-07).

## 1. Enrollment

1. **A manager creates a one-time code** in the back office, choosing the branch and the device kind (counter / cash desk). This needs `admin.devices`.
   - The code is **8 characters of Crockford base32**, shown as `K7Q2-M9XD`: about 40 bits, with no 0/O or 1/I/L to misread.
   - It **expires after 15 minutes** and works **once**. Only its SHA-256 is stored.
2. **On the counter**, the POS asks for the shop code and the enrollment code. The browser then:
   - generates an **ECDSA P-256 key pair** with WebCrypto, `extractable: false`, so the private key can be used but never read or copied out of the browser, and stores it in IndexedDB;
   - sends the **public key** (SPKI) with the code, **signed with the new private key**. This proves it holds the key.
3. **The server**:
   - checks the code (right tenant, not expired, not used) and verifies the signature with the sent public key;
   - creates the device with the next free **device code** for its kind: `C01, C02…` for counters, `D01…` for cash desks;
   - marks the code used and records it in the audit log.
4. **Enrollment attempts are rate-limited:** 10 per 15 minutes per IP and per shop. With 40-bit codes, guessing is hopeless.

## 2. Device tokens: the key is the credential

There are **no long-lived device secrets** besides the non-extractable key. A device gets a short access token by proving it holds its key:

1. `POST /api/devices/challenge` → a random **nonce**, valid for 60 seconds, usable once.
2. The device signs `tenantId | deviceId | nonce` and calls `POST /api/devices/token`.
3. The server verifies the signature with the stored public key and checks that the device is **active**. It then issues an **access token valid for 15 minutes**. Only the token's SHA-256 is stored.
4. Requests carry `Authorization: Device <tenantId>.<token>`. The server sets the tenant context from it and looks the token up **under RLS**, the same pattern as back-office sessions (D-081).

So there's no refresh token to steal or rotate. **Revoking a device** (`admin.devices`) deletes its tokens, and no new ones can be issued. Documents it already created are still accepted at sync, flagged for review (architecture §4.3, D-011).

## 3. Document signatures

Every document a device creates (Wave 1) is signed with its key:
- ECDSA P-256 with SHA-256, signature in **IEEE P1363** form (r‖s, 64 bytes), which is what WebCrypto produces;
- the signed bytes are the **canonical JSON** of the payload: keys sorted, no spaces, UTF-8, from one shared function in `packages/contracts`.

The server verifies with the device's stored public key. The public keys of a branch's devices sync to every device in it, so a cash desk can verify a counter's signed QR offline (§4.5).

## 4. Staff PIN

- **Personal, 4–6 digits.** Refused:
  - all digits the same (`1111`)
  - straight runs (`1234`, `9876`)
  - the user's short code
- **Set by the user in the back office**, after re-entering their password. A manager resets a PIN from user admin (Wave 1).
- **Stored as a slow hash both the server and the browser can compute:** **PBKDF2-HMAC-SHA256, 600,000 iterations** (OWASP 2023), with a 16-byte random salt, as `pbkdf2-sha256$600000$<salt>$<hash>`.
  - Argon2 would need WebAssembly in the browser; WebCrypto has PBKDF2 built in.
  - The parameters are in the string, so they can be raised later.
- **Unlock on the counter:** pick your name or type your short code, then enter the PIN. It's checked **offline** against the verifier synced to that branch's devices.
- **5 wrong PINs lock that user on that device** until a manager unlocks it with their own PIN. The lockout rule is a pure function in `packages/domain`. Lockouts are reported to the server's audit log at the next sync.
- **Overrides (PLT-07):** the approver types their PIN on the same screen. The device checks that the approver holds the needed permission (`can()`, D-081) and writes an override record into the document, signed with it.
- **Never a login:** the back office never accepts a PIN (D-081).

### The honest limit

A 4–6 digit PIN can't resist an offline attack by someone who already has an enrolled device and its synced data: PBKDF2 can be tried very fast on a GPU. PINs give **accountability on a trusted shop device**, not strong authentication (architecture §4.3). The real defences are physical (the shop), revocation of a lost device, the audit trail, and passwords for everything remote.

## 5. Threats and answers

| Threat | Answer |
|---|---|
| Someone guesses an enrollment code | 40 bits, 15-minute life, single use, rate limit per IP and shop |
| An enrollment code is photographed and used | Single use, so the real device's enrollment then fails and shows it. The manager revokes the impostor; the audit log shows who created the code and which device used it. |
| A device token leaks (logs, a proxy) | 15 minutes long; stored only as a hash; useless after the device is revoked |
| A token request is replayed | The nonce works once, for 60 seconds |
| A counter PC is stolen | Revoke it in the back office; its tokens stop at once. Local data is protected only by the Windows login (architecture §6.5). |
| Malicious script on the POS page (XSS) | Strict CSP and no third-party scripts (Wave 1). The key can't be extracted, so it can only be used while the page is open. |
| The server's database leaks | It holds only public keys, token hashes, Argon2 password hashes and PBKDF2 PIN verifiers |
| A PIN is shared or shoulder-surfed | Personal PINs, the audit trail on every document, and the user changes it in the back office |
