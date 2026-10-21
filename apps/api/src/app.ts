import Fastify, { type FastifyServerOptions } from 'fastify';

export interface AppOptions extends FastifyServerOptions {
  // The image tag of this release (D-075); the deploy checks it after starting.
  version?: string;
}

export function buildApp({ version = 'dev', ...options }: AppOptions = {}) {
  const app = Fastify(options);

  // Used by the deploy health check (D-063).
  // TEMP rehearsal (W0-04): an unhealthy release. Never merged.
  app.get('/api/health', (_request, reply) => reply.code(500).send({ status: 'broken', version }));

  return app;
}
