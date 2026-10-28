import type pg from 'pg';

// The change feed behind the SSE nudge (sync spec §8, SYN-04, W1-07): one LISTEN connection on 'erp_sync', where the
// pulled tables' triggers (migration 0008) send the tenant id of every commit that changed them. Subscribers are told
// per tenant, at most once per `minIntervalMs` (a burst of changes is one nudge, sent at its start and its end).

export const SYNC_CHANNEL = 'erp_sync';

export interface ChangeFeed {
  /** Calls `fn` after commits that changed `tenantId`'s pulled data; returns the unsubscribe. */
  subscribe(tenantId: string, fn: () => void): () => void;
  close(): Promise<void>;
}

export function createChangeFeed(
  pool: pg.Pool,
  opts: { minIntervalMs?: number; retryMs?: number; onError?: (err: unknown) => void } = {},
): ChangeFeed {
  const minInterval = opts.minIntervalMs ?? 2000;
  const retry = opts.retryMs ?? 5000;
  const subscribers = new Map<string, Set<() => void>>();
  const lastSent = new Map<string, number>();
  const pending = new Map<string, NodeJS.Timeout>();
  let client: pg.PoolClient | null = null;
  let connecting: Promise<void> | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let closed = false;

  const fire = (tenantId: string) => {
    lastSent.set(tenantId, Date.now());
    for (const fn of subscribers.get(tenantId) ?? []) fn();
  };
  const notify = (tenantId: string) => {
    if (!subscribers.has(tenantId) || pending.has(tenantId)) return;
    const wait = (lastSent.get(tenantId) ?? 0) + minInterval - Date.now();
    if (wait <= 0) return fire(tenantId);
    pending.set(
      tenantId,
      setTimeout(() => {
        pending.delete(tenantId);
        fire(tenantId);
      }, wait),
    );
  };

  const connect = (): Promise<void> => {
    connecting ??= (async () => {
      try {
        const c = await pool.connect();
        c.on('notification', (n) => {
          if (n.channel === SYNC_CHANNEL && n.payload) notify(n.payload);
        });
        c.on('error', (err) => {
          opts.onError?.(err);
          c.release(err);
          client = null;
          reconnect();
        });
        await c.query(`LISTEN ${SYNC_CHANNEL}`);
        if (closed) {
          c.release();
          return;
        }
        client = c;
      } catch (err) {
        opts.onError?.(err);
        reconnect();
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  };
  // While the connection is down, counters fall back to polling (sync spec §4); nothing is lost.
  const reconnect = () => {
    if (closed || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, retry);
  };

  return {
    subscribe(tenantId, fn) {
      let set = subscribers.get(tenantId);
      if (!set) subscribers.set(tenantId, (set = new Set()));
      set.add(fn);
      if (!client) void connect();
      return () => {
        set.delete(fn);
        if (set.size === 0) subscribers.delete(tenantId);
      };
    },
    async close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
      subscribers.clear();
      await connecting;
      if (client) {
        const c = client;
        client = null;
        await c.query(`UNLISTEN ${SYNC_CHANNEL}`).catch(() => undefined);
        c.release();
      }
    },
  };
}
