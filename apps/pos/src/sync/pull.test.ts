import { PULL_DATASETS, type PullResponse } from '@erp/contracts';
import { describe, expect, it } from 'vitest';

import { DeviceRefusedError } from '../device/session';
import { OfflineError, type Api } from '../net/api';
import { pullAll, type PullDeps } from './pull';

// The counter's pull loop (sync spec §2, §4): page by page from the stored cursor, each page applied with its cursor;
// the last page of a complete pull says so (the first catalog load, W1-03).

const DATASETS = encodeURIComponent(PULL_DATASETS.join(','));

const page = (n: number, hasMore: boolean): PullResponse => ({
  changes: { users: [{ id: `u${n}` }] },
  cursor: `c${n}`,
  hasMore,
});

const setup = (replies: (() => Promise<{ status: number; body: unknown }>)[]) => {
  const applied: [PullResponse['changes'], string, boolean][] = [];
  const paths: string[] = [];
  const tokensUsed: (string | undefined)[] = [];
  let invalidated = 0;
  let token = 'T1';
  const api: Api = (_m, path, opts) => {
    paths.push(path);
    tokensUsed.push(opts?.token);
    return replies.shift()!();
  };
  const deps: PullDeps = {
    api,
    tokens: {
      get: () => Promise.resolve(token),
      invalidate: () => {
        invalidated++;
        token = 'T2';
      },
    },
    cursor: () => Promise.resolve(applied.at(-1)?.[1] ?? 'c0'),
    apply: (changes, cursor, done) => {
      applied.push([changes, cursor, done]);
      return Promise.resolve();
    },
  };
  return { deps, applied, paths, tokensUsed, invalidated: () => invalidated };
};
const ok = (body: unknown) => () => Promise.resolve({ status: 200, body });

describe('pull', () => {
  it('pulls every dataset, a full page at a time, from the stored cursor and applies each page with its cursor', async () => {
    const s = setup([ok(page(1, true)), ok(page(2, false))]);
    expect(await pullAll(s.deps)).toEqual({ ok: true, rows: 2 });
    expect(PULL_DATASETS).toEqual(
      expect.arrayContaining(['users', 'items', 'item_identifiers', 'item_prices']),
    );
    expect(s.paths).toEqual([
      `/api/sync/pull?datasets=${DATASETS}&limit=1000&cursor=c0`,
      `/api/sync/pull?datasets=${DATASETS}&limit=1000&cursor=c1`,
    ]);
    expect(s.applied.map(([, c, done]) => [c, done])).toEqual([
      ['c1', false],
      ['c2', true],
    ]);
  });

  it('tells the screens after each page, so the staff list shows before a long first load ends', async () => {
    const s = setup([ok(page(1, true)), ok(page(2, false))]);
    let pages = 0;
    await pullAll({ ...s.deps, onPage: () => pages++ });
    expect(pages).toBe(2);
  });

  it('gets a new device token once when the old one is refused', async () => {
    const s = setup([() => Promise.resolve({ status: 401, body: {} }), ok(page(1, false))]);
    expect(await pullAll(s.deps)).toEqual({ ok: true, rows: 1 });
    expect(s.tokensUsed).toEqual(['T1', 'T2']);
    expect(s.invalidated()).toBe(1);
  });

  it('stops, applying nothing more, when offline, refused twice or the server fails', async () => {
    const offline = setup([() => Promise.reject(new OfflineError())]);
    expect(await pullAll(offline.deps)).toEqual({ ok: false, reason: 'offline' });
    const refused = setup([
      () => Promise.resolve({ status: 401, body: {} }),
      () => Promise.resolve({ status: 401, body: {} }),
    ]);
    expect(await pullAll(refused.deps)).toEqual({ ok: false, reason: 'refused' });
    const revoked = setup([
      () => Promise.reject(Object.assign(new DeviceRefusedError('challenge refused'), { revoked: true })),
    ]);
    expect(await pullAll(revoked.deps)).toEqual({ ok: false, reason: 'revoked' });
    const failing = setup([ok(page(1, true)), () => Promise.resolve({ status: 500, body: {} })]);
    expect(await pullAll(failing.deps)).toEqual({ ok: false, reason: 'server' });
    expect(failing.applied).toHaveLength(1);
  });
});
