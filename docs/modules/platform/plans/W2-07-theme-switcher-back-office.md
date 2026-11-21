# W2-07 Light and dark themes in the back office: the switcher

| | |
|---|---|
| **Issue** | to be opened when the plan is accepted |
| **Module** | platform (PLT-13), touching the back office's frame, `packages/ui` and the auth API |
| **Status** | Draft, for the owner's review |
| **Refs** | PLT-13; D-066 (shadcn/ui on the prototype's tokens), D-067 (light and dark, a switcher), D-114 (the account at the foot of the side menu); W1-28 (the theme buttons' place, shown as System only); CLAUDE.md rules 5, 10; prototype [Back-office light and dark themes](https://claude.ai/artifact/UkXzx1dm35yEboZxSZcf5W) (private canvas, sample figures) |
| **Depends on** | W1-28 (the account menu), W2-06 (the dashboard, whose charts are on the chart tokens) |
| **Size** | about 1½ days: API and table ¼, switcher and theme code ½, the dark pass over every screen ½, tests ¼ |
| **Test-first** | Yes: the API integration test, the theme unit tests and the account menu's component test, committed failing before the change |

## The problem

Every screen already uses the colour tokens of `packages/ui/src/theme.css`, and both sets of values exist (light by default, dark under `:root[data-theme='dark']`). Nothing sets `data-theme` yet: the account menu shows **System** chosen and Light and Dark greyed out, "comes with the theme switcher" (W1-28). PLT-13 asks for **Light / Dark / System** in the back office, **each user's choice remembered for them**, and printed output always light.

The counter (POS) gets its own task after this one: there the theme is set **per counter by a manager**, default Light (PLT-13), not per person.

## What the prototype shows

The canvas draws the real frame (Tijara side menu, top bar, account at the foot) on the dashboard (D-118) and the Items list, each in light and dark, with the switcher working:

- The account menu keeps its place (beside the side menu, D-114): **Theme** with the current choice named beside it, then three buttons **System · Light · Dark**, each an **icon and a word**, then Sign out. With System chosen, a line under the buttons says what the computer's setting is now ("Follows this computer's setting, now dark").
- A choice applies at once to the whole screen, menus and tooltips included.
- Colours are the existing token values, unchanged. The only new token is **`--bad-ink`**, the text on a solid red (`--bad`): the count beside a menu entry is `text-white` today (`Sidebar.tsx:66`), which is only **2.7:1** on the dark red `#f2786c`. In dark it becomes `#1b0f08` (6.8:1); in light it stays white. That pill is the only hard-coded colour in `apps/backoffice/src` (search on 2026-11-21: `text-white`, `bg-white`, `text-black`, hex values in class names).

## Questions for the owner (each with a recommendation)

1. **Where a person's choice is kept.**
   *Recommended:* **on the server, per user**, so it follows them to any computer and two people sharing the shop PC each get their own; a copy is kept in this browser so the screen opens in the right theme before the server answers.
   *Otherwise:* in the browser only (no API or table change; everyone signing in on one PC shares the last choice there).
2. **The choice for someone who hasn't picked one.**
   *Recommended:* **System** (follows Windows or the phone). Existing users start on System too, so nobody's screen changes on the day this ships unless their computer is already dark.
   *Otherwise:* Light for everyone until they change it, as the counter will default.
3. **The three buttons.**
   *Recommended:* **an icon and a word** (System, Light, Dark), as in the prototype: the W1-28 icons alone needed a hover to tell them apart.
   *Otherwise:* icons only, as drawn in W1-28, with the name in a tooltip.
4. **The sign-in and password screens** (nobody is signed in yet).
   *Recommended:* **the last theme chosen in this browser**, else System.
   *Otherwise:* always System on those screens.
5. **Printed reports while the screen is dark.**
   *Recommended:* **paper always uses the light colours**: the dark values apply on screen only, so a report printed or saved as PDF from a dark screen looks exactly like one printed from a light screen (PLT-13 "printed bills, labels and PDFs are always light"). Labels are already black on white whatever the theme.
   *Otherwise:* nothing extra (today's print rules force a white page and black body text, but grey text, lines and chart colours would keep their dark-theme values on paper).

## Design (with answers 1–5 as recommended)

| What | How |
|---|---|
| **Table** | Migration `0024_user_settings.sql`: `erp.user_settings (user_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, theme text NOT NULL CHECK (theme IN ('system','light','dark')), updated_at timestamptz NOT NULL, FOREIGN KEY (tenant_id, user_id) REFERENCES erp.users (tenant_id, id))` and `erp.enable_tenant_rls` (rule 5). **Not synced, not audited**: a screen preference, like `erp.user_login_state`, and it must not touch `erp.users`, whose every change syncs to the counters and is audited. No row = System. Mirrored in `packages/db/src/schema.ts` |
| **Contract** | `packages/contracts/src/auth.ts`: `Theme = z.enum(['system','light','dark'])`; `MeResponse` gains `theme: Theme`; `UpdateSettingsRequest = z.object({ theme: Theme })` |
| **API** | `GET /api/auth/me` reads the person's row in the same `withTenant` call that reads the shop's name (no extra round trip). New `PUT /api/users/me/settings` (any signed-in user, `requireAuth`, beside `/users/me/password`): validates the body, upserts the row for the session's user only, returns `204`; a bad value → `400 invalid_request`. `requireAuth` refuses it while a password change is due, like every other route (D-083); the password screen has no switcher |
| **Tokens** | `packages/ui/src/theme.css`: the dark block moves inside **`@media screen`**, so print always takes the light values (answer 5); `--bad-ink` added to both sets and mapped as `--color-bad-ink`. The POS uses the same file and never sets dark yet, so it is unchanged |
| **Applying it** | New `apps/backoffice/src/theme.ts`: `resolveTheme(choice, prefersDark)`; `applyTheme(choice)` sets `data-theme` on `<html>` to `light` or `dark` (System resolved through `matchMedia('(prefers-color-scheme: dark)')`, followed live while System is chosen); the browser copy under `erp.backoffice.theme`, every read and write in `try/catch` (a private window or blocked storage just means System). On `<html>`, so the Radix menus, tooltips and dialogs, which render outside the app's root, follow too |
| **No flash on load** | A few lines in `apps/backoffice/index.html`'s `<head>` read the browser copy and set `data-theme` before the page paints; after `/auth/me` answers, the server's value wins and refreshes the copy (answer 4: the sign-in screen uses the copy) |
| **Switcher** | `Account.tsx`: the three buttons enabled, each an icon and its word (answer 3), `aria-pressed` on the chosen one, the chosen name beside "Theme", the System line from the prototype. A press applies at once, then saves with `PUT /api/users/me/settings`; if the save fails the choice still holds in this browser and a short message says it wasn't saved for other computers. `App.tsx` passes `me.theme` and the save down through `Shell` and `Sidebar` |
| **Messages** | New keys under `nav.themes` (`followsSystem` "Follows this computer's setting, now {{mode}}", `notSaved`); `nav.themeLater` removed (rule 10) |
| **The menu's count** | `Sidebar.tsx`: `text-white` → `text-bad-ink` |
| **The dark pass** | Every screen the menu opens, every report and every dialog, looked at in dark at desktop and phone width (the verifier, screenshots in the PR). Anything unreadable is fixed in this task by using the right token, never by a second colour set; the W1-28 note that the Items table's names didn't show in dark is re-checked here (the colours there have changed since) |
| **A guard** | `apps/backoffice/src/colours.test.ts`: fails on `text-white`, `bg-white`, `text-black`, `bg-black` or a hex colour in a `className` in `apps/backoffice/src`, so new screens stay on the tokens. Allowed: the label print styles in `styles.css` (black on white by design, PLT-13) |

## Tests written first

- **Integration** (`apps/api/src/settings.int.test.ts`, PostgreSQL 17):
  - a user with no row: `GET /api/auth/me` returns `theme: 'system'`;
  - `PUT /api/users/me/settings {theme: 'dark'}` → `204`, then `me` returns `dark`; again with `light` → `light` (upsert);
  - another user of the same shop still gets `system`; a user of another shop can't see or change the row (RLS, rule 5);
  - `{theme: 'blue'}` and `{}` → `400`; without a session → `401`; while a password change is due → `403 password_change_required`.
- **Unit** (`theme.test.ts`): `resolveTheme` for the six cases; `applyTheme` sets `data-theme` on `<html>`; with System chosen, a `matchMedia` change event flips it, and stops once Light is chosen; the browser copy is read and written, and a `localStorage` that throws leaves System in place without an error.
- **Component** (`layout/Shell.test.tsx`, the W1-28 case "System chosen until the switcher comes" replaced): the three buttons are enabled and named System, Light, Dark; pressing Dark marks it pressed, names it beside "Theme", sets `data-theme="dark"` and calls the save with `{theme: 'dark'}`; a failed save shows the message and keeps Dark; with System chosen the line names the computer's mode.
- **Guard:** `colours.test.ts`, above; it fails today on `Sidebar.tsx:66`.
- **Schema mirror:** the existing test that compares `schema.ts` with the migrations covers the new table.
- **e2e** (`e2e/shell.spec.ts`): the owner picks Dark, the page is dark, a reload keeps it, and after signing out the sign-in screen is dark; a second user signing in on the same browser gets their own (System); the owner signing in again on a fresh browser context gets Dark from the server. With `page.emulateMedia({ media: 'print' })` on a dark report, the muted text has the light value (answer 5).

## Verify

`pnpm check`, `pnpm test:integration` against PostgreSQL 17, `pnpm e2e` (shell and one report), output shown in the PR; the verifier's dark-pass screenshots attached.

## Order

1. Failing tests (integration, unit, component, guard), committed.
2. Migration, schema mirror, contract, the two API routes.
3. Tokens (`@media screen`, `--bad-ink`), `theme.ts`, the `index.html` lines, the switcher and its messages.
4. The dark pass and its fixes; the e2e flow.
5. Decision-log entry **D-120**: *each back-office user's theme is kept on the server, System by default; paper always uses the light colours*, amending D-067 with the answers above. The platform README's status and a short section on the theme.

## Risks

- **A screen found unreadable in dark late in the pass** costs time inside the 1½ days; any fix that needs more than the right token is listed in the PR and taken as its own task rather than delaying the switcher.
- **The sign-in screen flashes light** on a browser with no copy whose person chose Dark elsewhere: it turns dark when `/auth/me` answers, once per new browser.
- **`@media screen` and the browser's print preview:** the preview is print media, so it shows the light colours, which is what lands on paper. Checked by the e2e print step.

## Out of scope (noted, not changed here)

- **The counter (POS):** a per-counter theme set by a manager, default Light (PLT-13), as its own task (W2-08), reusing the tokens and `theme.ts`'s approach.
- A language switcher (W1-28's other deferred item).
- A high-contrast theme or any third colour set.
