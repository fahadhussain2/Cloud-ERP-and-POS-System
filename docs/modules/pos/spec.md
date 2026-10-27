# POS counter: spec

| | |
|---|---|
| **Status** | Accepted v1 (with the W1-02 plan, D-089): local database, storage safeguards, device setup, unlock (2026-10-25). Search (§9) and the status bar at the top (§7): accepted with the W1-03 plan (2026-10-26). The bill (§10) and the keyboard map (§11): with the W1-05 plan and owner answers (2026-10-27). Payment and finalize (§12), printing and reprint (§13): with the W1-06 plan and owner answers (2026-10-27). |
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
- **Lockout:** 5 wrong PINs in a row lock that user **on this counter** (`pin_state`, survives reloads). A right PIN resets the count.
- **Manager unlock (W1-04), offline:** after a lock, the person's PIN screen offers *Manager unlock*. A manager picks their own name (or types their short code) and enters **their own** PIN. The counter checks it against their verifier and that they hold **`admin.devices`** for this counter's branch (the people who give temporary PINs, D-089). Wrong manager PINs count towards the manager's own lock; a right PIN from someone without the permission, or with a temporary PIN not yet replaced, is refused. The locked person then unlocks with their own PIN. Each lock and manager unlock is kept in `pin_events` for the server's audit log (pushed with W1-07).
- **Remote unlock:** a new temporary PIN from the back office clears the person's lock on every counter at its next pull (owner answer 3 to W1-04).
- **Removed while selling:** if a pull brings the unlocked person back disabled, deleted or without a PIN, the counter locks at once.
- **Disabled or deleted users** aren't listed and can't unlock.
- **Temporary PIN** (`pin_must_change`): the person enters it, then must choose their own PIN (twice). This needs the internet (sync spec §5). Offline, the counter says *Connect to set your PIN* and doesn't unlock.
- **Who's selling:** the unlocked user is shown in the status bar and recorded on every document (from W1-05).

## 6. Auto-lock

- After **3 minutes** without a key press or click, the counter locks and returns to the staff list (owner answer, W1-02). An open bill isn't lost: it's kept for the same user (§10).
- At the tenant's **closing time** (Delux 20:00, PLT-01), idle counters lock; a counter in the middle of a bill locks right after it.
- **Not** after each bill.

## 7. Status bar

Always visible at the **top** of every screen (W1-03 owner answer 1, as in the prototype); the key bar is at the bottom:
- **Connection:** *Online*, or *Offline since HH:MM* (red after 30 minutes). It changes as soon as the browser loses the network; when the network comes back, the counter pulls at once and retries for about 30 seconds until a pull succeeds, then shows *Online*.
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
- A **scan** (characters typed faster than a person types, ending in Enter) adds the item it matches to the bill at once, even before the results are shown (§10).

**Each result shows:** code, name, variant and spec, the first OEM number, the vehicle tag (*Corolla 2009–2014*), bin location, and the price in the bill's tier (§10; the default tier until another is chosen). Dormant and discontinued items carry a chip. Stock (Shop · Godown) is added with W1-08.

**Keys:** `F2` search · `↑ ↓` select · `Esc` clear · `Alt+L` lock. `Enter` adds the selected item to the bill (§10). Every key also appears in the key bar at the bottom, where it can be clicked (D-053). The full map is §11.

**Before the first catalog load finishes**, the counter shows *Loading the catalog… N items* instead of the search.

## 10. The bill (W1-05)

POS-04, PLT-07, D-004. The rules are pure functions in `packages/domain` (`bill.ts`, golden cases in `golden/bill-*.json`); the counter computes with them and the server re-checks synced bills with the same functions (W1-07), recording exceptions, never rejecting (D-011).

**A line** holds the item, the quantity, the **list price** (the bill tier's price when it was added; the default tier's if the item has none in this tier), the **floor** when it was added, and the **unit price** the salesman gives. A later pull doesn't change an open bill.

**Quantity:** more than 0 and at most 9,999; whole numbers unless the item's unit allows fractions (LITRE, METER, FOOT), up to 3 decimals. Adding an item that is already on the bill adds to its line, if that line is still at list price without an approval; otherwise it starts a new line. An item without a list price (none in any tier, or 0) is added only with a typed price.

