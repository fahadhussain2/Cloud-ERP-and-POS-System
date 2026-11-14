import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Kbd,
} from '@erp/ui';
import { ChevronDown, LogOut, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { Route } from '../router';
import { placeOf } from './menu';

// The top bar (W1-28 plan): where you are (the menu's group and entry, also on a detail screen), the search for
// screens, and the account menu with Sign out. The shop's name is left out for now (owner answer 2).

/** Up to two initials for the avatar, e.g. "FH" for Fahad Hussain. */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toLocaleUpperCase())
    .join('');

export function TopBar({
  fullName,
  route,
  onSearch,
  onSignOut,
}: {
  fullName: string;
  route: Route;
  onSearch: () => void;
  onSignOut: () => void;
}) {
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
        <Kbd className="bg-surface">{t('nav.searchKey')}</Kbd>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('nav.account', { name: fullName })}
            className="flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent ps-1 pe-2 font-medium text-ink hover:bg-surface-2 data-[state=open]:bg-surface-2"
          >
            <span
              aria-hidden="true"
              className="grid size-7 place-items-center rounded-full border border-line bg-surface-2 text-[11px] font-semibold text-muted-foreground"
            >
              {initials(fullName)}
            </span>
            <span className="max-md:sr-only">{fullName}</span>
            <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} className="w-56 p-1.5">
          <DropdownMenuLabel className="px-2.5 py-1.5 font-semibold">{fullName}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onSignOut} className="h-8.5 cursor-pointer px-2.5 text-sm">
            <LogOut aria-hidden="true" />
            {t('nav.signOut')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
