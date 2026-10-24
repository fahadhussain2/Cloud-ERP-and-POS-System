# W0-13 Legacy importer: catalog, parties and chart of accounts, with cleanup reports

| | |
|---|---|
| **Issue** | [#14](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/14) |
| **Module** | migration (with catalog and parties) |
| **Status** | Accepted (2026-10-24) |
| **Refs** | MIG-01, CAT-01…CAT-04, PRD Q1–Q3, Q6, Q13; migration doc §3, §7; data model §3, §4, §9; [importer spec](../spec.md); D-014, D-019, D-030, D-083, D-084, D-085 |
| **Depends on** | W0-11 (the Delux tenant), W0-12 (staging) |
| **Size** | about 4 days |
| **Test-first** | Yes: every mapping rule (golden), the load's idempotency, phone masking |

## Goal

**Your real catalog and parties in a Delux tenant on this PC**: all 19,552 items with their codes, identifiers, vehicle tags and prices, the 373 customers and suppliers, and your legacy expense accounts in the chart. Every later task (search, checkout, labels, purchasing) is then built and tested on the real data. You get **cleanup reports** to review: what the importer guessed, what looks wrong, what needs your decision.

Opening stock, customer and supplier balances and the 90-day bills are **not** in this task (Wave 1, with posting).

## Design (D-085)

| Choice | Why |
|---|---|
| **Migration `0006` adds the catalog and party tables** (data model §3, §4): units, categories, brands, origins, vehicle makes, items, item identifiers, vehicle tags, item prices, parties, customer and supplier accounts. Forced RLS, sync and audit, like every tenant table. | The importer needs somewhere to load; Wave 1 builds the screens on the same tables. |
| **Every mapping rule is a pure, golden-tested function** in `tools/legacy-import/src/transform/` (100% coverage). | The rules in the migration doc §3 are full of judgement calls (a country as a brand, a bulb type as a "manufacturer", a colour as a part number). Each becomes a case you can read and that can't regress. |
| **Your decisions live in a reviewed mapping file** (`tools/legacy-import/mapping/delux.json`, in git): the vehicle-make allow-list, brand→origin, name fixes, tier changes per party code. The importer re-applies it on every run. It holds **codes and catalog words only, never personal data**. | The importer never auto-deletes or auto-merges (migration doc §2). You decide; the decision survives re-runs and the final 31 Dec run. |
| **Load = upsert by legacy key** (`items.code`, `parties.code`, …), with `legacy jsonb` (label, original IDs) on every row, one transaction per entity group, as the app role inside `withTenant` (RLS applies). A re-run updates changed rows and never duplicates; rows missing from a newer dump are reported, not deleted. | Idempotent and safe to repeat for the rehearsals; rule 5 holds for the importer too. |
| **The load target is a local dev database** (`erp_dev` on this PC), with the Delux tenant created from the reviewed `delux.json` spec. Staging and production get the data in the rehearsal plans (December). | Party contacts stay on your PC until the real migration. |
| **Prices** in minor units, exactly (rule 1). Mechanic = Retail −5%, Wholesale = Retail −10% (PRD Q1), rounded to Rs 1, half away from zero. Floors stay empty and follow the category rule cost + 5% (PRD Q2). | The accepted PRD defaults; you can edit any price later. |
| **Reports** in `out/<label>/reports/`: one CSV per finding (opens in Excel) and an `index.html` summary. **Phone numbers masked** (`0300-***4567`). Party reports are kept separate; I read only the summary counts and the catalog reports, not the party lists. | You review on your PC; I can help with the catalog findings without seeing customer contacts. |

## The mapping (migration doc §3, summarised)

| Legacy | → New |
|---|---|
| `INV_Item.ItemID` | the item code **and** its barcode, kept exactly (shelf labels use it) |
| `Item` (name) | the name, trimmed; numbers in brackets such as `(17910-SO4-E84)` also become OEM identifiers |
| `BrandID` | a brand, except **country names → origin** (PAKISTANI, CHINA, TAIWAN…), `GENUINE` → "Genuine (OEM)", `None` → empty |
| `MakeID` | origin (names fixed: INDONASIA → Indonesia…) |
| `ManufactureID` | a **vehicle make** if on the allow-list (Toyota, Suzuki, Honda… with spelling fixes), otherwise `spec` (H4, 6PK, 6203…) |
| `Model` | years (`2003-2008`, `2012-ON`) or a model name (`MEHRAN`, `CIVIC`) on the vehicle tag |
| `PartNo` | an OEM identifier if it looks like a part number, otherwise added to `spec` and listed for review |
| `ItemReferenceNo` · `PlaceofItem` · `SizeID` | alternate identifier · bin location · variant (R/H, FRONT…) |
| `SalePrice` · `CostPrice` | Retail price (+ Mechanic, Wholesale) · kept in `legacy` for the opening-stock fallback (Wave 1) |
| `MinQuantity`, `MaxQuantity`, `IsExcludeOrderList`, `DefaultSupplierCode` | as they are (default supplier via the party mapping) |
| `INV_BusinessPartner` (not `0001`/`0002`, the cash partners) | parties, code = legacy ID; supplier and/or customer accounts from the role rows; label abbreviation, contacts (phones de-duplicated), NTN. No CNIC (already dropped in staging). |
| `GL_ChartofAccount` | `legacy_code` on the matching template account (`10-01-0001` → 1110…); each legacy expense account becomes its own account under 6100/6200/6300/6400 with its name, and an expense category (PRD Q13); partner expenses → 3110 Drawings. The chart is checked again with `validateChartOfAccounts`. |

Customers: Retail tier (you move mechanics to Mechanic in the review), credit allowed, offline cap Rs 25,000/day (PRD Q6), the **limit per your answer to question 1**.

## Cleanup reports (migration doc §7)

- brands that are countries, and their items
- `PartNo` values not taken as part numbers
- `Manufacture` values not on the vehicle-make list
- `Model` values not read as years
- price 0 (258), cost above price (14), no cost
- duplicate names (e.g. 8 × `FREE`), duplicate OEM numbers across items
- parties: no phone, both roles, label abbreviation clashes (masked phones)
- anything staged but not mapped (a column or table this plan didn't expect)

**Not yet:** negative or zero stock with recent sales, and the dormant flag (both need the stock and sales calculation, Wave 1, preferably on the 2026 dump).

## Scope

1. **Migration `0006`** and the Drizzle mirror.
2. **`tools/legacy-import`:** `transform/` rules, the mapping file, `transform`, `report` and `load` steps (`--dry-run` = reports only), `pnpm legacy:import --label <label>` running all three.
3. **Local dev database:** `pnpm dev:db` creates `erp_dev` with the migrations and the Delux tenant (owner `fahad` with a generated password, must change).
4. **Docs:** data model §3, §4 (anything the build changes), the migration README, the plan's results.

**Out of scope:** opening balances, the 90-day bills and reconciliation (Wave 1); loading staging or production (the rehearsal plans); catalog screens (Wave 1).

## Tests written first

- [ ] **Mapping rules (golden):** brand vs origin; origin name fixes; manufacture → make or spec (allow-list, spelling fixes, `HIACE` → Toyota + Hiace, `UNIVERSAL` → none); model → years or name (`2012-ON`, `2003-2008`, `SALOON 1.6`); part number or not (`17910-SO4-E84`, `WHITE`, `FC6`); OEM numbers in names; name clean-up; price text → minor units exactly (`1250.00`, `0.5`, `-0`), tier prices; phones de-duplicated and masked; legacy account → new account.
- [ ] **Load (integration, on a synthetic staging schema):** every row lands with `legacy`; a second run changes nothing; a changed mapping updates the affected rows only; the cash partners aren't parties; the chart still passes the CoA rules; everything is written through `withTenant` (RLS on).
- [ ] **Reports:** each finding file is produced; no unmasked phone in any report file.
- [ ] RLS covers the new tables, and the Drizzle mirror matches (the existing checks).

## Verify

1. `pnpm check` and the integration tests.
2. **On the Dec 2025 copy, on this PC:** `pnpm legacy:import --label dec2025`, then a second run reporting no changes. Expected: **19,552 items** (each with its barcode), **373 parties** (131 customer and 281 supplier roles, 39 both), the chart valid. I paste the summary counts into the plan.
3. **You review the first reports** (issue #14's last criterion). Your decisions go into the mapping file, and the run is repeated.

## Order

1. Failing tests.
2. Migration `0006`.
3. The mapping rules, then load, then reports.
4. The real run, your review, a second run with your decisions.

## Risks

| Risk | Mitigation |
|---|---|
| A rule guesses wrong on thousands of items | Every guess is listed in a report; the mapping file fixes it; re-running is cheap and idempotent. |
| The 2026 dump differs from Dec 2025 (new columns, a new period database) | Staging shows new tables and columns; "staged but not mapped" is reported. The rehearsals run on the 2026 dumps. |
| Personal data leaves this PC | The load target is local; the mapping file holds codes only; party reports stay on this PC and phones are masked. |
| Audit and sync noise from 100k+ imported rows | Accepted: imported master data is audited like any change (PLT-08); the dev database is disposable. |

## Questions for you

1. **Credit limits:** the legacy system has none. What should existing credit customers start with?
   - **a. No limit until you set one** (recommended): credit sales work on day one; the review report lists every credit customer with their legacy balance so you can set limits before go-live.
   - b. One default limit for all (say Rs 50,000), then adjust.
   - c. No credit until you set a limit (safest, but blocks credit sales until then).
2. **Bill header:** `Admin_Company` has the shop name, NTN and sales-tax number, and `Admin_Parameter` probably has the address and phone. May the importer show these (your shop's own details, not customers') so I can propose the receipt header?
3. **Load locally only for now** (staging and production in December's rehearsals). OK?
4. **The 2026 dump:** still needed before the rehearsals. When can you put it in a new folder under `sql_dump/`?

## Owner answers (2026-10-24)

1. **Credit limits:** **a.** Existing credit customers start with **no limit** (`credit_limit` empty = no limit), and the review report lists every credit customer for the owner to set limits before go-live. The offline daily cap (Rs 25,000) still applies.
2. **Bill header:** yes. The importer writes the shop's own details from `Admin_Company` and `Admin_Parameter` (name, NTN, sales-tax number, address, phone; no customer data) to `out/<label>/reports/company.md`, and I propose the receipt header from it.
3. **Load locally only:** yes. Staging and production are loaded in the December rehearsals.
4. **The 2026 dump:** later; needed before the rehearsals.
