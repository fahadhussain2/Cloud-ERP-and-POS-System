import { TooltipProvider, useShortcuts } from '@erp/ui';
import { useState, type ReactNode } from 'react';

import { mayOpen, REPORTS } from '../reports/catalog';
import type { Route } from '../router';
import type { Theme } from '../theme';
import { menuFor } from './menu';
import { ScreenSearch } from './ScreenSearch';
import { Sidebar, type Badges } from './Sidebar';
import { TopBar } from './TopBar';

// The back-office frame (W1-28 plan, replacing W1-04's top bar and flat menu): a full-height side menu with the account
// at its foot, a top bar over the screen, and the search for screens. Only the frame: every screen draws itself as
// before.

export { allowed, MENU, needsOf, type MenuItem } from './menu';

export function Shell({
  fullName,
  username,
  permissions,
  route,
  onSignOut,
  badges = {},
  theme = 'system',
  onTheme = () => {},
  themeNotSaved = false,
  children,
}: {
  fullName: string;
  username: string;
  permissions: readonly string[];
  route: Route;
  onSignOut: () => void;
  /** A count beside a menu entry, e.g. the open high-severity exceptions (owner answer 5 to W1-20). */
  badges?: Badges;
  /** The person's theme and its change (W2-07, PLT-13). */
  theme?: Theme;
  onTheme?: (theme: Theme) => void;
  /** The last choice could not be saved for the person's other computers. */
  themeNotSaved?: boolean;
  children: ReactNode;
}) {
  const [searching, setSearching] = useState(false);
  useShortcuts({ 'Ctrl+K': () => setSearching(true) }, !searching);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex min-h-svh bg-bg text-ink">
        <Sidebar
          fullName={fullName}
          username={username}
          permissions={permissions}
          route={route}
          badges={badges}
          onSignOut={onSignOut}
          theme={theme}
          onTheme={onTheme}
          themeNotSaved={themeNotSaved}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar route={route} onSearch={() => setSearching(true)} />
          <main className="flex min-w-0 flex-col gap-2.5 p-4 md:px-7 md:py-5 print:p-0">{children}</main>
        </div>
      </div>
      <ScreenSearch
        groups={menuFor(permissions)}
        reports={REPORTS.filter((r) => mayOpen(r, permissions))}
        open={searching}
        onOpenChange={setSearching}
      />
    </TooltipProvider>
  );
}
