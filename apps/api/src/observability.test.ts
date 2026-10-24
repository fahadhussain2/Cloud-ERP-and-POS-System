import { Writable } from 'node:stream';

import { createLogger } from '@erp/observability';
import { describe, expect, it } from 'vitest';

import { buildApp } from './app';

// Request IDs and error references (architecture §11.2, D-086).

function capturingApp(opts: { testErrors?: boolean } = {}) {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, done) {
      for (const line of chunk.toString().split('\n').filter(Boolean))
        lines.push(JSON.parse(line) as Record<string, unknown>);
      done();
    },
  });
  const app = buildApp({
    loggerInstance: createLogger({ app: 'api', env: 'test', version: 'v1', destination }),
    ...opts,
  });
  return { app, lines };
}

describe('request IDs', () => {
  it('every response has one, a UUIDv7', async () => {
    const { app } = capturingApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
  });

  it("keeps a caller's valid ID and replaces an invalid one", async () => {
    const { app } = capturingApp();
    const id = '0192f1a0-0000-7000-8000-00000000e2e0';
    const kept = await app.inject({ method: 'GET', url: '/api/health', headers: { 'x-request-id': id } });
    expect(kept.headers['x-request-id']).toBe(id);
    const replaced = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-request-id': 'evil\nline' },
    });
    expect(replaced.headers['x-request-id']).not.toContain('evil');
  });
});

describe('an unexpected error', () => {
  it('answers 500 with only a reference, and logs the error with the same request ID', async () => {
    const { app, lines } = capturingApp({ testErrors: true });
    const res = await app.inject({ method: 'POST', url: '/api/_test/error' });
    expect(res.statusCode).toBe(500);
    const reference = res.headers['x-request-id'];
    expect(res.json()).toEqual({ error: 'internal', reference });
    const logged = lines.find((l) => l['level'] === 'error');
    expect(logged).toMatchObject({ request_id: reference, err: { message: 'test error (W0-06)' } });
  });

  it('has no test route unless asked for (staging only)', async () => {
    const { app } = capturingApp();
    expect((await app.inject({ method: 'POST', url: '/api/_test/error' })).statusCode).toBe(404);
  });
});
