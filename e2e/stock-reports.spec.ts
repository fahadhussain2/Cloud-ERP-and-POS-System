import pg from 'pg';

import bo from '../apps/backoffice/src/locales/en.json' with { type: 'json' };
import { chooseValue, report, signInAsOwner as signIn } from './backoffice';
import { expect, test } from './counter-test';
import { SHOP } from './fixtures';

// W2-02 plan (RPT-08, RPT-12, RPT-13, PUR-07 list; D-116): the owner reads the stock on the report frame. After the
// counter's sales (counter.spec) and the supplier's bill (purchasing.spec): stock at today shows the stock the shop has;
// a sold part's stock ledger opens the bill's details (D-125); an item below its minimum is on the reorder list under its
// supplier, and prints; the stock movement downloads as CSV. Reads only, except ENOL001's reorder levels, put back after.

const r = bo.reports.stockReports;

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

/** Thousandths as the screens show them: 2500 → "2.5". */
const qtyText = (t: number) => {
  const a = Math.abs(t);
  const rest = String(a % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return `${t < 0 ? '-' : ''}${Math.floor(a / 1000)}${rest ? `.${rest}` : ''}`;
};

test('stock at today is the stock on hand; a sold part opens its stock ledger and the bill', async ({
  page,
}) => {
  await signIn(page);
  await report(page, bo.nav.stockAt);
  const table = page.getByRole('table', { name: bo.nav.stockAt });
  await expect(table).toBeVisible();
  // Stock as on the shop's business date (04:00 cut-off): between midnight and 04:00 a document dated by the calendar
  // is tomorrow's, and not in stock "as on today" yet.
  const [{ q }] = (await sql<{ q: string }>(
    `SELECT (coalesce(sum(m.qty_delta), 0) * 1000)::bigint::text AS q FROM erp.stock_movements m
     JOIN erp.tenants t ON t.id = m.tenant_id JOIN erp.tenant_directory d ON d.tenant_id = t.id
     WHERE d.code = $1
       AND m.business_date <= ((now() AT TIME ZONE t.timezone) - make_interval(hours => t.day_cutoff_hour))::date`,
    [SHOP],
  )) as [{ q: string }];
  await expect(page.getByLabel(bo.reports.frame.figures)).toContainText(qtyText(Number(q)));

  // BRPD001, sold on the counter: its ledger, and a bill line opens its details (D-125).
  await report(page, bo.nav.stockLedger);
  await expect(page.getByText(r.ledger.pick)).toBeVisible();
  await page.getByRole('button', { name: r.item, exact: true }).click();
  await page.getByRole('combobox', { name: r.item, exact: true }).fill('BRPD001');
  await expect(page.getByRole('listbox', { name: bo.purchasing.line.results })).toContainText('BRPD001');
  await page.getByRole('combobox', { name: r.item, exact: true }).press('Enter');
  // This month, the default: the ledger takes up to 92 days.
  await expect(page.getByRole('heading', { level: 1 })).toContainText('BRPD001');
  const lines = page.getByRole('table', { name: r.ledger.lines });
  await expect(lines.getByRole('row').filter({ hasText: r.kinds.sale }).first()).toBeVisible();
  await lines.getByRole('row').filter({ hasText: r.kinds.sale }).first().getByRole('link').click();
  await expect(page).toHaveURL(/#\/sales\/bills\//);
  await expect(page.getByRole('table', { name: bo.billDetails.items })).toBeVisible();
});

test.describe('the reorder list', () => {
  test.beforeAll(async () => {
    // Levels ENOL001 is surely under: everything it has is to be ordered up to them.
    await sql("UPDATE erp.items SET min_qty = 1000, max_qty = 1200 WHERE code = 'ENOL001'");
  });
  test.afterAll(async () => {
    await sql("UPDATE erp.items SET min_qty = NULL, max_qty = NULL WHERE code = 'ENOL001'");
  });

  test('an item below its minimum is listed under its supplier, and prints', async ({ page }) => {
    const [item] = (await sql<{ on_hand: string; supplier: string | null }>(
      `SELECT (coalesce(sum(b.qty) FILTER (WHERE l.kind IN ('shop', 'storage')), 0) * 1000)::bigint::text AS on_hand,
         p.name AS supplier
       FROM erp.items i LEFT JOIN erp.item_costs k ON k.item_id = i.id
       LEFT JOIN erp.parties p ON p.id = coalesce(k.last_supplier_id, i.default_supplier_id)
       LEFT JOIN erp.stock_balances b ON b.item_id = i.id LEFT JOIN erp.locations l ON l.id = b.location_id
       WHERE i.code = 'ENOL001' GROUP BY p.name`,
    )) as [{ on_hand: string; supplier: string | null }];
    await signIn(page);
    await report(page, bo.nav.reorder);
    const table = page.getByRole('table', { name: bo.nav.reorder });
    const row = table.getByRole('row').filter({ hasText: 'ENOL001' });
    await expect(row).toContainText(item.supplier ?? r.noGroup.supplier);
    await expect(row).toContainText(qtyText(1_200_000 - Number(item.on_hand)));

    await page.emulateMedia({ media: 'print' });
    await expect(page.getByRole('navigation', { name: bo.nav.menu })).toBeHidden();
    await expect(page.getByLabel(bo.reports.frame.filters)).toBeHidden();
    await expect(page.locator('[data-slot="print-header"]')).toContainText(bo.nav.reorder);
    await page.emulateMedia({ media: 'screen' });
  });
});

test('the stock movement downloads as CSV', async ({ page }) => {
  await signIn(page);
  await report(page, bo.nav.stockMovement);
  await chooseValue(page, bo.reports.frame.period, 'thisYear');
  await expect(page.getByRole('table', { name: bo.nav.stockMovement })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: bo.reports.csv }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^stock-movement-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/);
});
