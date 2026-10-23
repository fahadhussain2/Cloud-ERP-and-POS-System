import Fastify, { type FastifyServerOptions } from 'fastify';
import type pg from 'pg';

import { registerAuth } from './auth/routes';
import { registerDevices } from './devices/routes';

export interface AppOptions extends FastifyServerOptions {
  // The image tag of this release (D-075); the deploy checks it after starting.
  version?: string;
  /** The app-role database pool (erp_app, D-078). Without it, only the health check is served. */
  pool?: pg.Pool;
  /** Injected clock, so session and lockout times can be tested. */
  now?: () => Date;
}

export function buildApp({ version = 'dev', pool, now = () => new Date(), ...options }: AppOptions = {}) {
  // Behind Caddy (the only way in), so the client IP comes from X-Forwarded-For.
  const app = Fastify({ trustProxy: true, ...options });

  // Used by the deploy health check (D-063).
  app.get('/api/health', () => ({ status: 'ok', version }));

  if (pool) {
    // Every /api route lives in this scope: cookies, the origin check and rate limits apply to all of them.
    void app.register(
      async (api) => {
        const requireAuth = await registerAuth(api, { pool, now });
        registerDevices(api, { pool, now, requireAuth });
      },
      { prefix: '/api' },
    );
  }

  return app;
}
