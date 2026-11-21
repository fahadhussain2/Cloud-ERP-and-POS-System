import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@erp/ui';
import { ChevronRight, LogOut, Monitor, Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { systemPrefersDark, type Theme } from '../theme';

// The account at the foot of the side menu (W1-28, owner after the mockup review): the person's name and username;
// its menu opens beside the side menu with the theme buttons and Sign out. The buttons are the theme switcher (W2-07,
// PLT-13): System, Light, Dark, icons only (owner answer 3), each named. The shop's name is left out (owner answer 2).

/** Up to two initials for the avatar, e.g. "FH" for Fahad Hussain. */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toLocaleUpperCase())
    .join('');

const THEMES = [
  { key: 'system', icon: Monitor },
  { key: 'light', icon: Sun },
  { key: 'dark', icon: Moon },
] as const;

export function Account({
  fullName,
  username,
  rail,
  side,
  onSignOut,
  theme,
  onTheme,
  themeNotSaved,
}: {
  fullName: string;
  username: string;
  rail: boolean;
  side: 'left' | 'right';
  onSignOut: () => void;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  themeNotSaved: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'shrink-0 border-t border-line',
        rail ? 'flex justify-center pt-2 pb-3' : 'px-3 pt-2 pb-3',
      )}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('nav.account', { name: fullName })}
            title={rail ? fullName : undefined}
            className={cn(
              'flex cursor-pointer items-center gap-2.5 rounded-[10px] border-0 bg-transparent text-start text-ink hover:bg-surface-2 data-[state=open]:bg-surface-2',
              rail ? 'p-1' : 'w-full px-2 py-1.5',
            )}
          >
            <span
              aria-hidden="true"
              className="grid size-8 shrink-0 place-items-center rounded-full border border-line bg-surface-2 text-xs font-semibold text-muted-foreground"
            >
              {initials(fullName)}
            </span>
            {!rail && (
              <>
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate font-semibold">{fullName}</span>
                  <span className="truncate text-xs text-muted-foreground">{username}</span>
                </span>
                <ChevronRight
                  className="size-4 shrink-0 text-muted-foreground rtl:-scale-x-100"
                  aria-hidden="true"
                />
              </>
            )}
          </button>
        </DropdownMenuTrigger>
        {/* Beside the side menu, touching its edge (owner, mockup review), its foot level with the account's. */}
        <DropdownMenuContent side={side} align="end" sideOffset={rail ? 12 : 13} className="w-62 p-1.5">
          <DropdownMenuLabel className="px-2.5 pt-1.5 pb-2 text-[13px] font-normal text-muted-foreground">
            {t('nav.theme')}
          </DropdownMenuLabel>
          <div
            role="group"
            aria-label={t('nav.theme')}
            className="mx-2.5 mb-2.5 inline-flex gap-0.5 rounded-[9px] border border-line bg-surface-2 p-[3px]"
          >
            {THEMES.map(({ key, icon: Icon }) => {
              const chosen = key === theme;
              return (
                <button
                  key={key}
                  type="button"
                  aria-label={t(`nav.themes.${key}`)}
                  title={t(`nav.themes.${key}`)}
                  aria-pressed={chosen}
                  onClick={() => onTheme(key)}
                  className={cn(
                    'grid h-7 w-9 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted-foreground hover:text-ink',
                    // The line ring keeps the chosen button visible in dark, where the surface is darker than the track.
                    chosen && 'bg-surface text-ink shadow-[0_1px_2px_rgb(0_0_0/0.14),0_0_0_1px_var(--line)]',
                  )}
                >
                  <Icon className="size-4" aria-hidden="true" />
                </button>
              );
            })}
          </div>
          {theme === 'system' && (
            <p className="mx-2.5 mb-2.5 text-xs text-muted-foreground">
              {t('nav.themes.followsSystem', {
                mode: t(`nav.themes.${systemPrefersDark() ? 'dark' : 'light'}`).toLocaleLowerCase(),
              })}
            </p>
          )}
          {themeNotSaved && (
            <p role="status" className="mx-2.5 mb-2.5 text-xs text-warn">
              {t('nav.themeNotSaved')}
            </p>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onSignOut} className="h-8.5 cursor-pointer px-2.5 text-sm">
            <LogOut aria-hidden="true" />
            {t('nav.signOut')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
