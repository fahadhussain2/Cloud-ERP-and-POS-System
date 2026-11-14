import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, type BrowserContext, type Page } from '@playwright/test';
import pg from 'pg';

import bo from '../apps/backoffice/src/locales/en.json' with { type: 'json' };
import pos from '../apps/pos/src/locales/en.json' with { type: 'json' };
import { account, menu, signOut } from './backoffice';
import { expect, test } from './counter-test';
import {
  BACKOFFICE_PORT,
  CASHIER,
  MANAGER,
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
// sale on the desk handed over by itself. W1-11 adds a collection, a cash-out offline and the counted close (below).
// W1-12 plan scope 7: a void before the handover and its reissue, a handed-over bill refused, and an offline void of a
// bill the desk took cash for, flagged on the server.

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
  await expect(account(page).or(page.getByLabel(bo.login.shopCode))).toBeVisible();
  if (await account(page).isVisible()) await signOut(page);
  await page.getByLabel(bo.login.shopCode).fill(SHOP);
  await page.getByLabel(bo.login.username).fill(OWNER.username);
  await page.getByLabel(bo.login.password).fill(OWNER_PASSWORD);
  await page.getByRole('button', { name: bo.login.submit }).click();

  await menu(page, bo.nav.staff);
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

  await menu(page, bo.nav.counters);
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
    // Counted, so a flow can tell a receipt or slip was printed (W1-11).
    window.print = () => {
      const w = window as unknown as { prints?: number };
      w.prints = (w.prints ?? 0) + 1;
    };
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

test('a cash sale on the desk itself is handed over by itself', async () => {
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
});

/** How many times the desk has printed (a bill, a receipt, a voucher or a slip). */
const prints = () => till.evaluate(() => (window as unknown as { prints?: number }).prints ?? 0);

/** The lines a document of `type` posted, as [account, debit, credit]. */
const journalOf = async (type: string) =>
  (
    await sql<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, l.debit, l.credit FROM erp.journal_entries e JOIN erp.journal_lines l ON l.entry_id = e.id
       JOIN erp.accounts a ON a.id = l.account_id WHERE e.source_type = $1 ORDER BY e.posting_seq, l.line_no`,
      [type],
    )
  ).map((l) => [l.code, Number(l.debit), Number(l.credit)]);

// W1-11 plan scope 8: a customer's payment with its receipt, a cash-out written offline, and the drawer counted blind,
// short, acknowledged later, then acknowledged by the owner on the day reconciliation.

test('a customer pays at the desk: the receipt prints and the payment posts to their account', async () => {
  const before = await prints();
  await till.keyboard.press('Alt+R');
  const dialog = till.getByRole('dialog');
  await dialog.getByRole('combobox').fill('Khan');
  await dialog.getByRole('button', { name: pos.desk.collect.pick }).click();
  await expect(dialog).toContainText('Khan Motors (C0042)');
  await dialog.getByLabel(pos.desk.collect.amount).fill('2000');
  await dialog.getByRole('button', { name: pos.desk.collect.action }).click();
  await expect(deskNotice()).toHaveText(/Received Rs\s?2,000 from Khan Motors · D01-R000001/);
  expect(await prints()).toBe(before + 1);
  await expect
    .poll(() => journalOf('payment'), { timeout: 15_000 })
    .toEqual([
      ['1110', 200000, 0],
      ['1200', 0, 200000],
    ]);
});

test('offline, a cash-out is written and printed at the desk; it reaches the server once the desk is back', async () => {
  test.setTimeout(90_000);
  await desk.setOffline(true);
  await expect(till.getByText(/queue is not updating · scan each bill/)).toBeVisible({ timeout: 10_000 });
  const before = await prints();
  await till.keyboard.press('Alt+M');
  const dialog = till.getByRole('dialog');
  await dialog.getByLabel(pos.desk.cashOut.target.expense).selectOption({ label: 'General expenses' });
  await dialog.getByLabel(pos.desk.cashOut.amount).fill('200');
  await dialog.getByLabel(pos.desk.cashOut.note).fill('tea for the staff');
  await dialog.getByRole('button', { name: pos.desk.cashOut.action }).click();
  await expect(deskNotice()).toHaveText(/Paid out Rs\s?200 · D01-M000001/);
  expect(await prints()).toBe(before + 1);
  expect(await sql('SELECT 1 FROM erp.cash_movements')).toHaveLength(0);

  await desk.setOffline(false);
  await expect
    .poll(
      async () => (await sql<{ kind: string }>('SELECT kind FROM erp.cash_movements')).map((r) => r.kind),
      {
        timeout: 30_000,
      },
    )
    .toEqual(['expense']);
  await expect
    .poll(() => journalOf('cash_movement'))
    .toEqual([
      ['6310', 20000, 0],
      ['1110', 0, 20000],
    ]);
});

/** The counter: Alt+V, the bill by its number, then the manager's own PIN and a reason (POS spec §18). */
async function voidBill(page: Page, bill: string) {
  await page.keyboard.press('Alt+V');
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(pos.void.search).fill(bill);
  await expect(dialog.getByRole('option', { name: new RegExp(bill) })).toBeVisible();
  await dialog.getByLabel(pos.void.search).press('Enter');
}
async function approveVoid(page: Page) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: new RegExp(MANAGER.fullName) }).click();
  await dialog.getByLabel(pos.approval.pin).fill(MANAGER.pin);
  await dialog.getByLabel(pos.override.reason.wrong_price).check();
  await dialog.getByRole('button', { name: new RegExp(`^${pos.approval.action}`) }).click();
}
const saleOf = async (bill: string) =>
  (
    await sql<{ status: string; reissue_of_number: string | null }>(
      'SELECT status, reissue_of_number FROM erp.sales_documents WHERE number = $1',
      [bill],
    )
  )[0] ?? null;

test('a manager voids a cash bill before its handover: it leaves the queue, and its reissue joins it', async ({
  page,
}) => {
  await openCounter(page);
  const bill = await sell(page, 'FNBL002');
  await expect(queue().getByText(bill)).toBeVisible({ timeout: 10_000 });

  await voidBill(page, bill);
  await expect(page.getByRole('dialog')).toContainText(pos.void.deskStatus.pending);
  await approveVoid(page);
  await expect(page.getByRole('dialog')).toContainText(`Reissue ${bill}?`);
  // The desk drops it as soon as the server has the void (queue-changed).
  await expect(queue().getByText(bill)).toBeHidden({ timeout: 10_000 });
  await expect.poll(() => saleOf(bill)).toMatchObject({ status: 'voided' });

  await page.getByRole('button', { name: new RegExp(`^${pos.void.reissueAction}`) }).click();
  await expect(page.getByText(`Reissue of ${bill}`, { exact: true })).toBeVisible();
  await page.keyboard.press('F9');
  await page.getByRole('dialog').getByLabel(pos.pay.cashReceived).press('Enter');
  const notice = page.getByRole('region', { name: pos.bill.title }).getByRole('status');
  await expect(notice).toHaveText(/^Bill C\d+-S\d{6} printed/);
  const again = /C\d+-S\d{6}/.exec((await notice.textContent()) ?? '')![0];
  await expect(queue().getByText(again)).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => saleOf(again)).toMatchObject({ status: 'finalized', reissue_of_number: bill });
});

test('a bill the desk has taken cash for is refused, with when and by whom', async ({ page }) => {
  await openCounter(page);
  const bill = await sell(page, 'FNBL002');
  await expect(queue().getByText(bill)).toBeVisible({ timeout: 10_000 });
  await queue()
    .getByRole('row', { name: new RegExp(bill) })
    .click();
  await scanField().press('Enter');
  await expect.poll(() => handoverOf(bill)).toMatchObject({ status: 'received' });

  await voidBill(page, bill);
  const panel = page.getByRole('region', { name: pos.bill.title });
  await expect(panel).toContainText(new RegExp(`${bill} was handed over at .* by ${CASHIER.fullName}`));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await saleOf(bill))?.status).toBe('finalized');
});

test('offline, a void of a bill the desk took cash for meanwhile is flagged on the server', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  await openCounter(page);
  const bill = await sell(page, 'FNBL002');
  await expect(queue().getByText(bill)).toBeVisible({ timeout: 10_000 });
  await context.setOffline(true);
  // The desk, still online, takes the cash.
  await queue()
    .getByRole('row', { name: new RegExp(bill) })
    .click();
  await scanField().press('Enter');
  await expect.poll(() => handoverOf(bill)).toMatchObject({ status: 'received' });

  await voidBill(page, bill);
  // Offline the counter asks (W1-23): answered not paid yet, so the clash happens.
  await expect(page.getByRole('dialog')).toContainText(pos.void.ask.cash.replace('{{number}}', bill));
  await page.getByRole('dialog').getByRole('button', { name: pos.void.ask.cashNo }).click();
  await expect(page.getByRole('dialog')).toContainText(pos.void.approveAsked.replace('{{number}}', bill));
  await approveVoid(page);
  // No reissue: Esc.
  await expect(page.getByRole('dialog')).toContainText(`Reissue ${bill}?`);
  await page.keyboard.press('Escape');
  await context.setOffline(false);
  await expect(page.getByText('0 bills waiting to sync')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => saleOf(bill), { timeout: 30_000 }).toMatchObject({ status: 'voided' });
  const flagged = await sql<{ kind: string; order: string }>(
    `SELECT e.kind, e.details->>'order' AS order FROM erp.exceptions e JOIN erp.sales_voids v ON v.id = e.document_id
     WHERE v.sale_number = $1`,
    [bill],
  );
  expect(flagged).toEqual([{ kind: 'cash_received_for_void', order: 'before_void' }]);

  // W1-23 (D-111): the desk lists the cash it took for the voided bill and gives it back after the manager's PIN.
  const section = till.getByRole('region', { name: pos.desk.voidCash.title });
  await expect(section.getByText(bill)).toBeVisible({ timeout: 30_000 });
  await section
    .getByRole('listitem')
    .filter({ hasText: bill })
    .getByRole('button', { name: /^Give back/ })
    .click();
  const approval = till.getByRole('dialog');
  await expect(approval.getByRole('button', { name: new RegExp(CASHIER.fullName) })).toHaveCount(0);
  await approval.getByRole('button', { name: new RegExp(MANAGER.fullName) }).click();
  await approval.getByLabel(pos.approval.pin).fill(MANAGER.pin);
  await approval.getByRole('button', { name: new RegExp(`^${pos.approval.action}`) }).click();
  await expect(deskNotice()).toHaveText(new RegExp(`given back for ${bill}`));
  await expect(section.getByText(bill)).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (
          await sql<{ status: string; review_note: string | null }>(
            `SELECT status, review_note FROM erp.exceptions
             WHERE kind = 'cash_received_for_void' AND details ->> 'billNumber' = $1`,
            [bill],
          )
        ).map((e) => [e.status, e.review_note?.startsWith('Given back on D01-M') ?? false]),
      { timeout: 30_000 },
    )
    .toEqual([['reviewed', true]]);
  // The give-back undid the handover in the books: Dr cash in transit / Cr cash drawer.
  const given = await sql<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, l.debit, l.credit FROM erp.cash_movements m
     JOIN erp.journal_entries e ON e.source_type = 'cash_movement' AND e.source_id = m.id
     JOIN erp.journal_lines l ON l.entry_id = e.id JOIN erp.accounts a ON a.id = l.account_id
     WHERE m.kind = 'void_cash' AND m.bill_number = $1 ORDER BY l.line_no`,
    [bill],
  );
  expect(given.map((l) => [l.code, l.debit === '0' ? 'credit' : 'debit'])).toEqual([
    ['1120', 'debit'],
    ['1110', 'credit'],
  ]);
});

