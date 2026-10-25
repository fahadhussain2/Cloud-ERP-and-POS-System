import { nextPinState, type PinState } from '@erp/domain';

// Unlock and auto-lock (POS spec §5–§6, PLT-01, PLT-04, D-089). The PIN check itself is the W0-10 PBKDF2 verifier,
// passed in so the worker runs it off the UI thread and tests can use a fast fake.

export interface StaffUser {
  id: string;
  fullName: string;
  shortCode: string | null;
  pinVerifier: string | null;
  pinMustChange: boolean;
  status: string;
  deletedAt: string | null;
}

/** Owner answer 1 to W1-02: 3 minutes without a key press. */
export const IDLE_LOCK_MS = 3 * 60_000;

/** Who appears on the unlock screen: active people with a PIN, by name. */
export const unlockableStaff = (users: readonly StaffUser[]): StaffUser[] =>
  users
    .filter((u) => u.status === 'active' && u.deletedAt === null && u.pinVerifier !== null)
    .sort((a, b) => a.fullName.localeCompare(b.fullName));

export type UnlockResult = 'ok' | 'wrong' | 'locked' | 'must_change' | 'no_pin';

export async function tryUnlock(opts: {
  user: StaffUser;
  pin: string;
  pinState: PinState;
  verify: (verifier: string, pin: string) => Promise<boolean>;
}): Promise<{ result: UnlockResult; pinState: PinState }> {
  const { user, pin, pinState, verify } = opts;
  if (user.pinVerifier === null) return { result: 'no_pin', pinState };
  if (pinState.locked) return { result: 'locked', pinState };
  const next = nextPinState(pinState, (await verify(user.pinVerifier, pin)) ? 'correct' : 'wrong');
  // A right temporary PIN leads to choosing the person's own PIN, never straight to selling.
  if (next.result === 'ok' && user.pinMustChange) return { result: 'must_change', pinState: next.state };
  return { result: next.result as 'ok' | 'wrong' | 'locked', pinState: next.state };
}

/** The local date (YYYY-MM-DD) and minutes since midnight of `at` in `timeZone`. */
function localDayMinutes(at: Date, timeZone: string): { day: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return {
    day: `${parts['year']}-${parts['month']}-${parts['day']}`,
    minutes: Number(parts['hour']) * 60 + Number(parts['minute']),
  };
}

/** True when the counter must lock now: after the idle time, or when closing time has passed since the last activity. */
export function autoLockDue(opts: {
  lastActivity: Date;
  now: Date;
  /** The tenant's closing time, `HH:MM` or `HH:MM:SS` (PLT-01, D-056). */
  closingTime: string;
  timeZone: string;
}): boolean {
  if (opts.now.getTime() - opts.lastActivity.getTime() >= IDLE_LOCK_MS) return true;
  const [h, m] = opts.closingTime.split(':').map(Number);
  const closing = h! * 60 + m!;
  const last = localDayMinutes(opts.lastActivity, opts.timeZone);
  const now = localDayMinutes(opts.now, opts.timeZone);
  if (now.day !== last.day) return now.minutes >= closing;
  return last.minutes < closing && now.minutes >= closing;
}
