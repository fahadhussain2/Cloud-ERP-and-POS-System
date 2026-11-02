import { PageHeader } from '@erp/ui';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from './api';
import { allowed, MENU, Shell } from './layout/Shell';
import { useRoute, type Route } from './router';
import { CountersScreen } from './screens/CountersScreen';
import { LoginScreen } from './screens/LoginScreen';
import { PasswordScreen } from './screens/PasswordScreen';
import { CashVarianceScreen, DayReconciliationScreen } from './screens/ReportsScreens';
import { PersonScreen } from './staff/PersonScreen';
import { StaffScreen } from './staff/StaffScreen';

// The back office: sign in, the forced password change (W1-02), then the layout with its menu and the screen named by
// the address (W1-04 plan).

export interface Me {
  tenantId: string;
  user: { id: string; username: string; fullName: string };
  permissions: string[];
  mustChangePassword: boolean;
}

/** The screen to show: the one addressed if this person may open it, otherwise the first one they may. */
function screenFor(route: Route, permissions: readonly string[]): Route | null {
  const items = MENU.flatMap((g) => g.items);
  const item = items.find((i) => i.screens.includes(route.screen));
  if (item && allowed(item, permissions)) return route;
  const first = items.find((i) => allowed(i, permissions));
  return first ? ({ screen: first.screens[0]! } as Route) : null;
}

export function App({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const route = useRoute();

  const fetchMe = useCallback(async () => {
    const r = await api('GET', '/api/auth/me');
    return r.status === 200 ? (r.body as Me) : null;
  }, [api]);
  const loadMe = async () => setMe(await fetchMe());

  useEffect(() => {
    let live = true;
    void fetchMe().then((m) => live && setMe(m));
    return () => {
      live = false;
    };
  }, [fetchMe]);

  if (me === undefined) return <p className="p-6 text-muted-foreground">{t('app.loading')}</p>;
  if (me === null) return <LoginScreen api={api} onSignedIn={setMe} />;
  if (me.mustChangePassword) return <PasswordScreen api={api} onChanged={() => void loadMe()} />;

  const signOut = async () => {
    await api('POST', '/api/auth/logout');
    setMe(null);
  };
  const shown = screenFor(route, me.permissions);

  return (
    <Shell
      fullName={me.user.fullName}
      permissions={me.permissions}
      route={shown ?? route}
      onSignOut={() => void signOut()}
    >
      {shown === null ? (
        <PageHeader title={t('app.title')} help={t('home.nothing')} />
      ) : shown.screen === 'person' ? (
        <PersonScreen key={shown.id} api={api} id={shown.id} permissions={me.permissions} />
      ) : shown.screen === 'counters' ? (
        <CountersScreen api={api} />
      ) : shown.screen === 'dayReconciliation' ? (
        <DayReconciliationScreen api={api} permissions={me.permissions} />
      ) : shown.screen === 'cashVariance' ? (
        <CashVarianceScreen api={api} />
      ) : (
        <StaffScreen api={api} permissions={me.permissions} />
      )}
    </Shell>
  );
}
