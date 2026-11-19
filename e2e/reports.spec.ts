import type { Page } from '@playwright/test';
import pg from 'pg';

import bo from '../apps/backoffice/src/locales/en.json' with { type: 'json' };
import pos from '../apps/pos/src/locales/en.json' with { type: 'json' };
import { menu, report } from './backoffice';
import { expect, test } from './counter-test';
import { BACKOFFICE_PORT, MANAGER, OWNER, OWNER_PASSWORD, POS_PORT, SALESMAN, SHOP } from './fixtures';

// W1-20 plan (D-110): a manager sends the counter's diagnostics after their PIN; the owner finds a counter bill in the
// sales register, traces it from the counter to the server, reviews an exception on it, and sees the diagnostics on
// the counter's page. Runs after counter.spec, whose counter, people and bills it uses.

const BACKOFFICE = `http://localhost:${BACKOFFICE_PORT}`;
const POS = `http://localhost:${POS_PORT}`;
const r = bo.reports;

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

const signIn = async (page: Page) => {
  await page.goto(BACKOFFICE);
  await page.getByLabel(bo.login.shopCode).fill(SHOP);
  await page.getByLabel(bo.login.username).fill(OWNER.username);
  await page.getByLabel(bo.login.password).fill(OWNER_PASSWORD);
  await page.getByRole('button', { name: bo.login.submit }).click();
  await expect(page.getByRole('navigation', { name: bo.nav.menu })).toBeVisible();
};

test('a manager sends the counter’s diagnostics after their PIN', async ({ page }) => {
  await page.goto(POS);
  await expect(page.getByRole('button', { name: new RegExp(SALESMAN.fullName) })).toBeVisible();
  await page.keyboard.press('Alt+S');
  await page.getByRole('button', { name: pos.health.diagnostics.send }).click();
  await page.getByRole('button', { name: new RegExp(MANAGER.fullName) }).click();
  await page.getByLabel(pos.health.pin).fill(MANAGER.pin);
  await page.getByRole('button', { name: pos.health.diagnostics.send }).click();
  await expect(page.getByText(pos.health.diagnostics.sent)).toBeVisible();
  await expect
    .poll(async () => (await sql('SELECT 1 FROM erp.device_diagnostics')).length)
    .toBeGreaterThanOrEqual(1);
});

test('the owner finds a counter bill in the register, traces it, reviews an exception and sees the diagnostics', async ({
  browser,
}) => {
  const [bill] = await sql<{ id: string; number: string; day: string; device_id: string }>(
    `SELECT id, number, business_date::text AS day, device_id FROM erp.sales_documents
     WHERE kind = 'sale' AND status = 'finalized' ORDER BY received_at LIMIT 1`,
  );
  expect(bill, 'counter.spec sold a bill').toBeDefined();
  const office = await browser.newContext();
  const page = await office.newPage();
  await signIn(page);

  // The sales register on the bill's day lists it.
  await report(page, bo.nav.salesRegister);
  await page.getByLabel(r.frame.from).fill(bill!.day);
  await page.getByLabel(r.frame.to).fill(bill!.day);
  await expect(page.getByRole('table', { name: r.register.list })).toContainText(bill!.number);

  // Its trace: made on the counter, accepted by the server, posted.
  await report(page, bo.nav.trace);
  await page.getByLabel(bo.support.trace.number).fill(bill!.number);
  await page.getByRole('button', { name: bo.support.trace.find }).click();
  await expect(page.getByText(/^Made on /)).toBeVisible();
  await expect(page.getByText(/^Reached the server/)).toBeVisible();

  // An exception on it, reviewed with a note: audited, and no longer open.
  const [e] = await sql<{ id: string }>(
    `INSERT INTO erp.exceptions (tenant_id, kind, severity, document_type, document_id, device_id, business_date,
       details, created_at, updated_at)
     SELECT tenant_id, 'clock_skew', 'high', 'sale', id, device_id, business_date, '{"skewMs": 400000}', now(), now()
     FROM erp.sales_documents WHERE id = $1 RETURNING id`,
    [bill!.id],
  );
  await report(page, bo.nav.exceptions);
  await page.getByLabel(r.frame.from).fill(bill!.day);
  await page.getByLabel(r.frame.to).fill(bill!.day);
  const row = page.getByRole('row', { name: new RegExp(r.exc.kinds.clock_skew) });
  await row.getByRole('button', { name: r.exc.review }).click();
  await page.getByRole('dialog').getByLabel(r.exc.note).fill('PC clock fixed');
  await page.getByRole('dialog').getByRole('button', { name: r.exc.save }).click();
  await expect
    .poll(
      async () =>
        (await sql<{ status: string }>('SELECT status FROM erp.exceptions WHERE id = $1', [e!.id]))[0]!
          .status,
    )
    .toBe('reviewed');
  await expect(page.getByRole('row', { name: new RegExp(r.exc.kinds.clock_skew) })).toHaveCount(0);

  // The diagnostics the manager sent, on the counter's page.
  await menu(page, bo.nav.counters);
  const [device] = await sql<{ code: string }>('SELECT code FROM erp.devices WHERE id = $1', [
    bill!.device_id,
  ]);
  await page
    .getByRole('row', { name: new RegExp(device!.code) })
    .getByRole('button', { name: bo.counters.diagnostics.show })
    .click();
  await expect(page.getByRole('table', { name: bo.counters.diagnostics.title })).toContainText(
    MANAGER.fullName,
  );
  await office.close();
});
