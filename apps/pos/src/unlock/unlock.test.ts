import { describe, expect, it } from 'vitest';

import { autoLockDue, IDLE_LOCK_MS, tryUnlock, unlockableStaff, type StaffUser } from './unlock';

// Unlock and auto-lock (POS spec §5–§6, PLT-01, PLT-04, owner answers to W1-02). A fake verifier keeps the tests
// fast; the real one is the W0-10 PBKDF2 check, tested in packages/contracts.

const user = (over: Partial<StaffUser> = {}): StaffUser => ({
  id: 'u1',
  fullName: 'Sara',
  shortCode: '4821',
  pinVerifier: 'pin:5739',
  pinMustChange: false,
  status: 'active',
  deletedAt: null,
  ...over,
});
const verify = (verifier: string, pin: string) => Promise.resolve(verifier === `pin:${pin}`);
const open = { failures: 0, locked: false };

describe('the staff list', () => {
  it('shows active people with a PIN, by name', () => {
    const list = unlockableStaff([
      user({ id: 'z', fullName: 'Zain' }),
      user({ id: 'd', fullName: 'Disabled', status: 'disabled' }),
      user({ id: 'g', fullName: 'Gone', deletedAt: '2026-10-25T00:00:00Z' }),
      user({ id: 'n', fullName: 'No PIN yet', pinVerifier: null }),
      user({ id: 'a', fullName: 'Ahmed' }),
    ]);
    expect(list.map((u) => u.id)).toEqual(['a', 'z']);
  });
});

describe('unlocking', () => {
  it('a right PIN unlocks and clears earlier mistakes', async () => {
    expect(
      await tryUnlock({ user: user(), pin: '5739', pinState: { failures: 3, locked: false }, verify }),
    ).toEqual({
      result: 'ok',
      pinState: open,
    });
  });

  it('5 wrong PINs lock the person on this counter, and a right PIN then still fails', async () => {
    let pinState = open;
    for (let i = 1; i <= 5; i++) {
      const r = await tryUnlock({ user: user(), pin: '0000', pinState, verify });
      pinState = r.pinState;
      expect(r.result).toBe(i < 5 ? 'wrong' : 'locked');
    }
    expect(pinState).toEqual({ failures: 5, locked: true });
    expect((await tryUnlock({ user: user(), pin: '5739', pinState, verify })).result).toBe('locked');
  });

  it("a right temporary PIN asks for the person's own PIN instead of unlocking", async () => {
    expect(
      (await tryUnlock({ user: user({ pinMustChange: true }), pin: '5739', pinState: open, verify })).result,
    ).toBe('must_change');
  });

  it('nobody unlocks without a PIN set', async () => {
    expect(
      (await tryUnlock({ user: user({ pinVerifier: null }), pin: '5739', pinState: open, verify })).result,
    ).toBe('no_pin');
  });
});

describe('auto-lock', () => {
  const base = { closingTime: '20:00:00', timeZone: 'Asia/Karachi' };
  // 2026-11-02 in Karachi (UTC+5): 15:00Z = 20:00 local.
  const at = (iso: string) => new Date(iso);

  it('locks after 3 minutes without a key press, not before', () => {
    expect(IDLE_LOCK_MS).toBe(3 * 60_000);
    const last = at('2026-11-02T08:00:00Z');
    expect(autoLockDue({ ...base, lastActivity: last, now: at('2026-11-02T08:02:59Z') })).toBe(false);
    expect(autoLockDue({ ...base, lastActivity: last, now: at('2026-11-02T08:03:00Z') })).toBe(true);
  });

  it('locks at closing time even if someone was just active', () => {
    const last = at('2026-11-02T14:59:30Z'); // 19:59:30 local
    expect(autoLockDue({ ...base, lastActivity: last, now: at('2026-11-02T14:59:50Z') })).toBe(false);
    expect(autoLockDue({ ...base, lastActivity: last, now: at('2026-11-02T15:00:10Z') })).toBe(true);
  });

  it('after closing, someone who unlocks again is only locked by the idle rule', () => {
    const last = at('2026-11-02T15:05:00Z'); // unlocked again at 20:05 local
    expect(autoLockDue({ ...base, lastActivity: last, now: at('2026-11-02T15:06:00Z') })).toBe(false);
    expect(autoLockDue({ ...base, lastActivity: last, now: at('2026-11-02T15:08:00Z') })).toBe(true);
  });
});
