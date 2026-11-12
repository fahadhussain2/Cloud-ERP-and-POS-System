import { describe, expect, it } from 'vitest';

import { OfflineError, type Api } from '../net/api';
import { changePin } from './pin';

// Choosing your own PIN at the counter (sync spec §5): the server's answers, as the screen needs them.

const tokens = { get: () => Promise.resolve('T'), invalidate: () => undefined };
const body = { userId: 'u1', currentPin: '4831', newPin: '7395' };
const reply =
  (status: number, b: unknown = null): Api =>
  () =>
    Promise.resolve({ status, body: b });

describe('changePin', () => {
  it('sends the temporary and the new PIN with the device token', async () => {
    let sent: unknown;
    const api: Api = (method, path, opts) => {
      sent = { method, path, ...opts };
      return Promise.resolve({ status: 204, body: null });
    };
    expect(await changePin({ api, tokens }, body)).toBe('ok');
    expect(sent).toEqual({ method: 'POST', path: '/api/sync/pin', body, token: 'T' });
  });

  it('maps every refusal to what the screen says', async () => {
    expect(
      await changePin({ api: reply(400, { error: 'weak_pin', problem: 'sequence' }), tokens }, body),
    ).toBe('weak_pin');
    expect(await changePin({ api: reply(401, { error: 'wrong_pin' }), tokens }, body)).toBe('wrong_pin');
    expect(await changePin({ api: reply(403, { error: 'pin_locked' }), tokens }, body)).toBe('pin_locked');
    expect(await changePin({ api: reply(409, { error: 'not_temporary' }), tokens }, body)).toBe('failed');
    expect(await changePin({ api: reply(401, { error: 'unauthenticated' }), tokens }, body)).toBe('failed');
    expect(await changePin({ api: () => Promise.reject(new OfflineError()), tokens }, body)).toBe('offline');
  });
});
