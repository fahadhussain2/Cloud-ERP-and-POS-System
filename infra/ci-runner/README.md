# CI runners on the owner's PC (D-119)

The three CI checks (format, lint, typecheck, tests, build; integration; end-to-end) run on one runner in Docker
Desktop on the owner's PC, `erp-pc-1`; the jobs take turns (about 15 minutes a run). Self-hosted runners are free and don't use the free plan's 2,000
Actions minutes a month, which ran out on 20 Nov 2026. Plan: [ci-runner-on-pc](../../docs/modules/devops/plans/ci-runner-on-pc.md).

| Task | How (PowerShell, from this folder) |
|---|---|
| Start (first time, or after `remove.ps1` or a new image) | `./start.ps1`: asks GitHub for a registration token with your `gh` sign-in, builds the image, starts the runners |
| Stop for a while | `./stop.ps1`. Jobs wait in GitHub's queue for up to 24 hours and start when the runners are back |
| Remove completely | `./remove.ps1`: deletes the containers and unregisters the runners |
| See them | GitHub → Settings → Actions → Runners, or `docker compose ps` |

**After a reboot** the runners come back by themselves once Docker Desktop is running (its "Start Docker Desktop when you
sign in" setting). Each keeps its registration; no new token is needed.

**Where jobs run**: two repository variables (Settings → Secrets and variables → Actions → Variables).

| Variable | Not set | Set to |
|---|---|---|
| `CHECKS_RUNS_ON` | the PC's runners | `"ubuntu-latest"`: the checks run on GitHub's machines (uses minutes), e.g. while the PC is away |
| `DEPLOY_RUNS_ON` | GitHub's machines | `["self-hosted","erp-pc"]`: deploys run on the PC, while GitHub's minutes are used up |

**How it works**

- GitHub's runner image (`ghcr.io/actions/actions-runner`) plus `shellcheck`, `docker compose` and pnpm at the
  repository's version (`Dockerfile`; `start.ps1` reads it from `package.json`). On the PC the jobs skip pnpm's setup
  action and GitHub's dependency cache: pnpm's store stays in the runner between jobs, so the shop's slow connection
  downloads each package once. **After changing `packageManager`, run `start.ps1` again.**
  Dependabot bumps the image monthly; the runner also updates itself.
- The runners share Docker Desktop's socket, so `docker run` starts containers next to them. The runner refuses
  `services:` inside a container, so each job starts its own PostgreSQL (`.github/actions/postgres`) on a random port,
  reached at `host.docker.internal`.
- Each runner's work folder (`/srv/ci-runner/<name>/_work`) has the same path inside the runner and on the Docker host,
  so `docker run -v "$PWD/…"` in a job finds its files.
- The check jobs get no secrets. A deploy on the PC removes its key and images when it ends.
