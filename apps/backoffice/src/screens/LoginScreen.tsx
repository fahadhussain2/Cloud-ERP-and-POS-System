import { LogIn } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import type { Me } from '../App';
import { Button, TextInput } from '../ui';
import { CardScreen } from './CardScreen';

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
    <CardScreen title={t('login.title')}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <TextInput
          label={t('login.shopCode')}
          value={tenantCode}
          onChange={(e) => setTenantCode(e.target.value)}
          autoComplete="organization"
          required
        />
        <TextInput
          label={t('login.username')}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          required
        />
        <TextInput
          label={t('login.password')}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
          error={error ?? undefined}
        />
        <Button type="submit" icon={LogIn} className="w-full" disabled={busy}>
          {busy ? t('login.busy') : t('login.submit')}
        </Button>
      </form>
    </CardScreen>
  );
}
