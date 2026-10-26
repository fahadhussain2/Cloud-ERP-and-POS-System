# `@erp/ui`

The building blocks every screen uses (W1-03, D-066): shadcn/ui components on Radix and Tailwind CSS, themed with the Tijara POS prototype's colour tokens, plus our keyboard layer. Plain components: no data fetching, no app state.

## Using it in an app

- Add `@tailwindcss/vite` to the app's Vite config.
- The app's CSS entry: `@import 'tailwindcss' source(none);`, `@import '@erp/ui/theme.css';`, and `@source` lines for the app's `src` and `packages/ui/src` (see `apps/pos/src/styles.css`).
- Import the fonts once: `import '@erp/ui/fonts';` (bundled, so they work offline; precache `woff2` in the PWA).

## Rules

- **Colours only from the tokens** (`bg-surface`, `text-muted`, `border-line`, `bg-accent`…): Tailwind's own palette is switched off. Dark values exist under `[data-theme='dark']`; the switcher is PLT-13 (Wave 2).
- **Logical utilities only** (`px`, `ms`, `pe`, `text-start`, `start-0`), never `ml`/`left`, so layouts work right-to-left (CLAUDE.md rule 10).
- **No text in components:** labels come in as props from the app's i18n keys.
- Every dialog ends with `DialogActions`: *Cancel (Esc)* plus a main button named after its action (D-053).

## What exists

| Block | Use |
|---|---|
| `AppFrame` | The one-screen frame: status on top, work area, key bar at the bottom |
| `Panel` | A white panel with an optional upper-case title |
| `Button` (`buttonVariants`) | `default`, `primary`, `ghost`, `danger`; sizes `sm`, `default`, `lg` |
| `Field`, `Input`, `Label` | A labelled input with hint and error, wired for screen readers |
| `Dialog`, `DialogContent`, `DialogBody`, `DialogActions` | Radix dialog: focus trap, Esc cancels, focus returns |
| `Alert`, `Badge` | A message in a screen; a short state chip |
| `OptionList`, `moveSelection` | A list moved by ↑ ↓ while focus stays in a search box |
| `KeyBar`, `Kbd`, `useShortcuts`, `matchKey` | Shortcut hints (each also a button) and the window-wide key layer (POS-03) |
| `formatMoney` | Minor units in the tenant's locale and currency; whole amounts without decimals |

Tested in jsdom (`src/ui.test.tsx`).
