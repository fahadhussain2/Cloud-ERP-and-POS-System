import { describe, expect, it } from 'vitest';

import { scrubEvent } from './sentry';

// Sentry events never carry cookies, authorization headers or request bodies (architecture §11.7, D-086).
describe('scrubEvent', () => {
  it('removes cookies, credential headers and the request body, and keeps the rest', () => {
    const event = scrubEvent({
      message: 'boom',
      tags: { request_id: 'r1' },
      request: {
        url: 'https://app.example.test/api/auth/login',
        method: 'POST',
        cookies: { erp_session: 's3cret' },
        data: { password: 'hunter2' },
        headers: {
          authorization: 'Device x.y',
          cookie: 'erp_session=s3cret',
          'user-agent': 'ua',
          'x-request-id': 'r1',
        },
      },
    });
    expect(event).toEqual({
      message: 'boom',
      tags: { request_id: 'r1' },
      request: {
        url: 'https://app.example.test/api/auth/login',
        method: 'POST',
        headers: { 'user-agent': 'ua', 'x-request-id': 'r1' },
      },
    });
  });

  it('leaves an event without a request alone', () => {
    expect(scrubEvent({ message: 'x' })).toEqual({ message: 'x' });
  });
});
