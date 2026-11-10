# W1-19 Back-office accounting: bank receipts, expenses, transfers, journal vouchers, periods and the lock date

| | |
|---|---|
| **Issue** | [#64](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/64) |
| **Module** | accounting (back-office screens and API; `packages/posting`: new posting sources), with cash desk (expense categories already reach the desks) and inventory (the lock date also closes stock documents) |
| **Status** | Done (2026-11-10): built in PR #128 and changed after the owner's review in PRs #132, #133 and #134, all merged to staging; the owner verified it on staging (below) |
| **Refs** | ACC-04, ACC-05, ACC-06, ACC-01 (tenant-specific accounts), ACC-07 (in part, owner answer 3); PRD §4 (Accountant role), Q15 (drawings by journal voucher); posting rules §1.5, §1.6, §6, §9.3; data model §6, §9; architecture §7 (an audited unlock); CLAUDE.md rules 1, 3, 4, 5; D-035, D-057, D-095, D-101, D-105; D-108 (new, below) |
| **Depends on** | W1-08 (posting engine, journals, party ledgers, the rebuild), W1-11 (the safe, expense categories at the desk), W1-16 (supplier payments by bank, document numbering) |
| **Size** | about 4¼ days: migration, domain and posting golden files ¾; API with integration tests 1; screens 1¼ (receipts, expenses, transfers, journal vouchers with reversal, periods); account balances and the account ledger ½ (owner answer 3); new accounts and expense heads ¼ (owner answer 4); e2e and docs ½ |
| **Test-first** | Yes: the checks of each document and of a journal voucher, the periods and the lock-date moves (golden, `packages/domain`); every new posting and the reversal (golden, `packages/posting`), including the rebuild; the API under RLS, permissions and the lock date (integration) |

## Goal

**The accountant keeps the books in the new system: money in and out of the banks, the safe's movements, expenses, corrections by journal voucher, and months that are closed and stay closed.**

- **Bank receipts:** a customer pays by bank transfer into HBL; the accountant records it, and the customer's balance drops at once, on the counters too.
- **Expenses:** an electricity bill paid from a bank or from the safe goes to its expense head.
- **Transfers:** money moves between banks, wallets, card settlement and the safe. Example: the safe's cash deposited at Soneri, or JazzCash moved to HBL.
- **Journal vouchers:** the accountant writes a balanced voucher. Uses: clearing posting suspense, partners' drawings, reclassifying opening balance equity, or a write-off.
- **Reversal:** a posted voucher, receipt, expense, transfer or supplier payment that was wrong is reversed, never edited.
- **Periods and the lock date:** fiscal years and months come from the shop's start month (Delux: January). The accountant locks a month once it is checked, and nothing posts into it afterwards. Only the owner can reopen it, with a reason.

## Owner answers (2026-11-08)

The owner accepted every recommendation:

1. **Who keeps the books:** an Accountant login (receipts, payments, expenses, journal vouchers, period close, financial reports, no selling), plus the owner, who can do everything. The manager gets no accounting. Until Delux has an accountant, the owner does it.
2. **Journal vouchers need no approval.** Every voucher is numbered, listed and audited, a mistake is reversed, and vouchers can't touch the accounts the system keeps.
3. **Account balances and the account ledger now** (part of ACC-07): the chart of accounts with each account's balance at a date, and an account's ledger with every line, its document, memo, party, debit, credit and running balance. Owner and accountant only. The full financial reports stay in Wave 2.
4. **New accounts and expense heads in the back office:**
   - The accountant adds a postable account under a heading, renames it, or deactivates it when its balance is 0 and nothing uses it.
   - The accountant adds or renames expense categories, each going to an expense account; a new one reaches the cash desks by itself.
   - New banks and wallets stay a setup job (they change the counters' payment methods).
5. **Locking months:**
   - The accountant or the owner locks a month once it is checked; the lock date moves forward only, to the end of a month that is over.
   - Before locking, the screen lists what still looks open in that month, without blocking.
   - Only the owner reopens, by moving the lock date back with a reason, written to the audit log.
6. **Card settlement fees:** a transfer takes an optional charges amount with an expense category. The bank gets the net, the fee goes to the expense, the source goes down by the full amount. This replaces the journal voucher of D-057 point 3; bank transfer fees work the same way.

## Design

| Choice | Why |
|---|---|
| **Customer receipt by bank** (ACC-04): customer, bank account, amount, date, reference. **Posted when saved** (after a confirm step), number `CR000001`. `Dr <bank> / Cr AR_CONTROL (customer)`, and a customer ledger entry of −amount. Permission `acc.receipt.create` (owner, accountant) | Posting rules §6. The same pattern as the supplier payment by bank (W1-16): one form, no draft |
| **Expense** (ACC-04): expense category, **paid from** a bank account or the safe, amount, date, reference, note. Posted when saved, `EX000001`. `Dr <the category's account> / Cr <bank or CASH_SAFE>`. Permission `acc.expense.create` (owner, accountant). An expense from the drawer stays the desk's cash-out (W1-11) | Posting rules §6. The drawer is counted at the desk, so only the desk takes money out of it |
| **Transfer** (ACC-04): from and to are each a bank account or the safe (not the same one), amount, and optional charges with an expense category (owner answer 6). Posted when saved, `FT000001`. `Dr <to> (amount − charges) · Dr <category's account> (charges) / Cr <from> (amount)`. Permission `acc.payment.create` (owner, accountant) | Posting rules §6, *bank-to-bank / bank-to-safe* |
| **A possible duplicate:** a warning (not a block) when the same customer and amount, the same category and amount, or the same route and amount was already recorded on that date | The same bank line typed twice is the commonest mistake |
| **Journal voucher** (ACC-05): a date, a narration and lines of account, debit or credit, an optional line memo, and the party on AR/AP lines. **A draft, then posted** once, `JV000001`. Posting writes the lines as entered. An AR line writes a customer ledger entry and an AP line a supplier one, due on the entry date. Permission `acc.journal.post` (owner, accountant), with no approval step (owner answer 2) | Posting rules §6. A long voucher can be saved and finished later |
| **A voucher's checks** (pure, golden): at least two lines; each line has a debit or a credit above 0, never both; debits = credits; every account postable and active; the party required on `AR_CONTROL` (a customer) and on `AP_CONTROL` (a supplier) and refused elsewhere; a narration | The books stay balanced, and the sub-ledgers stay equal to their control accounts |
| **Accounts the system keeps** can't be on a voucher: `INVENTORY` (equal to the stock ledger), `CASH_DRAWER` (equal to the desk's count) and `CASH_IN_TRANSIT` (equal to the bills not handed over). Stock is corrected by an adjustment and the drawer at the desk | A voucher on them would make the books and the shelves or the drawer disagree, and the reconciliations would never close |
| **Reversal:** **Reverse** on any posted back-office money document or voucher writes a posted journal voucher marked as its reversal. It swaps every line of the original's journal, and its party entries are reversed on their own due dates, as a void does. The date is chosen and defaults to today, not before the original. A document is reversed at most once, and both show the link ("Reversed by JV000012"). Permission `acc.journal.post`. Sales are corrected only by void and return; stock documents only by stock documents | Rule 3: corrections are reversals. One mechanism for every kind; a supplier payment by bank (W1-16) gets it too |
| **Dates:** a back-office document is dated by its user (default today), never in the future, and **refused when on or before the lock date**. POS documents keep posting on the first open date with `posted_after_lock` (posting rules §1.6) | The back office can pick another date; a counter bill must never be refused (rule 7) |
| **Periods** (ACC-06, D-035): fiscal years and their months are **computed** from `tenants.fiscal_year_start_month`, not stored. A month is *locked* when it ends on or before `tenants.lock_date`. The lock date is the only record. The first lock sets `fiscal_year_locked` (the start month can't change any more) | One source of truth that the posting engine already reads; nothing to keep in step |
| **Locking** (`acc.period.close`, owner and accountant): move the lock date forward to the end of a month that is over, with the checklist of what still looks open (owner answer 5). **Reopening** (`acc.period.reopen`, new, owner only): move it back, with a reason, written to the audit log (`period.lock`, `period.reopen`). This is also the audited unlock a rebuild of a locked period needs (architecture §7) | Owner answer 5 |
| **The lock closes stock and purchasing documents too:** goods receipts, returns, transfers and adjustments dated on or before it are refused like the rest | One lock date for every back-office document |
| **Account balances and ledger** (owner answer 3): read only, from `journal_lines`; parents sum their children. Permission `reports.financial` (owner, accountant) | Everything is already in the journals |
| **New accounts and expense heads** (owner answer 4): permission `acc.chart.edit` (new: owner, accountant). The code is suggested as the next free one under its heading, and `validateChartOfAccounts` checks the result. Roles, banks and payment methods stay setup jobs | Owner answer 4 |
| **Who sees it:** the accounting screens need an `acc.*` permission or `reports.financial`, so the per-person salary accounts stay with the owner and the accountant (migration §5) | No manager or cashier sees salaries |
| **Until go-live**, the books stay in the legacy app. The screens say so, and anything entered here during the pilot is removed by the pilot wipe (D-101) | As purchasing (D-105) and stock (D-107) |

New decision **D-108** records the answers: who keeps the books, no approval for vouchers, the accounts a voucher can't touch, reversal as the only correction, a computed calendar under one lock date that only the owner moves back, and fees on transfers.

## Scope

- **In:**
  - **Migration 0019:**
    - the tables `customer_receipts`, `expenses`, `fund_transfers`, `journal_vouchers` and `journal_voucher_lines`, with the reversal link (`reverses_type`, `reverses_id`, unique);
    - the `CR`, `EX`, `FT` and `JV` counters;
    - the posting source types;
    - the posted-document guard;
    - the permissions `acc.period.reopen` and `acc.chart.edit`.
  - Domain:
    - the checks of each document and of a voucher;
    - the duplicate warning;
    - the periods (`fiscalYears`, `periodOf`);
    - the lock-date moves.
  - Posting:
    - `postCustomerReceipt`, `postExpense`, `postFundTransfer`, `postJournalVoucher`, `postReversal`, with golden files;
    - the rebuild and the pilot wipe.
  - The API.
  - **Screens:**
    - Bank receipts;
    - Expenses;
    - Transfers;
    - Journal vouchers (draft, post, reverse);
    - Periods (lock, the checklist, reopen);
    - Accounts (balances, the ledger, new accounts) and Expense categories (owner answers 3 and 4).
  - The supplier payment by bank (W1-16) gets **Reverse**.
  - Refusing back-office documents dated on or before the lock date (purchasing and stock included).
  - e2e and docs: data model §9, posting rules §6, the accounting spec, permissions, D-108.
- **Out:**
  - the financial reports beyond the account ledger (trial balance, P&L, balance sheet, cash book: ACC-07, Wave 2);
  - bank reconciliation against statements;
  - cheques and post-dated cheques;
  - recurring vouchers;
  - attachments (a photo of the bill);
  - a year-end closing entry (profit into retained earnings; the first year end is December 2027, and the reports can show it without one);
  - new banks and wallets in the back office;
  - receipts and payments in other currencies.

## Tests written first

- **Domain (golden):**
  - **A receipt, an expense, a transfer:** amount above 0; a customer, category or bank as the kind needs; from ≠ to; charges below the amount, with a category; the date neither in the future nor on or before the lock date. Their warning: a possible duplicate.
  - **A journal voucher:** the checks in the design, each with its problem and row (unbalanced, a line with both sides or none, a heading account, an inactive account, a kept account, a party missing or not allowed, a customer on AP).
  - **Periods:** the months of a fiscal year for start months 1 and 7 (July–June), a date's period, a locked month.
  - **Moving the lock date:** forward only to a month's end that is over; back only with `acc.period.reopen` and a reason.
- **Posting (golden):**
  - a receipt from a customer into HBL with its customer entry;
  - an expense from a bank and from the safe;
  - a transfer from the safe to Soneri, and from card clearing to HBL with Rs 250 charges;
  - a voucher clearing suspense, and one with an AR and an AP line and their party entries;
  - a reversal of each kind, netting to nothing, with the party entries on their own due dates;
  - a role or category account missing (`role_unmapped`, `target_unmapped`);
  - the rebuild reproduces all of them.
- **Integration:**
  - each kind posted with its number; a posted one refused for editing; a draft voucher edited, then posted;
  - the GL and the customer's balance after a receipt; the balance on the counter's change feed;
  - a voucher on Inventory refused; an unbalanced one refused by the API and by the database;
  - a reversal posted once, the second refused;
  - a document dated on the lock date refused (a receipt, a voucher, a goods receipt, an adjustment), while a counter bill dated then still posts on the next open date;
  - the lock moved forward by the accountant; moved back by the accountant refused; moved back by the owner with a reason, and the audit row;
  - permissions: a manager and a cashier refused; the accountant can't reopen;
  - the account ledger's running balance; a new account and category, and the category on the desk's change feed;
  - RLS: another shop's documents are 404.
- **e2e:**
  - the accountant records a Rs 25,000 bank receipt from a customer, and the customer's balance drops;
  - an expense from HBL; a voucher clearing suspense;
  - an expense reversed;
  - October locked, and a receipt dated in October refused.

## Verify

- `pnpm check`, `pnpm test:integration`, `pnpm e2e`.
- The rebuild check (`posting-check`) on a database with every new kind and a reversal finds no difference.
- On staging:
  - a bank receipt from a customer, then their balance on a counter;
  - an expense from a bank and from the safe;
  - a transfer from card clearing with charges;
  - a voucher, then its reversal;
  - a month locked as the accountant, a back-dated entry refused, the month reopened as the owner.

## Changes during the build

| Change | Why |
|---|---|
| A reversal is a posted journal voucher with no lines of its own: its posting swaps the original's stored journal (in a rebuild, the original's replayed posting) | One mechanism for every kind; the rebuild check stays exact |
| A voucher's memo in the journal is `<number> <narration>`; a reversal's `<number> <original number>` | The account ledger shows what each line was |
| Back-office stock and purchasing documents dated on or before the lock date are refused when they post (`date_locked`), whoever posts them, including the owner approving an adjustment | One rule at the one place every back-office posting passes (`lockedOn`, `apps/api/src/lock.ts`) |
| The lock checklist also counts sent transfers not yet received and adjustments waiting for approval | They are stock not yet where the books say |
| `expense_categories` gained a `(tenant_id, id)` key | The new tables name their category by tenant, as every tenant foreign key does |
| Customers and suppliers are found by `/api/accounting/parties` (code, name or phone) | The back office had no customer search |
| The account ledger shows up to 1,000 lines per date range and says when there are more | A shop's month fits; a longer range is narrowed |
| A new voucher's Post saves it and posts it in one go (the first e2e run found it only saved the draft) | One click, as on the other documents |
| The e2e flow runs as the owner | The e2e shop has no Accountant login; the accountant's permissions are covered by the integration tests |

## Checks (2026-11-08)

- `pnpm check` (format, lint, typecheck, tests with coverage, build): pass, 2,065 tests.
- `pnpm test:integration`: 387 passed (37 files), including the accounting API (17) and the rebuild check with reversals.
- `pnpm e2e` (Edge): 51 passed; the new ledger flow covers a bank receipt, an expense, a voucher for drawings, a reversal, and last month locked with a receipt dated in it refused.

## Owner's test on staging (2026-11-10)

**Working as expected.** All five tests passed (bank receipt, expenses, transfer with charges, voucher and reversal, the month lock). What the owner found on the way, and what changed:

| Found | Fix |
|---|---|
| (PR #132) A goods receipt received in a locked month: Post saved it as a draft with no message; posting the draft said "Something went wrong". The server refused it correctly (`date_locked`), but the purchasing and stock screens had no words for it, and a new draft opening at its own address dropped the message | The purchasing and stock screens say "The books are locked up to …"; a refusal after the draft is saved is kept for the draft when it opens again (`carry` in `router.ts`). An existing draft now reloads after a refused Post, so the next Post is not refused as changed by someone else. The ledger e2e flow posts a goods receipt dated in the locked month, twice |
| (PR #133) Then: Post on a new receipt in a locked month still saved a draft before it was refused, which looked like it had worked | The purchasing and stock lookups carry the lock date, and the screens check it as you type (`isDateLocked`, `packages/domain`): a date on or before it says "The books are locked up to …" under the date and greys out Post (also Send for approval, Approve, Receive and Pay). Save draft still keeps what was typed: a draft isn't in the books, and drafts already saved in a month that gets locked are listed by the lock checklist. The server still refuses as before |
| (PR #134) Debit and credit were hard to read: was a line the right way round? | A hint under each voucher line's account, and on every posted journal: "↑ Bank charges goes up Rs 2,000", "↓ The customer owes you less: …", "↑ You owe the supplier more: …" (`lineEffect`, `packages/domain`, golden-tested for every account type; the arrow says it as well as the colour) |
| (PR #134) A journal voucher could be saved with nothing in it, and showed in the list as a draft; a new one offered Delete draft | Saving a draft with no line holding an item, an account or an amount is refused, on every back-office document (receipts, returns, transfers, adjustments, vouchers), by the screen and the API (`empty_draft`, `isEmptyDraft`). On an edit, posted or changed-by-someone-else is said first. Delete draft shows only on a saved draft |

## Order

1. Migration and schema.
2. Domain golden files.
3. Posting golden files.
4. Posting engine, rebuild and wipe.
5. API with integration tests.
6. Screens.
7. e2e.
8. Docs and D-108.

## Risks

| Risk | Mitigation |
|---|---|
| A bank receipt typed twice, or once here and once as a desk collection | The duplicate warning; the customer's ledger shows both, and a reversal removes one |
| A voucher that breaks a reconciliation (stock, the drawer) | Vouchers can't touch the accounts the system keeps |
| A closed month changed later | The lock date refuses back-office documents in it; only the owner reopens, audited |
| A lock moved too far by mistake | Forward only to a month that is over; the owner can move it back |
| The sub-ledgers drifting from AR and AP | A party on every AR/AP line, required by the check and written by the same posting |
| Salaries seen by staff | The accounting screens need an accounting permission |
