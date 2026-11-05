import { can } from '@erp/domain';
import { AppFrame } from '@erp/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Counter, CounterHealth, CounterStatus } from './counter';
import type { QuarantinedRow } from './db/outbox';
import type { DeviceInfo } from './db/repo';
import { CardScreen } from './screens/Card';
import { CashDeskScreen } from './screens/CashDeskScreen';
import { ChoosePinScreen } from './screens/ChoosePinScreen';
import { CounterScreen } from './screens/CounterScreen';
import { HealthDialog, type RetryAttempt } from './screens/HealthDialog';
import { RevokedScreen } from './screens/RevokedScreen';
import { SetupScreen } from './screens/SetupScreen';
import { StatusBar, type Connection } from './screens/StatusBar';
import { StopScreen } from './screens/StopScreen';
import { UnlockScreen } from './screens/UnlockScreen';
import type { StorageProblem } from './storage/checks';
import { DEFAULT_THRESHOLDS, offlineLevel } from './sync/offline';
import type { PullResult } from './sync/pull';
import { createPushScheduler, type PushOutcome, type PushScheduler } from './sync/push';
import { checkManager } from './unlock/approve';
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
  | { name: 'unlocked'; user: StaffUser }
  | { name: 'revoked' };

type Settings = Awaited<ReturnType<Counter['settings']>>;

