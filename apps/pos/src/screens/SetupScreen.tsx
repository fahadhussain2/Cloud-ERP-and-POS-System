import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { EnrollResult } from '../device/session';

/** Device setup (POS spec §4): the shop code and a manager's one-time code. */
export function SetupScreen({
  onEnroll,
}: {
  onEnroll: (input: { tenantCode: string; code: string }) => Promise<EnrollResult>;
}) {
  const { t } = useTranslation();
  const [tenantCode, setTenantCode] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await onEnroll({ tenantCode, code });
    setBusy(false);
    if (!r.ok) setError(r.error);
  };

  return (
    <main className="screen">
      <h1>{t('setup.title')}</h1>
      <p>{t('setup.help')}</p>
      <form onSubmit={(e) => void submit(e)}>
        <label>
          {t('setup.shopCode')}
          <input
            value={tenantCode}
            onChange={(e) => setTenantCode(e.target.value)}
            autoComplete="off"
            required
          />
        </label>
        <label>
          {t('setup.code')}
          <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" required />
        </label>
        {error && <p role="alert">{t(`setup.${error}`)}</p>}
        <button type="submit" disabled={busy}>
          {busy ? t('setup.busy') : t('setup.submit')}
        </button>
      </form>
    </main>
  );
}
