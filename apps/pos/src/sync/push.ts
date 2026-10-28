import {
  PUSH_BATCH_MAX,
  PushResponseSchema,
  type DeviceHealth,
  type PushEvent,
  type PushRequest,
  type PushResult,
  type SeriesState,
} from '@erp/contracts';

import type { OutboxRow } from '../db/outbox';
import { DeviceRefusedError, type TokenSource } from '../device/session';
import { OfflineError, type Api, type ApiResponse } from '../net/api';

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

type Failure = Extract<PushOutcome, { ok: false }>;

/** Sends one request, renewing a refused token once (as pull does). */
async function send(deps: PushDeps, body: PushRequest): Promise<ApiResponse | Failure> {
  for (let renewed = false; ; renewed = true) {
    let res: ApiResponse;
    try {
      res = await deps.api('POST', '/api/sync/push', { body, token: await deps.tokens.get() });
    } catch (err) {
      if (err instanceof OfflineError) return { ok: false, reason: 'offline' };
      if (err instanceof DeviceRefusedError)
        return { ok: false, reason: err.revoked ? 'revoked' : 'refused' };
      throw err;
    }
    if (res.status !== 401) return res;
    if (renewed) return { ok: false, reason: 'refused' };
    deps.tokens.invalidate();
  }
}

/** Pushes until the outbox is empty (or the round limit); always at least once, so an empty outbox is the handshake. */
export async function pushAll(deps: PushDeps): Promise<PushOutcome> {
  const total = { accepted: 0, duplicate: 0, rejected: 0, requeued: 0 };
  let serverTime = '';
  for (let round = 0; round < (deps.maxRounds ?? 200); round++) {
    const rows = await deps.outbox.batch();
    // A row the finalize couldn't sign (POS spec §12) is signed now, and keeps its signature.
    for (const r of rows)
      if (r.signature === null) {
        r.signature = await deps.sign(r.payload);
        await deps.outbox.setSignature(r.id, r.signature);
      }
    const body: PushRequest = {
      clientVersion: deps.clientVersion,
      schemaVersion: deps.schemaVersion,
      deviceClock: deps.now().toISOString(),
      health: await deps.outbox.health(),
      documents: rows.map((r) => ({
        id: r.id,
        family: r.family,
        seq: r.seq,
        payload: r.payload,
        signature: r.signature,
      })),
      events: await deps.outbox.events(),
    };
    const res = await send(deps, body);
    if ('ok' in res) return res;
    const answer = PushResponseSchema.safeParse(res.body);
    if (res.status !== 200 || !answer.success) return { ok: false, reason: 'server' };
    const at = deps.now().toISOString();
    await deps.outbox.ack(answer.data.results, at);
    if (answer.data.events.length > 0) await deps.outbox.ackEvents(answer.data.events, at);
    for (const r of answer.data.results) total[r.status]++;
    serverTime = answer.data.serverTime;
    const requeued = await deps.outbox.requeue(answer.data.series);
    total.requeued += requeued;
    if (rows.length < PUSH_BATCH_MAX && requeued === 0) break;
  }
  return { ok: true, ...total, serverTime };
}

const FIRST_RETRY_MS = 2000;
const MAX_RETRY_MS = 5 * 60_000;

/** First retry after 2 s, doubling to 5 minutes, times a jitter of 50–100% (`random` in [0, 1)). */
export const backoffDelay = (attempt: number, random: number): number =>
  Math.round(Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** attempt) * (0.5 + random / 2));

export interface PushScheduler {
  /** Push now (after a finalize, on reconnect, on the 60-second timer); a push already running runs once more after. */
  trigger(): void;
  stop(): void;
}

/**
 * One push at a time. A failure that may pass (offline, a server error) retries with backoff; a refused or revoked
 * counter waits for the next trigger, since retrying can't help.
 */
export function createPushScheduler(deps: {
  run: () => Promise<PushOutcome>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  random?: () => number;
  onOutcome?: (outcome: PushOutcome) => void;
}): PushScheduler {
  const random = deps.random ?? Math.random;
  let running = false;
  let again = false;
  let stopped = false;
  let attempt = 0;
  let timer: unknown = null;
  const cancel = () => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  };
  const run = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    cancel();
    running = true;
    let outcome: PushOutcome;
    try {
      outcome = await deps.run();
    } catch {
      outcome = { ok: false, reason: 'server' };
    } finally {
      running = false;
    }
    deps.onOutcome?.(outcome);
    if (stopped) return;
    if (outcome.ok) attempt = 0;
    if (again) {
      again = false;
      return run();
    }
    if (!outcome.ok && (outcome.reason === 'offline' || outcome.reason === 'server'))
      timer = deps.setTimer(
        () => {
          timer = null;
          void run();
        },
        backoffDelay(attempt++, random()),
      );
  };
  return {
    trigger: () => {
      if (!stopped) void run();
    },
    stop: () => {
      stopped = true;
      cancel();
    },
  };
}
