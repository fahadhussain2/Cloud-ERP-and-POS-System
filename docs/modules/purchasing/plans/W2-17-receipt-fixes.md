# W2-17 Goods receipt and purchase return: fixes from the owner's staging test of W2-16 (back office only)

| | |
|---|---|
| **Issue** | #228 |
| **Module** | purchasing (goods receipts, purchase returns), `packages/domain` (the receipt and return checks), the purchasing API, and the back office's kit and frame (`apps/backoffice/src/ui`, `App.tsx`); **not** `apps/pos` or `packages/ui` |
| **Status** | Accepted by the owner (2026-11-28) |
| **Refs** | PUR-02, PUR-03 (W1-16); D-105 (drafts posted once; cash paid at the desk); D-127 and its W2-16 line; plan [W2-16](W2-16-goods-receipt-layout.md); CLAUDE.md rules 1, 3 and 10 |
| **Depends on** | W2-16 (merged, #227) |
| **Size** | about 2 days |
| **Test-first** | Points 1, 2, 4 and 5 are bugs: failing tests committed and locked first. Points 3 and 6: their tests before the code |

## The problem

The owner tested W2-16 on staging (2026-11-28) and sent screenshots:

1. **Messages under a line run into each other.** "Type a quantity above 0." under Quantity runs on under Unit cost and overprints its message. The shared table cell never wraps (`whitespace-nowrap`, `packages/ui/src/components/ui/table.tsx:61`), so a message wider than its column spills over the next one.
2. **A very large unit cost blanks the page.** The console shows `Uncaught DomainError: 200000000000000000 is outside the safe range`. Quantity × cost is worked out exactly, and a result too big to hold is refused by *throwing* (`mulQty` → `toSafeNumber`, `packages/domain/src/money.ts:29`). The screen's check doesn't catch it, so React drops the whole page. Also:
   - the back office has nothing to show in place of a screen that failed;
   - the API has no upper limit either, so a draft saved with such a cost would fail to open again (its view runs the same check).
3. **Save draft flashes red, then says "Saved" in green.** Save draft marks every problem (as W2-16 planned), then the form reloads with the saved draft, which forgets the marks. The owner sees a red message for a moment and a green toast: two opposite answers.
4. **Two quick clicks on Save draft: "Fahad Hussain changed this in the meantime".** Nothing stops a second click while the first save is still going. The first save moves the draft to a new version; the second still carries the old one, and the server takes it for someone else's change (it names the last person who saved, here the same user). On a new receipt, two quick clicks can create **two drafts**. Transfers and adjustments have no guard either.
5. **A discount that can't be read counts as 0.** "s" in a line's Discount shows no problem. A bill discount too large to hold (the owner typed 100000000000000) silently becomes Rs 0, and the bill then "matches", so typing a bigger and bigger discount suddenly turns the difference green. The screen turns an unreadable discount into 0 before checking it (`?? 0`, `ReceiptScreen.tsx:305`, `:319` and `:336`). Save draft does the same for every box, so "dsasd" in Quantity is **saved as 0**, losing what was typed without a word.
6. **"Paid" doesn't say what it means.** It records how the bill was settled when the goods came in: not yet (owed to the supplier) or already, from a bank. Cash is never an option: it is paid at the desk afterwards (D-105).

Also asked, and answered without a change here:

- **Editing a posted receipt** is deliberately not allowed: a posted document never changes (rule 3; D-105's trade-off "a posted mistake is corrected by a return or a journal voucher, never an edit"). A *Reverse receipt* action, which undoes a whole receipt so it can be typed again, can be its own plan later.
- **Saving a draft whose bill discount is more than its lines** is allowed, as any incomplete draft; Post refuses it. With point 5 fixed, the discount says so under its box.

## Owner's answers (2026-11-28)

1. **No amount over Rs 1 crore** (Rs 1,00,00,000).
2. **Save draft marks nothing red;** it keeps the draft and says what is left before posting.
3. **The *Paid* field becomes *Payment*,** with the wording below.

## Design

### Messages that wrap in their column (point 1)

- The back office's `LineBox` (`purchasing/lineFields.tsx`) lets its message and notes wrap (`whitespace-normal`, long words broken) inside their own column. The shared table cell stays as it is.
- **Shorter words under a line's boxes**, since the column heading already names the field. The header fields keep their full sentences.

| Problem | Under a line's box today | New |
|---|---|---|
| `qty_positive` | Type a quantity above 0. | Above 0 |
| `qty_fraction` | This item has no fractions. | Whole units only |
| `cost_invalid` | The cost is not a valid amount. | Not an amount |
| `discount_invalid` | The discount is more than the line. | More than the line |
| `more_than_received` (return) | More than the receipt still has. | More than the receipt has |
| `item_required` | Pick the item. | Pick the item |

Toasts and the header keep the full sentences.

### Rs 1 crore at most, and a check that never crashes (point 2; owner answer 1)

- **One limit in `packages/domain`:** `AMOUNT_LIMIT` = 1,00,00,000 in the shop's currency. `amountLimit(minorUnits)` turns it into minor units (Rs: 1,000,000,000 paisa).
- **What it covers on a goods receipt and a purchase return:**
  - every amount typed: unit cost, line discount, bill discount, bill total as printed, unit cost back;
  - every amount worked out: a line's amount (quantity × cost) and the document's total.
- **New problems, each under its own field:**

| Problem | When | Shown under | Words |
|---|---|---|---|
| `cost_too_large` | a unit cost over the limit | Unit cost | Over Rs 1 crore |
| `line_too_large` | quantity × cost over the limit | Unit cost | The line is over Rs 1 crore |
| `qty_too_large` | a quantity the database can't hold (over 99,999,999,999) | Quantity | Too large |
| `total_too_large` | the bill total as printed, or the lines' total, over the limit | Bill total as printed | Over Rs 1 crore |

- **The check works in exact big integers** and turns anything too big into one of these problems. It never stops with an error, in the back office or in the API.
- **The API refuses a draft over the limit** (400 `too_large`), so no draft is saved that can't be opened again.
- **The back office gets an error screen:** if a screen still fails for any reason, the page shows "Something went wrong on this page" with a *Reload* button instead of going blank. The menu stays.
- Other money forms (expenses, vouchers, payments, prices) are not changed here: they already refuse an amount they can't read. The error screen covers them too.

### Save draft without red marks (point 3; owner answer 2)

- **Save draft marks nothing.** It saves the draft and the toast says what is left: "Draft saved. 2 to fix before posting." (or "Draft saved." when nothing is left). The bar keeps the count.
- Red still shows when a field is **left** with a problem, and on **Post**: it sends nothing, marks every problem and puts the cursor on the first (W2-16).
- **The one exception:** a box that can't be **stored** stops Save draft. That means "dsasd" in Quantity, or an amount over the limit. Save draft then sends nothing, marks only those boxes, and the toast says "Fix the marked boxes to save the draft." Today they are saved as 0.
- The same on a purchase return.
- This replaces "every problem when you press Save draft" in W2-16 and its line under D-127; the decision log says so.

### One save at a time (point 4)

- The kit's `Button` gains `busy`: disabled, with a small spinner in place of its icon, and its words unchanged.
- **Save draft, Post and Delete draft** are busy from the click until the answer arrives. After a successful save they stay busy until the form reloads with the new version, so no click can carry the old one.
- **The same on transfers and adjustments** (Save draft, Post, Delete).
- If the server still answers "changed in the meantime" (a real change by someone else), the message stays as today.

### A discount that can't be read is never 0 (point 5)

- An unreadable line discount is `discount_invalid` under that Discount box ("Not an amount" when it can't be read, "More than the line" when it is too big).
- An unreadable or too-large bill discount is `bill_discount_invalid` under Discount on the whole bill, and the sums show "—".
- An empty box still counts as 0, as today.

### Payment (point 6; owner answer 3)

- **The field is named *Payment*.** Its options:
  - "Not paid yet (on the supplier's account)";
  - "Paid from bank: {bank}", one for each bank account.
- **The note in its dropdown:** "Paid in cash? Choose Not paid yet, then pay it at the desk (Pay supplier)."
- A posted receipt shows the same words. The **Purchase register** report's *Paid* column ("By bank" / "On account") becomes *Payment* with "Paid by bank" / "Not paid yet", so the two screens say the same thing.
- Only the words change. Nothing changes in what is saved or posted.

### Words (rule 10)

- **New keys:** the short line problems; the four "too large" problems; "Draft saved. {{count}} to fix before posting." (plural); "Fix the marked boxes to save the draft."; the error screen's title, text and *Reload*; *Payment* and its options and note.
- **Changed:** the Purchase register's *Paid* column and its two values.
- **Removed:** `purchasing.receipts.onAccount`, `purchasing.receipts.cashNote` (replaced).

## Tests

**Written first, failing, then locked** (`node .claude/hooks/bugfix-lock.mjs lock …`)

- `packages/domain` (`purchasing.test.ts`): a unit cost of Rs 2,00,00,00,00,000 gives `cost_too_large` and doesn't throw; quantity × cost over the limit gives `line_too_large`; a bill total over the limit gives `total_too_large`; the same for a return.
- `purchasing.test.tsx`:
  - a cost of 2000000000000 shows "Over Rs 1 crore" under Unit cost and the page stays;
  - "s" in a line's Discount shows its problem once the box is left;
  - a bill discount of 100000000000000 shows its problem and the difference is not "Matches the bill";
  - Save draft with "dsasd" in Quantity sends nothing and marks Quantity;
  - two quick clicks on Save draft send one request (receipt and return).
- `inventory.test.tsx`: two quick clicks on a transfer's and an adjustment's Save draft send one request.
- API (`purchasing.int.test.ts`): a receipt draft with a unit cost over the limit is refused with 400 `too_large`, and nothing is saved.

**Written before the code**

- `purchasing.test.tsx`:
  - Save draft with a missing bill total saves, marks nothing, and the toast says "1 to fix before posting";
  - Post still marks it;
  - the *Payment* field and its options and note.
- `ui.test.tsx`: `Button busy` is disabled and shows the spinner.
- `App.test.tsx`: a screen that throws shows the error screen with *Reload*, and the menu stays.
- `e2e/purchasing.spec.ts`: with problems under Quantity and Unit cost on one line, the two messages don't overlap (each one's box stays inside its own column).

**Kept green:** the W2-16 tests; where one expected Save draft to mark problems, it now expects no marks and the toast's count.

## Verify

- `pnpm check`;
- the purchasing integration tests;
- `pnpm e2e` (all flows; `pos-look` in CI);
- `git diff --name-only origin/staging...HEAD -- apps/pos packages/ui` shown **empty**.

## Order

1. Failing tests for points 1, 2, 4, 5 → lock.
2. The domain: the limit, the new problems, no throwing; then the API's refusal.
3. The screens: wrapping and short words, unreadable boxes, the busy buttons (receipts, returns, transfers, adjustments), the error screen; then unlock.
4. Save draft without red marks, and *Payment*, against their tests.
5. Docs:
   - a new decision for the Rs 1 crore limit (D-128);
   - Save draft without marks, as a W2-17 line under D-127;
   - the purchasing README's status;
   - "as built" notes here.

One branch off `staging`, one PR.

## Risks

- **A draft already saved with a huge amount** would now be refused when saved again. That is right: it can't be posted either, and its box says why. Staging may have one from the owner's test; production has none.
- **The limit is per document type, not per shop.** One constant for now. Making it a shop setting is a later change, if ever needed.
- **Keeping the buttons busy until the reload** relies on the form being replaced after a save (it is, by its version). If the reload fails, the buttons come back, so the page never gets stuck.

## Out of scope

- Editing or reversing a posted receipt (a *Reverse receipt* plan later, if the owner wants it).
- The Rs 1 crore limit on other money forms.
- Any change to the POS or `packages/ui`.

## As built (2026-11-28)

- **Bugs first:** failing tests committed and locked: the golden cases for the limit (receipt and return), the screen's huge cost, the unreadable discount, the bill discount too big to read, "dsasd" in Quantity, two quick clicks on Save draft (receipt, new receipt, return, transfer, adjustment), and the API's refusal. The new-receipt double-click test first had a line without an item, which is an empty draft, so it sent nothing and failed for the wrong reason; it was corrected in its own commit (it then failed on the old screen with two new drafts) before the fix.
- **The limit's words** show the shop's own formatting of the amount ("Over Rs 10,000,000"), not the word "crore", so they follow the tenant's locale (rule 10).
- **`useOneAtATime`** takes a name per action, so only the pressed button shows the spinner and the others are disabled. Save draft, Post and Delete keep the buttons busy after success until the form is replaced; Receive (transfers) and Approve / Send back (adjustments) give them back at once, since their reload changes the screen anyway. Post with problems marks them without making anything busy.
- **A return's lines** show `lines_required` and the return's `total_too_large` under the table; before, a return had no place for them.
- **A return's line value** is worked out only within the limit, so a huge cost back can't stop the screen either.
- **The error screen** is tested on the kit (`ui.test.tsx`), not through `App.test.tsx`; the App wraps every screen in it, and a new address clears a failure.
- **Payment:** the keys `purchasing.receipts.onAccount` and `cashNote` are kept with the new words, not replaced. A bank option reads "Paid from {bank's name}" (the names already start with "Bank:", so "Paid from Bank: HBL").

