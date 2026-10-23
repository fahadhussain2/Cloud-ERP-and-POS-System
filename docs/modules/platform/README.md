# Platform (`PLT`)

| | |
|---|---|
| **Status** | In progress: W0-07, W0-09, W0-10 done; W0-11 (tenant setup) |
| **Requirements** | 13 (PLT-01…PLT-13) |
| **Feature spec needed** | Yes: device enrollment + PIN security |

## Scope

Tenants and their settings, branches and locations, device enrollment, users with passwords and PINs, roles and permissions, overrides, audit log, device health, tenant isolation, support tools, themes.

## Requirements

Full wording is in [the PRD](../../01-PRD.md). Wave 1 = critical path for go-live, Wave 2 = rest of the MVP.

| ID | Summary | Wave |
|---|---|---|
| PLT-01 | Tenant with base currency, timezone, locale, fiscal year start month (fixed once the first period is closed), cash rounding rule, receipt header, and cash… | 1 |
| PLT-02 | Branch → Locations (Shop / Godown / Damaged, flagged sellable or not). | 1 |
| PLT-03 | Device enrollment: a manager registers a counter or cash desk browser to a branch with a one-time code. | 1 |
| PLT-04 | Users with personal accounts. | 1 |
| PLT-05 | Role templates (§4) with permissions and limits. | 1 |
| PLT-06 | Custom role editor (copy a template, edit the permission checklist and limits). | 2 |
| PLT-07 | Override = the PIN of a user who has the required permission (usually a manager), entered on the same screen with a reason. | 1 |
| PLT-08 | Append-only audit log for master data changes (before and after), logins, overrides, voids, settings. | 1 |
| PLT-09 | Device health page: last sync, unsynced documents, app version, persistent-storage status, clock skew. | 1 |
| PLT-10 | Tenant data isolation enforced in the database (row-level security). | 1 |
| PLT-11 | Internal tenant setup script (platform owner only, not customer-facing). | 2 |
| PLT-12 | Support and diagnostics: "Trace a bill" timeline in the back office (owner / platform admin): device, user, print, sync attempts, server acceptance,… | 1 |
| PLT-13 | Light and dark themes. | 2 |

## Related

Architecture §4.3 (device identity, PIN), §6 (tenancy, RLS, auth); data model §2; D-026, D-028, D-051, D-056, D-061, D-064, D-067

## Work in this module

- `spec.md`: only if needed (see above), written before the first plan that depends on it.
- `plans/<wave>-<nn>-<slug>.md`: one accepted plan per task, before any code ([delivery process](../../07-DELIVERY-PROCESS.md) §3).
- `intent.md`: only for changes after the MVP.
