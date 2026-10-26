import { PIN_MAX_FAILURES, type PinState } from '@erp/domain';
import { Alert, AlertDescription, Button, TextField } from '@erp/ui';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { StaffUser, UnlockResult } from '../unlock/unlock';
import { CardScreen } from './Card';

/** Unlock (POS spec §5, owner answer 3): pick your name, or type your short code, then your PIN. */
export function UnlockScreen({
  staff,
  deviceCode,
  onUnlock,
}: {
  staff: StaffUser[];
  deviceCode: string | null;
  onUnlock: (user: StaffUser, pin: string) => Promise<{ result: UnlockResult; pinState: PinState }>;
}) {
  const { t } = useTranslation();
  const [user, setUser] = useState<StaffUser | null>(null);
  const [shortCode, setShortCode] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const eyebrow = deviceCode ? t('unlock.eyebrow', { code: deviceCode }) : undefined;

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
      <CardScreen eyebrow={eyebrow} title={user.fullName}>
        <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
          <TextField
            label={t('unlock.pin')}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            className="h-14 text-center font-mono text-[28px] tracking-[.5em]"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
          {message && (
            <Alert variant="destructive">
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" size="lg" disabled={busy || pin === ''}>
            {busy ? t('unlock.checking') : t('unlock.submit')}
          </Button>
          <Button variant="ghost" onClick={() => (pick(null), setShortCode(''))}>
            {t('unlock.back')}
          </Button>
        </form>
        <p className="m-0 text-center text-xs text-muted-foreground">{t('unlock.recorded')}</p>
      </CardScreen>
    );
  }

  return (
    <CardScreen eyebrow={eyebrow} title={t('unlock.title')} wide>
      {staff.length === 0 ? (
        <Alert>
          <AlertDescription>{t('unlock.noStaff')}</AlertDescription>
        </Alert>
      ) : (
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-2 p-0">
          {staff.map((u) => (
            <li key={u.id}>
              <Button variant="outline" size="lg" className="w-full justify-between" onClick={() => pick(u)}>
                {u.fullName}
                {u.shortCode && <span className="font-mono text-muted-foreground">{u.shortCode}</span>}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <TextField
        label={t('unlock.shortCode')}
        inputMode="numeric"
        autoComplete="off"
        className="font-mono"
        value={shortCode}
        onChange={(e) => typeShortCode(e.target.value)}
      />
    </CardScreen>
  );
}
