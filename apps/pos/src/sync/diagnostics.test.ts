import { describe, expect, it } from 'vitest';

import { OfflineError, type Api } from '../net/api';
import { scrub, sendDiagnostics } from './diagnostics';

// Send diagnostics (PLT-12, owner answer 6 to W1-20): the counter's log leaves it only scrubbed of personal data and
// secrets (a walk-in's phone, a PIN, a token), sent by a manager the server checks again.

describe('scrubbing the log', () => {
  it('drops phones, PINs, passwords and tokens at any depth, and keeps the rest', () => {
    expect(
      scrub({
        number: 'S-C1-000012',
        walkinPhone: '03001234567',
        bill: { lines: 2, customer: { phones: ['0300'], name: 'Rehman Autos' } },
        pin: '1234',
        accessToken: 'abc',
        password: 'x',
        list: [{ phone: '1' }, { qty: 3 }],
      }),
    ).toEqual({
      number: 'S-C1-000012',
      bill: { lines: 2, customer: { name: 'Rehman Autos' } },
      list: [{}, { qty: 3 }],
    });
  });

  it('leaves plain values alone', () => {
    expect(scrub('text')).toBe('text');
    expect(scrub(7)).toBe(7);
    expect(scrub(null)).toBeNull();
  });
});

describe('sending', () => {
  const deps = (answer: { status: number; body: unknown } | Error) => {
    const sent: unknown[] = [];
    return {
      sent,
      deps: {
        api: ((_m, _p, opts) => {
          sent.push(opts?.body);
          return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
        }) as Api,
        tokens: { get: () => Promise.resolve('token'), invalidate: () => undefined },
        log: () =>
          Promise.resolve([
            {
              at: '2026-11-10T10:00:00.000Z',
              kind: 'bill.set_aside',
              detail: '{"walkinPhone":"0300","n":1}',
            },
          ]),
        health: () => Promise.resolve({ outboxCount: 0 }),
        now: () => new Date('2026-11-10T10:05:00.000Z'),
      },
    };
  };

  it('sends the scrubbed log with who sent it', async () => {
    const d = deps({ status: 201, body: { id: 'x' } });
    expect(await sendDiagnostics(d.deps, 'manager-1')).toBe('sent');
    expect(d.sent[0]).toEqual({
      sentByUserId: 'manager-1',
      atDevice: '2026-11-10T10:05:00.000Z',
      health: { outboxCount: 0 },
      events: [{ at: '2026-11-10T10:00:00.000Z', kind: 'bill.set_aside', detail: { n: 1 } }],
    });
  });

  it('says offline, or not allowed, as the server answers', async () => {
    expect(await sendDiagnostics(deps(new OfflineError()).deps, 'm')).toBe('offline');
    expect(await sendDiagnostics(deps({ status: 403, body: { error: 'not_permitted' } }).deps, 'm')).toBe(
      'not_permitted',
    );
    expect(await sendDiagnostics(deps({ status: 500, body: null }).deps, 'm')).toBe('failed');
  });
});
