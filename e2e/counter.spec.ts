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
// W1-06 plan scope 6: pay by cash, Raast and split, refusals, numbering across a reload, offline printing, reprint.
// W1-09 plan scope 6: customers by phone and their tier, on account, the limit and the offline cap, a walk-in phone.
// W1-12 plan scope 7: hold and recall.

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

  // A scanned label: the code typed fast, ending in Enter, puts the item on the bill (W1-05). Cleared again after, so
  // the bill flows below start empty.
  const box = page.getByRole('combobox');
  await box.fill('');
  await box.pressSequentially('FNBL001', { delay: 5 });
  await box.press('Enter');
  await expect(page.getByRole('listbox', { name: pos.keys.lines }).getByRole('option').first()).toContainText(
    'FAN BELT CULTUS',
  );
  await page.keyboard.press('Alt+C');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: new RegExp(`^${pos.clear.action}`) })
    .click();
  await expect(page.getByText(pos.bill.empty)).toBeVisible();

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

// W1-05 plan scope 4: the bill from the keyboard, bargaining and an approval by PIN (offline), the tier, the bill
// discount, and the bill kept across lock and reload.

const total = (page: Page) => page.getByTestId('bill-total');
const billLines = (page: Page) => page.getByRole('listbox', { name: pos.keys.lines }).getByRole('option');
const billPanel = (page: Page) => page.getByRole('region', { name: pos.bill.title });
const unlockAs = async (page: Page, fullName: string, pin: string) => {
  await page.getByRole('button', { name: new RegExp(fullName) }).click();
  await enterPin(page, pin);
  await expect(page.getByRole('combobox')).toBeVisible();
};
const addToBill = async (page: Page, text: string) => {
  const box = page.getByRole('combobox');
  await box.fill(text);
  await expect(
    page.getByRole('listbox', { name: pos.search.results }).getByRole('option').first(),
  ).toBeVisible();
  await box.press('Enter');
  await expect(box).toHaveValue('');
};
/** Types into the open dialog's field and presses Enter, as a salesman would. */
const answer = async (page: Page, label: string, value: string) => {
  const field = page.getByRole('dialog').getByLabel(label);
  await field.fill(value);
  await field.press('Enter');
};

