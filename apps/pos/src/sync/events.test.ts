import { describe, expect, it } from 'vitest';

import { openEventStream, SseParser } from './events';

// The counter's SSE reader (sync spec §8, SYN-04, W1-07): events parsed across chunk boundaries, the token renewed when
// refused, reconnects after a normal end and backoff after a failure.

describe('SseParser', () => {
  it('names each completed event, ignoring comments, and keeps a partial one for the next chunk', () => {
    const p = new SseParser();
    expect(p.push(': connected\n\n')).toEqual([]);
    expect(p.push('event: changes-avail')).toEqual([]);
    expect(p.push('able\ndata: {}\n\n: keep-alive\n\nevent: changes-available\r\ndata: {}\r\n\r\n')).toEqual([
      'changes-available',
      'changes-available',
    ]);
    expect(p.push('data: x\n\n')).toEqual(['message']);
  });
});

/** A fetch answering each call from `replies` in turn: a status and the chunks of its body. */
function fakeFetch(replies: { status: number; chunks?: string[] }[]) {
  const calls: { url: string; auth: string }[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>)['authorization']! });
    const r = replies.shift();
    if (!r) return new Promise(() => undefined);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of r.chunks ?? []) c.enqueue(new TextEncoder().encode(chunk));
        c.close();
      },
    });
    return Promise.resolve(new Response(r.status === 200 ? body : null, { status: r.status }));
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

function setup(replies: { status: number; chunks?: string[] }[], clock = { t: 0 }) {
  const { fetchFn, calls } = fakeFetch(replies);
  const events: string[] = [];
  const states: boolean[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let token = 'T1';
  let invalidated = 0;
  const stream = openEventStream({
    fetchFn,
    tokens: {
      get: () => Promise.resolve(token),
      invalidate: () => {
        invalidated++;
        token = 'T2';
      },
    },
    onEvent: (name) => events.push(name),
    onConnected: (c) => states.push(c),
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => undefined,
    random: () => 0.999999,
    now: () => clock.t,
  });
  return { stream, calls, events, states, timers, invalidated: () => invalidated, clock };
}

describe('openEventStream', () => {
  it('reads events with the device token and tells when it is connected', async () => {
    const s = setup([{ status: 200, chunks: [': connected\n\n', 'event: changes-available\ndata: {}\n\n'] }]);
    await settle();
    expect(s.calls[0]).toEqual({ url: '/api/sync/events', auth: 'Device T1' });
    expect(s.events).toEqual(['changes-available']);
    expect(s.states).toEqual([true, false]);
    s.stream.close();
  });

  it('renews a refused token and backs off before trying again', async () => {
    const s = setup([{ status: 401 }, { status: 200, chunks: [': connected\n\n'] }]);
    await settle();
    expect(s.invalidated()).toBe(1);
    expect(s.timers.map((t) => t.ms)).toEqual([2000]);
    s.timers[0]!.fn();
    await settle();
    expect(s.calls.map((c) => c.auth)).toEqual(['Device T1', 'Device T2']);
    s.stream.close();
  });

  it('reconnects at once after a stream that ran its course, and backs off after one that dropped at once', async () => {
    const clock = { t: 0 };
    const s = setup(
      [
        { status: 200, chunks: [': connected\n\n'] },
        { status: 200, chunks: [': connected\n\n'] },
      ],
      clock,
    );
    // The first stream "lasts" 15 minutes: the clock moves while it is open.
    clock.t = 15 * 60_000;
    await settle();
    expect(s.calls).toHaveLength(2);
    expect(s.timers).toHaveLength(1);
    s.stream.close();
  });
});