test("a bill paid by JazzCash: the void asks whether the shop's account received it; yes opens its return", async ({
  page,
}) => {
  await openCounter(page);
  const box = page.getByRole('combobox');
  await box.fill('FNBL002');
  await expect(
    page.getByRole('listbox', { name: pos.search.results }).getByRole('option').first(),
  ).toBeVisible();
  await box.press('Enter');
  await expect(box).toHaveValue('');
  await page.getByRole('group', { name: pos.pay.pad }).getByRole('button', { name: 'JazzCash' }).click();
  const reference = page.getByRole('dialog').getByLabel(pos.pay.reference.jazzcash);
  await reference.fill('JC-55120');
  await reference.press('Enter');
  const notice = page.getByRole('region', { name: pos.bill.title }).getByRole('status');
  await expect(notice).toHaveText(/^Bill C\d+-S\d{6} printed/);
  const bill = /C\d+-S\d{6}/.exec((await notice.textContent()) ?? '')![0];

  await voidBill(page, bill);
  // Online too: only a person can see the shop's JazzCash account (W1-23).
  await expect(page.getByRole('dialog')).toContainText(/Has the shop.s JazzCash account received/);
  await page.getByRole('dialog').getByRole('button', { name: pos.void.ask.accountYes }).click();
  // The money had arrived: no void, the return opens on that bill.
  await expect(page.getByRole('dialog', { name: `Return from ${bill}` })).toBeVisible();
  await page.keyboard.press('Escape');
  expect((await saleOf(bill))?.status).toBe('finalized');
  expect(await sql('SELECT 1 FROM erp.sales_voids WHERE sale_number = $1', [bill])).toEqual([]);
});

