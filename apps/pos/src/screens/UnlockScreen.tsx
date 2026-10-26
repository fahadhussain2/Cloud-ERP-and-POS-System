import { PIN_MAX_FAILURES, type PinState } from '@erp/domain';
import { Alert, AlertDescription, Button, TextField } from '@erp/ui';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { ManagerUnlockResult, StaffUser, UnlockResult } from '../unlock/unlock';
import { CardScreen } from './Card';

type Message = { text: string; ok: boolean } | null;

/**
 * Unlock (POS spec §5, owner answer 3): pick your name, or type your short code, then your PIN. A person locked by
 * wrong PINs can be unlocked here by a manager with their own PIN (W1-04 plan).
 */
export function UnlockScreen({
  staff,
  deviceCode,
  onUnlock,
  onManagerUnlock,
}: {
  staff: StaffUser[];
  deviceCode: string | null;
  onUnlock: (user: StaffUser, pin: string) => Promise<{ result: UnlockResult; pinState: PinState }>;
  onManagerUnlock: (
    locked: StaffUser,
    manager: StaffUser,
    pin: string,
  ) => Promise<{ result: ManagerUnlockResult; managerState: PinState }>;
}) {
  const { t } = useTranslation();
  const [user, setUser] = useState<StaffUser | null>(null);
  const [locked, setLocked] = useState(false);
  // The manager unlock: who is being unlocked, and the manager who unlocks them.
  const [managerFor, setManagerFor] = useState<StaffUser | null>(null);
  const [manager, setManager] = useState<StaffUser | null>(null);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const eyebrow = deviceCode ? t('unlock.eyebrow', { code: deviceCode }) : undefined;

  const pick = (u: StaffUser | null) => {
    setUser(u);
    setLocked(false);
    setPin('');
    setMessage(null);
  };
  const pickManager = (m: StaffUser | null) => {
    setManager(m);
    setPin('');
    setMessage(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setBusy(true);
    const r = await onUnlock(user, pin);
    setBusy(false);
    setPin('');
    setLocked(r.result === 'locked');
    if (r.result === 'wrong')
      setMessage({ text: t('unlock.wrong', { count: PIN_MAX_FAILURES - r.pinState.failures }), ok: false });
    else if (r.result === 'locked') setMessage({ text: t('unlock.locked'), ok: false });
    else if (r.result === 'no_pin') setMessage({ text: t('unlock.no_pin'), ok: false });
  };

  const submitManager = async (e: FormEvent) => {
    e.preventDefault();
    if (!managerFor || !manager) return;
    setBusy(true);
    const r = await onManagerUnlock(managerFor, manager, pin);
    setBusy(false);
    setPin('');
    if (r.result === 'unlocked') {
      const name = managerFor.fullName;
      setManagerFor(null);
      setManager(null);
      setLocked(false);
      return setMessage({ text: t('unlock.managerDone', { name }), ok: true });
    }
    setMessage({
      ok: false,
      text:
        r.result === 'wrong'
          ? t('unlock.wrong', { count: PIN_MAX_FAILURES - r.managerState.failures })
          : r.result === 'manager_locked'
            ? t('unlock.managerLocked')
            : r.result === 'not_locked'
              ? t('unlock.notLocked')
              : t('unlock.notAllowed'),
    });
  };

  const note = message && (
    <Alert variant={message.ok ? 'default' : 'destructive'}>
      <AlertDescription>{message.text}</AlertDescription>
    </Alert>
  );

  // A manager enters their own PIN to unlock `managerFor`.
  if (managerFor && manager) {
    return (
      <CardScreen eyebrow={t('unlock.managerTitle')} title={manager.fullName}>
        <form className="flex flex-col gap-3" onSubmit={(e) => void submitManager(e)}>
          <p className="m-0 text-center text-muted-foreground">
            {t('unlock.managerFor', { name: managerFor.fullName })}
          </p>
          <TextField
            label={t('unlock.managerPin')}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            className="h-14 text-center font-mono text-[28px] tracking-[.5em]"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
          {note}
          <Button type="submit" size="lg" disabled={busy || pin === ''}>
            {busy ? t('unlock.checking') : t('unlock.managerSubmit')}
          </Button>
          <Button variant="ghost" onClick={() => pickManager(null)}>
            {t('unlock.back')}
          </Button>
        </form>
      </CardScreen>
    );
  }

  // Which manager? Everyone but the locked person; the check happens with their PIN.
  if (managerFor) {
    return (
      <CardScreen eyebrow={eyebrow} title={t('unlock.managerTitle')} wide>
        <p className="m-0 text-center text-muted-foreground">
          {t('unlock.managerFor', { name: managerFor.fullName })}
        </p>
        <StaffPicker
          staff={staff.filter((u) => u.id !== managerFor.id)}
          onPick={pickManager}
          shortCodeLabel={t('unlock.shortCode')}
        />
        <Button
          variant="ghost"
          onClick={() => {
            setManagerFor(null);
            setMessage(null);
          }}
        >
          {t('unlock.back')}
        </Button>
      </CardScreen>
    );
  }

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
          {note}
          <Button type="submit" size="lg" disabled={busy || pin === ''}>
            {busy ? t('unlock.checking') : t('unlock.submit')}
          </Button>
          {locked && (
            <Button
              variant="outline"
              size="lg"
              onClick={() => {
                setManagerFor(user);
                pickManager(null);
              }}
            >
              {t('unlock.managerUnlock')}
            </Button>
          )}
          <Button variant="ghost" onClick={() => pick(null)}>
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
        <StaffPicker staff={staff} onPick={pick} shortCodeLabel={t('unlock.shortCode')} />
      )}
    </CardScreen>
  );
}

/** The staff names as buttons, and the short-code field that picks one as soon as it matches. */
function StaffPicker({
  staff,
  onPick,
  shortCodeLabel,
}: {
  staff: StaffUser[];
  onPick: (u: StaffUser) => void;
  shortCodeLabel: string;
}) {
  const [shortCode, setShortCode] = useState('');
  const typeShortCode = (value: string) => {
    setShortCode(value);
    const match = staff.find((u) => u.shortCode !== null && u.shortCode === value.trim());
    if (match) onPick(match);
  };
  return (
    <>
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-2 p-0">
        {staff.map((u) => (
          <li key={u.id}>
            <Button variant="outline" size="lg" className="w-full justify-between" onClick={() => onPick(u)}>
              {u.fullName}
              {u.shortCode && <span className="font-mono text-muted-foreground">{u.shortCode}</span>}
            </Button>
          </li>
        ))}
      </ul>
      <TextField
        label={shortCodeLabel}
        inputMode="numeric"
        autoComplete="off"
        className="font-mono"
        value={shortCode}
        onChange={(e) => typeShortCode(e.target.value)}
      />
    </>
  );
}
