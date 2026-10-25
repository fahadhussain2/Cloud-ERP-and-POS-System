// The start-up safeguards (POS spec §3, D-010, D-089). Each failure is one stop screen; selling waits for all.

export interface DatabaseHealth {
  schemaVersion: number;
  /** `PRAGMA quick_check`: 'ok' when the file is sound. */
  quickCheck: string;
  /** null when the outbox couldn't be read. */
  outboxCount: number | null;
}

export type StorageProblem = 'not_persistent' | 'unavailable' | 'too_new' | 'damaged' | 'outbox_unreadable';

export interface CheckDeps {
  /** navigator.storage.persisted / persist; missing when the browser has no storage API. */
  persisted: (() => Promise<boolean>) | undefined;
  persist: (() => Promise<boolean>) | undefined;
  /** Opens the database in its worker, runs the migrations and reports its health. */
  openDatabase: () => Promise<DatabaseHealth>;
}

export type CheckResult = { ok: true; health: DatabaseHealth } | { ok: false; problem: StorageProblem };

export async function runStorageChecks(deps: CheckDeps): Promise<CheckResult> {
  if (!deps.persisted || !deps.persist) return { ok: false, problem: 'not_persistent' };
  // Ask once; Chrome grants it to an installed app (the counter setup installs the PWA).
  if (!(await deps.persisted()) && !(await deps.persist())) return { ok: false, problem: 'not_persistent' };
  let health: DatabaseHealth;
  try {
    health = await deps.openDatabase();
  } catch (err) {
    return { ok: false, problem: (err as Error).name === 'DbTooNewError' ? 'too_new' : 'unavailable' };
  }
  if (health.quickCheck !== 'ok') return { ok: false, problem: 'damaged' };
  if (health.outboxCount === null) return { ok: false, problem: 'outbox_unreadable' };
  return { ok: true, health };
}

/** The real browser dependencies. */
export const browserStorage = (): Pick<CheckDeps, 'persisted' | 'persist'> => {
  const s = typeof navigator === 'undefined' ? undefined : navigator.storage;
  return {
    persisted: s?.persisted ? () => s.persisted() : undefined,
    persist: s?.persist ? () => s.persist() : undefined,
  };
};