/** Sync spec §4: every 60 seconds while the counter runs; push runs on the same timer (a handshake when empty). */
const PULL_EVERY_MS = 60_000;
/** With the SSE nudge connected, a pull happens on each nudge and at least this often (sync spec §8). */
const PULL_WITH_NUDGE_MS = 5 * 60_000;
/** The offline warning is checked this often (SYN-06). */
const OFFLINE_TICK_MS = 60_000;
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
  const [status, setStatus] = useState<CounterStatus>({
    outboxCount: 0,
    lastSyncAt: null,
    lastContactAt: null,
    attention: 0,
  });
  const [health, setHealth] = useState<{ health: CounterHealth | null; attention: QuarantinedRow[] } | null>(
    null,
  );
  const [now, setNow] = useState(() => Date.now());
  // The SSE nudge is up: pulls follow it instead of the minute timer (sync spec §8).
  const live = useRef(false);
  const [liveShown, setLiveShown] = useState(false);
  const lastPullAt = useRef(0);
  const pusher = useRef<PushScheduler | null>(null);
  const [syncTick, setSyncTick] = useState(0);
  // On a cash desk (W1-10): the Cash desk screen, or selling (Alt+Q switches, D-001: the desk also sells).
  const [deskView, setDeskView] = useState(false);

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

  /** What a pull or a push tells about the connection; a revoked counter stops (sync spec §1, W1-07). */
  const noteOutcome = useCallback(
    (r: PullResult | PushOutcome) => {
      if (!r.ok && r.reason === 'revoked') {
        void counter.log('sync.revoked', {});
        setPhase({ name: 'revoked' });
      }
      // An answer that arrives after the browser said offline was sent before it: it doesn't make the counter
      // online (e2e 2026-11-05); the reconnect retry does, once the network is back.
      setConnection((c) =>
        r.ok
          ? c.state === 'offline' && !navigator.onLine
            ? c
            : { state: 'online', offlineSince: null }
          : r.reason === 'refused' || r.reason === 'revoked'
            ? { state: 'refused', offlineSince: null }
            : { state: 'offline', offlineSince: c.offlineSince ?? new Date() },
      );
    },
    [counter],
  );

  const sync = useCallback(async () => {
    lastPullAt.current = Date.now();
    const r = await counter.pull(() => void refresh());
    noteOutcome(r);
    await refresh();
    // The cash desk reads its queue again after every pull (W1-10).
    setSyncTick((n) => n + 1);
    return r.ok;
  }, [counter, refresh, noteOutcome]);

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
      // This counter keeps its own bills 30 days (SYN-01), never one still to sync.
      void counter.prune();
    })();
    return () => {
      cancelled = true;
    };
  }, [counter, refresh, sync]);

  // Push (sync spec §6.2, SYN-02): at once on start-up (the handshake, which also notices a server restore), after
  // every finalize, on reconnect and with the minute timer; retried with backoff while it fails.
  const enrolled = device !== null;
  useEffect(() => {
    if (!enrolled) return;
    const scheduler = createPushScheduler({
      run: () => counter.push(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (h) => window.clearTimeout(h as number),
      onOutcome: (o) => {
        noteOutcome(o);
        void refresh();
      },
    });
    pusher.current = scheduler;
    scheduler.trigger();
    return () => {
      scheduler.stop();
      pusher.current = null;
    };
  }, [enrolled, counter, noteOutcome, refresh]);

  // The SSE nudge (SYN-04): each changes-available pulls at once; while it is up the minute timer pulls only every
  // 5 minutes as a safety net.
  useEffect(() => {
    if (!enrolled) return;
    return counter.listen({
      onChanges: () => void sync(),
      onConnected: (up) => {
        live.current = up;
        setLiveShown(up);
      },
    });
  }, [enrolled, counter, sync]);

  // The offline warning follows the clock (SYN-06).
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), OFFLINE_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // Pull every minute (or with the nudge). The status bar follows the network at once (POS spec §7): offline as soon
  // as the browser says so; when it comes back, the connection often isn't usable yet, so the pull is retried until
  // one succeeds, and the outbox is pushed.
  useEffect(() => {
    if (!enrolled) return;
    let stopped = false;
    const timer = setInterval(() => {
      if (!live.current || Date.now() - lastPullAt.current >= PULL_WITH_NUDGE_MS) void sync();
      pusher.current?.trigger();
    }, PULL_EVERY_MS);
    const offline = () =>
      setConnection((c) => (c.state === 'offline' ? c : { state: 'offline', offlineSince: new Date() }));
    const online = async () => {
      pusher.current?.trigger();
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

  /** The counter's health page (POS spec §14): read fresh each time it opens. */
  const openHealth = useCallback(async () => {
    const [h, attention] = await Promise.all([counter.health(), counter.needsAttention()]);
    setHealth({ health: h, attention });
  }, [counter]);

  // A cash desk opens on the Cash desk screen for someone who may take cash, else on selling (cash desk spec).
  const isDesk = device?.kind === 'cash_desk';
  const unlockedId = phase.name === 'unlocked' ? phase.user.id : null;
  useEffect(() => {
    if (!isDesk || unlockedId === null) return;
    let cancelled = false;
    void counter.grants(unlockedId).then((g) => {
      if (!cancelled) setDeskView(can(g, 'cash.handover.receive', device?.branchId ?? null));
    });
    return () => {
      cancelled = true;
    };
  }, [isDesk, unlockedId, counter, device?.branchId]);

  // Alt+Q from selling back to the Cash desk screen; the desk screen has its own Alt+Q to selling.
  useEffect(() => {
    if (!isDesk || unlockedId === null || deskView) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.key.toLowerCase() !== 'q') return;
      e.preventDefault();
      setDeskView(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isDesk, unlockedId, deskView]);

  // Alt+S opens it from the staff list, the counter and the revoked screen (POS spec §11).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const p = phaseRef.current.name;
      if (!e.altKey || e.ctrlKey || e.metaKey || e.key.toLowerCase() !== 's') return;
      if (p !== 'locked' && p !== 'unlocked' && p !== 'revoked') return;
      e.preventDefault();
      void openHealth();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openHealth]);

  /** *Try again* on a refused bill: a manager's own PIN and admin.devices (owner answer 4 to W1-07). */
  const retry: RetryAttempt = async (row, manager, pin) => {
    const [state, grants] = await Promise.all([counter.getPinState(manager.id), counter.grants(manager.id)]);
    const r = await checkManager({
      approver: manager,
      approverState: state,
      approverGrants: grants,
      branchId: device?.branchId ?? null,
      pin,
      verify: (v, p) => counter.verifyPin(v, p),
    });
    await counter.setPinState(manager.id, r.approverState);
    await recordLock(manager.id, state, r.approverState);
    await counter.log('sync.retry', { documentId: row.id, managerId: manager.id, result: r.result });
    if (r.result === 'approved') {
      await counter.retryBill(row.id);
      pusher.current?.trigger();
      await Promise.all([openHealth(), refresh()]);
    }
    return { result: r.result, failures: r.approverState.failures };
  };

  const offline = {
    level: offlineLevel(status.lastContactAt, now, {
      warningHours: settings?.offlineWarningHours ?? DEFAULT_THRESHOLDS.warningHours,
      strongHours: settings?.offlineStrongWarningHours ?? DEFAULT_THRESHOLDS.strongHours,
    }),
    hours: status.lastContactAt === null ? 0 : (now - Date.parse(status.lastContactAt)) / 3_600_000,
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
      screen =
        isDesk && deskView ? (
          <CashDeskScreen
            counter={counter}
            money={{
              locale: settings?.locale ?? i18n.language,
              currency: settings?.currency ?? 'PKR',
              minorUnits: settings?.minorUnits ?? 2,
            }}
            user={phase.user}
            staff={staff}
            branchId={device?.branchId ?? null}
            shopName={settings?.name ?? ''}
            timeZone={settings?.timeZone ?? 'Asia/Karachi'}
            offline={connection.state !== 'online'}
            offlineSince={connection.offlineSince}
            syncTick={syncTick}
            onSaved={() => {
              void refresh();
              // A handover reaches the server at once, like a bill (SYN-02).
              pusher.current?.trigger();
            }}
            onSell={() => setDeskView(false)}
            onLock={() => setPhase({ name: 'locked' })}
          />
        ) : (
          <CounterScreen
            counter={counter}
            money={{
              locale: settings?.locale ?? i18n.language,
              currency: settings?.currency ?? 'PKR',
              minorUnits: settings?.minorUnits ?? 2,
            }}
            user={phase.user}
            staff={staff}
            branchId={device?.branchId ?? null}
            shopName={settings?.name ?? ''}
            offline={connection.state !== 'online'}
            onLock={() => setPhase({ name: 'locked' })}
            onSaved={() => {
              void refresh();
              // A finalized bill goes to the server at once, not on a timer (SYN-02).
              pusher.current?.trigger();
            }}
          />
        );
      break;
    case 'revoked':
      screen = <RevokedScreen waiting={status.outboxCount} onRetry={() => window.location.reload()} />;
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
          attention={status.attention}
          offline={offline}
          onOpenHealth={() => void openHealth()}
        />
      }
    >
      {screen}
      {health && (
        <HealthDialog
          health={health.health}
          attention={health.attention}
          live={liveShown}
          staff={staff}
          locale={settings?.locale ?? i18n.language}
          timeZone={settings?.timeZone ?? 'Asia/Karachi'}
          onRetry={retry}
          onClose={() => setHealth(null)}
        />
      )}
    </AppFrame>
  );
}
