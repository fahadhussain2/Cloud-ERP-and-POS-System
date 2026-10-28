import { SYNC_EVENTS } from '@erp/contracts';
import type { ChangeFeed } from '@erp/db';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';

// The SSE nudge (sync spec §8, SYN-04, W1-07): `GET /api/sync/events` with the device token streams
// `changes-available` after any commit to a pulled table of the device's tenant; the counter then pulls. The stream
// ends when the 15-minute device token would, and the counter reconnects with a new one. W1-10 adds `queue-changed`.

interface Deps {
  feed: ChangeFeed;
  requireDevice: preHandlerAsyncHookHandler;
}

/** Comments keep proxies (Caddy) from closing an idle stream. */
const KEEP_ALIVE_MS = 25_000;
/** The device token's life (platform spec §2). */
const STREAM_MS = 15 * 60_000;

export function registerEvents(scope: FastifyInstance, { feed, requireDevice }: Deps) {
  const open = new Set<() => void>();
  // Open streams end first, so the server can close.
  scope.addHook('preClose', (done) => {
    for (const end of [...open]) end();
    done();
  });

  scope.get('/sync/events', { preHandler: requireDevice }, (req, reply) => {
    const d = req.device!;
    void reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-request-id': req.id,
    });
    // The opening comment tells the counter it is connected.
    res.write(': connected\n\n');
    const unsubscribe = feed.subscribe(d.tenantId, () =>
      res.write(`event: ${SYNC_EVENTS.changesAvailable}\ndata: {}\n\n`),
    );
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), KEEP_ALIVE_MS);
    const end = () => {
      if (!open.delete(end)) return;
      clearInterval(keepAlive);
      clearTimeout(expiry);
      unsubscribe();
      res.end();
    };
    const expiry = setTimeout(end, STREAM_MS);
    open.add(end);
    req.raw.on('close', end);
    req.log.info({ deviceId: d.deviceId }, 'sync.events.open');
  });
}
