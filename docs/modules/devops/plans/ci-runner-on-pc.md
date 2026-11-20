# CI checks run on the owner's PC

| | |
|---|---|
| **Module** | devops |
| **Status** | Plan accepted (2026-11-20), with deploys on the PC until the minutes reset |
| **Refs** | W0-02 (CI), W0-04 (deploys), D-063, D-075, D-080, D-087 (no paid services); new **D-119** |
| **Depends on** | Docker Desktop on the owner's PC (already used by `pnpm db:up`) |
| **Size** | about half a day, plus the owner's two short steps |

## Goal

The pull-request and merge checks (format, lint, typecheck, tests, build; integration; end-to-end) run on a **runner on the owner's PC** instead of GitHub's machines. Self-hosted runners are free and don't use the free plan's 2,000 Actions minutes a month. *"The following usage remains free independently and does not reduce the included compute usage: … Self-hosted runners"* ([GitHub billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).

## Why

On 20 Nov GitHub stopped starting jobs: the month's 2,000 minutes were used up (PR #202's merge run never started, so `staging` wasn't deployed).

| Measured, 1–20 Nov | Minutes |
|---|---|
| CI on pull requests (70 runs) | 876 |
| CI after merging into `staging` (54 runs) | 655 |
| CI after releases to `main` (5 runs) | 66 |
| Deploys, backup check, others | 64 |
| **Total** (about 2,770 at this pace for a full month) | **1,845 counted; GitHub's own count reached 2,000** |

A run takes 14–18 minutes across its three jobs; almost all of it is the tests themselves, so shorter runs can't close the gap. Reusing the pull request's checks after a merge would save about 350 minutes a month (measured on the 54 merges: 33 would skip), which still leaves about 2,250. W0-02 had planned 4 minutes a run.

## Design (D-119)

**Where each job runs**

| Job | Runs on | Minutes on GitHub |
|---|---|---|
| Format, lint, typecheck, test, build | the PC | none |
| Integration tests (PostgreSQL 17) | the PC | none |
| End-to-end flows (Chromium) | the PC | none |
| Deploy (staging and production, and its after-hours schedule) | GitHub, **or the PC while GitHub's minutes are used up** (a variable, below) | about 4 a deploy |
| Backup check (daily), restore-drill reminder | GitHub | about 25 a month |

**The runner**

| Choice | Why |
|---|---|
| **GitHub's own runner image** (`ghcr.io/actions/actions-runner`, pinned), in **Docker Desktop**, with a small `infra/ci-runner/Dockerfile` that adds what the jobs use and the image lacks: `shellcheck` and the Docker Compose plugin (it already has `python3`, `ssh`, `jq` and `sudo`). Chromium's system libraries are installed by the job's `playwright install --with-deps` as today; the runners are kept between jobs, so only the first run pays for it. | Service containers (`services: postgres`) need a Linux runner with Docker (GitHub docs). Docker Desktop already runs Linux containers here; nothing new to install on Windows. |
| **Three runner containers** (`erp-pc-1` to `3`), so a run's three jobs still run side by side, as they do today. | A run then takes about as long as now (about 6–10 minutes). Docker has 8 of the PC's 16 GB and 8 CPU threads. If the rehearsal shows the PC struggling, two runners: a run then takes longer, nothing else changes. |
| **The Docker socket is shared with the runners** (Docker-outside-of-Docker): service containers and the `docker run` checks start next to the runners, not inside them. | The standard way to run the runner image with services. |
| **The work folder has the same path inside and outside** (`/srv/ci-runner/<runner>/_work`, a bind at an identical path). | "Check edge and app config" runs `docker run -v "$PWD/…"`; with a shared socket, Docker reads that path on the Docker host, so it must be the same path there. |
| **PostgreSQL on a random host port** (`ports: ['5432']`) and `DATABASE_URL` built from `job.services.postgres.ports['5432']`; the host is `host.docker.internal` on the PC and `localhost` on GitHub (`runner.environment`). | Two jobs on one PC can't both take port 5432. The same workflow still works on GitHub's machines (the fallback below). |
| **The runners restart with Docker** (`restart: unless-stopped`) and keep their registration in a volume. Auto-update stays on (GitHub refuses runners more than 63 days behind). | After a reboot or sleep the runners come back on their own. |
| **Labels** `self-hosted`, `linux`, `erp-pc`. | |

**Choosing the runner without editing workflows:** two repository variables (Settings → Secrets and variables → Actions → Variables).

| Variable | Default when not set | Set it to |
|---|---|---|
| `CHECKS_RUNS_ON` | `["self-hosted","erp-pc"]` | `"ubuntu-latest"` to move the checks back to GitHub, for example during a long time away from the PC |
| `DEPLOY_RUNS_ON` | `"ubuntu-latest"` | `["self-hosted","erp-pc"]` while GitHub's minutes are used up; unset it once they reset |

**Setting it up (owner, once)**: `infra/ci-runner/start.ps1`, run by the owner in PowerShell. It asks GitHub for runner registration tokens through the owner's own `gh` sign-in, builds the image, and starts the runners. The tokens go straight from GitHub into the containers; nobody copies or pastes one. `stop.ps1` stops them; `remove.ps1` also unregisters them from GitHub.

## Owner actions

1. Approve this plan, including the deploy choice below.
2. After the PR is merged: run `infra/ci-runner/start.ps1` once (about 5 minutes, mostly building the image). I'll watch the first run with you.
3. Keep Docker Desktop running and the PC awake while pull requests are checked. With Docker Desktop's "Start Docker Desktop when you sign in" setting on, the runners come back by themselves after a reboot.

**Deploy choice (your call):** deploys need the server's deploy key and the Sentry token. On the PC runner those secrets reach the PC for the length of a deploy job. My recommendation: **deploys stay on GitHub, and only while GitHub's minutes are used up (now until about 1 Dec) `DEPLOY_RUNS_ON` sends them to the PC.** Otherwise nothing reaches `staging` until the reset. The deploy key can only run the server's fixed commands (`has`, `load`, `status`, `queue`, `deploy`, `rollback`).

## Scope

1. `infra/ci-runner/`: `Dockerfile`, `entrypoint.sh`, `compose.yaml`, `start.ps1`, `stop.ps1`, `remove.ps1`, `README.md` (what it is, how to start and stop it, the variables, what to do when the PC is off).
2. `.github/workflows/ci.yml`: `runs-on` from `CHECKS_RUNS_ON`; random Postgres ports and `DATABASE_URL` from the service port; `shellcheck` and `compose config` also cover `infra/ci-runner`.
3. `.github/workflows/deploy.yml`: `runs-on` from `DEPLOY_RUNS_ON`, and on the PC a last step that removes the deploy key and the built images. The other scheduled workflows are unchanged.
4. `.github/dependabot.yml`: the `docker` ecosystem for `infra/ci-runner` (keeps the runner image pinned and current).
5. `docs/06-DECISION-LOG.md`: D-119. `docs/02-ARCHITECTURE.md` §9 and the W0-02 plan's minutes risk: one line each.

**Out of scope:** reusing the pull request's checks after a merge (about 350 minutes a month; not needed once the checks are off GitHub); faster integration tests; a runner on a second machine.

## Order

1. **First, prove that GitHub starts jobs on a self-hosted runner while the minutes are used up.** GitHub's docs don't say. One runner by hand from the image and a throwaway workflow on a throwaway branch with a single `echo` job (`runs-on: [self-hosted, erp-pc]`). **If GitHub refuses it, stop here** and come back to you: the choices are then making the repository public or waiting for the reset. The throwaway runner is removed and the branch deleted either way.
2. The image and the three runners; `start.ps1`, `stop.ps1`, `remove.ps1`.
3. `ci.yml` and `deploy.yml`. The plan PR's own CI run is the rehearsal (below).
4. Docs and D-119. PR to `staging`.

## Tests that prove it

- [x] A job on the PC runner starts while GitHub-hosted jobs are blocked (step 1): [run 44790254933](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/actions/runs/44790254933), green in 12 s on `erp-pc-smoke` (Ubuntu 24.04 in Docker Desktop's WSL2).
- [ ] This change's own pull request: all three checks green **on the PC runners** (each job's log names `erp-pc-…`), with run links and times.
- [ ] The edge-config check really reads the files: a deliberately broken Caddyfile on a throwaway commit turns it red (then reverted).
- [ ] Two runs at once (this PR and a throwaway second PR) don't collide: both green, Postgres on different ports.
- [ ] Runners off (`stop.ps1`): a run waits as *Queued*; after `start.ps1` it starts and finishes.
- [ ] A deploy to `staging` from the PC runner (the PR labelled `deploy:staging`, with `DEPLOY_RUNS_ON` set to the PC): healthy, and PR #202's phone fixes visible on staging.
- [ ] `CHECKS_RUNS_ON = "ubuntu-latest"` moves the checks back to GitHub: tested after the minutes reset (about 1 Dec), result added here.
- [ ] Locally: `pnpm check` (format check of the new files) and `shellcheck` unchanged; `docker compose -f infra/ci-runner/compose.yaml config -q`.

## Risks

| Risk | Mitigation |
|---|---|
| **GitHub blocks self-hosted jobs too** while the minutes are used up | Step 1 tests it before anything else is built. |
| **The PC is off, asleep or without Docker** | Jobs wait in the queue for up to 24 hours (GitHub docs), then fail; they start as soon as the runners are back. For a longer absence, `CHECKS_RUNS_ON = "ubuntu-latest"` (uses minutes again). |
| **The PC is busy during a run** (about 5–10 minutes of heavy CPU per run) | Three runners at most; two if it's too much. |
| **Code from a pull request runs on the PC**, and with the Docker socket it can reach what Docker Desktop can, including the PC's drives | The repository is private; pull requests come only from you, me and Dependabot (whose updates `pnpm install` also runs locally). The check jobs get no secrets. Deploy secrets reach the PC only if you choose so above. |
| **Daily backup check and drill reminder** stay blocked until the reset (about 1 Dec) | They need GitHub's minutes (about 25 a month, fine after the reset). Grafana's three backup alerts (WAL not archived, no base backup in 26 hours, status not updated) still run in the meantime. |
| The runner image falls behind | Auto-update stays on; Dependabot bumps the pinned image. |

## Results

| Check | Result |
|---|---|
| Step 1, 20 Nov | GitHub ran a job on a temporary PC runner while its own machines were blocked ([run 44790254933](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/actions/runs/44790254933)). The runner unregistered itself; the throwaway branch was deleted. |
| Probe, 20 Nov | From inside the runner image: Docker works once the runner joins group 0 (the socket's group); a nested `docker run -v` reads a file at an identical path; Postgres on a random port answers at `host.docker.internal`. |
