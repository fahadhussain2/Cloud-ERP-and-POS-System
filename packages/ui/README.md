# `@erp/ui`

The building blocks every screen uses (W1-03, D-066): **shadcn/ui components from the shadcn CLI**, on Radix and Tailwind CSS, themed with the Tijara POS prototype's colour tokens, plus our own keyboard layer and formatting. Plain components: no data fetching, no app state.

## Adding a shadcn/ui component

```bash
pnpm --filter @erp/ui ui:add <name> [more names]
```

- Runs the CLI at a pinned version (`scripts/shadcn-add.ts`), with `components.json` here. Files land in `src/components/ui/`; export what the apps need from `src/index.ts`.
- The script also fixes a CLI quirk: its import rewriting turns our utils alias (`@erp/ui/lib/utils`) into a package named `cn` and installs it. The script points the imports back and removes that package.
- New dependencies the CLI installs go into the pnpm catalog at a version **at least two weeks old** (as for every dependency).
- The generated files are ours to change, but **prefer theming through `theme.css` and `className`** over editing them, so a later `ui:add <name>` (with `--overwrite`) brings upstream fixes without losing anything.
- **One edit is always needed:** the CLI writes some physical utilities. After adding or overwriting, change them to logical ones (rule 10): in `select` `pr-8 pl-2` → `pe-8 ps-2` and `right-2` → `end-2`; in `table` `text-left` → `text-start` and `pr-0` → `pe-0`. A test checks the table header.

## Using it in an app

- Add `@tailwindcss/vite` to the app's Vite config.
- The app's CSS entry: `@import 'tailwindcss' source(none);`, `@import 'tw-animate-css';`, `@import '@erp/ui/theme.css';`, and `@source` lines for the app's `src` and `packages/ui/src` (see `apps/pos/src/styles.css`).
- Import the fonts once: `import '@erp/ui/fonts';` (bundled, so they work offline; precache `woff2` in the PWA).

## Rules

- **Colours only from the tokens.** shadcn/ui's names map to the prototype: `primary` (the orange), `muted-foreground` (secondary text), `muted`/`secondary` (light grey surfaces), `accent` (hover/selection), `destructive`, `border`/`input`, `ring`. Ours add `bg`, `surface`, `surface-2`, `ink`, `line`, `primary-soft`, `ok`/`warn`/`bad` (with `-soft`), `focus`, `select`. Tailwind's own palette is switched off. Dark values exist under `[data-theme='dark']`; the switcher is PLT-13 (Wave 2).
- **Logical utilities only** (`px`, `ms`, `pe`, `text-start`, `start-0`), never `ml`/`left`, so layouts work right-to-left (CLAUDE.md rule 10).
- **No text in components:** labels come in as props from the app's i18n keys. shadcn's `DialogContent` has an English "Close" label on its corner button: use `showCloseButton={false}` and end the dialog with `DialogActions`.
- Every dialog ends with `DialogActions`: *Cancel (Esc)* plus a main button named after its action (D-053).

## What exists

| Block | From | Use |
|---|---|---|
| `Button` (`buttonVariants`) | shadcn CLI | `default` (orange), `outline`, `secondary`, `ghost`, `destructive`, `link`; sizes `xs`, `sm`, `default`, `lg`, `icon…` |
| `Input`, `Label` | shadcn CLI | Plain field parts |
| `Checkbox` | shadcn CLI | Radix checkbox; wrap it in a `label` so the text is its name |
| `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem`… | shadcn CLI | Radix select: keyboard- and RTL-correct |
| `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell`… | shadcn CLI | Data tables in the back office |
| `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`, `DialogClose`, `DialogTrigger` | shadcn CLI | Radix dialog: focus trap, Esc cancels, focus returns |
| `Alert`, `AlertTitle`, `AlertDescription` | shadcn CLI | A message in a screen (text goes in `AlertDescription`) |
| `Badge` | shadcn CLI | A short state chip; states like Dormant use `variant="outline"` with `bg-warn-soft text-warn` |
| `TextField`, `LABEL_CLASS` | ours | A labelled input with hint and error, wired for screen readers, in the prototype's style |
| `DialogActions` | ours | The D-053 button bar |
| `AppFrame`, `Panel` | ours | The one-screen frame; a white panel with an optional title |
| `PageHeader` | ours | A back-office screen's title, help line and main action (W1-04) |
| `StatusChip` | ours | A state chip in the prototype's tones: `ok`, `warn`, `bad`, `accent`, `neutral` |
| `OptionList`, `moveSelection` | ours | A list moved by ↑ ↓ while focus stays in a search box |
| `KeyBar`, `Kbd`, `useShortcuts`, `matchKey` | ours | Shortcut hints (each also a button) and the window-wide key layer (POS-03) |
| `formatMoney` | ours | Minor units in the tenant's locale and currency, exact; whole amounts without decimals |

Tested in jsdom (`src/ui.test.tsx`).
