# W1-22 Customers in the back office: list, add, edit, credit terms, deactivate, ledger

| | |
|---|---|
| **Issue** | none yet: to be opened with the acceptance (the task list gets the row in this PR) |
| **Module** | pos (the customers the counter sells to), with platform (two new permissions) and accounting (the customer's ledger, read only) |
| **Status** | Proposed (2026-11-09): waiting for the owner's answers 1–9 (below) |
| **Refs** | POS-05, POS-07, CAT-04 (a customer's default tier), PUR-01 (a party can be customer and supplier), ACC-03 (customer sub-ledger), SYN-01 (customers), PLT-08 (audit); data model §3; sync spec §3; CLAUDE.md rules 1, 5, 8, 10; D-013, D-085, D-096 (owner answer 5 of W1-09: "until a back-office customer screen exists"), D-101 (the pilot wipe keeps parties), D-104 (legacy stays the master until go-live), D-105 (the suppliers screen); D-109 (new, written when this plan is accepted) |
| **Depends on** | W1-09 (the customer pull, the touch trigger, `normalizePhone`), W1-16 (the suppliers screen and API this mirrors), W1-19 (customer receipts by bank, which this screen's ledger shows) |
| **Size** | about 2¼ days: migration and permissions ¼; API with integration tests ¾; screens (list, add and edit dialogs, ledger) ¾; e2e and docs ½ |
| **Test-first** | Yes for RLS and sync: the customers API under RLS and permissions, and a customer added or changed in the back office reaching the next counter pull (integration), written before the routes |

## Why now

A new shop has **no way to get customers**. The counter only picks customers it pulled (W1-09), and nothing in the app creates one: only the legacy import (Delux) and the e2e seed insert them. W1-09 left editing to the legacy mapping file "until a back-office customer screen exists" (owner answer 5, D-096). The owner hit this testing W1-19 bank receipts on a fresh staging shop: there was no customer to receive money from.

## Goal

**The owner or a manager adds a customer in the back office, and seconds later every counter can find them with `F4`, at their tier's prices and, if the owner allows it, on account up to their limit.** The same screen lists and searches customers with their balances, edits their details and credit terms, stops credit or deactivates a customer, and shows each customer's ledger (every sale on account, return, collection, bank receipt and voucher, with the running balance).

## Open questions for the owner (with the recommended answer)

1. **Who adds and edits customers?**
   **Recommended:** owner, manager and accountant, with a new permission **`cust.edit`** (add, edit details, deactivate or reactivate, delete one added by mistake). Salesmen and cashiers can't; they see customers only on the counter.
2. **Who sets a customer's price tier and credit terms** (credit allowed, limit, offline daily cap, payment terms)?
   **Recommended:** the **owner only**, with a second new permission **`cust.terms.edit`**, as only the owner changes prices (D-104): a Mechanic or Wholesale tier is a discount, and a limit is money at risk. A customer a manager adds is on the default tier with no credit until the owner sets their terms. *Alternative:* owner and manager.
3. **A new customer's defaults?**
   **Recommended:** the shop's default tier (Retail); **credit off**. When credit is turned on, the limit must be typed **or "No limit" ticked on purpose** (D-085 keeps empty = no limit, but a new account shouldn't get it by forgetting a field). The offline daily cap is pre-filled with Rs 25,000 (PRD Q6), editable. Payment terms empty (due the same day, as now).
4. **Customer codes?**
   **Recommended:** the form suggests the next free code **`C0001`, `C0002`…** (editable, 1–20 characters, unique across all parties ignoring case) and the code **never changes** after it is saved, like an item's code. Legacy codes are numeric (`0042`), so a `C` code can never collide with a legacy import.
5. **Deactivate and delete?**
   **Recommended:** as for suppliers (D-105): **deactivate only at a zero balance** (`balance_open`, with the amount). An inactive customer disappears from the counters and the desk, so one who still owes couldn't pay at the desk. To stop a customer who owes from buying more on account, the owner **turns their credit off** instead. **Delete** only a customer never used anywhere (no sale, ledger entry, collection, receipt, voucher or opening line); it is marked deleted, never removed (rule 8). Reactivate any time.
6. **Delux before go-live** (legacy is the master until then, D-104)?
   **Recommended:** the importer re-run keeps overwriting **imported** customers (name, phones, tier and credit from the mapping file) until go-live, so the screen shows a notice on them: *"Imported from the legacy app: until go-live, change this customer there or in the mapping file; the next import overwrites changes made here."* **New customers** (`C` codes) are never touched by an import, and the pilot wipe keeps all parties (D-101). After go-live (`tenants.go_live_at`) the notice goes and the back office is the master.
7. **The customer's ledger now?**
   **Recommended:** yes, on the customer's page, read only, like the supplier ledger (ACC-03): date, document and number, due date, amount, running balance, and the balance owed. The ledger entries exist since W1-08; this is a view of them. Ageing by due date stays in W1-20 (RPT-06).
8. **An existing supplier who also buys from the shop?**
   **Recommended:** *Add customer* has **"From an existing supplier"**: pick the supplier, and the same party gets a customer account (PUR-01: one party, both roles, one code). W1-09's trigger already re-sends such a party to the counters.
9. **Adding a customer at the counter (`F4` → *New*)?**
   **Recommended:** **not in this task.** A customer made offline needs its own pushed document, a code that can't collide between counters and a duplicate check, so it is a bigger task. Until then the salesman takes a walk-in phone (W1-09) and the owner or manager adds the account in the back office, which reaches the counters in seconds.

## Design

| Choice | Why |
|---|---|
| **No new table and no change to the pull.** A customer is a row in `erp.parties` plus a live row in `erp.customer_accounts` (data model §3). The API writes both inside `withTenant`, in one transaction. | The tables exist (migration 0006) with forced RLS, sync and audit; the counter already pulls `customers`, `customer_accounts` and `customer_balances` (W1-09). |
| **Reaching the counters:** a new customer's party row and account row get new txids on insert, so the next `customers` and `customer_accounts` pulls return them; the nudge triggers on both tables (migration 0010) start that pull within seconds. An edit of name, phones or city changes the party row; a tier or credit change changes the account row; deactivation arrives as `status = 'inactive'` (the counter hides inactive customers); a delete arrives as an account tombstone (the counter hides parties without a live account). A supplier given a customer account is touched by `touch_customer_party` and re-sent. | Rule 8 (`xid8` cursor per table): nothing new is needed, and the integration tests prove each case before the routes are written. |
| **Two permissions** (owner answers 1, 2): **`cust.edit`** (Owner `*`, Manager and Accountant templates) and **`cust.terms.edit`** (Owner only). Migration **0020** gives `cust.edit` to the Manager and Accountant roles made from those templates in every tenant, as migration 0019 did for `acc.chart.edit`. Reading the list needs either. A save by someone without `cust.terms.edit` that changes the tier or credit terms is refused (`403 forbidden`), so the screen disables those fields with a hint. | The audit log (PLT-08) already records every before and after on both tables; a permission keeps the money-at-risk fields with the owner. |
| **Fields:** code (fixed after save), name, phones (up to 5), city, contact person, address, notes; and the terms: price tier, credit allowed, credit limit (rupees, or *No limit*), offline daily cap (rupees), payment terms (days, optional). Money is paisa in the API and the DB (rule 1), whole rupees on the form. Address, contact person and notes stay on the server (D-096: never pulled). | What the counter sells with (W1-09), plus what the office needs to reach the customer. Email and tax number are left out until someone needs them (the columns stay). |
| **Phones are stored normalized** with `normalizePhone` (`packages/domain`, W1-09): `0300-1234567` and `+92 300 1234567` are both `03001234567`; one that isn't 7 to 15 digits is refused (`phone_invalid`). While typing a phone, the dialog shows a customer who already has it (*Already used by C0042 Khan Motors*), without blocking. | One rule for typed and imported numbers, so the counter's search finds them; the hint catches most duplicates. |
| **New-customer defaults** (owner answer 3): default tier, credit off, cap Rs 25,000 from one constant **`DEFAULT_OFFLINE_DAILY_CAP`** in `packages/domain` (the importer's own constant moves there too). Credit on needs a limit or *No limit* ticked. | One source for PRD Q6's default; no "no limit" by accident. |
| **The code** (owner answer 4): `GET /customers/next-code` returns the next free `C` + 4 digits (past the highest existing `C` number; 5 digits after `C9999`). Uniqueness is checked ignoring case against every party, as for suppliers (`code_taken`). | Readable codes the salesman can type in `F4`; never a clash with the legacy numeric codes. |
| **Edits use row versions:** the form sends the party's and the account's `rowVersion`; a stale save is refused with who saved in between (`stale`, as the catalog and suppliers do). | Two people editing one customer don't overwrite each other silently. |
| **Deactivate, reactivate, delete** (owner answer 5): deactivate refused while the customer balance (`party_ledger_entries`, role customer) isn't 0. Delete only when the party appears nowhere; the "never used" check moves out of `purchasing/routes.ts` into a shared **`apps/api/src/parties.ts`** used by both screens, and gains `customer_receipts` and `journal_voucher_lines` (a draft voucher may already name the party). A party that is also a supplier keeps its party row: only its customer account is marked deleted (and the reverse for a supplier delete, which today refuses a party with a customer account). | Nothing may point at a deleted party; an open balance must stay collectable at the desk. |
| **From an existing supplier** (owner answer 8): `POST /customers` takes either the new party's details or `{ partyId }` of a live supplier without a customer account, with the terms. | PUR-01: one party, both roles. |
| **The ledger** (owner answer 7): `GET /customers/:id` returns the customer with every customer ledger entry in posting order (`entry_date, posting_seq, id`), its document kind and number (sale or return bill number, collection, `CR`, `JV`, void, opening) and the running balance, the same query shape as the supplier ledger. | ACC-03, read only; the owner sees a bank receipt land on the customer. |
| **Before go-live** (owner answer 6): a customer whose party has `legacy` set shows the notice while `tenants.go_live_at` is null; new customers don't. The importer is unchanged. | Matches D-104 for the catalog: one master at a time. |
| **Screens:** a new **Sales** menu group with **Customers** (later W1-20's sales reports can join it). The list: search box (code, name words, phone digits, city), filter Active / Inactive / All, columns code, name, city, phone, tier, credit (limit or *No limit* or *No credit*), balance, status, and an actions column (Edit, Deactivate or Reactivate, Delete when never used). *Add customer* and *Edit* open as `FormDialog`s, as on the suppliers screen; a row opens the customer's page with the details, terms and ledger. i18n keys under `customers.*`, logical CSS, the shop's money format (`moneyOf`). | The suppliers screen's pattern after the owner's review (D-105), so both feel the same. |
| **Personal data:** names and phones are shown in full in the back office (staff only; the counter keeps masking them, D-096); the API logs only ids, never a name or phone; tests and e2e use made-up people. Staging gets only test customers (D-076). | Customers' contacts are personal data. |

## Scope

1. **`packages/domain`:** `DEFAULT_OFFLINE_DAILY_CAP`; `cust.edit` and `cust.terms.edit` in `PERMISSIONS`, `cust.edit` in the Manager and Accountant templates; the permission tests.
2. **`packages/db`:** migration `0020_customer_permissions.sql` (the role grant only; no table change, so `schema.ts` stays as it is).
3. **`packages/contracts`:** `customers.ts`: `CreateCustomerRequest` (new party, or `partyId` of a supplier), `UpdateCustomerRequest` (row versions, details, terms, status), `CustomerRow`, `CustomerDetail` with the ledger, `CustomerLookups` (tiers, default cap, money, `can`, `live`).
4. **`apps/api`:** `src/customers/routes.ts`: `GET /customers/lookups`, `GET /customers/next-code`, `GET /customers` (search, status filter, 500 rows), `GET /customers/:id` (with the ledger), `POST /customers`, `PATCH /customers/:id`, `DELETE /customers/:id`; all inside `withTenant`; `src/parties.ts` (the shared "never used" check, used by suppliers too); registered in `app.ts`; `customers.int.test.ts`.
5. **`apps/backoffice`:** `src/customers/` (`CustomersScreen.tsx` with the list and dialogs, `CustomerScreen.tsx` with the details and ledger, `data.ts`, `customers.test.tsx`); the menu group and routes; `en.json` keys.
6. **`tools/legacy-import`:** use `DEFAULT_OFFLINE_DAILY_CAP` from `packages/domain` (no other change).
7. **E2E** (`e2e/customers.spec.ts`): the flows in "Tests written first".
8. **Docs:** POS README (status, the back-office screen), W1-09 plan's out-of-scope line pointing here, WAVE-1-TASKS row (in this PR), decision entry **D-109** with the owner's answers.

**Out of scope:** adding a customer at the counter (owner answer 9); CSV import and export of customers (CAT-09, Wave 2); ageing and the outstanding report (W1-20, RPT-06); printing a customer statement; merging duplicate customers; a separate history screen for limit changes (the audit log has every before and after).

## Tests written first

- [ ] **Customers API (integration, `apps/api/src/customers.int.test.ts`):**
  - the owner adds a customer → it is listed with balance 0, its phones normalized; a second one with the same code in another case → `code_taken`, also against a supplier's code; an invalid phone → `phone_invalid`;
  - `next-code` returns `C0001` on a fresh shop and the next one after `C0042`;
  - a manager adds a customer → default tier, credit off, cap Rs 25,000; a manager's save that changes the tier or the limit → `403`; a salesman → `403` on every route;
  - the owner turns credit on: without a limit and without *No limit* → refused; with a limit → saved; a stale row version → `stale` with who saved;
  - deactivate with a balance (an on-account sale posted) → `balance_open` with the amount; at 0 → inactive; reactivate;
  - delete a customer never used → marked deleted; one with a sale → `in_use`; a party that is also a supplier → only the customer account goes, the supplier stays;
  - from an existing supplier → the same party gets a customer account; one that already has one → refused;
  - the ledger: an on-account sale, a collection at the desk, a bank receipt (`CR`) and a journal voucher line, in order, with the running balance;
  - RLS: another shop's customer is `404` and never listed.
- [ ] **Reaching the counter (integration, the pull):** after a back-office add, the next `customers` and `customer_accounts` pulls return the new rows with only their listed columns; after a limit change, the next `customer_accounts` pull returns the new limit; after a deactivation, the party arrives with `status = 'inactive'`; after a delete, the account arrives as a tombstone; a supplier made customer is re-sent on the `customers` pull; the nudge fires for each.
- [ ] **Permissions (unit and migration):** the templates' new grants; migration 0020 gives `cust.edit` to Manager and Accountant roles made from the templates in every tenant, and not to a custom role.
- [ ] **Screens (jsdom):** search by name word, code and phone digits; the status filter; the terms fields disabled without `cust.terms.edit`; credit on needs a limit or *No limit*; the duplicate-phone hint; the legacy notice before go-live only on imported customers; the ledger's running balance.
- [ ] **E2E:** the owner adds *Test Motors* on the Mechanic tier with credit and a Rs 10,000 limit → a counter finds them with `F4` by phone after the pull, at Mechanic prices, and sells Rs 4,000 on account without a PIN → the customer's ledger shows the sale and the balance → a bank receipt (W1-19) of Rs 1,000 shows on the ledger → deactivate is refused (balance) → the owner turns credit off → the counter's *On account* is disabled for them.

## Verify

1. `pnpm check`, `pnpm test:integration` and `pnpm e2e`, output shown.
2. **On staging, on a fresh shop:** add two customers (one with credit), see them on a staging counter within seconds, sell on account to one, record a bank receipt for them (W1-19), and check the ledger. Results go into this plan.

## Order

1. The integration tests for the API and the pull (failing), committed.
2. Permissions and migration 0020, contracts, the shared "never used" check (suppliers' tests still green).
3. The routes until the integration tests pass.
4. The screens and their tests; the e2e.
5. Docs and D-109; `pnpm check`, integration, e2e; the PR into `staging`.

## Risks

| Risk | Mitigation |
|---|---|
| A customer edited here before go-live is overwritten by the next import | The notice on imported customers (owner answer 6); new customers are never touched. |
| A manager adds a near-duplicate of an existing customer | The duplicate-phone hint and the search; a duplicate never used can be deleted. |
| The owner turns credit on and forgets the limit | *No limit* must be ticked on purpose (owner answer 3); the offline cap still applies. |
| A customer is deactivated while a counter has their bill open or held | The bill keeps its customer and the server accepts it (rule 7, D-011); only new searches hide them. |
| Moving the "never used" check changes supplier deletes | The suppliers' integration tests run unchanged against the shared check. |
| Phones in the back office | Staff only, behind the back-office login; never logged; made-up data in tests and on staging. |
