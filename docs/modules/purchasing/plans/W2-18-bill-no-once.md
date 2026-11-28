# W2-18 A supplier's bill is posted once: no two posted goods receipts with the same bill number

| | |
|---|---|
| **Issue** | #231 |
| **Module** | purchasing (goods receipts): `packages/domain` (the receipt check), the purchasing API, the back office's receipt screen; **not** `apps/pos` or `packages/ui` |
| **Status** | Accepted by the owner (2026-11-28) |
| **Refs** | PUR-02 (W1-16); D-105 (drafts posted once; a posted mistake is corrected by a return or a voucher); D-127 and its W2-16 and W2-17 lines (problems at their field, Post marks them); CLAUDE.md rules 3 and 10 |
| **Depends on** | W2-17 (merged, #230) |
| **Size** | about 1 day |
| **Test-first** | A bug: failing tests committed and locked first |

## The problem

The owner noticed on staging (2026-11-28) that a goods receipt can be posted with the same supplier's bill number as one already posted. Nothing stops it today: no rule in the PRD or the decision log, no database constraint (`supplier_bill_no` is plain text, `0017_purchasing.sql:23`), no check in the API or the screen.

Each receipt posts correctly on its own, so nothing breaks in the database. The danger is **the same bill typed twice by mistake**. If both copies are posted:

- **the stock doubles:** the shop shows twice what arrived;
- **the supplier is owed twice:** their balance and the payables are inflated, and they could be paid twice;
- **the average cost is skewed** by the extra goods coming in.

Undoing it takes a purchase return or a journal voucher, because a posted receipt never changes (rule 3).

A repeated number from **different suppliers** is normal: two suppliers can both print "INV-001".

## Design

### The rule

- **The same supplier's bill can be posted once.** Two bill numbers are the same when they match after ignoring case and spaces: "inv-12", "INV-12" and "INV 12" are one bill. Dashes, slashes and other characters still count ("INV-12" and "INV12" are two bills).
- **Only posted receipts count.** A draft with the same number as a posted receipt can be saved (a draft may be incomplete, W2-17 answer 2), but it can't be posted.
- **Another draft with the same number** only warns: one of the two may be the draft that gets deleted.
- **A different supplier with the same number** is allowed.
- Purchase returns have no bill number and aren't affected.

### `packages/domain`

- **`billNoKey(text)`:** the number as compared, lower-cased with every space removed. One function, used by the screen and the API.
- **`checkReceipt`** gains an input `billNoPostedAs: string | null`: the number of the posted receipt that already has this supplier's bill (null = none). When it is set, the check adds the header problem **`bill_no_taken`**. Like every problem, it stops Post and not Save draft.

### The API

- **A lookup for the screen:** `GET /api/purchasing/receipts/bill-no?supplier=…&billNo=…&except=…` answers `{ posted: { id, number } | null, drafts: number }`. "posted" is the posted receipt with the same supplier and bill (by `billNoKey`). "drafts" counts the other drafts with it. `except` leaves out the receipt being edited. Permission: `pur.receive`, like the receipt itself.
- **The receipt's view** (`GET /api/purchasing/receipts/:id`) fills `billNoPostedAs` from the same query, so an opened draft shows the problem at once.
- **Post** takes a transaction lock for the tenant and supplier (`pg_advisory_xact_lock`, as purchase returns already do), then checks again. It refuses with **409 `bill_no_taken`** and the other receipt's number. So two people posting the same bill at the same moment can't both get through.
- **No database constraint.** A unique index on posted receipts would fail to build if staging already holds two posted receipts with the same bill (the owner found the gap by doing just that), and posted receipts can't be changed to make room (rule 3). The lock and the check at Post do the same job from now on.

### The screen (goods receipt)

- **When it asks:** when *Supplier's bill no.* is left, and when the supplier changes with a bill number already typed. Never while typing.
- **A posted receipt with this bill:** the problem under *Supplier's bill no.*, in red: "Already on GR000014", with the number as a link that opens that receipt. It counts in the bar's "N to fix before posting". Post marks it and puts the cursor there (W2-16).
- **Another draft with this bill:** an amber note under the same field: "Another draft from this supplier has this bill number." It doesn't stop Post.
- **If Post is refused by the server** (someone else posted it a moment earlier), the refusal is a toast naming the receipt, as other refusals are (W2-16 as built).

### Words (rule 10)

New keys:

- `purchasing.problems.bill_no_taken`: "Already on {{number}}."
- `purchasing.warnings.bill_no_on_draft`: "Another draft from this supplier has this bill number."
- `purchasing.errors.bill_no_taken`: "This bill is already on {{number}}."

## Tests

**Written first, failing, then locked** (`node .claude/hooks/bugfix-lock.mjs lock …`)

- **`packages/domain`:**
  - golden cases for `billNoKey`: case, spaces inside and around, dashes kept;
  - `checkReceipt` with `billNoPostedAs` set gives `bill_no_taken`.
- **API (`purchasing.int.test.ts`):**
  - a second receipt from the same supplier with the same bill ("inv 4471" against "INV-4471") is saved as a draft, but its Post is refused with 409 `bill_no_taken` and the first one's number;
  - the same number from another supplier posts;
  - two drafts with the same bill both save;
  - two Posts of the same bill sent at the same moment: one posts, one is refused.

**Written before the code**

- `purchasing.test.tsx`:
  - leaving *Supplier's bill no.* with a posted bill shows "Already on GR000014" under it, as a link to that receipt;
  - Post then sends nothing and puts the cursor on the bill number;
  - another draft with the bill shows the amber note, and Post isn't stopped by it;
  - a draft opened with a posted bill shows the problem at once.
- `e2e/purchasing.spec.ts`: a second receipt typed with the posted receipt's bill number (in another case) is marked at *Supplier's bill no.* and can't be posted.

**Kept green:** all purchasing tests and flows, which use different bill numbers.

## Verify

- `pnpm check`;
- the integration tests;
- `pnpm e2e` (all flows; `pos-look` in CI);
- `git diff --name-only origin/staging...HEAD -- apps/pos packages/ui` shown **empty**.

## Order

1. Failing tests → lock.
2. The domain: `billNoKey`, `bill_no_taken`.
3. The API: the lookup, the view, the lock and the check at Post.
4. The screen, against its tests; then unlock.
5. Docs:
   - a line under D-105 (a supplier's bill is posted once);
   - the purchasing README's status;
   - "as built" notes here.

One branch off `staging`, one PR.

## Risks

- **Receipts already posted twice on staging** stay as they are (rule 3). If any are real, they are corrected with a purchase return; the rule applies from now on.
- **A supplier who really reuses a bill number** (a new year starting again at 1) would be refused. That is rare. If it happens, the bill number can carry the year ("2027/1"), or the rule can later look at the bill date as well.
- **One more query** when the bill number is left and when a draft opens, on an indexed supplier column. Small.

## Out of scope

- Editing or reversing a posted receipt (D-105).
- Correcting receipts already posted twice.
- Duplicate checks on other documents (expenses, supplier payments).
- Any change to the POS or `packages/ui`.
