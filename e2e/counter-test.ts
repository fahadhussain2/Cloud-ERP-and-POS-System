import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, test as base, type BrowserContext, type Page } from '@playwright/test';

// A counter is a normal browser profile, not an off-the-record one. One profile for the whole run, so the flows build
// on the same counter, as on a shop PC.

export const test = base.extend<{ page: Page; context: BrowserContext }, { profile: BrowserContext }>({
  profile: [
    async ({ channel }, use) => {
      const dir = await mkdtemp(join(tmpdir(), 'erp-e2e-'));
      const context = await chromium.launchPersistentContext(dir, {
        ...(channel ? { channel } : {}),
      });
      // Chrome grants permanent storage to the installed POS (infra/counter-setup.md), which automation cannot do.
      // The flows run as on such a counter; the refusal itself is covered by storage/checks.test.ts and checked on
      // staging (W1-02 plan, Verify 2).
      await context.addInitScript(() => {
        navigator.storage.persisted = () => Promise.resolve(true);
        navigator.storage.persist = () => Promise.resolve(true);
      });
      await use(context);
      await context.close();
      await rm(dir, { recursive: true, force: true });
    },
    { scope: 'worker' },
  ],
  context: async ({ profile }, use) => use(profile),
  page: async ({ profile }, use, testInfo) => {
    const page = await profile.newPage();
    await use(page);
    // A persistent profile records no trace: keep what the counter showed when a flow fails.
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('page.txt', {
        body: await page.locator('body').innerText(),
        contentType: 'text/plain',
      });
      await testInfo.attach('page.png', { body: await page.screenshot(), contentType: 'image/png' });
    }
    await page.close();
  },
});

export { expect } from '@playwright/test';
