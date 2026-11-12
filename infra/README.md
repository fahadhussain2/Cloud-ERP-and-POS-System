# Infrastructure

Production runs on one Hetzner CX33 (`erp-prod-1`, `204.168.217.64`, Helsinki, Ubuntu 24.04). Everything on it comes from this folder, so the server can be rebuilt from scratch (D-062, D-073, D-074).

| Folder | What |
|---|---|
| `server/` | `bootstrap.sh` sets up the OS (users, SSH, firewall, fail2ban, upgrades, swap, Docker). `apply.sh` runs it over SSH. |
| `server/keys/<user>/*.pub` | **Public** SSH keys per server user. The list is complete: a key deleted here is removed from the server on the next run. |
| `edge/` | The shared Caddy (TLS, headers) for production and staging. It routes each site to its environment's `web` and `api` containers. `apply.sh` deploys it. |
| `app/` | One release of the apps (`api`, `worker`, `web`) for one environment: `compose.yaml` plus non-secret settings per environment. Deployed by `erp-deploy`. |
| `server/files/bin/erp-deploy` | The only program the GitHub deploy key may run on the server (D-075). |
| `db/` | PostgreSQL + pgBackRest per environment: image, config, `apply.sh`, `erp-db` (backups, canary, status, secrets, restore drills), systemd timers (D-076). `erp-tenant` and the tenant specs in `db/tenants/` (D-083). |
| `counter-setup.md` | Setting up a counter PC in the shop: enroll, install the POS, keep the browser from deleting unsynced bills (D-089). |

## Access

| User | Who | Can |
|---|---|---|
| `admin` | The owner and Claude Code (each with its own key) | sudo without a password (there are no passwords) |
| `deploy` | GitHub Actions | Only `erp-deploy` (`has`, `load`, `status`, `deploy`, `rollback`): no shell, no other command |
| `root` | Nobody | SSH login is off |

Log in with `ssh admin@204.168.217.64`. Claude uses `-i ~/.ssh/zorbix_erp_admin`.

## Deploys (D-063, D-075)

| What | How |
|---|---|
| **Staging** | Merge into `staging`. CI checks, then deploys automatically. |
| **Try a pull request on staging** | Add the label **`deploy:staging`** to the PR. Each new push to it redeploys. The next merge into `staging` puts staging back. |
| **Production** | Merge `staging` → `main` (the release). It deploys right away outside 10:00–20:00 Karachi; otherwise it is deferred to the next **hourly scheduled run (:17 past each hour, 20:17 to 03:17 Karachi)**. |
| **Production emergency** | Actions → **Deploy** → Run workflow → `prod`, tick **force**. Works only from `main`. |
| **Roll back** | Revert the merge on the branch, which deploys the previous code. A failed deploy rolls itself back automatically. |

Each deploy, on the server:
1. Load images (skipped when the tree was already built, e.g. tested on staging).
2. Run migrations. If they fail, it stops; the old version keeps running.
3. Start the new version and check that `/api/health` returns its version, both apps load, and the worker stays up.
4. If unhealthy, start the previous release again and fail the run.

Then CI checks the public HTTPS addresses as well, and rolls back if they fail.

**Migrations must work with the previous release too** (`REVIEW.md`): a rollback switches the code, not the database.

**What runs where:**
```bash
ssh admin@204.168.217.64 cat /srv/erp/prod/releases.log
```
```bash
ssh admin@204.168.217.64 sudo docker ps
```

**Secrets for an environment** go in `/srv/erp/<env>/app.env` on the server (mode 600, owner `deploy`). Never in git.

## Database and backups (D-076, D-077)

Each environment has its own PostgreSQL 17.9 container (`erp-prod-db`, `erp-staging-db`), set up by `infra/db/apply.sh`. App deploys never touch it.
- **No public port.** Apps reach the database on the internal network `erp-<env>-db`.
- **Admins** use:
  ```bash
  ssh admin@204.168.217.64 sudo docker exec -it -u postgres erp-prod-db psql -d erp
  ```

**Production backups** (pgBackRest → Backblaze B2 `zorbix-erp-backups-prod`, encrypted; staging has none):

