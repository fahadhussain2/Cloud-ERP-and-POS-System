# W0-12 Legacy importer: parse the dumps into staging

| | |
|---|---|
| **Issue** | [#13](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/13) |
| **Module** | migration |
| **Status** | Built, in review (2026-10-24) |
| **Refs** | MIG-01; [importer spec](../spec.md); migration doc §1, §2; CLAUDE.md rules 1 and 11; D-084 |
| **Depends on** | W0-01 |
| **Size** | about 1.5 days |
| **Test-first** | Yes: the parser, the date conversion and the credential exclusion |

## Goal

**Every row of the legacy dump, exactly as it is, in a local staging database**, with counts that prove nothing was lost and no passwords or CNICs stored. W0-13 then maps the staged rows into your Delux tenant (items, parties, chart of accounts) and produces the cleanup reports.

## Design (D-084)

| Choice | Why |
|---|---|
| **Staging is a separate local database** (`erp_legacy` on the dev PostgreSQL), one schema per dump copy (`legacy_dec2025`, later `legacy_oct2026`, `legacy_final`). Never on the server, never in the app database. | It holds customer and staff names and phones. Separate copies let us compare the Dec 2025 and 2026 dumps (the per-period database question). SQL makes the W0-13 transforms simple. |
| **A generic parser:** every `.sql` file is staged, with its columns from the `INSERT` column list. | No hand-kept table list to go stale. A table we didn't expect is still staged and shows up in the report. |
| **Values stay as text, as the source wrote them**, with only the encoding undone: strings decoded, `CAST(0x… AS DateTime)` → ISO date-time, decimals kept as their exact digits. | "Untouched" staging. No floating point anywhere (rule 1). The mapping happens once, in W0-13, where it's tested. |
| **Credential columns are dropped while parsing**, before anything is written. A CNIC-shaped value in any other column **stops the run** and names the column, never the value. | Rule 11: `Admin_Users.UserPassword` and CNICs are never stored, printed or migrated. Failing closed catches a column we didn't foresee. |
| **Counts must agree three ways:** rows staged = rows parsed = `INSERT` rows found by a separate line scan of the file. | Proof that the parser didn't skip or split rows, independent of the parser itself. |
| **Reports carry counts and column names only**, in a git-ignored `tools/legacy-import/out/`. I run the importer and read its reports; I never query staged rows. | You can share the reports with me safely; the data stays on your PC. |

## Scope

1. **`docs/modules/migration/spec.md`:** the importer design (written with this plan).
2. **`tools/legacy-import`:**
   - `parse`: a streaming UTF-16 LE reader and a tokenizer for SSMS scripts (`INSERT … VALUES`, `GO`, `SET …`, comments; `CREATE`/`ALTER` skipped; anything else stops with file and line)
   - the DateTime conversion (binary and string forms)
   - credential column exclusion and the CNIC check
   - `stage --label <label> [--dump <dir>]`: creates `erp_legacy` if missing, rebuilds `legacy_<label>`, loads in batches, writes `_files`
   - the staging report (`out/<label>/staging-report.md` and `.json`): per table: rows, independent count, SHA-256, dropped columns; totals; anything unexpected
3. `.gitignore`: `tools/legacy-import/out/`.
4. A `pnpm legacy:stage` shortcut and the steps in the migration README.

**Out of scope:**
- mapping into the tenant and the cleanup reports (W0-13)
- opening balances, the 90-day bills and reconciliation (Wave 1)
- loading production (a later plan, for the rehearsals and the 31 Dec run)

## Tests written first

All with **synthetic dump files** written by the tests (UTF-16 LE, CRLF). No real data in git or CI.

- [x] **Parser (golden):**
  - strings with `''`, line breaks and Urdu
  - `NULL`, negatives, decimals and `CAST(… AS Decimal(18, 2))` kept digit for digit
  - binary literals
  - several rows in one `INSERT`
  - `GO`, `SET IDENTITY_INSERT`, comments, skipped `CREATE TABLE`
  - an unknown statement stops with file and line
- [x] **DateTime (golden):**
  - `0x0000000000000000` → `1900-01-01 00:00:00.000`
  - negative days (before 1900)
  - ticks rounding: 1 → `.003`, 2 → `.007`, 299 → `.997`
  - a real-looking 2025 value
  - the `CAST(N'…' AS DateTime)` form
- [x] **Credentials:**
  - a fixture `Admin_Users` with `UserPassword` and a `CNICNo` column → neither column exists in staging, the report lists both as dropped, and no value appears in any output
  - a CNIC-shaped value in an ordinary column stops the run, naming only the column
  - `Nickname` is kept
- [x] **Staging (integration, PostgreSQL):**
  - a fixture dump stages with all three counts equal
  - staging the same label again gives the same result, not duplicates
  - two labels live side by side
  - a file whose line scan disagrees with the parser fails the run
- [x] **Coverage:** 100% on the parser and the date conversion, like `packages/domain`.

## Verify

1. `pnpm check` and the integration tests.
2. **On the real Dec 2025 copy, on your PC:** `pnpm legacy:stage --label dec2025`. The report must show the migration doc §1 counts: 19,552 items, 375 partners, 22,644 sale headers / 35,152 lines, 24,976 GL headers / 53,799 lines…, and `UserPassword` listed as dropped. I'll paste the report (counts only) into the plan's results.

## Order

1. Spec and plan (this PR).
2. Failing tests.
3. Parser and date conversion, then credentials, then staging and the report.
4. The real run on the Dec 2025 copy.

## Risks

| Risk | Mitigation |
|---|---|
| The SSMS script uses syntax the fixtures don't cover | The parser stops at the first unknown statement with the file and line, never guesses; I add the case as a golden test and rerun. |
| Personal data leaks into a report, a log or git | Values never appear in reports or errors (tested); `out/` and `sql_dump/` are git-ignored; staging is local only; the hook blocks other access to the dump. |
| A secret column under an unexpected name | Name-based dropping plus the CNIC-shaped value check; the report lists every staged column per table for you to scan once. |
| Large files are slow | Streamed, batched inserts; the §1 counts add up to under 200k rows, so minutes at most. |

## Questions for you

1. **The 2026 dump:** the PRD (Q11) expected a current 2026 dump by about the end of October, to confirm how the legacy system splits periods into databases. When can you put it in a new folder under `sql_dump/` (e.g. `sql_dump/2026-10/`)? W0-12 works on the Dec 2025 copy, but W0-13's results should be checked on 2026 data.
2. **Staging stays on this PC only.** OK? (Proposed: yes; it's never copied to the server.)

## Owner answers (2026-10-24)

1. **The 2026 dump:** not answered yet. W0-12 runs on the Dec 2025 copy; the 2026 dump is needed before W0-13's results are checked.
2. **Staging on this PC only:** yes.

## Changes during the build

Found by the first run on the real Dec 2025 copy; each was added as a test before the fix.

| Plan | Built | Why |
|---|---|---|
| Skip `GO`, `SET`, `USE`, comments, `CREATE`/`ALTER` | Also `IF` and `EXEC` batches (up to `GO`) and `PRINT` lines | The dump has a database script (`IF … sp_fulltext_database`, `EXEC …`) and SSMS writes `print 'Processed 100 total records'` between data batches. |
| The line scan counts lines that start an `INSERT` | Lines that start with `INSERT [` (SSMS's data form, at column 0) | A stored procedure's code contains an `INSERT`; it's skipped as code, so it mustn't be counted as data. A mismatch either way still fails the run. |
| Credential columns by whole words | `cnic`, `password`, `passwd`, `pwd` anywhere in the name; `pass`, `pin`, `nic` as words | `INV_BusinessPartner.BPCNIC` is one run of capitals. The CNIC value check stopped the run on it, as designed; now the name rule drops it. A side effect: `Admin_Users.ByPassWelcomeScreen` (a screen flag) is dropped too, which costs nothing. |
| A streaming reader | Each file is read whole, then parsed row by row | The largest file fits in memory easily; rows are still inserted in batches. |
| A separate `parse` step | Parsing runs inside `stage` | Nothing needs parsed rows without staging them. |

## Results (2026-10-24)

**Real run on the Dec 2025 copy** (`pnpm legacy:stage --label dec2025`, about 30 s): **79 files, 45 tables, 217,495 rows**, every file passing the three-way count.

| Table | Rows | Migration doc §1 |
|---|--:|--:|
| `INV_Item` | 19,552 | 19,552 |
| `INV_BusinessPartner` | 375 | 375 |
| `INV_BusinessPartnerSelection` | 414 | 281 supplier + 131 customer roles, plus the cash partners |
| `INV_Category` · `INV_Brand` · `INV_Make` · `INV_Manufacture` · `INV_Size` · `INV_Unit` | 267 · 330 · 23 · 214 · 74 · 5 | the same |
| `GL_ChartofAccount` | 77 | 77 |
| `INV_SaleHeader` / `INV_SaleDetail` | 22,644 / 35,152 | the same |
| `INV_PurchaseHeader` / `INV_PurchaseDetail` | 1,280 / 10,736 | the same |
| `GL_TransactionHeader` / `GL_TransactionDetail` | 24,976 / 53,799 | the same |
| `Admin_Users` | 17 | 17 |

- **Dropped, never stored:** `Admin_Users.UserPassword`, `INV_BusinessPartner.BPCNIC`, `Admin_Users.ByPassWelcomeScreen`.
- The staged column names were checked once: no other password, PIN or CNIC column. Contact columns (phones, e-mails, addresses of parties) stay in local staging for W0-13, which masks them in reports.
- `Admin_Company` has the name, NTN and sales-tax numbers but no address or phone; W0-13 looks for the rest of the bill header in the other `Admin_` tables.
