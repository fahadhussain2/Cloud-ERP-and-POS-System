# W0-05 Database backups and first restore drill

| | |
|---|---|
| **Issue** | [#6](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/6) |
| **Module** | devops |
| **Status** | Accepted (2026-10-22) |
| **Refs** | PRD §7 (durability); architecture §9, §12; D-029, D-062, D-074, D-075, D-076 |
| **Depends on** | W0-03 (server), W0-04 (deploys) |
| **Size** | about 1.5 days |

## Goal

PostgreSQL runs on the server, and **no committed data can be lost**. Every change is shipped off-site within about a minute, full backups run on a schedule, everything is encrypted, and a restore has been *proven* by doing one. There are no Hetzner backups (D-074), so this must be done before any real data goes onto the server.

## Design (D-076)

| Choice | Why |
|---|---|
| **PostgreSQL 17.9** in its own compose project per environment (`erp-prod-db`, `erp-staging-db`), separate from the app releases | App deploys and rollbacks never restart or touch the database. Database changes are rare and deliberate (`infra/db/apply.sh`). |
| **The database is never published on a port.** Apps reach it over a private Docker network (`erp-<env>-db`); admins use `docker exec … psql` or an SSH tunnel. | Nothing on the internet can even try to connect. |
| **pgBackRest** (a custom image: official `postgres:17.9` + pgBackRest from the PostgreSQL apt repository) | Mature and built for exactly this. It does continuous WAL archiving, full and differential backups, time-based retention, built-in encryption, checksum checks, and `check` / `verify` commands. WAL-G would also work, but pgBackRest's retention and verification are stronger. |
| **Continuous WAL archiving, `archive_timeout = 60 s`** | Committed changes leave the server within about a minute (**RPO ≈ 1 min**, required ≤ 5 min). `wal_recycle = off` and `wal_init_zero = on`, so near-empty WAL files compress to almost nothing. |
| **Schedule** (server clock UTC):<br>• full backup every Sunday at **03:00 Karachi**<br>• differential backup daily at **03:00 Karachi**<br>• monthly full on the 1st at **03:30** | Inside the quiet hours. A restore needs at most one full + one differential + WAL. |
| **Two retention sets in one bucket:**<br>• `repo1`: point-in-time restore to **any moment in the last 30 days**<br>• `repo2`: **12 monthly** backups (restore to the start of each month) | Exactly the PRD requirement (30 days + 12 months), managed by pgBackRest itself. |
| **Encrypted before upload** (AES-256, pgBackRest repo cipher). **The passphrase is generated on the server and shown once to the owner**, who keeps it in a password manager. | The storage provider never sees readable data. Without the passphrase the backups are useless, so the owner's offline copy is essential. |
| **Off-site storage: Backblaze B2, US East** (bucket `zorbix-erp-backups-prod`, endpoint `s3.us-east-005.backblazeb2.com`) | A different company and continent from Hetzner, 10 GB free and then about $6/TB a month. Data is encrypted with our own passphrase before upload, so the region doesn't affect privacy. **Versioning plus a "keep deleted versions for 30 days" rule** means someone who takes over the server still can't really delete the backups. |
| **Staging gets its own database without backups** | Staging data is disposable. W0-07 needs a staging database for its RLS work. |
| **Restore drills go into a throwaway container**, not the staging database. This changes architecture §9 ("into staging"). | A restore of production data must not land in staging, which is less protected. A throwaway container is restored, checked, timed and destroyed. |
| **A canary table, `ops.backup_canary`**: the server adds one row every 5 minutes | Every restore can then show *exactly* how recent the restored data is: the newest canary row is the measured RPO. It also proves the whole chain (write → WAL → off-site → restore) end to end. |
| **Freshness check:**<br>• `erp-deploy backup-status` (read-only)<br>• a **nightly CI job** that fails when the last backup is over 26 h old or the last archived WAL is over 15 min old | Uses the existing deploy key and GitHub's failure emails, with no new account. W0-06 adds the same check as a Grafana alert to Slack within minutes. |
| **A monthly drill reminder:** a scheduled workflow opens a GitHub issue "Monthly restore drill" | D-029 requires a monthly drill, and this makes it hard to forget. |

## Scope

1. **`infra/db/`:**
   - `Dockerfile` (postgres 17.9 + pgBackRest)
   - `compose.yaml` (per environment, with a memory limit)
   - `postgresql.conf` additions: archiving, WAL settings, and memory sized per environment
   - `pgbackrest.conf`: two repos, retention, encryption, compression
   - `apply.sh`: build, start, create the stanza, install the timers
2. **Secrets on the server only,** in `/srv/erp/prod/db.env`, mode 600, owner root:
   - the PostgreSQL superuser password (generated)
   - the B2 key, typed by the owner through `sudo erp-db-secrets`, a hidden prompt; I never see it
   - the backup passphrase (generated and shown once)
3. **systemd timers** for the full, differential, monthly and canary jobs, plus a 15-minute local status file for W0-06.
4. **`erp-deploy backup-status <env>`** (read-only), and a **nightly CI workflow** that fails on stale backups.
5. **`infra/db/restore-drill.sh`:** restore the latest backup, or a point in time, into a throwaway container; check the canary and `pg_amcheck`; print the timings; then destroy the container.
6. **App compose joins `erp-<env>-db`**, so W0-07 only has to add `DATABASE_URL`.
7. **Docs:**
   - `infra/README.md`: backups, restore, drills
   - `docs/modules/devops/restore-drills.md`: the drill log
   - **architecture §9:** drills go into a throwaway container
8. **Monthly drill reminder workflow.**

**Out of scope:**
- Application tables, roles and RLS (W0-07)
- Slack and Grafana alerts (W0-06)
- Standby replicas or high availability (not needed at this scale)

## Order

1. **Owner:** create the B2 bucket and key (steps below).
2. I build the image and start `erp-staging-db` first, to check the setup with no backups.
3. Start `erp-prod-db`. **You enter the B2 key** through the hidden prompt. Create the stanza, run `pgbackrest check`, then the first full backup. **You save the passphrase.**
4. Canary and timers; status verb and nightly check.
5. **First restore drill** (latest backup), then a **point-in-time drill**. Timed and logged.

## Tests that prove it

- [ ] `pgbackrest check` passes: WAL archiving works end to end.
- [ ] `pgbackrest info` shows the first full backup in both repos, and the archived WAL reaches the present.
- [ ] A canary row reaches off-site storage within about 2 minutes (it shows up in the archived WAL range).
- [ ] **Encrypted:** a file downloaded from the bucket is unreadable (it starts with `Salted__`, not PostgreSQL data).
- [ ] **No public port:** the external scan still finds only 22, 80 and 443, and `ss -tlnp` shows no 5432 on the host.
- [ ] **Restore drill, latest:**
  - a throwaway container restores the latest backup and starts
  - `pg_amcheck` is clean
  - the newest canary row is ≤ 5 minutes before the drill started (**measured RPO**)
  - the total time is recorded (**measured RTO**)
- [ ] **Point-in-time drill:** restored to a chosen moment, the canary has rows up to that moment and none after it.
- [ ] Timers are active, and their next runs show 03:00 / 03:30 Karachi.
- [ ] **The nightly freshness check is green**, and turns red when run with a zero-minute threshold (proves it can fail).
- [ ] **Apps deploy fine** with the new database network attached.
- [ ] No secret in git (the guard hook plus a search for the B2 key's ID prefix).

## Risks

| Risk | Mitigation |
|---|---|
| **The passphrase is lost**, so the backups can't be decrypted | It's shown once to the owner, who stores it in a password manager **and** on paper in a safe place. Each drill uses the server's copy and confirms it still decrypts. |
| Someone who takes over the server deletes the backups | The B2 key is limited to one bucket; versioning plus "keep deleted versions 30 days" means deletes can be undone for 30 days. |
| The disk fills with WAL if B2 is unreachable | PostgreSQL keeps WAL until it's archived. The 15-minute WAL check catches it early, and the disk has 70 GB free. |
| The drill uses only synthetic data (there's no real data yet) | The drill is repeated before the first migration rehearsal (W0-13) and before the pilot, with real data. |
| B2 costs grow | The data is small (well under 10 GB in year 1); usage is checked monthly. |

## Owner actions

1. **Create the off-site storage** (Backblaze B2 recommended):
   - an account at backblaze.com (created in region **US East**)
   - a **private** bucket `zorbix-erp-backups-prod`
   - Lifecycle: "Keep prior versions for **30** days"
   - an **application key** limited to that bucket, with read and write
2. **Enter the key** in the hidden prompt on the server (one command, which I'll give you).
3. **Save the backup passphrase** when it's shown, in a password manager and on paper.

## Owner answers (2026-10-22)

- **Storage: Backblaze B2.** The account was created in **US East**, not EU Central, and the owner chose to keep it. Backups are encrypted before upload, the database is small, and nothing requires EU storage today. Done: bucket `zorbix-erp-backups-prod` (private, default encryption on, 30-day lifecycle for prior versions) and an application key limited to that bucket.
