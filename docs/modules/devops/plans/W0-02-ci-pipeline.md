# W0-02 CI pipeline (GitHub Actions)

| | |
|---|---|
| **Issue** | [#3](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/3) |
| **Module** | devops |
| **Status** | Accepted (2026-10-21) |
| **Refs** | Architecture §9.1, §12; D-063, D-071, D-072 |
| **Depends on** | W0-01 (merged into `staging`) |
| **Size** | about half a day |

## Goal

Every pull request, and every push to `staging` and `main`, is checked automatically, and a red run is impossible to miss. Integration tests can reach a real, throwaway PostgreSQL from day one, so W0-07 (RLS) can be written test-first.

## Design

| Choice | Why |
|---|---|
| **One workflow, `.github/workflows/ci.yml`**, with two jobs: `check` and `integration` | Simple to read. The two jobs run in parallel, so total time is the slower of the two. |
| **Triggers:** pull requests into `staging` or `main`, and pushes to `staging` and `main`. Task branches are checked through their pull request. | Avoids running everything twice for the same commit. |
| **Docs-only changes don't run CI** (`paths-ignore: docs/**, **/*.md`) | Saves Actions minutes. Docs are reviewed by reading. |
| **`concurrency`:** a newer push cancels the older run on the same branch | Saves minutes and shows only the latest result. |
| **`check` job:** Node from `.nvmrc`, pnpm from `packageManager`, a cached pnpm store, `pnpm install --frozen-lockfile`, then `pnpm check` | The same command as on the PC. CI is not a second definition of "done". |
| **`integration` job:** a `postgres:17` service container, then `pnpm test:integration` | Same major version as production. Thrown away after every run. |
| **Integration tests are separate files, `*.int.test.ts`**, run by `vitest.integration.config.ts`. `pnpm test` stays unit-only and needs no database. | Unit tests stay fast and work offline. Integration tests **fail loudly** when `DATABASE_URL` is missing, so they never pass by being skipped. |
| **PostgreSQL driver: `pg` (node-postgres), D-072** | The most mature driver. Drizzle supports it, and pg-boss (the planned job queue) uses it too, so there is one driver to learn and patch. |
| **Least privilege:** `permissions: contents: read`; actions **pinned to a commit SHA** with the version in a comment; Dependabot updates the actions monthly | A tag can be moved by an attacker; a SHA cannot. Dependabot keeps the pins from going stale. |
| `timeout-minutes: 15` per job | A hung run can't burn the monthly minutes. |

## Scope

1. **`.github/workflows/ci.yml`** as designed above.
2. **`.github/dependabot.yml`**: monthly updates for `github-actions` only. npm updates stay manual for now, to avoid noise during the build.
3. **Integration test setup:**
   - root `vitest.integration.config.ts`; the unit config excludes `*.int.test.ts`
   - script `test:integration`
   - `pg` added to `packages/db`
4. **First integration test** in `packages/db/src/connection.int.test.ts`. It shows the database works the way the design depends on:
   - the server is PostgreSQL **17 or newer**
   - `pg_snapshot_xmin(pg_current_snapshot())` returns an `xid8` (the change-feed cursor, CLAUDE.md rule 8)
   - a `SET LOCAL app.tenant_id` inside a transaction is visible within the transaction and gone after it (the per-request RLS context, architecture §6.2)
5. **Local integration tests:** `DATABASE_URL` in `.env.example`. A local PostgreSQL (Docker Compose) arrives with W0-07. Until then, integration tests run in CI only.
6. **`CLAUDE.md`:** add `pnpm test:integration` to the commands.
7. **Status badge** for `staging` in a short root `README.md` (the repo has none yet): name, one-line description, link to the docs.

**Out of scope:**
- Deploy jobs and the after-hours rule (W0-04)
- Nightly Playwright and backup checks (W0-05, Wave 1)
- Branch protection: not available for private repos on the free plan (architecture §9.1)

## Order

1. Write the integration config and the failing `connection.int.test.ts`. It fails locally because there is no `DATABASE_URL`, which proves the loud-failure rule.
2. Add the workflow and Dependabot config.
3. Open the PR. CI must be green on its own PR.
4. Prove that red works: push a temporary commit with a broken unit test, and one with a broken integration test. Both must turn the run red. Then revert them.
5. Update `CLAUDE.md` and the README.

## Tests that prove it

- [ ] The PR's own CI run is green: the `check` and `integration` jobs both pass. Run links go in the PR.
- [ ] A deliberately failing unit test turns `check` red, and a failing integration test turns `integration` red. Run links go in the PR; both commits are reverted.
- [ ] A docs-only commit to `staging` starts no run.
- [ ] Locally, `pnpm test:integration` without `DATABASE_URL` exits non-zero with a clear message.
- [ ] Measured run time: under 10 minutes, with about 3–5 minutes expected.

## Risks

| Risk | Mitigation |
|---|---|
| **The free plan has 2,000 Actions minutes a month for private repos** | About 4 minutes a run, so about 400 runs a month. Docs skip CI, and cancelled runs stop early. Usage is checked at the end of November. |
| A flaky Postgres start makes runs randomly red | The service has a `pg_isready` health check, so the job waits until the database is ready. |
| CI and the PC drift apart | Both run the same `pnpm check`; Node comes from `.nvmrc` and pnpm from `packageManager`. |

## Owner actions

None. GitHub Actions is already enabled on the repo.
