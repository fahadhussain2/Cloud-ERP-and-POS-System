import type { CustomerLookups } from '@erp/contracts';
import { formatMoney } from '@erp/ui';
import type { TFunction } from 'i18next';
import { useEffect, useState } from 'react';

import type { Api } from '../api';

// What the customers screens share (W1-22, D-109): the lookups (tiers, the default offline cap, suppliers that can
// become customers, the shop's money format, what this person may do) and the words for a refusal.

export function useCustomerLookups(api: Api): CustomerLookups | null {
  const [lookups, setLookups] = useState<CustomerLookups | null>(null);
  useEffect(() => {
    let live = true;
    void api('GET', '/api/customers/lookups').then(
      (r) => live && setLookups(r.status === 200 ? (r.body as CustomerLookups) : null),
    );
    return () => {
      live = false;
    };
  }, [api]);
  return lookups;
}

/** The words for a refusal from the customers API; `money` formats an open balance. */
export function customerRefusal(t: TFunction, body: unknown, money?: CustomerLookups['money']): string {
  const b = body as { error?: string; by?: string | null; balance?: number } | null;
  const exists = (k: string) => t(k) !== k;
  if (b?.error === 'stale') return t('customers.errors.stale', { by: b.by ?? t('customers.errors.someone') });
  if (b?.error === 'balance_open' && b.balance !== undefined && money)
    return t('customers.errors.balance_open', { amount: formatMoney(b.balance, money) });
  if (b?.error && exists(`customers.errors.${b.error}`)) return t(`customers.errors.${b.error}`);
  return t('app.error');
}

/**
 * Phone digits worth searching for a duplicate: the last 7 digits of the last phone typed (so `+92 300…` and
 * `0300…` find each other), or null while it is shorter.
 */
export function phoneToCheck(phones: string): string | null {
  const last = phones
    .split(',')
    .map((p) => p.replace(/\D/g, ''))
    .filter(Boolean)
    .at(-1);
  return last !== undefined && last.length >= 7 ? last.slice(-7) : null;
}
