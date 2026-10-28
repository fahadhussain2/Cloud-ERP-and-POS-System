import type {
  DeviceHealth,
  PushEvent,
  PushRequest,
  PushResponse,
  PushResult,
  SeriesState,
} from '@erp/contracts';
import { describe, expect, it } from 'vitest';

import type { OutboxRow } from '../db/outbox';
import { DeviceRefusedError } from '../device/session';
import { OfflineError, type Api, type ApiResponse } from '../net/api';
import { backoffDelay, createPushScheduler, pushAll, type PushDeps, type PushOutcome } from './push';

// The counter's push loop (sync spec §6.2–§7, SYN-02, SYN-05, W1-07), against a fake API and a fake outbox.

const id = (seq: number) => `019a3f6e-7b10-7c3a-9d2e-${String(seq).padStart(12, '0')}`;
const NOW = new Date('2026-11-02T10:15:31.000Z');
const row = (seq: number, signature: string | null = `sig${seq}`): OutboxRow => ({
  id: id(seq),
  family: 'S',
  seq,
  payload: { id: id(seq), seq },
  signature,
});
const HEALTH: DeviceHealth = {
  outboxCount: 0,
  oldestUnsyncedAt: null,
  quarantinedCount: 0,
  storagePersisted: true,
  storageUsage: 1,
  storageQuota: 2,
  lastPullAt: null,
};

/** The server accepts everything it is sent, unless `answer` says otherwise. */
const accepting =
  (series: SeriesState[] = []) =>
  (body: PushRequest): ApiResponse => ({
    status: 200,
    body: {
      serverTime: '2026-11-02T10:15:31.400Z',
      results: body.documents.map((d): PushResult => ({
        id: d.id,
        status: 'accepted',
        exceptions: [],
        error: null,
      })),
      series,
      events: body.events.map((e) => e.id),
    } satisfies PushResponse,
  });

function setup(opts: {
  /** Successive batches the outbox hands out; empty once they run out. */
  batches?: OutboxRow[][];
  events?: PushEvent[];
  replies?: ((body: PushRequest) => ApiResponse | Promise<ApiResponse>)[];
  requeued?: number[];
  tokenError?: Error;
  maxRounds?: number;
}) {
  const batches = [...(opts.batches ?? [])];
  const replies = [...(opts.replies ?? [])];
  const requeued = [...(opts.requeued ?? [])];
  const sent: PushRequest[] = [];
  const tokensUsed: string[] = [];
  const acked: [PushResult[], string][] = [];
  const eventsAcked: string[][] = [];
  const signatures: [string, string][] = [];
  const seriesSeen: SeriesState[][] = [];
  let token = 'T1';
  let invalidated = 0;
  const api: Api = async (method, path, o) => {
    expect([method, path]).toEqual(['POST', '/api/sync/push']);
    tokensUsed.push(o!.token!);
    const body = o!.body as PushRequest;
    sent.push(structuredClone(body));
    const reply = replies.shift() ?? accepting();
    return reply(body);
  };
  const deps: PushDeps = {
    api,
    tokens: {
      get: () => (opts.tokenError ? Promise.reject(opts.tokenError) : Promise.resolve(token)),
      invalidate: () => {
        invalidated++;
        token = 'T2';
      },
    },
    outbox: {
      batch: () => Promise.resolve(batches.shift() ?? []),
      setSignature: (docId, signature) => {
        signatures.push([docId, signature]);
        return Promise.resolve();
      },
      ack: (results, at) => {
        acked.push([results, at]);
        return Promise.resolve();
      },
      requeue: (series) => {
        seriesSeen.push(series);
        return Promise.resolve(requeued.shift() ?? 0);
      },
      events: () => Promise.resolve(opts.events ?? []),
      ackEvents: (ids) => {
        eventsAcked.push(ids);
        return Promise.resolve();
      },
      health: () => Promise.resolve(HEALTH),
    },
    sign: (payload) => Promise.resolve(`signed:${(payload as { seq: number }).seq}`),
    clientVersion: '0.7.0',
    schemaVersion: 6,
    now: () => NOW,
    ...(opts.maxRounds === undefined ? {} : { maxRounds: opts.maxRounds }),
  };
  return {
    deps,
    sent,
    tokensUsed,
    acked,
    eventsAcked,
    signatures,
    seriesSeen,
    invalidated: () => invalidated,
  };
}

