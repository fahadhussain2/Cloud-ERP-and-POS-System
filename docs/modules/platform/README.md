# Platform (`PLT`)

| | |
|---|---|
| **Status** | In progress: W0-07, W0-09, W0-10, W0-11 done; counter side of PLT-03/PLT-04 built with W1-02; staff and user admin (PLT-04, PLT-05 assign) built with W1-04 (in review); the back-office frame redesigned with W1-28 (D-114); back-office documents on the shop's business date with W2-05 (D-117); the back office's light and dark themes with W2-07 (D-120, PLT-13); the back office's own controls with W2-12 (D-127), Customers moved, the other screens in W2-14 and W2-15 |
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

## Tenant setup (W0-11, D-083)

- A shop is a reviewed JSON spec (`infra/db/tenants/<name>.json`, schema `TenantSpec` in `packages/contracts`), created by `setupTenant` (`packages/db`): **create-if-missing**, drift reported and never applied.
- The chart of accounts is the retail template (`packages/db/templates/retail-coa.json`) plus the shop's banks and wallets, checked by `validateChartOfAccounts` (`packages/domain`) before anything is written.
- On the server: `sudo erp-tenant setup <env> <name>` (the owner types the password) and `reset-password` for support; see [infra/README.md](../../../infra/README.md#tenants-d-083).
- **After creation the shop's name and bill header are the owner's** (D-112): setup creates them from the spec but no longer compares them; see *The shop's name and bill header* below.
- A generated password sets `must_change_password`: the API then answers `403 password_change_required` on every route except `GET /api/auth/me`, `POST /api/auth/logout` and `PUT /api/users/me/password`.

## Counter PINs and back-office minimum (W1-02, D-089)

- **Temporary PIN:** `PUT /api/users/:id/temporary-pin { pin }` needs **`admin.devices`** (the Manager template has it, not `admin.users`). It stores the verifier, sets `users.pin_must_change` (migration `0007`), resets `user_login_state.pin_failures` and audits `pin.temporary_set`.
- **Own PIN at the counter:** `POST /api/sync/pin` (device token) checks the temporary PIN (wrong ones count towards the 5-try lock) and the PIN rules, clears the flag and audits `pin.changed` with the device.
- **Lists for the back office:** `GET /api/branches` and `GET /api/devices` (`apps/api/src/admin/routes.ts`); the staff list is `GET /api/users` (W1-04, below).
- **Back office** (`apps/backoffice`): sign in, the forced password change, *Staff* and *Counters* (one-time codes, revoke).

## Staff and user admin (W1-04, D-091)

- **Who:** people are managed with **`admin.users`** (Owner by template, owner answer 1); **temporary PINs stay with `admin.devices`** (Manager and Owner). One *Staff* screen for both: the actions shown follow the permissions.
- **Prices are the owner's** (W1-15, D-104): `cat.price.edit` is not in the Manager template; migration 0016 removed it from the existing template Manager roles. Managers keep `cat.item.edit` (details, codes, vehicles, new items).
- **API** (`apps/api/src/admin/users.ts`):

  | Route | Permission | What |
  |---|---|---|
  | `GET /users` | `admin.users` or `admin.devices` | People with roles, back-office access, PIN state, status, last sign-in; never a hash or verifier |
  | `GET /roles` | `admin.users` | Roles for the picker |
  | `POST /users` | `admin.users` | Create: name, username (fixed afterwards), short code, email, roles, optional temporary password |
  | `PATCH /users/:id` | `admin.users` | Full name, short code, email |
  | `PUT /users/:id/roles` | `admin.users` | Replace the roles (removed ones soft-deleted, so counters get tombstones) |
  | `PUT` · `DELETE /users/:id/password` | `admin.users` | Temporary password (must be changed at sign-in) · remove back-office access; both end the person's sessions |
  | `POST /users/:id/deactivate` · `reactivate` | `admin.users` | Deactivate ends sessions; counters drop the person at their next pull |
  | `PUT /users/:id/temporary-pin` | `admin.devices` | As in W1-02, but never to an Owner or a staff admin the actor doesn't outrank (`canGivePinTo`, 403 `cannot_grant`); `GET /users` says per person (`canGivePin`) |

- **Guards:**
  - nobody gives or removes a role, or changes a person, holding rights they don't have (`canGrantRole` in `packages/domain`);
  - nobody deactivates themselves, removes their own password or their own `admin.users`;
  - an **active Owner who can sign in always remains**; owner-affecting changes take a per-tenant advisory lock, so two admins can't race past the check.
- **Never deleted:** people are deactivated, not deleted; documents and the audit trail keep pointing at them.
- **Audit:** row changes by the W0-09 triggers; `password.set_by_admin` and `password.removed` by the API.
- **Leaver routine:** deactivate the person, then check *Counters*: an offline counter only learns at its next sync, and until then the person can still unlock it.
- **Counter side:** manager unlock offline, lock reset on a new PIN, lock when the person selling is removed (POS spec §5).

## The back-office frame (W1-28, D-114)

- **Where:** `apps/backoffice/src/layout/`. `menu.ts` holds the menu (seven groups with their icons and entries, each entry's address and permissions) and the remembered state; `Sidebar.tsx`, `TopBar.tsx` and `ScreenSearch.tsx` draw it; `Shell.tsx` puts them together.
- **The menu:** Customers, Catalog, Purchasing, Stock, Accounting, Reports, Settings. It lists only screens that exist and that the person may open (W1-04 owner answer 4). A group opens and closes; the current screen's group opens by itself; a group with one allowed entry is a direct link. A new screen adds its entry to a group in `menu.ts`; a test pins every entry's address and permissions.
- **The rail:** the collapse button folds the menu into icons with tooltips; a group lists its entries in a flyout. Narrow windows (under 48rem) always show the rail.
- **Remembered** in the browser only (`localStorage`, `erp.backoffice.menu`): the open groups and the fold. Unreadable state or a group that no longer exists is ignored.
- **The top bar:** where you are (group / entry, also on a detail screen), the search for screens (Ctrl K; the screens this person may open, by their name or their group's).
- **The account** (`Account.tsx`) at the foot of the side menu: avatar, name and username; its menu opens beside the side menu with the theme buttons (System only until PLT-13) and Sign out. It shows even with no menu entries, so anyone signed in can sign out.
- **First screen after sign-in:** the first entry the person may open, in the menu's order (Customers for an owner or manager).

## The shop's name and bill header (W1-25, D-112)

- **Back office → Shop → *Shop and bill*** (owner only, `admin.settings`): the shop name, the branch's address, phone and up to 3 extra lines, and the bill's policy line; each line up to 60 characters; a preview in the bill's order.
- **API:** `GET` and `PUT /api/settings/shop` (`apps/api/src/admin/shop-settings.ts`); one audited transaction on `tenants`, `branches` and the default `print_profiles`. Counters pull the changed rows (they're already in the pull and nudged).
- **The header's order:** `billHeaderLines` in `packages/print`, used by the counter, the cash desk and the preview.

## The shop's day in the back office (W2-05, D-117)

- **One business date** (`businessDate` in `@erp/domain`: the tenant's `timezone` and `day_cutoff_hour`, 04:00 at Delux) for the counters and the back office. The API works it out in `shopDay` (`apps/api/src/lock.ts`) and sends it as `today` in the purchasing, inventory and accounting lookups.
- **Every back-office document form** defaults to it and goes no later than it; none reads the browser's calendar.
- **Report screens** start on it: `GET /api/shop/today` (any signed-in user) and `useShopToday` (`apps/backoffice/src/shopDay.ts`).
- **On post**, `dateRefusal` (`apps/api/src/lock.ts`) refuses a purchasing or stock document dated after it (`date_in_future`) or on or before the lock date (`date_locked`, D-108); accounting documents check the same with `checkDocumentDate`.

## Light and dark themes (W2-07, D-120)

- **The switcher** is in the account menu at the foot of the side menu: System · Light · Dark, icons only. A press applies at once and saves for the person (`PUT /api/users/me/settings`); `/api/auth/me` returns `theme`.
- **Kept** in `erp.user_settings` (tenant RLS, not synced, not audited); no row = System.
- **On screen** `apps/backoffice/src/theme.ts` sets `data-theme` on `<html>`, follows the computer while System is chosen and keeps a browser copy (`erp.backoffice.theme`) that `index.html` reads before the first paint.
- **Paper** always uses the light colours: the dark values in `packages/ui/src/theme.css` apply under `@media screen` only.
- **New screens** use the tokens only; `colours.test.ts` fails on a fixed white, black or hex colour in a class name.

## The back office's own controls (W2-12, D-127)

- **Where:** `apps/backoffice/src/ui/` (`index.ts`): `Button` (optional `icon` before the word), `IconButton` (a row action: `label` is its name and tooltip), `TextInput`, `Select`, `Checkbox`, `FormDialog` and `ConfirmDialog`, `ListToolbar`, and `notify` with its `Toaster` (mounted once in the frame). Composed from `packages/ui`, which is never edited for the back office's sake.
- **Looks** come from `apps/backoffice/src/styles.css`: the orange focus (`--focus` set to the accent), `--glow`, `--field-line`, and the pointer cursor on everything you can press. `theme.css` is the POS's as much as the back office's and is not changed for this.
- **Problems** show at their field: a form keeps its problems by field and passes them to `FormDialog` (`errors`), which puts focus on the first wrong field after a save is tried. A result, or a problem that isn't one field's, is a toast: `notify.done(text)` (green, fades) or `notify.problem(text)` (red, stays). No page banners for results.
- **Tests** pick a kit dropdown with `chooseOption` (`src/ui/testing/choose.ts`) and, end to end, `choose` (`e2e/backoffice.ts`).
- **The lint rule** (`eslint.config.js`) refuses packages/ui's Button, Input, TextField, Checkbox, LABEL_CLASS and DialogActions in the back office, except in the screens still listed there; a screen comes off the list when it moves (W2-14, W2-15).
- **The POS look** (`e2e/pos-look.spec.ts`, Linux Chromium in CI only) compares six counter screens with `e2e/pos-look.spec.ts-snapshots/`, pixel for pixel. Those pictures are only ever re-taken from `staging`, in a PR of their own.

## Related

Architecture §4.3 (device identity, PIN), §6 (tenancy, RLS, auth); data model §2; D-026, D-028, D-051, D-056, D-061, D-064, D-067

## Work in this module

- `spec.md`: only if needed (see above), written before the first plan that depends on it.
- `plans/<wave>-<nn>-<slug>.md`: one accepted plan per task, before any code ([delivery process](../../07-DELIVERY-PROCESS.md) §3).
- `intent.md`: only for changes after the MVP.
