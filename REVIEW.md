# Review Policy

Every pull request is reviewed by Claude against this policy before the owner approves it. The agent that wrote the code never approves it (docs/07-DELIVERY-PROCESS.md §3).

## How to report

- **Rank findings:** 🔴 **Blocker** (must fix before merge) · 🟠 **Major** (fix before merge unless the owner accepts the risk) · 🟡 **Minor** (fix soon) · ⚪ **Nit** (optional, **at most 3 per review**).
- Each finding gives the **file and line**, **what is wrong**, **a concrete failure scenario** and **a suggested fix**.
- **Check against the task's `plan.md`, the module spec and the requirement IDs.** Unplanned changes are flagged.
- End with a one-line verdict: *Ready to merge* / *Fix blockers first* / *Needs rework*.

## Blockers (always 🔴)

| Area | Check |
|---|---|
| **Money** | Any float or `number` arithmetic on money; rounding outside `packages/domain`; allocations that don't sum exactly |
| **Tenancy** | A new table without `tenant_id` + forced RLS policy; queries that bypass the RLS role; tenant ID taken from user input instead of the session |
| **Immutability** | Code that updates finalized document lines or amounts; deletes of documents or ledger rows |
| **Ledgers** | Stock/party/GL entries written outside `packages/posting`; unbalanced journal entries; postings not linked to a source document |
| **Business rules** | Checkout rules (prices, floors, credit, returns, totals) implemented outside `packages/domain`, or duplicated |
| **Sync** | Non-idempotent document handling; server rejecting a completed sale on a business rule; `updated_at` or sequence used as a change cursor; local DB rebuild while the outbox is not empty |
| **POS checkout path** | A network call on the checkout path; printing before the local transaction commits |
| **Security** | Secrets in code or config; passwords/PINs/tokens logged; missing auth or permission check on an endpoint; SQL built by string concatenation; PIN accepted for back-office login |
| **Data protection** | Anything reading `sql_dump/` outside `tools/legacy-import`; personal data in logs without masking |
| **Migrations** | Destructive schema migration without a backfill/rollback plan; a migration that can't run on a populated database |
| **Tests** | Core logic (domain, posting, sync, RLS) changed without tests; a bug fix without a failing-test-first commit; tests weakened to pass |

## Major (🟠)

- Missing tests for new behaviour outside the core packages
- Error handling that swallows errors or loses the request/document ID context
- Missing i18n keys (hard-coded UI text), physical CSS properties instead of logical ones
- Keyboard flow broken on a POS screen (every action needs a key; every keyboard action needs a clickable equivalent)
- Performance regressions on the POS: search over 100 ms, extra re-renders on the checkout screen, bundle growth without reason
- Docs not updated: a changed decision without a new decision-log entry; module README/spec out of date
- Observability: new endpoints or jobs without structured logging and metrics

## Minor / nits

Naming, small duplication, comments that restate the code, formatting the formatter didn't catch.

## Before posting the review

- [ ] I ran or checked CI: lint, typecheck, tests, build all green
- [ ] I read the plan and the requirement IDs it names
- [ ] Every blocker has a concrete failure scenario, not a style opinion
