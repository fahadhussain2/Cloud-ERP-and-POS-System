# Accounting (`ACC`)

| | |
|---|---|
| **Status** | In progress: the posting engine for sales built in W1-08 (in review); [spec](spec.md) v1 accepted |
| **Requirements** | 9 (ACC-01…ACC-09) |
| **Feature spec needed** | Yes: posting engine design and rebuild ([spec.md](spec.md)) |

## Scope

Chart of accounts, automatic posting engine, customer/supplier sub-ledgers, receipts and payments, journal vouchers, fiscal periods and lock date, financial statements, payment-method mapping, tax codes.

## Requirements

Full wording is in [the PRD](../../01-PRD.md). Wave 1 = critical path for go-live, Wave 2 = rest of the MVP.

| ID | Summary | Wave |
|---|---|---|
| ACC-01 | Chart of accounts (tree) from a retail template plus tenant-specific accounts. | 1 |
| ACC-02 | Automatic posting of every operational document to the GL per [posting rules](04-ACCOUNTING-POSTING-RULES.md). | 1 |
| ACC-03 | Customer and supplier sub-ledgers with balances and ageing (from cutover onward). | 1 |
| ACC-04 | Back-office receipts and payments (bank), expenses, bank-to-bank transfers. | 1 |
| ACC-05 | Journal vouchers (accountant), with reversal. | 1 |
| ACC-06 | Fiscal years and periods from the tenant setting. | 1 |
| ACC-07 | Reports: account ledger, cash book, trial balance, profit & loss, balance sheet (any date range). | 2 |
| ACC-08 | Payment-method → GL account mapping (e.g. | 1 |
| ACC-09 | Tax code on items (all 0% in the MVP) and tax lines on documents, so VAT/sales tax can be switched on later without schema changes. | 1 |

## Related

docs/04-ACCOUNTING-POSTING-RULES.md (all); data model §9; D-022, D-023, D-035, D-057

## Work in this module

- `spec.md`: only if needed (see above), written before the first plan that depends on it.
- `plans/<wave>-<nn>-<slug>.md`: one accepted plan per task, before any code ([delivery process](../../07-DELIVERY-PROCESS.md) §3).
- `intent.md`: only for changes after the MVP.
