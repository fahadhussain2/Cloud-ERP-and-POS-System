# Runbook: backups too old

**Alerts** (critical, architecture §11.6, D-076, D-077):
- *WAL not archived for 15 minutes*: committed changes aren't reaching off-site storage (RPO ≤ 5 min is at risk).
- *No base backup in 26 hours*: the nightly backup (03:00 Karachi) didn't finish.
- *Status not updated for 45 minutes*: `erp-db status` (every 15 minutes) stopped, so backup health is unknown.

Nothing is lost while the server is healthy: WAL waits on the server until it can be archived.

## Check

```bash
ssh admin@204.168.217.64 "sudo erp-db status && sudo cat /srv/erp/prod/backup-status.json"
ssh admin@204.168.217.64 "systemctl list-timers 'erp-db-*' --no-pager"
ssh admin@204.168.217.64 "sudo docker logs --since 2h erp-prod-db 2>&1 | grep -i -E 'archive|pgbackrest' | tail -20"
```

## Fix

| Cause | Action |
|---|---|
| B2's free daily download cap was used up (e.g. a restore drill) | Archiving resumes by itself at 00:00 UTC (05:00 Karachi) (D-077). Don't run another drill today. |
| B2 key revoked or expired | `ssh -t admin@… sudo erp-db secrets` with a new key. |
| A timer stopped | `ssh admin@… sudo systemctl enable --now erp-db-backup.timer erp-db-status.timer`; re-run `infra/db/apply.sh admin@… prod`. |
| The nightly backup failed | `ssh admin@… sudo erp-db backup`, then read its output. |
| Storage near the free 10 GB | Keep fewer monthly fulls (D-087); don't add a card. |

Afterwards the alert resolves by itself within one status run (15 minutes).
