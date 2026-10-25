import type { Page } from '@playwright/test';

import bo from '../apps/backoffice/src/locales/en.json' with { type: 'json' };
import pos from '../apps/pos/src/locales/en.json' with { type: 'json' };
import { expect, test } from './counter-test';
import {
  BACKOFFICE_PORT,
  OWN_PIN,
  OWNER,
  OWNER_FIRST_PASSWORD,
  OWNER_PASSWORD,
  POS_PORT,
  SALESMAN,
  SHOP,
  TEMPORARY_PIN,
} from './fixtures';

// W1-02 plan scope 5: enroll a counter, give a temporary PIN, choose your own at first unlock, unlock, reload
// offline and still unlock, lock after 5 wrong PINs.

const BACKOFFICE = `http://localhost:${BACKOFFICE_PORT}`;
const POS = `http://localhost:${POS_PORT}`;

test.describe.configure({ mode: 'serial' });

let code = '';

const enterPin = async (page: Page, pin: string) => {
  await page.getByLabel(pos.unlock.pin).fill(pin);
  await page.getByRole('button', { name: pos.unlock.submit }).click();
};

test('a manager signs in, gives a temporary PIN and creates a one-time counter code', async ({ page }) => {
  await page.goto(BACKOFFICE);
  await page.getByLabel(bo.login.shopCode).fill(SHOP);
  await page.getByLabel(bo.login.username).fill(OWNER.username);
  await page.getByLabel(bo.login.password).fill(OWNER_FIRST_PASSWORD);
  await page.getByRole('button', { name: bo.login.submit }).click();

  await expect(page.getByRole('heading', { name: bo.password.title })).toBeVisible();
  await page.getByLabel(bo.password.current).fill(OWNER_FIRST_PASSWORD);
  await page.getByLabel(bo.password.new, { exact: true }).fill(OWNER_PASSWORD);
  await page.getByLabel(bo.password.repeat).fill(OWNER_PASSWORD);
  await page.getByRole('button', { name: bo.password.submit }).click();

  const row = page.getByRole('row', { name: new RegExp(SALESMAN.fullName) });
  await expect(row).toContainText(bo.staff.pin.none);
  await row.getByRole('button', { name: bo.staff.give }).click();
  await page.getByLabel(bo.staff.temporaryPin).fill(TEMPORARY_PIN);
  await page.getByRole('button', { name: bo.staff.save }).click();
  await expect(row).toContainText(bo.staff.pin.temporary);

  await page.getByRole('button', { name: bo.nav.counters }).click();
  await page.getByRole('button', { name: bo.counters.create }).click();
  code = (await page.locator('.code strong').textContent()) ?? '';
  expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
});

test('the counter is set up, and the salesman chooses their own PIN at first unlock', async ({ page }) => {
  await page.goto(POS);
  await page.getByLabel(pos.setup.shopCode).fill(SHOP);
  await page.getByLabel(pos.setup.code).fill(code);
  await page.getByRole('button', { name: pos.setup.submit }).click();

  await page.getByRole('button', { name: new RegExp(SALESMAN.fullName) }).click();
  await enterPin(page, TEMPORARY_PIN);
  await page.getByLabel(pos.choosePin.newPin, { exact: true }).fill(OWN_PIN);
  await page.getByLabel(pos.choosePin.repeat).fill(OWN_PIN);
  await page.getByRole('button', { name: pos.choosePin.submit }).click();

  await expect(page.getByText(`${SALESMAN.fullName} is selling on this counter.`)).toBeVisible();
  await expect(page.locator('.status-bar')).toContainText('C01');
  await expect(page.locator('.status-bar')).toContainText(pos.status.online);
});

test('offline, the counter still starts and the salesman still unlocks', async ({ page, context }) => {
  await page.goto(POS);
  // The service worker must control the page before the network goes.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: new RegExp(SALESMAN.fullName) }).click();
  await enterPin(page, OWN_PIN);
  await expect(page.getByText(`${SALESMAN.fullName} is selling on this counter.`)).toBeVisible();
  await expect(page.locator('.status-bar')).toContainText('Offline since');
  await context.setOffline(false);
});

test('5 wrong PINs lock the salesman on this counter, and the lock survives a reload', async ({ page }) => {
  await page.goto(POS);
  await page.getByRole('button', { name: new RegExp(SALESMAN.fullName) }).click();
  for (let left = 4; left >= 1; left--) {
    await enterPin(page, '0000');
    await expect(page.getByRole('alert')).toContainText(`${left} tr`);
  }
  await enterPin(page, '0000');
  await expect(page.getByRole('alert')).toHaveText(pos.unlock.locked);

  await page.reload();
  await page.getByRole('button', { name: new RegExp(SALESMAN.fullName) }).click();
  await enterPin(page, OWN_PIN);
  await expect(page.getByRole('alert')).toHaveText(pos.unlock.locked);
});
