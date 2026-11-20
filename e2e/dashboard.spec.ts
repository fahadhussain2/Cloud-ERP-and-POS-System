import type { DashboardView, SalesProfitView } from '@erp/contracts';
import type { Browser, Page } from '@playwright/test';

import bo from '../apps/backoffice/src/locales/en.json' with { type: 'json' };
import { expect, test } from './counter-test';
import { BACKOFFICE_PORT, MANAGER, OWNER, OWNER_PASSWORD, SHOP } from './fixtures';

// W2-06 plan (RPT-18; D-118): after the counter's sales (counter.spec), the owner signs in and lands on the dashboard;
// today's net sales are the sales and gross profit report's for today, and the card opens that report for today. A
// manager has no dashboard: no menu row, the address opens their usual first screen, and the API refuses them. Reads
// only, each in a browser context of its own.

const BACKOFFICE = `http://localhost:${BACKOFFICE_PORT}`;
const d = bo.dashboard;

test.describe.configure({ mode: 'serial' });

async function signInFresh(browser: Browser, username: string, password: string): Promise<Page> {
  const office = await browser.newContext();
  const page = await office.newPage();
  await page.goto(BACKOFFICE);
  await page.getByLabel(bo.login.shopCode).fill(SHOP);
  await page.getByLabel(bo.login.username).fill(username);
  await page.getByLabel(bo.login.password).fill(password);
  await page.getByRole('button', { name: bo.login.submit }).click();
  await expect(page.getByRole('navigation', { name: bo.nav.menu })).toBeVisible();
  return page;
}

test("the owner lands on the dashboard; today's net sales are the report's, and the card opens it", async ({
  browser,
}) => {
  const page = await signInFresh(browser, OWNER.username, OWNER_PASSWORD);
  const nav = page.getByRole('navigation', { name: bo.nav.menu });
  await expect(nav.getByRole('link', { name: bo.nav.dashboard })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: d.title, level: 1 })).toBeVisible();
  const figures = page.getByRole('region', { name: d.keyFigures });
  await expect(figures.getByRole('link')).toHaveCount(5);

  // The same figures from the two endpoints, read in this browser (its session).
  const view = (await (
    await page.request.get(`${BACKOFFICE}/api/dashboard?period=today`)
  ).json()) as DashboardView;
  const t = view.today;
  const report = (await (
    await page.request.get(`${BACKOFFICE}/api/reports/sales-profit?from=${t}&to=${t}&compare=none`)
  ).json()) as SalesProfitView;
  expect(view.netSales.now).toBe(report.total.cells.sales);
  expect(view.netSales.now).toBeGreaterThan(0);
  const sales = figures.getByRole('link', { name: new RegExp(d.kpi.salesSoFar) });
  // The figure's digits as the shop's locale groups them (the card adds the currency).
  const whole = Math.trunc(view.netSales.now / 10 ** view.money.minorUnits);
  await expect(sales).toContainText(new Intl.NumberFormat(view.money.locale).format(whole));

  await sales.click();
  await expect(page).toHaveURL(new RegExp(`#/reports/sales-profit\\?.*from=${t}.*to=${t}`));
  await expect(page.getByRole('table', { name: bo.nav.salesProfit })).toBeVisible();

  // The period switch reads the 7 days and names their comparison.
  await page.goBack();
  await page.getByRole('button', { name: d.periods['7d'] }).click();
  await expect(page.getByText(d.compared['7d']).or(page.getByText(d.beforeGoLive))).toBeVisible();
  await page.context().close();
});

test('a manager has no dashboard: no menu row, their own first screen, and the API refuses them', async ({
  browser,
}) => {
  const page = await signInFresh(browser, MANAGER.username, MANAGER.password);
  const nav = page.getByRole('navigation', { name: bo.nav.menu });
  await expect(nav.getByRole('link', { name: bo.nav.dashboard })).toHaveCount(0);
  await page.goto(`${BACKOFFICE}/#/dashboard`);
  await expect(page.getByRole('heading', { name: d.title, level: 1 })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: bo.nav.customers })).toHaveAttribute('aria-current', 'page');
  expect((await page.request.get(`${BACKOFFICE}/api/dashboard`)).status()).toBe(403);
  await page.context().close();
});
