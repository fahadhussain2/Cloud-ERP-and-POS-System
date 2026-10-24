# Runbook: an error in the apps

**Alerts** (warning, architecture §11.6, D-086):
- *Error in the apps*: the API or the worker logged an error. The Slack message names the service, the environment and the **reference** (request ID) the user saw.
- *An app keeps restarting*: the API or the worker started more than twice in 15 minutes.

## Check

1. **Sentry** (EU, project `erp-server` or `erp-web`): search the reference in the `request_id` tag. It shows the stack trace, the release and the tenant.
2. **The request's logs:** Grafana → Explore → `-logs`:
   ```
   {env="prod"} | json | request_id="<reference>"
   ```
3. **Its trace:** on a log line, open the `trace_id` link to see the request in Tempo: each route step and database query, with timings.
4. Restarts: `{service=~"api|worker", env="prod"} | json | level=~"error|fatal"` around the restarts.

## Fix

- A bug: write a failing test first (CLAUDE.md working rules), fix it, release.
- A release made it worse: `ssh admin@204.168.217.64 sudo erp-deploy rollback prod`.
- An outside cause (database down, disk full): see [site-down.md](site-down.md) and [disk-full.md](disk-full.md).