| What | When |
|---|---|
| WAL (every committed change) | Off-site within 5 minutes |
| Full backup | 1st of each month, 03:00 Karachi; 12 kept |
| Differential backup | Every other night, 03:00 Karachi |
| Restore possible to | Any moment in the last 30+ days, or the start of any of the last 12 months |
| Canary row (`ops.backup_canary`) | Every minute: keeps WAL flowing and measures data loss in drills |
| Status file `/srv/erp/prod/backup-status.json` | Every 15 minutes; checked nightly by CI (`Backup check` workflow) |

B2 is on the free tier with hard daily caps (D-077):
- **Run at most one restore drill a day.**
- If B2 refuses with "cap exceeded", archiving pauses until 00:00 UTC (05:00 Karachi) and then catches up by itself. WAL waits safely on the server meanwhile.

**Secrets** live in `/srv/erp/prod/db-secrets/`: the B2 key, the backup passphrase, and the database superuser password. Never in git.
- To change the B2 key (the passphrase is kept):
  ```bash
  ssh -t admin@204.168.217.64 sudo erp-db secrets
  ```
- The **backup passphrase** is kept offline by the owner. Without it, no backup can be decrypted.

**Restore drill** (monthly; a GitHub issue reminds you on the 2nd):
```bash
ssh admin@204.168.217.64 sudo erp-db restore-drill
```
```bash
ssh admin@204.168.217.64 "sudo erp-db restore-drill --time '2026-10-22 10:15:00+00'"
```
Each drill restores into a throwaway container, runs `pg_amcheck`, reports the restore time and data loss, then deletes everything. Log the result in `docs/modules/devops/restore-drills.md`.

**Real disaster (the server is lost):**
1. Rebuild the server (see "Rebuild from scratch").
2. Restore the secrets: run `erp-db secrets` with the B2 key, and put the saved passphrase into `/srv/erp/prod/db-secrets/pgbackrest.conf` as `repo1-cipher-pass=…`.
3. Restore: `pgbackrest --stanza=erp --repo=1 --process-max=16 restore` into an empty `erp-prod-pgdata` volume, then start with `infra/db/apply.sh … prod`.
4. Deploy the apps.

**Check backups by hand:**
```bash
ssh admin@204.168.217.64 "sudo erp-db status && sudo cat /srv/erp/prod/backup-status.json"
```

## Observability (D-064, D-086)

Errors go to **Sentry** (EU; projects `erp-server` and `erp-web`), logs, metrics and traces to **Grafana Cloud** (EU) through **Grafana Alloy** on the server (`observability/`), and alerts to Slack (`#erp-critical` with an email copy, `#erp-alerts`). All on free plans (D-087).

**Set up or update Alloy** (creates the `erp-otel` network and the read-only `erp_monitor` database role):
```bash
infra/observability/apply.sh admin@204.168.217.64
ssh -t admin@204.168.217.64 sudo erp-obs secrets    # once: Grafana Cloud details and the Sentry DSN (hidden)
ssh admin@204.168.217.64 sudo erp-obs status
```

**Dashboard and alert rules** (`observability/dashboards/`, `observability/grafana/alert-rules.json`): edit the files, then apply them with a Grafana service-account token (typed at a hidden prompt):
```bash
python infra/observability/grafana/apply.py
```

**Uptime checks** (Grafana → Testing & synthetics → Synthetics → Checks; created by hand, the API needs another token): two HTTP checks every 5 minutes from two European probes, with the default status-200 and certificate checks. **The job names must be exactly these**, because the *Website or POS down* alert looks for them; without the checks it fires on missing data.

| Job name | Target |
|---|---|
| `erp-app` | `https://app.zorbixtechnologies.com/api/health` |
| `erp-pos` | `https://pos.zorbixtechnologies.com/api/health` |

Staging isn't checked: its deploys health-check themselves.

**Finding things:** every error response has a `reference` (the request ID).
- In Sentry, search the `request_id` tag.
- In Grafana → Explore → the `-logs` data source: `{env="prod"} | json | request_id="<reference>"`. The line's `trace_id` opens the request's trace.
- The *System* dashboard: Dashboards → ERP → System.
- Each alert links to its runbook in `docs/runbooks/`.

