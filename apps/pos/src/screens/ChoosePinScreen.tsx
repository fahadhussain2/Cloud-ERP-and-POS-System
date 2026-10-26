import { pinProblem } from '@erp/domain';
import { Alert, Button, Field } from '@erp/ui';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { PinChangeResult } from '../sync/pin';
import type { StaffUser } from '../unlock/unlock';
import { CardScreen } from './Card';

/** After a temporary PIN (owner answer 2 to W1-02): the person chooses their own, online, before selling. */
export function ChoosePinScreen({
  user,
  onChoose,
}: {
  user: StaffUser;
  onChoose: (newPin: string) => Promise<PinChangeResult>;
}) {
  const { t } = useTranslation();
  const [newPin, setNewPin] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (newPin !== repeat) return setMessage(t('choosePin.mismatch'));
    // The same rules as the server (W0-10), checked here first so the person gets an answer offline too.
    const problem = pinProblem(newPin, user.shortCode);
    if (problem) return setMessage(t(`pinProblem.${problem}`));
    setBusy(true);
    const r = await onChoose(newPin);
    setBusy(false);
    if (r === 'pin_locked') setMessage(t('unlock.locked'));
    else if (r !== 'ok') setMessage(t(`choosePin.${r}`));
  };

  const pinField = 'text-center font-mono text-[22px] tracking-[.4em]';
  return (
    <CardScreen eyebrow={user.fullName} title={t('choosePin.title')}>
      <p className="m-0 text-center text-muted">{t('choosePin.help')}</p>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <Field
          label={t('choosePin.newPin')}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          className={pinField}
          value={newPin}
          onChange={(e) => setNewPin(e.target.value)}
        />
        <Field
          label={t('choosePin.repeat')}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          className={pinField}
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
        />
        {message && <Alert variant="bad">{message}</Alert>}
        <Button type="submit" variant="primary" size="lg" disabled={busy}>
          {busy ? t('choosePin.busy') : t('choosePin.submit')}
        </Button>
      </form>
    </CardScreen>
  );
}
