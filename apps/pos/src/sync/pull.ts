import { PULL_DATASETS, PULL_LIMIT_MAX, type PullResponse } from '@erp/contracts';

import { DeviceRefusedError, type TokenSource } from '../device/session';
import { OfflineError, type Api } from '../net/api';

// The counter's pull loop (sync spec §2, §4): page by page from the stored cursor; each page is applied together
// with its cursor (one local transaction, repo.applyPull), so a crash never leaves the cursor ahead of the data. Full
// pages (the first catalog load is ~125k rows, W1-03), and the last page says the pull is complete.

export interface PullDeps {
  api: Api;
  tokens: TokenSource;
  cursor: () => Promise<string | null>;
  apply: (changes: PullResponse['changes'], cursor: string, done: boolean) => Promise<unknown>;
}

export type PullResult = { ok: true; rows: number } | { ok: false; reason: 'offline' | 'refused' | 'server' };

export async function pullAll(deps: PullDeps): Promise<PullResult> {
  let rows = 0;
  let retried = false;
  for (;;) {
    const cursor = await deps.cursor();
    const query = new URLSearchParams({ datasets: PULL_DATASETS.join(','), limit: String(PULL_LIMIT_MAX) });
    if (cursor) query.set('cursor', cursor);
    let res;
    try {
      res = await deps.api('GET', `/api/sync/pull?${query.toString()}`, { token: await deps.tokens.get() });
    } catch (err) {
      if (err instanceof OfflineError) return { ok: false, reason: 'offline' };
      if (err instanceof DeviceRefusedError) return { ok: false, reason: 'refused' };
      throw err;
    }
    if (res.status === 401 && !retried) {
      // The token expired or the server restarted its sessions: one new token, then give up.
      retried = true;
      deps.tokens.invalidate();
      continue;
    }
    if (res.status === 401) return { ok: false, reason: 'refused' };
    if (res.status !== 200) return { ok: false, reason: 'server' };
    const page = res.body as PullResponse;
    await deps.apply(page.changes, page.cursor, !page.hasMore);
    rows += Object.values(page.changes).reduce((n, list) => n + list.length, 0);
    if (!page.hasMore) return { ok: true, rows };
  }
}
