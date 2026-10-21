# Delivery Process (AI-native SDLC)

| | |
|---|---|
| **Status** | Accepted (D-069). Applies from Wave 0 onward. |
| **Based on** | [The AI-native SDLC playbook](https://claude.com/resources/articles/the-ai-native-sdlc-playbook), scaled down for a solo developer working with Claude Code |
| **Related** | [PRD](01-PRD.md) · [Architecture §9 (CI/CD, environments)](02-ARCHITECTURE.md) · [Decisions](06-DECISION-LOG.md) |

---

## 1. Principle

Every stage of the work ends in a **committed file that the next stage reads**: intent → spec → plan → code → review → deploy. The commit history is the audit trail. Nothing is built without an accepted plan, and nothing is "done" until the checks have run and their output has been shown.

## 2. Where things live

```
docs/
  01-PRD.md … 06-DECISION-LOG.md   ← product level: the MVP intent and spec
  07-DELIVERY-PROCESS.md           ← this file
  modules/
    platform/        PLT: tenants, users, roles, devices, PINs, audit
    catalog/         CAT
    pos/             POS
    cash-desk/       CSH
    inventory/       INV
    purchasing/      PUR
    accounting/      ACC
    reports/         RPT
    sync/            SYN
    migration/       MIG
    devops/          CI/CD, hosting, observability (architecture §9, §11)
      README.md      ← scope, requirement IDs, links to the PRD, status
      intent.md      ← only for work after the MVP (new feature or change)
      spec.md        ← only where the product docs aren't detailed enough to build from
      plans/
        W1-03-item-search.md   ← one plan per task: <wave>-<nn>-<slug>.md
```

**Rules**

- **One folder per module, not per task.** Modules follow the PRD requirement groups.
- **The MVP needs no new intents:** the PRD is the intent. A feature spec is written only where needed. Expected: sync, POS checkout, posting engine, legacy importer, device enrollment and PIN.
- **Every plan names its requirement IDs and decisions** (e.g. `SYN-02`, `D-011`), so any piece of code traces back to the PRD.
- **Each task is a GitHub issue**, 0.5–2 days of work, linking to its plan.

## 3. The loop for every task

| Step | What happens | Output |
|---|---|---|
| **1. Plan** | Claude starts in plan mode with the module README/spec and writes the plan: files to change, order, risks, tests that prove it. The owner accepts it, briefly for small tasks. **No code before acceptance.** | `plans/<task>.md` committed |
| **2. Tests first** | For `packages/domain`, `packages/posting`, sync and RLS: golden test cases written first and committed. | Failing tests |
| **3. Build** | On a short branch off `staging`. If the work departs from the plan, the plan is updated in the same commit. | Code + updated plan |
| **4. Verify** | Claude runs the one-command checks (lint, type check, tests, build) and **shows the output before saying "done"**. A verifier subagent runs the app for UI tasks. | Green checks |
| **5. Review** | Claude reviews the PR against `REVIEW.md` (bugs, security, matches the spec and plan, docs updated). Findings are ranked by severity, with few nits. **The owner approves the merge.** The agent that wrote the code never approves it. | Reviewed PR |
| **6. Merge to `staging`** | Auto-deploys to staging. The owner checks it there. | Running on staging |
| **7. Release** | The owner merges `staging` → `main`. Production deploys after shop hours, with migrations, a health check and auto-rollback (D-063). | Running in production |

**Bug fixes:** write a failing test first and commit it, then fix the code **without editing that test**. A hook enforces this.

## 4. Guardrails in the repo

| Item | Purpose |
|---|---|
| `CLAUDE.md` (**about one page**) | Build, test and lint commands, conventions, non-negotiable rules, known mistakes. Detail lives in `docs/`. A rule is added whenever Claude repeats the same mistake twice. |
| `REVIEW.md` | Review policy: severity levels, checklist (money as integers, RLS on new tables, no business rules outside `packages/domain`, immutable documents, i18n keys, docs and decision log updated). |
| `.claude/settings.json` hooks | Block any edit or read of `sql_dump/`. Run the formatter and linter on changed files after edits. Block secrets in diffs. Block test-file edits during bug fixes. |
| `.claude/skills/` | Core knowledge applied the same way every time: **posting rules**, **checkout rules**, **legacy migration mapping**, **sync protocol**. Skills are advisory; critical rules are also enforced by tests and hooks. |
| `.claude/agents/` | **verifier**: runs checks and the app, reports without fixing. **researcher**: explores code and docs read-only. |

## 5. Tests and evals

- **One-command checks** that fail loudly: `lint`, `typecheck`, `test`, `build`, plus end-to-end runs for UI flows.
- **Evals:** a growing set of **real shop scenarios** (start with about 20, aim for 50), run in CI nightly and whenever `CLAUDE.md`, skills or hooks change. Examples: offline day + sync, a return of an unsynced bill, a credit sale over the limit, a goods receipt with a bill discount, the day-close variance.
- **Every production incident becomes a permanent test or eval.**

## 6. Working rhythm

- **Parallel sessions:** up to 2–3 Claude sessions in separate git worktrees, on modules that don't touch the same files (e.g. `migration` and `domain`). Never more than the owner can review.
- **Autonomy:** auto-accept edits only for routine, well-tested changes with a tight plan. Everything touching money, sync or security is reviewed step by step.
- **Weekly demo on staging:** the owner clicks through what was built, and feedback becomes plan changes or new decisions.
- **Docs stay current:** any change of decision → a new decision-log entry, in the same PR as the code.

## 7. After go-live (maintain)

- **Alerts** (architecture §11) go to Slack. Claude can **diagnose read-only** and writes its findings as an `intent.md` in the affected module. The owner triages.
- **Incidents:** a short post-mortem in `docs/lessons.md`, plus a new eval or test.
- **New features** enter the same loop: `intent.md` → `spec.md` (if needed) → plans.

## 8. What we measure

| Stage | Indicator |
|---|---|
| Build | Plans accepted without rework; first-pass merge rate; time from plan to merge |
| Test | First-pass CI success; eval pass rate; bugs caught in CI versus on staging or in production |
| Review | Findings fixed before merge; review comments needing human edits |
| Deploy | Deploy frequency, failed deploys, rollbacks, time to restore |
| Release plan | Wave progress against PRD §8; open issues per wave |

## 9. Setup before Wave 0 code (no application code)

1. Trim `CLAUDE.md` to about a page; move the detail into the docs it links to.
2. Add `REVIEW.md`.
3. Add `.claude/settings.json` hooks, the skills and the subagents.
4. Create `docs/modules/<module>/README.md` for every module, with scope, requirement IDs and status.
5. Break Wave 0 into GitHub issues, each with a plan to be accepted before building.
