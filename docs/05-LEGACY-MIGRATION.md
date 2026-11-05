# Legacy Migration: mapping and plan

| | |
|---|---|
| **Status** | Draft for owner review |
| **Source** | SQL Server database `DLX_Inventory2024`, SSMS "Generate Scripts" output in `sql_dump/` (analysis copy dated 6 Dec 2025) |
| **Target** | Tenant "Delux Autos", go-live 1 Jan 2027 |
| **Related** | [Data model](03-DATA-MODEL.md) · [Posting rules §7](04-ACCOUNTING-POSTING-RULES.md) · [PRD MIG-01..04](01-PRD.md) |

> **Data protection:** `sql_dump/` contains customer phone numbers, addresses and employee names, and the legacy users table holds passwords. It must **never be committed to git** or copied to the server. Only the transformed import is loaded. Legacy passwords are never read or migrated.

---

## 1. Source facts

| Fact | Value |
|---|---|
| Format | One `.sql` file per object, **UTF-16 LE**, CRLF, `INSERT ... VALUES` statements |
| Dates | `CAST(0x<16 hex> AS DateTime)` = 4-byte signed days since 1900-01-01 + 4-byte ticks of 1/300 s |
| Scope keys | `CompanyID = 1`, `ChartOfAccountID = 1`, `PeriodID = 1` (period "07-2025": 2025-07-01 → 2025-12-31) |
| Period databases | The DB name (`2024`) differs from its period (Jul–Dec 2025). Legacy appears to create **a new database per period**, and document numbers restart (`000001`) in each one. The final migration must use the database that is current on 31 Dec 2026. The owner provides it as an SSMS script dump in the same format, plus a current 2026 dump by ~31 Oct (PRD Q11). |
| Row counts (Dec 2025 copy) | Items 19,552 · Business partners 375 (281 supplier roles, 131 customer roles, 39 parties with both) · Categories 267 · Brands 330 · Origins ("Make") 23 · Manufacture 214 · Size 74 · Units 5 · CoA 77 · Sale headers 22,644 / lines 35,152 · Purchase headers 1,280 / lines 10,736 · GL headers 24,976 / lines 53,799 · Users 17 (13 enabled) |

## 2. Pipeline (`tools/legacy-import`)

```
sql_dump/*.sql (UTF-16)
  → 1. parse   : decode UTF-16, tokenize INSERT values, convert CAST(0x.. AS DateTime)
  → 2. stage   : load raw rows into a local staging DB (legacy_* tables), untouched
  → 3. transform: apply the mapping rules below → candidate rows + cleanup findings
  → 4. report  : HTML/CSV reports (counts, findings, reconciliation) for owner review
  → 5. load    : insert into the tenant (via the db package, inside one transaction per entity group)
```

- **Idempotent and re-runnable.** Every loaded row keeps `legacy jsonb` (original IDs), so a re-run updates instead of duplicating. A `--dry-run` produces reports only.
- **Two rehearsals** (on a mid-December dump), then the **final run** on the night of 31 Dec after the legacy day close.
- Development starts on the 6 Dec 2025 copy, so all build work uses real data from Wave 0.

## 3. Master data mapping

### 3.1 Tenant and reference data
| Legacy | → New | Rule |
|---|---|---|
| `Admin_Company` (Delux Autos) | `tenants` | Name, PKR (2 minor units), `Asia/Karachi`, FY start **January**, tax_mode `none`, rounding Rs 1 |
| `Admin_Country`, `Admin_City` | party `country`, `city` text | Pakistan / Karachi |
| `Admin_Currency` | `tenants.base_currency` | PKR |
| `INV_Unit` (PCS, SET, LITRE, METER, FOOT) | `units` | 1:1 by name |
| `GEN_Doctype`, `Admin_Menu*`, `Admin_Parameter`, `Admin_Period*`, `GEN_Model` (year list) | none | Not migrated (UI/config of the old app) |

### 3.2 Catalog dimensions
| Legacy | → New | Rule |
|---|---|---|
| `INV_Category` (code e.g. `ABEA`, name) | `categories` | 1:1. Keep `code`. Flat (no parent) at first. |
| `INV_Brand` | `brands` / `origins` | **Overloaded:** ~7,900 items have a country as "brand" (PAKISTANI 3,074 · CHINA 2,877 · TAIWAN 268 · THAILAND 179 · JAPAN 118). Country-like brands → set the item's **origin** (if empty) and leave the brand empty. `GENUINE` (1,396) → brand "Genuine (OEM)". `None` → empty. Others → brands 1:1. |
| `INV_Make` (Pakistan, CHINA, JAPAN…) | `origins` | 1:1 (country of origin). Normalize names (e.g. `INDONASIA` → Indonesia, `HUNGRY` → Hungary, `SAUDIA ARABIA` → Saudi Arabia). |
| `INV_Manufacture` / `INV_ManufactureCT` (214) | `vehicle_makes` **or** `items.spec` | **Overloaded.** Values in the vehicle-make allow-list → `vehicle_makes`, with fixes `HYNDAI`→Hyundai, `CHEVERLET`→Chevrolet, `SUBARO`→Subaru, `VOLKS WAGON`→Volkswagen. `HIACE` → make Toyota + model Hiace. `UNIVERSAL`, `OTHER CARS`, `LOCAL`, `TRUCK`, `NONE` → no make (generic). **Everything else** (H4, 9005, 6PK, 6203, ENGINE OIL, BODY POLISH…) → `items.spec` text. |
| `INV_Size` (R/H, L/H, FRONT, REAR, SET…) | `items.variant` | Text; `None` → empty |

