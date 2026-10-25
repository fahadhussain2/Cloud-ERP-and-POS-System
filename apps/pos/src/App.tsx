import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Counter } from './counter';
import type { DeviceInfo } from './db/repo';
import { ChoosePinScreen } from './screens/ChoosePinScreen';
import { SetupScreen } from './screens/SetupScreen';
import { StatusBar, type Connection } from './screens/StatusBar';
import { StopScreen } from './screens/StopScreen';
import { UnlockScreen } from './screens/UnlockScreen';
import type { StorageProblem } from './storage/checks';
import { autoLockDue, tryUnlock, unlockableStaff, type StaffUser } from './unlock/unlock';

// The counter shell (POS spec §3-§7, D-089): storage checks → setup → unlock → (choose your PIN) → home.

type Phase =
  | { name: 'checking' }
  | { name: 'stop'; problem: StorageProblem }
  | { name: 'setup' }
  | { name: 'locked' }
  | { name: 'choose_pin'; user: StaffUser; temporaryPin: string }
  | { name: 'unlocked'; user: StaffUser };

type Settings = Awaited<ReturnType<Counter['settings']>>;

/** Sync spec §4: every 60 seconds while the counter runs. */
const PULL_EVERY_MS = 60_000;
const AUTO_LOCK_CHECK_MS = 5_000;

export function App({ counter }: { counter: Counter }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>({ name: 'checking' });
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [settings, setSettings] = useState<Settings>(null);
  const [connection, setConnection] = useState<Connection>({ state: null, offlineSince: null });
  const [status, setStatus] = useState({ outboxCount: 0, lastSyncAt: null as string | null });

  const refresh = useCallback(async () => {
    const [s, st, set] = await Promise.all([counter.staff(), counter.status(), counter.settings()]);
    setStaff(unlockableStaff(s));
    setStatus(st);
    setSettings(set);
    return s;
  }, [counter]);

  const sync = useCallback(async () => {
    const r = await counter.pull();
    setConnection((c) =>
      r.ok
        ? { state: 'online', offlineSince: null }
        : r.reason === 'refused'
          ? { state: 'refused', offlineSince: null }
          : { state: 'offline', offlineSince: c.offlineSince ?? new Date() },
    );
    return refresh();
  }, [counter, refresh]);

  // Start-up: the checks block everything else (POS spec §3).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const checks = await counter.checkStorage();
      if (cancelled) return;
      if (!checks.ok) return setPhase({ name: 'stop', problem: checks.problem });
      const d = await counter.device();
      setDevice(d);
      if (!d) return setPhase({ name: 'setup' });
      await refresh();
      if (cancelled) return;
      setPhase({ name: 'locked' });
      void sync();
    })();
    return () => {
      cancelled = true;
    };
  }, [counter, refresh, sync]);

  // Pull every minute and as soon as the connection comes back.
  const enrolled = device !== null;
  useEffect(() => {
    if (!enrolled) return;
    const timer = setInterval(() => void sync(), PULL_EVERY_MS);
    const online = () => void sync();
    window.addEventListener('online', online);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', online);
    };
  }, [enrolled, sync]);

  // Auto-lock after 3 minutes without a key press, and at closing time (POS spec §6, owner answer 1).
  const lastActivity = useRef(new Date());
  const unlocked = phase.name === 'unlocked';
  useEffect(() => {
    if (!unlocked) return;
    lastActivity.current = new Date();
    const touch = () => (lastActivity.current = new Date());
    window.addEventListener('keydown', touch);
    window.addEventListener('pointerdown', touch);
    const timer = setInterval(() => {
      const due = autoLockDue({
        lastActivity: lastActivity.current,
        now: new Date(),
        closingTime: settings?.closingTime ?? '23:59',
        timeZone: settings?.timeZone ?? 'Asia/Karachi',
      });
      if (due) {
        void counter.log('unlock.auto_lock', {});
        setPhase({ name: 'locked' });
      }
    }, AUTO_LOCK_CHECK_MS);
    return () => {
      clearInterval(timer);
      window.removeEventListener('keydown', touch);
      window.removeEventListener('pointerdown', touch);
    };
  }, [unlocked, settings, counter]);

  const enroll = async (input: { tenantCode: string; code: string }) => {
    const r = await counter.enroll(input);
    if (!r.ok) return r;
    setDevice(await counter.device());
    await sync();
    setPhase({ name: 'locked' });
    return r;
  };

  const unlock = async (user: StaffUser, pin: string) => {
    const pinState = await counter.getPinState(user.id);
    const r = await tryUnlock({ user, pin, pinState, verify: (v, p) => counter.verifyPin(v, p) });
    await counter.setPinState(user.id, r.pinState);
    await counter.log(`unlock.${r.result}`, { userId: user.id });
    if (r.result === 'ok') {
      setPhase({ name: 'unlocked', user });
      void sync();
    }
    if (r.result === 'must_change') setPhase({ name: 'choose_pin', user, temporaryPin: pin });
    return r;
  };

  const choosePin = async (user: StaffUser, temporaryPin: string, newPin: string) => {
    const r = await counter.changePin({ userId: user.id, currentPin: temporaryPin, newPin });
    await counter.log('pin.choose', { userId: user.id, result: r });
    if (r !== 'ok') return r;
    // The new verifier comes back with the next pull; until then this person is unlocked with the PIN just checked.
    await sync();
    setPhase({ name: 'unlocked', user });
    return r;
  };

  let screen;
  switch (phase.name) {
    case 'checking':
      screen = (
        <main className="screen">
          <p>{t('app.checking')}</p>
        </main>
      );
      break;
    case 'stop':
      return <StopScreen problem={phase.problem} />;
    case 'setup':
      screen = <SetupScreen onEnroll={enroll} />;
      break;
    case 'locked':
      screen = <UnlockScreen staff={staff} onUnlock={unlock} />;
      break;
    case 'choose_pin':
      screen = (
        <ChoosePinScreen user={phase.user} onChoose={(p) => choosePin(phase.user, phase.temporaryPin, p)} />
      );
      break;
    case 'unlocked':
      screen = (
        <main className="screen">
          <h1>{settings?.name ?? t('app.title')}</h1>
          <p>{t('home.ready', { name: phase.user.fullName })}</p>
          <p>{t('home.placeholder')}</p>
          <button type="button" onClick={() => setPhase({ name: 'locked' })}>
            {t('home.lock')}
          </button>
        </main>
      );
      break;
  }

  return (
    <div className="shell">
      {screen}
      <StatusBar
        deviceCode={device?.code ?? null}
        connection={connection}
        outboxCount={status.outboxCount}
        lastSyncAt={status.lastSyncAt}
        userName={phase.name === 'unlocked' ? phase.user.fullName : null}
        timeZone={settings?.timeZone}
      />
    </div>
  );
}
