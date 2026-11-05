import { Button, cn, Panel } from '@erp/ui';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { href, type Route } from '../router';

// The back-office layout from the Tijara Goods Receipt prototype (W1-04 plan): a top bar, a side menu in groups,
// panels in the work area. The menu lists only screens that exist and that this person may open (owner answer 4);
// each later task adds its entry here.

export interface MenuItem {
  key: 'staff' | 'counters' | 'dayReconciliation' | 'cashVariance' | 'items' | 'categories';
  href: string;
  /** Any of these permissions opens the screen. */
  needs: readonly string[];
  /** Routes that light this entry up. */
  screens: readonly Route['screen'][];
}

export const MENU: readonly {
  group: 'people' | 'catalog' | 'shop' | 'reports';
  items: readonly MenuItem[];
}[] = [
  {
    group: 'people',
    items: [
      {
        key: 'staff',
        href: href.staff,
        needs: ['admin.users', 'admin.devices'],
        screens: ['staff', 'person'],
      },
    ],
  },
  {
    // Catalog maintenance (W1-15): items with their codes, vehicles and prices; the categories' floor margin.
    group: 'catalog',
    items: [
      {
        key: 'items',
        href: href.items,
        needs: ['cat.item.edit', 'cat.price.edit'],
        screens: ['items', 'item', 'newItem'],
      },
      {
        key: 'categories',
        href: href.categories,
        needs: ['cat.item.edit', 'cat.price.edit'],
        screens: ['categories'],
      },
    ],
  },
  {
    group: 'shop',
    items: [{ key: 'counters', href: href.counters, needs: ['admin.devices'], screens: ['counters'] }],
  },
  {
    // The cash reports (W1-11, CSH-08, RPT-02).
    group: 'reports',
    items: [
      {
        key: 'dayReconciliation',
        href: href.dayReconciliation,
        needs: ['reports.view'],
        screens: ['dayReconciliation'],
      },
      { key: 'cashVariance', href: href.cashVariance, needs: ['reports.view'], screens: ['cashVariance'] },
    ],
  },
];

export const allowed = (item: MenuItem, permissions: readonly string[]) =>
  item.needs.some((p) => permissions.includes(p));

export function Shell({
  fullName,
  permissions,
  route,
  onSignOut,
  children,
}: {
  fullName: string;
  permissions: readonly string[];
  route: Route;
  onSignOut: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const groups = MENU.map((g) => ({ ...g, items: g.items.filter((i) => allowed(i, permissions)) })).filter(
    (g) => g.items.length > 0,
  );

  return (
    <div className="flex min-h-svh flex-col gap-2.5 bg-bg px-4 py-2.5 text-ink">
      <header className="flex flex-wrap items-center gap-x-4.5 gap-y-2">
        <div className="me-auto flex flex-wrap items-baseline gap-2.5">
          <span className="font-display text-[26px] font-bold text-primary">{t('app.brand')}</span>
          <span className="font-display text-lg font-semibold tracking-[.04em] uppercase">
            {t('app.title')}
          </span>
        </div>
        <div className="flex flex-col text-end">
          <span className="text-[11px] font-semibold tracking-[.07em] text-muted-foreground uppercase">
            {t('nav.signedIn')}
          </span>
          <span className="font-semibold">{fullName}</span>
        </div>
        <Button variant="outline" onClick={onSignOut}>
          {t('nav.signOut')}
        </Button>
      </header>

      <div className="grid items-start gap-2.5 md:grid-cols-[200px_minmax(0,1fr)]">
        {groups.length > 0 && (
          <Panel
            className="flex flex-row flex-wrap gap-0.5 p-2 md:sticky md:top-2.5 md:flex-col"
            aria-label={t('nav.menu')}
            role="navigation"
          >
            {groups.map((g) => (
              <div key={g.group} className="contents md:flex md:flex-col md:gap-0.5">
                <h3 className="m-0 hidden px-2 pt-2.5 pb-1 text-[11px] font-semibold tracking-[.08em] text-muted-foreground uppercase md:block">
                  {t(`nav.groups.${g.group}`)}
                </h3>
                {g.items.map((item) => {
                  const on = item.screens.includes(route.screen);
                  return (
                    <a
                      key={item.key}
                      href={item.href}
                      aria-current={on ? 'page' : undefined}
                      className={cn(
                        'rounded-md px-2 py-1.5 font-medium text-muted-foreground no-underline hover:bg-surface-2',
                        on && 'bg-select font-semibold text-ink',
                      )}
                    >
                      {t(`nav.${item.key}`)}
                    </a>
                  );
                })}
              </div>
            ))}
          </Panel>
        )}
        <main className="flex min-w-0 flex-col gap-2.5">{children}</main>
      </div>
    </div>
  );
}
