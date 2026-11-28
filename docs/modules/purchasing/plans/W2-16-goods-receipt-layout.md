# W2-16 Goods receipt and purchase return: a layout for typing a bill, fixes from the owner's review (back office only)

| | |
|---|---|
| **Issue** | #225 |
| **Module** | purchasing (goods receipts, purchase returns), with small changes to the back-office kit (`apps/backoffice/src/ui`) and the item search; **not** `apps/pos` or `packages/ui` |
| **Status** | Accepted by the owner (2026-11-28), after the mockup |
| **Refs** | PUR-02, PUR-03 (W1-16); D-127 and its plan [W2-12](../../platform/plans/W2-12-back-office-restyle.md) (the kit, answers 3 and 6); D-053 (dialogs); D-108 (lock date); PRD §1 principle 2 (keyboard first); CLAUDE.md rule 10; mockup [Back-office restyle](https://claude.ai/artifact/4TCNKN5Cu5JpYfDp6B5p5k), page **Goods receipt** (private canvas, sample names and figures) |
| **Depends on** | W2-15 (every screen on the kit) |
| **Size** | about 3 days |
| **Test-first** | Points 1, 2, 3, 7 and 8 are bugs: failing tests committed and locked first. The layout and the field problems: their tests before the code |

## The problem

The owner's review of New goods receipt (2026-11-28), with screenshots:

1. **The item field can't be typed in from the keyboard.** Closed, it is a button showing the picked item (`purchasing/ItemPicker.tsx:58`); the search box appears only on a click or Enter. Tab onto it and type: nothing happens.
2. **Tab after picking an item goes to "Collapse the menu".** The search box closes while it has the focus (`ItemPicker.tsx:92`), the focus falls to the page, and Tab starts again from the top.
3. **The item list is cut off at the bottom of the window.** It always opens under the field, up to 256px tall (`ui/SearchBox.tsx:81`), even when the field is near the window's bottom.
4. **Quantity, cost and discount drop out of line** once a line has a message. The row asks for every cell at the top (`ReceiptScreen.tsx:494`), but the shared cell's `align-middle` (`packages/ui/src/components/ui/table.tsx:61`) wins, so the other cells centre in the taller row. Purchase return the same.
5. **The fields jump while typing.** The table sizes its columns from their contents; when Net cost and Value change from "—" to an amount, the columns widen and the others move. Purchase return the same.
6. **Uneven gaps between Item, Quantity, Unit cost and Discount:** boxes of fixed widths (96, 112, 96px) in columns that size themselves.
7. **A purchase return draft can't be deleted.** The API can (`DELETE /api/purchasing/returns/:id`, drafts only); the screen has no button. A goods receipt draft can, but **without asking first** (`ReceiptScreen.tsx:368`), next to Post.
8. **Print labels shows the receipt's id, not its number.** *Make labels* links by id (`ReceiptScreen.tsx:401`); the labels page puts what it gets into the *Goods receipt number* field.
9. **A quantity column on the receipts list?** Not added: items are counted in different units (pieces, litres, metres, fractions), so a total means nothing; the amount already gives the size. (The owner agreed.)
10. **Every problem of a line piles up under its Item** ("Pick the item.", "Type a quantity above 0.", "The cost is not a valid amount."), and they show as soon as anything is typed on the line. Header problems are one grey sentence above the buttons.
11. **Totals and buttons are out of sight.** Save draft and Post are at the very bottom, under the totals; on a long bill you scroll down to check the difference and back up to type.

## What the mockup shows (owner, 2026-11-28)

The owner accepted all seven layout changes and asked for the mockup first; then, on the mockup: the cash hint goes into the *Paid* dropdown, a line's bin is red, and dark-mode fields keep their faint fill.

1. **A bar at the bottom of the window**, always in view: *Delete draft* at the start; "N to fix before posting" after Post is pressed with problems; **Total · As printed · Difference** (red until it is 0, then "Matches the bill" in green); *Save draft* and *Post* at the end.
2. **The page follows the paper bill.** Top: Supplier, Supplier's bill no., Bill date; then Received on, Into, Paid. Foot, beside the sums: Discount on the whole bill, **Bill total as printed**, Notes.
3. **A # column,** and **Enter in the last box of the last line adds a line** and puts the cursor in its Item.
4. **The last cost under Unit cost** ("Last 820.00"); amber with the change when it moved more than 10 % ("Last 1,240.00 · 17 % up"), in place of today's sentence.
5. **Delete draft asks first** and sits apart from Post.
6. **Problems at their own field,** header and lines alike.
7. **Purchase return the same:** the bar ("Supplier owes back …"), the # column, problems at their field, Delete draft. Each line from a receipt says how many can go back ("Up to 6").

Also in the mockup: set column widths and every cell at the top (points 4–6); a **Draft** tag beside the title of a saved draft; *Post* stays clickable (below).

## Design

### The item search (points 1–3)

- **`ItemPicker`, closed:** a printable key on the focused field opens the search **with that character already typed**; ↓ and Backspace open it empty; Enter and a click as today. Used by goods receipts, purchase returns, transfers and adjustments, so all four gain it.
- **After a pick, and after Esc, the focus goes back to the item field**, so Tab moves on to Quantity. A click elsewhere closes the list without moving the focus.
- **`SearchBox`:** when the space under the field is less than the list needs and there is more above, the list opens **above** the field; otherwise it opens below with its height cut to the space there (at least about 4 rows). Measured again on scroll and resize, as today. Both `floating` modes, so the searchable pickers (supplier, account…) behave the same.

### The lines table (points 4–6)

- `table-layout: fixed` with a `<colgroup>`: # 36px, Item takes the rest, Quantity 112, Unit cost 148, Discount 124, Net cost 112, Value 128, the bin 44 (purchase return: #, Item, Quantity 124, Unit cost back 148, Value 140). The boxes fill their column, so the gaps are equal and nothing moves while typing.
- **Every cell `align-top`** on the cell itself (the shared table stays as it is); the read-only amounts are padded to line up with the boxes.
- **The bin** is a kit `IconButton` with a new `tone="bad"`: red at rest, not only on hover. Other delete icons keep today's grey-then-red.
- **Narrow windows:** the table scrolls sideways inside its panel (a minimum width of about 980px), as the W2-12 rules say.

### Problems at their field (point 10, answer 6)

| Problem (domain code) | Shown under |
|---|---|
| `supplier_required` | Supplier |
| `bill_no_required`, `bill_date_required`, `location_required` | Supplier's bill no., Bill date, Into |
| `item_required` | the line's Item |
| `qty_positive`, `qty_fraction`, `more_than_received` (return) | the line's Quantity |
| `cost_invalid` | the line's Unit cost (Unit cost back) |
| `discount_invalid` | the line's Discount |
| `bill_discount_invalid` | Discount on the whole bill |
| `total_required`, `total_mismatch` | Bill total as printed |
| `reason_required`, `reason_unknown`, `note_required` (return) | Reason, Note |
| `lines_required` | under the lines table |
| the lock date or a future date (D-108, W2-05) | Received on / Returned on, as today |

- The box gets the red border (`aria-invalid`) and the message under it (`aria-describedby`), as the kit's fields do.
- **When they show:** a field's problem once you **leave that field**; every problem when you press **Save draft** or **Post**. A problem clears as soon as it is fixed. Nothing shows while you are still typing in a field you haven't left.
- **Save draft** still saves a bill with problems (a draft may be incomplete) and marks what is left.
- **Post stays clickable.** With problems, it sends nothing: it marks every one, moves the cursor to the first, and the bar says "3 to fix before posting". Today it greys out without saying why.
- A refusal from the server on Post that names a line or a field goes to that field; any other is a toast, as today.
- **The warnings** (cost more than 10 % off the last, Retail at or below the cost) go under Unit cost in amber, in the "Last" line (point 4 of the mockup); "Retail 1,400.00: at or below the cost" when that one applies. They never stop Post.
- **Transfers and adjustments** show the same pile-up under the item: each problem goes under its own field there too, and their cells go to the top. Their layout is otherwise unchanged.

### The page (mockup points 1–3, 5, 7)

- **`ActionBar`** in the kit (`apps/backoffice/src/ui/ActionBar.tsx`): sticky to the bottom of the content area, full width of it, a line and a shadow above; its parts wrap on a narrow window. A `role="region"` named "Save or post"; the sums in it are a `role="status"`, so a screen reader hears the difference change. Not shown on a posted receipt or return (read-only; its actions stay in the page header).
- **Goods receipt:** the head panel holds the head of the bill (above); a new panel at the foot, **"The bill's total"**, holds Discount on the whole bill, Bill total as printed (its hint "Posting waits until the lines add up to this" stays) and Notes, beside the sums as today. The cash hint line is removed from the page and becomes a **note at the bottom of the *Paid* dropdown**: "Paid in cash? Choose On the supplier's account, then pay it at the desk (Pay supplier)." The kit's `Select` gains a `note` (a line of muted text after the options, not an option).
- **Enter on the last line:** in the last box of the last line (Discount; on a return without a receipt, Unit cost back), Enter adds a line and focuses its Item. Enter elsewhere does nothing new.
- **The last cost:** from the picked item's `lastCost` (already in the item search's answer); the change in whole per cent.
- **Delete draft** (receipt and return): the kit's `ConfirmDialog`, danger: "Delete this draft? The draft from {supplier} and its {n} lines go for good. This can't be undone." On a return, the new button calls the existing `DELETE`; after it, back to the list with a toast, as receipts do.
- **"Up to N" on a return's lines:** the receipt's lines gain `returnable` (what is still left to send back, from the API's existing `returnable` query) in `ReceiptLineView`, so a new return from a receipt knows it before the first save, and the screen checks it as you type. A saved return already has it.
- **The Draft tag** beside the title of a saved draft (the list's existing chip).
- **Make labels** links by the receipt's **number**; the labels page already accepts a number. Links by id still work.

### The fields' fill in dark mode (owner, 2026-11-28)

In dark mode the back office's fields have a faint fill today only because the shared `Input` adds `dark:bg-input/30` and the kit's `bg-surface` doesn't override it. The owner keeps the fill: the kit's `FIELD_BOX` sets it itself (`dark:bg-input/30`), so it no longer depends on the shared field, and the item field's closed button and the dropdowns, which aren't an `Input`, get it too. Light mode unchanged.

### Words (rule 10)

New keys under `purchasing`: the foot panel's title, the # column's spoken name ("Line"), the Enter hint, "Last {{cost}}", "Last {{cost}} · {{pct}} % up/down", the retail warning's short form, "{{count}} to fix before posting" (plural), "Up to {{qty}}", the delete confirmation's title and text, the *Paid* dropdown's note. `purchasing.receipts.cashHint` goes. The kit's `ActionBar` and `Select` note add no words of their own.

## Tests

**Written first, failing, then locked** (`node .claude/hooks/bugfix-lock.mjs lock …`)

- `purchasing/ItemPicker.test.tsx`: Tab to the field and type "a": the search opens with "a" in it; after a pick, the focused element is the item field; after Esc, the same.
- `ui/ui.test.tsx` (`SearchBox`): with the field 100px from the window's bottom, the list sits above it; with 180px, below and no taller than the space.
- `purchasing/purchasing.test.tsx`: a saved return draft has *Delete draft*, which asks first and then deletes; a receipt's *Delete draft* asks first; a posted receipt's *Make labels* links to its number.

**Written before the code**

- `purchasing.test.tsx`:
  - a line with an empty quantity shows nothing while typing in it, and "Type a quantity above 0." under **Quantity** (not under Item) once you leave it;
  - Save draft saves and marks every problem;
  - Post with problems sends nothing, marks them all, focuses the first, and the bar says how many;
  - the bill total's mismatch shows under Bill total;
  - Enter in the last Discount adds a line with the cursor in its Item;
  - "Last 1,240.00 · 17 % up" under a cost 17 % above the last;
  - the *Paid* dropdown shows the cash note and the page doesn't;
  - a return from a receipt shows "Up to 6" and marks 8 as more than the receipt still has, before saving.
- `ui.test.tsx`: `ActionBar` is a named region; `IconButton tone="bad"`; `Select` with a `note`; `FIELD_BOX` carries the dark fill.
- `e2e/purchasing.spec.ts`: on a receipt line with a problem, the Quantity, Unit cost and Discount boxes share one top edge; typing a discount moves no column (the boxes' x positions are the same before and after); Tab after picking an item lands in Quantity.
- The API: `ReceiptLineView.returnable` in the receipt's integration test (a line partly returned shows what's left).

**Kept green:** the existing purchasing, transfer and adjustment tests and e2e flows; where a test found a line's problem under the Item cell, it reads it at its field.

## Verify

`pnpm check`; `pnpm e2e` (all flows, `pos-look` included); `git diff --name-only origin/staging...HEAD -- apps/pos packages/ui` shown **empty**; screenshots of a goods receipt and a purchase return at 1440, 1024 and 390px, light and dark, in the PR.

## Order

1. Failing tests for points 1, 2, 3, 7, 8 → lock → fix → unlock.
2. The kit: `ActionBar`, `IconButton tone="bad"`, `Select` note, the dark fill in `FIELD_BOX`, with their tests.
3. The API: `returnable` on receipt lines, with its test.
4. Goods receipt: the table, the field problems, the layout and the bar, against their tests; then purchase return; then the field problems on transfers and adjustments.
5. Docs: the purchasing README's status; "as built" notes here; a decision-log line under D-127 for the document screens' bar and the clickable Post.

One branch off `staging`, one PR.

## Risks

- **The bar and the toasts:** toasts sit top-end and the bar at the bottom; no overlap. The bar must not hide the last line: the page gets bottom padding the bar's height.
- **"Shown after you leave the field"** adds a small per-field state (touched fields, and "everything" after Save or Post). The checks themselves don't change, only when and where they show.
- **Enter adding a line** must not fire inside the open item list, where Enter picks the item.
- **`returnable` on receipt lines** is one more query when a receipt is opened; it reuses the existing one, for one receipt's lines.

## Out of scope

- A quantity column on the receipts list (point 9).
- The same layout for transfers, adjustments or vouchers (only their field problems change here); the `ActionBar` is in the kit so they can take it later.
- Any change to the POS or `packages/ui`.
