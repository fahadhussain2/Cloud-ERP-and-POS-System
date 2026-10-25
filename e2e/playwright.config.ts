import { defineConfig, devices } from '@playwright/test';

import { API_PORT, BACKOFFICE_PORT, POS_PORT } from './fixtures';

// End-to-end flows on the built apps (W1-02 plan scope 5): the API on a fresh erp_e2e database, and the POS and back
// office served by `vite preview`, each with /api on its own origin as behind the edge proxy (D-065).

const databaseUrl = process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:54329/postgres';
const apiUrl = `http://127.0.0.1:${API_PORT}`;

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  // The flows share one database and build on each other.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    // CI uses Playwright's Chromium; locally an installed Chrome or Edge can be used instead (E2E_CHANNEL=msedge).
    ...(process.env['E2E_CHANNEL'] ? { channel: process.env['E2E_CHANNEL'] } : {}),
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm exec tsx seed.ts',
      url: `${apiUrl}/api/health`,
      env: { DATABASE_URL: databaseUrl },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm --dir ../apps/pos exec vite build && pnpm --dir ../apps/pos exec vite preview --port ${POS_PORT} --strictPort`,
      url: `http://localhost:${POS_PORT}`,
      env: { API_URL: apiUrl },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm --dir ../apps/backoffice exec vite build && pnpm --dir ../apps/backoffice exec vite preview --port ${BACKOFFICE_PORT} --strictPort`,
      url: `http://localhost:${BACKOFFICE_PORT}`,
      env: { API_URL: apiUrl },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
