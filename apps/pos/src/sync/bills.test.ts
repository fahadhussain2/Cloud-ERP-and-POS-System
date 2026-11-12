import { describe, expect, it, vi } from 'vitest';

import type { TokenSource } from '../device/session';
import { OfflineError, type Api, type ApiResponse } from '../net/api';
import { checkDesk, UNKNOWN } from './bills';

// The live cash desk check before a void (POS spec §18, W1-12): only a clear answer counts; anything else is unknown.

const tokens = () => {
  const t = { invalidated: 0, get: () => Promise.resolve('tok'), invalidate: () => void t.invalidated++ };
  return t satisfies TokenSource;
};
const answer =
  (res: ApiResponse): Api =>
  () =>
    Promise.resolve(res);
const body = (b: Record<string, unknown>) => ({
  known: true,
  status: 'finalized',
  handoverStatus: 'pending',
  handedOverAt: null,
  cashierName: null,
  ...b,
});

describe('the live cash desk check', () => {
  it('asks for the bill by number with the device token', async () => {
    const api = vi.fn<Api>(() => Promise.resolve({ status: 200, body: body({}) }));
    expect(await checkDesk({ api, tokens: tokens() }, 'C03-S000412')).toEqual({
      status: 'pending',
      at: null,
      cashierName: null,
    });
    expect(api).toHaveBeenCalledWith('GET', '/api/sync/bills/status?number=C03-S000412', { token: 'tok' });
  });

  it('says who took the cash and when', async () => {
    const res = body({
      handoverStatus: 'received',
      handedOverAt: '2026-11-03T09:05:00.000Z',
      cashierName: 'Ali',
    });
    expect(
      await checkDesk({ api: answer({ status: 200, body: res }), tokens: tokens() }, 'C03-S000412'),
    ).toEqual({
      status: 'received',
      at: '2026-11-03T09:05:00.000Z',
      cashierName: 'Ali',
    });
  });

  it('is unknown for a bill the server has nothing of, a refusal, a bad answer, offline, or no answer in time', async () => {
    const t = tokens();
    const none = body({ known: false, status: null, handoverStatus: null });
    expect(await checkDesk({ api: answer({ status: 200, body: none }), tokens: t }, 'C03-S1')).toEqual(
      UNKNOWN,
    );
    expect(await checkDesk({ api: answer({ status: 401, body: null }), tokens: t }, 'C03-S1')).toEqual(
      UNKNOWN,
    );
    expect(t.invalidated).toBe(1);
    expect(await checkDesk({ api: answer({ status: 200, body: { known: 'yes' } }), tokens: t }, 'x')).toEqual(
      UNKNOWN,
    );
    const offline: Api = () => Promise.reject(new OfflineError('offline'));
    expect(await checkDesk({ api: offline, tokens: t }, 'C03-S1')).toEqual(UNKNOWN);
    const never: Api = () => new Promise(() => undefined);
    expect(await checkDesk({ api: never, tokens: t }, 'C03-S1', 20)).toEqual(UNKNOWN);
  });
});
