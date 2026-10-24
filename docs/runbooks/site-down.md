# Runbook: website or POS down

**Alert:** *Website or POS down* (critical) or *TLS certificate expires within 14 days* (warning). Architecture §11.6, D-086.

**What it means:** Grafana's uptime checks (every 5 minutes, two places in Europe) failed to get `200` from `https://app.zorbixtechnologies.com/api/health` or `https://pos.zorbixtechnologies.com/api/health` for most of the last 10 minutes. Counters keep selling offline; bills sync when the site is back.

## Check

1. Open the URL in a browser. If it loads, the problem was short or regional; watch the next checks.
2. Is the server up? `ssh admin@204.168.217.64 uptime`
3. Containers: `ssh admin@204.168.217.64 sudo erp-deploy status prod` and `sudo docker ps`
4. The *System* dashboard (Grafana → Dashboards → ERP → System): CPU, memory, disk, API errors.
5. Logs: Grafana → Explore → `-logs` → `{env="prod"} | json | level=~"error|fatal"`, and Caddy: `{service="caddy"}`.

## Fix

| Cause | Action |
|---|---|
| A container stopped or keeps restarting | `ssh admin@… sudo erp-deploy rollback prod` (back to the previous release), then look at the logs. |
| The database is down | `ssh admin@… sudo docker ps -a --filter name=erp-prod-db`; start it with `infra/db/apply.sh admin@… prod`. |
| Disk full | See [disk-full.md](disk-full.md). |
| Certificate | Caddy renews automatically; check `{service="caddy"} |= "certificate"` in Explore. DNS must still point at the server. |
| The server is gone | Rebuild: `infra/README.md` → Rebuild from scratch, then restore the database (W0-05). |
