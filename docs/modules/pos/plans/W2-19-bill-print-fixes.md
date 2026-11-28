# W2-19 The printed bill: a barcode that scans, margins that stay, a white page

| | |
|---|---|
| **Issue** | #236 |
| **Module** | pos (printing: `apps/pos/src/print/`, the print rules in `apps/pos/src/styles.css`), and `packages/print` (the Code 39 drawer, shared with the item labels). **The counter's screens don't change**; `packages/ui` doesn't change |
| **Status** | Accepted by the owner (2026-11-28) |
| **Refs** | POS spec §13 (printing); POS-09, POS-16; D-048 (print profiles), D-055 (A5 landscape, Code 39), D-093 (finalize and print); W1-01 (the bill print test at the shop, still open on the go-live checklist); D-127 (the POS keeps its look) |
| **Depends on** | nothing |
| **Size** | about 1 day, plus a print test at the shop |
| **Test-first** | Bugs: failing tests committed and locked first |

## The problem

The owner saved a counter bill as a PDF, printed it on A4 and tried to scan its barcode (2026-11-28). The scanner read the item labels but **not the bill**. The PDF (not committed: it is a real bill) also showed two other things.

1. **The barcode's bars are too thin.** The bill code is the bill number and the cash due (`C01-S000001 5890`, POS spec §13), 16–19 characters, and the bars are always squeezed into **62 mm** (`.bill-bars svg`, `apps/pos/src/styles.css:121`). Worked out from `code39Svg`'s sizes (narrow 1, wide 2.5, quiet zone 10):

   | Code | Characters with start/stop | Narrowest bar |
   |---|---|---|
   | An item label, `ENOL001` | 9 | about 0.3 mm |
   | A bill, Rs 5,890 due | 18 | 0.22 mm |
   | A bill, Rs 1,25,000 due | 20 | 0.20 mm |

   The bigger the amount, the thinner the bars. At 0.2 mm, toner spread fills the gaps and many handheld scanners stop reading. Printing the PDF "fit to page" shrinks it further.

2. **The PDF runs edge to edge.** The bill asks for 8 mm margins with `@page { margin: 8mm }` (`BillPrint.tsx:244`). That is only a request to the print dialog: with *Margins: None* the browser drops it, and the text touches the paper's edges. A printer can't print the outer 3–5 mm, so it clips the edges or shrinks the page, which thins the bars again.

3. **The lower part of the page prints grey.** The page's own background is the counter's screen colour (`body { background: var(--bg) }`, `packages/ui/src/theme.css:139`, `#eceff2`). It prints whenever *Background graphics* is ticked; only the bill's own area is white. **On a counter in the dark theme it is near-black (`#0e141a`)**: most of the page would print black. The cash desk's slips (`DeskSlipPrint.tsx`) have the same page rule and the same background.

## Design

### 1. Bars of a set width; the barcode's width follows the code

- **The narrowest bar is 1/75 inch (0.339 mm)** and the wide bar 2.5 times that (0.847 mm). These land on whole printer dots at both 300 and 600 dpi (4 and 8 dots), so every narrow bar prints the same width. The quiet zone stays 10 narrow bars on each side (3.4 mm); the height stays 11 mm.
- **`packages/print`:** a new `code39Modules(text, options)` gives the barcode's width in narrow bars. `code39Svg` gains optional `width` and `height` in millimetres, written on the `<svg>`, so the drawing has its real size. With neither, it draws as today, so **the item labels don't change**.
- **The bill** draws its barcode with those sizes, and the fixed 62 mm goes. A typical code is about 95 mm wide; the longest likely (a 7-digit cash due) about 110 mm.
- **It fits:** the A5 landscape page has 194 mm between margins, and the totals take 62 mm plus a 6 mm gap, which leaves 126 mm for the barcode and the policy line. The A4 profile has the same width.
- **The code's content doesn't change** (D-055): the cash desk reads it exactly as now.

### 2. Margins that stay

