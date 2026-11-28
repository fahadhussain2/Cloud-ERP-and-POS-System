import type { PurchasingLookups } from '@erp/contracts';
import { checkDocumentDate } from '@erp/domain';
import { formatMoney } from '@erp/ui';
import type { TFunction } from 'i18next';
import { useCallback, useEffect, useState } from 'react';

import type { Api } from '../api';

// What the purchasing screens share (W1-16): the lookups (locations, banks, suppliers, the shop's money format, what
// this person may do) and the text of a refusal. Money and quantity fields use the catalog's helpers (rule 1).

export function usePurchasingLookups(api: Api): PurchasingLookups | null {
  const [lookups, setLookups] = useState<PurchasingLookups | null>(null);
  const fetchIt = useCallback(async () => {
    const r = await api('GET', '/api/purchasing/lookups');
    return r.status === 200 ? (r.body as PurchasingLookups) : null;
  }, [api]);
  useEffect(() => {
    let live = true;
    void fetchIt().then((l) => live && setLookups(l));
    return () => {
      live = false;
    };
  }, [fetchIt]);
  return lookups;
}

/** The words for a problem code, with its row when it has one; `limit` names the most an amount may be (W2-17). */
export function problemText(
  t: TFunction,
  exists: (key: string) => boolean,
  problem: string,
  row: number | null,
  limit?: string,
) {
  const text = exists(`purchasing.problems.${problem}`)
    ? t(`purchasing.problems.${problem}`, { limit })
    : problem;
  return row === null ? text : t('purchasing.problems.row', { row: row + 1, text });
}

/**
 * The short words under a line's box (W2-17): the column's heading already names the field, so "Above 0" says what
 * "Type a quantity above 0." does. A problem with no short form keeps its sentence.
 */
export function shortProblemText(
  t: TFunction,
  exists: (key: string) => boolean,
  problem: string,
  limit: string,
) {
  return exists(`purchasing.short.${problem}`)
    ? t(`purchasing.short.${problem}`, { limit })
    : problemText(t, exists, problem, null, limit);
}

/** The words for a refusal from the purchasing API; `money` formats an amount in it (a supplier's open balance). */
export function purchasingRefusal(
  t: TFunction,
  exists: (key: string) => boolean,
  body: unknown,
  money?: PurchasingLookups['money'],
): string {
  const b = body as {
    error?: string;
    problems?: { problem: string; row: number | null }[];
    by?: string | null;
    code?: string;
    lockDate?: string;
    today?: string;
    balance?: number;
    limit?: number;
  } | null;
  if (b?.error === 'invalid' && b.problems?.length)
    return b.problems.map((p) => problemText(t, exists, p.problem, p.row)).join(' ');
  // An amount over Rs 1 crore (W2-17): the screen marks it first, so this is only for a page out of date.
  if (b?.error === 'too_large' && b.problems?.length) {
    const limit = b.limit !== undefined && money ? formatMoney(b.limit, money) : undefined;
    return b.problems.map((p) => problemText(t, exists, p.problem, p.row, limit)).join(' ');
  }
  if (b?.error === 'stale')
    return t('purchasing.errors.stale', { by: b.by ?? t('purchasing.errors.someone') });
  if (b?.error === 'balance_open' && b.balance !== undefined && money)
    return t('purchasing.errors.balance_open', { amount: formatMoney(b.balance, money) });
  if (b?.error === 'posting_failed') return t('purchasing.errors.posting_failed', { code: b.code ?? '' });
  if (b?.error === 'date_locked') return t('purchasing.errors.date_locked', { date: b.lockDate ?? '' });
  if (b?.error === 'date_in_future') return t('purchasing.errors.date_in_future', { today: b.today ?? '' });
  if (b?.error && exists(`purchasing.errors.${b.error}`)) return t(`purchasing.errors.${b.error}`);
  return t('app.error');
}

/**
 * Why a document dated `date` can't post, or null: the server's check as you type. Not after the shop's business date
 * (`lookups.today`, W2-05: the forms' default too, never this browser's calendar), not on or before the lock date
 * (D-108).
 */
export function dateProblem(
  t: TFunction,
  date: string,
  lookups: Pick<PurchasingLookups, 'today' | 'lockDate'>,
): string | null {
  const problem = checkDocumentDate(date, lookups.today, lookups.lockDate);
  if (problem === 'date_in_future') return t('purchasing.errors.date_in_future', { today: lookups.today });
  if (problem === 'date_locked') return t('purchasing.errors.date_locked', { date: lookups.lockDate });
  return null;
}

export interface PickedItem {
  id: string;
  code: string;
  name: string;
  allowsFraction: boolean;
  lastCost: number | null;
  retail: number | null;
}
