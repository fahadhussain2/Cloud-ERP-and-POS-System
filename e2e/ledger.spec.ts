import type { Page } from '@playwright/test';
import pg from 'pg';

import bo from '../apps/backoffice/src/locales/en.json' with { type: 'json' };
import { expect, test } from './counter-test';
import { BACKOFFICE_PORT, OWNER, OWNER_PASSWORD, SHOP } from './fixtures';

// W1-19 plan (D-108): the owner keeps the books in the back office. A Rs 25,000 bank receipt from Rehman Autos lowers
// what they owe; an electricity bill paid from a bank; a journal voucher for partners' drawings; the bill reversed,
// once; last month locked after its checklist, and a receipt dated in it refused. Back office only; after counter.spec,
// which gives the owner their own password. Rehman Autos is used by no other flow.

const BACKOFFICE = `http://localhost:${BACKOFFICE_PORT}`;
const a = bo.accounting;

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
const menu = (page: Page, name: string) =>
  page.getByRole('navigation', { name: bo.nav.menu }).getByRole('link', { name }).click();
const owes = async () =>
  Number(
    (
      await sql<{ b: string }>(
        `SELECT coalesce((SELECT b.balance FROM erp.party_balances b JOIN erp.parties p ON p.id = b.party_id
                          WHERE p.code = 'C0077' AND b.role = 'customer'), 0)::text AS b`,
      )
    )[0]!.b,
  );
const accountId = async (code: string) =>
  (await sql<{ id: string }>('SELECT id FROM erp.accounts WHERE code = $1', [code]))[0]!.id;

test('the owner records money in and out, a voucher and a reversal, and locks last month', async ({
  browser,
}) => {
  const office = await browser.newContext();
  const page = await office.newPage();
  await signIn(page);
  await menu(page, bo.nav.money);
  await expect(page.getByText(a.notLive.title)).toBeVisible();

  // A Rs 25,000 bank receipt from Rehman Autos into HBL.
  const before = await owes();
  await page.getByRole('button', { name: a.money.newReceipt }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: a.fields.customer }).fill('Rehman');
  await dialog.getByRole('button', { name: /Rehman Autos/ }).click();
  await dialog.getByLabel(a.fields.intoBank).selectOption({ label: 'Bank: HBL' });
  await dialog.getByLabel(a.fields.amount).fill('25,000');
  await dialog.getByRole('button', { name: a.new.save }).click();
  await expect(page.getByRole('status')).toHaveText('CR000001 is posted.');
  expect(await owes()).toBe(before - 2_500_000);

  // The electricity bill, Rs 18,500 from Soneri.
  await page.getByRole('button', { name: a.money.newExpense }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel(a.fields.category).selectOption({ label: 'Utilities' });
  await dialog.getByLabel(a.fields.paidFrom).selectOption({ label: 'Bank: Soneri' });
  await dialog.getByLabel(a.fields.amount).fill('18,500');
  await dialog.getByRole('button', { name: a.new.save }).click();
  await expect(page.getByRole('status')).toHaveText('EX000001 is posted.');

  // Partners' drawings by journal voucher: Dr 3110 / Cr HBL Rs 5,000.
  await page.getByRole('button', { name: a.money.newVoucher }).click();
  await page.getByLabel(a.voucher.narration).fill("Partner's drawings, November");
  await page.getByRole('combobox', { name: 'Account, line 1' }).selectOption(await accountId('3110'));
  await page.getByLabel('Debit, line 1').fill('5,000');
  await page.getByRole('combobox', { name: 'Account, line 2' }).selectOption(await accountId('1160'));
  await page.getByLabel('Credit, line 2').fill('5,000');
  await page.getByRole('button', { name: a.voucher.post }).click();
  await expect(page.getByRole('heading', { name: `${a.types.journal_voucher} JV000001` })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('3110');

  // The bill was typed on the wrong account: reversed, once.
  await menu(page, bo.nav.money);
  await page.getByRole('link', { name: 'EX000001' }).click();
  await page.getByRole('button', { name: a.document.reverse }).click();
  await page.getByRole('dialog').getByRole('button', { name: a.document.reverse }).click();
  await expect(page.getByRole('link', { name: 'Reversed by JV000002' })).toBeVisible();
  await expect(page.getByRole('button', { name: a.document.reverse })).toHaveCount(0);
  const soneri = await sql<{ b: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b FROM erp.journal_lines l
     JOIN erp.accounts x ON x.id = l.account_id WHERE x.code = '1150'`,
  );
  expect(Number(soneri[0]!.b)).toBe(0);

  // Last month locked after its checklist; a receipt dated in it is refused.
  await menu(page, bo.nav.periods);
  const lockButton = page.getByRole('button', { name: /^Lock up to / });
  const label = (await lockButton.textContent()) ?? '';
  const lockDate = label.replace('Lock up to ', '').trim();
  await lockButton.click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByText(a.periods.lockHelp)).toBeVisible();
  await dialog.getByRole('button', { name: a.periods.lock }).click();
  await expect
    .poll(async () => (await sql<{ d: string }>('SELECT lock_date::text AS d FROM erp.tenants'))[0]!.d)
    .toBe(lockDate);
  await menu(page, bo.nav.money);
  await page.getByRole('button', { name: a.money.newReceipt }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: a.fields.customer }).fill('Rehman');
  await dialog.getByRole('button', { name: /Rehman Autos/ }).click();
  await dialog.getByLabel(a.fields.amount).fill('100');
  await dialog.getByLabel(a.fields.date).fill(lockDate);
  await dialog.getByRole('button', { name: a.new.save }).click();
  await expect(dialog.getByRole('alert')).toHaveText(a.problems.date_locked);
  await office.close();
});
