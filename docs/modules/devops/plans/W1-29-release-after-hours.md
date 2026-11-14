# W1-29 A release merged in shop hours deploys at 20:05

| | |
|---|---|
| **Issue** | [#173](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/173) |
| **Module** | devops |
| **Status** | Plan: waiting for the owner |
| **Refs** | Architecture §9.1; D-063 (production only outside 10:00–20:00 Karachi), D-075 (images over SSH, `erp-deploy`, health check and rollback), D-080 (the hourly schedule this replaces), D-086 (Grafana alerts), D-087 (no paid services); new **D-115** |
| **Depends on** | W0-04 (deploy pipeline), W0-06 (Grafana alerts, the textfile metrics) |
| **Size** | about 1 day |

## Goal

A release merged into `main` between 10:00 and 20:00 Karachi **deploys at 20:05 the same evening**, with the same migrations, health checks and automatic rollback as every other deploy. Nobody has to watch for it or start it by hand. The "Run workflow" emergency deploy with **force** stays as it is.

## Why: GitHub's schedule doesn't keep time

Today CI defers such a release, and `deploy.yml` waits for its own schedule (`17 15-22 * * *`, every hour from 20:17 to 03:17 Karachi, D-080) to deploy it.

| Finding | Detail |
|---|---|
| **GitHub fires the schedule once or twice a night, hours late** | The 40 scheduled runs from 24 Oct to 14 Nov (`gh run list --workflow deploy.yml --event schedule`): never before 23:26 Karachi, most between 00:30 and 05:00, several after 07:00, the latest at 08:06. Of the eight slots a night, six or seven never run. GitHub documents scheduled runs as best-effort; busy hours are dropped. |
| **14 Nov: PR #172** | Merged 16:22 Karachi and correctly deferred. Still not deployed at 22:46; deployed by hand ("Run workflow") at 22:50. |
| **22 Oct: the first release** | The 22:00 run never came; deployed by hand at 00:39 (W0-04, D-080). |

More slots won't fix it: the slots aren't the problem, GitHub's queue is. The server's own clock is.

## Design (D-115)

**CI does everything it can at merge time; the server's clock does the switch.**

| Step | Who | What |
|---|---|---|
| 1. Merge to `main` in shop hours | CI | Checks, then build the images (or reuse staging's, same tree, D-075) and `ssh erp load` them, exactly as today. |
| 2. Queue | CI → `erp-deploy queue prod <tag>` | Sends the `infra/app` bundle, as `deploy` does. The server unpacks it into `releases/<tag>` and writes `/srv/erp/prod/pending` (tag and time). **Nothing running changes.** The run is green, with *"Queued: production switches at 20:05 Karachi"*. |
| 3. 20:05 Karachi | systemd timer → `erp-deploy release prod` | Migrate → start → health check → roll back on failure: **the same code as `deploy`**, then the **public check** (below), then clear `pending`. |
| 4. Report | Grafana → Slack; GitHub email in the morning | Below. |

**Details**

| Choice | Why |
|---|---|
| **A systemd timer on the server:** `erp-release.timer`, `OnCalendar=*-*-* 20,21,22,23,00,01,02,03:05:00 Asia/Karachi`, `Persistent=true`. It runs `erp-deploy release prod` as `deploy`. Each run exits at once when nothing is waiting. | systemd keeps time to the second and is already how backups run (`erp-db-backup.timer`, 03:00). The hourly retries cover a server that was rebooting at 20:05, a deploy lock held by a "Run workflow", or a queue that arrived just after 20:05 (below). |
| **`release` checks the hours itself:** for `prod`, it does nothing between 10:00 and 20:00 Karachi. | `Persistent=true` starts a missed run at boot, which could be at 11:00. The window then lives on the server for this path, not only in CI. |
| **`deploy` and `release` share one code path.** `deploy` is refactored into *stage* (unpack the bundle) and *activate* (migrate, start, verify, roll back); `release` is *activate* on the queued bundle. | What runs at 20:05 is what every staging deploy has already exercised. |
| **The public HTTPS check moves to the server for `release`:** after the in-container checks, `erp-deploy` asks `https://pos.…` and `https://app.…` (`staging-pos`, `staging-app` for staging) for `/api/health` = the new tag and `/` = 200, 10 tries 3 s apart, as CI does today. **On failure it rolls back** to the previous release. | It covers what CI's check covers: DNS, the certificate, the edge's routes to the new containers. The request leaves through the server's public address and the edge, like a customer's. |
| **Reachability from outside** (Hetzner firewall, routes beyond the server) is left to the **Grafana uptime checks** (`erp-app`, `erp-pos`, every 5 minutes from two European probes), whose *Website or POS down* alert already goes to `#erp-critical`. | A check from the server can't see the server's firewall. The uptime checks already do, all day, for free (D-086). |
| **A bad release isn't retried.** After `release` runs it (deployed, rolled back, migration failed), `pending` is cleared. Only "busy" (the lock) and "shop hours" leave it waiting. | A release that failed at 20:05 would fail again at 21:05, and each try restarts production. |
| **The newest queued release wins.** A second merge in the same day replaces `pending`. A deploy of any tag to prod (a merge outside hours, or "Run workflow") clears `pending`. | `main` only moves forward by releases (D-080), so the newest tree contains every earlier one. Without this, a forced deploy at 17:00 would be downgraded at 20:05 by the release it replaced. |
| **CI asks the clock twice.** At the start (deploy now, or build and queue), and again after the images are on the server: if it's now past 20:00, it deploys right away instead of queuing. | A merge at 19:55 takes about 10 minutes of checks; its queue would arrive after the 20:05 run and wait for 21:05. |
| **`status prod` adds `pending=<tag or none>` and `last=<action> <tag> <result>`** (the newest line of `releases.log`), at the end of the line. | CI's `current=` parsing keeps working, and the morning check (below) reads it. |
| **`prune` keeps the pending release's folder and images.** | A staging deploy's prune must not delete what production deploys tonight. |
| **`release` refuses over SSH;** the deploy key can't start it. `queue` is a new deploy-key command, so the forced-command list grows to `has`, `load`, `status`, `queue`, `deploy`, `rollback`. | The timer is the only caller. A leaked key can at worst queue an image that is already on the server, which it could deploy today. |

**Reporting** (no GitHub run sees the 20:05 deploy)

| Signal | How |
|---|---|
| **Slack, within minutes** (free, D-086) | `erp-deploy` writes `/srv/erp/metrics/release.prom` (node exporter textfile, like `backup.prom`): `erp_release_pending` (0/1), `erp_release_last_timestamp_seconds`, `erp_release_last_ok` (0/1), each labelled `env`. Two new Grafana alerts: **"Release failed or rolled back"** (critical, `#erp-critical` + email) when `erp_release_last_ok == 0`; **"Release still waiting"** (warning, `#erp-alerts`) when a release is pending after 20:30 Karachi. Each with a runbook, `docs/runbooks/release-failed.md`. |
| **GitHub email in the morning** | `deploy.yml`'s `schedule` becomes **one check a day** (`17 3 * * *`, 08:17 Karachi; any delay is harmless) that **never deploys**: it reads `status prod` and fails if a release is still waiting or the last action didn't end `ok`. A red run sends GitHub's failure email, as the backup check does. |
| **The record** | `releases.log` gets `queue <tag> ok` and `release <tag> <result>` lines, next to `deploy` and `rollback`. |

**The emergency path is unchanged:** Actions → Deploy → Run workflow → `prod` + **force** deploys now from `main`, with CI's own internet check and rollback, and clears anything waiting. Without force, during shop hours, "Run workflow" now queues for 20:05 (today it defers to the schedule).

**To stop a waiting release** (found a problem at 18:00): fix forward through `staging` → `main` (the newer release replaces it), or
```bash
ssh admin@204.168.217.64 sudo -u deploy erp-deploy cancel prod
```
which clears `pending` and logs `cancel <tag>`. `cancel` is for admins on the server; the deploy key can't run it.

**Alternatives considered**

| Option | Why not |
|---|---|
| More schedule slots, or `*/10` | GitHub drops runs in busy hours whatever the slot; eight slots already gave one or two runs a night. |
| An external cron (cron-job.org, a Cloudflare Worker) calling `workflow_dispatch` | Needs a GitHub token stored in a third-party service, a new account, and still depends on GitHub's queue. |
| A long GitHub job that sleeps until 20:00 (or an environment wait timer) | Jobs stop after 6 hours, and wait timers on environments need a paid plan for private repositories (D-087). |
| The server calls GitHub at 20:00 to start the workflow | Needs a GitHub token on the server, which D-075 avoided. |
| Deploy everything from the server, even outside hours | Bigger change than needed; CI's immediate deploys and their check from the internet work well. |
| Also keep the old schedule as a backstop deployer | Two things that may switch production, on clocks that disagree, and GitHub's can land after 10:00. One switch (the server) and one report (the morning check). |

## Scope

1. **`infra/server/files/bin/erp-deploy`:**
   - refactor `deploy` into stage + activate (no behaviour change);
   - new `queue <env> <tag>`, `release <env>` (local only, the hours check for prod), `cancel <env>` (local only);
   - the public check and its rollback in `release`;
   - `status` adds `pending=` and `last=`;
   - `deploy` clears `pending`; `prune` keeps the pending tag;
   - writes `release.prom`.
2. **`infra/server/files/systemd/erp-release.service` and `erp-release.timer`** (oneshot as `deploy`, `TimeoutStartSec=20min`).
3. **`infra/server/bootstrap.sh`:** install and enable the timer; create `/srv/erp/metrics/release.prom` writable by `deploy`.
4. **`.github/workflows/deploy.yml`:**
   - in shop hours without force: build and load as now, then queue;
   - ask the clock again before queuing;
   - the internet check only after an immediate deploy;
   - the schedule becomes the 08:17 morning check.
5. **`infra/observability/grafana/alert-rules.json`:** the two alerts. **`docs/runbooks/release-failed.md`.**
6. **Docs:** `infra/README.md` → Deploys (done in this plan's PR), architecture §9.1 (one line: the server switches a waiting release at 20:05), W0-04 plan's risk row about late schedules.

**Out of scope:**
- Moving the shop-hours rule for `deploy` itself onto the server (today the deploy key could deploy at any hour; only CI enforces the window). Worth its own small task.
- Staging's own server (D-063, before the pilot): the timer and the bundle move with `erp-deploy`.
- Different hours per weekday or holidays.

## Order

1. **On the server, by hand:** check that `curl https://pos.zorbixtechnologies.com/api/health` from the server itself reaches the edge (it should; the address is on the server's own interface). If it doesn't, the public check uses `curl --resolve` to the public IP.
2. `erp-deploy` refactor, with `shellcheck`. Deploy a PR to staging (label `deploy:staging`) to prove `deploy` still works unchanged.
3. `queue`, `release`, `cancel`, `status`, `prune`, the metrics file. Rehearse on staging by hand (below).
4. The timer, bootstrap; `infra/server/apply.sh` twice (the second prints `Done: no changes.`).
5. `deploy.yml`; the alerts and runbook; `apply.py`.
6. PR to `staging`. After the owner merges it, the next release merged in shop hours is the real test.

## Tests that prove it

Rehearsed on staging by hand (`sudo -u deploy erp-deploy … staging`), since staging accepts any hour:
- [ ] **Refactor changes nothing:** a labelled PR deploys to staging as before, and a release that fails its health check (as in W0-04 rehearsal A) still rolls back.
- [ ] **Queue changes nothing running:** `queue staging <tag>` → `status` shows `pending=<tag>`, staging still serves the old version, the log has `queue <tag> ok`.
- [ ] **Release switches:** `release staging` → staging serves `<tag>` on both public addresses, `pending=none`, the log has `release <tag> ok`, `erp_release_last_ok 1` in Grafana.
- [ ] **A bad release rolls back once:** queue the unhealthy rehearsal image, `release` → rolled back, `pending=none`, a second `release` does nothing, the critical alert reaches Slack.
- [ ] **Public check failure rolls back:** with the public check pointed at a host that doesn't answer (a test-only override), `release` rolls back and logs `public-check-failed`.
- [ ] **Shop hours:** `release prod` between 10:00 and 20:00 does nothing and says so; `pending` stays.
- [ ] **Newest wins / deploy clears:** queue A then B → `pending=B`; then `deploy` C → `pending=none`.
- [ ] **Prune keeps the pending release** after a staging deploy.
- [ ] **The deploy key** can run `queue` but not `release` or `cancel`.
- [ ] **The timer:** `systemctl list-timers erp-release.timer` shows the next 20:05 Karachi; survives a reboot.

In production:
- [ ] **The next release merged in shop hours:** the run is green with *Queued*; production switches at 20:05–20:10 Karachi; `pos` and `app` serve the tag staging tested; `releases.log` shows `queue` then `release … ok`.
- [ ] **The morning check** is green the morning after. Its few lines of logic are tried in the PR against sample `status` lines (waiting, rolled back, ok), so a red run and its email are known to work.
- [ ] `shellcheck` and the CI checks pass (`pnpm check` for the docs).

## Risks

| Risk | Mitigation |
|---|---|
| A deploy at 20:05 lands during closing (late sales, the cash-desk close) | Counters keep selling offline while the API restarts (under a minute). D-080 already allowed 20:17. If the close needs the server at 20:05, the time is one line in the timer (owner question 1). |
| Nobody is watching at 20:05 | It's the same automatic rollback as every deploy; a failure reaches `#erp-critical` and email within minutes, and the morning check emails again. |
| The server's clock or time zone is wrong | systemd uses `Asia/Karachi` explicitly in `OnCalendar`; the server runs NTP (systemd-timesyncd). `release` checks the hour with `TZ=Asia/Karachi`. |
| The queued bundle or images are deleted before 20:05 | `prune` keeps the pending tag; `release` fails cleanly (and alerts) if the images are missing. |
| A queued release meets a database changed by a later migration | Only one release waits at a time, and it is the newest `main`; migrations are backward-compatible (D-075). |
| The check from the server passes while customers can't reach it | The Grafana uptime checks from Europe alert within 10 minutes (`site-down.md`). |

## Owner questions

1. **Time:** 20:05 Karachi (recommended: the earliest moment after closing, like the window), or later, e.g. 21:00, if the cash-desk close often runs past 20:00?
2. **Stopping a waiting release:** `sudo -u deploy erp-deploy cancel prod` on the server (recommended), or only by fixing forward with a newer release?
3. **Morning check:** in `deploy.yml` at 08:17 (recommended), or added to the 08:00 Backup check?
