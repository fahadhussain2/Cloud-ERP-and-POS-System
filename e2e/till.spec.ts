import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, type BrowserContext, type Page } from '@playwright/test';
import pg from 'pg';

import bo from '../apps/backoffice/src/locales/en.json' with { type: 'json' };
import pos from '../apps/pos/src/locales/en.json' with { type: 'json' };
import { expect, test } from './counter-test';
import {
  BACKOFFICE_PORT,
  CASHIER,
  OWN_PIN,
  OWNER,
  OWNER_PASSWORD,
  POS_PORT,
  SALESMAN,
  SHOP,
} from './fixtures';

// W1-10 plan scope 7: the cash desk (the "till"), after the counter and sync flows built the counter and its staff.
// The desk is a second PC, so a second browser profile. A session with a float; a counter's cash bill in the queue
// within 5 s under its salesman, confirmed with Enter; a corrected cash received; a scan of a queued bill; offline, a
// scan of a bill whose counter hasn't synced, matched by the server once both are back; a second scan refused; a
// sale on the desk handed over by itself; the session closed.

const BACKOFFICE = `http://localhost:${BACKOFFICE_PORT}`;
const POS = `http://localhost:${POS_PORT}`;

test.describe.configure({ mode: 'serial' });

async function sql<T extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const url = new URL(process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:54329/postgres');
  url.pathname = '/erp_e2e';
  const c = new pg.Client({ connectionString: url.toString() });
  await c.connect();
  try {
    return (await c.query<T>(text, params)).rows;
  } finally {
    await c.end();
  }
}

/** The server's handover of a bill, once it has one. */
const handoverOf = async (bill: string) =>
  (
    await sql<{
      method: string;
      linked: boolean;
      received_amount: string | null;
      corrected_from: string | null;
      exceptions: number;
      status: string | null;
    }>(
      `SELECT h.method, h.sales_document_id IS NOT NULL AS linked, h.received_amount, h.corrected_from,
         h.exception_count AS exceptions, d.handover_status AS status
       FROM erp.cash_handovers h LEFT JOIN erp.sales_documents d ON d.id = h.sales_document_id
       WHERE h.bill_number = $1 AND h.duplicate_of_id IS NULL`,
      [bill],
    )
  )[0] ?? null;

let code = '';
let deskDir = '';
let desk: BrowserContext;
let till: Page;

const queue = () => till.getByRole('region', { name: pos.desk.queue });
const scanField = () => till.getByRole('textbox', { name: pos.desk.scan });
const deskNotice = () =>
  till
    .getByRole('status')
    .filter({ hasNotText: /Offline/ })
    .last();

const unlock = async (page: Page, fullName: string, pin: string) => {
  await page.getByRole('button', { name: new RegExp(fullName) }).click();
  await page.getByLabel(pos.unlock.pin).fill(pin);
  await page.getByRole('button', { name: pos.unlock.submit }).click();
};

/** The counter (the shared profile): Asif sells one of `item` for cash, optionally typing the cash received. */
async function sell(page: Page, item: string, received?: string): Promise<string> {
  const box = page.getByRole('combobox');
  await box.fill(item);
  await expect(
    page.getByRole('listbox', { name: pos.search.results }).getByRole('option').first(),
  ).toBeVisible();
  await box.press('Enter');
  // The line is on the bill once the search is cleared; pay is disabled while the bill is empty.
  await expect(box).toHaveValue('');
  await page.keyboard.press('F9');
  const field = page.getByRole('dialog').getByLabel(pos.pay.cashReceived);
  if (received) await field.fill(received);
  await field.press('Enter');
  const notice = page.getByRole('region', { name: pos.bill.title }).getByRole('status');
  await expect(notice).toHaveText(/^Bill C\d+-S\d{6} printed/);
  return /C\d+-S\d{6}/.exec((await notice.textContent()) ?? '')![0];
}

const openCounter = async (page: Page) => {
  await page.addInitScript(() => {
    window.print = () => undefined;
  });
  await page.goto(POS);
  await unlock(page, SALESMAN.fullName, OWN_PIN);
  await expect(page.getByRole('combobox')).toBeVisible();
};

test.afterAll(async () => {
  await desk?.close();
  if (deskDir) await rm(deskDir, { recursive: true, force: true });
});

