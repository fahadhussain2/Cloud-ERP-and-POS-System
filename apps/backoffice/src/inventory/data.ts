import type { InventoryLookups } from '@erp/contracts';
import type { TFunction } from 'i18next';
import { useCallback, useEffect, useState } from 'react';

import type { Api } from '../api';

// What the stock screens share (W1-18): the lookups (locations, routes that need receiving, the approval limit, the
// shop's money format, what this person may do) and the words for a problem or a refusal.

export function useInventoryLookups(api: Api, version = 0): InventoryLookups | null {
  const [lookups, setLookups] = useState<InventoryLookups | null>(null);
  const fetchIt = useCallback(async () => {
    const r = await api('GET', '/api/inventory/lookups');
    return r.status === 200 ? (r.body as InventoryLookups) : null;
  }, [api]);
  useEffect(() => {
    let live = true;
    void fetchIt().then((l) => live && setLookups(l));
    return () => {
      live = false;
    };
  }, [fetchIt, version]);
  return lookups;
}

/** A location's name, or the code given when it isn't one of the lookups (In transit). */
export const locationName = (lookups: InventoryLookups, id: string | null, t: TFunction) =>
  id === null ? '—' : (lookups.locations.find((l) => l.id === id)?.name ?? t('inventory.inTransit'));

/** The words for a problem code, with its row when it has one. */
export function problemText(
  t: TFunction,
  exists: (key: string) => boolean,
  problem: string,
  row: number | null,
) {
  const text = exists(`inventory.problems.${problem}`) ? t(`inventory.problems.${problem}`) : problem;
  return row === null ? text : t('inventory.problems.row', { row: row + 1, text });
}

/** The words for a refusal from the stock API. */
export function inventoryRefusal(t: TFunction, exists: (key: string) => boolean, body: unknown): string {
  const b = body as {
    error?: string;
    problems?: { problem: string; row: number | null }[];
    by?: string | null;
    code?: string;
    lockDate?: string;
  } | null;
  if (b?.error === 'invalid' && b.problems?.length)
    return b.problems.map((p) => problemText(t, exists, p.problem, p.row)).join(' ');
  if (b?.error === 'stale') return t('inventory.errors.stale', { by: b.by ?? t('inventory.errors.someone') });
  if (b?.error === 'posting_failed') return t('inventory.errors.posting_failed', { code: b.code ?? '' });
  if (b?.error === 'date_locked') return t('inventory.errors.date_locked', { date: b.lockDate ?? '' });
  if (b?.error && exists(`inventory.errors.${b.error}`)) return t(`inventory.errors.${b.error}`);
  return t('app.error');
}

/** Today in the shop's calendar, as YYYY-MM-DD (the back office runs in the shop). */
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
