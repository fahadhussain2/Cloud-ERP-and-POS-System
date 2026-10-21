import { defineConfig } from 'vitest/config';

// Integration tests (*.int.test.ts) run against a real PostgreSQL given by DATABASE_URL.
// CI provides one; `pnpm test` never runs them.
export default defineConfig({
  test: {
    include: ['{apps,packages,tools}/*/src/**/*.int.test.ts'],
    environment: 'node',
    globalSetup: ['./vitest.integration.setup.ts'],
    // Tests share one database, so files run one at a time.
    fileParallelism: false,
  },
});
