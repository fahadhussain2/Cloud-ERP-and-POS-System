import { TooltipProvider, useShortcuts } from '@erp/ui';
import { useState, type ReactNode } from 'react';

import type { Route } from '../router';
import { menuFor } from './menu';
import { ScreenSearch } from './ScreenSearch';
import { Sidebar, type Badges } from './Sidebar';
import { TopBar } from './TopBar';

// The back-office frame (W1-28 plan, replacing W1-04's top bar and flat menu): a full-height side menu with the account
// at its foot, a top bar over the screen, and the search for screens. Only the frame: every screen draws itself as
// before.

export { allowed, MENU, type MenuItem } from './menu';

export function Shell({
  fullName,
  username,
  permissions,
  route,
  onSignOut,
  badges = {},
  children,
}: {
  fullName: string;
  username: string;
  permissions: readonly string[];
  route: Route;
  onSignOut: () => void;
  /** A count beside a menu entry, e.g. the open high-severity exceptions (owner answer 5 to W1-20). */
  badges?: Badges;
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
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar route={route} onSearch={() => setSearching(true)} />
          <main className="flex min-w-0 flex-col gap-2.5 p-4 md:px-7 md:py-5">{children}</main>
        </div>
      </div>
      <ScreenSearch groups={menuFor(permissions)} open={searching} onOpenChange={setSearching} />
    </TooltipProvider>
  );
}
