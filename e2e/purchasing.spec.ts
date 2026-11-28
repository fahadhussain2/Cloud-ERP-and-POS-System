import type { Page } from '@playwright/test';
import pg from 'pg';

import bo from '../apps/backoffice/src/locales/en.json' with { type: 'json' };
import { choose, menu, pick } from './backoffice';
import { expect, test } from './counter-test';
import { BACKOFFICE_PORT, OWNER, OWNER_PASSWORD, SHOP } from './fixtures';

// W1-16 plan: the owner adds a supplier, types the supplier's bill with a bill discount (Post waits until the lines
// equal the bill), posts it, returns part of it, pays by bank, and reads it all on the supplier's ledger. Back office
// only; after counter.spec, so the owner's own password is set. ENOL001 is not sold by any other flow.
// It uses the shared fixtures (./counter-test), so every flow runs in one worker with one counter profile: a file with
// other fixtures ran in a worker of its own, and the flows after it got a fresh counter (staging CI, 2026-11-06). The
// back office gets its own browser context, as in counter.spec, so the counter's profile stays as it was.

const BACKOFFICE = `http://localhost:${BACKOFFICE_PORT}`;

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

test('the owner records a supplier bill with a bill discount, returns part of it and pays by bank', async ({
  browser,
}) => {
  const office = await browser.newContext();
  const page = await office.newPage();
  await signIn(page);

  // The supplier.
  await menu(page, bo.nav.suppliers);
  await expect(page.getByText(/legacy app/i)).toHaveCount(0); // no go-live notice (D-113)
  await page.getByRole('button', { name: bo.purchasing.suppliers.add }).click();
  // Add supplier opens a dialog (owner review, 2026-11-07).
  const form = page.getByRole('dialog');
  await form.getByLabel(bo.purchasing.fields.code).fill('S100');
  await form.getByLabel(bo.purchasing.fields.name).fill('Naveed Glass');
  await form.getByLabel(bo.purchasing.fields.terms).fill('30');
  await form.getByLabel(bo.purchasing.fields.labelAbbr).fill('NG');
  await form.getByRole('button', { name: new RegExp(`^${bo.purchasing.suppliers.create}`) }).click();
  await expect(page.getByRole('heading', { name: 'Naveed Glass' })).toBeVisible();

  // The bill: 10 × Rs 5,000 less Rs 1,000 on the whole bill = Rs 49,000.
  await menu(page, bo.nav.receipts);
  await page.getByRole('link', { name: bo.purchasing.receipts.add }).click();
  await pick(page, bo.purchasing.fields.supplier, 'Naveed Glass');
  await page.getByLabel(bo.purchasing.fields.billNo).fill('INV-4471');
  // W2-13 (owner, 2026-11-26): ↓ moves through the results and Enter takes the highlighted one, not the first.
  await page.getByRole('button', { name: 'Item of line 1' }).click();
  await page.getByRole('combobox', { name: 'Item of line 1' }).fill('fnbl');
  await expect(
    page.getByRole('listbox', { name: bo.purchasing.line.results }).getByRole('option'),
  ).toHaveCount(2);
  await page.getByRole('combobox', { name: 'Item of line 1' }).press('ArrowDown');
  await page.getByRole('combobox', { name: 'Item of line 1' }).press('Enter');
  await expect(page.getByRole('button', { name: 'Item of line 1' })).toContainText('FNBL002');
  // W2-16 (owner, 2026-11-28): after a pick the cursor is back on the item, so Tab goes on to the quantity.
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Quantity of line 1')).toBeFocused();
  // The line's item for this flow, typed straight into the field reached from the keyboard (W2-16).
  await page.getByRole('button', { name: 'Item of line 1' }).focus();
  await page.keyboard.type('enol001');
  await expect(page.getByRole('combobox', { name: 'Item of line 1' })).toHaveValue('enol001');
  await expect(page.getByRole('listbox', { name: bo.purchasing.line.results })).toContainText('ENOL001');
  await page.getByRole('combobox', { name: 'Item of line 1' }).press('Enter');
  await expect(page.getByRole('button', { name: 'Item of line 1' })).toContainText('ENOL001');

  // A problem under the quantity leaves the line's boxes in line, and typing moves no column (W2-16).
  const boxes = ['Item of line 1', 'Quantity of line 1', 'Unit cost of line 1', 'Discount of line 1'];
  const boxOf = (name: string) =>
    name.startsWith('Item') ? page.getByRole('button', { name }) : page.getByLabel(name, { exact: true });
  await page.getByLabel('Quantity of line 1').fill('0');
  await page.getByLabel('Quantity of line 1').press('Tab');
  await expect(page.getByLabel('Quantity of line 1')).toHaveAttribute('aria-invalid', 'true');
  const tops = await Promise.all(boxes.map(async (b) => (await boxOf(b).boundingBox())!.y));
  expect(new Set(tops.map((y) => Math.round(y))).size).toBe(1);
  // Two problems on one line each stay inside their own column, wrapping there, never running into the next (W2-17).
  await page.getByLabel('Unit cost of line 1').fill('abc');
  await page.getByLabel('Unit cost of line 1').press('Tab');
  await expect(page.getByLabel('Unit cost of line 1')).toHaveAttribute('aria-invalid', 'true');
  for (const name of ['Quantity of line 1', 'Unit cost of line 1']) {
    const box = page.getByLabel(name, { exact: true });
    const id = (await box.getAttribute('aria-describedby'))!.split(' ')[0]!;
    const message = page.locator(`[id="${id}"]`);
    await expect(message).toBeVisible();
    expect(await message.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const [m, b] = [(await message.boundingBox())!, (await box.boundingBox())!];
    expect(m.x).toBeGreaterThanOrEqual(b.x - 1);
    expect(m.x + m.width).toBeLessThanOrEqual(b.x + b.width + 1);
  }
  const lefts = async () =>
    Promise.all(boxes.map(async (b) => Math.round((await boxOf(b).boundingBox())!.x)));
  const before = await lefts();
  await page.getByLabel('Unit cost of line 1').fill('5000');
  await page.getByLabel('Discount of line 1').fill('1250');
  expect(await lefts()).toEqual(before);
  await page.getByLabel('Discount of line 1').fill('');

  await page.getByLabel('Quantity of line 1').fill('10');
  await page.getByLabel(bo.purchasing.fields.billDiscount).fill('1000');
  await page.getByLabel(bo.purchasing.fields.billTotal).fill('48000');
  // The totals stay in view in the bar at the bottom of the window; Post stays clickable and, while the lines don't
  // add up to the bill, sends nothing and puts the cursor on the bill total (W2-16).
  const bar = page.getByRole('region', { name: bo.purchasing.bar });
  await expect(bar.getByRole('status')).toContainText(/-Rs\s?1,000/);
  await bar.getByRole('button', { name: bo.purchasing.post }).click();
  await expect(page.getByLabel(bo.purchasing.fields.billTotal)).toBeFocused();
  await expect(page.getByLabel(bo.purchasing.fields.billTotal)).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel(bo.purchasing.fields.billTotal).fill('49000');
  await expect(bar.getByRole('status')).toContainText(bo.purchasing.totals.matches);
  await bar.getByRole('button', { name: bo.purchasing.post }).click();
  await expect(page.getByRole('heading', { name: 'GR000001' })).toBeVisible();
  // Rs 4,900 a can after the bill discount: the item's average and last cost.
  await expect
    .poll(() =>
      sql<{ avg: string; last: string }>(
        `SELECT k.avg_cost::text AS avg, k.last_cost::text AS last FROM erp.item_costs k
         JOIN erp.items i ON i.id = k.item_id WHERE i.code = 'ENOL001'`,
      ),
    )
    .toEqual([{ avg: '490000', last: '490000' }]);

  // W1-17: the received cans' labels, one per piece, with the supplier's abbreviation and the Code 39 barcode.
  await page.getByRole('main').getByRole('link', { name: bo.labels.makeLabels }).click();
  await expect(page.getByText('GR000001 · Naveed Glass')).toBeVisible();
  // Opened by its number, which the field shows (W2-16 point 8).
  await expect(page.getByLabel(bo.labels.receiptNumber)).toHaveValue('GR000001');
  await expect(page.getByLabel('Labels for ENOL001')).toHaveValue('10');
  const preview = page.getByRole('region', { name: bo.labels.preview });
  await expect(preview.getByRole('img', { name: 'Label ENOL001' })).toHaveCount(10);
  await expect(preview.getByRole('img', { name: 'Label ENOL001' }).first()).toContainText('NG');
  await expect(preview.locator('svg rect').first()).toBeAttached();
  await page.getByLabel('Labels for ENOL001').fill('3');
  await expect(page.getByText('3 labels')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'GR000001' })).toBeVisible();

  // Two back to the supplier, from this receipt.
  await page.getByRole('link', { name: bo.purchasing.returns.fromReceipt }).click();
  await page.getByLabel('Quantity of line 1').fill('2');
  await choose(page, bo.purchasing.fields.reason, bo.purchasing.reasons.damaged);
  await expect(page.getByText(/Supplier owes back: Rs\s?9,800/)).toBeVisible();
  await page.getByRole('button', { name: bo.purchasing.post }).click();
  await expect(page.getByRole('heading', { name: 'PR000001' })).toBeVisible();

  // The same bill typed again, in lower case: Supplier's bill no. names the receipt that has it, and Post sends nothing
  // and goes back to it (W2-18). Nothing is saved, so the numbers below are unchanged.
  await menu(page, bo.nav.receipts);
  await page.getByRole('link', { name: bo.purchasing.receipts.add }).click();
  await pick(page, bo.purchasing.fields.supplier, 'Naveed Glass');
  const again = page.getByLabel(bo.purchasing.fields.billNo);
  await again.fill('inv-4471');
  await again.press('Tab');
  await expect(page.getByRole('main').getByRole('link', { name: 'GR000001' })).toBeVisible();
  await expect(again).toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('button', { name: bo.purchasing.post }).click();
  await expect(again).toBeFocused();
  await expect(page).toHaveURL(/#\/purchasing\/receipts\/new$/);

  // A payment by bank, and the ledger: 49,000 − 9,800 − 10,000 = 29,200 owed.
  await menu(page, bo.nav.suppliers);
  await page.getByRole('link', { name: 'Naveed Glass' }).click();
  await page.getByRole('button', { name: bo.purchasing.pay.action }).click();
  const pay = page.getByRole('dialog');
  await pay.getByLabel(bo.purchasing.pay.amount).fill('10000');
  await pay.getByRole('button', { name: new RegExp(`^${bo.purchasing.pay.confirm}`) }).click();
  // A toast; the one for the supplier added a moment ago may still be showing (CI, 2026-11-27).
  await expect(page.getByRole('status').filter({ hasText: 'SP000001' })).toBeVisible();
  const ledger = page.getByRole('table', { name: bo.purchasing.ledger.title });
  await expect(ledger).toContainText('GR000001');
  await expect(ledger).toContainText('PR000001');
  await expect(ledger).toContainText('SP000001');
  await expect(page.getByText(/The shop owes Rs\s?29,200/)).toBeVisible();
  await office.close();
});
