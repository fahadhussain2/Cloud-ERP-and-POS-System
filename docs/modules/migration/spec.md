# Legacy importer: design

| | |
|---|---|
| **Status** | Accepted with the W0-12 plan (2026-10-24), D-084 |
| **Refs** | MIG-01…MIG-04; [migration doc](../../05-LEGACY-MIGRATION.md) §1, §2, §7, §8; CLAUDE.md rule 11; D-030, D-034, D-052, D-055 |

The mapping rules are in the migration doc (§3–§5). This spec covers how the importer (`tools/legacy-import`) runs, where data lives, and how personal data is protected.

## 1. Where it runs and where data lives

| What | Where | Never |
|---|---|---|
| The dumps (SSMS scripts, UTF-16 LE) | `sql_dump/` on the owner's PC (git-ignored), one folder per copy | in git, on the server, in CI |
| Staging (raw legacy rows) | a separate database `erp_legacy` on the local PostgreSQL (`pnpm db:up`), one schema per dump: `legacy_<label>` | in the app database, on the server |
| Reports | `tools/legacy-import/out/<label>/` (git-ignored) | in git; phone numbers unmasked |
| Load target | a tenant, through `packages/db` (W0-13 onward); the final run loads production over an SSH tunnel (plan to come) | written by anything but the load step |

- **Only the importer reads the dumps** (rule 11, enforced by a hook). Claude runs the importer and reads its reports; it never queries staged tables or prints staged values.
- Staging is a **disposable copy**: re-staging a label drops and rebuilds its schema. Nothing downstream depends on staging surviving.

## 2. Pipeline

```
parse → stage → transform → report → load
```

| Step | Input → output | Task |
|---|---|---|
| `parse` | a dump folder → rows (streamed), with credential columns already removed | W0-12 |
| `stage` | rows → `legacy_<label>.<table>` + a staging report | W0-12 |
| `transform` | staging → candidate rows + cleanup findings (migration doc §3, §7) | W0-13 |
| `report` | findings → owner-readable reports (HTML/CSV), phones masked | W0-13 |
| `load` | candidate rows → the tenant, one transaction per entity group; `legacy jsonb` on every row, so a re-run updates instead of duplicating | W0-13 (masters), later (opening balances, 90-day bills) |

Command line: `pnpm --filter @erp/legacy-import start <step> --label <label> [--dump <dir>] [--dry-run]`. `--dump` defaults to `sql_dump/` at the repo root.

## 3. Parsing

- **Generic:** every `*.sql` file in the dump folder is parsed; a table's columns come from its `INSERT [dbo].[T] ([a], [b], …)` column list. No hand-written table list, so a new or changed legacy table is staged as it is.
- **Statements:** `INSERT … VALUES (…)` (one or several rows), `GO`, `SET IDENTITY_INSERT`, `SET ANSI_NULLS` / `QUOTED_IDENTIFIER`, `USE`, comments. `CREATE` / `ALTER` statements are skipped. Anything else stops the run with the file and line number.
- **Values** are kept as the text the source denotes. Nothing is computed in floating point (rule 1):

| Source | Staged as |
|---|---|
| `NULL` | `NULL` |
| `N'…'`, `'…'` (with `''` escapes, newlines, Urdu) | the decoded text |
| `123`, `-4.50`, `CAST(12.50 AS Decimal(18, 2))`, `CAST(0 AS bit)` | the number's literal text: `12.50` |
| `CAST(0x<8 bytes> AS DateTime)` | ISO text `2025-12-06 14:03:10.333`: 4-byte signed days since 1900-01-01, then 4-byte ticks of 1/300 s, rounded to milliseconds the way SQL Server shows them (.000, .003, .007) |
| `CAST(N'2025-07-01T00:00:00.000' AS DateTime)` | the same ISO text |
| `0x…` binary | lower-case hex text |

## 4. Personal data and credentials

- **Credential columns are dropped while parsing**, before anything is stored: any column with a word `password`, `passwd`, `pwd`, `pass`, `pin`, `cnic` or `nic` in its name (words split at `_` and case changes, so `UserPassword` and `CNICNo` are dropped, `Nickname` isn't). The staging report lists each dropped `table.column`, never a value.
- **Fail closed:** a value shaped like a CNIC (`12345-1234567-1` or 13 digits) in a column that isn't dropped stops the run, naming the `table.column` only. Then the owner decides whether to drop it or allow it.
- **No values in errors or logs.** Parser errors give the file, line and column name.
- Staging holds names and phone numbers (customers, suppliers, staff). It stays on the owner's PC and is never copied elsewhere.

## 5. Staging tables

- `legacy_<label>.<source table>` (lower case), one `text` column per source column, plus `_file` and `_line`.
- `legacy_<label>._files`: file name, SHA-256, rows staged, `INSERT` statements counted independently, dropped columns, staged at.
- **Counts must agree:** rows staged = rows parsed = `INSERT` rows counted by a separate line scan. Any difference fails the run.

## 6. Re-runs and copies

- Each dump copy gets its own label (`dec2025`, `oct2026`, `rehearsal1`, `final`), so copies can be compared (e.g. the per-period database question in the migration doc §1).
- Staging a label again replaces it completely. Mapping decisions (W0-13) live in a reviewed file, not in staging, so nothing is lost.
