import { pinProblem } from '@erp/domain';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { PinChangeResult } from '../sync/pin';
import type { StaffUser } from '../unlock/unlock';

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

  return (
    <main className="screen">
      <h1>{t('choosePin.title')}</h1>
      <p>{t('choosePin.help')}</p>
      <form onSubmit={(e) => void submit(e)}>
        <label>
          {t('choosePin.newPin')}
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={newPin}
            onChange={(e) => setNewPin(e.target.value)}
          />
        </label>
        <label>
          {t('choosePin.repeat')}
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
        </label>
        {message && <p role="alert">{message}</p>}
        <button type="submit" disabled={busy}>
          {busy ? t('choosePin.busy') : t('choosePin.submit')}
        </button>
      </form>
    </main>
  );
}
