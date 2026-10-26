# W1-04 Staff and user admin, plus the back-office layout

| | |
|---|---|
| **Issue** | [#49](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/49) |
| **Module** | platform (with pos for the counter unlock, and `packages/ui`) |
| **Status** | Accepted (2026-10-26); built, checks green, waiting for Verify 2–3 and review |
| **Refs** | PLT-04, PLT-05 (assign), PLT-08; PRD §4; platform spec §4; POS spec §5; migration §6; D-051, D-053, D-066, D-081, D-082, D-083, D-089, D-090 |
| **Depends on** | W1-02 (Staff PINs, Counters, unlock), W1-03 (`packages/ui`, tokens) |
| **Size** | about 3 days |
| **Test-first** | Yes: `canGrantRole` (golden), the user-admin API with RLS and audit (integration), the counter's manager unlock and lock reset |

## Goal

**The owner sets up the shop's people without support:** add the 13 legacy staff by hand (migration §6), give each a role for the branch, a back-office password only if they need one, and a temporary PIN; move people between roles, deactivate a leaver at once. **On the counter, a manager unlocks a colleague locked out by wrong PINs**, offline. The back office gets the prototype's look: top bar, grouped side menu, panels and tables, which every later back-office screen (W1-15 to W1-20) reuses.

## Design

| Choice | Why |
|---|---|
| **People are managed with `admin.users`** (Owner by template): add, edit, roles, back-office password, deactivate. **Temporary PINs stay with `admin.devices`** (Manager and Owner, as in W1-02). Owner question 1. | PRD §4 and the W0-09 templates: managers approve and run the floor; who works here and with which rights is the owner's. |
| **One *Staff* screen replaces *Staff PINs*.** Everyone with `admin.devices` or `admin.users` sees the list; the actions shown follow the permissions (a manager sees only *Give temporary PIN*). Owner question 2. | One list of people instead of two that drift apart. |
| **A person has:** full name, username (fixed once created: it's the login and in the audit trail), optional short code and email, roles each **for one branch or all branches** (`user_roles.branch_id`, D-081), and a status. **No new server tables or columns.** | The W0-09 schema already holds all of it; branch scope is per role, so "branch" in the issue is the role's branch. Delux has one branch (MAIN): the branch field defaults to *All branches*. |
| **Nobody grants more than they hold:** a role can be given or taken away only by someone who holds every permission in it (`canGrantRole` in `packages/domain`, golden-tested; Owner's `*` needs `*`). | Rule 2 and D-081: permission logic lives in the domain. Harmless with Owner-only admin today, essential once custom roles (PLT-06) or managers with `admin.users` exist. |
| **Guards:** you can't deactivate yourself or take your own `admin.users` away; **the last active Owner can't be deactivated or lose the Owner role**. Checked in the API inside the transaction, with the owner rows locked (`FOR UPDATE`), so two admins can't race past it. | Otherwise one click locks the shop out of its own back office, and only platform support (D-083) could fix it. |
| **Back-office password is optional.** Salesmen get none: they only unlock counters (D-089). Giving access or resetting it: the owner types a **temporary password** (≥ 10 characters, D-081 rules), `must_change_password` is set, the person's sessions end and their login lock clears. *Remove access* clears `password_hash` and ends their sessions. | Mirrors the temporary PIN (D-089) and the support reset (D-083): the owner tells the person, the person replaces it. No secret is ever returned by the API. |
| **Deactivate, never delete.** `status = 'disabled'`: sessions end at once, login refuses (already the case), the next pull removes them from every counter's staff list, and **a counter where they're unlocked locks** when that pull lands. *Reactivate* brings them back. | Documents and the audit trail reference people forever (rule 3, PLT-08). |
| **Manager unlock on the counter (POS spec §5):** a locked person on the unlock screen shows *Locked* and offers *Manager unlock*. A manager picks themselves (or types their short code) and enters **their own** PIN; the counter checks it offline and that they hold **`admin.devices`** for this branch (`can()` over the pulled roles, D-081). Wrong manager PINs count towards the manager's own lockout. The locked person then unlocks with their PIN as usual. | The same people who give temporary PINs. Works with the internet down, which is when a lock hurts most. |
| **A new PIN from the server clears the lock:** when a pull brings a different `pin_verifier` for a person, their lock on that counter resets. | The remote path: with no manager in the shop, the owner gives a temporary PIN from home and the counter clears itself. The lock protected the old PIN, which no longer exists. Owner question 3. |
| **Lock and unlock events are kept on the counter** (local schema 3: `pin_events`: who, by whom, when) and **pushed with W1-07** into the audit log (platform spec §4: "reported at the next sync"). Until W1-07 they're also in the diagnostic log. | They aren't numbered documents, so they don't belong in the outbox's series; one small table keeps W1-07's job clear. |
| **Back-office layout from the prototype (Tijara Goods Receipt):** a top bar (brand, shop name, signed-in person and role, sign out), a **side menu in groups** (*People* → Staff; *Shop* → Counters), and the work area in panels. **The menu shows only screens that exist and that the person may open**; each later task adds its entries. Owner question 4. Narrow windows fold the menu into a row (logical properties, rule 10). | D-090: the design pass for the back office is part of this task. Greyed-out future entries would be clutter that changes every week. |
| **Screens have addresses (`#/staff`, `#/staff/<id>`, `#/counters`)** with a small hash router of our own (about 30 lines). | Reload and the back button keep your place; hash addresses need no server change on the back-office host. A router library is more than four screens need. |
| **Building blocks added to `packages/ui` with the shadcn CLI:** `table`, `select`, `checkbox`, plus our own `PageHeader` (title, help, main action) and `StatusChip` (Active, Deactivated, Locked, PIN states). Messages stay as `Alert`; no toast yet. | Only what these screens use (the W1-03 rule). Radix `select` is keyboard- and RTL-correct. |

### API (all under `/api`, all inside `withTenant`)

| Route | Permission | What |
|---|---|---|
| `GET /users` | `admin.users` or `admin.devices` | People with roles (role id, name, branch), back-office access yes/no, PIN state, status, last login. Never hashes or verifiers. Replaces `GET /staff`. |
| `GET /roles` | `admin.users` | The tenant's roles (id, name, template key) for the role picker |
| `POST /users` | `admin.users` | Create: name, username, short code, email, roles, optional temporary password |
| `PATCH /users/:id` | `admin.users` | Full name, short code, email |
| `PUT /users/:id/roles` | `admin.users` | Replace the role set (removed rows soft-deleted, so counters get tombstones); `canGrantRole` for each added or removed role; last-owner guard |
| `PUT /users/:id/password` · `DELETE /users/:id/password` | `admin.users` | Give or reset a temporary password · remove back-office access; both end the person's sessions |
| `POST /users/:id/deactivate` · `POST /users/:id/reactivate` | `admin.users` | Status; deactivate ends sessions; self and last-owner guards |
| `PUT /users/:id/temporary-pin` | `admin.devices` | Unchanged (W1-02) |

Every change is in the audit log through the W0-09 triggers (before/after, secrets stripped); password and session events are written by the API (`password.set_by_admin`, `password.removed`, `user.deactivated`).

## Scope

1. **`packages/domain`:** `canGrantRole(granterGrants, rolePermissions)` with golden cases; `PinEvent` already has `manager_unlock` (W0-10).
2. **`packages/contracts`:** Zod schemas for the user-admin requests and the `GET /users` response.
3. **`apps/api`:** the routes above (`admin/users.ts`), a `requireAnyPermission` helper, the guards; `GET /staff` removed.
4. **`packages/ui`:** `table`, `select`, `checkbox` from the shadcn CLI; `PageHeader`, `StatusChip`; README updated.
5. **`apps/backoffice`:** Tailwind and `@erp/ui` (as the POS does), the layout and menu, the hash router; **Staff** (list with filter *Active / Deactivated*, *Add person*, the person page with details, roles and branch, back-office access, temporary PIN, deactivate/reactivate, each in a D-053 dialog); **Counters** restyled, same behaviour; sign-in and password change restyled.
6. **`apps/pos`:** local schema 3 (`pin_events`); *Manager unlock* on the unlock screen; lock reset on a new verifier; lock the counter when the unlocked person is deactivated by a pull.
7. **E2E:** owner adds a salesman with a role and a temporary PIN → the counter lists them after a pull; 5 wrong PINs lock them → a manager unlocks offline → they unlock; owner deactivates them → gone from the counter; a manager signed in sees *Give temporary PIN* only.
8. **Docs:** platform README (user admin), platform spec §4 (manager unlock, lock reset), POS spec §5, data model §12 (local schema 3), sync spec (a `pin_events` note for W1-07), decision log **D-091**.

**Out of scope:** the custom role editor (PLT-06, Wave 2); branch and location admin (no screen needed for one branch); TOTP (Phase 2); pushing `pin_events` (W1-07); the theme switcher (PLT-13); any other back-office module.

## Tests written first

**Domain (golden):**
- [x] `canGrantRole`: Owner grants any template; a holder of exactly the Manager permissions grants Manager and Salesman but not Owner or Accountant; nobody without `*` grants a `*` role; branch-scoped grants count only in their branch.

**API (integration, real database):**
- [x] Create a person with roles and no password: no `password_hash`, can't log in; their roles come back in `GET /users`; the audit log has the insert without secrets.
- [x] Give a temporary password: login works, then `403 password_change_required` until changed; resetting it ends the person's existing session and clears their login lock.
- [x] Remove access: the person's session ends and login fails.
- [x] Replace roles: removed rows become tombstones in the counter pull; a Salesman role scoped to a branch comes back with that branch.
- [x] Deactivate: the session ends, login fails, the pull sends `status = disabled`; reactivate restores login.
- [x] Guards: deactivating yourself → 409; deactivating the last active Owner or removing their Owner role → 409; two concurrent requests removing the last two Owners → exactly one succeeds.
- [x] `canGrantRole` enforced: a user with `admin.users` but not every Owner permission can't give Owner (403).
- [x] Permissions: a Manager gets `GET /users` and the temporary PIN, and 403 on every other user-admin route; a Salesman gets 403 everywhere.
- [x] Duplicate username (any case) or short code → 409 with the field named; another tenant's user id → 404 (RLS).
- [x] No response from any route contains `password_hash` or `pin_verifier`.

**Counter (unit, fake worker):**
- [x] Manager unlock: a locked person + a manager's right PIN with `admin.devices` → unlocked and a `pin_events` row; a Salesman's PIN → refused; a wrong manager PIN counts towards the manager's lock; a manager whose role is for another branch → refused.
- [x] A pull with a new `pin_verifier` resets that person's lock; the same verifier doesn't.
- [x] A pull that disables the unlocked person locks the counter.
- [x] Local schema 3 upgrades a schema-2 database in place with every row kept (rule 9).

**Back office (jsdom):**
- [x] The menu shows Staff and Counters for an Owner, only what a Manager may open for a Manager, nothing for a Salesman with a password.
- [x] `#/staff/<id>` opens that person after a reload; the back button returns to the list.
- [x] Each dialog closes on `Esc` and keeps focus order (D-053).

- [x] **E2E:** the flows in scope item 7 (10 flows in `e2e/counter.spec.ts`, extending the W1-02/W1-03 ones).

## Changes made while building

| Change | Why |
|---|---|
| **A person's password, status and details can only be changed by someone who could give all their roles** (`checkOutranks`), not only roles. New test: a user with `admin.users` but fewer rights than the Owner gets 403 on resetting, removing or deactivating the Owner. | Found while building: without it, anyone with user admin could reset the Owner's password and take over. |
| **"An Owner remains" means active, with a password**, holding `*` for every branch. The guard runs after the change, inside the transaction, behind a **per-tenant advisory lock** instead of `FOR UPDATE` on owner rows. The race test fails with the lock removed (checked). | A row lock can't see an owner role removed by another transaction; the advisory lock serializes every owner-affecting change, and an owner without a password can't sign in to fix anything. |
| `GET /api/users` replaces `GET /api/staff`; the two W1-02 tests for it moved to `/api/users` | One list for one screen (owner answer 2). |
| **Roles on the person form are checkboxes** with one *Branch for roles you tick* picker (default *All branches*); a role already held for a branch keeps it | Delux has one branch; per-role branches stay possible without a picker per row. |
| `uuidv7()` added to `@erp/contracts`, with tests | The PIN events need device-made ids (rule 7); bills (W1-06) will use the same. |
| `DialogActions` key hints are `aria-hidden`, with `aria-keyshortcuts` on the buttons | Buttons were named "Save Enter" for screen readers. |
| Back-office dialogs give focus back to whatever opened them (they open from state, not a Radix trigger); the Esc test waits for it, as the `@erp/ui` test does | Radix returns focus only to a `DialogTrigger`; checked by removing the code (the test fails). |
| The shadcn `select` and `table` had physical utilities (`pl-2`, `right-2`, `text-left`); changed to logical ones, with a note in the `@erp/ui` README and a test on the table header | Rule 10 (RTL). |
| `apps/backoffice/src/test-setup.ts` stubs `ResizeObserver` in jsdom | Radix's checkbox measures itself inside a form. |
| The "following a person's name" test waits for the address | jsdom follows a fragment link a moment later; without waiting, the address leaked into the next test. |
| Revoking a counter now asks in a dialog (it was an inline second button) | The same D-053 confirmation as the other actions. |
| Back-office bundle: JS 370 → 532 kB (118 → 168 kB gzipped), CSS 1 → 40 kB | Tailwind, Radix and the bundled fonts, the same set the counter already has. |

## Order

1. Failing tests (domain, API integration, counter), committed on their own.
2. Domain `canGrantRole`; contracts.
3. API routes and guards.
4. `packages/ui` additions; back-office layout, router, Staff, Counters, sign-in restyle.
5. Counter: schema 3, manager unlock, lock reset, lock on deactivate.
6. E2E; docs and D-091.
7. Verify (below).

## Verify

1. `pnpm check`, `pnpm test:integration` and `pnpm e2e`, output shown.
2. **On your PC, with the Delux tenant** (local API, built back office and POS in Edge): add three of the legacy staff (a salesman without a password, a cashier, a manager with a password), check their roles and the audit rows; lock the salesman on a counter and unlock as the manager with the network off.
3. **On staging:** the owner signs in, adds a test person, deactivates them; the layout at full width and in a narrow window.

## Risks

| Risk | Mitigation |
|---|---|
| The shop locks itself out of the back office | The last-Owner and self guards, tested with concurrent requests; platform support reset (D-083) as the last resort. |
| A deactivated person keeps selling on an offline counter | The counter only learns at the next pull: offline it can't know. The audit trail and the document's user show it; the owner's leaver routine (deactivate, then check *Counters* sync) goes in the platform README. |
| `pin_events` wait on the counter until W1-07 | Kept in SQLite with the other local data (rule 9 protects the database); W1-07's plan picks them up. |
| The restyle grows into the other back-office modules | Only sign-in, password change, Staff and Counters; later screens come with their tasks. |
| Changing roles moves rights on counters that are offline | Counters apply role changes at the next pull, like every dataset (sync spec §4); overrides already carry the approver on the document. |

## Owner answers (2026-10-26)

1. **The Owner only manages people** (add, edit, roles, passwords, deactivate); Managers keep temporary PINs and the counter unlock.
2. **One *Staff* screen** replaces *Staff PINs*; the actions shown follow the permissions.
3. **A new temporary PIN from the back office clears that person's lock** on every counter at its next pull.
4. **The menu shows only screens that exist**; each later task adds its entry when its screen is built (no greyed-out future modules).
