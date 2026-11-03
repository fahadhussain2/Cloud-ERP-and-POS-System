# POS counter (`POS`)

| | |
|---|---|
| **Status** | In progress: W1-02 (POS shell), W1-03 (catalog and search), W1-05 (bill building) and W1-06 (finalize and print) and W1-09 (customers and credit) merged; W1-12 (hold, void and reissue) merged (D-099); W1-13 (return and exchange) built, in review (D-100) |
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
| POS-12 | Return / exchange screen per W6, including bill lookup (90 days; no legacy bills, D-100), reason and condition, no-receipt flow with PIN, return window and non-returnable… | 1 |
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
| The counter screen: search, bill panel, key bar, first-load progress | `apps/pos/src/screens/CounterScreen.tsx` |

**Look and feel:** every screen is built from `packages/ui` ([README](../../../packages/ui/README.md)): shadcn/ui on Radix and Tailwind with the Tijara POS tokens (D-066).

## Bill building (W1-05)

[Plan](plans/W1-05-bill-building.md), [spec §10–§11](spec.md).

| Part | Where |
|---|---|
| The bill rules: amounts, the bill discount split, what a price needs, who may approve, approval validity, every edit, typed prices and discounts (golden cases in `golden/bill-*.json`) | `packages/domain/src/bill.ts` |
| What a line takes from the catalog (tier price with the default tier as fallback, floor, fractional units), the tiers | `billItem`, `tierPrices`, `tiers` in `apps/pos/src/search/search-index.ts` |
| The open bill per person (local schema 4), saved after every change | `apps/pos/src/bill/` (`open-bill.ts`, `bill-state.ts`, `use-open-bill.ts`), `open_bills` in `db/repo.ts` |
| An approver's PIN, checked offline | `apps/pos/src/unlock/approve.ts` |
| The bill panel, the dialogs (quantity, price, bill discount, tier, clear, approval), the key map | `apps/pos/src/screens/BillPanel.tsx`, `BillDialogs.tsx`, `CounterScreen.tsx` |
| App updates wait while a bill has lines | `apps/pos/src/bill/bill-open.ts`, `main.tsx` |

## Finalize and print (W1-06)

[Plan](plans/W1-06-finalize-and-print.md), [spec §12–§13](spec.md), [sync spec §6.1](../sync/spec.md).

| Part | Where |
|---|---|
| The tender rules, quick cash, the rounded total, document numbers, the bill code and the sale document (golden cases in `golden/tender*.json`, `sale-*.json`, `quick-cash.json`, `document-number.json`, `bill-code.json`) | `packages/domain/src/tender.ts`, `sale-document.ts` |
| The sale document's wire schema | `SaleDocumentV1` in `packages/contracts/src/documents.ts` |
| Code 39 bars as SVG | `packages/print/src/code39.ts` |
| The checkout datasets (payment methods, print profiles, the device's own row) | `CHECKOUT_COLUMNS` in `packages/contracts/src/sync.ts`, `datasetSource` in `apps/api/src/sync/routes.ts` |
| Local schema 5, the finalize transaction, recent bills, reprints | `apps/pos/src/db/checkout.ts`; signing after the commit in `counter-browser.ts` |
| The payment pad and the Cash, method and Split popups | `apps/pos/src/screens/PaymentPad.tsx`, `PaymentDialogs.tsx` |
| The printed bill and printing | `apps/pos/src/print/` (`BillPrint.tsx`, `print-bill.tsx`); print styles in `styles.css` |
| Reprint (`Alt+P`) | `apps/pos/src/screens/ReprintDialog.tsx` |

## Hold and recall (W1-12)

[Plan](plans/W1-12-hold-void-reissue.md), [spec §17](spec.md).

| Part | Where |
|---|---|
| The hold check, the cap and the label, when a held bill expires (golden cases in `golden/hold.json`, `held-expiry.json`) | `packages/domain/src/hold.ts` |
| Local schema 10, holding, the list and its sweep, the recall and its swap, clearing | `apps/pos/src/db/held.ts` |
| The Hold and Recall dialogs (`F8`, `Shift+F8`) | `apps/pos/src/screens/HoldDialogs.tsx`, `CounterScreen.tsx` |

## Void and reissue (W1-12)

[Plan](plans/W1-12-hold-void-reissue.md), [spec §18](spec.md).

| Part | Where |
|---|---|
| Who may void, the void check, the void document, the server's review (golden cases in `golden/void*.json`); the reissue's open bill (`reissue.json`) | `packages/domain/src/void.ts`, `reissue.ts` |
| The wire schema (family V) and the bill status answer | `SaleVoidV1`, `BillStatusResponseSchema` in `packages/contracts` |
| Today's bills, what a desk knows itself, the void transaction | `apps/pos/src/db/void.ts` |
| The live cash desk check | `apps/pos/src/sync/bills.ts` |
| The Void dialog, the approval, the VOID print, the reissue | `apps/pos/src/screens/VoidDialog.tsx`, `CounterScreen.tsx`, `print/BillPrint.tsx` |

## Work in this module

- `spec.md`: only if needed (see above), written before the first plan that depends on it.
- `plans/<wave>-<nn>-<slug>.md`: one accepted plan per task, before any code ([delivery process](../../07-DELIVERY-PROCESS.md) §3).
- `intent.md`: only for changes after the MVP.
