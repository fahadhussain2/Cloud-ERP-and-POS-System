# W0-01 Monorepo skeleton and one-command checks

| | |
|---|---|
| **Issue** | [#2](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/2) |
| **Module** | devops |
| **Status** | Accepted (2026-10-21) |
| **Refs** | Architecture §2, §3, §12; D-027, D-037, D-038, D-066, D-070, D-071 |
| **Size** | about 1 day |

## Goal

A TypeScript monorepo where every check runs with one command from the root, so every later task starts from green checks.

## Tooling choices (D-071)

| Choice | Why |
|---|---|
| **Node.js 24 LTS**, pinned in `.nvmrc` and `engines` | It is the current LTS. CI and Docker use the same version. |
| **pnpm 11 workspaces**, pinned with `packageManager` | Fast installs and strict dependencies. It is already installed. |
| **No Turborepo yet** | `pnpm -r` is enough for 12 packages. Add caching later only if checks get slow. |
| **Internal packages are used as TypeScript source**, with no build step of their own. Apps bundle them. | No build order to manage, and fast feedback. |
| **ESM everywhere**, `strict` TypeScript plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` | Catches undefined lookups and optional mix-ups at compile time. |
| **ESLint (flat config) + typescript-eslint + Prettier** | The post-edit hook already calls them. |
| **Vitest** with one root config that lists every package as a project, plus coverage | Same runner for unit and golden tests. |

## Scope

1. Branches: create `staging` from `main` and push it. This task is built on `w0-01-monorepo-skeleton`, which branches off `staging`.
2. Root files:
   - `package.json` with scripts `lint`, `format`, `typecheck`, `test`, `build`, `check` (runs all of them)
   - `pnpm-workspace.yaml`, `.nvmrc`
   - `tsconfig.base.json`, `eslint.config.js`, `.prettierrc`, `.prettierignore`, `vitest.config.ts`
   - `.editorconfig`, `.gitattributes`
3. Skeletons, each with `package.json`, `tsconfig.json`, `src/index.ts` and one smoke test:
   - **Apps:**
     - `apps/api`: Fastify with `GET /api/health`, which the deploy health check needs in W0-04. Built with tsup.
     - `apps/worker`: an entry point only.
     - `apps/pos` and `apps/backoffice`: Vite + React + TypeScript showing one placeholder screen. The text comes from an i18n key through a minimal i18next setup (rule 10).
   - **Packages:** `domain`, `contracts`, `db`, `posting`, `ui`, `observability`. These are empty modules for now; the real content comes in later tasks.
   - **Tools:** `tools/legacy-import`, a CLI entry that only prints its usage. It reads no data.
4. Lint rules that make the non-negotiable rules cheap to keep:
   - `packages/domain`:
     - no I/O imports (`node:*`, `fs`, `http`, fetch)
     - no `Date.now()`, `new Date()` without arguments, `Math.random()`, `parseFloat`, or `toFixed`
     - no imports from other internal packages except `contracts`
   - `packages/posting` and `packages/db` may not be imported by `apps/pos` or `apps/backoffice`.
   - `no-floating-promises` and `consistent-type-imports` everywhere.
5. Coverage: a **100% threshold** on `packages/domain`. It holds now and stays enforced from the first rule onwards.
6. `.env.example` files for `apps/api` and `apps/worker` with placeholders only. `.gitignore` adds `node_modules`, `dist`, `coverage`, `.env*` except `.env.example`, and `*.tsbuildinfo`.
7. Fill in the **Commands** section of `CLAUDE.md`.

**Out of scope:** CI (W0-02), Docker and Caddy (W0-03/04), the database (W0-07), real UI components (Wave 1).

## Order

1. Create the branches, then add the root config.
2. Add the package skeletons and their smoke tests.
3. Add the apps.
4. Add the lint boundaries, and prove each one with a deliberately bad sample that fails. The samples are removed before the commit.
5. Update `CLAUDE.md` and run the checks from a clean clone.

## Tests that prove it

- [x] On a fresh clone, `pnpm install && pnpm check` exits 0. The output is shown in the PR.
- [x] Each package's smoke test runs: `GET /api/health` returns 200 `{status:"ok"}` through Fastify `inject`, and the POS placeholder renders its i18n key.
- [x] Boundary rules fail as expected on bad samples, for example `Date.now()` or an `fs` import in `packages/domain`. The ESLint output is shown in the PR.
- [x] Editing a `.ts` file triggers the post-edit hook (Prettier fixes the formatting).
- [x] `pnpm build` produces `apps/api/dist`, `apps/pos/dist` and `apps/backoffice/dist`.
- [x] `git status` is clean after the checks run, so no generated files are left untracked.

## Risks

| Risk | Mitigation |
|---|---|
| Prettier reformats the approved docs (the hook runs on `.md` files) | `.prettierignore` excludes `docs/`, `*.md` at the root and `sql_dump/`. |
| Windows line endings (CRLF warnings today) | `.gitattributes` with `* text=auto eol=lf`. |
| Local Node is 22.14; the project pins 24 | The owner installs Node 24 LTS. `engines` warns until then. |
| Too many dependencies too early | Only the tools above. React, Fastify and i18next go only in the apps that use them. |

## Owner actions

- Install Node.js 24 LTS on the development PC. *Done.*

## Changes made while building

| Change | Why |
|---|---|
| **TypeScript 6.0**, not 7.0 | typescript-eslint supports TypeScript only up to 6.0. Move to 7 when it does. |
| No `.npmrc`. pnpm 11 settings live in `pnpm-workspace.yaml`: a version **catalog** (one version of each tool for every package) and `allowBuilds: esbuild` | pnpm 11 moved its settings out of `.npmrc` and blocks install scripts unless they are allowed. |
| pnpm's **minimum release age** is kept. No exclusions; the catalog uses ranges that resolve to versions at least a day old. | Protects against a freshly published compromised package. |
| The POS and back office also may not import **`@erp/db`** (not only `@erp/posting`) | The database package is server-only as well. |
| `pnpm typecheck` also checks the root config files | `vitest.config.ts` would otherwise go unchecked. |
| Prettier config is `.prettierrc.json` | Same as `.prettierrc`, with an explicit format. |
| **The post-edit hook now runs Prettier and ESLint through Node directly, not through the shell** | Through the shell, the hook failed on the space in "Zorbix Products". Found while testing it here. |
| On this PC, nvm's Node 22 comes before Node 24 on the PATH | Run `nvm install 24` then `nvm use 24` (or remove nvm) so terminals use Node 24. |
