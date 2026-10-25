import { describe, expect, it } from 'vitest';

import { runStorageChecks, type CheckDeps } from './checks';

// The start-up safeguards (POS spec §3, D-010, D-089): each failure is one stop, and selling waits for all to pass.

const healthy = { schemaVersion: 1, quickCheck: 'ok', outboxCount: 0 };
const deps = (over: Partial<CheckDeps> = {}): CheckDeps => ({
  persisted: () => Promise.resolve(true),
  persist: () => Promise.resolve(true),
  openDatabase: () => Promise.resolve(healthy),
  ...over,
});

describe('storage checks', () => {
  it('pass on a healthy counter', async () => {
    expect(await runStorageChecks(deps())).toEqual({ ok: true, health: healthy });
  });

  it('ask for permanent storage once, and stop if Chrome refuses', async () => {
    let asked = 0;
    const ok = await runStorageChecks(
      deps({ persisted: () => Promise.resolve(false), persist: () => (asked++, Promise.resolve(true)) }),
    );
    expect(ok.ok).toBe(true);
    expect(asked).toBe(1);
    expect(
      await runStorageChecks(
        deps({ persisted: () => Promise.resolve(false), persist: () => Promise.resolve(false) }),
      ),
    ).toEqual({
      ok: false,
      problem: 'not_persistent',
    });
  });

  it('stop when the database cannot open, is too new, is damaged, or its outbox is unreadable', async () => {
    const fail = (name: string) => () => Promise.reject(Object.assign(new Error(name), { name }));
    expect(await runStorageChecks(deps({ openDatabase: fail('NotSupportedError') }))).toEqual({
      ok: false,
      problem: 'unavailable',
    });
    expect(await runStorageChecks(deps({ openDatabase: fail('DbTooNewError') }))).toEqual({
      ok: false,
      problem: 'too_new',
    });
    expect(
      await runStorageChecks(
        deps({ openDatabase: () => Promise.resolve({ ...healthy, quickCheck: 'row 3 missing' }) }),
      ),
    ).toEqual({
      ok: false,
      problem: 'damaged',
    });
    expect(
      await runStorageChecks(
        deps({ openDatabase: () => Promise.resolve({ ...healthy, outboxCount: null }) }),
      ),
    ).toEqual({
      ok: false,
      problem: 'outbox_unreadable',
    });
  });

  it('stop if the browser has no storage API at all', async () => {
    expect(await runStorageChecks(deps({ persisted: undefined, persist: undefined }))).toEqual({
      ok: false,
      problem: 'not_persistent',
    });
  });
});
