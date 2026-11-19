import { DomainError } from './errors';

// The reports' shared arithmetic (W1-20, D-110): pure, so the API, its CSV and the tests agree to the paisa (rule 1).

/** One bill as the sales register reads it; `total` and payment amounts are signed paisa (a return is negative). */
export interface RegisterBill {
  number: string;
  status: 'finalized' | 'voided';
  kind: 'sale' | 'return' | 'exchange';
  salespersonId: string;
  salespersonName: string;
  deviceCode: string;
  total: number;
  payments: { methodCode: string; methodName: string; amount: number }[];
}

export interface RegisterTotals {
  /** Finalized bills counted (returns and exchanges included). */
  bills: number;
  /** Voided bills: listed by the register, left out of every total. */
  voided: number;
  total: number;
  bySalesperson: { id: string; name: string; bills: number; total: number }[];
  byCounter: { code: string; bills: number; total: number }[];
  byTender: { code: string; name: string; amount: number }[];
}

/** The register's totals (RPT-01, owner answer 3 to W1-20): finalized bills net, voids apart; fixed order. */
export function registerTotals(bills: readonly RegisterBill[]): RegisterTotals {
  const people = new Map<string, { id: string; name: string; bills: number; total: number }>();
  const counters = new Map<string, { code: string; bills: number; total: number }>();
  const tenders = new Map<string, { code: string; name: string; amount: number }>();
  let counted = 0;
  let voided = 0;
  let total = 0;
  for (const b of bills) {
    if (b.status === 'voided') {
      voided += 1;
      continue;
    }
    counted += 1;
    total += b.total;
    const p = people.get(b.salespersonId) ?? {
      id: b.salespersonId,
      name: b.salespersonName,
      bills: 0,
      total: 0,
    };
    people.set(b.salespersonId, { ...p, bills: p.bills + 1, total: p.total + b.total });
    const c = counters.get(b.deviceCode) ?? { code: b.deviceCode, bills: 0, total: 0 };
    counters.set(b.deviceCode, { ...c, bills: c.bills + 1, total: c.total + b.total });
    for (const pay of b.payments) {
      const t = tenders.get(pay.methodCode) ?? { code: pay.methodCode, name: pay.methodName, amount: 0 };
      tenders.set(pay.methodCode, { ...t, amount: t.amount + pay.amount });
    }
  }
  const by =
    <T>(key: (x: T) => string) =>
    (a: T, b: T) =>
      key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
  return {
    bills: counted,
    voided,
    total,
    bySalesperson: [...people.values()].sort(by((p) => p.name)),
    byCounter: [...counters.values()].sort(by((c) => c.code)),
    byTender: [...tenders.values()].sort(by((t) => t.code)),
  };
}

/** One party ledger entry: positive raises what is owed (a credit sale, a supplier's bill), negative lowers it. */
export interface AgeingEntry {
  partyId: string;
  entryDate: string;
  dueDate: string;
  amount: number;
}

export interface AgeingInput {
  asOf: string;
  entries: AgeingEntry[];
}

export interface AgeingBuckets {
  balance: number;
  notDue: number;
  days1to30: number;
  days31to60: number;
  days61to90: number;
  over90: number;
}

export interface AgeingRow extends AgeingBuckets {
  partyId: string;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since 1970-01-01 of a calendar date; a date that isn't one is refused. */
export function dayNumber(date: string): number {
  const m = DAY.exec(date);
  const [y, mo, d] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [NaN, NaN, NaN];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (!m || t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d)
    throw new DomainError('invalid_date', `not a date: ${date}`);
  return t.getTime() / 86_400_000;
}

const empty = (): AgeingBuckets => ({
  balance: 0,
  notDue: 0,
  days1to30: 0,
  days31to60: 0,
  days61to90: 0,
  over90: 0,
});

/** A debit with what is still unpaid of it; days are `dayNumber`s. */
export interface OpenDebit {
  due: number;
  at: number;
  left: number;
}

/**
 * One party's entries settled oldest first (owner answer 4 to W1-20): credits pay the debits in due-date order, then
 * entry date. Returns every debit with what is left unpaid, and the credit left over (an advance), 0 or more.
 */
export function settleOldestFirst(entries: readonly Omit<AgeingEntry, 'partyId'>[]): {
  debits: OpenDebit[];
  credit: number;
} {
  const debits = entries
    .filter((e) => e.amount > 0)
    .map((e) => ({ due: dayNumber(e.dueDate), at: dayNumber(e.entryDate), left: e.amount }))
    .sort((a, b) => a.due - b.due || a.at - b.at);
  let credit = -entries.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0);
  for (const d of debits) {
    const used = Math.min(credit, d.left);
    d.left -= used;
    credit -= used;
  }
  return { debits, credit };
}

/**
 * Ageing by due date (RPT-06, owner answer 4 to W1-20): credits settle the oldest debits first (due date, then entry
 * date); what is left of each debit goes to its bucket by days past due at `asOf`; a credit left over goes to not yet
 * due, so the buckets always add up to the balance. Parties at zero are left out; rows by party id.
 */
export function ageBalances(input: AgeingInput): { rows: AgeingRow[]; totals: AgeingBuckets } {
  const asOf = dayNumber(input.asOf);
  const byParty = new Map<string, AgeingEntry[]>();
  for (const e of input.entries) byParty.set(e.partyId, [...(byParty.get(e.partyId) ?? []), e]);

  const rows: AgeingRow[] = [];
  for (const [partyId, entries] of byParty) {
    const { debits, credit } = settleOldestFirst(entries);
    const row: AgeingRow = { partyId, ...empty() };
    for (const d of debits) {
      if (d.left === 0) continue;
      const late = asOf - d.due;
      if (late <= 0) row.notDue += d.left;
      else if (late <= 30) row.days1to30 += d.left;
      else if (late <= 60) row.days31to60 += d.left;
      else if (late <= 90) row.days61to90 += d.left;
      else row.over90 += d.left;
    }
    row.notDue -= credit;
    row.balance = row.notDue + row.days1to30 + row.days31to60 + row.days61to90 + row.over90;
    if (row.balance !== 0) rows.push(row);
  }
  // Party ids are unique, so two rows never tie.
  rows.sort((a, b) => (a.partyId < b.partyId ? -1 : 1));
  const totals = rows.reduce<AgeingBuckets>(
    (t, r) => ({
      balance: t.balance + r.balance,
      notDue: t.notDue + r.notDue,
      days1to30: t.days1to30 + r.days1to30,
      days31to60: t.days31to60 + r.days31to60,
      days61to90: t.days61to90 + r.days61to90,
      over90: t.over90 + r.over90,
    }),
    empty(),
  );
  return { rows, totals };
}
