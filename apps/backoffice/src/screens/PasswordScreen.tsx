import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';

/** The forced password change (W0-11, D-083): until it is done, the API allows nothing else. */
export function PasswordScreen({ api, onChanged }: { api: Api; onChanged: () => void }) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== repeat) return setError(t('password.mismatch'));
    setBusy(true);
    setError(null);
    const r = await api('PUT', '/api/users/me/password', { currentPassword: current, newPassword: next });
    setBusy(false);
    if (r.status === 204) return onChanged();
    const b = r.body as { error?: string; problem?: string } | null;
    if (b?.error === 'weak_password' && b.problem) setError(t(`passwordProblem.${b.problem}`));
    else if (b?.error === 'wrong_password') setError(t('password.wrong'));
    else setError(t('app.error'));
  };

  return (
    <main className="screen">
      <h1>{t('password.title')}</h1>
      <p>{t('password.help')}</p>
      <form onSubmit={(e) => void submit(e)}>
        <label>
          {t('password.current')}
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <label>
          {t('password.new')}
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        <label>
          {t('password.repeat')}
          <input
            type="password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          {t('password.submit')}
        </button>
      </form>
    </main>
  );
}