test('the drawer is counted blind, short, acknowledged later; the owner acknowledges it on the day reconciliation', async ({
  page,
}) => {
  await till.keyboard.press('Alt+X');
  const dialog = till.getByRole('dialog');
  // Blind (owner answer 2): the expected cash shows nowhere while counting.
  await expect(till.getByText(pos.desk.expected)).toBeHidden();
  await dialog.getByRole('textbox', { name: /5,000.*×/ }).fill('1');
  await dialog.getByRole('button', { name: pos.desk.count.done }).click();
  await expect(dialog.getByText(/^Short Rs/)).toBeVisible();
  await dialog.getByLabel(pos.desk.count.reason.unknown).check();
  await dialog.getByLabel(pos.desk.count.later).check();
  await dialog.getByRole('button', { name: pos.desk.count.action }).click();
  await expect(deskNotice()).toHaveText(/Session D01-Z000002 closed, variance/);
  const closed = async () =>
    (
      await sql<{
        counted_cash: string | null;
        variance: string | null;
        acknowledged_by_user_id: string | null;
      }>(
        "SELECT counted_cash, variance, acknowledged_by_user_id FROM erp.cash_sessions WHERE close_number = 'D01-Z000002'",
      )
    )[0] ?? null;
  await expect
    .poll(closed, { timeout: 15_000 })
    .toMatchObject({ counted_cash: '500000', acknowledged_by_user_id: null });
  expect(Number((await closed())!.variance)).toBeLessThan(0);

  // The owner, in the back office, on today's business day (Karachi, 04:00 cutoff).
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(
    new Date(Date.now() - 4 * 3_600_000),
  );
  await page.goto(BACKOFFICE);
  await expect(account(page).or(page.getByLabel(bo.login.shopCode))).toBeVisible();
  if (!(await account(page).isVisible())) {
    await page.getByLabel(bo.login.shopCode).fill(SHOP);
    await page.getByLabel(bo.login.username).fill(OWNER.username);
    await page.getByLabel(bo.login.password).fill(OWNER_PASSWORD);
    await page.getByRole('button', { name: bo.login.submit }).click();
  }
  await menu(page, bo.nav.dayReconciliation);
  await page.getByLabel(bo.reports.day.date).fill(today);
  await expect(page.getByText(bo.reports.day.provisional)).toBeVisible();
  // The earlier flows left cash bills nobody handed over: they are listed under their salesman.
  await expect(page.getByText(new RegExp(`${SALESMAN.fullName} ·`))).toBeVisible();
  // A session goes by its open document's number; D01-Z000002 is its close.
  const row = page.getByRole('row', { name: /D01-Z000001/ });
  await expect(row).toContainText(bo.reports.ack.waiting);
  await row.getByRole('button', { name: bo.reports.ack.action }).click();
  await expect(row).toContainText(`By ${OWNER.fullName}`);
  await expect.poll(async () => (await closed())?.acknowledged_by_user_id ?? null).not.toBeNull();
});

