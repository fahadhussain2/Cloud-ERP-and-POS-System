import { AppFrame } from '@erp/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Counter } from './counter';
import type { DeviceInfo } from './db/repo';
import { CardScreen } from './screens/Card';
import { ChoosePinScreen } from './screens/ChoosePinScreen';
import { CounterScreen } from './screens/CounterScreen';
import { SetupScreen } from './screens/SetupScreen';
import { StatusBar, type Connection } from './screens/StatusBar';
import { StopScreen } from './screens/StopScreen';
import { UnlockScreen } from './screens/UnlockScreen';
import type { StorageProblem } from './storage/checks';
import {
  autoLockDue,
  managerUnlock,
  staysUnlocked,
  tryUnlock,
  unlockableStaff,
  type StaffUser,
} from './unlock/unlock';

// The counter shell (POS spec §3-§9, D-089): storage checks → setup → unlock → (choose your PIN) → the counter screen.

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
/** After the network comes back: pull at once, then retry while the connection settles. */
const RECONNECT_RETRY_MS = [0, 1_000, 2_000, 4_000, 8_000, 15_000];
const AUTO_LOCK_CHECK_MS = 5_000;

export function App({ counter }: { counter: Counter }) {
  const { t, i18n } = useTranslation();
  const [phase, setPhase] = useState<Phase>({ name: 'checking' });
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [settings, setSettings] = useState<Settings>(null);
  const [connection, setConnection] = useState<Connection>({ state: null, offlineSince: null });
  const [status, setStatus] = useState({ outboxCount: 0, lastSyncAt: null as string | null });

  // Who is selling, for the pull below (a callback can't read the current phase).
  const phaseRef = useRef<Phase>(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const refresh = useCallback(async () => {
    const [s, st, set] = await Promise.all([counter.staff(), counter.status(), counter.settings()]);
    setStaff(unlockableStaff(s));
    setStatus(st);
    setSettings(set);
    // A pull can deactivate the person selling, or take their PIN away: lock at once (W1-04 plan).
    const p = phaseRef.current;
    if (p.name === 'unlocked' && !staysUnlocked(s, p.user.id)) {
      void counter.log('unlock.removed_by_sync', { userId: p.user.id });
      setPhase({ name: 'locked' });
    }
    return s;
  }, [counter]);

  const sync = useCallback(async () => {
    const r = await counter.pull(() => void refresh());
    setConnection((c) =>
      r.ok
        ? { state: 'online', offlineSince: null }
        : r.reason === 'refused'
          ? { state: 'refused', offlineSince: null }
          : { state: 'offline', offlineSince: c.offlineSince ?? new Date() },
    );
    await refresh();
    return r.ok;
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

  // Pull every minute. The status bar follows the network at once (POS spec §7): offline as soon as the browser
  // says so; when it comes back, the connection often isn't usable yet, so the pull is retried until one succeeds.
  const enrolled = device !== null;
  useEffect(() => {
    if (!enrolled) return;
    let stopped = false;
    const timer = setInterval(() => void sync(), PULL_EVERY_MS);
    const offline = () =>
      setConnection((c) => (c.state === 'offline' ? c : { state: 'offline', offlineSince: new Date() }));
    const online = async () => {
      for (const wait of RECONNECT_RETRY_MS) {
        await new Promise((r) => setTimeout(r, wait));
        if (stopped || !navigator.onLine) return;
        if (await sync()) return;
      }
    };
    const onOnline = () => void online();
    window.addEventListener('offline', offline);
    window.addEventListener('online', onOnline);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', onOnline);
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
    // The first pull brings the whole catalog: unlock can start as soon as its first page has the staff.
    void sync();
    setPhase({ name: 'locked' });
    return r;
  };

  /** Keeps a lock that just happened for the server's audit log (platform spec §4). */
  const recordLock = async (userId: string, before: { locked: boolean }, after: { locked: boolean }) => {
    if (!before.locked && after.locked)
      await counter.recordPinEvent({ kind: 'locked', userId, byUserId: null, at: new Date().toISOString() });
  };

  const unlock = async (user: StaffUser, pin: string) => {
    const pinState = await counter.getPinState(user.id);
    const r = await tryUnlock({ user, pin, pinState, verify: (v, p) => counter.verifyPin(v, p) });
    await counter.setPinState(user.id, r.pinState);
    await recordLock(user.id, pinState, r.pinState);
    await counter.log(`unlock.${r.result}`, { userId: user.id });
    if (r.result === 'ok') {
      setPhase({ name: 'unlocked', user });
      void sync();
    }
    if (r.result === 'must_change') setPhase({ name: 'choose_pin', user, temporaryPin: pin });
    return r;
  };

  const unlockByManager = async (locked: StaffUser, manager: StaffUser, pin: string) => {
    const [lockedState, managerState, managerGrants] = await Promise.all([
      counter.getPinState(locked.id),
      counter.getPinState(manager.id),
      counter.grants(manager.id),
    ]);
    const r = await managerUnlock({
      lockedUser: locked,
      lockedState,
      manager,
      managerState,
      managerGrants,
      branchId: device?.branchId ?? null,
      pin,
      verify: (v, p) => counter.verifyPin(v, p),
    });
    await counter.setPinState(manager.id, r.managerState);
    await counter.setPinState(locked.id, r.lockedState);
    await recordLock(manager.id, managerState, r.managerState);
    if (r.result === 'unlocked')
      await counter.recordPinEvent({
        kind: 'unlocked',
        userId: locked.id,
        byUserId: manager.id,
        at: new Date().toISOString(),
      });
    await counter.log(`unlock.manager.${r.result}`, { userId: locked.id, managerId: manager.id });
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
      screen = <CardScreen title={t('app.checking')}>{null}</CardScreen>;
      break;
    case 'stop':
      return <StopScreen problem={phase.problem} />;
    case 'setup':
      screen = <SetupScreen onEnroll={enroll} />;
      break;
    case 'locked':
      screen = (
        <UnlockScreen
          staff={staff}
          deviceCode={device?.code ?? null}
          onUnlock={unlock}
          onManagerUnlock={unlockByManager}
        />
      );
      break;
    case 'choose_pin':
      screen = (
        <ChoosePinScreen user={phase.user} onChoose={(p) => choosePin(phase.user, phase.temporaryPin, p)} />
      );
      break;
    case 'unlocked':
      screen = (
        <CounterScreen
          counter={counter}
          money={{
            locale: settings?.locale ?? i18n.language,
            currency: settings?.currency ?? 'PKR',
            minorUnits: settings?.minorUnits ?? 2,
          }}
          onLock={() => setPhase({ name: 'locked' })}
        />
      );
      break;
  }

  return (
    <AppFrame
      top={
        <StatusBar
          shopName={settings?.name ?? null}
          deviceCode={device?.code ?? null}
          connection={connection}
          outboxCount={status.outboxCount}
          lastSyncAt={status.lastSyncAt}
          userName={phase.name === 'unlocked' ? phase.user.fullName : null}
          timeZone={settings?.timeZone}
        />
      }
    >
      {screen}
    </AppFrame>
  );
}
