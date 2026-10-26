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
// offline and still unlock, lock after 5 wrong PINs. W1-03 plan scope 6: search by code, scan, OEM number, words in
// any order, car and year, also offline.

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

  await expect(page.getByRole('combobox')).toBeVisible();
  await expect(page.locator('.status-bar')).toContainText(SALESMAN.fullName);
  await expect(page.locator('.status-bar')).toContainText('C01');
  await expect(page.locator('.status-bar')).toContainText(pos.status.online);
});

const searchFor = async (page: Page, text: string) => {
  await page.getByRole('combobox').fill(text);
  return page.getByRole('listbox', { name: pos.search.results }).getByRole('option');
};

test('the salesman finds parts by code, scan, OEM number, words in any order, and car and year', async ({
  page,
}) => {
  await page.goto(POS);
  await page.getByRole('button', { name: new RegExp(SALESMAN.fullName) }).click();
  await enterPin(page, OWN_PIN);
  await expect(page.getByRole('combobox')).toBeVisible();

  let options = await searchFor(page, 'brpd001');
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText('BRAKE PADS FRONT COROLLA');
  await expect(options.first()).toContainText(/Rs\s4,500/);
  await expect(options.first()).toContainText('OEM 04465-02220');
  await expect(options.first()).toContainText('Bin R3-B2');

  // A scanned label: the code typed fast, ending in Enter.
  const box = page.getByRole('combobox');
  await box.fill('');
  await box.pressSequentially('FNBL001', { delay: 5 });
  await box.press('Enter');
  options = page.getByRole('listbox', { name: pos.search.results }).getByRole('option');
  await expect(options.first()).toContainText('FAN BELT CULTUS');
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');

  for (const oem of ['04465-02220', '0446502220', '04465 02220']) {
    options = await searchFor(page, oem);
    await expect(options).toHaveCount(1);
    await expect(options.first()).toContainText('BRPD001');
  }

  options = await searchFor(page, 'corolla pads');
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText('BRPD001');
  await expect(options.nth(1)).toContainText(pos.item.status.dormant);

  options = await searchFor(page, 'brake pads corolla 2012');
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText('BRPD001');

  await page.keyboard.press('Escape');
  await expect(page.getByRole('combobox')).toHaveValue('');
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
  await expect(page.getByRole('combobox')).toBeVisible();
  await expect(page.locator('.status-bar')).toContainText('Offline since');
  // The catalog is on the counter: search works without the internet.
  const options = await searchFor(page, '17521');
  await expect(options).toHaveCount(2);
  await expect(options.first()).toContainText('FNBL002');
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
