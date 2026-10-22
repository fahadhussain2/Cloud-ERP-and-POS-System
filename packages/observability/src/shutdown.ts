import type { EventEmitter } from 'node:events';

export interface ShutdownOptions {
  signals?: readonly NodeJS.Signals[];
  target?: Pick<EventEmitter, 'once'>;
  exit?: (code: number) => void;
}

// Runs `handler` once on the first stop signal (Docker sends SIGTERM on deploy), then exits.
// Later this also flushes logs and Sentry before exit (W0-06).
export function onShutdown(handler: () => Promise<void>, options: ShutdownOptions = {}): void {
  const { signals = ['SIGTERM', 'SIGINT'], target = process, exit = (code) => process.exit(code) } = options;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    handler().then(
      () => exit(0),
      () => exit(1),
    );
  };
  for (const signal of signals) target.once(signal, stop);
}
