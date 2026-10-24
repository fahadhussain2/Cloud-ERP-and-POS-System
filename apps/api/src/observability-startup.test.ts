import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { initSentry } from '@erp/observability';
import { startTracing } from '@erp/observability/tracing';
import { afterAll, describe, expect, it } from 'vitest';

import { buildApp } from './app';

// Bug (staging deploy, 2026-10-24): with OpenTelemetry and Sentry both on, Sentry's own Fastify integration added a
// second `opentelemetry` request decorator and the API crashed at startup. Tests had run with Sentry off.

// A local stand-in for Alloy, so exporting on shutdown has somewhere to go.
const sink = createServer((req, res) => req.resume().on('end', () => res.end('{}')));
await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
const sdk = startTracing({ service: 'erp-api', env: 'test', version: 'test' });
// A syntactically valid DSN; nothing is captured, so nothing is sent.
initSentry({ dsn: 'https://public@o0.ingest.de.sentry.io/0', app: 'api', env: 'test', version: 'test' });

afterAll(async () => {
  await sdk?.shutdown();
  await new Promise((resolve) => sink.close(resolve));
});

describe('the API with tracing and Sentry both on', () => {
  it('starts and answers its health check', async () => {
    const app = buildApp();
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
