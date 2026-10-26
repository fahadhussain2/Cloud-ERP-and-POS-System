import { Alert, Button, Field } from '@erp/ui';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { EnrollResult } from '../device/session';
import { CardScreen } from './Card';

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
    <CardScreen title={t('setup.title')}>
      <p className="m-0 text-center text-muted">{t('setup.help')}</p>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <Field
          label={t('setup.shopCode')}
          value={tenantCode}
          onChange={(e) => setTenantCode(e.target.value)}
          autoComplete="off"
          autoFocus
          required
        />
        <Field
          label={t('setup.code')}
          className="font-mono"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="off"
          required
        />
        {error && <Alert variant="bad">{t(`setup.${error}`)}</Alert>}
        <Button type="submit" variant="primary" size="lg" disabled={busy}>
          {busy ? t('setup.busy') : t('setup.submit')}
        </Button>
      </form>
    </CardScreen>
  );
}
