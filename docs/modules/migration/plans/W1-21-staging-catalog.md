# W1-21 The real Delux catalog on staging (catalog only)

| | |
|---|---|
| **Issue** | to be opened when the plan is accepted |
| **Module** | migration (with devops for the server command) |
| **Status** | Draft, for the owner's review (2026-10-27) |
| **Refs** | D-076 (no production data on staging), D-083 (tenants from specs, `erp-tenant`), D-084, D-085 (legacy importer, `legacy` columns); CLAUDE.md rule 11; sync spec §3 (`CATALOG_COLUMNS`); W1-03, W1-05 Verify 3 |
| **Depends on** | W0-13 (the catalog in `erp_dev`), W0-11 (`erp-tenant`) |
| **Size** | about 1 day |
| **Test-first** | Yes: what the export keeps and drops, and what the load accepts and refuses |

## Goal

**Staging shows the shop's real catalog**, so W1-03 and W1-05 (and every later counter task) can be tried there with the real 19,552 items, part numbers, vehicle tags and prices. **No personal data leaves this PC:** no customers, suppliers, staff, balances or legacy values.

## Design

| Choice | Why |
|---|---|
| **A new decision, D-093:** the Delux **catalog only** may go to staging. D-076 keeps production data off staging because staging is less protected; the catalog is the shop's price list (business data, no personal data), and the owner chose to have it there (2026-10-27). Everything else stays off. | The owner's answer; the rule's reason (personal data) doesn't apply to these tables. |
| **What goes** (by code, never by id): price tiers (code only, to match), units, categories, brands, origins, vehicle makes, items, item identifiers, vehicle tags, item prices. **Exactly the columns the counter already receives** (`CATALOG_COLUMNS` in `@erp/contracts`, sync spec §3), minus ids, which staging makes itself. | One reviewed column list for "may leave the server"; a new column never travels without being added there. |
| **What never goes:** `legacy` (original values from the dump), `default_supplier_id` (18,657 items link a supplier), `min_qty`, `max_qty`, `exclude_from_reorder`, costs, audit columns, and every non-catalog table. A supplier part number (`supplier_ref` identifiers) is a part number, not a party: it goes. | The legacy values and supplier links are where personal data could ride along. |
| **Export, on this PC:** `pnpm catalog:export <file>` reads `erp_dev` (or a named local database) and writes one gzipped JSON file with the rows, their counts and a SHA-256. It refuses a database that isn't on this PC. | The same local-only guard as `dev:reset-password`. |
| **Load, on the server:** `sudo erp-tenant load-catalog staging delux <file>`. It runs in the staging API image like `erp-tenant setup`, as the owner role, inside one transaction with the tenant set (RLS on), and **refuses `prod`** (production's catalog comes from the importer at cutover, W1-14). Create-if-missing by code: a second run adds nothing; a changed price is reported, never overwritten. | The existing, reviewed path onto the server database; nothing new is opened. |
| **Getting the file there:** `scp` over the existing admin SSH key, deleted from the server after the load. No third-party service. | D-087 (no paid services); the file is never public. |
| **Counters on staging** pull the new catalog as usual (the change feed), so nothing changes in the POS. | Sync spec §2. |

## Scope

1. **Docs:** D-093; this plan; migration README (the two commands); infra README (*Tenants*: the staging catalog).
2. **`tools/legacy-import` or `packages/db`:** the export (`catalog:export`) and the load (`loadCatalog`), with the allow-list taken from `CATALOG_COLUMNS`.
3. **`apps/api`:** the load's entry point for the one-off container (like the tenant setup's).
4. **`infra/db/bin/erp-tenant`:** `load-catalog <env> <shop> <file>`, refusing `prod`.
5. **Then (owner, with Claude):** `erp-tenant setup staging delux --generated` if staging has no Delux shop yet, export, copy, load, and check a search on the staging counter.

**Out of scope:** customers, suppliers and opening balances on staging (never, per D-076); keeping staging's catalog in step with `erp_dev` automatically (run the commands again when needed); production (W1-14).

## Tests written first

- [ ] **Export (integration, on a test database seeded with a catalog that has `legacy` values and supplier links):** the file holds exactly the listed tables and columns; no `legacy`, `default_supplier_id`, reorder settings or ids; counts and SHA-256 match; a non-local database is refused.
- [ ] **Load (integration):** loads into a test tenant with RLS on; a second run adds nothing; a changed price is reported, not applied; an unknown table or column, a wrong SHA-256 or a missing tier is refused and nothing is written; `prod` is refused.
- [ ] **Round trip:** export from one test database, load into another, and the counter's pull returns the same items, identifiers, vehicle tags and prices.

## Verify

1. `pnpm check` and `pnpm test:integration`, output shown.
2. On staging: the load reports 19,552 items; a staging counter's first catalog load finishes; searches like `17801`, `fan belt cultus` and `brake pads corolla 2012` find the same items as locally.
3. On staging's database: no row in parties or customer tables for Delux, and no `legacy` value on any catalog row.

## Risks

| Risk | Mitigation |
|---|---|
| Personal data rides along in a column added later | The allow-list is `CATALOG_COLUMNS`, the same list that decides what goes to every counter; a test fails on any column outside it. |
| The command is run against production by mistake | `erp-tenant load-catalog` refuses `prod`; the export refuses non-local databases. |
| The file is left on the server | The command deletes it after a successful load, and the infra README says so. |
| Staging drifts from `erp_dev` | Run the two commands again; the load adds what's new and reports price changes. |

## Questions for the owner

1. **D-093 as written:** the catalog (items, part numbers, vehicle tags, tiers and prices) may go to staging; customers, suppliers, staff, balances and legacy values never. *Recommended: yes.*
2. **Staging's shop code:** load into a `delux` shop on staging (same code as production), or keep the catalog under the `demo` shop? *Recommended: `delux`, so staging looks like the real shop.*
3. **Price changes on a re-run:** report them only (as planned), or update staging's prices to match `erp_dev`? *Recommended: report only for now.*
