export interface Job {
  name: string;
  run: () => Promise<void>;
}

// Background jobs (reconciliation, reports, reorder list, notifications) are registered here.
export const jobs: readonly Job[] = [];

// Keeps the worker running until stopped. The job queue replaces the idle timer in a later task.
export function startWorker(): () => Promise<void> {
  const idle = setInterval(() => undefined, 60_000);
  return () => {
    clearInterval(idle);
    return Promise.resolve();
  };
}
