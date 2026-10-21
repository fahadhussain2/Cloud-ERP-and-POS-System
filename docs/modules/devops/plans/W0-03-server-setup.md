# W0-03 Server setup and hardening (Hetzner CX33)

| | |
|---|---|
| **Issue** | [#4](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/4) |
| **Module** | devops |
| **Status** | Accepted (2026-10-21) |
| **Refs** | Architecture §6.5, §9, §9.0; D-029, D-062, D-063, D-065, D-073, D-074 |
| **Depends on** | W0-02 (CI checks the server config) |
| **Size** | about 1 day, plus waiting for DNS |

## Goal

A secure, reproducible production server that serves HTTPS on the four app addresses, ready for the first deploy in W0-04. Every setting lives in git, so the server can be rebuilt from scratch (or moved to the UAE later) by running one script.

## Design (D-073)

| Choice | Why |
|---|---|
| **Ubuntu 24.04 LTS** (Hetzner image) | Supported until 2029, and the default for Docker and Hetzner. |
| **Server setup is one idempotent script in git:** `infra/server/bootstrap.sh`, run over SSH. Re-running it changes nothing. | Reviewable and repeatable. Ansible would be overkill for one server and awkward to run from Windows; cloud-init only runs when a server is created. |
| **Two layers of firewall:** the **Hetzner Cloud Firewall** (outside the server) allows only 22, 80 and 443, and **ufw** on the server does the same | Docker writes its own iptables rules and **bypasses ufw** for published ports. The Hetzner firewall blocks everything else whatever Docker does. |
| **SSH: keys only, no root login, no passwords, fail2ban.** SSH stays reachable from any IP. | The architecture says "SSH from allowed IPs", but your home or office IP is probably dynamic, and GitHub Actions deploys come from many IPs. With keys only, password guessing is useless. **Revisit:** a private network such as Tailscale for SSH, once there are several admins. |
| **Users:** `admin` (you, with sudo; also used by Claude through its own key) and `deploy` (no sudo; runs Docker for GitHub Actions in W0-04) | Separate keys can be revoked separately. Note: Docker access is close to root access, which is why `deploy` gets its own key that is never used for anything else. |
| **One shared Caddy ("edge") in its own compose project**, serving production and staging. Production and staging apps get their own compose projects in W0-04. | One process owns ports 80/443 and the certificates. Staging can start and stop without touching production. |
| **Caddy security headers:** HSTS (without `includeSubDomains`, so the marketing site is unaffected), `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'`; `X-Robots-Tag: noindex` on staging | A safe baseline from day one. |
| **Unattended security upgrades** with an automatic reboot if needed at **04:30 Karachi time** (23:30 UTC) | After the 04:00 business-date cutoff and long after closing. Counters keep selling offline even if the server is briefly down. |
| **2 GB swap file, Docker log rotation** (10 MB × 3 per container), server clock in **UTC** | Prevents the out-of-memory killer from hitting PostgreSQL and logs from filling the disk. The apps use the tenant's timezone, not the server's. |

## Scope

1. **`infra/server/`:**
   - `bootstrap.sh` creates the users and installs their public keys, applies the SSH hardening, ufw, fail2ban, unattended upgrades, swap, timezone, Docker Engine + Compose (from Docker's apt repository) and the Docker daemon settings.
   - Config files live next to it: `sshd_config.d/`, `fail2ban/`, `apt/`, `docker/daemon.json`.
   - **Public keys only**, in `infra/server/keys/*.pub`. Private keys never enter the repo; the guard hook blocks them.
2. **`infra/edge/`:** `compose.yaml` and `Caddyfile` for the four sites, with a placeholder page each and `/api/*` already routed to a future upstream (it returns 503 until W0-04).
3. **CI:** add `shellcheck` on `infra/**/*.sh`, and `caddy validate` + `docker compose config` on `infra/edge`, to the `check` job.
4. **`infra/README.md`:** a runbook covering how to run the bootstrap, add or revoke a key, check fail2ban, reboot safely, and rebuild the server from scratch.
5. **Hetzner console (owner):** **Rebuild** the server to Ubuntu 24.04 (the old app is not needed; the IP stays the same), then create the Cloud Firewall and attach it. **No Hetzner snapshots or backups (D-074).**
6. **DNS (owner, in Hostinger):** A records for `pos`, `app`, `staging-pos` and `staging-app` → `204.168.217.64`, with TTL 300.

**Out of scope:**
- App containers and deploys (W0-04)
- PostgreSQL and backups (W0-05, W0-07)
- Monitoring agents (W0-06)
- The staging CX23 (before the pilot)

## Order

1. **Owner:** add the DNS records in Hostinger and rebuild the server to Ubuntu 24.04. DNS needs time to spread, so this goes first.
2. I write the scripts and configs on a branch, and CI validates them (shellcheck, caddy validate).
3. **First run as `root`** with your existing key: create `admin`, check that I can log in as `admin` **in a second session**, and only then turn off root login and passwords. This order means a mistake can't lock us out.
4. Create the Cloud Firewall and attach it (owner, or me guiding you).
5. Start the edge compose project. Caddy gets certificates once DNS resolves.
6. Run the checks below, reboot once, and run them again.

## Tests that prove it

- [ ] **From outside:** only 22, 80 and 443 answer. A scan of 1–1024 plus 2375/2376 (Docker API), 3000 and 5432 finds nothing else.
- [ ] `ssh root@…` is refused, and an SSH login with a password is refused (`Permission denied (publickey)`).
- [ ] All four addresses serve HTTPS with a valid Let's Encrypt certificate. HTTP redirects to HTTPS, and the security headers are present (`curl -I` output in the PR).
- [ ] `/api/health` returns 503 for now. This proves the route exists before the app does.
- [ ] Re-running `bootstrap.sh` reports no changes.
- [ ] `fail2ban-client status sshd` is active, and an `unattended-upgrade --dry-run` succeeds.
- [ ] **After a reboot,** Caddy comes back on its own and all four sites serve again.
- [ ] The Hetzner Cloud Firewall is attached (owner confirms with a screenshot).

## Risks

| Risk | Mitigation |
|---|---|
| Locking ourselves out of SSH | `admin` login is tested in a second session before root and password login are turned off. Hetzner's web console works even without SSH. In the worst case the server is rebuilt and the script re-run, because it holds no data yet. |
| Docker bypasses ufw | The Hetzner Cloud Firewall blocks it anyway; only Caddy publishes ports; PostgreSQL is never published. |
| Let's Encrypt rate limits while DNS isn't ready | Caddy waits for DNS and retries; the first attempts use Let's Encrypt's staging CA. |
| No Hetzner backups (D-074) | The server holds no data until W0-05, and its setup is rebuildable from git. **W0-05 (off-site backups) must be finished before any real data goes onto the server.** |

## Owner answers (2026-10-21)

1. The old app on the server is not needed: **clean rebuild** to Ubuntu 24.04.
2. DNS for `zorbixtechnologies.com` is managed in **Hostinger**.
3. The owner logs in today as **root with an SSH key**. Claude gets its own key (`~/.ssh/zorbix_erp_admin` on the dev PC), and the owner adds its public key.
4. The server is renamed to **erp-prod-1**.
5. **No Hetzner snapshots or backups**, to save cost (D-074).
