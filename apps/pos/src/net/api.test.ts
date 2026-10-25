import { describe, expect, it } from 'vitest';

import { httpApi, OfflineError } from './api';

// The counter's HTTP client: the device token goes in the scheme the API reads (platform spec §2).

describe('httpApi', () => {
  it('sends the device token as "Authorization: Device <token>", and JSON bodies', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const api = httpApi((url, init) => {
      seen = { url: url as string, init: init! };
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    });
    expect(await api('POST', '/api/sync/pin', { body: { a: 1 }, token: 'T.x' })).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(seen!.url).toBe('/api/sync/pin');
    expect(seen!.init.headers).toEqual({ authorization: 'Device T.x', 'content-type': 'application/json' });
    expect(seen!.init.body).toBe('{"a":1}');
  });

  it('turns a network failure into an OfflineError', async () => {
    const api = httpApi(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(api('GET', '/api/sync/pull')).rejects.toBeInstanceOf(OfflineError);
  });
});
