# POS counter (`POS`)

| | |
|---|---|
| **Status** | In progress: W1-02 (POS shell) merged; W1-03 (catalog and search, design pass) built, in review |
| **Requirements** | 17 (POS-01…POS-17) |
| **Feature spec needed** | Yes: checkout screen and keyboard map; local DB and storage guardrails |

## Scope

The offline PWA on counter PCs: search, bill, tiers and overrides, customers, payment pad and tender, credit control, hold, printing and bill code, void, return/exchange, numbering, status, rounding, print profiles.

## Requirements

Full wording is in [the PRD](../../01-PRD.md). Wave 1 = critical path for go-live, Wave 2 = rest of the MVP.

| ID | Summary | Wave |
|---|---|---|
| POS-01 | Installable PWA on Chromium (Chrome/Edge). | 1 |
| POS-02 | Omni-search: one input that matches code, barcode scan, OEM/alternate numbers (normalized), name words in any order, and vehicle tags. | 1 |
| POS-03 | Fully keyboard-driven: function-key map, no mouse needed, visible shortcut hints. | 1 |
| POS-04 | Bill lines: quantity, unit price (from tier). | 1 |
| POS-05 | Customer selection: walk-in by default, fast search by name, phone or code. | 1 |
| POS-06 | Tender: cash (optional cash received, Enter = exact amount → change), bank/Raast, JazzCash, Easypaisa, card. | 1 |
| POS-07 | Credit control: limit check (synced balance + local unsynced) and offline daily cap per customer. | 1 |
| POS-08 | Hold / park bills and resume them on the same device. | 1 |
| POS-09 | Finalize → print the bill silently to the device's default printer (local or shared network printer) using its print profile (POS-16). | 1 |
| POS-10 | Reprint (marked REPRINT, logged). | 1 |
| POS-11 | Void with permission, PIN and reason within the void window; optional linked reissue. | 1 |
| POS-12 | Return / exchange screen per W6, including legacy bill lookup (90 days), reason and condition, no-receipt flow with PIN, return window and non-returnable… | 1 |
| POS-13 | Per-device document numbering, gapless and never reused (e.g. | 1 |
| POS-14 | Status bar: online/offline, last sync, unsynced count, warnings when offline longer than a threshold. | 1 |
| POS-15 | Cash rounding per tenant rule (e.g. | 1 |
| POS-16 | Print profiles: a tenant default, overridable per device. | 1 |
| POS-17 | Payment pad under the bill total. | 1 |

## Related

PRD W1–W7, W15; architecture §4 (offline design), §8 (printing); D-001–D-013, D-047–D-053; prototype: Tijara POS

## Domain core (`packages/domain`, W0-08, D-079)

The exact building blocks every checkout rule uses. They are pure functions; golden cases are in `packages/domain/golden/`.

| Function | What it does |
|---|---|
| `money(v)`, `add`, `sub`, `negate`, `sum` | `Money` = whole minor units (paisa). Accepts the database's bigint text. Refuses fractions and unsafe values. |
| `qty(v)`, `parseQty(text)` | `Qty` = thousandths of a unit (1.5 m = 1500) |
| `mulQty(qty, unitPrice)` | Line amount, rounded half away from zero |
| `mulBp(amount, bp)` | Amount × rate in basis points (1% = 100 bp) |
| `roundCash(amount, increment)` | Cash rounding to the tenant increment → `{ rounded, adjustment }` (POS-15) |
| `allocate(total, weights)` | Largest-remainder split that always sums exactly (bill discounts, refunds) |
| `parseMoney(text, minorUnits)` | Typed text → exact minor units; extra decimals are an error |
| `businessDate(instantMs, timeZone, cutoffHour)` | Business date with the 04:00 cutoff (D-056); the time is always passed in |
| `DomainError.code` | A stable error code for i18n messages and API exceptions |

## Counter shell (W1-02, D-089)

What every later counter task builds on ([spec](spec.md), [plan](plans/W1-02-pos-shell.md)):

| Part | Where (`apps/pos/src`) |
|---|---|
| Local database: SQLite WASM in a worker on OPFS, numbered migrations, outbox guard | `db/worker.ts`, `db/migrate.ts`, `db/repo.ts`; the UI calls it through `db/client.ts` |
| Storage checks that stop the counter (spec §3) | `storage/checks.ts`, `screens/StopScreen.tsx` |
| Setup: the key pair in IndexedDB, enrollment, device token | `device/keys.ts`, `device/session.ts`, `screens/SetupScreen.tsx` |
| Pull loop (startup, after unlock, every 60 s, when back online) | `sync/pull.ts` |
| Unlock from the staff list, 5-try lock, auto-lock | `unlock/unlock.ts`, `screens/UnlockScreen.tsx`, `App.tsx` |
| Choose your own PIN after a temporary one (online only) | `sync/pin.ts`, `screens/ChoosePinScreen.tsx` |
| Status bar at the top (POS-14) | `screens/StatusBar.tsx` |
| Offline app shell; updates wait until no bill is open | `vite-plugin-pwa` in `vite.config.ts`, `pwa/update.ts` |

The screens talk only to the `Counter` interface (`counter.ts`), so they are tested with a fake; `counter-browser.ts` is the real one. End-to-end flows: `e2e/counter.spec.ts` (`pnpm e2e`). Setting up a shop PC: [infra/counter-setup.md](../../../infra/counter-setup.md).

## Catalog and search (W1-03)

[Plan](plans/W1-03-catalog-search.md), [spec §9](spec.md), [sync spec §3](../sync/spec.md).

| Part | Where |
|---|---|
| The catalog datasets and their column lists (shared by API and counter) | `CATALOG_COLUMNS` in `packages/contracts/src/sync.ts` |
| Local catalog tables (schema 2), applying pages, loading the catalog | `apps/pos/src/db/migrate.ts`, `db/repo.ts` (`applyPull`, `loadCatalog`) |
| The search index: four match ranks, patched per page, warmed after loads | `apps/pos/src/search/search-index.ts`, golden cases in `search/cases.json` |
| One part-number normalizer for importer and counter | `normalizeIdentifier` in `packages/domain` |
| The counter screen: search, bill panel (W1-05), key bar, first-load progress | `apps/pos/src/screens/CounterScreen.tsx` |

**Look and feel:** every screen is built from `packages/ui` ([README](../../../packages/ui/README.md)): shadcn/ui on Radix and Tailwind with the Tijara POS tokens (D-066).

## Work in this module

- `spec.md`: only if needed (see above), written before the first plan that depends on it.
- `plans/<wave>-<nn>-<slug>.md`: one accepted plan per task, before any code ([delivery process](../../07-DELIVERY-PROCESS.md) §3).
- `intent.md`: only for changes after the MVP.
