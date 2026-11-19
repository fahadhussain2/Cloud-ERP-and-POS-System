import { DomainError } from './errors';
import { checkRange } from './statements';

// The stock reports' rules (W2-02 plan; RPT-08, RPT-12, RPT-13, RPT-14, PUR-07 list; D-116). Pure: the API reads the
// stock ledger's sums and hands them here, so the screens, the CSV and the tests agree (rule 1). Quantities are integer
// thousandths, money integer minor units, dates YYYY-MM-DD. Nothing here reads the clock: "today" is passed in.

/** A quantity in thousandths and its value in minor units. */
export interface QtyValue {
  qty: number;
  value: number;
}

const ZERO: QtyValue = { qty: 0, value: 0 };
const plus = (a: QtyValue, b: QtyValue): QtyValue => ({ qty: a.qty + b.qty, value: a.value + b.value });

/** No more days than this in a range (only both ends' order is checked). */
const ANY = Number.MAX_SAFE_INTEGER;
/** Days from `a` to `b` (0 on the same day); both real dates, `a` not after `b`. */
const daysFrom = (a: string, b: string) => checkRange({ from: a, to: b }, ANY) - 1;

// ---- Stock movement (RPT-13) ----

/** Where a movement goes in the stock movement report (owner answer 3; the plan's design). */
export const MOVEMENT_BUCKETS = [
  'openings',
  'purchases',
  'purchaseReturns',
  'sales',
  'salesReturns',
  'adjustments',
  'transfersIn',
  'transfersOut',
] as const;
export type MovementBucket = (typeof MOVEMENT_BUCKETS)[number];

/**
 * The bucket of a stock movement, from its source and the sign of its quantity. A void undoes its bill's lines, so a
 * void bringing stock back undoes a sale and one taking stock out undoes a return. A transfer, sent or received, is out
 * of one location and into another.
 */
export function bucketOf(source: string, qty: number): MovementBucket {
  switch (source) {
    case 'opening':
      return 'openings';
    case 'goods_receipt':
      return 'purchases';
    case 'purchase_return':
      return 'purchaseReturns';
    case 'sale':
      return qty > 0 ? 'salesReturns' : 'sales';
    case 'sales_void':
      return qty < 0 ? 'salesReturns' : 'sales';
    case 'stock_adjustment':
      return 'adjustments';
    case 'stock_transfer':
    case 'stock_transfer_receipt':
      return qty < 0 ? 'transfersOut' : 'transfersIn';
    default:
      throw new DomainError('unknown_source', `not a stock source: ${source}`);
  }
}

export interface StockMovementInput {
  /** On hand and its value before the period. */
  opening: QtyValue;
  /** The period's movements, summed by source and by the sign of their quantity (or one by one). */
  moves: { source: string; qty: number; value: number }[];
}

export interface StockMovement {
  opening: QtyValue;
  /** Signed: what came in is positive, what went out negative, so opening + every bucket = closing. */
  buckets: Record<MovementBucket, QtyValue>;
  closing: QtyValue;
}

/** One item's (or location's) movement over a period: opening, each bucket, closing. */
export function stockMovement(input: StockMovementInput): StockMovement {
  const buckets = Object.fromEntries(MOVEMENT_BUCKETS.map((b) => [b, ZERO])) as Record<
    MovementBucket,
    QtyValue
  >;
  let closing = input.opening;
  for (const m of input.moves) {
    const b = bucketOf(m.source, m.qty);
    const move = { qty: m.qty, value: m.value };
    buckets[b] = plus(buckets[b], move);
    closing = plus(closing, move);
  }
  return { opening: input.opening, buckets, closing };
}

// ---- Grouped lists with subtotals (stock at a date, stock movement; owner answer 3) ----

export interface GroupedInput {
  /** In the order they should appear inside their group; `group` is the path (category, then make), '' for none. */
  rows: { key: string; group: string[]; values: number[] }[];
  /** How many levels of `group` to use: 0 is a plain list with a total. */
  depth: number;
}

export type GroupedLine =
  | { kind: 'group'; depth: number; path: string[]; name: string; count: number; values: number[] }
  | { kind: 'row'; depth: number; key: string; values: number[] };

export interface Grouped {
  lines: GroupedLine[];
  total: { count: number; values: number[] };
}

/** Group names in order; rows with none ('') come last. */
const byName = (a: string, b: string) =>
  Number(a === '') - Number(b === '') ||
  a.localeCompare(b, 'en', { sensitivity: 'base' }) ||
  Number(a > b) - Number(a < b);

/**
 * The rows under their groups, each group's line first with its subtotals and the count of rows beneath. Every value
 * column is added up, so the subtotals of a level add up to the total.
 */
export function groupRows(input: GroupedInput): Grouped {
  const width = Math.max(0, ...input.rows.map((r) => r.values.length));
  const sum = (rows: GroupedInput['rows']) =>
    Array.from({ length: width }, (_, i) => rows.reduce((s, r) => s + (r.values[i] ?? 0), 0));
  const lines: GroupedLine[] = [];
  const walk = (rows: GroupedInput['rows'], level: number, path: string[]) => {
    if (level === input.depth) {
      for (const r of rows) lines.push({ kind: 'row', depth: level, key: r.key, values: r.values });
      return;
    }
    const groups = new Map<string, GroupedInput['rows']>();
    for (const r of rows) {
      const name = r.group[level] ?? '';
      // Added to in place: copying the group for each row is quadratic on 19,500 items in one group.
      const inside = groups.get(name);
      if (inside) inside.push(r);
      else groups.set(name, [r]);
    }
    for (const name of [...groups.keys()].sort(byName)) {
      const inside = groups.get(name)!;
      lines.push({
        kind: 'group',
        depth: level,
        path: [...path, name],
        name,
        count: inside.length,
        values: sum(inside),
      });
      walk(inside, level + 1, [...path, name]);
    }
  };
  walk(input.rows, 0, []);
  return { lines, total: { count: input.rows.length, values: sum(input.rows) } };
}

