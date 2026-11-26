import bo from '../apps/backoffice/src/locales/en.json' with { type: 'json' };
import { report, signInAsOwner as signIn } from './backoffice';
import { expect, test } from './counter-test';

// W2-01 plan (ACC-07, RPT-11, D-116): the owner reads the books on the report frame. After the counter's sales
// (counter.spec) and the electricity bill (ledger.spec), this year's trial balance balances; Sales opens its ledger and
// a line opens the bill's details (D-125); the profit and loss month by month; the balance sheet balances; the trial balance
// downloads as CSV; and on paper the menu and filters go while a header names the shop. Back office only, read only.

const r = bo.reports;

test.describe.configure({ mode: 'serial' });

test('the trial balance balances; Sales opens its ledger and a line opens the bill', async ({ page }) => {
  await signIn(page);
  await report(page, bo.nav.trialBalance);
  await page.getByLabel(r.frame.period).selectOption('thisYear');
  const table = page.getByRole('table', { name: bo.nav.trialBalance });
  await expect(table).toBeVisible();
  await expect(page.getByLabel(r.frame.figures).getByText(r.tb.balanced)).toBeVisible();
  expect(page.url()).toContain('preset=thisYear');

  // CSV: the same report, downloaded.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: r.csv }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^trial-balance-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/);

  await table.getByRole('link', { name: 'Sales', exact: true }).click();
  await expect(page.getByRole('heading', { name: '4100 Sales', level: 1 })).toBeVisible();
  const lines = page.getByRole('table', { name: bo.accounting.ledger.lines });
  await expect(lines.getByRole('row')).not.toHaveCount(1);
  await lines.getByRole('link').first().click();
  await expect(page).toHaveURL(/#\/sales\/bills\//);
  await expect(page.getByRole('table', { name: bo.billDetails.items })).toBeVisible();
});

test('the profit and loss month by month, and the balance sheet balances', async ({ page }) => {
  await signIn(page);
  await report(page, bo.nav.profitLoss);
  await page.getByLabel(r.frame.period).selectOption('thisYear');
  await page.getByLabel(r.pl.compare).selectOption('months');
  const pl = page.getByRole('table', { name: bo.nav.profitLoss });
  // The account column and one per month of the fiscal year so far, up to twelve.
  await expect(pl.getByRole('columnheader')).toHaveCount(13);
  await expect(pl.getByRole('row', { name: new RegExp(`^${r.pl.netProfit}`) })).toBeVisible();
  await expect(page.getByRole('table', { name: r.pl.stock.title })).toBeVisible();

  await report(page, bo.nav.balanceSheet);
  await expect(page.getByRole('table', { name: bo.nav.balanceSheet })).toBeVisible();
  await expect(page.getByLabel(r.frame.figures).getByText(r.tb.balanced)).toBeVisible();
  await expect(page.getByRole('table', { name: bo.nav.balanceSheet }).getByText(r.bs.difference)).toHaveCount(
    0,
  );
});

test('on paper the menu and filters go, and a header names the shop and the report', async ({ page }) => {
  await signIn(page);
  await report(page, bo.nav.trialBalance);
  await expect(page.getByRole('table', { name: bo.nav.trialBalance })).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('navigation', { name: bo.nav.menu })).toBeHidden();
  await expect(page.getByLabel(r.frame.filters)).toBeHidden();
  const header = page.locator('[data-slot="print-header"]');
  await expect(header).toBeVisible();
  await expect(header).toContainText(bo.nav.trialBalance);
  await expect(header).toContainText(r.frame.printedBy.split('{{')[0]!.trim());
  await page.emulateMedia({ media: 'screen' });
  await expect(header).toBeHidden();
});
