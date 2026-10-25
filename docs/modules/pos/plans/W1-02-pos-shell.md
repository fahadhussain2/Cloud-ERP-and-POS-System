# W1-02 POS shell: local database, device setup, staff unlock and offline status

| | |
|---|---|
| **Issue** | [#45](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/45) |
| **Module** | pos (with platform and sync) |
| **Status** | Accepted (2026-10-25) |
| **Refs** | POS-01, POS-14, PLT-01 (closing-time lock), PLT-03, PLT-04 (PIN unlock, auto-lock), SYN-01; architecture §4.1–§4.3, §5.3; data model §10, §12; D-009, D-010, D-039, D-065, D-082, D-089 |
| **Depends on** | W0-07 (pull with the xid8 cursor), W0-09 (users, roles), W0-10 (enrollment, device tokens, PIN verifiers) |
| **Size** | about 4 days |
| **Test-first** | Yes: local schema migrations and the outbox guard, the pull column lists, the unlock lockout |

## Goal

**A counter PC that opens the POS with no internet, knows who is selling, and never loses data**: enrolled once by a manager, unlocked by each salesman with their PIN, with its own database on the PC and a status bar that always tells the truth about the connection and unsynced bills. Every later counter task (search, checkout, sync) builds on this.

## Design (D-089)

| Choice | Why |
|---|---|
| **SQLite WASM in a dedicated Web Worker, on OPFS (`opfs-sahpool`)** (`@sqlite.org/sqlite-wasm`), as D-039 proposed. The UI talks to it through one small typed message API. | Real SQL and transactions for the local-first write (rule 6); runs off the UI thread; needs no cross-origin-isolation headers. |
| **Local schema changes are numbered migrations run in place**, inside a transaction, never a drop-and-rebuild. A rebuild from the server is refused while the outbox has rows. | Rule 9 and D-010: unsynced bills must survive any app update. |
| **Storage guardrails block the counter, not warn:** no persistent storage (`navigator.storage.persist()`), an unreadable database, a schema mismatch or a damaged outbox shows a full-screen stop with what to do. | D-010: selling with storage that the browser may clear risks losing bills. |
| **The app shell works offline** through a service worker (`vite-plugin-pwa`). A new version downloads in the background and activates only when no bill is open (none exist yet: the rule is built now). | The POS must start with the internet down (PRD goal 1). |
| **Device setup:** the manager creates a one-time code in the back office, types it on the counter; the counter makes its non-extractable signing key (kept in IndexedDB, D-082), enrolls, and gets a device token. | W0-10 built the server side; this is the counter side. |
| **Counters pull what unlock needs** (users with PIN verifiers, roles, user roles, tenant and branch settings) through a device-authenticated pull endpoint on the existing xid8 cursor. **Each dataset has an explicit column list: `password_hash` never leaves the server.** | Offline unlock needs the verifiers on the counter (architecture §4.3, accepted). `SELECT *` would also send password hashes. W1-03 adds the catalog datasets to the same endpoint; W1-06 adds push. |
| **Unlock (owner answer 3):** pick your name from the list of staff (or type your short code), enter your PIN; checked locally against the PBKDF2 verifier; 5 wrong tries lock that user on this counter (the W0-10 domain rule) until a manager unlocks. **Auto-lock after 3 minutes** without a key press and at closing time; not after each bill (owner answer 1). | PLT-04, PLT-01. |
| **Status bar** on every screen: online or *Offline since HH:MM*, *N bills waiting to sync* (the outbox count), last sync time, the counter's code, who is unlocked. | POS-14: staff always know the real state. |
| **PINs (owner answer 2):** a manager gives a new or forgetful salesman a **temporary PIN** in the back office (*Staff PINs*); at their first unlock the counter makes them **choose their own PIN**, which needs the internet so every counter learns it. Until then the temporary PIN can't sell. The manager can reset a PIN the same way. | Salesmen need no back-office login, and only they know their final PIN, so a bill's salesman stays trustworthy. |
| **Back-office minimum:** sign in, the forced password change (W0-11), *Staff PINs* (set a temporary PIN), and *Counters* (create an enrollment code, list and revoke devices). | Without them nobody can set a PIN or enroll a counter; the API exists since W0-09/10. |

## Scope

1. **Specs (written before this plan, for review with it):** [POS spec](../spec.md) v1 (local database, safeguards, setup, unlock) and [sync spec](../../sync/spec.md) v1 (pull and the counter PIN change).
2. **`apps/pos`:** the SQLite worker and migrations (data model §12: `sync_state`, `local_series`, `outbox`, `local_documents`, the pulled tables, `pin_state`, `diagnostic_log`), the storage checks, the service worker, the enrollment screen, the unlock screen, auto-lock, the status bar, and a placeholder home screen ("ready to sell" comes with checkout).
3. **`apps/api`:**
   - `GET /api/sync/pull?datasets=…&cursor=…` for enrolled devices (device token), with per-dataset column lists (sync spec §2–§3); the datasets `users`, `roles`, `user_roles`, `tenant`, `branch`
   - temporary PINs: a manager sets one (`users.pin_must_change`, migration `0007`); an enrolled counter changes it to the user's own PIN after checking the temporary one (`POST /api/sync/pin`, sync spec §5)
4. **`apps/backoffice`:** sign-in, password change, *Staff PINs*, *Counters*.
5. **E2E with Playwright** (the first UI flows, so `pnpm e2e` arrives now): enroll a counter, give a temporary PIN, choose your own at first unlock, unlock, lock after 5 wrong PINs, reload offline and still unlock.
6. **Docs:** data model §12 (local tables as built), the POS and platform READMEs, a counter-setup note in `infra/` (Chrome policies against clearing site data, install the PWA).

**Out of scope:** the catalog and search (W1-03), bills and the outbox's first real writes (W1-05), push (W1-06), the cash desk screens (W1-07), themes (PLT-13, Wave 2; colour tokens only).

## Tests written first

- [ ] **Local migrations:** a fresh database reaches the latest schema; an older one is upgraded in place with its rows kept; a failing migration rolls back and leaves the old schema.
- [ ] **Outbox guard:** "rebuild from the server" is refused while the outbox has rows, allowed when empty.
- [ ] **Pull (integration):** a device gets its tenant's users with `pin_verifier` and **without `password_hash`** (or any column not in the list); rows changed during a pull are not skipped (the existing cursor test, now through the endpoint); another tenant's device sees nothing; a revoked device gets `401`.
- [ ] **Temporary PINs (integration):** only a user with the permission can set one; the counter can change it only with the right temporary PIN, and the new verifier reaches the next pull; offline, a temporary PIN can't sell.
- [ ] **Unlock:** a right PIN unlocks; 5 wrong ones lock that user on this counter, and the lock survives a reload; a disabled user can't unlock; auto-lock after the idle time and at closing time.
- [ ] **E2E:** the flows in scope item 5.

## Verify

1. `pnpm check`, integration tests and `pnpm e2e`.
2. **On staging, on your PC** (no shop visit needed): create a code in the staging back office, enroll `staging-pos` in Chrome, give yourself a temporary PIN, choose your own at first unlock, unlock; switch the network off, reload, unlock again; see *Offline since …* in the status bar.

## Risks

| Risk | Mitigation |
|---|---|
| OPFS or `opfs-sahpool` behaves differently in some Chrome versions | Counters run current Chrome or Edge (Q10); the storage check stops the counter instead of losing data; E2E runs in Chromium. |
| PBKDF2 with 600k iterations is slow on old PCs | It runs in the worker (the UI stays responsive); measured on staging; the iteration count is stored in each verifier, so it can change later. |
| Pulled PIN verifiers can be brute-forced by someone who controls an enrolled PC | Accepted in architecture §4.3: PINs give accountability on a trusted device; the back office always needs a password. |
| The back-office screens grow | Only the four screens in scope; their look follows the theme tokens, nothing more. |

## Owner answers (2026-10-25)

1. **Auto-lock:** after 3 minutes without a key press, and at closing time; **not** after each bill.
2. **PINs:** option 3: the manager gives a temporary PIN, and the person chooses their own at the counter on first unlock (online). No back-office login needed for salesmen.
3. **Unlock screen:** a list of staff names to pick from (typing the short code also works).