describe('pushAll', () => {
  it('sends the batch in order with the versions, the clock, the health and the events, then applies the answer', async () => {
    const events: PushEvent[] = [
      { id: id(900), kind: 'pin.locked', at: '2026-11-02T09:00:00.000Z', userId: 'u1' },
    ];
    const s = setup({ batches: [[row(1), row(2)]], events });
    expect(await pushAll(s.deps)).toEqual({
      ok: true,
      accepted: 2,
      duplicate: 0,
      rejected: 0,
      requeued: 0,
      serverTime: '2026-11-02T10:15:31.400Z',
    });
    expect(s.sent[0]).toEqual({
      clientVersion: '0.7.0',
      schemaVersion: 6,
      deviceClock: NOW.toISOString(),
      health: HEALTH,
      documents: [
        { id: id(1), family: 'S', seq: 1, payload: { id: id(1), seq: 1 }, signature: 'sig1' },
        { id: id(2), family: 'S', seq: 2, payload: { id: id(2), seq: 2 }, signature: 'sig2' },
      ],
      events,
    });
    expect(s.acked).toEqual([
      [
        [
          { id: id(1), status: 'accepted', exceptions: [], error: null },
          { id: id(2), status: 'accepted', exceptions: [], error: null },
        ],
        NOW.toISOString(),
      ],
    ]);
    expect(s.eventsAcked).toEqual([[id(900)]]);
  });

  it('with an empty outbox still sends once: the start-up handshake', async () => {
    const s = setup({});
    expect(await pushAll(s.deps)).toMatchObject({ ok: true, accepted: 0 });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.documents).toEqual([]);
  });

  it('signs an unsigned row before sending it, and keeps the signature', async () => {
    const s = setup({ batches: [[row(1), row(2, null)]] });
    await pushAll(s.deps);
    expect(s.signatures).toEqual([[id(2), 'signed:2']]);
    expect(s.sent[0]!.documents.map((d) => d.signature)).toEqual(['sig1', 'signed:2']);
  });

  it('keeps going while batches are full, and stops after a short one', async () => {
    const full = Array.from({ length: 100 }, (_, i) => row(i + 1));
    const s = setup({ batches: [full, [row(101)]] });
    expect(await pushAll(s.deps)).toMatchObject({ ok: true, accepted: 101 });
    expect(s.sent.map((b) => b.documents.length)).toEqual([100, 1]);
  });

  it('counts each status, and carries on past a rejected document', async () => {
    const s = setup({
      batches: [[row(1), row(2), row(3)]],
      replies: [
        () => ({
          status: 200,
          body: {
            serverTime: '2026-11-02T10:15:31.400Z',
            results: [
              { id: id(1), status: 'duplicate', exceptions: [], error: null },
              { id: id(2), status: 'rejected', exceptions: [], error: 'bad_schema' },
              { id: id(3), status: 'accepted', exceptions: ['below_floor_no_override'], error: null },
            ],
            series: [],
            events: [],
          } satisfies PushResponse,
        }),
      ],
    });
    expect(await pushAll(s.deps)).toMatchObject({ ok: true, accepted: 1, duplicate: 1, rejected: 1 });
    expect(s.acked[0]![0].map((r) => r.status)).toEqual(['duplicate', 'rejected', 'accepted']);
  });

  it('hands every answer’s series to re-queue, and pushes again what was put back (SYN-05)', async () => {
    const series: SeriesState[] = [{ family: 'S', through: 0, missing: [] }];
    const s = setup({ batches: [[], [row(1), row(2)]], replies: [accepting(series)], requeued: [2, 0] });
    expect(await pushAll(s.deps)).toMatchObject({ ok: true, accepted: 2, requeued: 2 });
    expect(s.seriesSeen[0]).toEqual(series);
    expect(s.sent.map((b) => b.documents.map((d) => d.seq))).toEqual([[], [1, 2]]);
  });

  it('stops after the round limit even if the server keeps asking for more', async () => {
    const s = setup({ requeued: [1, 1, 1, 1, 1, 1], maxRounds: 3 });
    expect(await pushAll(s.deps)).toMatchObject({ ok: true });
    expect(s.sent).toHaveLength(3);
  });

  it('gets a new device token once when the old one is refused', async () => {
    const s = setup({ batches: [[row(1)]], replies: [() => ({ status: 401, body: {} })] });
    expect(await pushAll(s.deps)).toMatchObject({ ok: true, accepted: 1 });
    expect(s.tokensUsed).toEqual(['T1', 'T2']);
    expect(s.invalidated()).toBe(1);
  });

  it('stops without applying anything when offline, refused twice, revoked or the server fails', async () => {
    const offline = setup({ batches: [[row(1)]], replies: [() => Promise.reject(new OfflineError())] });
    expect(await pushAll(offline.deps)).toEqual({ ok: false, reason: 'offline' });
    expect(offline.acked).toEqual([]);

    const refused = setup({
      batches: [[row(1)]],
      replies: [() => ({ status: 401, body: {} }), () => ({ status: 401, body: {} })],
    });
    expect(await pushAll(refused.deps)).toEqual({ ok: false, reason: 'refused' });

    const failing = setup({ batches: [[row(1)]], replies: [() => ({ status: 500, body: {} })] });
    expect(await pushAll(failing.deps)).toEqual({ ok: false, reason: 'server' });
    expect(failing.acked).toEqual([]);

    const revokedError = Object.assign(new DeviceRefusedError('challenge refused'), { revoked: true });
    const revoked = setup({ batches: [[row(1)]], tokenError: revokedError });
    expect(await pushAll(revoked.deps)).toEqual({ ok: false, reason: 'revoked' });

    const notEnrolled = setup({ batches: [[row(1)]], tokenError: new DeviceRefusedError('not enrolled') });
    expect(await pushAll(notEnrolled.deps)).toEqual({ ok: false, reason: 'refused' });
  });
});

