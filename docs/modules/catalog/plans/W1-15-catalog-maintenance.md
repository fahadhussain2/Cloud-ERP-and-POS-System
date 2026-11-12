# W1-15 Catalog maintenance in the back office

| | |
|---|---|
| **Issue** | [#60](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/60) |
| **Module** | catalog (back-office screens and API), with sync (the counters pull the edits through the existing change feed), accounting (`writeFloors` from `packages/posting` when a category's margin changes) and platform (only the owner changes prices) |
| **Status** | Accepted (2026-11-05) with the owner's answers 1–4 (below). Built (2026-11-06) on `w1-15-catalog` |
| **Refs** | CAT-01, CAT-02 (edited here; search was W1-03), CAT-03, CAT-04, CAT-05, CAT-07; data model §4; sync spec §3; PRD Q1 (Mechanic −5 %, Wholesale −10 %), Q2 (floor = cost + 5 %); CLAUDE.md rules 1, 5, 8, 10; D-014, D-019, D-055, D-085, D-092, D-101, D-103 |
| **Depends on** | W1-03 (catalog on the counter), W1-04 (back-office shell, staff screens), W1-14 (`item_floors`, `writeFloors`) |
| **Size** | about 3 days: item list and search ½, item screen and the API 1¼, prices, floor and history ¾, categories ¼, e2e and docs ¼ |
| **Test-first** | Yes: item and price validation (golden, `packages/domain`); the API under RLS with permissions, row versions and price history (integration) |

## Goal

**The shop can look after its own catalog without the legacy app or me.** A manager finds any item by code, name, barcode or OEM number; changes its details, codes, vehicle tags and prices; sets a floor; and adds a new item. Every price change is kept with who, when, old → new and why (CAT-07). The counters get the change at their next pull or nudge, like any other catalog change (sync spec §3). **Until go-live the legacy app stays where items are changed** (owner answer 1): the final import overwrites the catalog, and the screens say so.

## Design

| Choice | Why |
|---|---|
| **Items screen:** one search box over code, name, brand and every identifier (normalized, as on the counter), with category, brand and status filters; 50 rows a page, server side | 19,552 items: too many to send to the browser; the same words find the same item as at the counter |
| **Item screen** in four parts: details (CAT-01), codes and vehicles (CAT-02, CAT-03), prices and floor (CAT-04, CAT-05), history (CAT-07) | One place per item; each part saved on its own, so a price change doesn't wait for a name check |
| **The item code can't be changed** once the item exists | Labels (D-019, D-055) and printed bills carry it, and every item has a barcode identifier equal to its code (data model §4). A wrong code = a new item, and the old one made dormant |
| **New item:** code, name, category, unit required; the barcode identifier = the code is added by itself; Retail price required, Mechanic and Wholesale proposed at −5 % and −10 % (PRD Q1, rounded to Rs 1) and editable | The same defaults the importer uses (D-085), so a new item looks like an imported one |
| **Status** active / dormant / discontinued, never a delete | Bills and ledgers point at items (rule 3) |
| **Concurrent edits:** every save sends the row version it read; a newer one is refused with "changed by X at …, reload" | Two managers, or the importer, can't silently overwrite each other |
| **Prices:** one form for the three tier prices and the item's own floor; a reason when any price goes down, from a fixed list (supplier price dropped, market price, slow stock, correction, other with a note) (owner answer 2) | CAT-07 asks for the reason; a list keeps the history readable, like D-092's override reasons |
| **`price_history`** (new table, migration 0016): `item_id, target (tier_id or 'floor'), old_value, new_value, source (manual · import · repricing), reason_code, note, user_id, at`, written in the same transaction as the price, append-only, tenant RLS, not synced. The importer doesn't write it: until go-live legacy is where prices change | Data model §4 already names it; the counter doesn't need it |
| **The floor shown** = the item's own floor, else cost + the category margin (`item_floors`), else the list price, with where it comes from (D-092, D-101); the item's own floor can be cleared again | The manager sees what the counter will do |
| **Cost** (average, last purchase, supplier, date) shown only with `cost.view` | The permission exists for this (platform roles); salesmen and cashiers don't see costs |
| **Categories screen:** name, parent and the floor margin (`floor_min_margin_bp`, shown as %; the margin needs `cat.price.edit`). Changing the margin re-writes that category's `item_floors` through `writeFloors` (`packages/posting`) in the same transaction | `item_floors` stays written in one place (W1-14's ledger-writer test); the counters get the new floors at once |
| **Brands, origins, vehicle makes:** picked from a list or added inline while editing an item; no screens of their own | They are just names (D-014) |
| **Permissions:** `cat.item.edit` for details, codes, vehicles and new items (owner and manager); `cat.price.edit` for prices, floors and the category margin, **the owner only** (owner answer 3): removed from the Manager template, and migration 0016 takes it out of the existing Manager roles made from that template (tenant setup never changes a role once made, and no screen edits roles yet). A new item's prices therefore need the owner; a manager adds the item and the owner prices it | One person decides prices; the permissions exist already (`packages/domain/permissions.ts`) |
| **Legacy stays the master until go-live** (owner answer 1): the importer is unchanged and the final run overwrites the catalog. Until the shop is marked live (`tenants.go_live_at`, D-101), the catalog screens show a notice: change items in the legacy app; changes made here are overwritten by the final import | No sync between two masters during the pilot; the notice stops a manager losing work |
| **No new tiers, no repricing** in this task | The three tiers are fixed for Delux (CAT-04 default); markup rules and repricing suggestions are CAT-06, Wave 2 |

## Scope

1. **Migration 0016:** `price_history` (RLS, audit) and its mirror in `schema.ts`; `cat.price.edit` removed from the Manager roles made from the template, and from the template.
2. **`packages/domain`:** `itemProblems` (code, name, unit, year range, min ≤ max, quantities as thousandths) and `priceProblems` (prices ≥ 0 in paisa, the floor not above Retail as a warning, a reason when a price goes down); golden files.
3. **API (`apps/api/src/catalog/`):** `GET /catalog/items` (search, filters, pages), `GET /catalog/items/:id`, `POST /catalog/items`, `PATCH /catalog/items/:id` (details), `PUT /catalog/items/:id/identifiers`, `PUT /catalog/items/:id/vehicles`, `PUT /catalog/items/:id/prices` (tiers and floor, with history), `GET /catalog/lookups` (categories, units, brands, origins, makes, tiers, suppliers), `PATCH /catalog/categories/:id`. All inside `withTenant`, all audited, row versions checked.
4. **Back office:** Items (list and search), Item (four parts), New item, Categories; menu entries; i18n keys only, logical CSS properties, tenant money format.
5. **Docs:** data model §4 (`price_history` built), catalog README status, platform roles (only the owner prices), the go-live checklist (from go-live, items are changed only in the new back office), `WAVE-1-TASKS.md` status marks (W1-08, W1-10, W1-11 and W1-13 are built), and a decision for answers 1 and 3.

## Tests written first

- **Golden (`packages/domain`):** `itemProblems`, `priceProblems`, including fractions, an open-ended year range and the floor above Retail.
- **Integration (`apps/api`):** search by code, name words and an OEM number with dashes; a salesman is refused; a manager may edit an item but not its prices; a stale row version is refused; a duplicate barcode is refused; a new item gets its barcode identifier; a price change writes one history row per changed target with the user; a category margin change re-writes its floors and only its floors; the cost hidden without `cost.view`; another tenant's item is not found (RLS).
- **Unit (back office):** the screens render their states (loading, empty search, saved, refused as stale), the price form read-only without `cat.price.edit`, and the notice while the shop isn't live.
- **e2e:** the owner changes an item's Retail price and adds a new item in the back office; the counter finds the new item and sells the old one at the new price after its next pull.

## Verify

`pnpm check`, `pnpm test:integration`, `pnpm e2e`. On staging (generated catalog, W1-21): search, edit, a price change and its history, a new item reaching a counter.

## Order

Migration and schema → domain golden files → API with integration tests → back-office screens → e2e → docs.

## Risks

| Risk | Mitigation |
|---|---|
| A search over 19,552 items and 29,000 identifiers is slow | Prefix and normalized-value indexes exist (migration 0006); measure on `erp_rehearsal2`, add a trigram index only if needed |
| Someone changes an item in the new back office during the pilot and the final import overwrites it | The notice on every catalog screen until go-live (owner answer 1) |
| A category margin change writes thousands of floors at once | One statement per category through `writeFloors`; measured on the largest category |
| A price change reaches some counters later than others | The nudge (W1-07) and the 60-second pull; the bill uses the price it had when the line was added (POS spec) |

## Changes during the build

| Change | Why |
|---|---|
| `price_history` keeps `tier_id` (null = the floor) rather than a text target | A foreign key to the tier; the API answers with the tier code |
| `price_history` has no audit trigger; it records `user_id` and `at` itself, and the app role can't update or delete it | It is the audit of prices |
| Migration 0016's role change reads the tenants with the roles' RLS lifted, like 0012 and 0013, with its own test (`manager-price-role.int.test.ts`) | The first version looped over `erp.tenants` under forced RLS and changed nothing |
| The lookups also carry the shop's money format and what this person may do | The back office has no other way to know (rule 10) |
| The back office depends on `@erp/domain` | The same checks as the API (item details, price change, proposed tier prices) |
| Brands, origins and vehicle makes are added inline from the item screen (`POST /api/catalog/brands`, `origins`, `makes`) | As planned, no screens of their own |

## Checks (2026-11-06)

- `pnpm check` (format, lint, typecheck, tests with coverage, build): pass, 1,861 tests; `packages/domain` at 100 % branch coverage.
- `pnpm test:integration`: 317 passed (30 files), including the catalog API (17) and the Manager role migration.
- `pnpm e2e` (Edge): 48 passed, including "the owner changes a price and adds an item in the back office; the counter sells both after its next pull".
- On `erp_dev`: migration 0016 took `cat.price.edit` from the Delux Manager role.
- The pilot wipe keeps `price_history` with the prices (a test checks every table is kept or wiped).

## Owner answers (2026-11-05)

1. **Legacy stays the master until go-live**, no importer change: simpler. The new back office shows a notice until the shop is live.
2. **The reason list is enough**, asked only when a price goes down.
3. **Only the owner changes prices** (`cat.price.edit` removed from Manager).
4. **About 3 days** (back from 3½ with answer 1).