test('the salesman builds a bill from the keyboard: Enter, a scan, 1.5*, + −, Q and Del', async ({
  page,
}) => {
  await page.goto(POS);
  await unlockAs(page, SALESMAN.fullName, OWN_PIN);
  await expect(page.getByText(pos.bill.empty)).toBeVisible();

  await addToBill(page, 'brpd001');
  await expect(total(page)).toHaveText(/Rs\s4,500/);
  // A scanned label: the code typed fast, then Enter at once.
  const box = page.getByRole('combobox');
  await box.pressSequentially('FNBL001', { delay: 5 });
  await box.press('Enter');
  await expect(total(page)).toHaveText(/Rs\s5,800/);
  await addToBill(page, '1.5*hose');
  await expect(billLines(page)).toHaveCount(3);
  await expect(billLines(page).nth(2)).toContainText('×1.5');
  await expect(total(page)).toHaveText(/Rs\s6,100/);

  // The lines take the keyboard; the line just added is selected.
  await box.press('Tab');
  await expect(billPanel(page)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('+');
  await expect(billLines(page).first()).toContainText('×2');
  await expect(total(page)).toHaveText(/Rs\s10,600/);
  await page.keyboard.press('-');
  await expect(total(page)).toHaveText(/Rs\s6,100/);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Delete');
  await expect(billLines(page)).toHaveCount(2);
  await expect(total(page)).toHaveText(/Rs\s4,800/);
  await page.keyboard.press('q');
  await answer(page, pos.qty.label, '2.5');
  await expect(billLines(page).nth(1)).toContainText('×2.5');
  await expect(total(page)).toHaveText(/Rs\s5,000/);

  // End as a salesman does: lock. The bill is saved in the background; unlocking goes through the same database
  // worker after that save, so the next flow (which reloads) finds this bill, not an earlier one (CI race, 2026-10-27).
  await page.keyboard.press('Alt+L');
  await unlockAs(page, SALESMAN.fullName, OWN_PIN);
  await expect(total(page)).toHaveText(/Rs\s5,000/);
});

test('offline, a price within the floor needs nobody; below it, a manager approves with their own PIN', async ({
  page,
  context,
}) => {
  await page.goto(POS);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.reload();
  await unlockAs(page, SALESMAN.fullName, OWN_PIN);
  // The bill from before the reload is still there.
  await expect(total(page)).toHaveText(/Rs\s5,000/);

  await page.getByRole('combobox').press('Tab');
  await expect(billPanel(page)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('p');
  await answer(page, pos.price.label, '4,200');
  await expect(billLines(page).first()).toContainText(/Bargained −Rs\s300/);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await expect(billPanel(page)).toBeFocused();
  await page.keyboard.press('p');
  await answer(page, pos.price.label, '3800');
  const dialog = page.getByRole('dialog', { name: pos.approval.title });
  await expect(dialog).toContainText(pos.approval.below_floor);
  await expect(dialog).toContainText(/Rs\s4,000/);

  // The salesman can't approve their own price below the floor.
  await dialog.getByRole('button', { name: new RegExp(SALESMAN.fullName) }).click();
  await answer(page, pos.approval.pin, OWN_PIN);
  await expect(dialog.getByRole('alert')).toHaveText(pos.approval.notAllowed);
  await dialog.getByRole('button', { name: pos.approval.back }).click();

  // The manager, by short code: a wrong PIN first, then theirs.
  await dialog.getByLabel(pos.unlock.shortCode).fill(MANAGER.shortCode);
  await answer(page, pos.approval.pin, '0000');
  await expect(dialog.getByRole('alert')).toContainText('4 tries');
  await answer(page, pos.approval.pin, MANAGER.pin);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(billLines(page).first()).toContainText(`Approved by ${MANAGER.fullName} · Customer bargain`);
  await expect(total(page)).toHaveText(/Rs\s4,300/);
  await context.setOffline(false);
});

test('F7 changes the price tier, D gives a bill discount, and one below the floor needs an approval', async ({
  page,
}) => {
  await page.goto(POS);
  await unlockAs(page, SALESMAN.fullName, OWN_PIN);
  await page.keyboard.press('Alt+C');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: new RegExp(`^${pos.clear.action}`) })
    .click();
  await expect(page.getByText(pos.bill.empty)).toBeVisible();

  await addToBill(page, 'brpd001');
  await page.keyboard.press('F7');
  await page.getByRole('dialog').getByLabel('Mechanic').check();
  await page.getByRole('dialog').getByLabel('Mechanic').press('Enter');
  await expect(total(page)).toHaveText(/Rs\s4,275/);
  await expect(billPanel(page)).toContainText('Mechanic prices');

  await page.getByRole('combobox').press('Tab');
  await page.keyboard.press('d');
  await answer(page, pos.discount.label, '5%');
  // 5% of Rs 4,275 is Rs 213.75: rounded down to Rs 213, still above the Rs 4,000 floor.
  await expect(total(page)).toHaveText(/Rs\s4,062/);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await expect(billPanel(page)).toBeFocused();
  await page.keyboard.press('d');
  await answer(page, pos.discount.label, '300');
  await expect(page.getByRole('dialog', { name: pos.approval.title })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(billPanel(page)).toContainText(pos.bill.billNeedsApproval);
  await expect(total(page)).toHaveText(/Rs\s3,975/);
});

test('F5 does not reload; the bill waits for the same person after a lock, and another person has their own', async ({
  page,
}) => {
  await page.goto(POS);
  await unlockAs(page, SALESMAN.fullName, OWN_PIN);
  await expect(total(page)).toHaveText(/Rs\s3,975/);
  await page.evaluate(() => ((window as unknown as { stay: number }).stay = 1));
  await page.keyboard.press('F5');
  expect(await page.evaluate(() => (window as unknown as { stay?: number }).stay)).toBe(1);

  await page.keyboard.press('Alt+L');
  await unlockAs(page, MANAGER.fullName, MANAGER.pin);
  await expect(page.getByText(pos.bill.empty)).toBeVisible();
  await page.keyboard.press('Alt+L');
  await page.reload();
  await unlockAs(page, SALESMAN.fullName, OWN_PIN);
  await expect(total(page)).toHaveText(/Rs\s3,975/);
  await expect(billPanel(page)).toContainText('Mechanic prices');
});

// W1-12 plan scope 7: hold a bill, sell another, recall the first as it was; recall over a bill with lines swaps them;
// the held bill waits for the same person after a lock. The salesman's bill is left as the next flow expects it.
test('F8 holds the bill and Shift+F8 recalls it; recalling over a bill with lines swaps the two', async ({
  page,
}) => {
  await page.goto(POS);
  await unlockAs(page, SALESMAN.fullName, OWN_PIN);
  await expect(total(page)).toHaveText(/Rs\s3,975/);
  await page.keyboard.press('F8');
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(pos.hold.label).fill('Blue Suzuki');
  await dialog.getByLabel(pos.hold.label).press('Enter');
  await expect(page.getByText(pos.bill.empty)).toBeVisible();
  await expect(billPanel(page)).toContainText('Bill held: Blue Suzuki');

  // Another customer meanwhile, then the first comes back: Enter asks, a second Enter swaps.
  await addToBill(page, 'brpd001');
  await page.keyboard.press('Shift+F8');
  await expect(dialog.getByRole('listbox')).toContainText('Blue Suzuki');
  await page.keyboard.press('Enter');
  await expect(dialog).toContainText('Enter again holds it');
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(total(page)).toHaveText(/Rs\s3,975/);
  await expect(billPanel(page)).toContainText('Mechanic prices');

  // The bill set aside by the swap waits for the same person after a lock; Del twice clears it.
  await page.keyboard.press('Alt+L');
  await unlockAs(page, SALESMAN.fullName, OWN_PIN);
  await expect(page.getByRole('button', { name: /Recall \(1\)/ })).toBeVisible();
  await page.keyboard.press('Shift+F8');
  await expect(dialog.getByRole('listbox')).toContainText(/Rs\s4,500/);
  await page.keyboard.press('Delete');
  await page.keyboard.press('Delete');
  await expect(dialog).toContainText(pos.recall.empty);
  await page.keyboard.press('Escape');
  await expect(total(page)).toHaveText(/Rs\s3,975/);
});

// W1-06 plan scope 6: paying and printing. window.print() is replaced by a recorder of what the print container shows
// at that moment, as the counter's kiosk printing would send it to the printer.
const recordPrints = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { printed: string[] };
    w.printed = [];
    window.print = () => void w.printed.push(document.getElementById('print-root')?.innerText ?? '');
  });
