import type { DashboardView } from '@erp/contracts';
import type { Page } from '@playwright/test';

import bo from '../apps/backoffice/src/locales/en.json' with { type: 'json' };
import { href } from '../apps/backoffice/src/router';
import { expect, test } from './counter-test';
import { BACKOFFICE_PORT, OWNER, OWNER_PASSWORD, SHOP } from './fixtures';

// The back office on a phone (owner, 2026-11-20): every screen the owner opens fits a 375px-wide screen with no
// sideways scroll, the dashboard's key figures fit their cards, and the side menu stays in place while the page
// scrolls. After counter.spec (the owner's own password, and sales for the dashboard). Reads only, in a browser
// context of its own. E2E_SHOTS=<folder> also saves a full-page picture of each screen, for a look by eye.

const BACKOFFICE = `http://localhost:${BACKOFFICE_PORT}`;
const PHONE = { width: 375, height: 812 };

/** Every list, report and new-document screen: the router's fixed addresses, and the forms a `new` opens. */
const SCREENS: string[] = [
  ...Object.values(href).flatMap((h) => (typeof h === 'string' ? [h] : [])),
  href.receipt('new'),
  href.purchaseReturn('new'),
  href.transfer('new'),
  href.adjustment('new'),
  href.voucher('new'),
];

/** What spills past the screen's width: the widest elements reaching beyond it, for the failure message. */
async function overflowOf(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const width = root.clientWidth;
    // A phone widens its page (innerWidth) to take in what spills, then zooms out.
    if (root.scrollWidth <= width && window.innerWidth <= width) return null;
    const wide = [...document.querySelectorAll('main *, aside *')]
      .map((e) => ({ e, right: e.getBoundingClientRect().right }))
      .filter((x) => x.right > width + 1)
      .slice(0, 3)
      .map(
        ({ e, right }) =>
          `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 60)} → ${Math.round(right)}px`,
      );
    return { scrollWidth: root.scrollWidth, innerWidth: window.innerWidth, width, wide };
  });
}

test('every screen fits a phone with no sideways scroll; the side menu stays put; the key figures fit', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  // A phone, not a narrow desktop window: a phone widens the page to fit what spills and zooms out.
  const page = await (
    await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true })
  ).newPage();
  // The dashboard as a busy shop sees it: Delux-sized figures (millions, a negative bank) and a long day of hours;
  // before signing in, which opens the dashboard.
  await page.route('**/api/dashboard?*', async (route) => {
    const view = (await (await route.fetch()).json()) as DashboardView;
    const big = (now: number) => ({ now, chip: { amount: now, bp: 10_000, direction: 'up', good: true } });
    Object.assign(view.netSales, big(1_762_980_00));
    Object.assign(view.grossProfit, big(1_442_800_00));
    Object.assign(view.cash, big(1_762_980_00));
    Object.assign(view.bank, big(-14_428_000_00));
    Object.assign(view.customersOwe, big(48_720_000_00));
    view.busyHours.hours = { first: 6, last: 23 };
    view.busyHours.bills = Array.from({ length: 7 }, () => Array.from({ length: 24 }, (_, h) => h));
    await route.fulfill({ json: view });
  });

  await page.goto(BACKOFFICE);
  await page.getByLabel(bo.login.shopCode).fill(SHOP);
  await page.getByLabel(bo.login.username).fill(OWNER.username);
  await page.getByLabel(bo.login.password).fill(OWNER_PASSWORD);
  await page.getByRole('button', { name: bo.login.submit }).click();
  const nav = page.getByRole('navigation', { name: bo.nav.menu });
  await expect(nav).toBeVisible();

  const problems: Record<string, unknown> = {};
  for (const screen of SCREENS) {
    await page.goto(`${BACKOFFICE}/${screen}`);
    await expect(page.locator('main h1').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    // Measured once the screen has its data, and a frame later (a phone widens its page after layout).
    for (const loading of [bo.app.loading, bo.dashboard.loading])
      await expect(page.locator('main')).not.toContainText(loading);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const shots = process.env['E2E_SHOTS'];
    if (shots) {
      const name = screen.replace(/[#/]+/g, '-').replace(/^-|-$/g, '') || 'home';
      await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
    }
    const spill = await overflowOf(page);
    if (spill) problems[screen] = spill;
  }

  // The dashboard: each key figure fits its card, and the menu stays on the screen at the page's foot.
  await page.goto(`${BACKOFFICE}/${href.dashboard}`);
  const figures = page.getByRole('region', { name: bo.dashboard.keyFigures });
  await expect(figures.getByRole('link')).toHaveCount(5);
  await expect(figures).toContainText('1,762,980');
  const clipped = await figures
    .locator('a .font-display')
    .evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
  if (clipped.length > 0) problems['key figures cut off'] = clipped;
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const menu = await page.locator('aside').first().boundingBox();
  // At the top of the screen and its full height (a fraction of a pixel aside).
  if (!menu || Math.abs(menu.y) >= 1 || Math.round(menu.height) !== PHONE.height)
    problems['side menu after scrolling'] = menu;

  expect(problems).toEqual({});
  await page.context().close();
});
