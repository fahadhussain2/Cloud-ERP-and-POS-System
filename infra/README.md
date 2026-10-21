# Infrastructure

Production runs on one Hetzner CX33 (`erp-prod-1`, `204.168.217.64`, Helsinki, Ubuntu 24.04). Everything on it comes from this folder, so the server can be rebuilt from scratch (D-062, D-073, D-074).

| Folder | What |
|---|---|
| `server/` | `bootstrap.sh` sets up the OS (users, SSH, firewall, fail2ban, upgrades, swap, Docker). `apply.sh` runs it over SSH. |
| `server/keys/<user>/*.pub` | **Public** SSH keys per server user. The list is complete: a key deleted here is removed from the server on the next run. |
| `edge/` | The shared Caddy (TLS, headers, static apps, `/api`) for production and staging. `apply.sh` deploys it. |

## Access

| User | Who | Can |
|---|---|---|
| `admin` | The owner and Claude Code (each with its own key) | sudo without a password (there are no passwords) |
| `deploy` | GitHub Actions (key added in W0-04) | Docker only, no sudo |
| `root` | Nobody | SSH login is off |

Log in with `ssh admin@204.168.217.64`. Claude uses `-i ~/.ssh/zorbix_erp_admin`.

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