Allow-list for vehicle makes: Toyota, Suzuki, Honda, Daihatsu, Nissan, Hyundai, Mitsubishi, Kia, Changan, FAW, Chevrolet, Datsun, Daewoo, Mazda, Subaru, Volkswagen. The owner can extend it during cleanup review.

### 3.3 Items (`INV_Item` → `items` + `item_identifiers` + `item_compatibility` + `item_prices`)
| Legacy column | → New | Rule |
|---|---|---|
| `ItemID` (e.g. `ABEA001`) | `items.code` **and** `item_identifiers(kind=barcode)` | **Kept exactly.** Labels already on shelves encode this code. |
| `Item` (name) | `items.name` | Trimmed, whitespace collapsed. Case kept (upper). **Also:** parenthesized groups containing digits (4,206 names, e.g. `(17910-SO4-E84)`) → extra `oem` identifiers. The name itself is not changed. |
| `CategoryID` | `category_id` | By code |
| `UnitID` | `unit_id` | By name |
| `BrandID`, `MakeID` | `brand_id`, `origin_id` | Per §3.2 |
| `ManufactureID` (+CT) | `item_compatibility.make_id` or `items.spec` | Per §3.2 |
| `Model` (3,335 distinct values) | `item_compatibility` | Year range (`2003-2008`, `2012-ON`; 6,312 items) → `year_from/year_to` (ON = open-ended). Other text (`MEHRAN`, `CIVIC`, `SALOON 1.6`; 10,536 items) → `model`. Empty (2,704) → no tag unless a make exists. One compatibility row per item from make + model/years. |
| `SizeID` | `items.variant` | Per §3.2 |
| `PartNo` (11,553 filled) | `item_identifiers(kind=oem)` **or** attribute | Looks like a part number (≥ 5 chars, has digits, has a dash or ≥ 4 digits; ~5,900) → OEM identifier. Otherwise (`WHITE`, `BLACK`, `REBORN`, `FC6`, `LK20`…; ~5,600) → appended to `items.spec` and listed in the cleanup report. |
| `ItemReferenceNo` (426) | `item_identifiers(kind=alternate)` | As is |
| `PlaceofItem` (2,379) | `items.bin_location` | `0` and empty → null |
| `DefaultSupplierCode` | `items.default_supplier_id` | Via the party mapping |
| `MinQuantity`, `MaxQuantity` | `min_qty`, `max_qty` | As is. 0/1 defaults are kept but flagged as "untuned" in the report. |
| `IsExcludeOrderList` | `exclude_from_reorder` | As is |
| `SalePrice` | `item_prices(RETAIL)` | Converted to minor units. 258 items with price 0 → flagged. |
| (none) | `item_prices(MECHANIC, WHOLESALE)` | Initialized from Retail by the rule agreed in PRD Q1 |
| (none) | `items.floor_price` | Null → category rule (PRD Q2) |
| `CostPrice` | `item_costs.last_cost` | Fallback cost only (see §4.1). 14 items with cost > sale price → flagged. |
| `OpeningQuantity`, `OpeningRate` | none | **Not used.** Opening stock comes from computed closing stock (§4.1). |
| `BPAccountCode` | none | Ignored (legacy GL link) |
| Not sold since a cutoff (e.g. 12 months) | `items.status = dormant` | Hidden from default search ranking but still searchable and sellable. Never deleted. |

### 3.4 Parties (`INV_BusinessPartner` + `INV_BusinessPartnerSelection`)
| Legacy | → New | Rule |
|---|---|---|
| Partner `0001 CASH PURCHASE`, `0002 CASH SALE` | none | Not parties. Cash sales = walk-in; cash purchases = goods receipt with `payment_mode = cash`. |
| Each other partner | `parties` | One party per `BusinessPartnerID`. `code` = legacy ID. |
| Selection type 1 (Supplier) | `supplier_accounts` | |
| Selection type 2 (Customer) | `customer_accounts` | Tier = Retail (owner reassigns mechanics to the Mechanic tier during review). Credit allowed = yes for existing credit customers. Limit = PRD Q6. |
| Both types (39) | Both account rows on one party | |
| `BPNameAbbr` (286 filled) | `parties.label_abbr` | Printed on labels (D-019) |
| `ContactPerson`, phones/mobiles, emails, addresses | `contact_person`, `phones[]`, `email`, `address` | Empty strings → null. Phones de-duplicated. |
| `BPNTN` | `tax_id` | |
| `BPCNIC` (2 rows) | none | **Not migrated** (national ID; not needed) |
| `BPFax*` | none | Dropped |

