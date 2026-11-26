import pg from 'pg';

import bo from '../apps/backoffice/src/locales/en.json' with { type: 'json' };
import { report, signInAsOwner as signIn } from './backoffice';
import { expect, test } from './counter-test';
import { SHOP } from './fixtures';

// W2-03 plan (RPT-07, RPT-09, RPT-15; D-116): the owner reads sales and purchases on the report frame. After the
// counter's sales (counter.spec) and the supplier's bill (purchasing.spec): sales and gross profit for today, by
// category, opens a category's items and an item's bills, and a bill its details (D-125); the purchase register lists the
// supplier's receipt and opens it; the rates show BRPD001's sale and what Naveed Glass was paid; sales over time draws
// its charts, prints them, and downloads as CSV. Reads only.

const r = bo.reports.salesReports;

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

/** The shop's business date now (04:00 cut-off), and the finalized bills on it. */
const TODAY = `((now() AT TIME ZONE t.timezone) - make_interval(hours => t.day_cutoff_hour))::date`;

test('sales and gross profit for today, by category, opens the items, their bills and a bill', async ({
  page,
}) => {
  const [{ bills }] = (await sql<{ bills: string }>(
    `SELECT count(*)::text AS bills FROM erp.sales_documents d
     JOIN erp.tenant_directory x ON x.tenant_id = d.tenant_id JOIN erp.tenants t ON t.id = d.tenant_id
     WHERE x.code = $1 AND d.status = 'finalized' AND d.business_date = ${TODAY}`,
    [SHOP],
  )) as [{ bills: string }];
  const [{ category }] = (await sql<{ category: string }>(
    `SELECT c.name AS category FROM erp.items i JOIN erp.categories c ON c.id = i.category_id
     JOIN erp.tenant_directory x ON x.tenant_id = i.tenant_id WHERE x.code = $1 AND i.code = 'BRPD001'`,
    [SHOP],
  )) as [{ category: string }];
  await signIn(page);
  await report(page, bo.nav.salesProfit);
  await page.getByLabel(bo.reports.frame.period).selectOption('today');
  const table = page.getByRole('table', { name: bo.nav.salesProfit });
  await expect(table).toBeVisible();
  await expect(page.getByLabel(bo.reports.frame.figures)).toContainText(`${r.bills}${bills}`);

  // The category opens its items, BRPD001 its bills, a bill its details (D-125).
  await table.getByRole('link', { name: category, exact: true }).click();
  await expect(page).toHaveURL(/group=item/);
  await table.getByRole('link', { name: /BRPD001/ }).click();
  await expect(page).toHaveURL(/group=bill/);
  await table.getByRole('link').first().click();
  await expect(page).toHaveURL(/#\/sales\/bills\//);
  await expect(page.getByRole('table', { name: bo.billDetails.items })).toBeVisible();
});

test("the purchase register lists the supplier's receipt and opens it", async ({ page }) => {
  await signIn(page);
  // This month, the default: the register is a list, up to 92 days.
  await report(page, bo.nav.purchaseRegister);
  const table = page.getByRole('table', { name: bo.nav.purchaseRegister });
  const row = table
    .getByRole('row')
    .filter({ hasText: 'Naveed Glass' })
    .filter({ hasText: r.register.kinds.receipt });
  await expect(row.first()).toBeVisible();
  await row.first().getByRole('link').click();
  await expect(page).toHaveURL(/#\/purchasing\/receipts\//);
});

test("the rates show BRPD001's sale and what Naveed Glass was paid", async ({ page }) => {
  await signIn(page);
  await report(page, bo.nav.rates);
  await expect(page.getByText(r.rates.pick)).toBeVisible();
  await page.getByRole('button', { name: r.rates.item, exact: true }).click();
  await page.getByRole('textbox', { name: r.rates.item, exact: true }).fill('BRPD001');
  await expect(page.getByRole('listbox', { name: bo.purchasing.line.results })).toContainText('BRPD001');
  await page.getByRole('textbox', { name: r.rates.item, exact: true }).press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('BRPD001');
  await expect(page.getByRole('table', { name: r.rates.sales }).getByRole('row')).not.toHaveCount(1);

  // Any item, and the supplier instead: ENOL001 at its rate on the bill and net of the bill discount.
  await page.getByRole('button', { name: r.rates.clear.item }).click();
  await page.getByRole('button', { name: r.rates.party, exact: true }).click();
  await page.getByRole('textbox', { name: r.rates.party, exact: true }).fill('naveed');
  await expect(page.getByRole('listbox', { name: bo.purchasing.line.results })).toContainText('S100');
  await page.getByRole('textbox', { name: r.rates.party, exact: true }).press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Naveed Glass');
  await expect(page.getByRole('table', { name: r.rates.purchases })).toContainText('ENOL001');
});

test('sales over time draws its charts, prints them, and downloads as CSV', async ({ page }) => {
  await signIn(page);
  await report(page, bo.nav.salesOverTime);
  await expect(page.getByRole('img', { name: r.overTime.trend.day })).toBeVisible();
  await expect(page.getByRole('table', { name: r.overTime.hours })).toBeVisible();
  await expect(page.getByRole('list', { name: r.overTime.top })).toContainText('BRPD001');

  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('navigation', { name: bo.nav.menu })).toBeHidden();
  await expect(page.locator('[data-slot="print-header"]')).toContainText(bo.nav.salesOverTime);
  await expect(page.getByRole('img', { name: r.overTime.trend.day })).toBeVisible();
  await page.emulateMedia({ media: 'screen' });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: bo.reports.csv }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^sales-over-time-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/);
});