const printed = (page: Page) => page.evaluate(() => (window as unknown as { printed: string[] }).printed);
const notice = (page: Page) => billPanel(page).getByRole('status');
const payDialog = (page: Page) => page.getByRole('dialog');

test('pay is refused while a price waits for an approval; exact cash prints S000001 and reaches the server', async ({
  page,
}) => {
  await recordPrints(page);
  await page.goto(POS);
  await unlockAs(page, SALESMAN.fullName, OWN_PIN);
  // The bill from the last flow still has a bill discount waiting for an approval.
  await expect(billPanel(page)).toContainText(pos.bill.billNeedsApproval);
  await page.keyboard.press('F9');
  await expect(billPanel(page)).toContainText(pos.pay.approveFirst);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.keyboard.press('Alt+C');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: new RegExp(`^${pos.clear.action}`) })
    .click();
  await addToBill(page, 'brpd001');
  await page.keyboard.press('F9');
  await expect(payDialog(page).getByTestId('pay-total')).toHaveText(/Rs\s4,500/);
  // Enter with the field empty: the exact amount.
  await payDialog(page).getByLabel(pos.pay.cashReceived).press('Enter');
  await expect(notice(page)).toHaveText(/^Bill C\d+-S000001 printed · bring Rs\s4,500 to the cash desk$/);
  await expect(page.getByText(pos.bill.empty)).toBeVisible();
  await expect(page.getByRole('combobox')).toBeFocused();
  const [bill] = await printed(page);
  expect(bill).toContain(pos.print.saleBill);
  expect(bill).toContain('BRPD001');
  expect(bill).toContain(SALESMAN.fullName);
  expect(bill).toMatch(/C\d+-S000001 4500/);
  // Online, a finalized bill is pushed at once (SYN-02, W1-07): nothing is left waiting within seconds.
  await expect(page.getByText('0 bills waiting to sync')).toBeVisible({ timeout: 5000 });
});

