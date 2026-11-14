import { expect, type Page } from '@playwright/test';

import bo from '../apps/backoffice/src/locales/en.json' with { type: 'json' };

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
  if (!(await link.isVisible()))
    for (const group of await nav.locator('button[aria-expanded="false"]').all()) await group.click();
  await link.click();
}

/** The account menu's button in the top bar, whoever is signed in. */
export const account = (page: Page) =>
  page
    .getByRole('banner')
    .getByRole('button', { name: new RegExp(`^${bo.nav.account.replace('{{name}}', '')}`) });

export async function signOut(page: Page): Promise<void> {
  await account(page).click();
  await page.getByRole('menuitem', { name: bo.nav.signOut }).click();
  await expect(page.getByLabel(bo.login.shopCode)).toBeVisible();
}
