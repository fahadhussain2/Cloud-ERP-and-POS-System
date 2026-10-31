import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['apps/*', 'packages/*', 'tools/*'],
    coverage: {
      provider: 'v8',
      include: ['apps/*/src/**', 'packages/*/src/**', 'tools/*/src/**'],
      exclude: ['**/*.test.{ts,tsx}', '**/main.{ts,tsx}', '**/testing/**'],
      reporter: ['text-summary', 'html'],
      thresholds: {
        // Checkout rules must be fully covered (architecture §12, D-071).
        'packages/domain/src/**': { lines: 100, branches: 100, functions: 100, statements: 100 },
        // The posting engine decides every ledger row (W1-08); its database layer is covered by integration tests.
        'packages/posting/src/{sale,cost,replay,dates}.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        // The legacy parser decides what is stored and what is dropped (D-084).
        'tools/legacy-import/src/{parse,datetime,columns}.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        // The legacy mapping rules decide what every item and party becomes (D-085).
        'tools/legacy-import/src/transform/{rules,mapping}.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
      },
    },
  },
});
