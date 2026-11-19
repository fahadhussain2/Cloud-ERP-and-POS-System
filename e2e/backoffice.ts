import { expect, type Page } from '@playwright/test';

import bo from '../apps/backoffice/src/locales/en.json' with { type: 'json' };
import { BACKOFFICE_PORT, OWNER, OWNER_PASSWORD, SHOP } from './fixtures';

// The back office's frame, shared by the flows (W1-28): the side menu, whose groups open and close, and the account
// menu that holds Sign out.

/**
 * Follows a menu entry by its name. A closed group hides its entries, so the closed groups are opened first. For the
 * expanded menu, as a fresh browser shows it; the rail has its own flow (shell.spec).
 */
export async function menu(page: Page, name: string): Promise<void> {
  const nav = page.getByRole('navigation', { name: bo.nav.menu });
  await expect(nav).toBeVisible();
  const link = nav.getByRole('link', { name, exact: true });
  // Opening a group takes it out of this set, so always open the first one left.
  const closed = nav.locator('button[aria-expanded="false"]');
  while (!(await link.isVisible()) && (await closed.count()) > 0) await closed.first().click();
  await link.click();
}

/** Opens a report from the Reports home, the menu's Reports row (W2-01, owner answer 1), by its name. */
export async function report(page: Page, name: string): Promise<void> {
  await menu(page, bo.nav.reports);
  await expect(page.getByRole('heading', { name: bo.reports.home.title, level: 1 })).toBeVisible();
  await page
    .getByRole('main')
    .getByRole('link', { name: new RegExp(`^${name}`) })
    .click();
}

/** The account's button at the foot of the side menu, whoever is signed in. */
export const account = (page: Page) =>
  page.getByRole('button', { name: new RegExp(`^${bo.nav.account.replace('{{name}}', '')}`) });

export async function signOut(page: Page): Promise<void> {
  await account(page).click();
  await page.getByRole('menuitem', { name: bo.nav.signOut }).click();
  await expect(page.getByLabel(bo.login.shopCode)).toBeVisible();
}

/**
 * The owner, signed in: kept when the shared browser profile already has them, else signed in afresh. The API takes 20
 * sign-ins a minute from one address (auth routes), and every flow signs in from the same one, so the read-only report
 * flows don't spend one per test (CI, 2026-11-19: a full run hit the limit at till.spec).
 */
export async function signInAsOwner(page: Page): Promise<void> {
  await page.goto(`http://localhost:${BACKOFFICE_PORT}`);
  const form = page.getByLabel(bo.login.shopCode);
  const nav = page.getByRole('navigation', { name: bo.nav.menu });
  await expect(form.or(nav)).toBeVisible();
  if (await nav.isVisible()) {
    const owner = page.getByRole('button', { name: bo.nav.account.replace('{{name}}', OWNER.fullName) });
    if (await owner.isVisible()) return;
    await signOut(page);
  }
  await form.fill(SHOP);
  await page.getByLabel(bo.login.username).fill(OWNER.username);
  await page.getByLabel(bo.login.password).fill(OWNER_PASSWORD);
  await page.getByRole('button', { name: bo.login.submit }).click();
  await expect(nav).toBeVisible();
}
