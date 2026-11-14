import { Kbd } from '@erp/ui';
import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { Route } from '../router';
import { placeOf } from './menu';

// The top bar (W1-28 plan): where you are (the menu's group and entry, also on a detail screen) and the search for
// screens. The account is at the foot of the side menu (owner, mockup review).

export function TopBar({ route, onSearch }: { route: Route; onSearch: () => void }) {
  const { t } = useTranslation();
  const place = placeOf(route.screen);
  return (
    <header className="sticky top-0 z-10 flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-4 py-2.5 md:px-7">
      <div className="flex min-w-0 items-center gap-2 text-[13.5px]">
        {place && (
          <>
            <span className="text-muted-foreground">{t(`nav.groups.${place.group}`)}</span>
            <span aria-hidden="true" className="text-muted-foreground">
              /
            </span>
            <span className="truncate font-semibold">{t(`nav.${place.item.key}`)}</span>
          </>
        )}
      </div>

      <button
        type="button"
        aria-label={t('nav.search')}
        onClick={onSearch}
        className="ms-auto flex h-9 w-full max-w-70 min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-lg border border-transparent bg-surface-2 px-2.5 text-start text-muted-foreground hover:border-line sm:flex-none"
      >
        <Search className="size-4.5 shrink-0" aria-hidden="true" />
        <span className="flex-1 truncate">{t('nav.search')}</span>
        <Kbd className="bg-surface max-sm:hidden">{t('nav.searchKey')}</Kbd>
      </button>
    </header>
  );
}
