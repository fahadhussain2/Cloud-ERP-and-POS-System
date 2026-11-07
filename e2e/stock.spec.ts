import type { Page } from '@playwright/test';
import pg from 'pg';

import bo from '../apps/backoffice/src/locales/en.json' with { type: 'json' };
import { expect, test } from './counter-test';
import { BACKOFFICE_PORT, MANAGER, OWNER, OWNER_PASSWORD, SHOP } from './fixtures';

// W1-18 plan: the manager moves stock Shop → Godown and corrects the Shop's stock (−1 broken posts at once; a
// Rs 14,700 loss waits for the owner, owner answer 3), the owner approves it, and the stock card and Transfer needed
// show the result. Back office only; after purchasing.spec, which leaves 8 ENOL001 in the Shop at Rs 4,900, and after
// counter.spec, which gave the manager a back-office password. ENOL001 is not sold by any other flow.

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

const signIn = async (page: Page, username: string, password: string) => {
  await page.goto(BACKOFFICE);
  await page.getByLabel(bo.login.shopCode).fill(SHOP);
  await page.getByLabel(bo.login.username).fill(username);
  await page.getByLabel(bo.login.password).fill(password);
  await page.getByRole('button', { name: bo.login.submit }).click();
  await expect(page.getByRole('navigation', { name: bo.nav.menu })).toBeVisible();
};
const menu = (page: Page, name: string) =>
  page.getByRole('navigation', { name: bo.nav.menu }).getByRole('link', { name }).click();
const pickItem = async (page: Page, row: number, text: string) => {
  await page.getByRole('button', { name: `Item of line ${row}` }).click();
  await page.getByRole('textbox', { name: `Item of line ${row}` }).fill(text);
  await expect(page.getByRole('listbox', { name: bo.purchasing.line.results })).toContainText('ENOL001');
  await page.getByRole('textbox', { name: `Item of line ${row}` }).press('Enter');
};
const shopStock = async () =>
  (
    await sql<{ code: string; q: string }>(
      `SELECT l.code, b.qty::text AS q FROM erp.stock_balances b JOIN erp.locations l ON l.id = b.location_id
       JOIN erp.items i ON i.id = b.item_id WHERE i.code = 'ENOL001' AND b.qty <> 0 ORDER BY l.code`,
    )
  ).map((r) => `${r.code} ${r.q}`);

test('the manager moves and corrects stock; a large loss waits for the owner', async ({ browser }) => {
  const office = await browser.newContext();
  const page = await office.newPage();
  await signIn(page, MANAGER.username, MANAGER.password);

  // 5 cans from the Shop to the Godown: the route moves at once.
  await menu(page, bo.nav.transfers);
  await expect(page.getByText(bo.inventory.notLive.title)).toBeVisible();
  await page.getByRole('link', { name: bo.inventory.transfers.add }).click();
  await page.getByLabel(bo.inventory.fields.from).selectOption({ label: 'Shop' });
  await page.getByLabel(bo.inventory.fields.to).selectOption({ label: 'Godown' });
  await pickItem(page, 1, 'enol001');
  await page.getByLabel('Quantity of line 1').fill('5');
  await page.getByRole('button', { name: bo.inventory.post }).click();
  await expect(page.getByRole('heading', { name: 'TR000001' })).toBeVisible();
  await expect.poll(shopStock).toEqual(['GODOWN 5.000', 'SHOP 3.000']);

  // One broken: Rs 4,900, under the limit, posts at once against Inventory adjustments.
  await menu(page, bo.nav.adjustments);
  await page.getByRole('link', { name: bo.inventory.adjustments.add }).click();
  await page.getByLabel(bo.inventory.fields.reason).selectOption({ label: bo.inventory.reasons.damaged });
  await pickItem(page, 1, 'enol001');
  await page.getByLabel('Change of line 1').fill('-1');
  await page.getByRole('button', { name: bo.inventory.post }).click();
  await expect(page.getByRole('heading', { name: 'AD000001' })).toBeVisible();
  await expect
    .poll(() =>
      sql<{ code: string; debit: string }>(
        `SELECT a.code, l.debit::text AS debit FROM erp.journal_lines l
         JOIN erp.journal_entries e ON e.id = l.entry_id JOIN erp.accounts a ON a.id = l.account_id
         WHERE e.memo = 'AD000001' AND l.debit > 0`,
      ),
    )
    .toEqual([{ code: '5200', debit: '490000' }]);

  // Three lost: Rs 14,700, above Rs 10,000, so it waits for the owner and the stock doesn't move yet.
  await menu(page, bo.nav.adjustments);
  await page.getByRole('link', { name: bo.inventory.adjustments.add }).click();
  await page.getByLabel(bo.inventory.fields.reason).selectOption({ label: bo.inventory.reasons.lost });
  await pickItem(page, 1, 'enol001');
  await page.getByLabel('Change of line 1').fill('-3');
  await expect(page.getByRole('status')).toContainText(/Loss Rs\s?14,700/);
  await page.getByRole('button', { name: bo.inventory.adjustments.sendForApproval }).click();
  await expect(page.getByText(/Waiting for the owner's approval/)).toBeVisible();
  await expect.poll(shopStock).toEqual(['GODOWN 5.000', 'SHOP 2.000']);
  await office.close();

  // The owner approves it: it posts with the next number.
  const owner = await browser.newContext();
  const op = await owner.newPage();
  await signIn(op, OWNER.username, OWNER_PASSWORD);
  await menu(op, bo.nav.adjustments);
  await op.getByRole('main').getByRole('link', { name: bo.inventory.unnumbered }).click();
  await op.getByRole('button', { name: bo.inventory.adjustments.approve }).click();
  await expect(op.getByRole('heading', { name: 'AD000002' })).toBeVisible();
  await expect.poll(shopStock).toEqual(['GODOWN 5.000', 'SHOP -1.000']);

  // The Shop is short while the Godown has some: Transfer needed says move 1.
  await menu(op, bo.nav.transferNeeded);
  const needed = op.getByRole('table', { name: bo.inventory.needed.title });
  await expect(needed.getByRole('row', { name: /ENOL001/ })).toContainText('-1');

  // The stock card: every movement, newest first.
  await needed.getByRole('link', { name: 'ENOL001' }).click();
  const card = op.getByRole('table', { name: bo.inventory.card.movements });
  await expect(card.getByRole('link', { name: 'AD000002' })).toBeVisible();
  await expect(card.getByRole('link', { name: 'TR000001' })).toHaveCount(2);
  await expect(card.getByRole('link', { name: 'GR000001' })).toBeVisible();
  await owner.close();
});
