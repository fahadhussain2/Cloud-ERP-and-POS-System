# W1-28 The back-office shell: a tidy side menu and a slim top bar

| | |
|---|---|
| **Issue** | [#168](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/168) |
| **Module** | platform (the back-office layout from W1-04; touches no other module's screens) |
| **Status** | Draft (2026-11-14), waiting for the owner. The look is agreed from the [mockup](https://claude.ai/artifact/EBa8edxXQzJLAxXboErgWU) (expanded and collapsed, 2026-11-14) |
| **Refs** | W1-04 (the layout and the menu, owner answer 4: only screens that exist and that the person may open), W1-20 owner answer 5 (the Exceptions count in the menu); D-066 (shadcn/ui, Lucide), D-067 and PLT-13 (colour tokens for both themes), D-090 (the back-office design pass); CLAUDE.md rule 10 (i18n keys, logical CSS) |
| **Depends on** | W1-04 (the layout), W1-20 (the Exceptions count) |
| **Size** | about 2 days |
| **Test-first** | Yes: the menu's groups, open and closed state, permissions, badges, the collapsed menu, the top bar and the search (unit); one flow through the collapsed menu and the search (e2e) |

## The problem

The back-office menu grew one entry per task since W1-04 and is now hard to scan:

- **28 links under 8 headings, all showing at once.** The headings look much like the links, and nothing can be closed.
- **Two groups hold one link each** (*People* → Staff, *Sales* → Customers).
- **Setup screens are spread over three groups:** Staff (*People*), Counters and Shop and bill (*Shop*), Stock settings (*Stock*).
- **No icons, and the menu can't be made smaller,** so wide tables (the items list, the reports) lose 200px for good.
- **The top bar holds little:** the brand, the signed-in name and Sign out, on its own row above everything.

## Goal

**The menu shows seven rows; the group you are working in is open, the rest are one click away.** The top bar says where you are, finds any screen by name, and holds the account menu. Every screen stays where a permission puts it today: this task changes the frame, not the screens.

## Design

**The menu** (all 28 entries kept; the order follows the mockup):

| Row | Entries |
|---|---|
| **Customers** | *(a direct link)* |
| **Catalog** | Items · Categories · Print labels |
| **Purchasing** | Suppliers · Goods receipts · Purchase returns |
| **Stock** | Transfers · Adjustments · Stock card · Transfer needed |
| **Accounting** | Money · Accounts · Periods · Expense categories |
| **Reports** | Day reconciliation · Cash variance · Sales register · Overrides · Voids and returns · Stock and value · Outstanding and ageing · Exceptions · Trace a bill |
| **Settings** *(at the foot)* | Staff · Counters · Shop and bill · Stock settings |

| Choice | Why |
|---|---|
| **A full-height sidebar** (248px), white, with a hairline on its inner edge; it stays in place while the screen scrolls, and scrolls on its own if a short window can't hold it. Brand (*Tijara · Back office*) on top | Replaces the floating panel under the top bar; the frame reads as one piece |
| **Each group is one row** with an icon and a chevron; clicking opens or closes it. **The group of the current screen opens by itself.** Open groups and the collapsed state are remembered in this browser (`localStorage`) | 7 rows instead of 36 lines; the working group is always in view |
| **A group with one entry the person may open shows as a direct link** (the entry's name, the group's icon). Customers today; also a manager who may open only one screen of a group | No group that opens to a single link. One rule, so it also holds when permissions hide entries |
| **People and Shop merge into Settings, with Stock settings;** it sits at the foot of the menu | Everything set once and rarely changed is in one place, away from daily work |
| **The current screen** has a neutral fill and bold text; its group's icon is orange. Orange is used nowhere else in the menu | One accent; today's blue selection fill goes from the menu (the `select` token stays for tables and lists) |
| **Collapsed menu** (a button in the brand row): a 64px rail of icons with tooltips. Clicking an icon opens that group's screens beside it. **Windows narrower than `md` always show the rail** | Wide tables get the room back. Replaces today's menu-folds-into-a-row on narrow windows |
| **Badges:** on the entry as today; **on its group while the group is closed**; a dot on the icon in the rail | The Exceptions count must not hide inside a closed group |
| **The top bar** (56px, level with the brand row) holds three things: **where you are** (*Catalog / Items*), **the search**, **the account menu** (name → Sign out). Today's top bar goes | The brand moves to the sidebar, so the bar is free for what helps on every screen |
| **Where you are** comes from the menu itself (group and entry of the current route, also on detail screens: an item shows *Catalog / Items*). `PageHeader` is unchanged: titles, help lines and the back links stay | No per-screen work, and nothing to keep in step by hand |
| **The search** (**Ctrl K**, or a click): a dialog listing the screens the person may open; typing narrows it, arrows and Enter open one. **Screens only**, built from the menu. Question 1 | With groups closed, a name is the fastest way to a screen. Uses what `packages/ui` already has (`Dialog`, `OptionList`, `useShortcuts`) |
| **The account menu** shows the person's name and **Sign out**. The mockup's shop name is left out for now. Question 2 | `/auth/me` doesn't return the shop's name; the theme switcher (PLT-13, Wave 2) will live in this menu |
| **The first screen after sign-in** stays "the first one you may open", now in the new order: **Customers** for an owner or manager (today Staff). Question 3 | The rule doesn't change; Staff is no longer first because Settings is at the foot |
| **Colours and fonts:** the existing tokens only, checked in both themes. **Icons:** Lucide (D-066). **New building blocks:** shadcn/ui `dropdown-menu` (account menu, rail flyouts) and `tooltip`, added to `packages/ui` | The same look as every other screen; dark needs no extra work when its switcher comes |
| **Rule 10:** every new string is an i18n key; logical CSS only; chevrons and flyouts follow the reading direction | Works right-to-left |
| **Accessibility:** the `navigation` landmark keeps its name (*Menu*); group rows are buttons with `aria-expanded`; the current entry keeps `aria-current`; rail icons have names | Keyboard and screen-reader use stays correct; the tests find things the same way |

## Scope

- **In:**
  - `apps/backoffice/src/layout/`: the menu's data with the new groups and icons (`MENU` and `allowed` keep their exports for `App.tsx`), the sidebar, the top bar, the screen search, the shell that puts them together.
  - `packages/ui`: `dropdown-menu` and `tooltip` from the shadcn CLI (`pnpm --filter @erp/ui ui:add`), exported from the index.
  - `apps/backoffice/package.json`: `lucide-react` (the workspace catalog's version).
  - `apps/backoffice/src/locales/en.json`: the Settings group, collapse and expand, the search, the account menu; *People*, *Shop* and *Signed in* go.
  - Tests: the existing *layout and menu* tests in `App.test.tsx` moved to the new groups; a shared menu helper for the e2e specs (a closed group must be opened before its link can be clicked).
  - Docs: **D-114** in the decision log (the back-office frame departs from the Tijara prototype's top bar and flat menu; the tokens stay); the *Look and feel* note and the W1-28 row in `WAVE-1-TASKS.md`; the platform README's status.
- **Out:**
  - **Every screen's content**, `PageHeader`, tables and forms: the next design passes, one screen family at a time.
  - **Searching data** (items, customers, bills) from the search box.
  - **The theme switcher** (PLT-13, Wave 2) and a language switcher.
  - **The shop's name in the frame** (question 2).
  - **The POS**: it has its own frame (`AppFrame`), untouched.
  - **Permissions and routes:** no entry gains, loses or changes a permission or an address.

## Tests written first

- **Unit** (`apps/backoffice/src/layout/Shell.test.tsx`, new):
  - An owner sees the seven rows in order. **Every one of today's 28 entries is in exactly one group** (a guard against losing a screen in the regrouping).
  - The current screen's group is open and its entry is marked current; the others are closed. A detail screen (an item, a person) opens its list's group.
  - A group opens and closes on click, stays open after moving to another screen, and comes back open after a reload (`localStorage`).
  - A group with one allowed entry shows as a direct link; a group with none doesn't show; someone with no rights sees no rows (as today's test says).
  - The Exceptions count: on the entry when Reports is open, on Reports when it's closed, nothing at 0.
  - Collapsed: the rail shows, every row still has its name, a click on an icon lists the group's screens, and the choice is remembered.
  - The top bar: the group and entry of the current route; the account menu shows the name, and Sign out calls `onSignOut`.
  - The search: Ctrl K opens it; typing narrows the list; Enter goes to the screen; a screen the person may not open is never listed.
- **Unit** (`App.test.tsx`): the *layout and menu* tests on the new groups; tests that relied on landing on Staff address `#/staff` first.
- **e2e:** the three local `menu()` helpers and the direct menu clicks in `counter.spec.ts` go through one shared helper. One new flow: collapse the menu, open Stock → Transfers from the rail, then reach Trace a bill by the search.

## Verify

1. `pnpm check` and `pnpm e2e`, output shown. (`pnpm test:integration` is not affected: no API or database change.)
2. **The verifier** runs the back office and compares the frame with the mockup, expanded and collapsed, in light and with `data-theme="dark"` forced.
3. **On staging, by the owner:** sign in as owner and as a manager: the seven rows, opening and closing, the rail and its flyouts, the search, Sign out; a reload keeps the menu as it was left; a narrow window shows the rail.

## Questions for you

1. **The search box: build it now, for screens only?** It's about half a day of the two. Without it the top bar holds the location and the account menu only. *Recommended: yes, screens only; searching items or bills from it is a later task.*
2. **Leave the shop's name out of the account menu for now?** Showing it needs the name in `/auth/me` (contract, API, an integration test). *Recommended: yes, leave it out; add it with the theme switcher, which reworks this menu anyway.*
3. **The first screen after sign-in becomes Customers** (owner and manager), because the rule "the first screen you may open" follows the new order. *Recommended: yes. If you'd rather land on Items, say so and Catalog moves above Customers.*

## Risks

| Risk | Mitigation |
|---|---|
| A screen is lost or lands in the wrong group | The guard test compares the regrouped menu with today's 28 entries; permissions and addresses aren't touched |
| The e2e flows click menu links that are now inside closed groups | One shared helper opens the group first; every spec uses it, and the whole e2e suite runs in Verify 1 |
| Tests that assumed landing on Staff fail | They address `#/staff` first; the landing rule itself has its own test |
| Ctrl K is taken by the browser on some setups | The search also opens by click; the shortcut is a convenience, never the only way |
| The remembered menu state holds a group that no longer exists | Unknown names are ignored when the state is read; tested |
| Radix menus and tooltips grow the back-office bundle | Both come from the `radix-ui` package already in `packages/ui`; the build output's size is compared before and after |
| The frame looks right in light but not in dark | Verify 2 forces dark; only tokens are used, so a miss is one class to change |
