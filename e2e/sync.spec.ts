import type { Page } from '@playwright/test';
import pg from 'pg';

import bo from '../apps/backoffice/src/locales/en.json' with { type: 'json' };
import pos from '../apps/pos/src/locales/en.json' with { type: 'json' };
import { account, menu, signOut } from './backoffice';
import { expect, test } from './counter-test';
import {
  BACKOFFICE_PORT,
  MANAGER,
  OWN_PIN,
  OWNER,
  OWNER_PASSWORD,
  POS_PORT,
  SALESMAN,
  SHOP,
} from './fixtures';

// W1-07 plan scope 8: push from the counter after the counter flows (counter.spec.ts) built its staff and bills. Offline
// bills wait and arrive in order; the offline warnings at 8 and 48 hours; a server change through the SSE nudge; a
// refused bill under Needs attention and a manager's Try again; a server restore re-pushed; the counter's health in
// the back office; revoke and Re-enable.

const BACKOFFICE = `http://localhost:${BACKOFFICE_PORT}`;
const POS = `http://localhost:${POS_PORT}`;

test.describe.configure({ mode: 'serial' });

/** The E2E database itself, as the superuser: to see what the server stored, change a price, and play a restore. */
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

/** The counter the flows run on: the one with the bills. */
const counterCode = async () =>
  (
    await sql<{ code: string }>(
      `SELECT v.code FROM erp.devices v JOIN erp.sales_documents d ON d.device_id = v.id
       GROUP BY v.code ORDER BY count(*) DESC LIMIT 1`,
    )
  )[0]!.code;

const storedSeqs = async (code: string) =>
  (
    await sql<{ seq: number }>(
      `SELECT d.seq FROM erp.sales_documents d JOIN erp.devices v ON v.id = d.device_id WHERE v.code = $1
       ORDER BY d.seq`,
      [code],
    )
  ).map((r) => r.seq);

const waiting = (page: Page, n: number) =>
  page.getByText(n === 1 ? '1 bill waiting to sync' : `${n} bills waiting to sync`);
/** Nothing left to sync: once the status bar shows what the counter really holds (it starts at 0 before reading). */
const synced = async (page: Page) => {
  await expect(page.getByText(/^Last sync/)).toBeVisible({ timeout: 15_000 });
  await expect(waiting(page, 0)).toBeVisible({ timeout: 15_000 });
};
const billPanel = (page: Page) => page.getByRole('region', { name: pos.bill.title });
const notice = (page: Page) => billPanel(page).getByRole('status');
const recordPrints = (page: Page) =>
  page.addInitScript(() => {
    window.print = () => undefined;
  });
