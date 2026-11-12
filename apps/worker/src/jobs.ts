import { pruneDiagnostics } from '@erp/db';
import { postPending } from '@erp/posting';
import type pg from 'pg';

export interface Job {
  name: string;
  /** Runs once at start-up, then this long after each run ends (never two runs of one job at once). */
  everyMs: number;
  run: () => Promise<void>;
}

export interface JobLog {
  info: (fields: object, message: string) => void;
  warn: (fields: object, message: string) => void;
  error: (fields: object, message: string) => void;
}

/**
 * The catch-up (W1-08): posts every accepted document no push could post (a payment method without an account, a
 * bug since fixed), shop by shop, oldest first. The documents already accepted before W1-08 are posted on the first run.
 */
export function postingCatchUp(pool: pg.Pool, log: JobLog, now: () => Date = () => new Date()): Job {
  return {
    name: 'posting-catch-up',
    everyMs: 60_000,
    run: async () => {
      const shops = await pool.query<{ code: string; tenant_id: string }>(
        'SELECT code, tenant_id FROM erp.tenant_directory ORDER BY code',
      );
      for (const shop of shops.rows) {
        const { posted, failed } = await postPending(pool, shop.tenant_id, { now });
        if (failed > 0) log.warn({ shop: shop.code, posted, failed }, 'posting.pending');
        else if (posted > 0) log.info({ shop: shop.code, posted }, 'posting.pending');
      }
    },
  };
}

/** A counter's diagnostics are kept 30 days (owner answer 6 to W1-20, D-110): removed shop by shop, every 6 hours. */
export function diagnosticsPrune(pool: pg.Pool, log: JobLog, now: () => Date = () => new Date()): Job {
  return {
    name: 'diagnostics-prune',
    everyMs: 6 * 60 * 60_000,
    run: async () => {
      const shops = await pool.query<{ code: string; tenant_id: string }>(
        'SELECT code, tenant_id FROM erp.tenant_directory ORDER BY code',
      );
      for (const shop of shops.rows) {
        const removed = await pruneDiagnostics(pool, shop.tenant_id, now());
        if (removed > 0) log.info({ shop: shop.code, removed }, 'diagnostics.pruned');
      }
    },
  };
}

/** Background jobs (reconciliation, reports, reorder list, notifications) are registered here. */
export function jobsFor(deps: { pool: pg.Pool | undefined; log: JobLog }): Job[] {
  return deps.pool ? [postingCatchUp(deps.pool, deps.log), diagnosticsPrune(deps.pool, deps.log)] : [];
}

/** Runs the jobs until stopped. A failing run is reported and the job carries on at its next turn. */
export function startWorker(
  jobs: readonly Job[],
  onError: (job: Job, err: unknown) => void,
): () => Promise<void> {
  // Keeps the process alive even with no jobs.
  const idle = setInterval(() => undefined, 60_000);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const running = new Set<Promise<void>>();
  let stopped = false;
  const turn = (job: Job) => {
    const run = job
      .run()
      .catch((err: unknown) => onError(job, err))
      .finally(() => {
        running.delete(run);
        if (stopped) return;
        const t = setTimeout(() => {
          timers.delete(t);
          turn(job);
        }, job.everyMs);
        timers.add(t);
      });
    running.add(run);
  };
  for (const job of jobs) turn(job);
  return async () => {
    stopped = true;
    clearInterval(idle);
    for (const t of timers) clearTimeout(t);
    await Promise.all(running);
  };
}
