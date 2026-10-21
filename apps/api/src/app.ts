import Fastify, { type FastifyServerOptions } from 'fastify';

export function buildApp(options: FastifyServerOptions = {}) {
  const app = Fastify(options);

  // Used by the deploy health check (D-063).
  app.get('/api/health', () => ({ status: 'ok' }));

  return app;
}
