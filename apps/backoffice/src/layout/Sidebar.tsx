import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@erp/ui';
import { ChevronDown, ChevronRight, PanelLeft } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Route } from '../router';
import type { Theme } from '../theme';
import { Account } from './Account';
import {
  menuFor,
  placeOf,
  readMenuState,
  writeMenuState,
  type GroupKey,
  type MenuGroup,
  type MenuItem,
} from './menu';

// The side menu (W1-28 plan): one row per group with an icon; a click opens or closes it, and the group of the
// current screen opens by itself. A group with one entry this person may open is a direct link. Folded, it is a rail
// of icons whose groups list their screens beside it; a narrow window always shows the rail. Open groups and the fold
// are remembered in this browser. Settings follows Reports; the account sits at the foot (owner, mockup review).

export type Badges = Partial<Record<MenuItem['key'], number>>;

/** Narrower than Tailwind's `md` (48rem): no room for the full menu beside a screen. */
const NARROW = '(max-width: 47.99rem)';

function useNarrow(): boolean {
  const media = () => (typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(NARROW) : null);
  const [narrow, setNarrow] = useState(() => media()?.matches ?? false);
  useEffect(() => {
    const m = media();
    if (!m) return;
    const follow = () => setNarrow(m.matches);
    m.addEventListener('change', follow);
    return () => m.removeEventListener('change', follow);
  }, []);
  return narrow;
}

/** The count beside an entry: a pill in the menu, a dot on a rail icon. It describes its row and is not its name. */
function Count({ id, count, dot }: { id: string; count: number; dot?: boolean }) {
  const { t } = useTranslation();
  if (count <= 0) return null;
  const label = t('nav.badge', { count });
  return dot ? (
    <span
      id={id}
      aria-label={label}
      className="absolute end-2 top-2 size-2 rounded-full bg-bad ring-2 ring-surface"
    />
  ) : (
    <span
      id={id}
      aria-label={label}
      className="ms-auto min-w-[18px] rounded-full bg-bad px-1.5 text-center text-xs leading-[18px] font-semibold text-bad-ink tabular-nums"
    >
      {count}
    </span>
  );
}

/** Names a row by its text when a count sits inside it, so the count describes the row instead of renaming it. */
const named = (label: string, countId: string, count: number) =>
  count > 0 ? { 'aria-label': label, 'aria-describedby': countId } : {};

const ROW =
  'relative flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 bg-transparent px-2.5 text-start font-medium text-ink no-underline hover:bg-surface-2';
const RAIL_ROW = 'h-10 justify-center px-0';