**Amounts:** line amount = quantity × unit price (rounded half away from zero to the paisa). The **bill discount** is an amount (or a percent of the lines, rounded down to whole rupees); it is split over the lines in proportion to their amounts by largest remainder, and may not exceed them. Total = lines − bill discount. Prices and discounts are typed in **whole rupees** (D-056); cash rounding is in §12.

**What a price needs**, per line, after its share of the bill discount (compared as line totals, never as rounded unit prices):

| Line amount | Needs |
|---|---|
| at or above list (above list shows a chip) | nothing |
| below list, within the seller's `maxDiscountBp`, at or above the floor | nothing |
| below list beyond the seller's limit, at or above the floor | approval `below_list`: someone with `pos.override.approve` whose own `maxDiscountBp` covers the discount |
| below the floor, or no list price | approval `below_floor`: someone with `pos.price.below_floor` |

**When the floor is unknown, it is the list price** (owner answer 1): the server sends each item's effective floor (explicit, or cost + the category's margin) once costs exist (W1-14).

**Approval on the same screen** (PLT-07): the dialog shows the item, list, floor, requested price and seller. The approver picks their name (or types their short code) and enters **their own PIN**, then a **reason**: *Customer bargain, Old or slow stock, Matching a market price, Regular customer*, or *Other* with a note (owner answer 3). The PIN is checked offline like the manager unlock (§5): wrong PINs count towards the approver's own lock; a locked approver, a temporary PIN not yet replaced, or someone without the permission in this branch is refused. **The seller may approve their own price** if they hold the permission, with their PIN and a reason (owner answer 2). The dialog ends with *Cancel (Esc)* and *Approve (Enter)* (D-053).