/** BRPD001's Shop quantity as the search result shows it (W1-27), the search then cleared. */
const shopStock = async (page: Page) => {
  const box = page.getByRole('combobox');
  await box.fill('brpd001');
  const cell = page
    .getByRole('listbox', { name: pos.search.results })
    .getByRole('option')
    .first()
    .getByTestId('stock');
  await expect(cell).toBeVisible();
  const text = (await cell.textContent()) ?? '';
  await box.fill('');
  return Number(text.split(' · ')[0]!.replace('−', '-'));
};

test('cash with change, typed and by quick cash; less than the total is refused', async ({ page }) => {
  await recordPrints(page);
  await page.goto(POS);
  await unlockAs(page, SALESMAN.fullName, OWN_PIN);
  // W1-27: each result shows its Shop and Godown stock; a sale here comes off the Shop at once.
  const before = await shopStock(page);
  await addToBill(page, 'fnbl001');
  await page.keyboard.press('F9');
  await answer(page, pos.pay.cashReceived, '1000');
  await expect(payDialog(page).getByRole('alert')).toHaveText(pos.pay.lessThanTotal);
  await payDialog(page).getByLabel(pos.pay.cashReceived).fill('2000');
  await expect(payDialog(page).getByTestId('pay-change')).toHaveText(/Rs\s700/);
  await payDialog(page).getByLabel(pos.pay.cashReceived).press('Enter');
  await expect(notice(page)).toHaveText(
    /S000002 printed · bring Rs\s1,300 to the cash desk, change Rs\s700$/,
  );

  await addToBill(page, 'brpd001');
  await page.keyboard.press('F9');
  await payDialog(page)
    .getByRole('group', { name: pos.pay.quickCash })
    .getByRole('button', { name: /Rs\s5,000/ })
    .click();
  await expect(notice(page)).toHaveText(
    /S000003 printed · bring Rs\s4,500 to the cash desk, change Rs\s500$/,
  );
  expect(await printed(page)).toHaveLength(2);
  // Online, both bills reach the server at once (SYN-02, W1-07).
  await expect(page.getByText('0 bills waiting to sync')).toBeVisible({ timeout: 5000 });
  // One BRPD001 sold: one fewer in the Shop, before and after the server has it.
  await expect.poll(() => shopStock(page)).toBe(before - 1);
});

