# W2-08 Light and dark themes on the counters: one theme per counter

| | |
|---|---|
| **Issue** | to be opened when the plan is accepted |
| **Module** | platform (PLT-13), touching the POS, the sync pull of the counter's own row and the back office's Counters screen |
| **Status** | Draft, for the owner's review |
| **Refs** | PLT-13; D-067 (POS: **per counter, set by a manager, default Light**), D-120 (the back office's switcher, paper always light); W2-07 (tokens, `--bad-ink`, `@media screen`); CLAUDE.md rules 5, 6, 7, 9, 10, 12; sync skill (pull datasets, local migrations) |
| **Depends on** | W2-07 (merged: the tokens and the dark values on screen only) |
| **Size** | about 1 day: table, sync and back office ¼, the counter ¼, the dark pass on the counter and the cash desk ¼, tests ¼ |
| **Test-first** | Yes: the API integration test, the POS local-migration and theme tests and the Counters screen's component test, committed failing first |

## The problem

The counter and the cash desk already draw with the same colour tokens as the back office (`apps/pos/src/styles.css` imports `@erp/ui/theme.css`), so dark costs no new colours. What is missing is **who chooses and where it is kept**. PLT-13 and D-067 say: on the POS the theme belongs to the **counter**, not the person, **set by a manager**, **default Light**, so cashiers and salesmen sharing a counter don't flip it between them.

## What exists to build on

- **Each counter already receives its own device row** in the pull (`dataset === 'device'`, `apps/api/src/sync/routes.ts:124`: only the caller's row, its `CHECKOUT_COLUMNS`) into the local `device` table (`apps/pos/src/db/migrate.ts`). Its print profile travels this way today (D-055). A theme column on the same row reaches the counter the same way, with no new endpoint.
- **The back office's Counters screen** (`apps/backoffice/src/screens/CountersScreen.tsx`, `admin.devices`, which managers and the owner hold) lists every counter and cash desk.
- `erp.devices` is synced and audited, so a change is recorded with who made it.

## Questions for the owner (each with a recommendation)

1. **Where a manager sets a counter's theme.**
   *Recommended:* **in the back office, Counters screen:** a Theme choice on each counter and cash desk (Light · Dark · System). It reaches the counter with its next pull (seconds when online; on reconnect when offline), and the change is in the audit log.
   *Otherwise:* on the counter itself, behind a manager's PIN (works offline at once, but needs a new screen and PIN flow on the counter and a push of the change back).
2. **The choices.**
   *Recommended:* **Light, Dark and System**, as PLT-13 lists, **Light by default** for every counter (existing ones too), so nothing changes on the shop floor until a manager picks.
   *Otherwise:* Light and Dark only (System on a shop PC follows Windows, which staff may change).
3. **Before a counter is set up** (the setup and PIN screens of a new or reset device, which has no device row yet).
   *Recommended:* **Light**, then the counter's own theme once its first pull lands; the last applied theme is kept on the device so a restart opens in it at once, even offline.
   *Otherwise:* always Light until the next pull after each start.
4. **The cash desk.**
   *Recommended:* **the same rule**: it is a device too, with its own choice on the Counters screen.
   *Otherwise:* the cash desk always Light.

Paper stays light on every device (D-120): bills, slips and labels are printed outside the tokens already, and the dark values apply on screen only.

## Design (with answers 1–4 as recommended)

| What | How |
|---|---|
| **Table** | Migration `0025_device_theme.sql`: `ALTER TABLE erp.devices ADD COLUMN theme text NOT NULL DEFAULT 'light' CHECK (theme IN ('system','light','dark'))`. Mirrored in `packages/db/src/schema.ts`. Already synced and audited: no new RLS or trigger |
| **Contract** | `packages/contracts`: `theme` added to the device dataset's `CHECKOUT_COLUMNS` (the only columns that leave the server) and to the admin device view; `UpdateDeviceThemeRequest = { theme: Theme }` (the `Theme` enum from W2-07) |
| **API** | `PUT /api/admin/devices/:id/theme` (`admin.devices`), in `apps/api/src/devices/routes.ts`: updates the row in `withTenant` (bumps `row_version` and `txid`, so the counter's pull picks it up; audited by the table's trigger), returns `204`; a bad value → `400`; another shop's device → `404` (RLS) |
| **Back office** | Counters screen: a **Theme** select per counter and cash desk, saved on change, with the usual saved/failed message; i18n keys (rule 10) |
| **Counter, local DB** | A new local migration step: `ALTER TABLE device ADD COLUMN theme TEXT NOT NULL DEFAULT 'light'`. An added column only: the local database is never dropped or rebuilt (rule 9) |
| **Counter, on screen** | `apps/pos/src/theme.ts` (the back office's `theme.ts` approach: `data-theme` on `<html>`, System followed live): applied at start from a device-local copy (`erp.pos.theme`, answer 3), then from the `device` row after each pull that changes it. No switcher on the counter (answer 1). `apps/pos/index.html` reads the copy before the first paint, as the back office does. The POS origin is unchanged (rule 12) |
| **Dark pass** | The counter, the cash desk, every dialog (payment, void, return, hold, reprint, health), the setup, PIN and stop screens, at the counter's screen size, by script for text under 3:1 as in W2-07, plus a look by eye at the bill panel and the payment pad. Fixes use the tokens only. The same colour guard as W2-07 is added for `apps/pos/src` (bills and slips that print in black on white are exempt by file) |
| **Sync rules** | Unchanged: a theme never blocks a sale, and a counter offline keeps its last theme (rule 7) |

## Tests written first

- **Integration** (`apps/api/src/device-theme.int.test.ts`): a new device is `light`; a manager sets `dark` → `204`, the audit log has it, and the counter's pull of `device` returns `theme: 'dark'` (and only its own row); a cashier → `403`; another shop's device → `404`; `{theme: 'blue'}` → `400`.
- **POS local migration:** a local database at the previous version with an unsynced outbox document gains `device.theme = 'light'` and keeps the document (rule 9).
- **POS theme (unit):** applying from the `device` row; the copy used at start; storage blocked → Light.
- **Counters screen (component):** the Theme select shows each device's theme, a change calls the API and shows the saved message; without `admin.devices` the screen isn't reachable (existing).
- **e2e** (`e2e/theme-counter.spec.ts`): a manager sets Counter 1 to Dark in the back office; the counter turns dark after its pull and stays dark after a reload while offline; another counter stays Light; a bill printed from the dark counter uses the light colours.

## Verify

`pnpm check`, `pnpm test:integration` (full suite, including the pilot wipe's table check), `pnpm e2e`, output shown in the PR; the dark-pass findings in the PR.

## Order

1. Failing tests, committed.
2. Migration, schema, contract, the pull column and the admin route.
3. The Counters screen's Theme select; the counter's local migration, `theme.ts` and `index.html`.
4. The dark pass on the counter and the cash desk, and its fixes; the e2e flow.
5. Decision-log entry **D-121**: *each counter's theme is set by a manager in the back office, Light by default*, amending D-067. The platform README's theme section.

## Risks

- **A change made while a counter is offline** shows only when it reconnects; the Counters screen says so beside the select.
- **The pull's column list** is the sync contract: an older counter build ignores the extra column; a newer build reading an older server finds no theme and stays Light.
- **Dark on the shop floor** in bright light may be hard to read; that is the manager's call per counter, and Light stays the default.

## Out of scope

- A switcher on the counter itself (answer 1, otherwise).
- Per-person themes on the counter (D-067 chose per counter).
