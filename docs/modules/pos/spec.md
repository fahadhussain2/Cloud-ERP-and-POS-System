# POS counter: spec

| | |
|---|---|
| **Status** | Accepted v1 (with the W1-02 plan, D-089): local database, storage safeguards, device setup, unlock (2026-10-25). Search (§9) and the status bar at the top (§7): accepted with the W1-03 plan (2026-10-26). Checkout and the keyboard map are added with W1-05. |
| **Refs** | POS-01, POS-14, PLT-01, PLT-03, PLT-04; architecture §4.1–§4.4, §8; data model §12; sync spec; CLAUDE.md rules 6, 9, 10; D-009, D-010, D-039, D-082 |

The PRD and architecture describe what the counter does. This spec fixes how its foundations behave, precisely enough to build and test. **v1** covers what W1-02 builds; checkout, the payment pad and the keyboard map come in later versions.

## 1. Local database

- **SQLite WASM** (`@sqlite.org/sqlite-wasm`) in **one dedicated Web Worker**, stored on OPFS with the `opfs-sahpool` VFS (D-039). Only the worker touches the database; the UI sends it typed requests and gets typed results.
- **One database per origin** (`pos.zorbixtechnologies.com`, D-065): file `erp-pos.sqlite3`.
- **Tables** (data model §12):

| Table | Holds |
|---|---|
| `meta` | `schema_version`, `device_id`, `tenant_id`, `branch_id`, `device_code`, `created_at` |
| `sync_state` | the pull cursor (opaque, sync spec §2), last pull and push times, server clock offset |
| `local_series` | the next sequence per document family (used from W1-05) |
| `outbox` | documents waiting to be pushed (used from W1-05) |
| `local_documents` | this counter's documents for 30 days (used from W1-05) |
| pulled tables | `tenant`, `branch`, `users`, `roles`, `user_roles` with the sync spec's columns (§3) |
| `pin_state` | per user on this counter: wrong tries in a row, locked since |
| `diagnostic_log` | ring buffer of the last ~5,000 events (architecture §11.3) |

- **The device's signing key is not in SQLite:** it's a non-extractable WebCrypto key in IndexedDB (D-082). The device token is kept in memory and refreshed with the key (W0-10 challenge flow).

## 2. Schema changes

- **Numbered migrations**, each a list of SQL statements, applied in order **inside one transaction**, raising `schema_version`. A failing migration rolls back and leaves the previous schema; the counter then stops (§3).
- **Never drop or rebuild the database while the outbox has rows** (rule 9). "Rebuild from the server" exists only as a manager action and is refused while the outbox isn't empty.
- An app version that finds a **newer** schema than it knows (an older app after a rollback) refuses to open the database and asks for the update, instead of guessing.

## 3. Storage safeguards (blocking)

Checked at every start, before unlock. Each failure shows a full-screen stop with what it means and who to call; **selling is impossible until it's fixed** (D-010).

| Check | Stop message (i18n key) |
|---|---|
| `navigator.storage.persist()` granted | storage not permanent: Chrome may clear it |
| OPFS and the SQLite worker start | storage unavailable |
| `PRAGMA quick_check` = `ok` | local database damaged |
| `schema_version` known and migrations applied | app update needed / database too new |
| the outbox table readable | unsynced bills can't be read: don't clear this PC, call the manager |

Every check result is written to `diagnostic_log`.

## 4. Device setup (enrollment)

1. A manager creates a **one-time code** in the back office (*Counters*), for a branch and a kind (counter, cash desk), valid 15 minutes (W0-10).
2. On the new PC, the POS shows *Set up this counter*: the manager types the code.
3. The counter creates its key pair (non-extractable), enrolls with the code and its public key, gets its device code (e.g. `C03`), tenant and branch, stores them in `meta`, then pulls (sync spec).
4. An enrolled counter never shows setup again. If the server says the device is **revoked**, the counter stops with *This counter was removed*; its unsynced documents are kept and can still be pushed after re-enrollment (W1-06).