test('Raast needs its reference; a split pays cash and JazzCash with cash received', async ({ page }) => {
  await recordPrints(page);
  await page.goto(POS);
  await unlockAs(page, SALESMAN.fullName, OWN_PIN);
  await addToBill(page, 'brpd001');
  await billPanel(page)
    .getByRole('group', { name: pos.pay.pad })
    .getByRole('button', { name: 'Raast' })
    .click();
  await payDialog(page).getByLabel(pos.pay.reference.raast).press('Enter');
  await expect(payDialog(page).getByRole('alert')).toHaveText(pos.tender.reference_required);
  await answer(page, pos.pay.reference.raast, 'RST-5512');
  await expect(notice(page)).toHaveText(/S000004 printed · paid by Raast$/);
  expect((await printed(page))[0]).toContain('Raast · RST-5512');

  await addToBill(page, 'brpd001');
  await page.keyboard.press('Shift+F9');
  const split = payDialog(page);
  await split.getByLabel('Cash amount', { exact: true }).fill('2000');
  await expect(split.getByTestId('split-left')).toHaveText(/Rs\s2,500 still to cover/);
  await split.getByLabel('JazzCash amount', { exact: true }).fill('2500');
  await split.getByLabel(`JazzCash: ${pos.pay.reference.jazzcash}`).fill('JC-88123');
  await split.getByLabel(pos.pay.cashReceived).fill('5000');
  await expect(split.getByTestId('split-left')).toHaveText(pos.pay.covered);
  await expect(split.getByTestId('pay-change')).toHaveText(/Rs\s3,000/);
  await split.getByLabel(pos.pay.cashReceived).press('Enter');
  await expect(notice(page)).toHaveText(
    /S000005 printed · bring Rs\s2,000 to the cash desk, change Rs\s3,000$/,
  );
  const bill = (await printed(page))[1];
  expect(bill).toContain('JazzCash · JC-88123');
  expect(bill).toMatch(/C\d+-S000005 2000/);
  // Both reach the server before the next flow takes the counter offline.
  await expect(page.getByText('0 bills waiting to sync')).toBeVisible({ timeout: 5000 });
});

test('offline, numbering goes on after a reload, the bill prints, and Alt+P reprints it marked REPRINT', async ({
  page,
  context,
}) => {
  await recordPrints(page);
  await page.goto(POS);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.reload();
  await unlockAs(page, SALESMAN.fullName, OWN_PIN);
  await addToBill(page, 'fnbl001');
  await page.keyboard.press('F9');
  await payDialog(page).getByLabel(pos.pay.cashReceived).press('Enter');
  await expect(notice(page)).toHaveText(/S000006 printed/);
  // Offline it waits; the five bills before it reached the server while online (W1-07).
  await expect(page.getByText('1 bill waiting to sync')).toBeVisible();

  await page.keyboard.press('Alt+P');
  const reprint = page.getByRole('dialog', { name: pos.reprint.title });
  await expect(reprint.getByRole('option').first()).toContainText('S000006');
  await reprint.getByLabel(pos.reprint.search).fill('000002');
  await expect(reprint.getByRole('option')).toHaveCount(1);
  await reprint.getByLabel(pos.reprint.search).press('Enter');
  await expect(notice(page)).toHaveText(/S000002 reprinted$/);
  const copy = (await printed(page))[1];
  expect(copy).toMatch(new RegExp(`REPRINT · .* · ${SALESMAN.fullName}`));
  expect(copy).toContain('FAN BELT CULTUS');
  expect(copy).toMatch(/C\d+-S000002 1300/);
  await context.setOffline(false);
});

// W1-09 plan scope 6: customers and credit. F4 by phone and the customer's tier, part cash and part on account, on
// account within the limit, over it with the manager's own PIN, and offline the day's cap; a walk-in's phone.
const pickCustomer = async (page: Page, text: string) => {
  await page.keyboard.press('F4');
  const dialog = page.getByRole('dialog', { name: pos.customer.title });
  await dialog.getByLabel(pos.customer.search).fill(text);
  await expect(dialog.getByRole('option').nth(1)).toBeVisible();
  await dialog.getByLabel(pos.customer.search).press('ArrowDown');
  await dialog.getByLabel(pos.customer.search).press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
};
const onAccount = (page: Page) =>
  billPanel(page).getByRole('group', { name: pos.pay.pad }).getByRole('button', { name: 'On account' });

