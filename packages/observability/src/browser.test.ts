import { describe, expect, it } from 'vitest';

import { envFromHost } from './browser';

// The web image is built once and served on both environments (D-075), so the browser tells them apart by host.
describe('envFromHost', () => {
  it.each([
    ['app.zorbixtechnologies.com', 'prod'],
    ['pos.zorbixtechnologies.com', 'prod'],
    ['staging-app.zorbixtechnologies.com', 'staging'],
    ['staging-pos.zorbixtechnologies.com', 'staging'],
    ['localhost', 'dev'],
    ['127.0.0.1', 'dev'],
  ])('%s is %s', (host, env) => expect(envFromHost(host)).toBe(env));
});
