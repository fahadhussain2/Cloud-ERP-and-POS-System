import type { Page } from '@playwright/test';

import bo from '../apps/backoffice/src/locales/en.json' with { type: 'json' };
import pos from '../apps/pos/src/locales/en.json' with { type: 'json' };
import { expect, test } from './counter-test';
import {
  BACKOFFICE_PORT,
  MANAGER,
  NEWCOMER,
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
// any order, car and year, also offline. W1-04 plan scope 7: the owner adds people with roles, a manager unlocks a
// locked salesman offline, a deactivated person leaves the counter, a manager's back office has the PIN action only.

const BACKOFFICE = `http://localhost:${BACKOFFICE_PORT}`;
const POS = `http://localhost:${POS_PORT}`;

test.describe.configure({ mode: 'serial' });

let code = '';

const enterPin = async (page: Page, pin: string) => {
  await page.getByLabel(pos.unlock.pin).fill(pin);
  await page.getByRole('button', { name: pos.unlock.submit }).click();
};

const signIn = async (page: Page, username: string, password: string) => {
  await page.goto(BACKOFFICE);
  await page.getByLabel(bo.login.shopCode).fill(SHOP);
  await page.getByLabel(bo.login.username).fill(username);
  await page.getByLabel(bo.login.password).fill(password);
  await page.getByRole('button', { name: bo.login.submit }).click();
};

const changePassword = async (page: Page, current: string, next: string) => {
  await expect(page.getByRole('heading', { name: bo.password.title })).toBeVisible();
  await page.getByLabel(bo.password.current).fill(current);
  await page.getByLabel(bo.password.new, { exact: true }).fill(next);
  await page.getByLabel(bo.password.repeat).fill(next);
  await page.getByRole('button', { name: bo.password.submit }).click();
};

const giveTemporaryPin = async (page: Page, fullName: string, pin: string) => {
  const row = page.getByRole('row', { name: new RegExp(fullName) });
  await row.getByRole('button', { name: bo.staff.give }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(bo.staff.temporaryPin).fill(pin);
  await dialog.getByRole('button', { name: bo.staff.save }).click();
  await expect(row).toContainText(bo.staff.pin.temporary);
};

const addPerson = async (
  page: Page,
  p: { fullName: string; username: string; shortCode: string; temporaryPassword?: string },
  role: string,
) => {
  await page.getByRole('button', { name: bo.staff.add }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(bo.staff.fullName).fill(p.fullName);
  await dialog.getByLabel(bo.staff.username).fill(p.username);
  await dialog.getByLabel(bo.staff.shortCodeField).fill(p.shortCode);
  if (p.temporaryPassword) await dialog.getByLabel(bo.staff.password.optional).fill(p.temporaryPassword);
  await dialog.getByRole('checkbox', { name: role }).click();
  await dialog.getByRole('button', { name: bo.staff.create }).click();
  await expect(page.getByRole('status')).toContainText(p.fullName);
};

test('the owner signs in, adds a manager and a salesman, gives temporary PINs and a one-time counter code', async ({
  page,
}) => {
  await signIn(page, OWNER.username, OWNER_FIRST_PASSWORD);
  await changePassword(page, OWNER_FIRST_PASSWORD, OWNER_PASSWORD);

  await expect(page.getByRole('heading', { name: bo.staff.title })).toBeVisible();
  await addPerson(page, MANAGER, 'Manager');
  await addPerson(page, NEWCOMER, 'Salesman');
  const newcomer = page.getByRole('row', { name: new RegExp(NEWCOMER.fullName) });
  await expect(newcomer).toContainText('Salesman');
  await expect(newcomer).toContainText(bo.staff.backOfficeNo);
  await expect(page.getByRole('row', { name: new RegExp(MANAGER.fullName) })).toContainText(
    bo.staff.backOfficeYes,
  );

  await expect(page.getByRole('row', { name: new RegExp(SALESMAN.fullName) })).toContainText(
    bo.staff.pin.none,
  );
  await giveTemporaryPin(page, SALESMAN.fullName, TEMPORARY_PIN);
  await giveTemporaryPin(page, MANAGER.fullName, MANAGER.temporaryPin);
  await giveTemporaryPin(page, NEWCOMER.fullName, NEWCOMER.temporaryPin);

  await page
    .getByRole('navigation', { name: bo.nav.menu })
    .getByRole('link', { name: bo.nav.counters })
    .click();
  await page.getByRole('button', { name: bo.counters.create }).click();
  code = (await page.getByRole('status').locator('strong').textContent()) ?? '';
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

test('the manager and the new salesman choose their own PINs at first unlock', async ({ page }) => {
  await page.goto(POS);
  for (const p of [MANAGER, NEWCOMER]) {
    await page.getByRole('button', { name: new RegExp(p.fullName) }).click();
    await enterPin(page, p.temporaryPin);
    await page.getByLabel(pos.choosePin.newPin, { exact: true }).fill(p.pin);
    await page.getByLabel(pos.choosePin.repeat).fill(p.pin);
    await page.getByRole('button', { name: pos.choosePin.submit }).click();
    await expect(page.getByRole('combobox')).toBeVisible();
    await page.keyboard.press('Alt+L');
    await expect(page.getByText(pos.unlock.title)).toBeVisible();
  }
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

test('offline, a manager unlocks the locked salesman with their own PIN, then the salesman unlocks', async ({
  page,
  context,
}) => {
  await page.goto(POS);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: new RegExp(SALESMAN.fullName) }).click();
  await enterPin(page, OWN_PIN);
  await expect(page.getByRole('alert')).toHaveText(pos.unlock.locked);

  await page.getByRole('button', { name: pos.unlock.managerUnlock }).click();
  // A salesman can't do it.
  await page.getByRole('button', { name: new RegExp(NEWCOMER.fullName) }).click();
  await page.getByLabel(pos.unlock.managerPin).fill(NEWCOMER.pin);
  await page.getByRole('button', { name: pos.unlock.managerSubmit }).click();
  await expect(page.getByRole('alert')).toHaveText(pos.unlock.notAllowed);
  await page.getByRole('button', { name: pos.unlock.back }).click();

  await page.getByRole('button', { name: new RegExp(MANAGER.fullName) }).click();
  await page.getByLabel(pos.unlock.managerPin).fill(MANAGER.pin);
  await page.getByRole('button', { name: pos.unlock.managerSubmit }).click();
  await expect(page.getByText(pos.unlock.managerDone.replace('{{name}}', SALESMAN.fullName))).toBeVisible();
  await enterPin(page, OWN_PIN);
  await expect(page.getByRole('combobox')).toBeVisible();
  await expect(page.locator('.status-bar')).toContainText(SALESMAN.fullName);
  await context.setOffline(false);
});

test('the owner deactivates the new salesman in the back office', async ({ browser }) => {
  // The back office in its own browser context; the counter keeps its profile.
  const office = await browser.newContext();
  const page = await office.newPage();
  await signIn(page, OWNER.username, OWNER_PASSWORD);
  await page.getByRole('link', { name: NEWCOMER.fullName }).click();
  await expect(page.getByRole('heading', { name: NEWCOMER.fullName })).toBeVisible();
  await page.getByRole('button', { name: bo.staff.deactivate }).click();
  await page.getByRole('dialog').getByRole('button', { name: bo.staff.deactivate }).click();
  await expect(page.getByRole('status')).toContainText(NEWCOMER.fullName);
  await office.close();
});

test('the counter drops the deactivated salesman at its next sync', async ({ page }) => {
  await page.goto(POS);
  await expect(page.locator('.status-bar')).toContainText(pos.status.online);
  await expect(page.getByRole('button', { name: new RegExp(SALESMAN.fullName) })).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(NEWCOMER.fullName) })).toHaveCount(0);
});

test('the manager signs in to the back office and can only give temporary PINs', async ({ browser }) => {
  const office = await browser.newContext();
  const page = await office.newPage();
  await signIn(page, MANAGER.username, MANAGER.temporaryPassword);
  await changePassword(page, MANAGER.temporaryPassword, MANAGER.password);
  await expect(page.getByRole('heading', { name: bo.staff.title })).toBeVisible();
  const menu = page.getByRole('navigation', { name: bo.nav.menu });
  await expect(menu.getByRole('link', { name: bo.nav.staff })).toBeVisible();
  await expect(menu.getByRole('link', { name: bo.nav.counters })).toBeVisible();
  await expect(page.getByRole('button', { name: bo.staff.add })).toHaveCount(0);
  const row = page.getByRole('row', { name: new RegExp(SALESMAN.fullName) });
  await expect(row.getByRole('button', { name: bo.staff.give })).toBeVisible();
  await page.getByRole('link', { name: SALESMAN.fullName }).click();
  await expect(page.getByRole('heading', { name: SALESMAN.fullName })).toBeVisible();
  await expect(page.getByRole('button', { name: bo.staff.deactivate })).toHaveCount(0);
  await office.close();
});
