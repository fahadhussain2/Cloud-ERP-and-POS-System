import { money, type CreditView, type Money } from '@erp/domain';

import { getSync } from './repo';
import type { SqlDb } from './sql';

// Customers on the counter and their credit figures (POS spec §15, POS-05, POS-07, D-096). Runs in the database
// worker. Names and phones are never written to the diagnostic log.

export interface CustomerAccountInfo {
  tierId: string;
  creditAllowed: boolean;
  /** null = no limit (D-085). */
  creditLimit: Money | null;
  offlineDailyCap: Money;
}

export interface CounterCustomer {
  id: string;
  code: string;
  name: string;
  phones: string[];
  city: string | null;
  account: CustomerAccountInfo;
  /** The pulled balance: positive = owes, negative = an advance. */
  balance: Money;
}

const text = (v: unknown): string | null =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;

const CUSTOMER_SQL = `
  SELECT c.id, c.code, c.name, c.phones, c.city, a.price_tier_id, a.credit_allowed, a.credit_limit,
         a.offline_daily_cap, coalesce(b.balance, 0) AS balance
  FROM customers c
  JOIN customer_accounts a ON a.party_id = c.id AND a.deleted_at IS NULL
  LEFT JOIN customer_balances b ON b.party_id = c.id AND b.deleted_at IS NULL
  WHERE c.deleted_at IS NULL AND c.status = 'active'`;

const toCustomer = (r: Record<string, unknown>): CounterCustomer => ({
  id: String(r['id']),
  code: String(r['code']),
  name: String(r['name']),
  phones: (JSON.parse(String(r['phones'])) as unknown[]).map(String),
  city: text(r['city']),
  account: {
    tierId: String(r['price_tier_id']),
    creditAllowed: Number(r['credit_allowed']) === 1,
    creditLimit: r['credit_limit'] === null ? null : money(Number(r['credit_limit'])),
    offlineDailyCap: money(Number(r['offline_daily_cap'])),
  },
  balance: money(Number(r['balance'])),
});

/** The active customers with a live account, by name: who the F4 dialog can pick. */
export const listCustomers = (db: SqlDb): CounterCustomer[] =>
  db.selectObjects(`${CUSTOMER_SQL} ORDER BY c.name, c.code`).map(toCustomer);

export const getCustomer = (db: SqlDb, id: string): CounterCustomer | null => {
  const [r] = db.selectObjects(`${CUSTOMER_SQL} AND c.id = ?`, [id]);
  return r === undefined ? null : toCustomer(r);
};

/** The on-account parts of this counter's bills for a customer, with a condition on the document `d`. */
const onAccountSum = (db: SqlDb, customerId: string, where: string, params: string[]): Money =>
  money(
    Number(
      db.selectValue(
        `SELECT coalesce(sum(json_extract(p.value, '$.amount')), 0)
         FROM local_documents d, json_each(d.payload, '$.payments') p
         WHERE json_extract(d.payload, '$.customerId') = ? AND json_extract(p.value, '$.method') = 'on_account'
           AND (${where})`,
        [customerId, ...params],
      ),
    ),
  );

/**
 * What the counter knows about a customer's credit (POS spec §15): the pulled balance and when; this counter's
 * on-account bills the balance can't include yet (still in the outbox, refused ones too, or accepted after the start
 * of the last complete pull); and, offline, today's on-account bills made offline. A walk-in or a party without an
 * account has no account and a balance of 0.
 */
export function creditFigures(
  db: SqlDb,
  customerId: string,
  offline: boolean,
  businessDate: string,
): CreditView {
  const c = getCustomer(db, customerId);
  const balanceAsOf = getSync(db, 'complete_pull_started_at');
  const unsynced = onAccountSum(db, customerId, 'd.id IN (SELECT id FROM outbox) OR d.accepted_at > ?', [
    // Before any complete pull, every accepted bill may be missing from the balance.
    balanceAsOf ?? '',
  ]);
  const offlineToday = onAccountSum(
    db,
    customerId,
    "d.business_date = ? AND json_extract(d.payload, '$.credit.offline') = 1",
    [businessDate],
  );
  return {
    account:
      c === null
        ? null
        : {
            creditAllowed: c.account.creditAllowed,
            creditLimit: c.account.creditLimit,
            offlineDailyCap: c.account.offlineDailyCap,
          },
    balance: c?.balance ?? money(0),
    balanceAsOf: c === null ? null : balanceAsOf,
    unsynced,
    offline,
    offlineToday,
  };
}
