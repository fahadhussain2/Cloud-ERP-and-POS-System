import type { CashMovementKind, SessionMovement } from './cash-movement';
import { expectedCash, type SessionCollection, type SessionHandover } from './cash-session';
import type { HandoverKind } from './handover';
import { add, money, sum, type Money } from './money';

// The business-day reconciliation (CSH-08, RPT-02, PRD W10.2, cash desk spec, W1-11): what one branch's day looks like
// once the server has what it has. Pure: the API reads the rows, this puts them together. A day is final only when
// nothing that belongs to it can still arrive.

export interface DayDevice {
  code: string;
  /** The device's last push or pull; null = never. */
  lastContactAt: string | null;
  /** Its oldest document not yet synced, as it last reported; null = none. */
  oldestUnsyncedAt: string | null;
}

export interface DaySession {
  id: string;
  number: string;
  deviceCode: string;
  cashierName: string;
  status: 'open' | 'closed';
  openingFloat: Money;
  /** The desk's figure at close; null while open. */
  deskExpected: Money | null;
  /** null while open, and for a close without a count (W1-10). */
  countedCash: Money | null;
  variance: Money | null;
  varianceReason: string | null;
  acknowledgedByName: string | null;
  handovers: SessionHandover[];
  collections: SessionCollection[];
  movements: SessionMovement[];
}

export interface DayInput {
  businessDate: string;
  /** When the business day ends (the next day's cutoff, D-056). */
  dayEndsAt: string;
  now: string;
  handoverMode: 'required' | 'off';
  /** The branch's active devices. */
  devices: DayDevice[];
  /** Open sequence gaps on those devices. */
  gaps: { deviceCode: string; family: string; fromSeq: number; toSeq: number }[];
  sessions: DaySession[];
  /** The day's finalized, not voided cash bills and refunds still waiting for the desk. */
  pendingBills: {
    number: string;
    sellerId: string;
    sellerName: string | null;
    createdAt: string;
    cashDue: Money;
  }[];
  /** The day's handovers whose bill never arrived. */
  unmatched: { number: string; billNumber: string; kind: HandoverKind; amount: Money; createdAt: string }[];
  /** The day's exceptions, counted by kind. */
  exceptions: { kind: string; severity: 'low' | 'medium' | 'high'; count: number }[];
  /** The branch's cash in transit at the end of the day: 0 when every bill reached the drawer. */
  cashInTransit: Money;
}

export type DayHold =
  | { kind: 'day_not_over'; dayEndsAt: string }
  | { kind: 'device_not_heard'; deviceCode: string; lastContactAt: string | null }
  | { kind: 'device_unsynced'; deviceCode: string; oldestUnsyncedAt: string }
  | { kind: 'sequence_gap'; deviceCode: string; family: string; fromSeq: number; toSeq: number }
  | { kind: 'session_open'; number: string; deviceCode: string; cashierName: string };

export type Acknowledgement = 'open' | 'not_counted' | 'exact' | 'waiting' | 'acknowledged';

export interface DaySessionSummary {
  id: string;
  number: string;
  deviceCode: string;
  cashierName: string;
  status: 'open' | 'closed';
  openingFloat: Money;
  handedIn: Money;
  paidOut: Money;
  cashCollections: Money;
  cashOuts: Record<CashMovementKind, Money>;
  /** From the session's documents on the server. */
  expected: Money;
  deskExpected: Money | null;
  /** The desk counted against a figure the server's documents don't reach (some haven't arrived). */
  expectedDiffers: boolean;
  counted: Money | null;
  variance: Money | null;
  varianceReason: string | null;
  acknowledgement: Acknowledgement;
  acknowledgedByName: string | null;
}

export interface MissingHandoverGroup {
  sellerId: string;
  sellerName: string | null;
  /** Oldest first. */
  bills: { number: string; createdAt: string; kind: HandoverKind; amount: Money }[];
  toCollect: Money;
  toPayOut: Money;
}

export interface DayReconciliation {
  businessDate: string;
  status: 'final' | 'provisional';
  holds: DayHold[];
  sessions: DaySessionSummary[];
  /** null when handover confirmation is Off. */
  missingHandovers: MissingHandoverGroup[] | null;
  unmatchedScans: DayInput['unmatched'];
  exceptions: DayInput['exceptions'];
  cashInTransit: Money;
  totalVariance: Money;
}

const before = (a: string, b: string) => Date.parse(a) < Date.parse(b);
/** A copy of `rows` in the order of their keys (keys are unique, so no two compare equal). */
const sortedBy = <T>(rows: readonly T[], key: (row: T) => string): T[] =>
  [...rows].sort((a, b) => (key(a) < key(b) ? -1 : 1));
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;
const MOVEMENT_KINDS: readonly CashMovementKind[] = [
  'expense',
  'supplier_payment',
  'bank_deposit',
  'to_safe',
  'from_safe',
];

