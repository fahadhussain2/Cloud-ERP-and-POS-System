# DevOps, hosting and observability

| | |
|---|---|
| **Status** | In progress: W0-01 |
| **Requirements** | Non-functional: PRD §7 (durability, security, observability), §8 (release plan, go/no-go) |
| **Feature spec needed** | No: architecture §9 and §11 are the spec |

## Scope

Monorepo tooling and one-command checks, CI (GitHub Actions), environments and deploys (`staging` → staging, `main` → production after hours), server setup and hardening on the Hetzner CX33, domains and TLS, backups (WAL + base, off-site) and restore drills, observability (Sentry, Grafana Cloud via OpenTelemetry + Alloy, uptime checks, Slack alerts), runbooks.

## Related

Architecture §9 (deployment, domains, CI/CD), §11 (observability), §12 (testing); D-029, D-062, D-063, D-064, D-065; [delivery process](../../07-DELIVERY-PROCESS.md).

## Owner actions needed

- DNS records for `pos.`, `app.`, `staging-pos.`, `staging-app.` (and optional `status.`) `zorbixtechnologies.com`
- Accounts: off-site backup storage (a different provider from Hetzner), Sentry, Grafana Cloud, UptimeRobot, Slack workspace with `#erp-critical` and `#erp-alerts`
- Enable Hetzner server backups; buy a CX23 for staging before 30 Nov

## Work in this module

- `plans/<wave>-<nn>-<slug>.md`: one accepted plan per task, before any code.
- `docs/runbooks/`: one short runbook per critical alert.
