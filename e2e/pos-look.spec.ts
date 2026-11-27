import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, type BrowserContext, type Page } from '@playwright/test';

import bo from '../apps/backoffice/src/locales/en.json' with { type: 'json' };
import pos from '../apps/pos/src/locales/en.json' with { type: 'json' };
import { menu, signInAsOwner } from './backoffice';
import { expect, test } from './counter-test';
import { OWN_PIN, POS_PORT, SALESMAN, SHOP } from './fixtures';

// W2-12 plan, "Keeping the POS exactly as it is": the counter's look, pixel for pixel. The back office's restyle
// (W2-12 to W2-15) must not change a single pixel of the POS (owner, 2026-11-27), so this compares the counter's
// screens with pictures taken from staging before the restyle began. A difference fails CI.
//
// After counter.spec (the salesman's own PIN, the customers). It sets up a counter of its own in a fresh profile, so
// the shared counter the other flows build on is untouched, and it finishes no bill. The pictures are Linux Chromium's
// (CI's); fonts render differently elsewhere, so other platforms skip it. A new baseline is only ever taken from
// staging, in a PR of its own (plan, Risks).

const POS = `http://localhost:${POS_PORT}`;
const SCREEN = { width: 1366, height: 768 };

test.describe.configure({ mode: 'serial' });
test.skip(
  process.platform !== 'linux',
  "The baseline is CI's Linux Chromium; fonts differ on other platforms.",
);

const look = async (page: Page, name: string) => {
  await expect(page).toHaveScreenshot(`${name}.png`, {
    maxDiffPixels: 0,
    animations: 'disabled',
    caret: 'hide',
    stylePath: join(import.meta.dirname, 'pos-look.css'),
  });
};

let counter: BrowserContext;
let dir = '';
let page: Page;

test.beforeAll(async ({ channel }) => {
  dir = await mkdtemp(join(tmpdir(), 'erp-look-'));
  counter = await chromium.launchPersistentContext(dir, {
    ...(channel ? { channel } : {}),
    viewport: SCREEN,
    colorScheme: 'light',
    locale: 'en-US',
  });
  await counter.addInitScript(() => {
    navigator.storage.persisted = () => Promise.resolve(true);
    navigator.storage.persist = () => Promise.resolve(true);
    window.print = () => undefined;
  });
  page = await counter.newPage();
});

test.afterAll(async () => {
  await counter.close();
  await rm(dir, { recursive: true, force: true });
});

test('the setup screen and the unlock screen look as before', async ({ browser }) => {
  await page.goto(POS);
  await expect(page.getByRole('heading', { name: pos.setup.title })).toBeVisible();
  await look(page, 'setup');

  // A one-time code from the back office, in a window of its own.
  const office = await (await browser.newContext()).newPage();
  await signInAsOwner(office);
  await menu(office, bo.nav.counters);
  await office.getByRole('button', { name: bo.counters.create }).click();
  const code = (await office.getByRole('status').locator('strong').textContent()) ?? '';
  expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  await office.context().close();

  await page.getByLabel(pos.setup.shopCode).fill(SHOP);
  await page.getByLabel(pos.setup.code).fill(code);
  await page.getByRole('button', { name: pos.setup.submit }).click();
  await expect(page.getByRole('button', { name: new RegExp(SALESMAN.fullName) })).toBeVisible();
  await look(page, 'unlock');
});

test('the counter, a bill of three lines, the Cash popup and the customer popup look as before', async () => {
  await page.getByRole('button', { name: new RegExp(SALESMAN.fullName) }).click();
  await page.getByLabel(pos.unlock.pin).fill(OWN_PIN);
  await page.getByRole('button', { name: pos.unlock.submit }).click();
  const box = page.getByRole('combobox');
  await expect(box).toBeVisible();
  await expect(page.locator('.status-bar .online')).toBeVisible();
  await expect(page.getByText(pos.bill.empty)).toBeVisible();
  await look(page, 'counter-empty');

  const lines = page.getByRole('listbox', { name: pos.keys.lines }).getByRole('option');
  for (const [i, text] of ['brpd001', 'fnbl001', '1.5*hose'].entries()) {
    await box.fill(text);
    await expect(
      page.getByRole('listbox', { name: pos.search.results }).getByRole('option').first(),
    ).toBeVisible();
    await box.press('Enter');
    await expect(lines).toHaveCount(i + 1);
  }
  await expect(page.getByTestId('bill-total')).toHaveText(/Rs\s6,100/);
  await look(page, 'counter-bill');

  await page.keyboard.press('F9');
  await expect(page.getByRole('dialog').getByLabel(pos.pay.cashReceived)).toBeVisible();
  await look(page, 'cash-popup');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.keyboard.press('F4');
  await expect(page.getByRole('dialog', { name: pos.customer.title })).toBeVisible();
  await look(page, 'customer-popup');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Leave nothing behind: the bill is cleared, never paid.
  await page.keyboard.press('Alt+C');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: new RegExp(`^${pos.clear.action}`) })
    .click();
  await expect(page.getByText(pos.bill.empty)).toBeVisible();
});