### 3.5 Chart of accounts (`GL_ChartofAccount` → `accounts`)
The tenant gets the [template CoA](04-ACCOUNTING-POSTING-RULES.md#2-default-chart-of-accounts-retail-template). Legacy accounts map as follows (`legacy_code` kept and searchable):

| Legacy | → New |
|---|---|
| `10-01-0001` Cash in hand | 1110 Cash drawer |
| `10-01-0002` Cheque in hand, `10-01-0003` Cash memo, `10-01-0004` Cash for payment | **Not migrated.** They have no transactions and a zero balance in the legacy data, and customers don't pay by cheque (PRD Q8). The final run re-checks them: any account holding a balance on 31 Dec is migrated as an asset account under 1100 and flagged. |
| `10-02-0001` Cash sale (control) | **Retired.** Cash sales go through 1120 Cash in transit. |
| `10-03-0001` Customers | 1200 AR control (sub-ledger by party) |
| `10-04-0001` Soneri bank, `10-04-0002` HBL | 1150 / 1160 + `bank_accounts` rows |
| `20-01-0001` Purchases (under Liabilities) | **Retired.** Replaced by 1300 Inventory + 5100 COGS. |
| `20-02-0001` Suppliers | 2100 AP control |
| `20-03-0001` Cash purchase | **Retired** |
| `30-01-0001` Sales | 4100 Sales (sale returns go to 4110) |
| `30-02-0001` Purchase discount | **Retired** (discounts are capitalized into cost, D-057) |
| `30-02-0002` Sale discount | 4120 Sales discounts |
| `40-01-*` Misc expenses | 6400… (one account each, same names) |
| `40-02-*` General expenses | 6300… |
| `40-03-*` Utilities | 6200… |
| `40-04-*` Salaries (per person) | 6100… (names kept; access restricted to Owner/Accountant) |
| `40-05-*` Partner expenses | 3110 Partners' drawings (D-057) |
| `50-01-0001` Investment, `50-01-0002` Drawing | 3100 Capital, 3110 Drawings |

Expense accounts used for cash-out at the desk become `expense_categories` (PRD Q13).

## 4. Opening balances (as of close of business 31 Dec 2026)

### 4.1 Stock quantity and cost
- **Quantity** per item = legacy closing stock as of 31 Dec 2026, as the legacy Closing Stock report computes it (D-102): `INV_Item.OpeningQuantity` ± the `INV_StockRecordTAB` rows up to the cutoff, with physical-stock counts taken from the count sheet's signed lines. Sale lines are not summed (legacy stores their quantities negative). It is compared **per item** with the legacy Item Wise Closing Stock report on the dump day (rehearsal 2: all 20,163 items matched).
- All of it goes into **SHOP**. Legacy has no godown split (PRD Q9: the godown is counted and transferred in January).
- **Average cost** (D-103) = the latest `INV_StockRecordTAB.ValuationRate` on or before the cutover (this mirrors legacy `fn_GetValuationRate`). Fallback: the last purchase rate in the period, then `INV_Item.OpeningRate` (legacy's carried-forward average, as its Closing Stock report values old stock) unless it is above Retail, then `CostPrice`. Items with no cost → flagged and valued at 0 until fixed. `cost-compare.csv` lists every item whose cost differs from the legacy report's Average Rate, with the reason.
- **Negative quantities** (15 items in the Dec 2025 copy) → loaded as negative and listed for the first January cycle counts.
- It is posted as an opening stock movement plus `Dr INVENTORY` in the opening entry.
- **As built (W1-14, D-101):** the document types and their signs are in `opening.docTypes` of the mapping file (Dec 2025: 21 Purchase +, 32 Purchase return −, 31 Sale −, 22 Sale return +, 11 Physical stock + with signed quantities, proposed from the names and to be confirmed). Two cross-checks are reported per item: the legacy running balance (the latest `INV_StockRecordTAB.StockQuantity`) and the sum of the stock records' own quantities. With `out/<label>/legacy-closing.csv` (item, qty, from the legacy report) the run also writes `closing-compare.csv`, and `periods.csv` gives the legacy period and each stock table's first and last date.

### 4.2 Customer and supplier balances
- Balance per party = Σ (`AmountDR − AmountCR`) on GL lines for the control account (`10-03-0001` customers, `20-02-0001` suppliers) **grouped by `SubAccountCode`** (= party ID), including the legacy opening-balance voucher (doctype 10).
- Each non-zero balance becomes **one opening party-ledger entry** dated 2027-01-01. Ageing starts at go-live. Older invoice-level ageing is not reconstructed.
- Reference (Dec 2025 copy): customers ≈ Rs 0.68 M across 131 accounts, suppliers ≈ Rs 5.79 M across 281 accounts. The owner confirms the top 20 balances of each before go-live.

### 4.3 Cash and bank
- Drawer: physically counted at opening on 1 Jan.
- Banks and wallets: **bank statement balances** at 31 Dec.
- The legacy GL cash/bank figures are only compared, not trusted.

### 4.4 Opening journal
As in [posting rules §7](04-ACCOUNTING-POSTING-RULES.md#7-opening-balances-at-cutover-delux-1-jan-2027): the balancing line goes to Opening Balance Equity, and the lock date is set to 2026-12-31.

## 5. Transaction history
| Data | Migrated? | Rule |
|---|---|---|
| Sale bills, last 90 days | **No** (D-100, owner answer 4 to W1-13; MIG-03 dropped) | A part bought before go-live is a no-receipt return: the manager looks the bill up in the read-only legacy system and sets the refund price; the old number is kept as the return's reference. |
| Older sales, purchases, GL vouchers | No | They stay in the legacy DB, which is kept **read-only** for reference |
| Purchase history | Derived only | Last supplier and last cost per item → `item_costs.last_supplier_id/last_cost` (for reorder suggestions) |
| Sales history | Derived only | 30/90-day sales quantity per item for the **first** reorder suggestions, and "last sold date" for the dormant flag |
| Physical stock counts | No | |

## 6. Users and roles
- The 13 enabled legacy users are **re-created by hand** in the new system, with their real names. Case duplicates (`FAIZAN` / `faizan` / `fAIZAN`) become one person.
- The shared `admin` account is **retired**. Each person gets their own account and PIN.
- Legacy role memberships (Administrator 4, Manager 4, User 2, Counter 11) are only a hint. Roles are assigned from the new templates.
- **No passwords are migrated.**

## 7. Cleanup reports (produced on every run)
| Report | Purpose |
|---|---|
| Brand-as-country items | Confirm the origin mapping |
| `PartNo` values not classified as part numbers | Review: colour, model code, or real part number? |
| Manufacture values not in the vehicle allow-list | Extend the allow-list or keep as spec |
| Model values not parsed as years | Fix the common ones (e.g. `SALOON 1.6`) |
| Price 0 (258) · cost > price (14) · no cost | Fix before go-live |
| Duplicate names (e.g. 8 × `FREE`) and duplicate OEM numbers across items | Merge or keep |
| Negative / zero stock with recent sales | First cycle counts |
| Parties with no phone, both roles, or abbreviation clashes | Contact cleanup |

The importer **never auto-deletes or auto-merges**. It reports, and the owner decides. Cleanup decisions are saved as a mapping file that is re-applied on every run.

## 8. Reconciliation checks (gate for go-live)

Built in W1-14 (`reports/opening/reconciliation.html`): each check below is read from the tenant's own ledgers after posting and shown as *pass*, *differs* or *waiting* (for the legacy report totals the owner types into `legacy-totals.json`).
| Check | Tolerance |
|---|---|
| Item count loaded = legacy item count | Exact |
| Σ opening stock qty and Σ value vs legacy Closing Stock report | Exact qty; value within Rs 1 per item for rounding |
| Σ customer balances and Σ supplier balances vs legacy Customer/Supplier Outstanding reports | Exact |
| Top 20 customer and supplier balances confirmed by the owner | Signed off |
| Opening journal balances (Dr = Cr) | Exact |

## 9. Timeline
| When | Run |
|---|---|
| Wave 0 (Oct) | Build the importer against the 6 Dec 2025 copy. Iterate on the cleanup reports with the owner. |
| By ~31 Oct | Owner provides a **current 2026 dump** (same SSMS format). Re-run the importer to confirm the per-period database structure and refresh the development data. |
| ~10 Dec 2026 | **Rehearsal 1** on a fresh dump. Full reconciliation. |
| ~22 Dec 2026 | **Rehearsal 2.** Timed end to end. Must take < 1 h. |
| 31 Dec 2026, after close | **Final run** → wipe the pilot (D-101) → reconciliation sign-off → set the lock date (`erp-tenant go-live`) → open for business 1 Jan. |
| W1-14 (4 Nov 2026) | **Rehearsal 1** on the Dec 2025 copy, on this PC, into a fresh database: the pipeline end to end (results in the W1-14 plan). The run on the 2026 dump follows when it arrives. |
