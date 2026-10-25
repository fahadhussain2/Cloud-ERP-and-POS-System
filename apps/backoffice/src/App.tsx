import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from './api';
import { CountersScreen } from './screens/CountersScreen';
import { LoginScreen } from './screens/LoginScreen';
import { PasswordScreen } from './screens/PasswordScreen';
import { StaffPinsScreen } from './screens/StaffPinsScreen';

// The back-office minimum of W1-02 (plan scope 4): sign in, the forced password change, Staff PINs, Counters.

export interface Me {
  tenantId: string;
  user: { id: string; username: string; fullName: string };
  permissions: string[];
  mustChangePassword: boolean;
}

type Page = 'staff' | 'counters';

export function App({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [page, setPage] = useState<Page>('staff');

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

  if (me === undefined) return <p className="screen">{t('app.loading')}</p>;
  if (me === null) return <LoginScreen api={api} onSignedIn={setMe} />;
  if (me.mustChangePassword) return <PasswordScreen api={api} onChanged={() => void loadMe()} />;

  const canManageDevices = me.permissions.includes('admin.devices');
  const signOut = async () => {
    await api('POST', '/api/auth/logout');
    setMe(null);
  };

  return (
    <div className="shell">
      <nav>
        {canManageDevices && (
          <>
            <button type="button" aria-current={page === 'staff'} onClick={() => setPage('staff')}>
              {t('nav.staff')}
            </button>
            <button type="button" aria-current={page === 'counters'} onClick={() => setPage('counters')}>
              {t('nav.counters')}
            </button>
          </>
        )}
        <span className="user">{me.user.fullName}</span>
        <button type="button" onClick={() => void signOut()}>
          {t('nav.signOut')}
        </button>
      </nav>
      {!canManageDevices ? (
        <main className="screen">
          <p>{t('home.nothing')}</p>
        </main>
      ) : page === 'staff' ? (
        <StaffPinsScreen api={api} />
      ) : (
        <CountersScreen api={api} />
      )}
    </div>
  );
}
