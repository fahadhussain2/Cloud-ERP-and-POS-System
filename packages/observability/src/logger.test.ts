import { Writable } from 'node:stream';

import { context, trace, TraceFlags } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { describe, expect, it } from 'vitest';

import { setContext, withContext } from './context';
import { createLogger } from './logger';

// Logs (architecture §11.2, §11.7, D-086): JSON lines with the app, env, version and the request context; secrets
// never appear.

function capture() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, done) {
      for (const line of chunk.toString().split('\n').filter(Boolean))
        lines.push(JSON.parse(line) as Record<string, unknown>);
      done();
    },
  });
  const log = createLogger({ app: 'api', env: 'test', version: 'v1', destination });
  return { log, lines };
}

const SECRETS = [
  'hunter2-password',
  '1234',
  'pbkdf2$verifier',
  'tok-abc',
  'Bearer xyz',
  'erp_session=s3cret',
];

describe('redaction', () => {
  it('never writes a password, PIN, verifier, token, authorization header or cookie', () => {
    const { log, lines } = capture();
    log.info(
      {
        password: 'hunter2-password',
        pin: '1234',
        pinVerifier: 'pbkdf2$verifier',
        token: 'tok-abc',
        user: {
          password: 'hunter2-password',
          newPassword: 'hunter2-password',
          pin_verifier: 'pbkdf2$verifier',
        },
        body: { currentPassword: 'hunter2-password', deviceToken: 'tok-abc' },
        req: { headers: { authorization: 'Bearer xyz', cookie: 'erp_session=s3cret', host: 'app' } },
        res: { headers: { 'set-cookie': 'erp_session=s3cret' } },
      },
      'login',
    );
    const text = JSON.stringify(lines);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(lines[0]).toMatchObject({
      password: '[redacted]',
      user: { password: '[redacted]' },
      req: { headers: { host: 'app' } },
    });
  });
});

describe('every line', () => {
  it('carries the app, env and version, as JSON with an ISO time', () => {
    const { log, lines } = capture();
    log.info('started');
    expect(lines[0]).toMatchObject({ app: 'api', env: 'test', version: 'v1', msg: 'started', level: 'info' });
    expect(String(lines[0]!['time'])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('carries the request context inside withContext, and what setContext adds', () => {
    const { log, lines } = capture();
    withContext({ requestId: 'req-1', tenantId: 'tenant-1' }, () => {
      log.info('one');
      setContext({ userId: 'user-1', deviceId: 'device-1' });
      log.info('two');
    });
    log.info('outside');
    expect(lines[0]).toMatchObject({ request_id: 'req-1', tenant_id: 'tenant-1' });
    expect(lines[0]).not.toHaveProperty('user_id');
    expect(lines[1]).toMatchObject({
      request_id: 'req-1',
      tenant_id: 'tenant-1',
      user_id: 'user-1',
      device_id: 'device-1',
    });
    expect(lines[2]).not.toHaveProperty('request_id');
    expect(lines[2]).not.toHaveProperty('tenant_id');
  });

  it('keeps contexts apart across concurrent work', async () => {
    const { log, lines } = capture();
    await Promise.all(
      ['a', 'b'].map((id) =>
        withContext({ requestId: id }, async () => {
          await new Promise((r) => setTimeout(r, id === 'a' ? 5 : 0));
          log.info(id);
        }),
      ),
    );
    for (const l of lines) expect(l['request_id']).toBe(l['msg']);
  });
});

describe('traces', () => {
  it('a line logged inside a span carries its trace ID', () => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    const { log, lines } = capture();
    const span = trace.wrapSpanContext({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: TraceFlags.SAMPLED,
    });
    context.with(trace.setSpan(context.active(), span), () => log.info('inside'));
    log.info('outside');
    expect(lines[0]).toMatchObject({ trace_id: '0af7651916cd43dd8448eb211c80319c' });
    expect(lines[1]).not.toHaveProperty('trace_id');
    context.disable();
  });
});
