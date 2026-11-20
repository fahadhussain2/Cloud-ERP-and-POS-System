import bo from '../apps/backoffice/src/locales/en.json' with { type: 'json' };
import { account, signOut } from './backoffice';
import { expect, test } from './counter-test';
import { BACKOFFICE_PORT, OWNER, OWNER_PASSWORD, SHOP } from './fixtures';

// W1-28 plan: the owner lands on the Dashboard (W2-06, D-118; Customers before it), folds the menu into a rail, opens Stock → Transfers from it, finds the
// rail again after a reload, reaches Trace a bill by the search (Ctrl K), and signs out from the account menu. Back
// office only, in a browser context of its own so the folded menu stays out of the other flows; after counter.spec,
// which gives the owner their own password.

const BACKOFFICE = `http://localhost:${BACKOFFICE_PORT}`;

test('the owner folds the menu into a rail, opens a screen from it, and finds another by the search', async ({
  browser,
}) => {
  const office = await browser.newContext();
  const page = await office.newPage();
  await page.goto(BACKOFFICE);
  await page.getByLabel(bo.login.shopCode).fill(SHOP);
  await page.getByLabel(bo.login.username).fill(OWNER.username);
  await page.getByLabel(bo.login.password).fill(OWNER_PASSWORD);
  await page.getByRole('button', { name: bo.login.submit }).click();

  const nav = page.getByRole('navigation', { name: bo.nav.menu });
  await expect(nav.getByRole('link', { name: bo.nav.dashboard })).toHaveAttribute('aria-current', 'page');
  await expect(account(page)).toContainText(OWNER.fullName);

  await page.getByRole('button', { name: bo.nav.collapse }).click();
  await expect(nav.getByRole('link', { name: bo.nav.items })).toHaveCount(0);
  await nav.getByRole('button', { name: bo.nav.groups.stock }).click();
  await page.getByRole('menuitem', { name: bo.nav.transfers }).click();
  await expect(page).toHaveURL(/#\/stock\/transfers$/);
  await expect(page.getByRole('heading', { name: bo.inventory.transfers.title })).toBeVisible();
  await expect(page.getByRole('banner')).toContainText(bo.nav.groups.stock);

  await page.reload();
  await expect(page.getByRole('button', { name: bo.nav.expand })).toBeVisible();

  await page.keyboard.press('Control+K');
  await page.getByRole('combobox', { name: bo.nav.searchLabel }).fill('trace');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/support\/trace$/);
  await expect(page.getByRole('heading', { name: bo.support.trace.title })).toBeVisible();

  await signOut(page);
  await office.close();
});
