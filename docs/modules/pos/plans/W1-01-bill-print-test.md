# W1-01 Bill print test on the shop's dot-matrix printer

| | |
|---|---|
| **Issue** | to be created on acceptance |
| **Module** | pos (with cash-desk) |
| **Status** | Proposed (2026-10-24) |
| **Refs** | POS-16, CSH-03 (scan handover, offline); PRD §5 targets ("bill printed ≈ 15 s"), PRD Q7; architecture §4.5, §8 (printing); D-047, D-048, D-055, D-088 (proposed) |
| **Depends on** | W0-04 (deploys), W0-08 (Money) |
| **Size** | about 1.5 days of build, plus one hour at the shop |
| **Test-first** | Yes: the Code 39 encoder and the bill-code format |

## Goal

**Prove, on the real printer, that a browser-printed bill is fast enough and its barcode scans**, before we build checkout around it (PRD §5: printed before the salesman reaches the cash counter, about 15 s). If it isn't, we switch to the fallback (a small local print helper sending plain text, architecture §8) now, while it's cheap.

The bill layout and barcode code built here are the real ones: checkout (W1-05) and the cash desk scan (W1-07) reuse them.

## Design (D-088, proposed)

| Choice | Why |
|---|---|
| **The bill is an HTML/CSS page sized A5 landscape** (`@page { size: 210mm 148mm }`), black on white, no shading, large monospace-friendly text, the header lines from the print profile (placeholders for now, go-live checklist). | D-055: the legacy bill is A5 landscape and already prints in graphics mode on this printer. Light layouts print fastest on dot matrix. |
| **The barcode is drawn as SVG bars**, not with a barcode font. A pure Code 39 encoder in a new `packages/print`, shared later by labels (CAT-08). | Crisp at any printer resolution, no font to install on every counter, and testable. |
| **Bill code content:** `<bill number> <amount due in rupees>`, e.g. `C03-S000412 1250`. Code 39, no check character. The amount is whole rupees, because cash is rounded to Rs 1 (D-083). A parser in `packages/domain` turns a scan back into the bill number and amount. | The cash desk records an offline handover from exactly these two facts (architecture §4.5). Short content keeps the barcode short enough to scan easily. |
| **A test page on staging-pos** (`/print-test`): three sample bills (3, 15 and 40 lines, the last one going to two pages), a print button, and a scan box that decodes what the cash-desk scanner types and says if it matches. | One URL to open on a counter PC at the shop; no data or login needed. |
| **Silent printing as in production:** Chrome started with `--kiosk-printing`, the printer as the Windows default, with a custom A5 landscape paper size. | Measures the real path. The dialog adds seconds and isn't what salesmen will see. |

## Scope

1. **`packages/print`:** `encodeCode39(text)` → bar widths, and `code39Svg(text, options)`.
2. **`packages/domain`:** `billCode({ billNumber, amountDue })` and `parseBillCode(scanned)` (golden-tested).
3. **`apps/pos`:** the `Bill` print component (A5 landscape, from a plain bill object, i18n keys) and the `/print-test` page with the samples, print button, timer and scan check.
4. **Docs:** a short counter-setup note (Chrome `--kiosk-printing`, default printer, A5 paper size) in `infra/`; the results in this plan.

**Out of scope:** real bills from checkout (W1-05), print profiles from the database (with W1-05), labels (CAT-08), the local print helper (only if the test fails).

## Tests written first

- [ ] **Code 39 (golden):** the start/stop character, each allowed character's bar pattern (digits, A–Z, `-`, `.`, space, `$`, `/`, `+`, `%`), the narrow gap between characters; lower case and other characters are refused.
- [ ] **Bill code (golden):** `C03-S000412` with Rs 1,250.00 due → `C03-S000412 1250`; a refund; zero due; paisa refused (cash is rounded); parsing gives back the same bill number and amount; a scan with a trailing Enter or spaces still parses; garbage is refused.
- [ ] **The bill component:** renders the bill number, the lines, the totals, cash received, change and the barcode; uses only i18n keys (no hard-coded text).

## At the shop (about one hour, with you)

On one counter PC with current Chrome (a Windows 10/11 counter; the Windows 7/8 ones are upgraded later, Q10):

1. Set the shared printer as the default and add the A5 landscape paper size (I'll send exact steps).
2. Start Chrome with `--kiosk-printing` and open `https://staging-pos.zorbixtechnologies.com/print-test`.
3. Print each sample 3 times. Time each one, from the click to paper out (the page's timer plus a phone stopwatch).
4. Scan each printed barcode with the cash-desk scanner into the scan box: it shows ✓ or what it read.
5. Check the layout: margins, line spacing, nothing cut off, the tear position on the paper.

**Pass:** every bill out within 15 s of the click, every barcode scans on the first or second try, nothing cut off.
**Fail:** I write the plan for the local print helper (plain-text ESC/P) instead.

## Proposed Wave 1 order

W1-01 is first because it can change how printing works. Then, in order of go-live criticality (PRD §8):

| | Task |
|---|---|
| W1-02 | POS shell: local database (SQLite in the browser), device unlock with PIN, offline status bar |
| W1-03 | Catalog pull and item search on the counter |
| W1-04 | Checkout rules in `packages/domain`: prices, tiers, floors, discounts, tender, rounding |
| W1-05 | Bill entry, payment pad, finalize and print (local-first, outbox) |
| W1-06 | Sync: push with idempotency and sequence gaps, server acceptance, pull |
| W1-07 | Cash desk: live queue and scan handover |
| W1-08 | Hold, void, return and exchange |
| W1-09 | Credit control (limits, offline cap) |
| W1-10 | Posting engine: stock, party and GL ledgers |
| W1-11 | Goods receipt, purchase return, supplier ledger |
| W1-12 | Labels (Code 39 + supplier abbreviation) |
| W1-13 | Cash session close, collections, cash movements |
| W1-14 | Opening balances and the 90-day bills (migration) |
| W1-15 | Trace a bill, send diagnostics |

Each gets its own plan for your acceptance, as now.

## Risks

| Risk | Mitigation |
|---|---|
| Browser printing is too slow on this printer | That's what this test finds out. Fallback ready: a local helper sending plain text. |
| The barcode doesn't scan | Make the bars wider and taller; the legacy bill proves Code 39 scans on this printer. |
| Paper type unknown (continuous or single sheets, A4 or A5) | We learn it at the shop (Q7); the page size and tear position are adjusted then. |
| The counter you use still runs Windows 7/8 | Use a Windows 10/11 PC, or your laptop on the shop network with the printer installed. |

## Questions for you

1. **Printer:** what model is the shared dot-matrix printer (the label on it, or its name in Windows)? And the paper: **continuous** (with holes on the sides) or **single sheets**, and A4 or already half-size?
2. **Cash-desk scanner:** is it a USB scanner that types into the PC (most are)? Its model, if easy to see.
3. **When can you do the hour at the shop**, and on which PC? I'll have the test page on staging by then.
4. **Bill code:** bill number plus amount due (`C03-S000412 1250`), as above. OK?
