# Runbook: disk over 85% full

**Alert:** *Disk over 85% full* (critical, architecture §11.6). At 100% PostgreSQL stops accepting writes, so act early.

## Check

```bash
ssh admin@204.168.217.64 "df -h / && sudo du -xh --max-depth=1 /var/lib/docker /srv/erp 2>/dev/null | sort -h | tail -15"
ssh admin@204.168.217.64 "sudo docker system df"
```

## Fix

| What grew | Action |
|---|---|
| Old images (each deploy loads three) | `erp-deploy` keeps 5 releases per environment; remove the rest with `sudo docker image prune -a --filter until=168h`. Never remove images of the current or previous release. |
| WAL waiting to be archived (archiving is failing) | Fix archiving first: [backup-too-old.md](backup-too-old.md). Never delete files in the database volume. |
| Container logs | Docker rotates them (10 MB × 3 per container); a huge one means an app is logging in a loop: find it in Grafana and fix the cause. |
| The database itself | Check the *System* dashboard's database size; plan a bigger server (a Hetzner rescale keeps the disk). |