test('the owner adds a cashier with a temporary PIN and creates a cash desk code', async ({ page }) => {
  await page.goto(BACKOFFICE);
  const signOut = page.getByRole('button', { name: bo.nav.signOut });
  await expect(signOut.or(page.getByLabel(bo.login.shopCode))).toBeVisible();
  if (await signOut.isVisible()) await signOut.click();
  await page.getByLabel(bo.login.shopCode).fill(SHOP);
  await page.getByLabel(bo.login.username).fill(OWNER.username);
  await page.getByLabel(bo.login.password).fill(OWNER_PASSWORD);
  await page.getByRole('button', { name: bo.login.submit }).click();

  await expect(page.getByRole('heading', { name: bo.staff.title })).toBeVisible();
  await page.getByRole('button', { name: bo.staff.add }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(bo.staff.fullName).fill(CASHIER.fullName);
  await dialog.getByLabel(bo.staff.username).fill(CASHIER.username);
  await dialog.getByLabel(bo.staff.shortCodeField).fill(CASHIER.shortCode);
  await dialog.getByRole('checkbox', { name: 'Cashier' }).click();
  await dialog.getByRole('button', { name: bo.staff.create }).click();
  await expect(page.getByRole('status')).toContainText(CASHIER.fullName);
  const row = page.getByRole('row', { name: new RegExp(CASHIER.fullName) });
  await row.getByRole('button', { name: bo.staff.give }).click();
  await page.getByRole('dialog').getByLabel(bo.staff.temporaryPin).fill(CASHIER.temporaryPin);
  await page.getByRole('dialog').getByRole('button', { name: bo.staff.save }).click();
  await expect(row).toContainText(bo.staff.pin.temporary);

  await page
    .getByRole('navigation', { name: bo.nav.menu })
    .getByRole('link', { name: bo.nav.counters })
    .click();
  await page.getByRole('combobox', { name: bo.counters.kind }).click();
  await page.getByRole('option', { name: bo.counters.kinds.cash_desk }).click();
  await page.getByRole('button', { name: bo.counters.create }).click();
  code = (await page.getByRole('status').locator('strong').textContent()) ?? '';
  expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
});

test('the cash desk PC is set up; the cashier chooses a PIN, lands on the cash desk and opens a session', async ({
  channel,
}) => {
  deskDir = await mkdtemp(join(tmpdir(), 'erp-e2e-desk-'));
  desk = await chromium.launchPersistentContext(deskDir, { ...(channel ? { channel } : {}) });
  await desk.addInitScript(() => {
    navigator.storage.persisted = () => Promise.resolve(true);
    navigator.storage.persist = () => Promise.resolve(true);
    window.print = () => undefined;
  });
  till = await desk.newPage();
  await till.goto(POS);
  await till.getByLabel(pos.setup.shopCode).fill(SHOP);
  await till.getByLabel(pos.setup.code).fill(code);
  await till.getByRole('button', { name: pos.setup.submit }).click();

  await unlock(till, CASHIER.fullName, CASHIER.temporaryPin);
  await till.getByLabel(pos.choosePin.newPin, { exact: true }).fill(CASHIER.pin);
  await till.getByLabel(pos.choosePin.repeat).fill(CASHIER.pin);
  await till.getByRole('button', { name: pos.choosePin.submit }).click();

  await expect(till.getByText(pos.desk.noSession)).toBeVisible();
  await expect(till.locator('.status-bar')).toContainText('D01');
  await till.keyboard.press('Alt+O');
  await till.getByRole('dialog').getByLabel(pos.desk.open.label).fill('5000');
  await till.getByRole('dialog').getByRole('button', { name: pos.desk.open.action }).click();
  await expect(deskNotice()).toHaveText(/Session D01-Z000001 opened with Rs\s?5,000/);
  await expect
    .poll(async () => (await sql<{ status: string }>('SELECT status FROM erp.cash_sessions'))[0]?.status)
    .toBe('open');
});

test("a counter's cash bill is in the queue within 5 seconds under its salesman; Enter confirms it", async ({
  page,
}) => {
  await openCounter(page);
  const bill = await sell(page, 'FNBL002');
  const started = Date.now();
  const group = queue().getByRole('rowgroup', { name: SALESMAN.fullName });
  await expect(group.getByText(bill)).toBeVisible({ timeout: 5_000 });
  test.info().annotations.push({ type: 'finalize to visible', description: `${Date.now() - started} ms` });

  // The earlier flows' cash bills wait in the queue too (nobody handed them over): pick this one, as the cashier
  // matches the salesman's paper to its row.
  await queue()
    .getByRole('row', { name: new RegExp(bill) })
    .click();
  await scanField().press('Enter');
  await expect(deskNotice()).toHaveText(new RegExp(`Received Rs\\s?900 for ${bill}`));
  await expect(queue().getByText(bill)).toBeHidden();
  await expect
    .poll(() => handoverOf(bill))
    .toMatchObject({ method: 'queue', linked: true, status: 'received' });
});

test('E corrects the cash received; the correction is kept on the handover, the bill stays as printed', async ({
  page,
}) => {
  await openCounter(page);
  const bill = await sell(page, 'FNBL002', '1000');
  await expect(queue().getByText(bill)).toBeVisible({ timeout: 10_000 });
  await queue()
    .getByRole('row', { name: new RegExp(bill) })
    .click();
  await scanField().press('e');
  const dialog = till.getByRole('dialog');
  await dialog.getByLabel(pos.desk.correct.label).fill('5000');
  await dialog.getByRole('button', { name: pos.desk.correct.action }).click();
  await expect(deskNotice()).toHaveText(new RegExp(`for ${bill} · change Rs\\s?4,100`));
  await expect
    .poll(() => handoverOf(bill))
    .toMatchObject({ received_amount: '500000', corrected_from: '100000', exceptions: 0 });
});

test('a scan of a queued bill selects it, and Enter records it as scanned', async ({ page }) => {
  await openCounter(page);
  const bill = await sell(page, 'AFLT001');
  await expect(queue().getByText(bill)).toBeVisible({ timeout: 10_000 });
  await scanField().fill(`${bill} 1400`);
  await scanField().press('Enter');
  await expect(queue().getByRole('row', { selected: true })).toContainText(bill);
  await scanField().press('Enter');
  await expect.poll(() => handoverOf(bill)).toMatchObject({ method: 'scan', linked: true });
});

test("offline, the desk records a bill whose counter hasn't synced from its code; the server matches it later", async ({
  page,
  context,
}) => {
  // Offline and back: the reconnect retries take their time.
  test.setTimeout(90_000);
  await openCounter(page);
  await context.setOffline(true);
  await desk.setOffline(true);
  const bill = await sell(page, 'FNBL001');
  await expect(till.getByText(/queue is not updating · scan each bill/)).toBeVisible({ timeout: 10_000 });

  await scanField().fill(`${bill} 1300`);
  await scanField().press('Enter');
  const dialog = till.getByRole('dialog');
  await expect(dialog).toContainText(`${bill} isn’t in the queue yet`);
  await dialog.getByRole('button', { name: /Record Rs\s?1,300/ }).click();
  await expect(deskNotice()).toHaveText(new RegExp(`Received Rs\\s?1,300 for ${bill}`));

  // A second scan of the same paper is refused on the desk, offline too.
  await scanField().fill(`${bill} 1300`);
  await scanField().press('Enter');
  await expect(till.getByRole('alert')).toContainText('Already handed over');

  await desk.setOffline(false);
  await context.setOffline(false);
  // Back online, the counter pushes its bill; the server links the desk's scan to it.
  await expect(page.getByText('0 bills waiting to sync')).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => handoverOf(bill), { timeout: 30_000 })
    .toMatchObject({ method: 'scan', linked: true, status: 'received', exceptions: 0 });
});

