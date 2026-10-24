# Go-live checklist (Delux, 1 Jan 2027)

Open items that must be settled before, or soon after, go-live. Each line names where it was decided. Tick it in a PR when it's done.

## Before go-live

- [ ] **Raast and bank-transfer payments:** pick the bank account each one posts to (W0-11 owner answer 2, D-083). The tenant setup lists both under "needs attention" until then.
- [ ] **Credit limits:** migrated credit customers start with no limit (D-085). Set limits from the `parties/credit-customers.csv` report.
- [ ] **Mechanic tier:** mark which customers are mechanics (`partyTiers` in `tools/legacy-import/mapping/delux.json`) and re-run the import (W0-13 owner review).
- [ ] **Bill header:** the legacy database has only the shop name. Give the real address, phone and other header lines; until then the receipt uses placeholder lines (W0-13 owner review).
- [ ] **The 2026 dump:** a current dump in its own folder under `sql_dump/`, before the rehearsals (PRD Q11, W0-12).

## After go-live

- [ ] **Catalog clean-up** from the import reports (W0-13 owner review): 258 items at price 0, 14 with cost above price, 7 duplicate names, PartNo values kept as specs (5,566).

## Not doing

- ~~**Backblaze B2 card**~~: no paid services (D-087). Backups stay within B2's free tier.
