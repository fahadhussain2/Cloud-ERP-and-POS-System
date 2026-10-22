import { describe, expect, it } from 'vitest';

import { buildApp } from './app';

describe('GET /api/health', () => {
  it('returns ok and the running version', async () => {
    const app = buildApp({ version: 'abc123' });
    const res = await app.inject({ method: 'GET', url: '/api/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', version: 'abc123' });
    await app.close();
  });

  it('reports "dev" when no version is given', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });

    expect(res.json()).toEqual({ status: 'ok', version: 'dev' });
    await app.close();
  });
});
