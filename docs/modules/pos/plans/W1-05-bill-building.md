# W1-05 Bill building: lines, prices, discounts, approvals, keyboard map

| | |
|---|---|
| **Issue** | [#50](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/50) |
| **Module** | pos (rules in `packages/domain`) |
| **Status** | Accepted (2026-10-27), with the owner answers below |
| **Refs** | POS-03, POS-04, PLT-07; PRD §4 (role limits), W1, W15; data model §5, §12; POS spec §5, §6, §8, §9; D-004, D-011, D-051, D-053, D-056, D-089, D-091; PRD Q2 (floor = cost + 5%) |
| **Depends on** | W1-03 (catalog, prices, search, `packages/ui`), W1-04 (manager PIN check on the counter) |
| **Size** | about 3 days |
| **Test-first** | Yes: the pricing and approval rules and the bill totals (golden, `packages/domain`), local schema 4, the open bill kept across lock and reload |

## Goal

**A salesman builds a bill at full speed from the keyboard, offline:** Enter or a scan adds the item at the bill's tier price, `2*` sets the quantity, and bargaining stays inside the rules. Down to the role limit and the floor needs nobody; below that, an approver types their own PIN and a reason **on the same screen** (PLT-07), and the approval is kept on the bill. Nothing is lost when the counter locks or the page reloads. Paying, numbering and printing come next (W1-06).

## Design

| Choice | Why |
|---|---|
| **The rules live in `packages/domain`** (`bill.ts`), pure and golden-tested: the line amounts, the bill discount split, which approval a price needs, who may give it, and whether an approval still holds. The counter computes with them now; the server re-checks synced bills with the same functions in W1-07 and records exceptions, never rejecting (D-011). | CLAUDE.md rule 2. The inputs are exactly what the document will carry (list price and floor at sale, the approver's roles), so the server can repeat the check. |
| **A line keeps the prices it was added with:** `list` (the bill tier's price; the default tier's if the item has none in this tier) and `floor`. A later pull doesn't change an open bill. | The customer was quoted that price; data model §5 snapshots `list_price` and `floor_price_at_sale`. |
| **Amounts:** line total = `mulQty(qty, unitPrice)`; the bill discount is split over the lines by `allocate` in proportion to their totals; total = lines − bill discount. Prices are typed in **whole rupees** (D-056). Cash rounding is W1-06. | The existing domain building blocks; the split always adds up exactly. |
| **What a price needs** (per line, after its share of the bill discount):<br>• at or above list: nothing (above list is allowed and shown with a chip, owner answer 4)<br>• below list, within the seller's `maxDiscountBp` and at or above the floor: nothing<br>• below list beyond the seller's limit, still at or above the floor: approval `below_list`, by someone with **`pos.override.approve`** whose own `maxDiscountBp` covers the discount<br>• below the floor: approval `below_floor`, by someone with **`pos.price.below_floor`**<br>• no list price at all (no price in any tier, or 0): the salesman types one, approval `below_floor`<br>Compared as totals (`net < mulQty(qty, floor)`), never as rounded unit prices. | POS-04, D-004, PRD §4. The override kinds are the data model's (§5). |
| **When the floor is unknown, it is the list price** (owner answer 1). Today every imported item has `floor_price` null: the floor comes from the category rule (cost + 5%, PRD Q2), and costs only arrive with the opening balances (W1-14). The server will send each item's **effective floor** in the items pull from then on; that work is added to W1-14. | Otherwise a salesman (limit 100%, floor unknown) could sell at Rs 1 without anyone approving. |
| **Approval on the same screen** (PLT-07): a dialog shows the item, list, floor, requested price and seller; the approver picks their name (or types their short code), enters **their own PIN**, picks a **reason** and adds a note (required for *Other*). Checked offline in the worker, like the manager unlock (W1-04): wrong PINs count towards the approver's own lock; a temporary PIN not yet replaced, a locked person or someone without the permission in this branch is refused. The dialog ends with *Cancel (Esc)* and *Approve (Enter)* (D-053). | The W1-04 code path, already tested; the approver's PIN never leaves the counter. |
| **The approval is kept on the bill:** kind, line (or the whole bill for a bill discount), requested by, approved by, reason, note, the values it approved (list, floor, price or discount) and the time. **It holds while the price stays at or above what was approved**; lowering it, changing the tier, or (for a bill discount) changing any line asks again. | One approval per decision, never a blank cheque. W1-06 writes these as `overrides` rows with the document. |
| **Seller who holds the permission themselves** (a manager selling): they confirm with their own PIN and a reason; the approval records them as both seller and approver (owner answer 2). | Every below-floor sale is still logged with a reason (D-004, RPT-10). |
| **Reasons are a fixed list in `packages/domain`** with i18n labels: *Customer bargain, Old or slow stock, Matching a market price, Regular customer, Other* (the prototype's), until a tenant-editable `reason_codes` table is needed (owner answer 3). | No migration, no new pull dataset for five labels; the codes are stable, so a later table can adopt them. |
| **Quantity:** `2*` or `1.5*` before the search text, `+` / `−` on a line, `Q` to type it. More than 0, at most 9,999; whole numbers unless the item's unit allows fractions (LITRE, METER, FOOT), up to 3 decimals. Adding the same item again (or scanning it twice) adds to its line, if that line is still at list price without an approval; otherwise it starts a new line. | The prototype's behaviour; quantities are integer thousandths (rule 1). |
| **Price tier:** the bill starts on the default tier (Retail). `F7` picks another tier; lines still at list move to the new tier's price, bargained lines keep their price and are checked again. The customer's tier sets it automatically from W1-09. Search results show the bill's tier price. | PRD W1 step 3. Customers on the counter are W1-09. |
| **The open bill is saved on the counter** (local schema 4, `open_bills`: one per person, JSON, `version`), after every change. When the counter locks (`Alt+L`, idle, closing time) or reloads, the bill waits for the same person's next unlock; another person starts with their own. `Alt+C` clears it after a confirm. It never leaves the counter (data model §5); W1-06 removes it in the finalize transaction, W1-12 adds more held bills. | POS spec §6 (*an open bill isn't lost*). A reload or a crash can't wipe a half-built bill. |
| **App updates wait for the bill** (POS spec §8): `billOpen` is true while someone is unlocked with lines on their bill. | Wires the W1-02 rule (`pwa/update.ts`) to real state. |
| **Keyboard map** (POS-03, from the prototype the owner reviewed; owner answer 4):<br>• **Search zone:** `F2` search · `↑ ↓` result · `Enter` add · `Esc` clear · `Tab` to the bill lines<br>• **Bill lines zone:** `↑ ↓` line · `+ −` quantity · `Q` set quantity · `P` price · `D` bill discount · `Del` remove · `Esc` back to search; any other letter types into search<br>• **Anywhere:** `F7` price tier · `Alt+C` clear bill · `Alt+L` lock<br>• Reserved for later tasks, shown only once built: `F3` return (W1-13), `F4` customer (W1-09), `F8` / `Shift+F8` hold and recall (W1-12), `F9` / `Shift+F9` pay (W1-06)<br>• `F1`, `F3`, `F5`, `F7` don't reach the browser (no help page, find bar, reload mid-bill or caret browsing). `F6` and `Alt+D` stay unused: Chrome sends them to the address bar.<br>Every key is in the key bar and clickable (D-053); the key bar changes with the zone. | The prototype's map, so the salesmen learn one layout. |
| **The bill panel** (prototype layout): a context strip (*Walk-in · Retail prices*), the lines (number, name, code, list, floor, chips: *Bargained −Rs 150*, *Above list*, *Approved by Tariq · Customer bargain*, *Needs approval*), and the totals pinned at the bottom (items, subtotal, discount, **Total** in large figures). The payment pad takes its place under the total in W1-06. | POS-17's fixed position, ready for W1-06. |

## Scope

1. **`packages/domain`:** `bill.ts` (line and bill amounts, bill discount split, `priceNeeds`, `canApprove`, approval validity, `addToBill` merge rule, quantity limits by unit), `OVERRIDE_REASONS`; golden files `bill-pricing.json`, `bill-totals.json`, `bill-approvals.json`.
2. **`apps/pos`:**
   - local schema 4 (`open_bills`) and the worker messages to load, save and clear the open bill
   - the bill state (`bill/`): reducer over the domain functions, saved after every change, restored at unlock
   - `CounterScreen`: zones, the bill panel, `Enter`/scan adds, the quantity prefix, `Q`, `P`, `Del`, `+ −`, `D` bill discount, `F7` tier picker, `Alt+C` clear, the zone-aware key bar
   - the approval dialog, reusing the W1-04 staff picker and PIN check
   - `main.tsx`: `billOpen` from the real bill state
3. **`packages/ui`:** only what the screens above need and don't have yet (toast, select for the reason), from the shadcn CLI.
4. **E2E** (`e2e/counter.spec.ts`): add by Enter and by scan, `2*`, `+ −` and `Q`, remove, bargain within the rules, below the floor with an approver's PIN (wrong PIN first), the bill discount, the tier change, lock and unlock keep the bill, reload keeps the bill.
5. **Docs:** POS spec §10 *The bill* and §11 *Keyboard map* (new; drafted after acceptance, before code), §5–§6 updated; data model §12 (schema 4); POS README; WAVE-1-TASKS: W1-14 also sends the effective floor; a decision entry (D-092) for the owner answers.

**Out of scope:** payment, numbering, the outbox write and printing (W1-06); the server's `overrides` table and re-check (W1-07); customers and their tier (W1-09); hold and recall (W1-12); returns (W1-13); stock on the lines (W1-08); computing the effective floor from cost (W1-14); editing floors and prices (W1-15).

## Tests written first

- [ ] **Pricing (golden):** at list; above list; below list within the role limit; exactly at the role limit; one paisa past it; exactly at the floor; below the floor; floor unknown (list is the floor); no list price; a fractional quantity (1.5 m); a bill discount that pushes one line below its floor while the others stay fine.
- [ ] **Approvers (golden):** Manager approves below floor; a Salesman can't; a Manager role for another branch doesn't count here; `below_list` needs an approver whose own limit covers the discount; the seller with the permission approves themselves (owner answer 2).
- [ ] **Totals (golden):** line totals with `mulQty` rounding; the bill discount split sums exactly; subtotal, line discounts (negative above list), bill discount, total; the same item added twice merges, a bargained one doesn't; whole-unit items refuse 1.5.
- [ ] **Approval validity (golden):** holds after a quantity change and after raising the price; is dropped after lowering the price, a tier change, or a line change under a bill discount.
- [ ] **Local schema 4:** a schema-3 database with catalog, PIN events and outbox rows upgrades in place with every row kept; save, load and clear an open bill per person; an open bill of an unknown `version` is set aside in `diagnostic_log`, not crashed on.
- [ ] **Approval dialog (jsdom, fake counter):** a wrong PIN counts towards the approver's lock; a temporary PIN, a locked approver or one without the permission is refused; *Other* needs a note; Enter and the *Approve* button do the same.
- [ ] **Counter screen (jsdom, fake counter):** Enter adds the selected result; `3*` adds three; a scan adds at once; the key bar follows the zone and each hint does what its key does; lock and unlock bring back the same person's bill, and another person's is empty.
- [ ] **E2E:** the flows in scope item 4.

## Changes made while building

| Change | Why |
|---|---|
| Six golden files instead of three: `bill-pricing` (`priceNeed`), `bill-approvers` (`canApprove`), `bill-totals` (`billAmounts`), `bill-approvals` (`pendingApprovals`), `bill-edits` (every edit, as a list of steps from an empty bill) and `bill-input` (typed prices and discounts) | One file per function keeps each case small and its expected value easy to check by hand. |
| Edits drop an approval that no longer holds (a lower price, a new tier, back at list; any line change for a bill-discount approval); `pendingApprovals` still checks every approval it finds | The chips on screen and the overrides W1-06 writes show only approvals that apply; the second check guards against a bill saved by an older version. |
| No list price: the line must be added with a typed price (`price_required`); it never merges | A line always has a unit price, so the totals never meet an empty one. |
| Search results show the price a line would get: the bill tier's, or the default tier's when the item has none there. One W1-03 test expectation changed with it | A result showing *No price* while Enter adds it at Retail would mislead. |
| No new `packages/ui` components: the reasons are native radio buttons, the tiers too; what a key can't do shows as a message in the bill panel instead of a toast | Arrow keys move through radio buttons with no extra code, and they test plainly in jsdom; the toast waits for W1-06. |
| The approver picker lists everyone who can unlock (the W1-04 `StaffPicker`, now its own file); someone without the permission is refused after their PIN | The same flow as the manager unlock, so staff learn one thing. |
| When the lines take the keyboard, the line just added is the selected one | As in the prototype: the usual next key is `+` or `P` on what was just added. |

## Verify

1. `pnpm check`, `pnpm test:integration` and `pnpm e2e`, output shown.
2. **On your PC, with the real catalog** (local API, built POS in Edge): a 15-line bill from the keyboard only; key press to line added under 100 ms; a below-floor approval with a manager's PIN; lock, unlock, reload, and the bill is still there; offline the same. Timings go into this plan.
3. **On staging:** the same bill on the seeded catalog, in Chrome.

## Risks

| Risk | Mitigation |
|---|---|
| Until the effective floor arrives (W1-14), every bargain needs a manager's PIN | Only before the pilot: W1-14 is a pilot task. The approval takes a few seconds and is the safe direction. If the owner prefers, the rule is one function with its golden cases, easy to relax later. |
| The floor on screen lets a salesman work out the cost (floor ÷ 1.05) | The prototype showed it and the owner reviewed that. Hiding it for roles without `cost.view` is a one-line change if wanted. |
| The open bill's JSON changes shape in a later version | It carries a `version`; an unknown one is set aside in the diagnostic log and the person starts a new bill, never a crash. Bills are minutes old, so nothing financial is lost (nothing is final before W1-06). |
| Keys collide with the browser (`F1`, `F3`, `F5`, `F7`) | Their defaults are prevented on the counter screen, and keys the browser keeps for itself (`F6`, `Alt+D`, `Ctrl+…`) aren't used; the E2E presses each key in Edge. |
| The approval rules are subtle (bill discount over several lines) | Golden cases for each boundary, the same functions on the server in W1-07, and the exceptions report (RPT-10) as the safety net. |

## Owner answers (2026-10-27)

1. **Item without a known floor** (all imported items until costs arrive with W1-14): the **list price is the floor**, so any price below list needs the PIN of someone with `pos.price.below_floor`.
2. **Someone holding the permission selling below the floor** (e.g. a manager): confirms with their own PIN and a reason, recorded as approved by themselves, so every below-floor sale has a reason.
3. **Approval reasons:** the prototype's fixed list (*Customer bargain, Old or slow stock, Matching a market price, Regular customer, Other* with a note) for now; a list the owner edits comes later, adopting the same codes.
4. **Keys and prices:** the prototype's map above, with `F7` for the price tier and `D` (on the bill lines) for a bill discount, typed as an amount or a percent like `5%`. A price **above list** is allowed without approval and shown with a chip.
