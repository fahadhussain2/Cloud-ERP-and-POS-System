import type pg from 'pg';

// The change feed behind the SSE nudge (sync spec §8, SYN-04, W1-07): one LISTEN connection on 'erp_sync', where the
// pulled tables' triggers (migration 0008) send the tenant id of every commit that changed them. Subscribers are told
// per tenant, at most once per `minIntervalMs` (a burst of changes is one nudge, sent at its start and its end).
// The cash queue (W1-10, migration 0011) has its own channel, 'erp_queue', with '<tenant>:<branch>': its subscribers
// use `queueKey`, so a bill wakes only that branch's cash desks.

export const SYNC_CHANNEL = 'erp_sync';
export const QUEUE_CHANNEL = 'erp_queue';

/** The key to subscribe to for a branch's cash queue. */
export const queueKey = (tenantId: string, branchId: string) => `queue:${tenantId}:${branchId}`;

export interface ChangeFeed {
  /**
   * Calls `fn` after commits that changed `key`'s data: a tenant id for its pulled data, or `queueKey(...)` for a
   * branch's cash queue. Returns the unsubscribe.
   */
  subscribe(key: string, fn: () => void): () => void;
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
  let client: { connection: pg.PoolClient; release: (err?: Error) => void } | null = null;
  let connecting: Promise<void> | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let closed = false;

  const fire = (key: string) => {
    lastSent.set(key, Date.now());
    for (const fn of subscribers.get(key) ?? []) fn();
  };
  const notify = (key: string) => {
    if (!subscribers.has(key) || pending.has(key)) return;
    const wait = (lastSent.get(key) ?? 0) + minInterval - Date.now();
    if (wait <= 0) return fire(key);
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        fire(key);
      }, wait),
    );
  };

  const connect = (): Promise<void> => {
    connecting ??= (async () => {
      try {
        const c = await pool.connect();
        const onNotification = (n: pg.Notification) => {
          if (!n.payload) return;
          if (n.channel === SYNC_CHANNEL) notify(n.payload);
          else if (n.channel === QUEUE_CHANNEL) notify(`queue:${n.payload}`);
        };
        // Once handed back, the connection is the pool's: the listeners go with the release, and it happens once.
        let released = false;
        const release = (err?: Error) => {
          if (released) return;
          released = true;
          c.off('notification', onNotification);
          c.off('error', onError);
          c.release(err);
        };
        const onError = (err: Error) => {
          opts.onError?.(err);
          release(err);
          if (client?.connection === c) client = null;
          reconnect();
        };
        c.on('notification', onNotification);
        c.on('error', onError);
        await c.query(`LISTEN ${SYNC_CHANNEL}`);
        await c.query(`LISTEN ${QUEUE_CHANNEL}`);
        if (closed) {
          release();
          return;
        }
        client = { connection: c, release };
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
    subscribe(key, fn) {
      let set = subscribers.get(key);
      if (!set) subscribers.set(key, (set = new Set()));
      set.add(fn);
      if (!client) void connect();
      return () => {
        set.delete(fn);
        if (set.size === 0) subscribers.delete(key);
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
        await c.connection.query('UNLISTEN *').catch(() => undefined);
        c.release();
      }
    },
  };
}
