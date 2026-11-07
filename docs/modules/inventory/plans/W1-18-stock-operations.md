# W1-18 Stock operations: transfers, adjustments, item stock card

| | |
|---|---|
| **Issue** | [#63](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/63) |
| **Module** | inventory (back-office screens and API), with accounting (`packages/posting`: two new posting sources) and sync (stock balances already reach the counters) |
| **Status** | Accepted (2026-11-07) with the owner's answers 1–4 (below) |
| **Refs** | INV-04, INV-05, INV-07, INV-03 (negative stock allowed); PRD W13; posting rules §5.3, §5.4; data model §2 (locations), §7; CLAUDE.md rules 1, 3, 4, 5; D-015, D-017, D-095, D-105; D-107 (new, below) |
| **Depends on** | W1-08 (stock ledger, balances, average cost, posting engine), W1-16 (document numbering, the draft → post pattern, the item picker) |
| **Size** | about 3½ days: migration, posting and golden files ¾; API with integration tests 1; the screens 1¼ (transfers with receiving, adjustments with approval, stock card, transfer needed, on the way); e2e and docs ½ |
| **Test-first** | Yes: the checks of a transfer, a receipt of a transfer and an adjustment, and when an adjustment needs approval (golden, `packages/domain`); their postings (golden, `packages/posting`), including the rebuild; the API under RLS and permissions (integration) |

## Goal

**The shop moves and corrects stock in the new system, and can see every movement of an item.**

- **Transfers:** the storekeeper types a transfer between Godown, Shop and Damaged; the owner or the manager posts it.
  - Between locations in one building the stock moves at once.
  - Where a route needs receiving, it is on the way until the other side receives it.
- **Adjustments:** the manager corrects stock that was found, lost or broken, with a reason.
  - A large loss waits for the owner's approval.
  - Each adjustment is valued and posted to the books.
- **Stock card:** anyone who may see costs opens an item's stock card and sees every movement, with its document, quantity, cost and running balance per location.

## Owner answers (2026-11-07)

1. **Adjustment reasons:** the list is right — *found*, *lost / missing*, *broken / damaged*, *theft*, *count correction*, *write-off (damaged goods)*, *other* (with a note).
2. **Who does what:** transfers and adjustments are posted by the owner and the manager only. On our recommendation, accepted, the purchaser/storekeeper may *type* a transfer as a draft (so a move is recorded when it happens), but only the owner or the manager posts it. Cashiers and salesmen do neither.
3. **Large losses** need the owner's approval: an adjustment by someone other than the owner whose losses come to more than **Rs 10,000** waits for the owner before it posts. Losses only (a gain costs nothing); the limit is a setting; the owner's own adjustments post at once.
4. **On the way:** both. A transfer either moves at once or is sent and later received. Which one is a setting **per route** (from → to), not a choice on each transfer, so nobody picks the wrong one. Delux's Godown is in the same building as the shop, so all of Delux's routes start as **"moves at once"**; receiving is built and ready for a shop whose store is elsewhere.

## Design

| Choice | Why |
|---|---|
| **Transfer** (INV-04): from one location to another, lines of item + quantity. A draft, then posted once like a goods receipt (D-105); posting takes the next number `TR000001`. A posted transfer is never edited (rule 3); a mistake is a transfer back | One pattern for every back-office document |
| **Drafts by `inv.transfer`** (owner, manager, purchaser); **posting by `inv.transfer.post`** (new: owner, manager) | Owner answer 2 |
| **A route that moves at once** (`postStockTransfer`): out of the source and into the destination at the current average cost, **no GL entry** (posting rules §5.4: both are Inventory) | The average is per item, not per location (D-017) |
| **A route that needs receiving:** posting *sends* it: the stock moves out of the source into the branch's **In transit** location (new location kind `transit`, not sellable, one per branch, created by the migration). The transfer shows *on the way*. **Receiving** (`inv.transfer.post`) moves it from In transit into the destination, at the cost it was sent at. No GL entry either way | Owner answer 4: stock on the way is still Inventory, but it can't be sold at either end |
| **Short on arrival:** the receiver enters what arrived; the shortfall stays out of In transit as a loss adjustment (reason *lost / missing*, linked to the transfer), so it follows the approval rule below | One way to lose stock, one approval rule |
| **Routes:** a setting per from → to pair, `moves at once` (the default when none is set) or `needs receiving`, edited by the owner (`admin.settings`) in Inventory settings | Owner answer 4: a setting, not a per-transfer choice |
| **Any → Damaged is a transfer**; Damaged → anywhere else is allowed too (a part that was fine after all) | PRD W13: Damaged is a location, not a write-off |
| **Stock may go below 0** at the source: the transfer posts and raises `negative_stock`, never refused (INV-03); the screen warns before posting | The shelf is what's true; the count corrects the books later |
| **Adjustment** (INV-05): one location, lines of item + quantity change (+ found / − lost), a **reason** from the list (owner answer 1), a note (required for *other*). Draft → post by `inv.adjust` (owner, manager), number `AD000001` | Valued and posted, as the PRD asks |
| **Approval** (owner answer 3): when the poster is not the owner and the adjustment's losses at the average cost come to more than the limit (`settings.inventory.adjustmentApprovalLimit`, default Rs 10,000), posting puts it in **awaiting approval**: stock and books don't change yet. Someone with `inv.adjust.approve` (new: owner only) approves, and it posts, or rejects it with a reason, and it goes back to a draft. The rule is a pure function in `packages/domain`, golden-tested | Losses only; the owner's own post at once |
| **Posting an adjustment** (`postStockAdjustment`): a gain `Dr INVENTORY / Cr INVENTORY_ADJUSTMENT`, a loss the reverse, qty × the average cost when posted (posting rules §5.3); an item with no cost known posts quantity only and is flagged `no_cost` | As the posting rules say; 5200 Inventory adjustments already exists in the chart |
| **Writing off damaged goods** = an adjustment out of Damaged with reason *write-off* | Posting rules §5.3 |
| **Item stock card** (INV-07): per item, every stock movement in posting order with date, document (number and link), location, quantity in and out, unit cost, value and the running balance per location and in total; filters by location and dates. Cost and value only with `cost.view` | Everything is already in `stock_movements`; the card only reads |
| **Transfer needed** (PRD W13): items whose Shop stock is below 0 while Godown has some; "Transfer" opens a draft transfer Godown → Shop with the quantities filled in | The alert the PRD names; one click to fix it |
| **On the way**: a list of sent transfers not yet received, with since when; empty at Delux while every route moves at once | Owner answer 4 |
| **Rebuild and pilot wipe:** the new sources (transfer sent, transfer received, adjustment) replay in a rebuild; the new tables are wiped with the pilot data | As every other posting source |
| **Until go-live** transfers and adjustments are made in the legacy app, like purchases (D-105); the screens say so | The final import's opening replaces the pilot's stock |

New decision **D-107** records answers 2–4: the purchaser drafts, the owner or the manager posts; owner approval for losses above a limit; receiving per route through an In transit location.

## Scope

- **In:**
  - **Migration 0018:**
    - the tables `stock_transfers`, `stock_transfer_lines`, `stock_adjustments`, `stock_adjustment_lines`, `transfer_routes`;
    - location kind `transit` and one In transit location per branch;
    - the `TR` and `AD` counters;
    - the posting source types;
    - the posted-document guard;
    - the permissions `inv.transfer.post` and `inv.adjust.approve`.
  - Domain checks and the approval rule.
  - The posting functions with golden files and the rebuild.
  - The API.
  - **Screens:**
    - Transfers (with send and receive);
    - Adjustments (with awaiting approval);
    - Item stock card (also from the item screen);
    - Transfer needed;
    - On the way;
    - Inventory settings (routes, approval limit).
  - e2e and docs (data model, permissions, posting rules §5.3–5.4, D-107).
- **Out:**
  - cycle counts (INV-06, Wave 2);
  - transfers between branches (one branch);
  - transfers from the counter (POS);
  - reprinting a transfer slip;
  - notifications of approvals waiting (the back-office list shows them).

## Tests written first

- **Domain (golden):**
  - **A transfer's checks:** from ≠ to; neither is In transit; at least one line; an item on each line; quantity above 0 and whole for an item without fractions; an item at most once. Its warning: the source goes below 0.
  - **A receipt's checks:** received between 0 and sent; whole for an item without fractions.
  - **An adjustment's checks:** a reason; a note for *other*; quantity ≠ 0 and whole for an item without fractions. Its warning: stock goes below 0.
  - **`needsApproval`:**
    - the owner never needs it;
    - gains never need it;
    - losses at or below the limit don't, above it do;
    - an item with no cost counts as 0.
- **Posting (golden):**
  - a transfer Godown → Shop at once at the average, with no journal;
  - a transfer sent to In transit, then received, including short;
  - a transfer that takes the source below 0 (`negative_stock`);
  - an adjustment gain and loss with their journals;
  - a loss on an item with no cost (`no_cost`, quantity only);
  - a write-off out of Damaged;
  - the rebuild reproduces all of them.
- **Integration:**
  - draft → post with numbers `TR000001` / `AD000001`; a posted one refused for editing;
  - balances and the GL after posting; a route that needs receiving, sent then received;
  - the purchaser drafts but can't post; a salesman is refused;
  - a manager's Rs 12,000 loss waits, stock unchanged; the owner approves it, it posts, and the GL shows it; a rejected one goes back to a draft; the owner's own loss posts at once;
  - the stock card's running balance;
  - RLS: another shop's documents are 404.
- **e2e:**
  - the purchaser drafts a Godown → Shop transfer of 5, the owner posts it, and the stock card shows it;
  - the manager's −1 broken posts at once, and a large loss waits for the owner, who approves it.

## Verify

- `pnpm check`, `pnpm test:integration`, `pnpm e2e`.
- The rebuild check (`posting-check`) on a database with transfers (at once and received) and adjustments finds no difference.
- On staging:
  - a transfer drafted by the purchaser and posted by the manager;
  - an adjustment under the limit and one over it, approved by the owner;
  - the item's stock card;
  - a route switched to "needs receiving", a send and a receive, then switched back.

## Order

1. Migration and schema.
2. Domain golden files.
3. Posting golden files.
4. Posting engine and rebuild.
5. API with integration tests.
6. Screens.
7. e2e.
8. Docs and D-107.

## Risks

| Risk | Mitigation |
|---|---|
| An adjustment posted twice, or edited after posting | `postDocument`'s lock and the posted-document trigger (as D-101, D-105) |
| A large loss typed by mistake (−100 for −10) | The screen shows the value before posting; above the limit the owner sees it first; a mistake after posting is a reversing adjustment |
| Stock sent and never received, so it is missing from both ends | The On the way list shows it with its age; at Delux no route needs receiving |
| Drafts piling up that nobody posts, so the shop's stock drifts below 0 | The transfers list shows drafts first, and Transfer needed shows the result |
| The stock card is slow for an item with many movements | Server-side pages of 100 movements, newest first, the running balance computed in SQL |