**An approval is kept on the bill** with its kind, the line (or the bill, for a bill discount), who asked, who approved, the reason, the note, the time and what it approved (a line's list, floor and price; or the bill discount and the lines it covered). It holds while the line's price stays at or above the approved price; lowering it or changing the tier asks again. A bill-discount approval holds while the discount stays at or below the approved one and the lines are unchanged. W1-06 writes the approvals as `overrides` with the document.

**Price tier:** the bill starts on the default tier (Retail); `F7` picks another. Lines still at list move to the new tier's price; bargained lines keep their price and are checked again. From W1-09, choosing a customer sets their tier.

**The open bill is kept on the counter** (`open_bills`, one per person, never pushed) and saved after every change. When the counter locks or the page reloads, it waits for the same person's next unlock; another person starts with their own. `Alt+C` clears it after a confirm. An app update waits while someone is unlocked with lines on their bill (§8).

**The bill panel:** a context strip (*Walk-in · Retail prices*), the lines (number, name, code, list, floor, quantity, price, amount; chips *Bargained −Rs 150*, *Above list*, *Approved by Tariq · Customer bargain*, *Needs approval*), and the totals pinned at the bottom (items, subtotal, discount, **Total** in large figures). The payment pad goes under the total (§12).

## 11. Keyboard map (W1-05)

POS-03, D-053, from the prototype. The key bar always shows the keys of the current zone, and each hint is a button that does what its key does.

| Where | Keys |
|---|---|
| **Search** (`F2`) | `↑ ↓` result · `Enter` add · `2*` or `1.5*` before the text sets the quantity · `Esc` clear · `Tab` to the bill lines |
| **Bill lines** (`Tab`) | `↑ ↓` line · `+ −` quantity · `Q` set quantity · `P` price · `D` bill discount · `Del` remove · `Esc` back to search; any other letter types into the search |
| **Anywhere** | `F2` search · `F7` price tier · `F9` cash · `Shift+F9` split payment · `Alt+P` reprint · `Alt+C` clear the bill · `Alt+L` lock |
| **Dialogs** | `Enter` the main button · `Esc` cancel · `Tab` next field |
| **Later tasks** (shown once built) | `F3` return (W1-13) · `F4` customer (W1-09) · `F8` / `Shift+F8` hold and recall (W1-12) |

`F1`, `F3`, `F5`, `F7` and `F9` never reach the browser on the counter (no help page, find bar, reload or caret browsing mid-bill). `F6` and `Alt+D` are not used: Chrome keeps them for the address bar.

## 12. Payment and finalize (W1-06)

POS-06, POS-13, POS-15, POS-17, PRD W1 and W3, D-047, D-053. The rules are in `packages/domain`; the counter and, from W1-07, the server use the same functions.

**Total and rounding** (POS-15, owner answer 4): the bill's total is `roundCash(lines − bill discount, tenant.cash_rounding_increment)`, half away from zero, **for every bill whatever the tender**. The difference is the document's `rounding`. The bill panel shows a *Rounding* row only when it isn't zero; with whole-rupee prices that happens only with fractional quantities (1.5 m × Rs 333 = Rs 499.50 → Rs 500, rounding +0.50). Every payment amount is a multiple of the increment.

**The payment pad** sits under the total and never moves (POS-17): *Cash `F9`* (large, accent colour), then one button per other active payment method in its `sort` order (*Bank transfer*, *Raast*, *JazzCash*, *Easypaisa*, *Card*), *On account*, and *Split payment `Shift+F9`*. Only methods the tenant has active are shown.

- All buttons are disabled while the bill is empty.
- **Pay is refused while any approval is pending** (§10): *Approve the prices first*.
- *On account* stays disabled until a credit customer can be chosen (W1-09).

**Cash popup** (`F9` or the button): the total in large green figures, *Cash received* (optional, whole rupees), the quick-cash buttons and the change in large figures.

- **Enter with the field empty = the exact amount.** A typed amount below the total is refused: *That's less than the total. Use Split payment if the rest is paid another way.*
- **Quick cash** (`quickCash(total)`): *Exact*, then three round amounts, each showing its change. For each of Rs 500, 1,000, 5,000 and 10,000, take the next multiple **strictly above** the total; keep the three smallest distinct ones; if fewer than three remain, add the next multiples of Rs 5,000 above the largest. Rs 4,320 → 4,500 / 5,000 / 10,000; Rs 9,800 → 10,000 / 15,000 / 20,000. **One click finalizes.**

**Method popup** (a non-cash button): the amount (the whole total) and one reference field, labelled for the method: *Transfer reference* (bank transfer), *Raast or IBFT ID*, *JazzCash transaction ID*, *Easypaisa transaction ID*, *Card slip number or approval code*. Required when the method `requires_reference`.

**Split popup** (`Shift+F9`): one row per active method (cash first) with an amount and, for non-cash, a reference; cash is prefilled with the total; *Cash received* belongs to the cash row. Under the rows: *Rs X still to cover*, *Rs X too much* or *Fully covered*, and the change. Every tender can be paid from here with the keyboard alone (POS-03).

Every popup ends with *Cancel (Esc)* and *Finalize & print (Enter)* (D-053). Esc leaves the bill as it was.

**Tender rules** (`checkTender`): the first problem found, as an i18n key `tender.<code>`:

| Code | When |
|---|---|
| `no_payment` | no payment rows |
| `unknown_method` | a method that isn't an active pulled method |
| `on_account_needs_customer` | on account without a credit customer (always, until W1-09) |
| `duplicate_method` | the same method twice |
| `amount_not_positive` | an amount ≤ 0 |
| `amount_not_rounded` | an amount that isn't a multiple of the rounding increment |
| `reference_required` | a method that requires one, with an empty reference (after trimming) |
| `reference_too_long` | a reference over 40 characters |
| `sum_mismatch` | the amounts don't add up exactly to the total |
| `cash_received_without_cash` | cash received with no cash row |
| `cash_received_short` | cash received below the cash row's amount |

The **change** is cash received − the cash amount (0 when cash received is empty). The **cash due** is the cash row's amount (0 without one): what the salesman brings to the cash desk (D-047). `handoverStatus` is `pending` when the cash due is above 0, else `not_applicable`.

**Finalize** (`finalizeSale` in the worker, **one SQLite transaction**, data model §12):

1. Read the person's `open_bills` row. If there is none (a second Enter, a click and Enter), return the bill just finalized from it; nothing else is written.
2. Take `local_series.next_seq` for family `S` (1 on a new counter) and increment it.
3. Build the document with `buildSaleDocument` (sync spec §6.1): the number is `documentNumber(deviceCode, 'S', seq)`, e.g. `C03-S000412` (at least 6 digits); the business date is `businessDate(createdAt, tenant.timezone, tenant.day_cutoff_hour)` (D-056).
4. Insert it into `local_documents` and the `outbox` (`pending`, no signature yet).
5. Delete the `open_bills` row.
6. Commit. Any error rolls all of it back: no number is used and the open bill is still there (rule 6, POS-13).

**After the commit:**

1. The counter signs the canonical payload with its device key (`signCanonical`, D-082) and stores the signature on the outbox row. If signing fails, the row stays unsigned and push signs it before sending (W1-07).
2. The bill prints (§13).
3. A message: *Bill C03-S000412 printed · bring Rs 4,320 to the cash desk, change Rs 680* (or *paid by Raast* without cash), and a new empty bill with the search focused.
4. The unsynced count in the status bar goes up; an app update may now activate (§8).

## 13. Printing and reprint (W1-06)

POS-09, POS-10, POS-16, architecture §4.5 and §8, D-048, D-055.

**How:** the bill is HTML/CSS rendered into a print-only container and printed with `window.print()`. The counter's browser runs with `--kiosk-printing`, so it goes without a dialog to the **default Windows printer** (Delux: the shared printer at the cash counter). Printing happens only after the bill is committed; a failed print never changes the bill. The browser can't report a paper jam, so the reprint is the remedy.

**Print profile:** the device's `print_profile_id` (pulled `device` dataset), else the tenant default (`is_tenant_default`). Used fields:

| Field | Values built now |
|---|---|
| `paper_format` | `a5`: A5 landscape page, 210 × 148 mm (Delux, owner answer 1) · `a4`: A4 portrait page. `thermal_80` and `thermal_58` print the A4 layout until thermal templates are built (owner answer 2) |
| `code_type` | `barcode` (Code 39). `signed_qr` prints the barcode until it is built (owner answer 2) |
| `copies` | 1, or 2 = a second page in the same print job |
| `template_options` | `headerLines` (array of text), `policyText` |

**What the bill shows** (POS-09, Q12, the prototype's layout): the shop name and header lines (`branch.receipt_header`, then the profile's `headerLines`), *SALE BILL*, the bill number, date and time (tenant locale), counter, salesman, customer (*Walk-in*); the lines (#, code, description, quantity, rate, amount); subtotal, discount and rounding when not zero, **TOTAL**; each payment with its reference; *Cash received* and **CHANGE** when there is cash; the policy line (`policyText`, default *Exchange or return within 30 days with this bill.*); the bill code, with its text under the bars. Black on white, no shading. Text through i18n keys, logical CSS properties (rule 10).

**Bill code** (`billCode`, `parseBillCode`): Code 39, no check character, `<bill number> <cash due in whole rupees>`, e.g. `C03-S000412 4320`, or `C03-S000413 0` for a bill paid without cash. A cash due with paisa is refused (it is always rounded at Delux; a tenant whose increment leaves paisa can't use the barcode profile). Parsing ignores spaces around the text and a trailing Enter, and refuses anything else. The bars come from `code39Svg` in `packages/print`.

**Reprint** (`Alt+P`, POS-10, owner answer 3): a dialog lists this counter's bills from `local_documents` (newest first, up to 30 days), filtered as the number is typed; `↑ ↓` and Enter reprint the selected one. **Anyone unlocked may reprint, without a PIN.** The copy carries a **REPRINT** band with the time and who reprinted it. Each reprint is kept in `reprints` (`id` UUIDv7, `document_id`, `number`, `user_id`, `at`, `pushed_at`) and in `diagnostic_log`; push (W1-07) sends it to the audit log as `bill.reprinted`. A reprinted barcode can't collect cash twice: the handover is unique per bill (data model §6).