// W1-13 plan scope 7: returns and exchanges. The drawer above is closed, so the cashier opens a new session for the
// refunds first.

/** On the counter: F3, find `bill`, mark `qty` of `item` to come back, and put it on the bill. */
async function returnFrom(
  page: Page,
  bill: string,
  item: string,
  qty: string,
  opts: { askedPaid?: boolean } = {},
) {
  await page.keyboard.press('F3');
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(pos.return.search).fill(bill);
  await expect(dialog.getByRole('option', { name: new RegExp(bill) })).toBeVisible();
  await dialog.getByLabel(pos.return.search).press('Enter');
  if (opts.askedPaid)
    await page.getByRole('dialog').getByRole('button', { name: pos.void.ask.cashYes }).click();
  const marks = page.getByRole('dialog', { name: `Return from ${bill}` });
  await marks.getByLabel(`${pos.return.qtyBack} · ${item}`).fill(qty);
  await marks.getByLabel(`${pos.return.qtyBack} · ${item}`).press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('returned-line')).toBeVisible();
}

/** F9 on a refund, then Finalize & print; returns the return's number from the notice. */
async function refundAtDesk(page: Page): Promise<string> {
  await page.keyboard.press('F9');
  const dialog = page.getByRole('dialog', { name: pos.refund.title.cash });
  await dialog.getByRole('button', { name: new RegExp(`^${pos.pay.finalize}`) }).click();
  const notice = page.getByRole('region', { name: pos.bill.title }).getByRole('status');
  await expect(notice).toHaveText(/^Return C\d+-S\d{6} printed · refund Rs\s?[\d,]+ at the cash desk/);
  return /C\d+-S\d{6}/.exec((await notice.textContent()) ?? '')![0];
}