// ---- The reorder list (PUR-07, the list only; owner answer 4) ----

export interface ReorderInput {
  /** In the Shop and the Godown together. */
  onHand: number;
  min: number | null;
  max: number | null;
  excluded: boolean;
  status: 'active' | 'dormant' | 'discontinued';
}

export interface ReorderLine {
  /** Up to the maximum (or the minimum when the maximum is below it). */
  order: number;
  /** The maximum is below the minimum. */
  levelsNeedFixing: boolean;
}

/** Whether an item is to be ordered, and how much: at or below its minimum, up to its maximum. */
export function reorderLine(i: ReorderInput): ReorderLine | null {
  if (i.excluded || i.status === 'discontinued' || i.min === null || i.max === null) return null;
  if (i.min === 0 && i.max === 0) return null;
  if (i.onHand > i.min) return null;
  const levelsNeedFixing = i.max < i.min;
  const order = (levelsNeedFixing ? i.min : i.max) - i.onHand;
  return order > 0 ? { order, levelsNeedFixing } : null;
}

// ---- Dead and slow stock (RPT-08; owner answers 1 and 5) ----

/** Days of sales the slow-stock rate looks back on, and the cover above which stock is slow (owner answer 5). */
export const SLOW_WINDOW_DAYS = 90;
export const SLOW_COVER_DAYS = 180;

/** How many days `onHand` lasts at `sold` over `days`; null when nothing sold, 0 when nothing is on hand. */
export function daysOfCover(onHand: number, sold: number, days: number): number | null {
  if (onHand <= 0) return 0;
  if (sold <= 0 || days <= 0) return null;
  return Math.floor((onHand * days) / sold);
}

export interface StockAgeInput {
  onHand: number;
  /** The last day the item sold, since go-live; null if never. */
  lastSale: string | null;
  /** Net quantity sold in the last 90 days (or since go-live, if that is shorter). */
  sold: number;
  today: string;
  /** "No sale in N days". */
  days: number;
  /** The first day the system knows sales: the opening's date (owner answer 1). */
  since: string;
}

export type StockAgeKind = 'dead' | 'notSoldSinceGoLive' | 'slow' | 'moving' | 'none';

export interface StockAge {
  kind: StockAgeKind;
  /** Days since the last sale; null if it never sold since go-live. */
  daysSinceSale: number | null;
  daysOfCover: number | null;
}

/**
 * Dead: in stock and no sale in the last `days` days. An item that never sold since go-live is dead only once `days`
 * days have passed since then; before that it is "not sold since go-live". Slow: sold, but at the rate of the last 90
 * days (or since go-live) the stock lasts more than 180 days. Nothing on hand: none.
 */
export function stockAge(i: StockAgeInput): StockAge {
  const open = daysFrom(i.since, i.today) + 1;
  const window = Math.min(SLOW_WINDOW_DAYS, open);
  const daysSinceSale = i.lastSale === null ? null : daysFrom(i.lastSale, i.today);
  const cover = daysOfCover(i.onHand, i.sold, window);
  const kind: StockAgeKind =
    i.onHand <= 0
      ? 'none'
      : daysSinceSale === null
        ? open >= i.days
          ? 'dead'
          : 'notSoldSinceGoLive'
        : daysSinceSale >= i.days
          ? 'dead'
          : cover !== null && cover > SLOW_COVER_DAYS
            ? 'slow'
            : 'moving';
  return { kind, daysSinceSale, daysOfCover: cover };
}

// ---- Inventory analysis (RPT-14; owner answer 7) ----

/** The share of the total, in basis points, that classes A and B reach (80% and 95%): 80 / 15 / 5. */
export const ABC_LIMITS = { a: 8000, b: 9500 } as const;

export interface AbcRow {
  id: string;
  amount: number;
  /** Basis points of the total, and of the total up to and including this row. */
  share: number;
  cumulative: number;
  class: 'A' | 'B' | 'C' | null;
}

/** Basis points of `of` (never 0 here), rounded half up: both are positive. */
const bp = (part: number, of: number) => Math.round((part * 10000) / of);

/**
 * Items by sales or profit, largest first (ties by id). A row is A while the share before it is under 80%, B under 95%,
 * else C, so the largest item is always A. Items with nothing (or a loss) have no class and don't count in the total.
 */
export function abcClasses(items: readonly { id: string; amount: number }[]): AbcRow[] {
  const sorted = [...items].sort((x, y) => y.amount - x.amount || Number(x.id > y.id) - Number(x.id < y.id));
  const total = sorted.reduce((s, x) => s + Math.max(x.amount, 0), 0);
  let before = 0;
  return sorted.map((x) => {
    if (x.amount <= 0) return { id: x.id, amount: x.amount, share: 0, cumulative: 0, class: null };
    const cls: AbcRow['class'] =
      before * 10000 < ABC_LIMITS.a * total ? 'A' : before * 10000 < ABC_LIMITS.b * total ? 'B' : 'C';
    before += x.amount;
    return {
      id: x.id,
      amount: x.amount,
      share: bp(x.amount, total),
      cumulative: bp(before, total),
      class: cls,
    };
  });
}

/**
 * Stock turnover in hundredths: cost of sales ÷ the average of the opening and closing stock value, rounded half away
 * from zero; null when there was no stock to turn.
 */
export function turnover(costOfSales: number, opening: number, closing: number): number | null {
  const twice = opening + closing;
  if (twice <= 0) return null;
  const x = (costOfSales * 200) / twice;
  return Math.sign(x) * Math.round(Math.abs(x));
}