test('a cash sale on the desk itself is handed over by itself; then the session closes', async () => {
  await till.keyboard.press('Alt+Q');
  const box = till.getByRole('combobox');
  await box.fill('FNBL002');
  await expect(
    till.getByRole('listbox', { name: pos.search.results }).getByRole('option').first(),
  ).toBeVisible();
  await box.press('Enter');
  await expect(box).toHaveValue('');
  await till.keyboard.press('F9');
  await till.getByRole('dialog').getByLabel(pos.pay.cashReceived).press('Enter');
  const notice = till.getByRole('region', { name: pos.bill.title }).getByRole('status');
  await expect(notice).toHaveText(/^Bill D01-S\d{6} printed/);
  const bill = /D01-S\d{6}/.exec((await notice.textContent()) ?? '')![0];
  await expect
    .poll(() => handoverOf(bill), { timeout: 15_000 })
    .toMatchObject({ method: 'auto', linked: true });

  await till.keyboard.press('Alt+Q');
  await expect(queue()).toBeVisible();
  // The desk reads its session again when the screen comes back: wait for the bar, as the cashier sees it.
  await expect(till.getByText(pos.desk.expected)).toBeVisible();
  await till.keyboard.press('Alt+X');
  await till.getByRole('dialog').getByRole('button', { name: pos.desk.close.action }).click();
  await expect(deskNotice()).toHaveText(/Session D01-Z000002 closed/);
  await expect
    .poll(async () => (await sql<{ status: string }>('SELECT status FROM erp.cash_sessions'))[0]?.status, {
      timeout: 15_000,
    })
    .toBe('closed');
});