const returnOf = async (number: string) =>
  (
    await sql<{
      kind: string;
      handover_status: string;
      cash_due: string;
      return_of_number: string | null;
      no_receipt: boolean;
    }>(
      `SELECT kind, handover_status, cash_due, return_of_number, no_receipt FROM erp.sales_documents
       WHERE number = $1`,
      [number],
    )
  )[0] ?? null;

test('the cashier opens a new session for the refunds', async () => {
  await till.keyboard.press('Alt+O');
  await till.getByRole('dialog').getByLabel(pos.desk.open.label).fill('5000');
  await till.getByRole('dialog').getByRole('button', { name: pos.desk.open.action }).click();
  await expect(deskNotice()).toHaveText(/Session D01-Z\d{6} opened with Rs\s?5,000/);
});

test("a handed-over bill is returned on the counter; the refund is in the desk's queue and paid out with Enter", async ({
  page,
}) => {
  await openCounter(page);
  const bill = await sell(page, 'FNBL002');
  await queue()
    .getByRole('row', { name: new RegExp(bill) })
    .click({ timeout: 10_000 });
  await scanField().press('Enter');
  await expect.poll(() => handoverOf(bill)).toMatchObject({ status: 'received' });

  await returnFrom(page, bill, 'FAN BELT MEHRAN', '1');
  const ret = await refundAtDesk(page);
  const row = queue().getByRole('row', { name: new RegExp(ret) });
  await expect(row).toContainText('Pay out', { timeout: 5_000 });
  await row.click();
  await scanField().press('Enter');
  await expect(deskNotice()).toHaveText(new RegExp(`Paid out Rs\\s?900 for ${ret}`));
  await expect
    .poll(() => returnOf(ret))
    .toMatchObject({
      kind: 'return',
      handover_status: 'paid_out',
      cash_due: '-90000',
      return_of_number: bill,
    });
  const books = await sql<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, l.debit, l.credit FROM erp.journal_entries e JOIN erp.journal_lines l ON l.entry_id = e.id
     JOIN erp.accounts a ON a.id = l.account_id JOIN erp.sales_documents d ON d.id = e.source_id
     WHERE e.source_type = 'sale' AND d.number = $1 ORDER BY l.line_no`,
    [ret],
  );
  expect(books).toContainEqual({ code: '4110', debit: '90000', credit: '0' });
  expect(books).toContainEqual({ code: '1120', debit: '0', credit: '90000' });
});

test('an exchange: the fan belt back, the brake pads out, only the difference paid', async ({ page }) => {
  await openCounter(page);
  const bill = await sell(page, 'FNBL002');
  // Paid at the desk first: a return of an unpaid bill of today is a void instead (W1-23, guard 1).
  await queue()
    .getByRole('row', { name: new RegExp(bill) })
    .click({ timeout: 10_000 });
  await scanField().press('Enter');
  await expect.poll(() => handoverOf(bill)).toMatchObject({ status: 'received' });
  await returnFrom(page, bill, 'FAN BELT MEHRAN', '1');
  const box = page.getByRole('combobox');
  await box.fill('BRPD001');
  await expect(
    page.getByRole('listbox', { name: pos.search.results }).getByRole('option').first(),
  ).toBeVisible();
  await box.press('Enter');
  await expect(box).toHaveValue('');
  await expect(page.getByTestId('bill-total')).toHaveText(/Rs\s?3,600/);
  await page.keyboard.press('F9');
  await page.getByRole('dialog').getByLabel(pos.pay.cashReceived).press('Enter');
  const notice = page.getByRole('region', { name: pos.bill.title }).getByRole('status');
  await expect(notice).toHaveText(/^Bill C\d+-S\d{6} printed · bring Rs\s?3,600 to the cash desk/);
  const ex = /C\d+-S\d{6}/.exec((await notice.textContent()) ?? '')![0];
  await expect.poll(() => returnOf(ex)).toMatchObject({ kind: 'exchange', cash_due: '360000' });
});

test('without a receipt, the manager approves the refund price with their own PIN', async ({ page }) => {
  await openCounter(page);
  await page.keyboard.press('F3');
  await page.getByRole('dialog').getByRole('button', { name: pos.return.noReceipt }).click();
  const none = page.getByRole('dialog', { name: pos.return.noReceiptTitle });
  await none.getByLabel(pos.return.itemSearch).fill('FNBL002');
  await expect(none.getByRole('option').first()).toBeVisible();
  await none.getByLabel(pos.return.itemSearch).press('Enter');
  const price = none.getByLabel(`${pos.return.price} · FAN BELT MEHRAN`);
  await price.fill('800');
  await price.press('Enter');

  const approval = page.getByRole('dialog');
  await expect(approval).toContainText(pos.return.need.no_receipt_return);
  await approval.getByRole('button', { name: new RegExp(MANAGER.fullName) }).click();
  await approval.getByLabel(pos.approval.pin).fill(MANAGER.pin);
  await approval.getByLabel(pos.override.reason.before_go_live).check();
  await approval.getByRole('button', { name: new RegExp(`^${pos.approval.action}`) }).click();
  await expect(page.getByTestId('return-source')).toHaveText(pos.bill.returnedNoReceipt);
  const ret = await refundAtDesk(page);
  await expect
    .poll(() => returnOf(ret))
    .toMatchObject({ kind: 'return', no_receipt: true, cash_due: '-80000' });
  const approved = await sql<{ kind: string; approver: string }>(
    `SELECT o.kind, u.full_name AS approver FROM erp.overrides o JOIN erp.sales_documents d ON d.id = o.document_id
     JOIN erp.users u ON u.id = o.approved_by_user_id WHERE d.number = $1`,
    [ret],
  );
  expect(approved).toEqual([{ kind: 'no_receipt_return', approver: MANAGER.fullName }]);
});

test("offline, a return of this counter's own bill is written and printed, and syncs on reconnect", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  await openCounter(page);
  const bill = await sell(page, 'FNBL002');
  await queue()
    .getByRole('row', { name: new RegExp(bill) })
    .click({ timeout: 10_000 });
  await scanField().press('Enter');
  await expect.poll(() => handoverOf(bill)).toMatchObject({ status: 'received' });
  await context.setOffline(true);
  // Offline the counter can't ask the desk, so it asks the salesman (W1-23, guard 1).
  await returnFrom(page, bill, 'FAN BELT MEHRAN', '1', { askedPaid: true });
  const ret = await refundAtDesk(page);
  await context.setOffline(false);
  await expect(page.getByText('0 bills waiting to sync')).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => returnOf(ret), { timeout: 30_000 })
    .toMatchObject({ kind: 'return', return_of_number: bill });
});

test('a return of a bill of today not yet paid at the desk is offered as a void and reissue instead (guard 1)', async ({
  page,
}) => {
  await openCounter(page);
  const bill = await sell(page, 'FNBL002');
  await page.keyboard.press('F3');
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(pos.return.search).fill(bill);
  await expect(dialog.getByRole('option', { name: new RegExp(bill) })).toBeVisible();
  await dialog.getByLabel(pos.return.search).press('Enter');
  await expect(page.getByRole('dialog')).toContainText(pos.return.unpaid.replace(/\{\{number\}\}/g, bill));
  await page.getByRole('dialog').getByRole('button', { name: pos.return.voidInstead }).click();
  await expect(page.getByRole('dialog')).toContainText(pos.void.approve.replace('{{number}}', bill));
  await page.keyboard.press('Escape');
  expect((await saleOf(bill))?.status).toBe('finalized');
});

test("a split bill's refund waits at the desk until the bill's cash is collected (guard 2)", async ({
  page,
}) => {
  await openCounter(page);
  const box = page.getByRole('combobox');
  await box.fill('FNBL002');
  await expect(
    page.getByRole('listbox', { name: pos.search.results }).getByRole('option').first(),
  ).toBeVisible();
  await box.press('Enter');
  await expect(box).toHaveValue('');
  // Rs 900: Rs 500 in cash at the desk, Rs 400 by JazzCash at the counter.
  await page.keyboard.press('Shift+F9');
  const split = page.getByRole('dialog');
  await split.getByLabel('Cash amount', { exact: true }).fill('500');
  await split.getByLabel('JazzCash amount', { exact: true }).fill('400');
  await split.getByLabel(`JazzCash: ${pos.pay.reference.jazzcash}`).fill('JC-55121');
  await split.getByLabel('Cash amount', { exact: true }).press('Enter');
  const notice = page.getByRole('region', { name: pos.bill.title }).getByRole('status');
  await expect(notice).toHaveText(/^Bill C\d+-S\d{6} printed/);
  const bill = /C\d+-S\d{6}/.exec((await notice.textContent()) ?? '')![0];

  // Its JazzCash part was paid at the counter: a return, not a void (guard 1 lets it through).
  await returnFrom(page, bill, 'FAN BELT MEHRAN', '1');
  const ret = await refundAtDesk(page);
  const refund = queue().getByRole('row', { name: new RegExp(ret) });
  await expect(refund).toContainText('Pay out', { timeout: 10_000 });
  await refund.click();
  await scanField().press('Enter');
  await expect(till.getByRole('alert')).toHaveText(pos.handover.original_unpaid);
  // The bill's Rs 500 first, then the refund.
  await queue()
    .getByRole('row', { name: new RegExp(bill) })
    .click();
  await scanField().press('Enter');
  await expect.poll(() => handoverOf(bill)).toMatchObject({ status: 'received' });
  await queue()
    .getByRole('row', { name: new RegExp(ret) })
    .click();
  await scanField().press('Enter');
  await expect(deskNotice()).toHaveText(new RegExp(`Paid out Rs\\s?900 for ${ret}`));
  await expect.poll(() => returnOf(ret)).toMatchObject({ handover_status: 'paid_out' });
  expect(
    await sql(
      "SELECT 1 FROM erp.exceptions WHERE kind = 'refund_before_payment' AND details ->> 'originalNumber' = $1",
      [bill],
    ),
  ).toEqual([]);
});