test('F4 finds a customer by phone: their prices, part cash and part on account, then on account within the limit', async ({
  page,
}) => {
  await recordPrints(page);
  await page.goto(POS);
  await unlockAs(page, SALESMAN.fullName, OWN_PIN);
  await addToBill(page, 'brpd001');
  await expect(onAccount(page)).toBeDisabled();
  await pickCustomer(page, '4567');
  await expect(billPanel(page)).toContainText('Khan Motors (C0042)');
  await expect(billPanel(page)).toContainText('Mechanic prices');
  await expect(total(page)).toHaveText(/Rs\s4,275/);

  await page.keyboard.press('Shift+F9');
  const split = payDialog(page);
  await split.getByLabel('Cash amount', { exact: true }).fill('2000');
  await split.getByLabel('On account amount', { exact: true }).fill('2275');
  await expect(split.getByTestId('split-left')).toHaveText(pos.pay.covered);
  await split.getByLabel(pos.pay.cashReceived).press('Enter');
  await expect(notice(page)).toHaveText(/printed · bring Rs\s2,000 to the cash desk$/);
  const bill = (await printed(page))[0];
  expect(bill).toContain('Khan Motors (C0042)');
  expect(bill).toContain('On account');
  expect(bill).not.toContain('1234567');

  // The next bill starts as a walk-in again.
  await addToBill(page, 'brpd001');
  await expect(total(page)).toHaveText(/Rs\s4,500/);
  await pickCustomer(page, 'khan');
  await onAccount(page).click();
  await expect(payDialog(page).getByTestId('pay-total')).toHaveText(/Rs\s4,275/);
  await payDialog(page)
    .getByRole('button', { name: new RegExp(`^${pos.pay.finalize}`) })
    .click();
  await expect(notice(page)).toHaveText(/printed · paid by On account$/);
  await expect(page.getByText('0 bills waiting to sync')).toBeVisible({ timeout: 5000 });
});

test('over the limit, On account needs the manager’s own PIN and a reason', async ({ page }) => {
  await recordPrints(page);
  await page.goto(POS);
  await unlockAs(page, SALESMAN.fullName, OWN_PIN);
  await addToBill(page, 'brpd001');
  await pickCustomer(page, 'C0042');
  await onAccount(page).click();
  // Rs 6,550 already on account (both bills before) and Rs 4,275 more: Rs 825 over the Rs 10,000 limit.
  await expect(payDialog(page)).toContainText(/Over the credit limit by Rs\s825/);
  await payDialog(page)
    .getByRole('button', { name: new RegExp(`^${pos.pay.finalize}`) })
    .click();
  const approval = page.getByRole('dialog', { name: pos.approval.title });
  await expect(approval).toContainText(pos.approval.credit_limit);
  // The salesman can't approve credit over the limit; the manager can, with a credit reason.
  await approval.getByRole('button', { name: new RegExp(SALESMAN.fullName) }).click();
  await answer(page, pos.approval.pin, OWN_PIN);
  await expect(approval.getByRole('alert')).toHaveText(pos.approval.notAllowed);
  await approval.getByRole('button', { name: pos.approval.back }).click();
  await approval.getByLabel(pos.unlock.shortCode).fill(MANAGER.shortCode);
  await approval.getByLabel(pos.override.reason.regular_customer).check();
  await answer(page, pos.approval.pin, MANAGER.pin);
  await expect(notice(page)).toHaveText(/printed · paid by On account$/);
  await expect(page.getByText('0 bills waiting to sync')).toBeVisible({ timeout: 5000 });
});