describe('backoffDelay', () => {
  it('starts at 2 s, doubles, stops at 5 minutes, with 50–100% jitter', () => {
    expect(backoffDelay(0, 0.999999)).toBe(2000);
    expect(backoffDelay(0, 0)).toBe(1000);
    expect(backoffDelay(1, 0.999999)).toBe(4000);
    expect(backoffDelay(3, 0.999999)).toBe(16000);
    expect(backoffDelay(7, 0.999999)).toBe(256000);
    expect(backoffDelay(8, 0.999999)).toBe(300000);
    expect(backoffDelay(30, 0)).toBe(150000);
  });
});

describe('the push scheduler', () => {
  const failed: PushOutcome = { ok: false, reason: 'offline' };
  const done: PushOutcome = {
    ok: true,
    accepted: 1,
    duplicate: 0,
    rejected: 0,
    requeued: 0,
    serverTime: NOW.toISOString(),
  };

  function scheduler(outcomes: PushOutcome[]) {
    const timers: { fn: () => void; ms: number; state: 'waiting' | 'fired' | 'cleared' }[] = [];
    let runs = 0;
    const s = createPushScheduler({
      run: async () => {
        runs++;
        await Promise.resolve();
        return outcomes.shift() ?? done;
      },
      setTimer: (fn, ms) => {
        const t = { fn, ms, state: 'waiting' as const };
        timers.push(t);
        return t;
      },
      clearTimer: (h) => {
        (h as { state: string }).state = 'cleared';
      },
      random: () => 0.999999,
    });
    const settle = async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    };
    const waiting = () => timers.filter((t) => t.state === 'waiting');
    /** Lets the one waiting retry timer go off. */
    const fire = async () => {
      const [t] = waiting();
      expect(t, 'a retry is waiting').toBeDefined();
      t!.state = 'fired';
      t!.fn();
      await settle();
    };
    return { s, runs: () => runs, waiting, settle, fire };
  }

  it('pushes at once on a trigger and sets no timer after a success', async () => {
    const t = scheduler([done]);
    t.s.trigger();
    await t.settle();
    expect(t.runs()).toBe(1);
    expect(t.waiting()).toEqual([]);
  });

  it('retries a failure after a growing delay, and a success resets it', async () => {
    const t = scheduler([failed, failed, done, failed]);
    t.s.trigger();
    await t.settle();
    expect(t.waiting().map((x) => x.ms)).toEqual([2000]);
    await t.fire();
    expect(t.waiting().map((x) => x.ms)).toEqual([4000]);
    await t.fire();
    expect(t.waiting()).toEqual([]);
    t.s.trigger();
    await t.settle();
    expect(t.waiting().map((x) => x.ms)).toEqual([2000]);
    expect(t.runs()).toBe(4);
  });

  it('a trigger while waiting to retry pushes at once and cancels the timer', async () => {
    const t = scheduler([failed, done]);
    t.s.trigger();
    await t.settle();
    const [retry] = t.waiting();
    t.s.trigger();
    await t.settle();
    expect(retry!.state).toBe('cleared');
    expect(t.runs()).toBe(2);
    expect(t.waiting()).toEqual([]);
  });

  it('a trigger during a push runs one more push after it, never two at once', async () => {
    const t = scheduler([done, done, done]);
    t.s.trigger();
    t.s.trigger();
    t.s.trigger();
    await t.settle();
    expect(t.runs()).toBe(2);
  });

  it('does not retry by itself when the counter is revoked or refused; stop cancels a retry', async () => {
    const t = scheduler([{ ok: false, reason: 'revoked' }, { ok: false, reason: 'refused' }, failed]);
    t.s.trigger();
    await t.settle();
    t.s.trigger();
    await t.settle();
    expect(t.waiting()).toEqual([]);
    t.s.trigger();
    await t.settle();
    const [retry] = t.waiting();
    t.s.stop();
    expect(retry!.state).toBe('cleared');
  });
});