## 5. Unlock

- **Screen:** the list of active staff (names from the pulled `users`), picked by click or arrow keys; typing a short code jumps to that person. Then the PIN (4–6 digits, shown as dots).
- **Check:** locally, in the worker, against the user's PBKDF2 verifier (W0-10, `verifyPin`). The UI stays responsive.
- **Lockout:** 5 wrong PINs in a row lock that user **on this counter** (`pin_state`, survives reloads). A manager unlocks them by unlocking with their own PIN and choosing *Unlock user*. A right PIN resets the count.
- **Disabled or deleted users** aren't listed and can't unlock.
- **Temporary PIN** (`pin_must_change`): the person enters it, then must choose their own PIN (twice). This needs the internet (sync spec §5). Offline, the counter says *Connect to set your PIN* and doesn't unlock.
- **Who's selling:** the unlocked user is shown in the status bar and recorded on every document (from W1-05).

## 6. Auto-lock

- After **3 minutes** without a key press or click, the counter locks and returns to the staff list (owner answer, W1-02). An open bill isn't lost: it's held for the same user (from W1-05).
- At the tenant's **closing time** (Delux 20:00, PLT-01), idle counters lock; a counter in the middle of a bill locks right after it.
- **Not** after each bill.

## 7. Status bar

Always visible at the **top** of every screen (W1-03 owner answer 1, as in the prototype); the key bar is at the bottom:
- **Connection:** *Online*, or *Offline since HH:MM* (red after 30 minutes).
- **Unsynced:** *N bills waiting to sync* (outbox rows); amber when the oldest is over 10 minutes old.
- **Last sync** time, the **counter code**, and **who is unlocked**.
- All text through i18n keys, laid out with CSS logical properties (rule 10).

## 8. App updates

- The service worker caches the app shell, so the POS starts offline.
- A new version downloads in the background and **activates only when no bill is open** (at lock, or after finalize), never mid-bill. The server accepts pushes from the previous version (architecture §4.2).

## 9. Search (W1-03)

POS-02, CAT-02. One search box (`F2`) on the counter screen; it works the same online and offline.

**Where it runs:** an in-memory index inside the database worker, loaded from the local catalog tables at start and patched after each pull page. The UI sends `search(text)` on every key press and ignores answers to older requests.

**What matches** (identifiers are compared after `normalizeIdentifier`: upper case, without spaces, `-`, `/`, `.`):

| Rank | Match | Example |
|---|---|---|
| 1 | The whole text equals an item's code or a barcode | a scanned label `ABEA001` |
| 2 | The whole text equals an OEM, alternate or supplier number | `17801-0Y040` or `178010y040` |
| 3 | An identifier starts with the text (only when it has a digit and at least 4 characters) | `17801` |
| 4 | Every word starts a word of the item's name, variant, spec, brand, origin, category, vehicle make or model; a 4-digit year matches a vehicle tag whose range includes it | `brake pads corolla 2012`, `brak pad` |

- Within a rank: active items first, then dormant and discontinued; then shorter names; then code.
- **At most 50 results.** Empty text shows a short hint instead of results.
- A **scan** (characters typed faster than a person types, ending in Enter) that matches rank 1 selects that item at once.

**Each result shows:** code, name, variant and spec, the first OEM number, the vehicle tag (*Corolla 2009–2014*), bin location, and the price for the default tier (the customer's tier from W1-05). Dormant and discontinued items carry a chip. Stock (Shop · Godown) is added with W1-08.

**Keys:** `F2` search · `↑ ↓` select · `Esc` clear · `Alt+L` lock. `Enter` adds the selected item to the bill from W1-05. Every key also appears in the key bar at the bottom, where it can be clicked (D-053).

**Before the first catalog load finishes**, the counter shows *Loading the catalog… N items* instead of the search.
