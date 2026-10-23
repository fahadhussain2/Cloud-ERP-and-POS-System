# W0-11 Delux tenant setup: settings, chart of accounts, payment methods, tiers, roles, print profile

| | |
|---|---|
| **Issue** | [#12](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/12) |
| **Module** | platform (with accounting) |
| **Status** | Accepted (2026-10-23) |
| **Refs** | PLT-01, PLT-02, PLT-11, ACC-01, ACC-08, ACC-09, POS-16; posting rules §2; migration §5; D-055, D-056, D-061, D-081, D-083 |
| **Depends on** | W0-07, W0-09, W0-10 |
| **Size** | about 2 days |
| **Test-first** | Yes for the chart-of-accounts rules and the setup's idempotency |

## Goal

**One repeatable command creates a ready-to-use shop**: your real Delux tenant first, then test and demo shops, and later the second customer (PLT-11). After it you can log in to the back office as yourself, and the legacy importer (W0-12/13) has a real tenant to load your items, customers, suppliers and opening balances into.

## Design (D-083)

| Choice | Why |
|---|---|
| **A tenant is described by a JSON spec** in git (`infra/tenants/delux.json`): settings, branch, locations, banks and wallets, payment-method mapping, price tiers, print profile, the owner's username. No secrets. | Reviewable, versioned, and the same file creates a staging copy for testing. |
| **The chart of accounts comes from a retail template** (`packages/db/templates/retail-coa.json`, the tree in posting rules §2) plus the tenant's own bank and wallet accounts | ACC-01: every shop starts with the same structure and system roles; the legacy importer maps Delux's old accounts into it (migration §5). |
| **CoA rules are checked by a pure function in `packages/domain`:**<br>• every system role (`CASH_DRAWER`, `AR_CONTROL`, `COGS`…) mapped **exactly once**<br>• a child has its parent's type<br>• parents aren't postable | The posting engine (Wave 1) relies on these. A template or import mistake fails loudly before anything is written. |
| **Create-if-missing, never overwrite.** Re-running with the same spec changes nothing and says so. A spec value that differs from the database is **reported, not applied**. | Safe to run again at any time. Changing a live shop's settings is a deliberate back-office action, not a side effect of a script. |
| **The owner chooses their own password at a hidden prompt** when the command runs on the server (`ssh -t … sudo erp-tenant setup delux`). The account is marked **must change password** only for test tenants with a generated password. | Nobody else, including Claude, ever sees your password (the same pattern as the backup secrets). |
| **A forced password change is enforced by the API:** while `must_change_password` is set, every route except `me`, `logout` and `PUT /api/users/me/password` answers `403 password_change_required`. The new endpoint needs the current password and the W0-09 password rules. | Generated passwords for test or support accounts can't stay in use. |
| **Cash isn't mapped to an account on the payment method.** The posting engine routes cash by role (`CASH_IN_TRANSIT` at counters, `CASH_DRAWER` at the desk; posting rules §4). Non-cash methods map to a bank, wallet or card-clearing account (ACC-08). | Matches the posting rules; the handover flow stays in one place. |
| **New tables:**<br>• `accounts`, `bank_accounts`, `payment_methods`<br>• `price_tiers`, `tax_codes`, `print_profiles`, `expense_categories`<br>• `devices.print_profile_id` (null = the tenant default) | Data model §4, §6, §9. All tenant tables with forced RLS (picked up by the existing check). |

## Delux spec (proposed values)

| Setting | Value |
|---|---|
| Shop code (login) | `delux` |
| Currency | PKR, 2 minor units; **cash rounding Rs 1** (100) |
| Time | Asia/Karachi; business-date cutoff **04:00**; closing **20:00** (D-056) |
| Fiscal year | January–December |
| Tax | none (one tax code `ZERO`, 0 bp, ACC-09) |
| Cash handover | **Required** |
| Branch | `MAIN`, with Shop (sellable), Godown (storage), Damaged (not sellable) |
| Banks and wallets | Soneri, HBL, JazzCash, Easypaisa, card settlement clearing (posting rules §2) |
| Payment methods | cash · bank transfer · Raast · JazzCash · Easypaisa · card (reference required) · on account. JazzCash → JazzCash wallet, Easypaisa → Easypaisa wallet, card → card settlement clearing. **Bank transfer and Raast start unmapped** (the owner picks the bank later; the setup report lists them as "needs an account", and it's on the go-live checklist). |
| Price tiers | Retail (default), Mechanic, Wholesale |
| Roles | the six templates (D-081), Salesman and Cashier with credit sales |
| Print profile | A5 landscape dot matrix, Code 39 barcode, 1 copy, the default for every device (D-055) |
| Expense categories | Salaries, Utilities, General, Miscellaneous (the importer adds Delux's own heads) |

## Scope

1. **Migration `0005`:**
   - the tables above, with RLS, sync and audit
   - `users.must_change_password`
2. **`packages/domain`:** `validateChartOfAccounts()`, with golden cases.
3. **`packages/db`:**
   - `templates/retail-coa.json`
   - `setupTenant(ownerUrl, spec, ownerPassword)`: idempotent, returns a report of created / existing / drifted items
   - the Zod spec schema in `packages/contracts`
4. **`apps/api`:**
   - a `setup-tenant` entry (bundled like `migrate`)
   - `PUT /api/users/me/password`
   - the must-change-password gate
   - `mustChangePassword` in the login and `me` responses
5. **Server:**
   - `erp-tenant setup <spec>` (installed by `infra/db/apply.sh`): runs the entry in a one-off API container with the owner database role, with a hidden password prompt
   - `infra/tenants/apply.sh` from the PC, for test tenants with a password from a git-ignored file
6. **`infra/tenants/delux.json`** and `demo.json` (a test shop).
7. **Docs:** data model §4, §6, §9 updates; infra README (how to create a tenant); the platform README.

**Out of scope:**
- items, customers, suppliers and opening balances (the legacy importer, W0-12/13)
- the onboarding wizard and self-signup (later phases, D-061)
- fiscal periods (with posting, Wave 1)

## Tests written first

- [ ] **CoA rules (golden):** the retail template passes. Each of these fails with a clear code:
  - a missing system role
  - a duplicate system role
  - a child of another type
  - a postable parent
  - an unknown parent code
  - a duplicate account code
- [ ] **Setup (integration):**
  - Creates the tenant, the directory entry, the branch, the 3 locations, the full chart with **every system role exactly once**, the banks, the payment methods (cash unmapped, non-cash mapped), the tiers (one default), `ZERO`, the 6 roles, the owner with the Owner role, and the default print profile.
  - **A second run reports "no changes"** and creates no duplicates.
  - A changed spec value is reported as drift and **not** applied.
  - The owner can log in with the chosen password.
- [ ] **Password change:**
  - A must-change user gets `403 password_change_required` on other routes, but can call `me`, `logout` and the change endpoint.
  - The change needs the current password, applies the W0-09 rules, clears the flag, and ends the user's other sessions.
- [ ] RLS covers every new table (the existing check), and the Drizzle mirror matches (the drift check).

## Order

1. Failing tests.
2. Domain CoA rules, then the template.
3. Migration `0005`.
4. `setupTenant` and the API changes.
5. Server command.
6. **Staging:** create `demo` from my PC, then `delux` on staging **from your terminal**, so you can try logging in as yourself on `staging-app`.
7. **Production:** after the next release, **you run the same command once** on production. That's your real shop.

## Risks

| Risk | Mitigation |
|---|---|
| Wrong settings in the spec become live | Values are reviewed in this plan and the PR, and tried on staging first. Settings can be changed later in the back office (Wave 1) or with a migration, not by re-running the setup. |
| The legacy importer expects a different chart | It maps legacy accounts **into** this template (migration §5); W0-13 uses the account codes and roles created here. |
| The owner's password is lost | An admin reset path: a support command that sets a generated temporary password with must-change-password (part of `erp-tenant`). |

## Owner answers (2026-10-23)

1. **Bill header:** later. The legacy importer (W0-12/13) takes the company details from the dump if they're there (only the importer may read it, rule 11); otherwise the owner enters them in the back office. The header starts empty.
2. **Raast and bank transfers:** decided later in the system. Both start without an account; the setup report and the go-live checklist flag them.
3. **Owner username:** `fahad`.
4. **Shop code:** `delux`.
