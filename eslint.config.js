// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const PURE = 'packages/domain must stay pure and deterministic (CLAUDE.md rule 2)';

export default defineConfig(
  { ignores: ['**/dist/**', '**/coverage/**', '.claude/**', 'docs/**', 'sql_dump/**'] },

  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/pos/**/*.{ts,tsx}', 'apps/backoffice/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest']],
    languageOptions: { globals: globals.browser },
  },

  // Boundaries that keep the non-negotiable rules (D-071).
  {
    files: ['packages/domain/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: `${PURE}: no Node.js modules.` },
            {
              group: ['fs', 'fs/*', 'path', 'http', 'https', 'net', 'os', 'child_process', 'crypto'],
              message: `${PURE}: no I/O.`,
            },
            { group: ['@erp/*', '!@erp/contracts'], message: `${PURE}: it may import only @erp/contracts.` },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...['fetch', 'process', 'XMLHttpRequest', 'localStorage', 'indexedDB', 'crypto'].map((name) => ({
          name,
          message: `${PURE}: no I/O or environment access.`,
        })),
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: `${PURE}: pass the time in as an argument.`,
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: `${PURE}: pass the time in as an argument.`,
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: `${PURE}: no randomness.`,
        },
        {
          selector:
            "CallExpression[callee.name='parseFloat'], CallExpression[callee.property.name='parseFloat']",
          message: `${PURE}: money and quantities are integers (CLAUDE.md rule 1).`,
        },
        {
          selector: "CallExpression[callee.property.name='toFixed']",
          message: `${PURE}: money and quantities are integers (CLAUDE.md rule 1).`,
        },
      ],
    },
  },
  {
    files: ['apps/pos/**/*.{ts,tsx}', 'apps/backoffice/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@erp/posting', '@erp/posting/*', '@erp/db', '@erp/db/*'],
              message: 'Server-only package: posting and the database stay in the API (CLAUDE.md rule 4).',
            },
          ],
        },
      ],
    },
  },

  // The back office's own controls (W2-12, D-127): its screens use apps/backoffice/src/ui, not packages/ui's, which
  // stay as the POS has them. Every screen moved by W2-15; only the kit itself composes the shared ones.
  {
    files: ['apps/backoffice/src/**/*.{ts,tsx}'],
    ignores: ['apps/backoffice/src/ui/**', '**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@erp/ui',
              importNames: ['Button', 'Input', 'TextField', 'LABEL_CLASS', 'DialogActions', 'Checkbox'],
              message:
                "Use the back office's own control from src/ui (W2-12, D-127); packages/ui's stay as the POS has them.",
            },
          ],
        },
      ],
    },
  },

  prettier,
);
