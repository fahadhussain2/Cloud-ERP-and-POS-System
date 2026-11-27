# W2-12 The back office's new look: smaller controls, its own dropdown, icon row actions, dialogs that fit (POS unchanged)

| | |
|---|---|
| **Issue** | #217 (W2-12), #218 (W2-13), #219 (W2-14), #220 (W2-15) |
| **Module** | platform (the back-office frame and its building blocks), touching every back-office screen; **not** `apps/pos` or `packages/ui` |
| **Status** | Accepted by the owner (2026-11-27), questions 1–3 as recommended, rules 5 and 6 added; no responsiveness list yet (answer 4) |
| **Refs** | D-066 (shadcn/ui on Radix in `packages/ui`), D-053 (every popup ends with Cancel and a main button), D-114 (the back-office frame), D-120 (themes), D-109 (customers); PRD §1 principle 2 (keyboard first); CLAUDE.md rule 10; mockup [Back-office restyle — Customers](https://claude.ai/artifact/4TCNKN5Cu5JpYfDp6B5p5k) (private canvas, sample names and figures); the owner's reference images (2026-11-27: a button, a field, a dropdown, a dialog) |
| **Depends on** | W2-07 (the theme tokens and the dark pass), W2-11 (the last screens added) |
| **Size** | about 7 days in four tasks: W2-12 2½ days, W2-13 ½ day, W2-14 2 days, W2-15 2 days (the messages of answer 6 add about a day across the passes) |
| **Test-first** | W2-13 is a bug fix: failing tests committed and locked first. W2-12: the POS look baseline is committed **before** any back-office change, and the kit's component tests before the kit |

## The problem

The owner's review of the back office (2026-11-26, 2026-11-27):

1. **Buttons are too big.** Page buttons are `size="lg"` (40px) in 15 places, and dialog buttons are large everywhere (`DialogActions`).
2. **Fields are too big.** `TextField` is 44px tall with 16px text (`packages/ui/src/text-field.tsx:38`); 29 hand-written `<select>`s in 13 files copy the 44px; 34 more places set `h-10`/`h-11` by hand.
3. **↓ doesn't move through the item search** (goods receipt, purchase return, transfer, adjustment, stock card, three reports): `ItemPicker` handles only Esc and Enter, and Enter always takes the **first** hit (`apps/backoffice/src/purchasing/ItemPicker.tsx:108`). The customer/supplier search (`PartyPicker`, accounting) has the same gap. A real bug against the keyboard-first principle.
4. **Row actions are words** ("Edit", "Deactivate", "Delete": 27 of them in 8 screens), which take the width the data needs.
5. **No pointer cursor on buttons.** Tailwind v4 no longer gives buttons `cursor: pointer`; only a few menu items set it by hand.
6. **Dialogs run off the screen.** `FormDialog` (19 uses) has no height limit and no inner scroll, so on a laptop a tall form such as Add customer pushes Cancel and the main button below the window. Header, fields and buttons are one block.
7. **Narrow windows** (the owner has no list yet; see answer 4).
8. **Buttons say what they do with an icon** (owner, 2026-11-27): a **+** on every Add / New button, and icons on every Save and Cancel button.
9. **Messages are hard to find.** A form shows only its **first** problem, as one red line at the bottom of the dialog (for example `ErrorText` in `customers/CustomersScreen.tsx`), not at the field, and in a tall dialog it can be out of sight. The result of a save ("saved", "deleted", a refusal) is a banner at the top of the page that pushes the list down (`setMessage` + `Alert` on 12 screens).

**The POS must not change at all** (owner, 2026-11-27). It imports the same `packages/ui` pieces (`Button`, `TextField`, `Input`, `OptionList`, `Dialog*`, `DialogActions`, `Panel`, `Kbd`, `KeyBar`, `AppFrame`) and the same `theme.css`, so restyling them there would restyle the counter.

## What the mockup shows (accepted by the owner, 2026-11-27)

- **Buttons:** 36px (small 32px), 8px corners, 14px semibold, an icon before the word on Add, Save and Cancel (answer 5) and where it helps elsewhere. Primary is the app's orange (`--accent`), not the reference image's mustard or black. Outline for Cancel, ghost for quiet actions, red only inside a confirmation.
- **Fields:** 36px, 14px text, 8px corners, a slightly stronger border than the panel lines; the label **above, in normal case, 13px semibold** (today: small capitals); a hint or an error under the field. On focus, an **orange border and a soft orange glow**.
- **Dropdowns:** our own list, not the browser's: the chosen option shown with ↕ arrows; the open list is a rounded card with a shadow and a **tick beside the chosen option**. ↑ ↓, Enter, Esc and typing a letter work.
- **Row actions:** icon buttons (pencil = Edit, person with ✕ = Deactivate, person with ✓ = Reactivate, bin = Delete) with a **tooltip** and the spoken name ("Edit Al-Noor Motors"); Delete turns red on hover and still asks first.
- **Lists:** the search and the filters sit in the table's own toolbar, with a count ("6 customers") at its end, not in a separate panel above.
- **Dialogs:** centred on the screen; the title at the top; the fields scroll in the middle; **the buttons fixed at the bottom right under a separator line**, Cancel then the main button. On a phone the dialog takes the full width, its two columns become one, and the buttons stay at the bottom.
- Light and dark, on the existing tokens.

## The owner's answers (2026-11-27)

The owner took the recommendation on all four questions and added two rules (5 and 6).

1. **The Esc / Enter key hints on dialog buttons: dropped in the back office**, as in the mockup and the reference. Esc still closes and Enter still submits, and screen readers still hear the shortcut (`aria-keyshortcuts`). The POS keeps its hints (POS-03).
2. **The focus colour: orange.** An orange border and glow on fields (the reference), and the same orange glow around buttons and links reached with Tab, so the back office has one focus look. Blue (`--focus`) stays in `theme.css` for the POS.
3. **Lists that keep growing** (the supplier on a goods receipt and a purchase return, "From an existing supplier" in Add customer) get a **searchable picker** (type a code or name, ↑ ↓ Enter), like the item search. The new dropdown is only for **short fixed lists** (Show: Active/Inactive/All, location, price tier, paid from, return reason, period). Rule: anything that can pass about 15 options gets the search.
4. **The responsiveness list:** the owner has none yet and accepted the plan without it. The passes apply the general rules under *Responsive* below. If a list comes later, items for a module whose pass hasn't started go into that pass; the rest become their own task after W2-15.
5. **Icons on the common buttons**, everywhere in the back office:

   | Button | Icon (lucide) |
   |---|---|
   | Add / New … (Add customer, New goods receipt, Add line…) | `Plus` |
   | Save (and Save changes) | `Save` |
   | Cancel | `X` |

   The icon sits before the word, 16px, hidden from screen readers (`aria-hidden`), so a button's spoken name doesn't change. The kit's `Button` takes `icon`, and the dialog footer sets Cancel's icon itself, so no screen can forget it. Other main buttons (Post, Receive, Delete, Deactivate…) keep the word only unless a screen's pass finds a clear icon; the row icons of the mockup stay as drawn.
6. **Messages: problems at the field, results in a toast** (the owner asked about putting validation in a toast; agreed on this split after discussion). See *Messages* under Design.

## Design

### Keeping the POS exactly as it is

| What | How |
|---|---|
| **No edits to shared files** | Nothing under `apps/pos/` or `packages/ui/` changes in any of the four tasks. The back office **composes** the shared Radix parts (`Dialog`, `DialogContent`, `Tooltip`, the shadcn `select.tsx`) with its own classes, which `cn` (tailwind-merge) lets override, and writes its own markup where needed. |
| **Back-office kit** | New folder `apps/backoffice/src/ui/` with `index.ts`: `Button` (variants primary/outline/ghost/danger, sizes default 36px and sm 32px, optional leading icon), `IconButton` (32px, required `label` used for `aria-label` and the tooltip, `tone="danger"`), `Field` + `TextInput` (replaces `TextField`/`Input` for the back office: label above, hint, error, `aria-describedby`/`aria-invalid` as today), `Select` (on the shadcn/Radix select), `Checkbox`, `FormDialog` and `ConfirmDialog` (below), `ListToolbar` (search with its icon, filters, count), `Toaster` + `notify` (answer 6). Same prop names as the shared ones where they overlap, so swapping an import is most of a screen's change. |
| **Back-office styles** | `apps/backoffice/src/styles.css` only: `button, [role='button'], summary, label[for], select { cursor: pointer }` and `:disabled { cursor: not-allowed }`; two new tokens under the back office's root, `--field-line` (field border: `#bcc5ce` light, `#3b4856` dark) and `--ring` (the orange glow: accent at 20% light, 28% dark). `theme.css` is not touched. |
| **A lint rule** | `eslint.config.js`: for `apps/backoffice/**`, `no-restricted-imports` names `Button`, `Input`, `TextField`, `LABEL_CLASS`, `DialogActions`, `Checkbox` from `@erp/ui` with "use the back office's own from `../ui`". It starts as a **warning** in W2-12 (old screens still use them) and becomes an **error** at the end of W2-15, when none are left. |
| **Proof, part 1: the diff** | Each task's verify step runs `git diff --name-only origin/staging...HEAD -- apps/pos packages/ui` and shows it **empty** in the PR. |
| **Proof, part 2: the POS look** | New `e2e/pos-look.spec.ts`, committed with its baseline **before any back-office change** in W2-12: Playwright `toHaveScreenshot` of the counter (empty bill and a 3-line bill), the payment pad, the Cash popup, the customer popup, the cash desk, the unlock screen and the setup screen, at 1366×768, light, with animations off and the clock and bill numbers masked. The baseline is taken by CI (Linux Chromium, the bundled fonts) from today's staging build and committed; every later PR must match it pixel for pixel (`maxDiffPixels: 0`). It stays as a permanent guard on the counter's look. |
| **Proof, part 3** | The existing POS e2e flows (`counter`, `till`, `sync`, `phone`) run unchanged. |

### The dialog (W2-12)

`apps/backoffice/src/ui/FormDialog.tsx`, used by every back-office form dialog (the 19 `FormDialog` uses; the screen search, `layout/ScreenSearch.tsx`, keeps its own command-palette dialog and only takes the new field and list look in W2-15):

- On the shared `Dialog`/`DialogContent` with back-office classes: centred (as today), `max-height: min(90dvh, 860px)`, `display: flex; flex-direction: column`, no padding of its own.
- **Header** (title in the display font, optional description, a close icon button), **body** (`overflow-y: auto`, the fields), **footer** (top border, `justify-content: flex-end`, Cancel with its ✕ then the main button, both 36px; the main button's icon comes from the dialog's `icon` prop, `Save` by default for edit forms). The form wraps all three, so Enter submits as today; Esc closes as today; focus returns to the opener (D-053) as today.
- **Widths:** `sm` 440px (confirmations: Deactivate, Delete, Reactivate), `md` 560px (default), `lg` 680px (Add customer, a supplier, a person).
- **Phone (under 640px):** full width with 12px margins, the body's grids one column, the footer still fixed at the bottom.
- `ConfirmDialog` = `FormDialog` at `sm` with the text and a danger or primary main button.

### The dropdown (W2-12)

`apps/backoffice/src/ui/Select.tsx` on the shadcn/Radix select (`packages/ui/src/components/ui/select.tsx`, composed, not edited): a 36px trigger with ↕, a popover card (12px corners, shadow, 4px padding), 34px options with the tick, ↑ ↓ / Home / End / typing / Enter / Esc from Radix. It is a `combobox` button with a `listbox`, not a native `<select>`, so tests choose an option differently: a helper `choose(page, label, option)` in `e2e/backoffice.ts` and `chooseOption(label, option)` for the component tests replace the 25 `selectOption` calls in 9 e2e files and the `selectOptions` in 2 component-test files, screen by screen as each screen changes.

### Messages: at the field and in a toast (answer 6)

| What happened | Where it shows |
|---|---|
| A field is wrong (empty name, a bad limit, terms over 365 days) | **At the field:** red border, short message under it (`Field`'s `error`, with `aria-invalid` and `aria-describedby`). **Every** wrong field is marked at once, not just the first. On Save, focus goes to the first wrong field and the dialog body scrolls to it. Messages appear only after Save is pressed and each clears as soon as its field is changed. |
| The server refuses one field (for example a code already taken) | At that field, the same way. Each screen maps the refusal codes that name a field; any other refusal goes to the toast. |
| Saved, deleted, deactivated, reactivated, posted | **Toast**, green, top-end corner (top right in English; logical side, rule 10), under the top bar, fades after about 4 seconds, can be closed. Replaces today's page banner, so the list no longer jumps. |
| A problem that isn't one field's (no connection, no permission, someone else changed the record, the server failed) | **Toast**, red, **stays until closed**. The dialog stays open with the entries kept. |

- **Built on Sonner** (the toast shadcn uses; free, MIT), added to `apps/backoffice` only through the workspace catalog (D-071), wrapped in the kit as `<Toaster />` (mounted once in the back-office frame) and `notify.done(text)` / `notify.problem(text)`. Screens never import Sonner directly (the lint rule names it). Success toasts are `role="status"`, problem toasts `role="alert"`, so tests that find today's banners by role still find them. If Sonner can't give those roles, the kit writes its own small toaster with the same API.
- Above an open dialog (its own layer), in light and dark, full width at the top on a phone.
- **Form checks return every problem** keyed by field (`{ field: message }`) instead of the first string; `FormDialog` takes `errors` and does the focus and scroll. Each screen's check is changed in its pass.
- **Not toasts:** standing states stay as banners on their page (a stock adjustment awaiting approval or rejected, a transfer still needed, a closed period); they describe the page, they aren't the result of an action.
- The POS has its own messages and is untouched.

### The keyboard fix (W2-13)

`ItemPicker.tsx` and `PartyPicker` (`accounting/data.tsx`): a highlighted row that ↑ ↓ / PageUp / PageDown move (the shared `moveSelection`, used as is), starting on the first hit and reset when the hits change; Enter picks the **highlighted** hit; Esc closes; the list scrolls to keep it in view; the input is a `combobox` with `aria-activedescendant` and `aria-expanded`, each hit an `option` with `aria-selected`. Mouse clicks unchanged. Both pickers get the new look in the same change (36px input, the dropdown card).

### Screens (W2-12 pilot, then W2-14 and W2-15)

Each screen: imports swapped to `../ui`; `size="lg"` and hand-set heights removed; `<select>` → `Select` (or the searchable picker, answer 3); row-action words → `IconButton`s; the **+**, Save and Cancel icons (answer 5); the form's checks to per-field problems and its result banner to toasts (answer 6); search and filters → `ListToolbar` inside the table's panel; dialogs → the new `FormDialog`; checked at 1440px, 1024px and 390px wide, light and dark.

| Task | Screens |
|---|---|
| **W2-12** (pilot) | **Customers** (list, Add/Edit dialog, Deactivate/Reactivate/Delete confirmations, the customer's page): as drawn in the mockup |
| **W2-14** | Suppliers; Purchasing (goods receipts list and screen, purchase returns, print labels); Catalog (items, item, new item, categories); Stock (stock screens, transfers, adjustments, stock card, transfer needed, stock settings) |
| **W2-15** | Sales (bills, returns, bill details, day reconciliation, cash variance); Accounting (money, vouchers, accounts, periods, expense categories); Settings (staff, a person, counters, shop and bill); the reports frame and its filters; sign-in and password screens; the frame's own controls (top-bar search, account menu) to the same sizes. Then the lint rule becomes an error. |

### Responsive (every screen in its pass)

- The frame already folds to a rail on narrow windows (D-114); unchanged.
- Page headers wrap (title above, buttons below) under 640px.
- Toolbars wrap; the search takes the full width on a phone.
- Wide tables scroll sideways **inside their panel**, never the whole page; the name column stays readable.
- Form grids go to one column under 640px; dialogs as above.
- A later list from the owner (answer 4) joins a pass not yet started, or becomes its own task after W2-15.

### Messages (rule 10)

No new words in the UI except the tooltip names, which reuse the existing keys (`customers.edit`, `customers.deactivate`…). New keys only for the dropdown's empty state, the dialog's and the toast's close button (`app.close`), and per-field messages where a form had one message for several fields (for example `customers.problems.limit` stays, a missing name gets its own key). The new icons add no words (answer 5). Today's key hints on dialog buttons go (answer 1); their `aria-keyshortcuts` stay.

## Tests

**Written first**

- **POS look** (`e2e/pos-look.spec.ts`), above: green on today's staging, committed with its baseline before anything else.
- **W2-13, the bug** (failing, then locked with `node .claude/hooks/bugfix-lock.mjs lock …`): `purchasing/ItemPicker.test.tsx` with three hits: ↓ ↓ Enter picks the **third**; ↑ at the top stays on the first; PageDown goes to the last; Esc closes without picking; the input's `aria-activedescendant` follows the highlight. The same cases for `PartyPicker` in `accounting/data.test.tsx`. And in `e2e/purchasing.spec.ts`: on a goods receipt line, type a name, ↓, Enter, and the **second** hit is the line's item.
- **Kit component tests** (`apps/backoffice/src/ui/ui.test.tsx`): `IconButton` has its accessible name and shows the tooltip on focus; `Field` wires the label, the hint and the error (`aria-describedby`, `aria-invalid`); `Select` opens with Enter or ↓, moves with ↑ ↓, picks with Enter, jumps on a typed letter, closes on Esc and reports the value; `Button` with `icon` renders it before the word and keeps the word as its name; `FormDialog` renders header, body and footer (Cancel with ✕, the main button with its icon), submits on Enter, closes on Esc and gives focus back, and its body is the scrolling part; with `errors` it marks every wrong field and puts focus on the first; `notify.done` shows a `status` toast that fades, `notify.problem` an `alert` toast that stays until closed. And for Customers (the pilot): saving with an empty name and a bad limit marks both fields and focuses the name; a refusal for a taken code marks the code field; a save shows the "saved" toast and no page banner.

**Kept green, changed only where a control's role changes**

- Component tests that find buttons by name keep passing (icon buttons keep the full name). Tests that read a `<select>` switch to `chooseOption`.
- e2e: `selectOption` calls → `choose`, file by file with their screens; the flows themselves unchanged. Assertions on a page banner's text read the toast instead (same role, same text).

## Verify

Per task: `pnpm check`; `pnpm e2e` (all flows, including `pos-look`); the diff check on `apps/pos` and `packages/ui` shown empty; the verifier's screenshots of every changed screen at 1440, 1024 and 390px, light and dark, in the PR.

## Order

1. **W2-12** (2 days): the POS look spec and its CI baseline, committed first → kit tests (failing) → `apps/backoffice/src/ui/`, the styles, the lint rule as a warning → Customers on the kit, matching the mockup, with its messages at the fields and in toasts → decision-log entry **D-127**: *the back office has its own controls in `apps/backoffice/src/ui`, composed from `packages/ui`; the POS and `packages/ui` are unchanged; back-office dialogs keep the button bar of D-053 at the bottom right under a separator, with the owner's answers 1–3 and 5; problems are shown at their field and results in a toast (answer 6)* (amends D-066 and D-053 for the back office) → the platform README: status and a short section on the kit.
2. **W2-13** (½ day, may run before or alongside W2-12, it touches different files): failing tests, lock, fix, unlock.
3. **W2-14** (2 days): its screens, in the order of the table.
4. **W2-15** (2 days): its screens; the lint rule to error; the README's status.

Each is its own branch off `staging` and its own PR.

## Risks

- **Screenshot tests can be flaky** (fonts, anti-aliasing). The baseline is taken and compared only in CI on one browser build; animations are off and moving text masked. If CI's Chromium updates and the baseline drifts, the baseline is re-taken from `staging` in its own PR (never from a branch that changes the look), so a POS change can't sneak in with it.
- **Radix select in tests:** jsdom lacks `scrollIntoView` and pointer capture that Radix uses; the test setup adds the two small shims shadcn's docs give. If that proves brittle, `Select` falls back to our own listbox on `moveSelection`/`OptionList` (as the POS does), with the same look.
- **Many small file changes** across about 32 screen files: each PR is one module group, reviewable on its own, and each screen's tests and e2e flow must pass before the next group starts.
- **Changing every form's checks** (answer 6) is logic, not only looks: each screen's existing tests must stay green, and the checks themselves (what counts as wrong) don't change, only where the message shows.
- **A screen that needs more than restyling** (a layout that doesn't work on a phone at all) is listed in the PR and taken as its own task rather than growing the pass.

## Out of scope

- Any change to the POS, its sizes or its key hints, and any edit to `packages/ui`.
- New colours or a new brand colour (the reference's mustard/black buttons): the existing tokens stay.
- Table sorting, column choices, paging or other new list features.
- Printed layouts (reports on paper, labels, bills).

## W2-12 as built (2026-11-27)

- **POS guard first:** `e2e/pos-look.spec.ts` sets up a counter of its own (after `counter.spec`) and compares six screens: setup, unlock, the empty counter, a 3-line bill, the Cash popup and the customer popup. The cash desk isn't in it: setting one up needs a cashier, which `till.spec` creates later. It is one test, so a first run writes all six pictures. The baseline came from CI run 45957917404, on code identical to staging, and was committed before any back-office change; the next run passed on it.
- **The lint rule** is an **error** from the start, with the screens not yet moved listed in it, instead of a warning: `pnpm lint` fails on any warning (`--max-warnings 0`). Each pass takes its screens off the list; W2-15 removes it.
- **Toasts:** our own small toaster (`src/ui/notify.tsx`), as the plan allowed, because Sonner gives its toasts no `status`/`alert` role and announces problems as politely as results.
- **The dialog's close ✕** sits after the form and has no tooltip, so a dialog opens with focus on its first field and Esc closes the dialog, not a tooltip.
- **Add customer's "From an existing supplier"** uses the new dropdown for now; it becomes the searchable picker (answer 3) with W2-13, which rebuilds the pickers.
- **Customers** now also says *added* in a toast after Add (the key existed, unused), and checks a missing name before sending (`customers.problems.name`).