const unlockAs = async (page: Page, fullName: string, pin: string) => {
  await page.getByRole('button', { name: new RegExp(fullName) }).click();
  await page.getByLabel(pos.unlock.pin).fill(pin);
  await page.getByRole('button', { name: pos.unlock.submit }).click();
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
/** Sells one of `item` for exact cash and returns the bill number. */
const sell = async (page: Page, item: string) => {
  await addToBill(page, item);
  await page.keyboard.press('F9');
  await page.getByRole('dialog').getByLabel(pos.pay.cashReceived).press('Enter');
  await expect(notice(page)).toHaveText(/^Bill C\d+-S\d{6} printed/);
  return /C\d+-S\d{6}/.exec((await notice(page).textContent()) ?? '')![0];
};
/** Signs in as the owner and opens Counters; the shared profile may still be signed in from the counter flows. */
const signIn = async (page: Page) => {
  await page.goto(BACKOFFICE);
  const shopCode = page.getByLabel(bo.login.shopCode);
  await expect(account(page).or(shopCode)).toBeVisible();
  if (await account(page).isVisible()) await signOut(page);
  await page.getByLabel(bo.login.shopCode).fill(SHOP);
  await page.getByLabel(bo.login.username).fill(OWNER.username);
  await page.getByLabel(bo.login.password).fill(OWNER_PASSWORD);
  await page.getByRole('button', { name: bo.login.submit }).click();
  await menu(page, bo.nav.counters);
};

test('offline bills wait on the counter; back online they all reach the server, in order', async ({
  page,
  context,
}) => {
  await recordPrints(page);
  await page.goto(POS);
  // The last counter flow ended offline with a bill waiting: it goes first.
  await synced(page);
  const code = await counterCode();
  const before = await storedSeqs(code);

  await context.setOffline(true);
  await unlockAs(page, SALESMAN.fullName, OWN_PIN);
  for (const item of ['fnbl001', 'fnbl002', 'brpd001']) await sell(page, item);
  await expect(waiting(page, 3)).toBeVisible();

  await context.setOffline(false);
  await expect(waiting(page, 0)).toBeVisible({ timeout: 15_000 });
  const last = before.at(-1)!;
  expect(await storedSeqs(code)).toEqual([...before, last + 1, last + 2, last + 3]);
  const arrival = await sql<{ seq: number }>(
    `SELECT i.seq FROM erp.sync_inbox i JOIN erp.devices v ON v.id = i.device_id
     WHERE v.code = $1 AND i.seq > $2 ORDER BY i.received_at, i.seq`,
    [code, last],
  );
  expect(arrival.map((r) => r.seq)).toEqual([last + 1, last + 2, last + 3]);
});

test('a price changed on the server reaches the counter at once through the nudge; Alt+S shows it live', async ({
  page,
}) => {
  await recordPrints(page);
  await page.goto(POS);
  await unlockAs(page, SALESMAN.fullName, OWN_PIN);
  // The bill made offline in the last flow arrives first.
  await synced(page);
  await page.keyboard.press('Alt+S');
  const health = page.getByRole('dialog', { name: pos.health.title });
  await expect(health).toContainText(pos.health.sseOn, { timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(health).toHaveCount(0);

  const setPrice = (price: number) =>
    sql(
      `UPDATE erp.item_prices p SET price = $1 FROM erp.items i, erp.price_tiers t
       WHERE p.item_id = i.id AND p.tier_id = t.id AND i.code = 'BRPD001' AND t.code = 'RETAIL'`,
      [price],
    );
  await setPrice(460000);
  try {
    // Well inside the minute between timed pulls: the nudge made the counter pull.
    const box = page.getByRole('combobox');
    await expect(async () => {
      await box.fill('');
      await box.fill('brpd001');
      await expect(
        page.getByRole('listbox', { name: pos.search.results }).getByRole('option').first(),
      ).toContainText(/Rs\s4,600/, { timeout: 500 });
    }).toPass({ timeout: 10_000 });
  } finally {
    await setPrice(450000);
  }
});

test('the owner renames the shop and sets the bill header; the counter shows and prints them at once (W1-25)', async ({
  page,
  browser,
}) => {
  // window.print() records what the print container shows, as in counter.spec.ts.
  await page.addInitScript(() => {
    const w = window as unknown as { printed: string[] };
    w.printed = [];
    window.print = () => void w.printed.push(document.getElementById('print-root')?.innerText ?? '');
  });
  const [before] = await sql<{ name: string }>('SELECT name FROM erp.tenants');
  await page.goto(POS);
  await unlockAs(page, SALESMAN.fullName, OWN_PIN);
  await synced(page);

  const office = await browser.newContext();
  try {
    const bop = await office.newPage();
    await bop.goto(BACKOFFICE);
    await bop.getByLabel(bo.login.shopCode).fill(SHOP);
    await bop.getByLabel(bo.login.username).fill(OWNER.username);
    await bop.getByLabel(bo.login.password).fill(OWNER_PASSWORD);
    await bop.getByRole('button', { name: bo.login.submit }).click();
    await menu(bop, bo.nav.shopSettings);
    await expect(bop.getByRole('textbox', { name: bo.shop.fields.name })).toHaveValue(before!.name);
    await bop.getByRole('textbox', { name: bo.shop.fields.name }).fill('E2E City Auto Corner');
    await bop.getByRole('textbox', { name: bo.shop.fields.phone }).fill('021-1234567');
    await bop.getByRole('textbox', { name: bo.shop.fields.line1 }).fill('Dealers in genuine parts');
    await bop.getByRole('button', { name: bo.shop.save }).click();
    await expect(bop.getByRole('status')).toHaveText(bo.shop.saved);

    // The nudge makes the counter pull: the status bar has the new name well inside the minute between pulls.
    await expect(page.getByText('E2E City Auto Corner')).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Alt+P');
    const reprint = page.getByRole('dialog', { name: pos.reprint.title });
    await expect(reprint.getByRole('option').first()).toBeVisible();
    await reprint.getByLabel(pos.reprint.search).press('Enter');
    await expect(notice(page)).toHaveText(/reprinted$/);
    const copy = (await page.evaluate(() => (window as unknown as { printed: string[] }).printed)).at(-1)!;
    // The print container's text has no line breaks between its lines.
    expect(copy).toMatch(/E2E City Auto Corner\s*021-1234567\s*Dealers in genuine parts\s*SALE BILL/);
  } finally {
    await office.close();
    // Back as it was, for the flows after this one.
    await sql('UPDATE erp.tenants SET name = $1', [before!.name]);
    await sql("UPDATE erp.branches SET phone = NULL, receipt_header = '{}'");
  }
});

test('a bill the server refuses waits under Needs attention; a manager’s Try again sends it', async ({
  page,
}) => {
  await recordPrints(page);
  // The server's answer is replaced with a refusal and the bill kept from it, as for a bill it can't read.
  await page.route('**/api/sync/push', async (route) => {
    const body = route.request().postDataJSON() as { documents: { id: string }[] };
    const response = await route.fetch({ postData: JSON.stringify({ ...body, documents: [] }) });
    const answer = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      response,
      json: {
        ...answer,
        results: body.documents.map((d) => ({
          id: d.id,
          status: 'rejected',
          exceptions: [],
          error: 'bad_schema',
        })),
      },
    });
  });
  await page.goto(POS);
  await unlockAs(page, SALESMAN.fullName, OWN_PIN);
  const number = await sell(page, 'fnbl001');
  await expect(page.getByText('1 bill needs attention')).toBeVisible({ timeout: 15_000 });
  await page.unroute('**/api/sync/push');

  await page.getByRole('button', { name: pos.status.openHealth }).click();
  const health = page.getByRole('dialog', { name: pos.health.title });
  await expect(health).toContainText(number);
  await expect(health).toContainText(pos.health.error.bad_schema);
  await health.getByRole('button', { name: pos.health.tryAgain }).click();
  const retry = page.getByRole('dialog', { name: pos.health.tryAgain });
  await retry.getByRole('button', { name: new RegExp(MANAGER.fullName) }).click();
  await retry.getByLabel(pos.health.pin).fill(MANAGER.pin);
  await retry.getByRole('button', { name: pos.health.tryAgain }).click();
  await expect(page.getByText(`Bill ${number} will be sent again.`)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(waiting(page, 0)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('1 bill needs attention')).toHaveCount(0);
  const [stored] = await sql<{ number: string }>('SELECT number FROM erp.sales_documents WHERE number = $1', [
    number,
  ]);
  expect(stored?.number).toBe(number);
});

test('after a server restore, the counter puts back every bill the server lost', async ({ page }) => {
  const code = await counterCode();
  const before = await storedSeqs(code);
  expect(before.length).toBeGreaterThan(5);
  // A restore to before these bills: the server simply no longer has them (SYN-05).
  await sql(`
    DO $$ DECLARE dev uuid := (SELECT id FROM erp.devices WHERE code = '${code}'); BEGIN
      SET LOCAL session_replication_role = replica;
      DELETE FROM erp.sales_payments WHERE document_id IN (SELECT id FROM erp.sales_documents WHERE device_id = dev);
      DELETE FROM erp.overrides WHERE document_id IN (SELECT id FROM erp.sales_documents WHERE device_id = dev);
      DELETE FROM erp.sales_lines WHERE document_id IN (SELECT id FROM erp.sales_documents WHERE device_id = dev);
      DELETE FROM erp.exceptions WHERE device_id = dev;
      DELETE FROM erp.sales_documents WHERE device_id = dev;
      DELETE FROM erp.sync_inbox WHERE device_id = dev;
      DELETE FROM erp.sequence_gaps WHERE device_id = dev;
      DELETE FROM erp.device_series WHERE device_id = dev;
    END $$`);
  expect(await storedSeqs(code)).toEqual([]);

  // The counter's start-up handshake sees what the server lacks and sends it again.
  await page.goto(POS);
  await expect.poll(() => storedSeqs(code), { timeout: 20_000 }).toEqual(before);
  await expect(waiting(page, 0)).toBeVisible();
});

test('the back office shows the counter’s health on Counters', async ({ page }) => {
  const code = await counterCode();
  await signIn(page);
  const row = page.getByRole('row', { name: new RegExp(code) });
  for (const text of [
    bo.counters.waitingNone,
    bo.counters.clockOk,
    bo.counters.storageOk,
    bo.counters.gapsNone,
  ])
    await expect(row).toContainText(text);
  await expect(row).not.toContainText(bo.counters.notSeen);
});

test('a revoked counter stops with its bills kept; after Re-enable it sells and syncs again', async ({
  page,
  context,
}) => {
  const code = await counterCode();
  const office = await context.newPage();
  await signIn(office);
  const row = office.getByRole('row', { name: new RegExp(code) });
  await row.getByRole('button', { name: bo.counters.revoke }).click();
  await office.getByRole('dialog').getByRole('button', { name: bo.counters.confirmRevoke }).click();
  await expect(row.getByRole('button', { name: bo.counters.reenable })).toBeVisible();

  await recordPrints(page);
  await page.goto(POS);
  await expect(page.getByText(pos.revoked.title)).toBeVisible({ timeout: 15_000 });

  await row.getByRole('button', { name: bo.counters.reenable }).click();
  await office.getByRole('dialog').getByRole('button', { name: bo.counters.confirmReenable }).click();
  await expect(row.getByRole('button', { name: bo.counters.revoke })).toBeVisible();
  await office.close();

  await page.getByRole('button', { name: pos.revoked.retry }).click();
  await unlockAs(page, SALESMAN.fullName, OWN_PIN);
  const number = await sell(page, 'fnbl002');
  await expect(waiting(page, 0)).toBeVisible({ timeout: 15_000 });
  expect(await sql('SELECT 1 FROM erp.sales_documents WHERE number = $1', [number])).toHaveLength(1);
});

// Last: Playwright's clock stays on the browser profile once installed.
test('offline for 8 hours the counter warns, for 48 strongly, and it still sells', async ({
  page,
  context,
}) => {
  await recordPrints(page);
  await page.clock.install({ time: new Date() });
  await page.goto(POS);
  await synced(page);
  // Offline, then a reload: no call still on its way can land after the clock jumps.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('button', { name: new RegExp(SALESMAN.fullName) })).toBeVisible();
  await page.clock.fastForward('09:00:00');
  await expect(page.getByText(/not reached the server for 9 hours/)).toBeVisible();
  // Selling is never blocked (SYN-06).
  await unlockAs(page, SALESMAN.fullName, OWN_PIN);
  await sell(page, 'fnbl002');
  await expect(waiting(page, 1)).toBeVisible();
  await page.clock.fastForward('40:00:00');
  await expect(page.getByText(/not reached the server for 2 days/)).toBeVisible();
  // The clock belongs to the whole browser profile: put it back before anything else runs on it.
  await page.clock.setSystemTime(new Date());
  await context.setOffline(false);
});
