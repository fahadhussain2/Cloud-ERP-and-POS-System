import type { Page } from '@playwright/test';

import bo from '../apps/backoffice/src/locales/en.json' with { type: 'json' };
import { account, report, signOut } from './backoffice';
import { expect, test } from './counter-test';
import { BACKOFFICE_PORT, OWNER, OWNER_PASSWORD, SHOP } from './fixtures';

// W2-07 plan (PLT-13, D-120): the owner picks Dark in the account menu; it shows at once, a reload keeps it, the
// sign-in screen keeps it after signing out, and a fresh browser gets it from the server. Paper uses the light colours
// even from a dark screen. The owner goes back to System at the end, so the other flows are unchanged. After
// counter.spec, which gives the owner their own password.

const BACKOFFICE = `http://localhost:${BACKOFFICE_PORT}`;

const shown = (page: Page) => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
/** The muted text colour the page uses now (the light theme's is #586572 = rgb(88, 101, 114)). */
const muted = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--muted').trim());

async function signIn(page: Page) {
  await page.goto(BACKOFFICE);
  await page.getByLabel(bo.login.shopCode).fill(SHOP);
  await page.getByLabel(bo.login.username).fill(OWNER.username);
  await page.getByLabel(bo.login.password).fill(OWNER_PASSWORD);
  await page.getByRole('button', { name: bo.login.submit }).click();
  await expect(account(page)).toContainText(OWNER.fullName);
}

async function choose(page: Page, name: string) {
  await account(page).click();
  await page.getByRole('group', { name: bo.nav.theme }).getByRole('button', { name }).click();
  await page.keyboard.press('Escape');
}

test('the owner chooses Dark; it stays on this browser and follows them to another', async ({ browser }) => {
  const office = await browser.newContext({ colorScheme: 'light' });
  const page = await office.newPage();
  await signIn(page);
  expect(await shown(page)).toBe('light');

  await choose(page, bo.nav.themes.dark);
  await expect.poll(() => shown(page)).toBe('dark');
  expect(await muted(page)).toBe('#94a1ad');

  await page.reload();
  await expect(account(page)).toBeVisible();
  expect(await shown(page)).toBe('dark');

  // Paper: a report printed from the dark screen takes the light colours (owner answer 5).
  await report(page, bo.nav.trialBalance);
  await page.emulateMedia({ media: 'print' });
  expect(await muted(page)).toBe('#586572');
  await page.emulateMedia({ media: 'screen' });

  await signOut(page);
  expect(await shown(page)).toBe('dark');

  // Another browser, set to light: the server's Dark wins once signed in.
  const other = await browser.newContext({ colorScheme: 'light' });
  const second = await other.newPage();
  await signIn(second);
  await expect.poll(() => shown(second)).toBe('dark');

  // System follows the browser's setting.
  await choose(second, bo.nav.themes.system);
  await expect.poll(() => shown(second)).toBe('light');
  await second.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => shown(second)).toBe('dark');
  await signOut(second);
  await other.close();
  await office.close();
});
