import { PIN_MAX_FAILURES, type PinState } from '@erp/domain';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { StaffUser, UnlockResult } from '../unlock/unlock';

/** Unlock (POS spec §5, owner answer 3): pick your name, or type your short code, then your PIN. */
export function UnlockScreen({
  staff,
  onUnlock,
}: {
  staff: StaffUser[];
  onUnlock: (user: StaffUser, pin: string) => Promise<{ result: UnlockResult; pinState: PinState }>;
}) {
  const { t } = useTranslation();
  const [user, setUser] = useState<StaffUser | null>(null);
  const [shortCode, setShortCode] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const pick = (u: StaffUser | null) => {
    setUser(u);
    setPin('');
    setMessage(null);
  };

  const typeShortCode = (value: string) => {
    setShortCode(value);
    const match = staff.find((u) => u.shortCode !== null && u.shortCode === value.trim());
    if (match) pick(match);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setBusy(true);
    const r = await onUnlock(user, pin);
    setBusy(false);
    setPin('');
    if (r.result === 'wrong')
      setMessage(t('unlock.wrong', { count: PIN_MAX_FAILURES - r.pinState.failures }));
    else if (r.result === 'locked') setMessage(t('unlock.locked'));
    else if (r.result === 'no_pin') setMessage(t('unlock.no_pin'));
  };

  if (user) {
    return (
      <main className="screen">
        <h1>{user.fullName}</h1>
        <form onSubmit={(e) => void submit(e)}>
          <label>
            {t('unlock.pin')}
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              autoFocus
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
          </label>
          {message && <p role="alert">{message}</p>}
          <button type="submit" disabled={busy || pin === ''}>
            {busy ? t('unlock.checking') : t('unlock.submit')}
          </button>
          <button type="button" onClick={() => (pick(null), setShortCode(''))}>
            {t('unlock.back')}
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="screen">
      <h1>{t('unlock.title')}</h1>
      {staff.length === 0 ? (
        <p>{t('unlock.noStaff')}</p>
      ) : (
        <ul className="staff-list">
          {staff.map((u) => (
            <li key={u.id}>
              <button type="button" onClick={() => pick(u)}>
                {u.fullName}
                {u.shortCode && <span className="short-code">{u.shortCode}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <label>
        {t('unlock.shortCode')}
        <input
          inputMode="numeric"
          autoComplete="off"
          value={shortCode}
          onChange={(e) => typeShortCode(e.target.value)}
        />
      </label>
    </main>
  );
}
