# W0-04 Deploy pipeline: staging and production

| | |
|---|---|
| **Issue** | [#5](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/5) |
| **Module** | devops |
| **Status** | Accepted (2026-10-22) |
| **Refs** | Architecture §9, §9.1; D-063, D-065, D-073, D-075 |
| **Depends on** | W0-02 (CI), W0-03 (server and edge) |
| **Size** | about 2 days |

## Goal

A merge to `staging` deploys to staging automatically. A merge `staging` → `main` deploys to production, but only outside shop hours. Every deploy runs migrations first, checks health, and rolls itself back if the new version is unhealthy. Nobody has to SSH in to release.

## Design (D-075)

| Choice | Why |
|---|---|
| **Three images per release: `api`, `worker`, `web`**, built in CI from one multi-stage `Dockerfile` | The API and worker are Node; `web` is a small Caddy serving the built POS and back office. A rollback is then the same thing for everything: switch all three images back. |
| **No container registry.** CI sends the images to the server over SSH (`docker save \| ssh … load`). | GitHub's registry would need a token stored on the server, and private packages have small free limits. Nothing to sign up for, nothing to pay. |
| **Images are tagged with the git *tree* hash** (the content of the code, not the commit) | Merging `staging` → `main` gives the same tree, so production reuses the **exact image that was tested on staging**: no rebuild, nothing new slips in. |
| **Deploys go through `erp-deploy` on the server**, the only command the GitHub deploy key may run. It accepts `status`, `load`, `deploy <env> <tag>` and `rollback <env>`, and nothing else. | A leaked deploy key can't open a shell or run anything else. The deploy logic lives in git and is installed by `bootstrap.sh`. |
| **Each deploy:** load images → **run migrations** (stop if they fail; the old version keeps running) → start the new version → **health check** (`/api/health` must return the new version, the web pages must load, the worker must stay up) → keep, or **roll back** to the previous tag automatically and fail the run | This is D-063, made concrete. |
| **Migrations must be backward-compatible** with the previous release (expand → deploy → contract later) | A rollback switches code, not the database. Rolling back is only safe if the old code still works with the new schema. This rule goes into `REVIEW.md` as a blocker. |
| **Production after hours:** a production deploy that starts between **10:00 and 20:00 Karachi** is deferred. A scheduled run at **22:00 and 02:00 Karachi** deploys whatever is waiting. A manual "Run workflow" with `force` is the emergency override. | Keeps D-063. 22:00 leaves time for the closing routine (late sales, drawer close) before a deploy. Two short scheduled runs cost about 1 Actions minute a day. |
| **Staging also deploys any branch on demand** (manual "Run workflow" with a branch), so a pull request can be tried on staging before it is merged | Useful for checks like the rollback rehearsals below, without merging anything broken. |
| **One compose file for both environments** (`infra/app/compose.yaml`): projects `erp-prod` and `erp-staging`, joined to the `erp-edge` network. Staging has hard limits (about 1.5 GB RAM / 1 vCPU in total). | Staging is the same setup as production, just smaller. Staging runs all the time for now; stopping it on demand comes later if memory gets tight. |
| **A release log on the server** (`/srv/erp/<env>/releases.log`), and the last 5 releases kept for rollback | Shows what ran when, and makes rollback instant. |
| **Alerts:** GitHub emails a failed run until Slack arrives (W0-06) | Nothing extra to set up now. |

## Scope

1. **App changes** (small, needed to run in containers):
   - `/api/health` also returns `version` (the image tag).
   - The API listens on `HOST` / `PORT` from the environment and shuts down cleanly on `SIGTERM`.
   - The worker stays running and stops cleanly on `SIGTERM`; today it exits right away.
   - A `migrate` entry point in the API that does nothing until W0-07 adds the database. The deploy step and its failure path exist from today.
2. **`Dockerfile`** (targets `api`, `worker`, `web`) and **`.dockerignore`**, which excludes `node_modules`, `docs`, `.git`, `coverage` and `sql_dump`.
   - Runs as non-root, on a read-only filesystem, with a health check built in.
3. **`infra/app/`:** `compose.yaml`, plus the `web` container's Caddyfile:
   - POS and back office as single-page apps
   - `index.html` never cached; hashed assets cached for a year
4. **`infra/edge/caddy/Caddyfile`:** route each site to its environment's `web` and `api` containers, replacing the placeholders.
5. **`infra/server/files/bin/erp-deploy`** with its allowed commands. `bootstrap.sh` installs it. The deploy key is added with `restrict,command="/usr/local/bin/erp-deploy"`.
6. **`.github/workflows/deploy.yml`:**
   - called by CI after the checks pass on a push to `staging` or `main`
   - also runs on the 22:00 / 02:00 Karachi schedule and by hand ("Run workflow")
   - never cancels a running deploy
   - builds with a layer cache
   - skips the build when the server already has the image for this tree
7. **`REVIEW.md`:** blocker "migration not backward-compatible with the previous release".
8. **`infra/README.md`:** how to deploy, roll back, read the release log, and use the emergency override.

**Out of scope:**
- The database and real migrations (W0-07)
- Backups (W0-05)
- Slack alerts and dashboards (W0-06)
- The staging CX23 (before the pilot)

## Order

1. App changes, with tests (health `version`, clean shutdown, the worker staying up).
2. Dockerfile and compose; build and run them locally.
3. `erp-deploy` and the bootstrap change. Apply to the server and check that the deploy key can't get a shell.
4. Deploy workflow. First staging deploy from this branch, using the on-demand staging deploy.
5. Rehearsals (below), then the PR. After you merge it, the merge itself deploys to staging.
6. **First release:** you merge `staging` → `main`. We check the after-hours rule and the first production deploy.

## Tests that prove it

- [ ] **Unit tests:** `/api/health` returns `version`; the API and worker stop cleanly on `SIGTERM`.
- [ ] **Merge to `staging` deploys staging automatically.** `staging-pos` and `staging-app` show the real (placeholder) apps, and `/api/health` returns 200 with the new version.
- [ ] **Bad health check → automatic rollback.** A throwaway branch whose `/api/health` returns 500 is deployed to staging on demand. The deploy fails, the previous version is serving again within a minute, and the run is red.
- [ ] **Failing migration → nothing switches.** A throwaway branch whose `migrate` exits with an error: the deploy stops before starting the new version, the old version keeps serving, and the run is red.
- [ ] **Rollback by reverting a merge on `staging`** redeploys the previous version.
- [ ] **The deploy key can't do anything else:** `ssh deploy@… bash`, or any command other than the four, is refused.
- [ ] **Production after hours:** a release merged during shop hours is deferred, with a clear message in the run, and deployed by the next scheduled run (or by `force`). After a release, `pos` and `app` serve the apps, and production uses the **same image tag** that staging tested.
- [ ] A deploy takes under 5 minutes; when the image already exists, under 1 minute.
- [ ] The release log on the server shows every deploy and rollback.

## Risks

| Risk | Mitigation |
|---|---|
| A migration that the previous code can't handle makes rollback unsafe | Backward-compatible migrations only, a `REVIEW.md` blocker, and W0-07 adds a CI test that runs the previous release against the new schema. |
| A bad deploy during closing time | Production deploys only outside 10:00–20:00; the scheduled runs are at 22:00 and 02:00. Counters keep selling offline even while the API restarts. |
| The deploy key leaks | It can only run the four `erp-deploy` commands. Revoke it by deleting its `.pub` file and re-running the bootstrap. |
| Images fill the disk | The last 5 releases per environment are kept, and older images are pruned after each deploy. |
| GitHub's scheduled runs start late (it happens, by up to about 15 minutes) | Harmless at night. |

## Owner actions

1. Store the deploy key in GitHub. I generate it; you run one command (`gh secret set DEPLOY_SSH_KEY < …`), so the private key never appears on screen. Then I delete the local copy.
2. Merge the first release PR, `staging` → `main`.
