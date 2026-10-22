# Restore drills

One entry per drill (D-029, D-076). Run with `sudo erp-db restore-drill [--time '<ts>']` on the server; see `infra/README.md` → Database and backups.

| Date (UTC) | Target | Backup used | Restore (download) | Recovery + start | Total (RTO) | `pg_amcheck` | Data loss (RPO) | Notes |
|---|---|---|---|---|---|---|---|---|
| 2026-10-22 12:35 | latest | full `20261022-123310F` | 102 s | 7 s | 109 s | clean | not measured | First drill. Synthetic data only (canary). The RPO measure was wrong (compared with the drill start) and was fixed. |
| 2026-10-22 12:38 | latest | full `20261022-123310F` | 98 s | 9 s | 107 s | clean | 78 s | Restore time went to B2 retries: the free daily download cap was being hit (D-077). |
