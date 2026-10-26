# W1-03 Catalog on the counter and omni-search, plus the design pass

| | |
|---|---|
| **Issue** | [#48](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/48) |
| **Module** | pos (with sync and catalog) |
| **Status** | Draft for owner review |
| **Refs** | POS-02, POS-03 (shortcut hints), SYN-01 (catalog), CAT-02 (normalized search), PLT-13 (tokens); architecture §2, §4.1, §5.3; data model §4, §12; sync spec §2–§3; D-014, D-039, D-053, D-056, D-066, D-067, D-089, D-090 |
| **Depends on** | W1-02 (counter shell, pull), W0-13 (catalog tables, the real Delux catalog on your PC) |
| **Size** | about 4 days |
| **Test-first** | Yes: the catalog pull column lists, the identifier normalizer, local schema 2, the search cases and their ranking |

## Goal

**A salesman finds any part in under a tenth of a second, with the internet down**: by code, a scanned label, an OEM number typed any way, words of the name in any order, or the car and year. The counter keeps its own copy of the catalog and prices and keeps it current. The counter also gets its final look (the Tijara POS prototype) and the shared building blocks every later screen uses.

## Design

| Choice | Why |
|---|---|
| **Ten catalog datasets join the existing pull** (sync spec §3): `price_tiers`, `units`, `categories`, `brands`, `origins`, `vehicle_makes`, `items`, `item_identifiers`, `item_compatibility`, `item_prices`. **Each lists its columns**; `legacy`, costs, suppliers, reorder settings and audit columns never leave the server. Column lists are in the table below. | Same rules as W1-02 (D-089): no `SELECT *`. The counter needs what search and (from W1-05) a bill line need, nothing more. |
| **The first sync is the plain pull, page by page** (about 125k rows for Delux: 19,552 items, 27,647 identifiers, 18,506 vehicle tags, 58,656 prices). Until the first catalog load finishes, the counter shows *Loading the catalog… N items* instead of the search. **Measured on the real catalog on your PC**; if the first load takes more than 60 seconds, the gzipped snapshot (architecture §5.3) is added in this task, with a plan change. | The sync spec left the snapshot as "only if too slow". Measuring first avoids building it for nothing; the threshold makes the call now, not later. |
| **Local schema 2** (a numbered migration, D-089): real columns for the catalog tables, so the search index loads with one query per table. | In-place migration keeps the outbox and the W1-02 tables (rule 9). |
| **Search is an in-memory index inside the database worker**, loaded from SQLite at start and **patched after each pull page** (architecture §2, "proposed"; now decided). The UI asks the worker `search(text)` and drops answers to older requests. | 20k items fit easily in memory; no round trip to SQLite per key press; the UI thread stays free. No SQLite FTS: it can't match normalized part-number prefixes or year ranges without the same custom code. |
| **One identifier normalizer, in `packages/domain`** (`normalizeIdentifier`: upper case, without spaces, `-`, `/`, `.`), used by the importer, the counter and later the back office. Moved from `tools/legacy-import` with its golden cases. | A part number must normalize the same way where it was stored and where it is searched (CAT-02). |
| **Matching and ranking** (POS-02), detailed in the POS spec §9 (new): <br>1. **exact code or barcode** (normalized), e.g. a scanned label<br>2. **exact identifier** (OEM, alternate, supplier ref)<br>3. **identifier prefix**, when the text has a digit and at least 4 characters (`17801` finds `17801-0Y040`)<br>4. **words in any order**: every word must start a word of the name, variant, spec, brand, origin, category, vehicle make or model; a 4-digit year matches a vehicle tag whose range includes it (`brake pads corolla 2012`)<br>Within a rank: active items first, then shorter names, then code. **At most 50 results.** | The PRD order (exact code/barcode → identifier → name/vehicle). Word-start matching keeps `pad` from matching `SPADE`; the prototype's ranking worked in the owner's review. |
| **Each result shows** the code, name, variant/spec, the first OEM number, the vehicle tag (e.g. *Corolla 2009–2014*), bin location and the **default tier's price** (Retail). Dormant and discontinued items carry a chip (owner question 4). **No stock columns yet:** stock balances come to the counter with the posting engine (W1-08), which fills the Shop · Godown column already laid out. | POS-02. The customer's tier price replaces Retail once W1-05 adds customers to the bill. Before W1-08 there is no stock to show. |
| **The counter screen** (after unlock) is the prototype's two columns: search on the left, the bill on the right as an empty panel (*Bill lines come with W1-05*). **Keys:** `F2` search, `↑ ↓` select, `Esc` clear, `Alt+L` lock; `Enter` on a result does nothing yet (W1-05 adds the line). A scan (fast typing ending in Enter) selects the exact match. | POS-03: keyboard first, hints always visible. Enter waits for bills so no half-feature reaches the pilot. |
| **Design pass: plain CSS on colour tokens and our own small components in `packages/ui`; no shadcn/ui, Radix or Tailwind.** This replaces the component part of D-066 (new **D-091**, owner question 1). The native `<dialog>` element gives the focus trap and `Esc`; our list component handles arrow keys. | Already the direction in the Wave 1 task list (D-090): less code on old counter PCs, nothing to fight to match the prototype, one less toolchain. D-066's reasons (keyboard-correct dialogs, RTL, small bundle) are met by native elements and logical properties. |
| **Tokens are the prototype's**, light values, and the dark values under `[data-theme="dark"]` only (no `prefers-color-scheme`; the counter stays Light until the Wave 2 switcher, PLT-13, D-067). **Fonts** (Barlow Condensed, IBM Plex Sans and Mono, open licence) are **bundled and cached for offline**, not loaded from Google (owner question 3). | The prototype is the approved look. A counter offline can't reach Google Fonts. |
| **Building blocks in `packages/ui`:** app frame (top bar, work area, key bar), button, field (label, input, error), list (keyboard-selectable rows), dialog (with the D-053 button bar: *Cancel (Esc)* plus the main action), messages (inline notice, toast), key hint (`kbd`) and key bar (each hint is also a button, D-053), `useShortcuts`, and `formatMoney` (tenant locale and currency, whole rupees for Delux, D-056). Tested in jsdom. | W1-04 (back office) and every later counter screen reuse them. |
| **The W1-02 screens are restyled** with them: setup, unlock, choose PIN, stop screens, status bar. The status bar moves to the **top**, as in the prototype; the key bar takes the bottom (owner question 2). | The prototype's layout, which the owner reviewed. |

**Catalog dataset columns** (sync spec §3, to be added):

| Dataset | Table | Columns (plus `row_version, deleted_at`) |
|---|---|---|
| `price_tiers` | `price_tiers` | `id, code, name, sort, is_default` |
| `units` | `units` | `id, code, name, allows_fraction` |
| `categories` | `categories` | `id, code, name, parent_id, pricing_rule, return_policy` |
| `brands`, `origins`, `vehicle_makes` | same | `id, name` |
| `items` | `items` | `id, code, name, category_id, brand_id, origin_id, unit_id, variant, spec, bin_location, floor_price, tax_code_id, status`. **Never** `legacy`, `default_supplier_id`, `min_qty`, `max_qty`, `exclude_from_reorder`. |
| `item_identifiers` | `item_identifiers` | `id, item_id, kind, value, normalized_value, is_primary` |
| `item_compatibility` | `item_compatibility` | `id, item_id, make_id, model, year_from, year_to, note` |
| `item_prices` | `item_prices` | `id, item_id, tier_id, price` |

## Scope

1. **Specs (drafted with this plan, for review with it):** [sync spec](../../sync/spec.md) §3 (the catalog datasets above, and the bootstrap rule); [POS spec](../spec.md) §9 *Search* (matching, ranking, display, keys). §7 (status bar position) follows question 2.
2. **`packages/domain`:** `normalizeIdentifier` with golden cases; `tools/legacy-import` uses it (its tests unchanged).
3. **`packages/contracts`, `apps/api`:** the ten datasets in `PULL_DATASETS` and their column lists in `sync/routes.ts`.
4. **`packages/ui`:** tokens, base styles, bundled fonts, the building blocks above, their tests, a short README of what exists.
5. **`apps/pos`:**
   - local schema 2 (catalog tables and indexes), `applyPull` for the catalog datasets (tombstones delete locally)
   - the search index (`search/`) in the worker: load at start, patch per pull page, `search` message
   - the counter screen (search panel, empty bill panel, key bar), *Loading the catalog*, the first-load progress
   - the restyle of the W1-02 screens, the status bar at the top
6. **E2E:** the seed gets a small catalog (about 30 items with OEM numbers, vehicle tags and three tiers); flows: search by code, scan (code + Enter), OEM with and without dashes, words in any order, car and year; reload offline and search still works.
7. **Docs:** data model §12 (local schema 2), POS README (search and `packages/ui`), architecture §2 (search and UI rows), D-091 in the decision log.

**Out of scope:** adding to the bill and the quantity prefix (`2*`) (W1-05); stock on the counter (W1-08); customers in search (W1-09); the back-office look (W1-04); catalog editing (W1-15); the theme switcher (PLT-13, Wave 2); the 90-day bills dataset (W1-13).

## Tests written first

- [ ] **Pull (integration):** every catalog dataset returns exactly its listed columns (an item never carries `legacy` or `default_supplier_id`); a soft-deleted identifier comes back as a tombstone; another tenant's catalog is never sent; paging over all datasets returns every row once.
- [ ] **Normalizer (golden):** `17801-0Y040`, `17801 0Y040`, `17801.0y040` and `17801/0Y040` → `178010Y040`; the importer's existing cases still pass through the moved function.
- [ ] **Local schema 2:** a schema-1 database with users, PIN state and outbox rows upgrades in place with all rows kept; `applyPull` upserts catalog rows and deletes tombstones, in one transaction with the cursor.
- [ ] **Search cases (golden, `apps/pos/src/search/cases.json`):** exact code in any case; a scanned barcode; an OEM number with and without dashes; an OEM prefix; words in any order; a word prefix (`brak pad`); make + model + year inside and outside the tag's range; `pad` not matching `SPADE`; the rank order across the four levels; dormant after active; a deleted item gone after a patch; a changed price shown after a patch; empty text → nothing; at most 50.
- [ ] **Search speed:** on a generated 20,000-item catalog, 200 typical queries, each under 50 ms (the PRD allows 100 ms from key press to results).
- [ ] **Building blocks (jsdom):** the dialog closes on `Esc` and returns focus; the list moves with `↑ ↓` and reports the choice; a key-bar hint clicked does what its key does; `formatMoney` gives `Rs 1,250` for Delux.
- [ ] **Counter screen (jsdom, fake counter):** `F2` focuses the search; results render with the price; a newer answer replaces an older one, never the reverse; *Loading the catalog* until the first load is done.
- [ ] **E2E:** the flows in scope item 6.

## Verify

1. `pnpm check`, integration tests and `pnpm e2e`, output shown.
2. **On your PC, with the real catalog** (the Delux tenant from W0-13, local API): enroll a counter, time the first catalog load (the 60-second rule above), then time searches like `17801`, `fan belt cultus`, `brake pads corolla 2012` (target ≤ 100 ms), and switch the network off and search again. I paste the timings into this plan.
3. **On staging, on your PC:** the restyled setup, unlock and counter screens in Chrome; a search on the seeded staging catalog.

## Risks

| Risk | Mitigation |
|---|---|
| The first catalog load is slow on an old counter PC or a slow line | Measured on real data (Verify 2) with a fixed threshold for adding the snapshot; each page is committed with its cursor, so an interrupted load resumes where it stopped. |
| The in-memory index uses too much memory on old PCs | About 20k items with short strings: a few MB. Measured in Verify 2 (Chrome task manager). |
| Search finds too much or misses parts the staff expect | Golden cases from real Delux patterns; the owner tries real searches in Verify 2, and misses become new cases. |
| Dropping Radix leaves gaps in accessibility | Native `<dialog>`, real buttons and labels, `role="listbox"` with `aria-selected`; the E2E drives everything by keyboard. |
| The design pass grows | Only the blocks listed; the back office waits for W1-04. |

## Questions for the owner

1. **UI library:** plain CSS on tokens and our own small components, instead of shadcn/ui, Radix and Tailwind (D-066)? This is what the Wave 1 task list says; it needs a decision entry (D-091). *Recommended: yes.*
2. **Status bar at the top** of the counter (as in the prototype), with the key bar at the bottom? The POS spec says bottom today. *Recommended: top.*
3. **Fonts:** bundle the prototype's fonts (about 200 KB, cached for offline), or use the Windows fonts (Segoe UI, Consolas) and download nothing? *Recommended: bundle, for the prototype's look.*
4. **Dormant and discontinued items** in search: show them last with a chip (they may still be on a shelf), or hide discontinued ones? *Recommended: show both, last, with a chip.*
