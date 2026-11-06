import { createChangeFeed } from '@erp/db';
import { enterContext, isRequestId, newRequestId } from '@erp/observability';
import Fastify, { type FastifyError, type FastifyServerOptions } from 'fastify';
import type pg from 'pg';

import { registerAdmin } from './admin/routes';
import { registerUsers } from './admin/users';
import { registerAuth } from './auth/routes';
import { registerCatalog } from './catalog/routes';
import { registerPurchasing } from './purchasing/routes';
import { registerDevices } from './devices/routes';
import { registerEvents } from './sync/events';
import { registerReports } from './reports/routes';
import { registerPush } from './sync/push';
import { registerSync } from './sync/routes';

export interface AppOptions extends FastifyServerOptions {
  // The image tag of this release (D-075); the deploy checks it after starting.
  version?: string;
  /** The app-role database pool (erp_app, D-078). Without it, only the health check is served. */
  pool?: pg.Pool;
  /** Injected clock, so session and lockout times can be tested. */
  now?: () => Date;
  /** Adds POST /api/_test/error, for checking error reporting end to end (staging only, W0-06). */
  testErrors?: boolean;
  /** Called with every unexpected error and its request ID (Sentry, D-086). */
  reportError?: (err: unknown, requestId: string) => void;
}

export function buildApp({
  version = 'dev',
  pool,
  now = () => new Date(),
  testErrors = false,
  reportError,
  ...options
}: AppOptions = {}) {
  // Behind Caddy (the only way in), so the client IP comes from X-Forwarded-For.
  const app = Fastify({
    trustProxy: true,
    // Request IDs are UUIDv7; a caller's is kept only if it is a UUID (architecture §11.2).
    genReqId: (req) => {
      const given = req.headers['x-request-id'];
      return isRequestId(given) ? given : newRequestId();
    },
    // The request ID comes from the context (one field, request_id), not Fastify's own reqId binding.
    childLoggerFactory: (logger, _bindings, opts) => logger.child({}, opts),
    ...options,
  });

  // Every log line and error of this request carries its ID; every response returns it (D-086).
  app.addHook('onRequest', (req, reply, done) => {
    enterContext({ requestId: req.id });
    void reply.header('x-request-id', req.id);
    done();
  });

  // Unexpected errors: logged and reported with the request ID; the caller gets only a reference.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err.statusCode !== undefined && err.statusCode < 500) return reply.send(err);
    req.log.error({ err }, 'unexpected error');
    reportError?.(err, req.id);
    return reply.code(500).send({ error: 'internal', reference: req.id });
  });

  if (testErrors) {
    app.post('/api/_test/error', () => {
      throw new Error('test error (W0-06)');
    });
  }

  // Used by the deploy health check (D-063).
  app.get('/api/health', () => ({ status: 'ok', version }));

  if (pool) {
    // Every /api route lives in this scope: cookies, the origin check and rate limits apply to all of them.
    void app.register(
      async (api) => {
        const requireAuth = await registerAuth(api, { pool, now });
        const requireDevice = registerDevices(api, { pool, now, requireAuth });
        registerSync(api, { pool, now, requireAuth, requireDevice });
        registerPush(api, { pool, now, requireDevice });
        // One LISTEN connection for every counter's SSE stream, opened by the first one (SYN-04).
        const feed = createChangeFeed(pool, { onError: (err) => api.log.warn({ err }, 'sync change feed') });
        api.addHook('onClose', () => feed.close());
        registerEvents(api, { feed, requireDevice });
        registerAdmin(api, { pool, requireAuth });
        registerUsers(api, { pool, now, requireAuth });
        registerReports(api, { pool, now, requireAuth });
        registerCatalog(api, { pool, now, requireAuth });
        registerPurchasing(api, { pool, now, requireAuth });
      },
      { prefix: '/api' },
    );
  }

  return app;
}
