import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['apps/*', 'packages/*', 'tools/*'],
    coverage: {
      provider: 'v8',
      include: ['apps/*/src/**', 'packages/*/src/**', 'tools/*/src/**'],
      exclude: ['**/*.test.{ts,tsx}', '**/main.{ts,tsx}'],
      reporter: ['text-summary', 'html'],
      thresholds: {
        // Checkout rules must be fully covered (architecture §12, D-071).
        'packages/domain/src/**': { lines: 100, branches: 100, functions: 100, statements: 100 },
      },
    },
  },
});
