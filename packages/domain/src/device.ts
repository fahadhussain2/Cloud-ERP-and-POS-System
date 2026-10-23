// Staff PIN rules, the PIN lockout on a device, and device codes (PLT-03, PLT-04, platform spec §1, §4, D-082).
// The POS checks PINs offline with these same rules (CLAUDE.md rule 2).

export type PinProblem = 'not_digits' | 'too_short' | 'too_long' | 'all_same' | 'sequence' | 'is_short_code';

/** A PIN is 4–6 digits, not one digit repeated, not a straight run up or down, and not the user's short code. */
export function pinProblem(pin: string, shortCode: string | null): PinProblem | null {
  if (!/^\d+$/.test(pin)) return 'not_digits';
  if (pin.length < 4) return 'too_short';
  if (pin.length > 6) return 'too_long';
  const digits = [...pin].map(Number);
  if (digits.every((d) => d === digits[0])) return 'all_same';
  const steps = digits.slice(1).map((d, i) => d - digits[i]!);
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return 'sequence';
  if (shortCode !== null && pin === shortCode) return 'is_short_code';
  return null;
}

/** Wrong PINs in a row before the user is locked on that device. */
export const PIN_MAX_FAILURES = 5;

export interface PinState {
  failures: number;
  locked: boolean;
}

export type PinEvent = 'correct' | 'wrong' | 'manager_unlock';
export type PinResult = 'ok' | 'wrong' | 'locked' | 'unlocked';

/** One PIN attempt (or a manager unlock) on a device. Locked stays locked until a manager unlocks it. */
export function nextPinState(state: PinState, event: PinEvent): { state: PinState; result: PinResult } {
  if (event === 'manager_unlock') return { state: { failures: 0, locked: false }, result: 'unlocked' };
  if (state.locked) return { state, result: 'locked' };
  if (event === 'correct') return { state: { failures: 0, locked: false }, result: 'ok' };
  const failures = state.failures + 1;
  const locked = failures >= PIN_MAX_FAILURES;
  return { state: { failures, locked }, result: locked ? 'locked' : 'wrong' };
}

export type DeviceKind = 'counter' | 'cash_desk' | 'mobile';

const PREFIX: Record<DeviceKind, string> = { counter: 'C', cash_desk: 'D', mobile: 'M' };

/**
 * The next device code for a kind: C01, C02… for counters, D01… for cash desks, M01… for mobile. Numbers are
 * never reused, even after a device is revoked, so bill numbers like C03-S000412 stay unique (architecture §4.4).
 */
export function nextDeviceCode(kind: DeviceKind, existing: readonly string[]): string {
  const prefix = PREFIX[kind];
  const pattern = new RegExp(`^${prefix}(\\d{2,})$`);
  const highest = existing.reduce((max, code) => {
    const m = pattern.exec(code);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  return `${prefix}${String(highest + 1).padStart(2, '0')}`;
}
