import type { DeviceHealth, PushEvent, PushResult, SeriesState } from '@erp/contracts';

import type { OutboxRow } from '../db/outbox';
import type { TokenSource } from '../device/session';
import type { Api } from '../net/api';

// The counter's push loop (sync spec §6.2–§7, SYN-02, SYN-05, W1-07): the outbox in batches of 100 in sequence order,
// with the audit events and a health snapshot; unsigned rows signed first; the answer applied; what the server lacks
// put back and sent too. The scheduler runs it at once on finalize and reconnect, and retries with backoff.

export interface PushDeps {
  api: Api;
  tokens: TokenSource;
  outbox: {
    batch(): Promise<OutboxRow[]>;
    setSignature(id: string, signature: string): Promise<void>;
    ack(results: PushResult[], at: string): Promise<void>;
    requeue(series: SeriesState[]): Promise<number>;
    events(): Promise<PushEvent[]>;
    ackEvents(ids: string[], at: string): Promise<void>;
    health(): Promise<DeviceHealth>;
  };
  /** Signs canonicalJson(payload) with the device key (D-082). */
  sign(payload: unknown): Promise<string>;
  clientVersion: string;
  schemaVersion: number;
  now: () => Date;
  /** Stop after this many calls in one run (default 200: 20,000 documents). */
  maxRounds?: number;
}

export type PushOutcome =
  | { ok: true; accepted: number; duplicate: number; rejected: number; requeued: number; serverTime: string }
  | { ok: false; reason: 'offline' | 'refused' | 'revoked' | 'server' };

const notBuilt = (...args: unknown[]): never => {
  throw new Error(`not built yet (W1-07): ${args.length} arguments`);
};

/** Pushes until the outbox is empty (or the round limit); always at least once, so an empty outbox is the handshake. */
export function pushAll(deps: PushDeps): Promise<PushOutcome> {
  return notBuilt(deps);
}

/** First retry after 2 s, doubling to 5 minutes, times a jitter of 50–100% (`random` in [0, 1)). */
export function backoffDelay(attempt: number, random: number): number {
  return notBuilt(attempt, random);
}

export interface PushScheduler {
  /** Push now (after a finalize, on reconnect, on the 60-second timer); a push already running runs once more after. */
  trigger(): void;
  stop(): void;
}

export function createPushScheduler(deps: {
  run: () => Promise<PushOutcome>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  random?: () => number;
  onOutcome?: (outcome: PushOutcome) => void;
}): PushScheduler {
  return notBuilt(deps);
}
