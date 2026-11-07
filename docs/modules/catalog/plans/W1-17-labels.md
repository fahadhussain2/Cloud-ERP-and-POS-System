# W1-17 Labels in the legacy format

| | |
|---|---|
| **Issue** | [#62](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/62) |
| **Module** | catalog (label printing in the back office), with purchasing (labels from a posted goods receipt) and print (`packages/print`, the Code 39 encoder from W1-06) |
| **Status** | Done (2026-11-07): built in PR #116 and fixed after the owner's review in PRs #118 and #120, all merged to staging; the owner verified it on staging (below) |
| **Refs** | CAT-08, PUR-01 (supplier label abbreviation), PRD §5 step 6, PRD Q7 (label printer and size, still open); data model §4 (every item has a barcode identifier = its code); CLAUDE.md rule 10; D-019, D-055, PLT-13 (labels always print light) |
| **Depends on** | W1-15 (items screen and search), W1-16 (goods receipts, supplier `label_abbr`) |
| **Size** | about 1 day: the label page and template ½, from items and from a receipt ¼, tests, e2e and docs ¼ |
| **Test-first** | Yes: the label list from a receipt (counts, fractions, codes Code 39 can't print) as pure tests; the API under RLS and `cat.label.print` (integration); the label layout (component test) |

## Goal

**The shop prints its own item labels from the new system, looking like today's.** Each label has the item code as a Code 39 barcode and the delivering supplier's abbreviation (e.g. ADDI), so a label still tells which supplier a piece came from (D-019). Labels come from a posted goods receipt (one per piece received) or from items picked on the items screen (a relabel, a torn label).

## Design

| Choice | Why |
|---|---|
| **Code 39**, not Code128 as D-019 first said; D-019 is updated to point at D-055 | The legacy labels and bills use Code 39 and the shop's scanners read it (D-055); CAT-08 already says Code 39 |
| **One print screen** (Catalog → Print labels): a list of lines (item, supplier abbreviation, number of labels), a preview of the labels, and Print. Opened from a posted receipt ("Print labels") or from the items screen (select items → "Print labels") | One place to check and change counts before paper is used |
| **From a goods receipt:** labels = the quantity received, in whole pieces; abbreviation = the receipt's supplier. **An item that carries the maker's barcode** (a `barcode` identifier other than its own code) gets 0, **unless the shop's setting "label items with a maker's barcode" is on** (Delux: on, owner answer 4). A fractional item (oil by the litre) gets 1 per line; every count can be changed before printing | Delux labels everything; another shop may rely on the maker's barcode (CAT-08). The barcode is entered anyway so the counter can scan the box, so no per-item tick to keep up; a per-item override waits for a shop that asks. A litre of oil is one container |
| **From the items screen:** 1 label each; abbreviation = the item's last purchase supplier, else its default supplier, else empty; both editable | A relabel is usually one piece; the last supplier is the best guess of whose piece it is |
| **A code Code 39 can't print** (a lower-case letter or a character outside its 43) is listed as a problem and left off the labels; lower case is upper-cased first | Code 39 has no lower case; a wrong barcode is worse than none |
| **Browser printing** of an HTML page sized in millimetres (`@page`), barcodes as SVG from `code39Svg`, always light (PLT-13), one label per page on the Zebra roll (owner answer 1), from the back office (PRD §8) | The same way the bill prints (D-055); no driver or helper to install |
| **Template** (configurable, CAT-08) in the tenant's `settings` jsonb, no migration: a roll only, one label per page: label width × height (mm, Delux 40 × 28), margins, the shop's abbreviation (`DCAC`), whether the item name shows, and whether items with a maker's barcode get labels; the owner only (owner answer 5); the layout is the legacy one (owner answer 3). No A4 sheets (owner answer 1). Set by the owner on the same screen | One shop, one label stock; a table can come later if a tenant needs several |
| **Printing: `cat.label.print`** (owner, manager, purchaser already have it). **The template: the owner only** (owner answer 5) | The permission exists since W0; the template changes every label, like the shop's other settings |
| **Nothing is stored** about what was printed | A reprint is just printing again; no ledger is touched |

## Scope

- In: the print screen and its preview; from a posted receipt and from items; the template and its settings; the API to build the label list (`GET /api/catalog/labels?receipt=…` / `POST /api/catalog/labels` with item ids); i18n keys; docs (CAT-08 built, D-019 corrected, catalog README).
- Out: labels from the counter (POS), shelf or bin labels, price-change relabel lists (with repricing, Wave 2), direct printing to a label printer without the browser dialog.

## Tests written first

- Pure (`packages/domain` or the catalog lib): the label list from receipt lines — whole pieces; a maker's barcode with the setting on (labelled) and off (0); 1 for a fraction, a supplier with no abbreviation, an unprintable code; one page per label, in the order of the list.
- Integration: the label list for a posted receipt and for item ids, under RLS (another shop's receipt is 404), a draft receipt refused, a salesman refused (403); saving the template only by the owner (a manager gets 403).
- Component: the preview shows the right number of labels with the code, the abbreviation and the barcode; changing a count updates it; a problem line is shown and not printed.
- e2e: post a receipt → Print labels → the preview has one label per piece received, an item with a maker's barcode included.

## Verify

`pnpm check`, `pnpm test:integration`, `pnpm e2e`. **On the shop's printer:** print a receipt's labels on the Zebra and scan three of them at the counter (the item comes up), and compare with a legacy label side by side.

## Order

Label list (pure) → API with integration tests → print screen, preview and template → buttons on the receipt and items screens → e2e → docs.

## Risks

| Risk | Mitigation |
|---|---|
| The browser adds its own margins or scales the page, so labels drift off the stickers | `@page` size and margins in mm; the screen says to choose "Margins: none" and "Scale 100 %"; checked on the shop's printer before sign-off |
| A long code makes the barcode too wide for the label | The barcode narrows its bar width to fit, down to the narrowest the scanner reads; below that, a problem line instead of a bad barcode |
| Labels printed before go-live for stock received in legacy | Allowed: labels only need items and suppliers, which the importer brings |

## Changes during the build

| Change | Why |
|---|---|
| The API: `GET /api/catalog/labels/receipt?receipt=<id or number>`, `POST /api/catalog/labels/items`, `GET`/`PUT /api/catalog/labels/template` | One address for a receipt typed by number (as the legacy screen) or opened from the receipt |
| Reading the template needs `cat.label.print` or `admin.settings`; saving it `admin.settings` | The owner's only (owner answer 5); the printers need it for the layout |
| A template's limits: width 20–104 mm (the GX420t's widest), height 10–200 mm, margin 0–5 mm leaving 10 mm of label, the shop's abbreviation up to 10 characters | So a typo can't produce a label the printer can't take |
| The supplier abbreviation is printed in capitals | As the legacy labels; abbreviations were typed either way |
| The relabel is on the items screen, so it needs the items screen's permissions too (`cat.item.edit` or `cat.price.edit`) as well as `cat.label.print`; a purchaser prints from a receipt or by its number | The items screen is the catalog's; a relabel is rare |
| The back office depends on `@erp/print` (the Code 39 drawing the counter's bill uses) | One barcode drawing for bills and labels |
| The preview shows up to 60 labels; all of them print | A receipt of 500 pieces stays quick on screen |
| Recorded as D-106; D-019 points at Code 39 | CAT-08 stays as written, with the shop setting for the maker's barcode |

## Checks (2026-11-07)

- `pnpm check` (format, lint, typecheck, tests with coverage, build): pass, 1,936 tests.
- `pnpm test:integration`: 346 passed (33 files), including the labels API (10).
- `pnpm e2e` (Edge): 49 passed; the purchasing flow now opens the posted receipt's labels (10 cans → 10 labels with NG and the barcode).
- **Not yet:** printing on the shop's Zebra and scanning at a counter (go-live checklist).

## Owner review on staging (2026-11-07)

The owner tested the screens, the template and the labels on staging: **working as expected**, after three fixes.

| Finding | Fix |
|---|---|
| The two panels on Print labels had no inner padding | Padding as on the other back-office screens (PR #118) |
| The name sat at the start of the label; legacy centres it | The name centred, a long one cut at both ends (PR #118) |
| The code under the barcode was plain text; legacy prints `*CODE*` across the bars, each character under its own bars | `*CODE*`, inset by the barcode's quiet zones (`code39Width` in `@erp/print`), each character centred in its own cell (PRs #118, #120) |

Two UI tests that flaked on CI during the review now wait for their preconditions (PR #119).

**Still on the go-live checklist:**
- printing on the shop's Zebra with the final template (DCAC, maker's barcode on);
- scanning a printed label at a counter.

## Evidence (owner, 2026-11-07)

- **Printer:** Zebra GX420t (thermal transfer, 203 dpi), a roll of single labels, one across.
- **Legacy label** (PDF from the legacy app): page 114 × 79 pt ≈ **40 × 28 mm**. On it: a bold code at the top left (12 pt, Arial Narrow Bold), a smaller bold code at the top right (8 pt), the item code as a **Code 39 barcode with the text under it** (IDAutomationHC39M, 10 pt, start/stop `*`), and the item name on one line at the bottom (6 pt Arial Narrow, cut at the label's width).
- **Legacy screen "Barcode Printing":** pick by category or by a purchase invoice range; Label (roll) or Sheet; a list of code, item, quantity and "BP Abbr." (the supplier abbreviation), each line ticked and editable, then Process.

## Owner answers (2026-11-07)

1. **Always the Zebra roll** (GX420t, 40 × 28 mm labels); A4 label sheets are not used. The label size is evidence above (PRD Q7 answered for labels).
2. **Nearly always by purchase invoice.** No picking by category; the items screen covers a relabel.
3. **The label's contents:** top left, large bold = the **shop's abbreviation** (Delux: `DCAC`, Delux City Auto Corner), a tenant setting; top right, smaller bold = the **supplier's abbreviation** (`label_abbr`, e.g. `DCEN`), so a piece bought from several suppliers shows whose it is (D-019); then the Code 39 barcode of the item code with the code written under it; the item name on one line at the bottom, cut at the label's width. No price.
4. **Delux always prints its own labels** and never relies on the maker's barcode. Other shops may, so it is a shop setting ("label items with a maker's barcode", Delux on); off, an item with a maker's barcode starts at 0 (CAT-08).
5. **Only the owner changes the label template** (and that setting).

## Owner questions

1. ~~The label stock and printer~~ — answered above.
2. ~~What else is on today's label~~ — answered above.
3. ~~The maker's barcode rule~~ — answered above.
4. ~~Who may change the label template~~ — answered above.