function Hint({ label, side, children }: { label: string; side: 'left' | 'right'; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function Sidebar({
  fullName,
  username,
  permissions,
  route,
  badges,
  onSignOut,
  theme,
  onTheme,
  themeNotSaved,
}: {
  fullName: string;
  username: string;
  permissions: readonly string[];
  route: Route;
  badges: Badges;
  onSignOut: () => void;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  themeNotSaved: boolean;
}) {
  const { t, i18n } = useTranslation();
  const narrow = useNarrow();
  const [state, setState] = useState(readMenuState);
  const home = placeOf(route.screen);
  const rail = narrow || state.collapsed;
  // Flyouts and tooltips open towards the screen, whichever way the language reads.
  const side = i18n.dir() === 'rtl' ? 'left' : 'right';

  // Arriving in a group opens it; the person can still close it.
  const [arrived, setArrived] = useState<GroupKey | null>(null);
  if ((home?.group ?? null) !== arrived) {
    setArrived(home?.group ?? null);
    if (home && !state.open.includes(home.group)) setState((s) => ({ ...s, open: [...s.open, home.group] }));
  }
  useEffect(() => writeMenuState(state), [state]);

  const groups = menuFor(permissions);
  const toggle = (g: GroupKey) =>
    setState((s) => ({ ...s, open: s.open.includes(g) ? s.open.filter((o) => o !== g) : [...s.open, g] }));
  const countOf = (items: readonly MenuItem[]) => items.reduce((n, i) => n + (badges[i.key] ?? 0), 0);

  return (
    <aside
      className={cn(
        'sticky top-0 flex h-svh shrink-0 flex-col self-start border-e border-line bg-surface print:hidden',
        rail ? 'w-16' : 'w-62',
      )}
    >
      <div className={cn('flex h-14 shrink-0 items-center gap-2', rail ? 'justify-center' : 'ps-4.5 pe-3')}>
        {!rail ? (
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="font-display text-[26px] leading-none font-bold text-primary">
              {t('app.brand')}
            </span>
            <span className="truncate text-xs text-muted-foreground">{t('app.title')}</span>
          </span>
        ) : (
          narrow && (
            <span aria-hidden="true" className="font-display text-[26px] leading-none font-bold text-primary">
              {t('app.brand').slice(0, 1)}
            </span>
          )
        )}
        {!narrow && (
          <button
            type="button"
            aria-label={t(rail ? 'nav.expand' : 'nav.collapse')}
            title={t(rail ? 'nav.expand' : 'nav.collapse')}
            onClick={() => setState((s) => ({ ...s, collapsed: !s.collapsed }))}
            className={cn(
              'grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-muted-foreground hover:bg-surface-2 hover:text-ink',
              !rail && 'ms-auto',
            )}
          >
            <PanelLeft className="size-4.5 rtl:-scale-x-100" aria-hidden="true" />
          </button>
        )}
      </div>

      {groups.length > 0 && (
        <nav
          aria-label={t('nav.menu')}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pt-1 pb-3"
        >
          <ul className="m-0 flex flex-1 list-none flex-col gap-0.5 p-0">
            {groups.map((g) => (
              <li key={g.group} data-slot="menu-row">
                {g.items.length === 1 ? (
                  <Direct
                    group={g}
                    item={g.items[0]!}
                    route={route}
                    rail={rail}
                    side={side}
                    badges={badges}
                  />
                ) : rail ? (
                  <Flyout
                    group={g}
                    route={route}
                    on={home?.group === g.group}
                    side={side}
                    count={countOf(g.items)}
                    badges={badges}
                  />
                ) : (
                  <Group
                    group={g}
                    route={route}
                    on={home?.group === g.group}
                    open={state.open.includes(g.group)}
                    onToggle={() => toggle(g.group)}
                    count={countOf(g.items)}
                    badges={badges}
                  />
                )}
              </li>
            ))}
          </ul>
        </nav>
      )}
      {/* Keeps the account at the foot when there is no menu (someone who may open no screen still signs out). */}
      {groups.length === 0 && <div className="flex-1" />}
      <Account
        fullName={fullName}
        username={username}
        rail={rail}
        side={side}
        onSignOut={onSignOut}
        theme={theme}
        onTheme={onTheme}
        themeNotSaved={themeNotSaved}
      />
    </aside>
  );
}

/** A group with one entry: the entry itself, with the group's icon. */
function Direct({
  group,
  item,
  route,
  rail,
  side,
  badges,
}: {
  group: MenuGroup;
  item: MenuItem;
  route: Route;
  rail: boolean;
  side: 'left' | 'right';
  badges: Badges;
}) {
  const { t } = useTranslation();
  const countId = useId();
  const on = item.screens.includes(route.screen);
  const label = t(`nav.${item.key}`);
  const count = badges[item.key] ?? 0;
  const Icon = group.icon;
  const link = (
    <a
      href={item.href}
      aria-current={on ? 'page' : undefined}
      {...(rail
        ? { 'aria-label': label, 'aria-describedby': count > 0 ? countId : undefined }
        : named(label, countId, count))}
      className={cn(ROW, rail && RAIL_ROW, on && 'bg-bg font-semibold')}
    >
      <Icon
        className={cn('size-4.5 shrink-0', on ? 'text-primary' : 'text-muted-foreground')}
        aria-hidden="true"
      />
      {!rail && (
        <span data-slot="menu-label" className="min-w-0 flex-1 truncate">
          {label}
        </span>
      )}
      <Count id={countId} count={count} dot={rail} />
    </a>
  );
  return rail ? (
    <Hint label={label} side={side}>
      {link}
    </Hint>
  ) : (
    link
  );
}

/** A group in the full menu: a row that opens and closes the list of its entries under it. */
function Group({
  group,
  route,
  on,
  open,
  onToggle,
  count,
  badges,
}: {
  group: MenuGroup;
  route: Route;
  on: boolean;
  open: boolean;
  onToggle: () => void;
  count: number;
  badges: Badges;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const countId = useId();
  const label = t(`nav.groups.${group.group}`);
  const Icon = group.icon;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={onToggle}
        {...named(label, countId, open ? 0 : count)}
        className={cn(ROW, on && 'font-semibold')}
      >
        <Icon
          className={cn('size-4.5 shrink-0', on ? 'text-primary' : 'text-muted-foreground')}
          aria-hidden="true"
        />
        <span data-slot="menu-label" className="min-w-0 flex-1 truncate">
          {label}
        </span>
        {!open && <Count id={countId} count={count} />}
        <Chevron
          className={cn('size-3.5 shrink-0 text-muted-foreground', !open && 'rtl:-scale-x-100')}
          aria-hidden="true"
        />
      </button>
      {open && (
        <ul
          id={listId}
          className="m-0 ms-[1.1875rem] mt-0.5 mb-1.5 flex list-none flex-col gap-px border-s border-line p-0 ps-2.5"
        >
          {group.items.map((item) => (
            <li key={item.key}>
              <Entry item={item} route={route} count={badges[item.key] ?? 0} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Entry({ item, route, count }: { item: MenuItem; route: Route; count: number }) {
  const { t } = useTranslation();
  const countId = useId();
  const on = item.screens.includes(route.screen);
  const label = t(`nav.${item.key}`);
  return (
    <a
      href={item.href}
      aria-current={on ? 'page' : undefined}
      {...named(label, countId, count)}
      className={cn(
        'flex h-8 items-center gap-2 rounded-md px-2.5 text-[13.5px] whitespace-nowrap text-muted-foreground no-underline hover:bg-surface-2 hover:text-ink',
        on && 'bg-bg font-semibold text-ink',
      )}
    >
      {label}
      <Count id={countId} count={count} />
    </a>
  );
}

/** A group in the rail: its icon, which lists the group's entries beside the rail. */
function Flyout({
  group,
  route,
  on,
  side,
  count,
  badges,
}: {
  group: MenuGroup;
  route: Route;
  on: boolean;
  side: 'left' | 'right';
  count: number;
  badges: Badges;
}) {
  const { t } = useTranslation();
  const countId = useId();
  const label = t(`nav.groups.${group.group}`);
  const Icon = group.icon;
  return (
    <DropdownMenu>
      <Hint label={label} side={side}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={label}
            aria-describedby={count > 0 ? countId : undefined}
            className={cn(ROW, RAIL_ROW, on && 'bg-bg', 'data-[state=open]:bg-surface-2')}
          >
            <Icon
              className={cn('size-4.5', on ? 'text-primary' : 'text-muted-foreground')}
              aria-hidden="true"
            />
            <Count id={countId} count={count} dot />
          </button>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent side={side} align="start" sideOffset={20} className="w-56 p-1.5">
        <DropdownMenuLabel className="px-2.5 pt-1.5 pb-1 text-[11.5px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
          {label}
        </DropdownMenuLabel>
        {group.items.map((item) => {
          const current = item.screens.includes(route.screen);
          return (
            <DropdownMenuItem key={item.key} asChild>
              <a
                href={item.href}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'h-8 cursor-pointer px-2.5 text-[13.5px] text-ink no-underline',
                  current && 'bg-bg font-semibold',
                )}
              >
                {t(`nav.${item.key}`)}
                <Count id={`${countId}-${item.key}`} count={badges[item.key] ?? 0} />
              </a>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