function summarize(s: DaySession): DaySessionSummary {
  const total = <T extends { amount: Money }>(rows: readonly T[], keep: (r: T) => boolean) =>
    sum(rows.filter(keep).map((r) => r.amount));
  const expected = expectedCash({ ...s, openingFloat: s.openingFloat });
  const cashOuts = Object.fromEntries(
    MOVEMENT_KINDS.map((k) => [k, total(s.movements, (m) => m.kind === k)]),
  ) as Record<CashMovementKind, Money>;
  const acknowledgement: Acknowledgement =
    s.status === 'open'
      ? 'open'
      : s.countedCash === null
        ? 'not_counted'
        : s.variance === 0
          ? 'exact'
          : s.acknowledgedByName === null
            ? 'waiting'
            : 'acknowledged';
  return {
    id: s.id,
    number: s.number,
    deviceCode: s.deviceCode,
    cashierName: s.cashierName,
    status: s.status,
    openingFloat: s.openingFloat,
    handedIn: total(s.handovers, (h) => h.kind === 'in'),
    paidOut: total(s.handovers, (h) => h.kind === 'payout'),
    cashCollections: total(s.collections, (c) => c.cash),
    cashOuts,
    expected,
    deskExpected: s.deskExpected,
    expectedDiffers: s.deskExpected !== null && s.deskExpected !== expected,
    counted: s.countedCash,
    variance: s.variance,
    varianceReason: s.varianceReason,
    acknowledgement,
    acknowledgedByName: s.acknowledgedByName,
  };
}

function missingHandovers(bills: DayInput['pendingBills']): MissingHandoverGroup[] {
  const groups = new Map<string, MissingHandoverGroup>();
  const sorted = sortedBy(bills, (b) => `${b.createdAt} ${b.number}`);
  for (const b of sorted) {
    const g = groups.get(b.sellerId) ?? {
      sellerId: b.sellerId,
      sellerName: b.sellerName,
      bills: [],
      toCollect: money(0),
      toPayOut: money(0),
    };
    const kind: HandoverKind = b.cashDue < 0 ? 'payout' : 'in';
    const amount = money(Math.abs(b.cashDue));
    g.bills.push({ number: b.number, createdAt: b.createdAt, kind, amount });
    if (kind === 'in') g.toCollect = add(g.toCollect, amount);
    else g.toPayOut = add(g.toPayOut, amount);
    groups.set(b.sellerId, g);
  }
  // Like the desk's queue: named first, by name, then by id.
  const key = (g: MissingHandoverGroup) =>
    `${g.sellerName === null ? 1 : 0}\n${g.sellerName ?? ''}\n${g.sellerId}`;
  return sortedBy([...groups.values()], key);
}

export function reconcileDay(input: DayInput): DayReconciliation {
  const holds: DayHold[] = [];
  const over = !before(input.now, input.dayEndsAt);
  if (!over) holds.push({ kind: 'day_not_over', dayEndsAt: input.dayEndsAt });
  // Until the day is over the devices may still sell into it: they hold it only once it has ended.
  for (const d of over ? sortedBy(input.devices, (x) => x.code) : []) {
    if (d.lastContactAt === null || before(d.lastContactAt, input.dayEndsAt))
      holds.push({ kind: 'device_not_heard', deviceCode: d.code, lastContactAt: d.lastContactAt });
    else if (d.oldestUnsyncedAt !== null && before(d.oldestUnsyncedAt, input.dayEndsAt))
      holds.push({ kind: 'device_unsynced', deviceCode: d.code, oldestUnsyncedAt: d.oldestUnsyncedAt });
  }
  const gaps = sortedBy(
    input.gaps,
    (g) => `${g.deviceCode}\n${g.family}\n${String(g.fromSeq).padStart(12, '0')}`,
  );
  for (const g of gaps) holds.push({ kind: 'sequence_gap', ...g });
  const sessions = sortedBy(input.sessions, (x) => x.number);
  for (const s of sessions)
    if (s.status === 'open')
      holds.push({
        kind: 'session_open',
        number: s.number,
        deviceCode: s.deviceCode,
        cashierName: s.cashierName,
      });

  return {
    businessDate: input.businessDate,
    status: holds.length === 0 ? 'final' : 'provisional',
    holds,
    sessions: sessions.map(summarize),
    missingHandovers: input.handoverMode === 'off' ? null : missingHandovers(input.pendingBills),
    unmatchedScans: sortedBy(input.unmatched, (h) => `${h.createdAt} ${h.number}`),
    exceptions: sortedBy(
      input.exceptions,
      (e) => `${SEVERITY_ORDER[e.severity]}
${e.kind}`,
    ),
    cashInTransit: input.cashInTransit,
    totalVariance: sum(sessions.map((s) => s.variance ?? money(0))),
  };
}