test('offline, a customer buys on account up to the day’s cap without a PIN; past it needs one; a walk-in leaves a phone', async ({
  page,
  context,
}) => {
  await recordPrints(page);
  await page.goto(POS);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.reload();
  await unlockAs(page, SALESMAN.fullName, OWN_PIN);
  await addToBill(page, 'fnbl001');
  await pickCustomer(page, 'rehman');
  await onAccount(page).click();
  await expect(payDialog(page)).toContainText(pos.credit.capToday);
  await payDialog(page)
    .getByRole('button', { name: new RegExp(`^${pos.pay.finalize}`) })
    .click();
  await expect(notice(page)).toHaveText(/printed · paid by On account$/);

  // Rs 1,300 already today offline, Rs 1,300 more: Rs 600 past the Rs 2,000 cap.
  await addToBill(page, 'fnbl001');
  await pickCustomer(page, 'rehman');
  await onAccount(page).click();
  await expect(payDialog(page)).toContainText(/Over today’s offline cap by Rs\s600/);
  await payDialog(page)
    .getByRole('button', { name: new RegExp(`^${pos.pay.finalize}`) })
    .click();
  await expect(page.getByRole('dialog', { name: pos.approval.title })).toContainText(
    pos.approval.offline_cap,
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(total(page)).toHaveText(/Rs\s1,300/);

  // Back to walk-in, with a phone: shown by its last four digits only, never printed.
  await page.keyboard.press('F4');
  const dialog = page.getByRole('dialog', { name: pos.customer.title });
  await dialog.getByLabel(pos.customer.search).press('ArrowDown');
  await dialog.getByLabel(pos.customer.walkinPhone).fill('0300 111 2222');
  await dialog.getByLabel(pos.customer.walkinPhone).press('Enter');
  await expect(billPanel(page)).toContainText('Walk-in · •••• 2222');
  await page.keyboard.press('F9');
  await payDialog(page).getByLabel(pos.pay.cashReceived).press('Enter');
  await expect(notice(page)).toHaveText(/printed · bring Rs\s1,300 to the cash desk$/);
  expect((await printed(page))[1]).not.toContain('2222');
  await expect(page.getByText('2 bills waiting to sync')).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText('0 bills waiting to sync')).toBeVisible({ timeout: 15000 });
});

