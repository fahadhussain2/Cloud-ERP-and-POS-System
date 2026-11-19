import bo from '../apps/backoffice/src/locales/en.json' with { type: 'json' };
import { report, signInAsOwner as signIn } from './backoffice';
import { expect, test } from './counter-test';

// W2-04 plan (RPT-16, RPT-17, ACC-07; D-116): the owner reads customers, suppliers, control and the cash flow on the
// report frame. After the counter's bills on Khan Motors' account (counter.spec), the desk's collection from Khan Motors
// and its void (till.spec): the ledger for this month shows the bills and the payment and opens a bill's trace, and
// prints as a statement; the month's statements; the balance trend; overdue; money received; user activity with the
// void and the sign-ins; the cash flow, printed and downloaded. Reads only. This file's name sorts after till.spec, so
// the desk's documents are there.

const r = bo.reports.partnerReports;

test.describe.configure({ mode: 'serial' });

test("Khan Motors' ledger for this month: the bills and the desk's payment, a bill's trace, and the statement", async ({
  page,
}) => {
  await signIn(page);
  await report(page, bo.nav.partnerLedger);
  await expect(page.getByText(r.ledger.pick.customer)).toBeVisible();
  await page.getByRole('button', { name: r.roles.customer, exact: true }).click();
  await page.getByRole('textbox', { name: r.roles.customer, exact: true }).fill('khan');
  await expect(page.getByRole('listbox', { name: bo.purchasing.line.results })).toContainText('C0042');
  await page.getByRole('textbox', { name: r.roles.customer, exact: true }).press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Khan Motors (C0042)');

  const table = page.getByRole('table', { name: bo.nav.partnerLedger });
  await expect(table.getByRole('row').filter({ hasText: 'D01-R000001' })).toContainText(r.kinds.payment);
  await expect(page.getByLabel(bo.reports.frame.figures)).toContainText(r.balance.customer.owed);
  await expect(page.getByRole('table', { name: r.statement.ageing })).toBeVisible();

  // As a statement: the shop's heading and the customer's; it prints without the menu.
  await page.getByLabel(r.ledger.statement).check();
  await expect(page).toHaveURL(/statement=1/);
  await expect(page.getByText(r.statement.for.split(' {{')[0]!, { exact: false })).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('navigation', { name: bo.nav.menu })).toBeHidden();
  await expect(page.locator('[data-slot="print-header"]')).toContainText('Khan Motors (C0042)');
  await page.emulateMedia({ media: 'screen' });

  // A bill opens its trace.
  await table.getByRole('row').filter({ hasText: r.kinds.sale }).first().getByRole('link').click();
  await expect(page).toHaveURL(/#\/support\/trace\//);
});

test("this month's statements include Khan Motors, one to a page", async ({ page }) => {
  await signIn(page);
  await report(page, bo.nav.statements);
  await page.getByLabel(bo.reports.frame.period).selectOption('thisMonth');
  const khan = page.getByRole('region', { name: 'Khan Motors' });
  await expect(khan).toBeVisible();
  await expect(khan.getByRole('table', { name: r.statement.ageing })).toBeVisible();
});

test('the balance trend shows Khan Motors today, and before go-live for the earlier points', async ({
  page,
}) => {
  await signIn(page);
  await report(page, bo.nav.balanceTrend);
  const table = page.getByRole('table', { name: bo.nav.balanceTrend });
  const khan = table.getByRole('row').filter({ hasText: 'Khan Motors' });
  await expect(khan).toBeVisible();
  await expect(khan).toContainText(r.beforeGoLive);
  await expect(page.getByRole('img', { name: /Customers/ })).toBeVisible();
  await khan.getByRole('link').click();
  await expect(page).toHaveURL(/#\/reports\/partner-ledger\?/);
});

test('overdue takes its days from the address, and every bill of today is not yet overdue', async ({
  page,
}) => {
  await signIn(page);
  await report(page, bo.nav.overdue);
  await page.getByLabel(r.overdue.by).selectOption('0');
  await expect(page).toHaveURL(/days=0/);
  await expect(page.getByRole('table', { name: bo.nav.overdue })).toContainText(bo.reports.none);
});

test("money received today lists the desk's payment from Khan Motors, by how and by whom", async ({
  page,
}) => {
  await signIn(page);
  await report(page, bo.nav.collections);
  const table = page.getByRole('table', { name: r.register.title.received });
  const row = table.getByRole('row').filter({ hasText: 'D01-R000001' });
  await expect(row).toContainText('Khan Motors');
  await expect(row).toContainText('D01');
  await expect(page.getByRole('table', { name: r.register.byMethod })).toBeVisible();
  await page.getByLabel(r.register.side).selectOption('paid');
  await expect(page.getByRole('table', { name: r.register.title.paid })).toBeVisible();
});

test("user activity shows today's void and sign-ins, and filters by kind", async ({ page }) => {
  await signIn(page);
  await report(page, bo.nav.userActivity);
  const table = page.getByRole('table', { name: bo.nav.userActivity });
  await expect(table).toContainText(r.activity.actions.sale.voided);
  await expect(table).toContainText(r.activity.records.sales_documents);
  await page.getByLabel(r.kind).selectOption('sign_in');
  await expect(page).toHaveURL(/kind=sign_in/);
  await expect(table).toContainText(r.activity.actions.login.success);
  await expect(table).not.toContainText(r.activity.actions.sale.voided);
});

test('the cash flow for this month: sales and customers in, each month opening the cash book; printed and downloaded', async ({
  page,
}) => {
  await signIn(page);
  await report(page, bo.nav.cashFlow);
  const table = page.getByRole('table', { name: bo.nav.cashFlow });
  await expect(table).toContainText(r.flow.classes.sales);
  await expect(table).toContainText(r.flow.classes.customers);
  await expect(table).toContainText(r.flow.closing);

  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('[data-slot="print-header"]')).toContainText(bo.nav.cashFlow);
  await page.emulateMedia({ media: 'screen' });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: bo.reports.csv }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^cash-flow-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/);

  await table.getByRole('columnheader').getByRole('link').first().click();
  await expect(page).toHaveURL(/#\/reports\/cash-book\?/);
});
