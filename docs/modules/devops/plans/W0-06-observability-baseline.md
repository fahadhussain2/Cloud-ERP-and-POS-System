# W0-06 Observability baseline: logs, errors, metrics, uptime and alerts

| | |
|---|---|
| **Issue** | [#7](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/7) |
| **Module** | devops |
| **Status** | Done (2026-10-24) |
| **Refs** | Architecture §11; D-064 (amended by D-086), D-087; CLAUDE.md rule 11 |
| **Depends on** | W0-03 (server), W0-04 (deploys), W0-05 (backup status) |
| **Size** | about 3 days |
| **Test-first** | Yes for the logger (redaction, correlation IDs) and the error reference |

## Goal

**When something goes wrong, we see it without SSH-ing into the server**: the error with its request ID in Sentry, an alert in Slack, the logs of that request in Grafana, and the server's health on one *System* dashboard. Everything on free plans, **no card needed**.

## Design (D-086: amends D-064)

| Choice | Why |
|---|---|
| **Logs:** `pino` JSON on stdout from every app, through `packages/observability`: each line carries `app`, `env`, `version`, and from the request context `request_id`, `trace_id`, `tenant_id`, `user_id`, `device_id`. A **redaction list** (passwords, PINs, verifiers, tokens, cookies, authorization headers, keys) is applied to every line, with a CI test. | Architecture §11.2, §11.7. Context comes from one place (AsyncLocalStorage), so no call site can forget it. |
| **Every API response has an `x-request-id`** (UUIDv7, or the caller's if valid), and every error body carries it as `reference`. | "Reference: 0193…" in an error message finds the logs, the trace and the Sentry event. |
| **Errors: Sentry** (free Developer plan, **EU region**): two projects, `erp-server` (API and worker) and `erp-web` (POS and back office), tagged by app, env, release and request ID. Sentry's own alerts are **email** (the free plan has no Slack). Browser source maps are uploaded from CI. | Two projects keep the setup small; tags separate the apps. |
| **Logs, metrics, traces: Grafana Cloud** (free tier, **EU region**: 50 GB logs, 10k metric series, 50 GB traces, 14 days), fed by **Grafana Alloy** on the server: container logs, server metrics, PostgreSQL metrics, and OpenTelemetry from the apps. | As D-064. Alloy reads Docker's log files and needs **no Docker socket** (that would be root on the server); compose adds the service name to each log line. |
| **Uptime: Grafana Synthetic Monitoring** instead of UptimeRobot: HTTPS checks of `app` and `pos` health (two probe locations) and staging (one), every 5 minutes, with certificate expiry. | UptimeRobot's free plan is non-commercial only and has no SSL monitoring; Grafana's free tier includes 100k checks a month (these use about 50k), and alerts go through the same rules. |
| **Alerts: Grafana → Slack**, `#erp-critical` (+ an **email** copy) and `#erp-alerts`. The first rules: site down, backup too old, disk > 85%, a container restarting, any error log line (with its request ID). | One alerting place, free. Sentry adds email for new error types. |
| **Backup age as a metric:** `erp-db status` also writes a Prometheus text file that Alloy reads. | The *System* dashboard and the "backup too old" alert use the same numbers as the nightly check (W0-05). |
| **Secrets** (Grafana token, Sentry DSNs) are typed by you at a hidden prompt on the server (`sudo erp-obs secrets`), like the backup secrets. | Nobody else sees them; nothing in git. |

## Scope

1. **`packages/observability`:** `createLogger`, the request context (`withContext`, `setContext`), redaction, `initSentry` (server), `initTracing` (OpenTelemetry SDK, OTLP to Alloy).
2. **`apps/api`:** the logger instance for Fastify; request ID header and `reference` in error bodies; tenant/user/device added to the context by the auth hooks; Sentry on unhandled errors; OpenTelemetry (`@fastify/otel` for requests, `pg` for queries); a **staging-only** `POST /api/_test/error` for the acceptance test.
3. **`apps/worker`:** the logger, Sentry, tracing.
4. **`apps/pos`, `apps/backoffice`:** `@sentry/react` with the release, and source-map upload in CI (when the token secret is set).
5. **Server (`infra/observability/`):** the Alloy container and config (Docker log files, node metrics, PostgreSQL exporter for prod and staging with a read-only `erp_monitor` role, `pg_stat_statements`, OTLP receiver); `erp-obs` (`secrets`, `status`); compose logging labels; the backup-age text file. `alloy fmt` runs in CI.
6. **Grafana (described in the repo, set up once):** the *System* dashboard as JSON in `infra/observability/dashboards/`, the alert rules and the synthetic checks, applied with a script and your token.
7. **Docs:** infra README (where to look, how to add an alert), the first runbooks (`docs/runbooks/`: site down, backup too old, disk full), architecture §11 updated for D-086.

**Out of scope:**
- the other four dashboards (API & sync, Devices, Business day & cash, Database & backups): they come with the features they show
- POS offline diagnostics and device health (with sync, Wave 1)
- the "Trace a bill" view (PLT-12, Wave 1)

## Tests written first

- [x] **Redaction:** a log line with `password`, `pin`, `pinVerifier`, `token`, `authorization` and `cookie` (top level, nested, inside `req.headers`) shows `[redacted]` for each, never the value.
- [x] **Correlation:** a line logged inside `withContext({ requestId, tenantId })` carries both; after `setContext({ userId })` it carries the user too; outside any context it carries neither.
- [x] **API:** every response has `x-request-id`; a valid incoming one is kept, an invalid one is replaced; a 500 body is `{ error: 'internal', reference: <the request ID> }` with no stack or message; the log line for it has the request ID, the tenant and the error.
- [x] **Sentry scrubbing:** `beforeSend` removes cookies, authorization headers and request bodies.
- [x] `alloy fmt` accepts the Alloy config in CI.

## Verify (on staging, then production)

1. A test error on staging (`POST /api/_test/error`) **appears in Sentry with its request ID**, and in **Slack `#erp-alerts`** with the same ID.
2. In Grafana, **logs are searchable by `request_id` and `tenant_id`**, and the request shows as a trace.
3. The *System* dashboard shows CPU, RAM, disk, containers, API requests and errors, PostgreSQL connections and size, and backup age, for prod and staging.
4. The synthetic checks are green; a deliberately failing check alerts `#erp-critical` and your email, then is removed.
5. Alloy uses less than 250 MB of RAM.

## Order

1. Failing tests; the logger and context in `packages/observability`.
2. API and worker: logger, request IDs, Sentry, tracing.
3. Server: Alloy, `erp-obs`, the monitor role, `pg_stat_statements` (one restart of each database, outside shop hours; no shop is live yet).
4. Grafana: dashboard, alert rules, synthetic checks. Browser Sentry.
5. Staging checks, then production after the next release.

## Risks

| Risk | Mitigation |
|---|---|
| OpenTelemetry auto-instrumentation and our bundled ESM build don't mix | `@fastify/otel` is a Fastify plugin (no module patching); `pg` stays an external package, loaded through the `--import` hook. If a hook still fails, the request metrics come from the Fastify plugin alone. |
| Free-tier limits (logs, series, checks) | Debug logs off in production, label cardinality kept low (no IDs as metric labels), checks every 5 minutes. Grafana shows usage; over the limit, data is dropped, never billed. |
| A secret or personal data in logs | The redaction list and its test; phones masked (§11.7); Alloy drops lines over 16 KB. |
| Alert noise | Few rules to start, grouped per incident, each with a runbook. |
| Alloy competes with the shop for memory | A 300 MB memory limit on its container; measured in Verify. |

## What you need to do (all free, no card)

1. **Slack:** a free workspace with channels `#erp-critical` (phone notifications on) and `#erp-alerts`. I'll guide you.
2. **Sentry:** an account in the **EU** region, with projects `erp-server` and `erp-web`. You'll paste the two DSNs into `sudo erp-obs secrets`, and a Sentry auth token into the GitHub secrets for source maps.
3. **Grafana Cloud:** a free account with a stack in the **EU**. Create an access token for Alloy and connect the two Slack channels as contact points. I'll guide you through each screen.

## Questions for you

1. **Replace UptimeRobot with Grafana's uptime checks** (UptimeRobot's free plan isn't allowed for a business)? (Recommended: yes.)
2. **EU regions** for Sentry and Grafana, next to the server in Helsinki? (Recommended: yes.)
3. **Which email** gets the copy of critical alerts? (Proposed: the address you use for GitHub.)

## Owner answers (2026-10-24)

1. **Grafana's uptime checks instead of UptimeRobot:** yes.
2. **EU regions** for Sentry and Grafana: yes.
3. **Critical-alert email copy:** the owner's GitHub email.
4. **Slack** for the alerts (free workspace), and **no paid services** at all (D-087).

## Changes during the build

| Plan | Built | Why |
|---|---|---|
| Alloy as its image's own user | **Root with every capability dropped**, all host mounts read-only, state in its own volume | The image's user can't read Docker's root-owned log files or write its state; root without capabilities can read root-owned files but change nothing. |
| Worker tracing | Logs and Sentry only for now | The worker has no jobs yet; tracing comes with its first job. |
| Container names from Docker | From compose log labels on each line; restarts detected from the apps' "started" log lines | Without the Docker socket Alloy can't ask Docker; per-container CPU and memory wait for a socket-free option. |
| — | The worker image now ships its `node_modules` | Found by a local image build: the worker had no dependencies before, and would have crashed with pino and Sentry. |
| — | `service.namespace` = env on OpenTelemetry data | Grafana Cloud turns it into the metrics' `job` label (`prod/erp-api`), so prod and staging are told apart. |
| — | `protobufjs` install script denied, `@sentry/cli`'s allowed | pnpm requires a decision; protobufjs's script only checks versions, Sentry's CLI downloads the binary that uploads source maps. |
| Synthetic checks and Grafana resources "applied with a script" | Dashboard, alert rules and notification policy by `grafana/apply.py`; the three uptime checks are created in the Grafana UI | The uptime-check API needs a separate token; three checks are quicker by hand and are described in the infra README. |

## Results (2026-10-24)

**Two bugs found on staging, both fixed through their own PRs:**
- **The API crashed at startup with Sentry and OpenTelemetry both on** (#39). Sentry adds its own Fastify integration whenever `tracesSampleRate` is set, even to 0; it clashed with `@fastify/otel`. The first W0-06 staging deploy failed its health check and rolled back by itself. Local checks had run without a Sentry DSN. A test now starts the API with both on; Sentry is errors-only.
- **The browser bundles had no Sentry DSN** (#40). CI didn't pass `SENTRY_AUTH_TOKEN` to the reusable deploy workflow, and the DSN and org had been saved as secrets instead of variables.

**Verified on staging:**

| Check | Result |
|---|---|
| Test error (`POST /api/_test/error`) | `500 {"error":"internal","reference":"01a16e5c-e036-79c0-9864-3520eb0232a5"}`. **The owner found the same reference in Sentry** (erp-server, staging, `request_id` tag), **in Slack `#erp-alerts`** ("Error in the apps") **and in Grafana** (`{env="staging"} \| json \| request_id="…"`). |
| Logs by `tenant_id` | On authenticated requests' lines (integration test); searchable the same way. |
| Redaction | Tested: passwords, PINs, verifiers, tokens, cookies and authorization headers never reach a log line. |
| Browser errors | Both staging bundles carry the erp-web DSN; source maps uploaded to Sentry in the build, none served (0 `.map` files in the image). |
| Alloy | 75 MB of its 300 MB limit; server metrics, logs, backup age and PostgreSQL metrics in Grafana. |
| Contact points | Test messages reached `#erp-critical`, the email copy and `#erp-alerts`. |
| Grafana | `apply.py` created the ERP folder, the *System* dashboard, the 8 alert rules and the notification policy; the owner created the three uptime checks. |

**Production:** released 2026-10-24 23:21 PKT (tree `4fe3586a…`), images reused from staging, healthy; `POST /api/_test/error` answers `404` there, as intended.

**Not done:** a deliberately failing uptime check (the critical route was tested with the contact point test and the warning route end to end). It can be done any time by pointing a check at a wrong URL for 15 minutes.