## Tenants (D-083)

A shop is described by a reviewed spec in `db/tenants/<name>.json` (settings, branch, locations, banks, payment methods, tiers, print profile, the owner's username; no secrets). `infra/db/apply.sh` copies the specs to `/srv/erp/tenants/` and installs `erp-tenant`. It runs the API image of the environment's current release, so deploy first.

**Create a shop (or complete it).** The owner chooses the password at a hidden prompt; nobody else sees it:
```bash
ssh -t admin@204.168.217.64 sudo erp-tenant setup prod delux
```
It prints what it created, any **drift** (spec values that differ from the database; never applied) and what **needs attention** (e.g. a payment method without a bank account). A second run prints `no changes`. To change a live shop, use the back office (or a migration), not the spec.

**A test shop** with a generated password, shown once, that must be changed at the first login:
```bash
ssh admin@204.168.217.64 sudo erp-tenant setup staging demo --generated
```

**A test catalog on staging** (W1-21): about 20,000 generated items in Delux's shape, on a staging shop with no items yet. Never real data (D-076); refused for prod:
```bash
ssh admin@204.168.217.64 sudo erp-tenant seed-catalog staging demo
```
An optional last argument sets the number of items (up to 50,000). Real searches are checked locally on `erp_dev`.

**Forgotten password** (support): sets a generated temporary password that must be changed, lifts a lockout and ends the user's sessions. Give the password to the user in person or by phone:
```bash
ssh admin@204.168.217.64 sudo erp-tenant reset-password prod delux fahad
```

**A new shop:** copy `db/tenants/demo.json`, change it, open a PR, then run `infra/db/apply.sh` for each environment and `erp-tenant setup` (staging first).

## Common tasks

Run these from the repo root in Git Bash.

**Apply server changes** (after editing `server/`):
```bash
infra/server/apply.sh admin@204.168.217.64
```
A second run must print `Done: no changes.`

**Add or revoke a key:** add or delete the `.pub` file in `server/keys/<user>/`, commit, then apply.

**Install pending upgrades now** (security upgrades also install themselves at 04:00 Karachi time):
```bash
infra/server/apply.sh admin@204.168.217.64 --upgrade
```

**Update the edge (Caddy):**
```bash
infra/edge/apply.sh admin@204.168.217.64
```

**Check fail2ban:**
```bash
ssh admin@204.168.217.64 sudo fail2ban-client status sshd
```

**Unban an IP:**
```bash
ssh admin@204.168.217.64 sudo fail2ban-client set sshd unbanip <ip>
```

**Reboot safely:** only outside shop hours (10:00–20:00 Karachi). Counters keep selling offline. Caddy and, later, the apps restart by themselves.

## Rebuild from scratch

1. Hetzner console: **Rebuild** with Ubuntu 24.04, keeping the IP. Make sure the project SSH key "Fahad PC" is selected; if root has no key afterwards, use **Rescue** to add one.
2. Clear the old host key:
   ```bash
   ssh-keygen -R 204.168.217.64
   ```
3. First run as root, leaving SSH open:
   ```bash
   infra/server/apply.sh root@204.168.217.64
   ```
4. Test `ssh admin@204.168.217.64` **in a second window**, then lock SSH:
   ```bash
   infra/server/apply.sh admin@204.168.217.64 --lock-ssh
   ```
5. Deploy the edge, then the apps (W0-04), then restore the database from the off-site backup (W0-05).

## Firewalls

Both allow only 22/tcp, 80/tcp, 443/tcp and 443/udp, for IPv4 and IPv6:
- **Hetzner Cloud Firewall `erp-prod`:** outside the server, set in the console. It is free.
- **ufw:** on the server, set by `bootstrap.sh`.

Docker publishes ports past ufw, so the Hetzner firewall is the one that really protects the server. Only Caddy publishes ports; PostgreSQL never does.

## Without Hetzner backups (D-074)

The server holds no data that isn't in git, until the database arrives. **Off-site database backups (W0-05) must be running, and a restore tested, before any real data goes onto the server.**
