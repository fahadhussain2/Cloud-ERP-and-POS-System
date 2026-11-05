import type { CatalogLookups } from '@erp/contracts';
import { parseMoney, parseQty } from '@erp/domain';
import { plainAmount } from '@erp/ui';
import type { TFunction } from 'i18next';
import { useCallback, useEffect, useState } from 'react';

import type { Api } from '../api';

// What the catalog screens share (W1-15): the lookups (categories, units, brands, tiers, the shop's money format, what
// this person may do), the text of a refusal, and money and quantities to and from the fields (CLAUDE.md rule 1:
// integers only; rule 10: the shop's money format).

export function useLookups(api: Api): { lookups: CatalogLookups | null; reload: () => Promise<void> } {
  const [lookups, setLookups] = useState<CatalogLookups | null>(null);
  const fetchIt = useCallback(async () => {
    const r = await api('GET', '/api/catalog/lookups');
    return r.status === 200 ? (r.body as CatalogLookups) : null;
  }, [api]);
  useEffect(() => {
    let live = true;
    void fetchIt().then((l) => live && setLookups(l));
    return () => {
      live = false;
    };
  }, [fetchIt]);
  const reload = useCallback(async () => setLookups(await fetchIt()), [fetchIt]);
  return { lookups, reload };
}

/** The words for a refusal from the catalog API: each problem, a stale save with who saved, or the generic error. */
export function catalogRefusal(t: TFunction, exists: (key: string) => boolean, body: unknown): string {
  const b = body as {
    error?: string;
    problems?: (string | { problem: string; row: number | null })[];
    by?: string;
    code?: string;
  } | null;
  if (b?.error === 'invalid' && b.problems?.length)
    return b.problems
      .map((p) => {
        const code = typeof p === 'string' ? p : p.problem;
        const row = typeof p === 'string' || p.row === null ? null : p.row + 1;
        const text = exists(`catalog.problems.${code}`) ? t(`catalog.problems.${code}`) : code;
        return row === null ? text : t('catalog.problems.row', { row, text });
      })
      .join(' ');
  if (b?.error === 'stale') return t('catalog.errors.stale', { by: b.by ?? t('catalog.errors.someone') });
  if (b?.error === 'barcode_taken') return t('catalog.errors.barcode_taken', { code: b.code });
  if (b?.error && exists(`catalog.errors.${b.error}`)) return t(`catalog.errors.${b.error}`);
  return t('app.error');
}

/** Paisa as a field shows it ("" for none). */
export const moneyText = (minor: number | null, minorUnits: number) =>
  minor === null ? '' : plainAmount(minor, minorUnits);

/** A money field's text as paisa: null when empty, undefined when not a number. */
export function moneyValue(text: string, minorUnits: number): number | null | undefined {
  if (text.trim() === '') return null;
  try {
    return parseMoney(text.trim(), minorUnits);
  } catch {
    return undefined;
  }
}

/** Thousandths as a field shows them: 2500 → "2.5", 2000 → "2" ("" for none). */
export function qtyText(t: number | null): string {
  if (t === null) return '';
  const sign = t < 0 ? '-' : '';
  const a = Math.abs(t);
  const rest = String(a % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return `${sign}${Math.floor(a / 1000)}${rest ? `.${rest}` : ''}`;
}

/** A quantity field's text as thousandths: null when empty, undefined when not a number. */
export function qtyValue(text: string): number | null | undefined {
  if (text.trim() === '') return null;
  try {
    return parseQty(text.trim());
  } catch {
    return undefined;
  }
}

/** A select's value for "none". */
export const NONE = '';