- **The 8 mm moves inside the bill:** `@page { margin: 0 }`, and each bill page gets 8 mm of padding, so the space is there whatever the dialog's *Margins* says.
- **A bill longer than a page** needs the margin on every printed page, not only around the whole bill. The padding is repeated on each page with `box-decoration-break: clone`.
  - **To check while building:** that the counter's Chrome repeats it on a two-page bill.
  - **If it doesn't:** `@page` keeps its 8 mm (as today), and the padding is used only for a one-page bill. A one-page bill is the usual case, and the counter prints silently with the dialog's default margins, which honour `@page`.
- **The cash desk's slips** get the same rule.

### 3. A white page

- When printing, the page is white and the ink black in both themes: `@media print { html, body { background: #fff; color: #000 } }` in the POS's own stylesheet, not in `packages/ui`.
- Bills and the cash desk's slips both benefit.

### What doesn't change

- **The counter's screens:** every rule above is for printing, or for the bill's own elements, which only exist while printing. `e2e/pos-look.spec.ts` must pass unchanged, with no new screenshots.
- The bill's layout otherwise, its words, the A5 / A4 profiles, silent printing, the bill code's text.
- The item labels (back office): `code39Svg` without the new options draws exactly as before.

### The shop test (W1-01)

This is what the go-live checklist's "Bill print test at the shop" item was for, and it is still open. Once this is on staging:

- print real bills on the **HP LaserJet P1005** from a staging counter: one with a small cash due, one with a 6-digit cash due, and a two-page bill;
- scan each with the **cash-desk scanner**;
- tick the checklist item, or note what failed.

## Tests

**Written first, failing, then locked** (`node .claude/hooks/bugfix-lock.mjs lock …`)

- `packages/print` (`code39.test.ts`):
  - `code39Modules` of `C01-S000001 5890` is 280;
  - `code39Svg` with `width` / `height` writes them in mm on the `<svg>`;
  - without them its output is byte-for-byte as before (the labels).
- `apps/pos/src/print/BillPrint.test.tsx`:
  - the bill's barcode is `280 × 0.339 mm` wide for `C01-S000001 5890`, and wider for a bigger cash due, its narrowest bar always 0.339 mm;
  - the page rule asks for no `@page` margin, and the bill page carries the 8 mm padding;
  - the same rule on a cash-desk slip (`DeskSlipPrint.test.tsx`).
- `e2e` (POS, print media emulated after a bill is finished): the page background is white in both themes; the bill's barcode measures as above.

**Kept green:** `pos-look` with its current pictures; the labels' tests and e2e; the counter, cash desk and return flows.

## Verify

- `pnpm check`;
- `pnpm e2e` (all flows; `pos-look` in CI, unchanged);
- `git diff --name-only origin/staging...HEAD -- packages/ui` shown **empty**; the diff under `apps/pos` listed in the PR, all of it print-only;
- a printed PDF of a short and a two-page bill attached to the PR, with *Margins: None* and *Background graphics* ticked;
- after merge: the shop test above.

## Order

1. Failing tests → lock.
2. `packages/print`: `code39Modules`, the mm sizes.
3. The bill: the barcode's size, the margin inside the page; then the cash desk's slips. Check the two-page bill in the counter's Chrome; take the fallback if needed.
4. The white page in print.
5. Unlock. Docs:
   - a line under D-055 (the barcode's bar width, the margins inside the page, a white page when printing);
   - POS spec §13: the barcode's size;
   - "as built" notes here.

One branch off `staging`, one PR.

## Risks

- **A long barcode next to the totals:** at about 110 mm for a 7-digit amount it still fits beside them (126 mm free). A cash due that large isn't a counter bill at Delux.
- **The printer's own scaling:** if the P1005's driver is set to "fit to page", it still shrinks the page. The shop test prints from the counter as configured, which is the case that matters.
- **The scanner may still struggle** if the cause is elsewhere (a scanner set to a short maximum length for Code 39, for example). The shop test shows it. The scanner's settings are then a configuration fix, not code.

## Out of scope

- The thermal templates and the signed QR (D-048: not until a tenant needs them).
- Changing the bill code's content.
- Any change to the counter's screens or `packages/ui`.
