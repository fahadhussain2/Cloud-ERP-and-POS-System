# W2-10 Bill details in the back office

| | |
|---|---|
| **Issue** | to open after the plan is accepted |
| **Module** | reports (a back-office screen and its API, read only), with platform (Trace a bill links to it) |
| **Status** | Built (2026-11-26) on branch `plan/w2-10-bill-details`, waiting for review; accepted by the owner the same day, questions 1–3 as recommended |
| **Refs** | RPT-01 (the sales register), RPT-07 (sales and gross profit), PLT-12 (Trace a bill); data model §5 (sales documents, lines, payments, overrides); CLAUDE.md rules 1, 3, 5, 10; D-093 (reprint at the counter), D-124 (cost corrections); D-125 (new, below) |
| **Depends on** | W1-07 (bills on the server), W1-12 (voids, reissues), W1-13 (returns, exchanges), W1-20 (the sales register, Trace a bill), W2-03 (sales and gross profit's line figures) |
| **Size** | about 1½ days: the API with integration tests ½; the screen and its links ¾; print, e2e and docs ¼ |
| **Test-first** | Yes: the API under RLS and permissions, and its figures against the sales report (integration); the screen (component); one flow from the sales register to a bill (e2e) |
| **Mockup** | [Bill details mockup](https://claude.ai/artifact/HnGuZgwAH3wQJimTotWEAb) (private design canvas; Tweaks: *showCost*, *voided*) |

## Why

The back office can't show one bill with its items. The sales register lists one line per bill, and Trace a bill shows its story without its lines. The only place to see a cash bill's items today is the counter, by reprinting it or starting a return. The owner, a manager or the accountant checking a price, a discount or a customer's complaint has to ask someone at the counter.

All of a bill's data is already on the server: the document, its lines, payments and approvals, its void, reissue and returns, its handover and its posting. This task shows it, read only.

A bill view on the POS is **not** part of this task (owner, 2026-11-26): the counter already covers what salesmen need (Return / exchange shows a bill's lines, Reprint gives the paper). Watch during the pilot whether salesmen reprint just to look; if they do, the smallest fix is an on-screen preview in the Reprint dialog.

## What it shows

As in the mockup, top to bottom:

| Part | Contents | Where it comes from |
|---|---|---|
| **Header** | Bill number; status (*Finalized* or *Voided*) and kind (*Sale*, *Return*, *Exchange*); date and time on the counter, counter, price tier. Buttons: *Trace this bill* (only with `support.trace`), *Print* | `sales_documents`, `devices`, `price_tiers` |
| **Voided** (only when voided) | A banner: the void's number, when, the reason, who approved it, and the reissue if there is one | `sales_documents` void fields, `reissue_of_number` of the reissue |
| **Who and where** | Salesman; customer (opens the customer) or walk-in with the phone; cash handover (desk, cashier, time) or *paid without cash*; business date | `users`, `parties`, `cash_handovers` |
| **Items** | One row per line in bill order: item code (opens the item) and name, location; quantity (fractional units with their decimals); list price, price, line discount, line total. A chip for an approval on the line (*below list*, *below floor*, with who approved). **Returned lines** show a negative quantity and the refund, with the reason, the condition and the bill they return (a link). With `cost.view` only: each line's cost and profit, and a *no cost yet* chip on a line that left at no cost (D-124) | `sales_lines`, `items`, `locations`, `overrides`, the line's stock movements |
| **Totals** | Lines, bill discount (with its reason and approver), rounding, tax when not 0, total; then each payment: method, amount, cash received and change, reference | `sales_documents`, `sales_payments`, `payment_methods`, `overrides` |
| **Cost and profit** (`cost.view` only) | The bill's cost and gross profit with its margin; a note when a line had no cost yet, pointing to Sales and gross profit's cost corrections | The line figures, as Sales and gross profit counts them |
| **Related** | Returns made against this bill (number, date, what came back, refund); the bill this one returns or reissues; the approvals; its journal entry (opens it) | `sales_documents.return_of_id`, `sales_lines.original_line_id`, `postings`, `journal_entries` |

A short line at the foot: a finalized bill is never changed; corrections are a void and reissue, or a return, on the counter (rule 3).

## Design

| Choice | Why |
|---|---|
| **One read:** `GET /api/sales/bills/:number` returns a `BillView` (contract in `packages/contracts`) with everything above, in the shop's money format. Amounts in minor units (rule 1), quantities in thousandths. Under `withTenant` (rule 5) | One request per screen, like the reports |
| **Found by number**, as Trace a bill does: the bill with that number, the first received if a number repeats (a repeated number is already flagged at push) | Bill numbers are what people say and type; it matches Trace |
| **Cost and profit are the Sales and gross profit report's**: a line's cost is minus its stock movements' value, leaving out cost corrections (W2-03, D-124), and its sales figure is the one that report uses, so the bill's profit equals that report's row for the bill, to the paisa | One figure for one bill, wherever it is shown |
| **No cost, profit or margin in the answer without `cost.view`**: the API leaves them out (null), not just the screen | As every report (W2-03) |
| **A new screen** at `#/sales/bills/<number>` under **Sales** in the menu (*Bill details*, with a box to type or scan a number, like Trace a bill) | Easy to reach without a report open first |
| **Bill numbers open it everywhere** in the back office: the sales register, overrides, voids and returns, exceptions, sales and gross profit by bill, journal lines and the stock card (a sale's movement), the partner ledger and statement, and Trace a bill. The bill page has *Trace this bill* for whoever may trace | Today a number opens Trace for the owner and nothing for anyone else (question 3) |
| **Print** prints the page as it is on screen on A4, through the report frame's print styles, with the shop's name and *Printed {date} by {user}* at the top. Not the counter's A5 bill | An office copy for a file or a customer query; the A5 bill with its barcode stays the counter's (D-093), so a printed copy can't be taken for a bill (question 2) |
| **Read only.** No void, return or reprint from here | Those happen on the counter, with its approvals (rule 3) |
| **All words are i18n keys**, CSS logical properties, the shop's money and date format (rule 10) | As every screen |

## Questions for the owner

1. **Who may open a bill.** *Answer (owner, 2026-11-26): as recommended.* *Recommended:* anyone with `reports.view` (the owner, managers, the accountant and the purchaser today); costs and profit only with `cost.view`. *Alternative:* the owner only, like Trace a bill.
2. **What Print gives.** *Answer (owner, 2026-11-26): as recommended.* *Recommended:* the page on A4, as on screen, headed *Printed {date} by {user}*. *Alternative:* the counter's A5 bill marked *OFFICE COPY*, without the barcode.
3. **Where a bill number leads.** *Answer (owner, 2026-11-26): as recommended.* *Recommended:* to the bill page everywhere, with *Trace this bill* on it for the owner. *Alternative:* keep numbers opening Trace for the owner and the bill page for everyone else.

## Tests (first, failing)

- **Integration (`apps/api/src/bill-details.int.test.ts`)**, on bills pushed through the real route:
  - a sale with a below-list line, a bill discount, a fractional quantity and two payments: every figure as on the document; the lines in order; the approvals with who approved;
  - with `cost.view`, the bill's cost and profit equal Sales and gross profit's row for that bill; a line sold before it was received shows *no cost yet* and no correction;
  - without `cost.view`: no cost, profit or margin in the answer; without `reports.view`: refused;
  - a voided bill: the void, its reason and approver, and the reissue; an exchange: its returned lines negative, with the reason, the condition and the original bill; the original bill lists the return under Related;
  - an unknown number: 404; another shop's bill: not found (RLS).
- **Component (`apps/backoffice`)**: the parts of the mockup, a voided bill's banner, the cost parts hidden without `cost.view`, *Trace this bill* only with `support.trace`, a bill number in the sales register opening the bill page, every string translated.
- **E2E**: from the sales register to a bill and back; Print opens the browser's print with the page.

## Risks

| Risk | Mitigation |
|---|---|
| The line figures drift from Sales and gross profit's | The same query fragment for a line's cost and sales; the integration test compares the two |
| A long exchange or a bill of many lines is slow | One query per part, all by the document's id; the test bill with 40 lines answers under 200 ms |
| Someone reads a printed office copy as a bill | It is an A4 page headed *Printed {date} by {user}*, with no barcode |

## Docs

- The reports README: the new screen;
- PLT-12's note in the PRD: bill numbers open the bill page, which links to Trace;
- the glossary: *Bill details*.

## Results

**Since W2-11 (D-126):** the *Bill details* menu entry and its lookup box are gone. Sales lists **Bills** and **Returns** ([plan](W2-11-bills-returns-lists.md)); each row opens this page, whose back link goes to the list by the document's kind.

Built as planned, with these details settled while building:

- **The API** is `GET /api/sales/bills/:number` (`apps/api/src/reports/bill.ts`), `reports.view`; `BillView` in `packages/contracts`. A line's cost is −its stock movements' value with `qty_delta <> 0`, its sales figure `line_total` (after its bill-discount share); *Amount* on screen is qty × price, before the bill discount.
- **The integration tests** are in `apps/api/src/reports-sales.int.test.ts`, not a new file: its seeded bills already have a bill discount, a below-list line, a void, a return, a no-receipt return and a part sold before it was received.
- **The menu:** Sales is now a group of two, *Customers* and *Bill details* (it was a direct link to Customers).
- **Links:** every bill number in the back office opens its details: the sales register, overrides, voids and returns, exceptions, sales and gross profit by bill, purchase and sale rates, journal lines (ledgers, the partner ledger), the stock ledger and the stock card; Trace a bill's number too. A void's number on a journal line still opens the trace.
- **The journal entry** shows as its number: the back office has no page for a single journal entry yet.
- **Print** uses the report frame's print header (shop, *Bill {number}*, *Printed by … on …*).

Checks (2026-11-26, local, Node 24):

- `pnpm check`: format, lint, typecheck, 2,729 tests in 141 files with coverage, builds: all passed.
- `pnpm test:integration` (PostgreSQL 17.9): 555 tests in 50 files passed, the six new bill-details cases among them.
- `pnpm e2e` (Edge): 81 passed. The first run had four flows still expecting a bill number to open Trace (updated) and two counter flows (sync, till) that failed once and passed on the rerun with no change.