// W1-15 plan: the owner changes an item's Retail price and adds a new item in the back office; the counter has both
// after its next pull (sync spec §3).
test('the owner changes a price and adds an item in the back office; the counter sells both after its next pull', async ({
  page,
  browser,
}) => {
  const office = await browser.newContext();
  const bop = await office.newPage();
  await signIn(bop, OWNER.username, OWNER_PASSWORD);
  await bop.getByRole('navigation', { name: bo.nav.menu }).getByRole('link', { name: bo.nav.items }).click();
  await expect(bop.getByText(/legacy app/i)).toHaveCount(0); // no go-live notice (D-113)
  await bop.getByLabel(bo.catalog.items.search).fill('enol001');
  await bop.getByRole('link', { name: 'ENOL001' }).click();
  await bop.getByLabel('Retail').fill('7200');
  await bop.getByRole('button', { name: bo.catalog.item.savePrices }).click();
  await expect(bop.getByRole('status').filter({ hasText: bo.catalog.item.savedPrices })).toBeVisible();
  await expect(bop.getByRole('table', { name: bo.catalog.item.history })).toContainText(/Rs\s?7,200/);

  await bop.getByRole('link', { name: `← ${bo.catalog.item.back}` }).click();
  await bop.getByRole('link', { name: bo.catalog.items.add }).click();
  await bop.getByLabel(bo.catalog.fields.code).fill('abea050');
  await bop.getByLabel(bo.catalog.fields.name).fill('ADJUSTER BEARING VITZ');
  await bop.getByLabel(bo.catalog.fields.category).selectOption({ label: 'BRPD · BRPD' });
  await bop.getByLabel(bo.catalog.fields.unit).selectOption({ label: 'PCS' });
  await bop.getByLabel('Retail').fill('3950');
  await expect(bop.getByLabel('Mechanic')).toHaveValue('3753');
  await bop.getByRole('button', { name: bo.catalog.newItem.create }).click();
  await expect(bop.getByRole('heading', { name: /ABEA050/ })).toBeVisible();
  await office.close();

  await page.goto(POS);
  await unlockAs(page, SALESMAN.fullName, OWN_PIN);
  const results = page.getByRole('listbox', { name: pos.search.results });
  await expect(async () => {
    await page.getByRole('combobox').fill('abea050');
    await expect(results.getByRole('option').first()).toContainText(/Rs\s?3,950/, { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await page.getByRole('combobox').fill('enol001');
  await expect(results.getByRole('option').first()).toContainText(/Rs\s?7,200/);
});

// W1-22 plan (D-109): the owner adds a customer in the back office on the Mechanic tier with a Rs 10,000 limit; a
// counter finds them by phone after its next pull, at Mechanic prices, and sells on account within the limit without
// a PIN; the customer's ledger shows the bill; deactivating them is refused while they owe; with their credit turned
// off, the counter no longer offers On account. Test Motors is used by no other flow.
test('a customer added in the back office buys on account at a counter; credit off stops it', async ({
  page,
  browser,
}) => {
  const c = bo.customers;
  const office = await browser.newContext();
  const bop = await office.newPage();
  await signIn(bop, OWNER.username, OWNER_PASSWORD);
  await bop
    .getByRole('navigation', { name: bo.nav.menu })
    .getByRole('link', { name: bo.nav.customers })
    .click();
  await bop.getByRole('button', { name: c.add }).click();
  let form = bop.getByRole('dialog');
  await expect(form.getByLabel(c.fields.code)).toHaveValue(/^C\d{4}$/);
  await form.getByLabel(c.fields.name).fill('Test Motors');
  await form.getByLabel(c.fields.phones).fill('0333-5550101');
  await form.getByLabel(c.fields.tier).selectOption({ label: 'Mechanic' });
  await form.getByLabel(c.fields.creditAllowed).check();
  await form.getByLabel(c.fields.limit).fill('10,000');
  await form.getByRole('button', { name: new RegExp(`^${c.create}`) }).click();
  await expect(bop.getByRole('heading', { name: 'Test Motors' })).toBeVisible();

  // The counter has them after its next pull (the nudge makes it seconds).
  await page.goto(POS);
  await unlockAs(page, SALESMAN.fullName, OWN_PIN);
  await addToBill(page, 'brpd001');
  const find = async () => {
    await page.keyboard.press('F4');
    const dialog = page.getByRole('dialog', { name: pos.customer.title });
    await dialog.getByLabel(pos.customer.search).fill('5550101');
    try {
      await expect(dialog.getByRole('option').nth(1)).toContainText('Test Motors', { timeout: 1000 });
    } catch (err) {
      await page.keyboard.press('Escape');
      throw err;
    }
    await dialog.getByLabel(pos.customer.search).press('ArrowDown');
    await dialog.getByLabel(pos.customer.search).press('Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  };
  await expect(find).toPass({ timeout: 15_000 });
  await expect(billPanel(page)).toContainText('Mechanic prices');
  await expect(total(page)).toHaveText(/Rs\s4,275/);
  await onAccount(page).click();
  await payDialog(page)
    .getByRole('button', { name: new RegExp(`^${pos.pay.finalize}`) })
    .click();
  await expect(notice(page)).toHaveText(/printed · paid by On account$/);
  await expect(page.getByText('0 bills waiting to sync')).toBeVisible({ timeout: 5000 });

  // The bill is on their ledger, and they can't be deactivated while they owe.
  await expect(async () => {
    await bop.reload();
    await expect(bop.getByRole('table', { name: c.ledger.title })).toContainText(/Rs\s?4,275/, {
      timeout: 1000,
    });
  }).toPass({ timeout: 15_000 });
  await bop.getByRole('link', { name: `← ${c.title}` }).click();
  await bop.getByRole('button', { name: `${c.deactivate} Test Motors` }).click();
  form = bop.getByRole('dialog');
  await form.getByRole('button', { name: c.deactivate }).click();
  await expect(form.getByRole('alert')).toHaveText(/balance is Rs\s?4,275/);
  await form.getByRole('button', { name: c.cancel }).click();

  // Credit off: the counter stops offering On account after its next pull.
  await bop.getByRole('button', { name: `${c.edit} Test Motors` }).click();
  form = bop.getByRole('dialog');
  await form.getByLabel(c.fields.creditAllowed).uncheck();
  await form.getByRole('button', { name: c.save }).click();
  await expect(bop.getByRole('status')).toHaveText(c.saved.replace('{{name}}', 'Test Motors'));
  await office.close();

  await addToBill(page, 'brpd001');
  await expect(async () => {
    await find();
    await expect(onAccount(page)).toBeDisabled({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
});
