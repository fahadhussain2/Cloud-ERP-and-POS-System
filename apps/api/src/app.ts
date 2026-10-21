import Fastify, { type FastifyServerOptions } from 'fastify';

export interface AppOptions extends FastifyServerOptions {
  // The image tag of this release (D-075); the deploy checks it after starting.
  version?: string;
}

export function buildApp({ version = 'dev', ...options }: AppOptions = {}) {
  const app = Fastify(options);

  // Used by the deploy health check (D-063).
  app.get('/api/health', () => ({ status: 'ok', version }));

  return app;
}
