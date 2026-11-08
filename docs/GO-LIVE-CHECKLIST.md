# Go-live checklist (Delux, 1 Jan 2027)

Open items that must be settled before, or soon after, go-live. Each line names where it was decided. Tick it in a PR when it's done.

## Before go-live

- [x] **Raast and bank-transfer payments:** both post to HBL for now (W1-08 owner answer 1, D-095). Changing the bank later is an edit to `infra/db/tenants/delux.json` and a setup re-run.
- [ ] **Re-run the Delux setup on production** after W1-08 is released: it adds 1190 *Posting suspense*, marks the default tax code and maps Raast and bank transfer to HBL (`sudo erp-tenant setup prod delux`), then `sudo erp-tenant posting-check prod delux`.
- [ ] **From go-live, purchases are entered only in the new back office** (D-105): supplier bills as goods receipts, returns, bank payments; cash for a supplier is paid at the desk. Until then in the legacy app.
- [ ] **From go-live, items and prices change only in the new back office** (D-104): until then in the legacy app, since the final import overwrites the catalog. Tell the staff on the go-live day.
- [ ] **Credit limits:** migrated credit customers start with no limit (D-085). Set limits from the `parties/credit-customers.csv` report.
- [ ] **Mechanic tier:** mark which customers are mechanics (`partyTiers` in `tools/legacy-import/mapping/delux.json`) and re-run the import (W0-13 owner review).
- [ ] **Bill header:** the legacy database has only the shop name. Give the real address, phone and other header lines; until then the receipt uses placeholder lines (W0-13 owner review).
- [ ] **The 2026 dump:** a current dump in its own folder under `sql_dump/`, before the rehearsals (PRD Q11, W0-12). Then re-run rehearsal 1 on it: `legacy:stage`, `legacy:import`, `legacy:opening` (W1-14 owner answer 2).
- [x] **Legacy stock document types and the quantity rule:** settled by rehearsal 2 (D-102): every item matched the legacy Closing Stock report of 5 Nov 2026.
- [ ] **On each dump day:** run the legacy Item Wise Closing Stock report for the same day as the dump, after closing, and put it per item into `out/<label>/legacy-closing.csv`; `closing-compare.csv` must be empty (D-102), and `cost-compare.csv` reviewed: only `report_zero`, opening rates above Retail and a few rupees of rounding are expected (D-103).
- [ ] **The pilot opening (by ~28 Nov):** a dump taken after a day close in the last days of November, its masters and opening loaded into production over an SSH tunnel, `posting-check prod delux` (W1-14 owner answers 2, 3).
- [ ] **The legacy report totals** on each dump day: Closing Stock quantity and value, Customer and Supplier Outstanding into `legacy-totals.json` (W1-14 owner answer 4).
- [ ] **Top 20 customer and supplier balances signed off** from the reconciliation report (migration doc §8).
- [ ] **The final run (31 Dec, after the legacy day close):** every counter's outbox at 0 on the device health page; a production backup; `ssh -t … sudo erp-tenant wipe-pilot prod delux`; clear each pilot counter's site data and enrol it again; stage, import and `legacy:opening --post` the final dump with the counted drawer and bank statements; the reconciliation signed; `sudo erp-tenant go-live prod delux 2026-12-31`; `posting-check prod delux` (D-101). Rehearse it in rehearsal 2 (~22 Dec) on a copy of production.

- [ ] **Bill print test at the shop** (speed and barcode scan) by mid-November, with real bills once checkout exists (W1-01, deferred; the printer is an HP LaserJet P1005, so lower risk than the dot-matrix assumption).
- [ ] **Label template on production** (W1-17, D-106): the owner opens Catalog → Print labels → Label template and sets the shop abbreviation **DCAC** and **Label items that already carry the maker's barcode: on** (40 × 28 mm, 1 mm margin, the name printed).
- [ ] **Label print test on the Zebra** (W1-17): on the PC that prints labels, print a posted receipt's labels (print dialog: the Zebra, Margins: None, Scale: 100 %); scan three at a counter (the item comes up) and compare with a legacy label side by side.
- [ ] **Stock settings on production** (W1-18, D-107): the owner opens Stock → Stock settings and checks that the approval limit is **Rs 10,000** and that **no route needs receiving** (the Godown is in the same building).
- [ ] **Staff roles for stock** (W1-18): the storekeeper has the Purchaser role (drafts transfers); only the owner and the manager post transfers and adjustments.
- [ ] **Who keeps the books** (W1-19, D-108): if Delux has an accountant, they get their own login with the Accountant role; otherwise the owner keeps the books. The manager has no accounting.
- [ ] **Expense categories and bank charges** (W1-19): the accountant checks Accounting → Expense categories against the legacy expense heads, and adds a *Bank charges* category (on its own expense account) for card settlement and bank fees.
- [ ] **The first lock** (W1-19): after go-live the books are locked up to 31 Dec 2026 (the go-live mark); Accounting → Periods shows it, and the first month to lock is January 2027, once it is checked.

## After go-live

- [ ] **Catalog clean-up** from the import reports (W0-13 owner review): 258 items at price 0, 14 with cost above price, 7 duplicate names, PartNo values kept as specs (5,566).

## Not doing

- ~~**Backblaze B2 card**~~: no paid services (D-087). Backups stay within B2's free tier.
