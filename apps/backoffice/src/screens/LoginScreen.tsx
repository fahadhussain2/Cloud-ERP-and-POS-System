import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import type { Me } from '../App';

const SHOP_KEY = 'erp.shopCode';

const remembered = () => {
  try {
    return localStorage.getItem(SHOP_KEY) ?? '';
  } catch {
    return '';
  }
};

/** Back-office sign-in (PLT-04, D-081). The shop code is remembered on this PC. */
export function LoginScreen({ api, onSignedIn }: { api: Api; onSignedIn: (me: Me) => void }) {
  const { t } = useTranslation();
  const [tenantCode, setTenantCode] = useState(remembered);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await api('POST', '/api/auth/login', { tenantCode, username, password });
    setBusy(false);
    setPassword('');
    if (r.status === 200) {
      try {
        localStorage.setItem(SHOP_KEY, tenantCode.trim().toLowerCase());
      } catch {
        // Not remembered: the next sign-in asks again.
      }
      return onSignedIn(r.body as Me);
    }
    setError(r.status === 429 ? t('login.limited') : t('login.failed'));
  };

  return (
    <main className="screen">
      <h1>{t('login.title')}</h1>
      <form onSubmit={(e) => void submit(e)}>
        <label>
          {t('login.shopCode')}
          <input
            value={tenantCode}
            onChange={(e) => setTenantCode(e.target.value)}
            autoComplete="organization"
            required
          />
        </label>
        <label>
          {t('login.username')}
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          {t('login.password')}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? t('login.busy') : t('login.submit')}
        </button>
      </form>
    </main>
  );
}
