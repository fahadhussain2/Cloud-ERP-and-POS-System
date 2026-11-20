import {
  DASHBOARD_PERIOD_VIEWS,
  type DashboardCountView,
  type DashboardPeriodView,
  type DashboardView,
} from '@erp/contracts';
import { withTenant } from '@erp/db';
import {
  attentionList,
  biggestBalances,
  can,
  chipOf,
  dashboardWindows,
  gpDonut,
  hourGrid,
  periodOf,
  profitAndLoss,
  salesFigures,
  unusualTimes,
  type DashboardWindows,
  type Period,
} from '@erp/domain';
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';

import { requirePermission } from '../auth/routes';
import { balancesAt, chart, dayBefore, periodSums, shop } from './financial';
import { limitRows, moneyRegister } from './partners';
import { moneyOf } from './routes';
import { namesOf, overTime, salesSets, salesSince, type SalesSets, type Sums } from './sales';
import { deadStockRows, reorderListed, sinceOf as stockSince, stockAt } from './stock';
import { ageingOf, openExceptions, overrideRows, voidsAndReturns } from './views';

// The owner's dashboard (W2-06 plan; RPT-18; D-118): one read for the whole screen, under the app role (rule 5). Every
// figure comes from the query its report uses, so the two can't disagree; the rules (windows, chips, unusual, the
// donut, the biggest balances, attention) are @erp/domain's dashboard.ts. Four independent groups (sales, stock,
// customers and suppliers, the books) are read in parallel, each in its own tenant transaction (the plan's risk: one
// read was 2.3 s on a generated year). Only dashboard.view may read it (the owner's, through '*'); cost, profit,
// margin and stock value are still left out without cost.view, so a role given the dashboard later sees no more than
// its reports.

interface Deps {
  pool: pg.Pool;
  now: () => Date;
  requireAuth: preHandlerAsyncHookHandler;
}

type Client = pg.ClientBase;
/** Runs a read in its own tenant transaction. */
type Run = <T>(fn: (c: Client) => Promise<T>) => Promise<T>;

/** A counter needs attention when not seen for this long while its cash session is open (owner answer 5). */
const UNSEEN_MINUTES = 10;
/** Busy hours: the last four weeks (as the prototype). */
const BUSY_WEEKS = 4;
const TOP_CATEGORIES = 6;
const TOP_ITEMS = 5;
const TOP_BALANCES = 5;
/** Dead stock on the dashboard: no sale in 90 days (RPT-08's default). */
const DEAD_DAYS = 90;
const PRICE_APPROVALS = ['below_list', 'below_floor'];

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const NAMES = new Intl.Collator('en', { sensitivity: 'base' });
const daysOf = (p: Period) => {
  const out: string[] = [];
  for (let d = p.from; d <= p.to; d = addDays(d, 1)) out.push(d);
  return out;
};

interface Context {
  period: DashboardPeriodView;
  today: string;
  startMonth: number;
  w: DashboardWindows;
  clock: { minute: number; hour: number; cutoff: number };
  values: boolean;
  userId: string;
  now: Date;
}

/** The business minute now, and the hour, in the shop's time zone and cut-off. */
async function clockOf(c: Client, now: Date): Promise<Context['clock']> {
  const { rows } = await c.query<{ h: number; m: number; cutoff: number }>(
    `SELECT extract(hour FROM $1::timestamptz AT TIME ZONE timezone)::int AS h,
       extract(minute FROM $1::timestamptz AT TIME ZONE timezone)::int AS m, day_cutoff_hour AS cutoff
     FROM erp.tenants`,
    [now.toISOString()],
  );
  const r = rows[0]!;
  return { minute: ((r.h - r.cutoff + 24) % 24) * 60 + r.m, hour: r.h, cutoff: r.cutoff };
}

const counted = (now: { count: number; amount: number }, before: { count: number; amount: number }) =>
  ({
    count: now.count,
    amount: now.amount,
    usualCount: before.count,
    usualAmount: before.amount,
    times: unusualTimes(now.count, before.count),
  }) satisfies DashboardCountView;

// ---- Sales: key figures, trend, busy hours, categories, items, salesmen, discounts, returns and voids ----

async function salesPart(run: Run, x: Context) {
  const { w, today } = x;
  const upTo = w.upToMinute;
  const busyFrom = addDays(today, -(BUSY_WEEKS * 7 - 1));
  // Two connections at most: this period, and the comparison with the busy hours (the 30 days already hold them).
  const [cur, [cmp, cmpUpTo, busyBills]] = await Promise.all([
    run((c) => salesSets(c, w.current)),
    run(async (c) => {
      const full = await salesSets(c, w.comparison);
      const until = upTo === null ? full : await salesSets(c, w.comparison, upTo);
      const busy = x.period === '30d' ? null : (await overTime(c, { from: busyFrom, to: today }, {})).bills;
      return [full, until, busy] as const;
    }),
  ]);
  const nowFig = salesFigures(cur.total);
  const beforeFig = salesFigures(cmpUpTo.total);

  // The trend: by hour for Today (in the business day's order), else by day.
  let trend: DashboardView['trend'];
  if (x.period === 'today') {
    const byHour = (bills: { hour: number; sales: number }[]) => {
      const m = new Map<number, number>();
      for (const b of bills) m.set(b.hour, (m.get(b.hour) ?? 0) + b.sales);
      return m;
    };
    const a = byHour(cur.bills);
    const b = byHour(cmp.bills);
    const order = Array.from({ length: 24 }, (_, i) => (x.clock.cutoff + i) % 24);
    const used = order.filter((h) => a.has(h) || b.has(h) || h === x.clock.hour);
    const first = order.indexOf(used[0] ?? x.clock.hour);
    const last = order.indexOf(used.at(-1) ?? x.clock.hour);
    const nowAt = order.indexOf(x.clock.hour);
    trend = {
      step: 'hour',
      points: order.slice(first, last + 1).map((h, i) => ({
        label: `${String(h).padStart(2, '0')}:00`,
        now: first + i <= nowAt ? (a.get(h) ?? 0) : null,
        before: b.get(h) ?? 0,
      })),
    };
  } else {
    const a = new Map(cur.days.map((d) => [d.key, d.sales]));
    const b = new Map(cmp.days.map((d) => [d.key, d.sales]));
    const bd = daysOf(w.comparison);
    trend = {
      step: 'day',
      points: daysOf(w.current).map((d, i) => ({ label: d, now: a.get(d) ?? 0, before: b.get(bd[i]!) ?? 0 })),
    };
  }
  const grid = hourGrid(busyBills ?? cur.bills.filter((b) => b.date >= busyFrom));

  const cats = cur.categories.slice().sort((a, b) => b.sales - a.sales);
  const items = cur.items
    .slice()
    .sort((a, b) => b.sales - a.sales)
    .slice(0, TOP_ITEMS);
  // Names, price approvals, voids and returns: small reads on one connection.
  const range = (p: Period) => ({ ...p, branchId: null });
  const approvals = async (c: Client, p: Period) =>
    (await overrideRows(c, range(p))).filter((o) => PRICE_APPROVALS.includes(o.kind));
  const extra = await run(async (c) => ({
    catNames: await namesOf(
      c,
      'category',
      cats.map((r) => r.key),
    ),
    itemNames: await namesOf(
      c,
      'item',
      items.map((r) => r.key),
    ),
    smNames: await namesOf(
      c,
      'salesman',
      cur.salesmen.map((r) => r.key),
    ),
    belowNow: await approvals(c, w.current),
    belowBefore: await approvals(c, w.comparison),
    vrNow: await voidsAndReturns(c, range(w.current)),
    vrBefore: await voidsAndReturns(c, range(w.comparison)),
  }));
  const topCats = cats
    .map((r) => ({ id: r.key || null, name: extra.catNames.get(r.key)?.name ?? '', sales: r.sales }))
    .sort((a, b) => b.sales - a.sales || NAMES.compare(a.name, b.name))
    .slice(0, TOP_CATEGORIES);

  // Discounts given (list − paid, W2-03 owner answer 6) and on how many bills.
  const discounts = (s: SalesSets) => ({
    count: s.bills.filter((b) => b.listSales - b.sales > 0).length,
    amount: salesFigures(s.total).discount,
  });
  const below = (rows: Awaited<ReturnType<typeof approvals>>) => ({
    count: rows.length,
    amount: rows.reduce(
      (t, o) =>
        t +
        (o.list_price !== null && o.unit_price !== null && o.qty !== null
          ? Math.round(((Number(o.list_price) - Number(o.unit_price)) * Number(o.qty)) / 1000)
          : 0),
      0,
    ),
  });
  const returnsOf = (vr: typeof extra.vrNow) => ({
    count: vr.returns.length,
    amount: vr.returns.reduce((t, r) => t + r.amount, 0),
  });
  const voidsOf = (vr: typeof extra.vrNow) => ({
    count: vr.voids.length,
    amount: vr.voids.reduce((t, v) => t + (v.saleTotal ?? 0), 0),
  });
  const reasons = new Map<string, number>();
  for (const r of extra.vrNow.returns) reasons.set(r.reasonCode, (reasons.get(r.reasonCode) ?? 0) + 1);
  const topReason = [...reasons].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null;

  return {
    netSales: {
      now: nowFig.sales,
      before: beforeFig.sales,
      chip: chipOf({ now: nowFig.sales, before: beforeFig.sales, goodWhenUp: true }),
      bills: cur.total.bills,
      average: cur.total.bills > 0 ? Math.round(nowFig.sales / cur.total.bills) : null,
    },
    grossProfit: x.values
      ? {
          now: nowFig.profit,
          before: beforeFig.profit,
          chip: chipOf({ now: nowFig.profit, before: beforeFig.profit, goodWhenUp: true }),
          marginBp: nowFig.marginBp,
          beforeMarginBp: beforeFig.marginBp,
        }
      : { now: null, before: null, chip: null, marginBp: null, beforeMarginBp: null },
    trend,
    busyHours: { weeks: BUSY_WEEKS, bills: grid.bills, hours: grid.hours },
    topCategories: {
      rows: topCats,
      rest: cur.total.sales - topCats.reduce((t, r) => t + r.sales, 0),
      total: cur.total.sales,
    },
    leak: {
      discounts: counted(discounts(cur), discounts(cmpUpTo)),
      belowList: {
        ...counted(below(extra.belowNow), below(extra.belowBefore)),
        byOwner: extra.belowNow.filter((o) => o.approver_id === x.userId).length,
      },
      returns: { ...counted(returnsOf(extra.vrNow), returnsOf(extra.vrBefore)), topReason },
      voids: {
        ...counted(voidsOf(extra.vrNow), voidsOf(extra.vrBefore)),
        reissued: extra.vrNow.voids.filter((v) => v.reissueNumber !== null).length,
      },
    },
    bestItems: items.map((r) => ({
      id: r.key,
      code: extra.itemNames.get(r.key)?.code ?? '',
      name: extra.itemNames.get(r.key)?.name ?? '',
      qty: r.qty,
      sales: r.sales,
    })),
    salesmen: cur.salesmen
      .map((r: Sums) => ({
        id: r.key,
        name: extra.smNames.get(r.key)?.name ?? '',
        bills: r.bills,
        sales: r.sales,
      }))
      .sort((a, b) => b.sales - a.sales || NAMES.compare(a.name, b.name)),
  };
}

// ---- Stock: value, the reorder list, negative stock, dead stock ----

async function stockPart(c: Client, x: Context) {
  const onHand = await stockAt(c, null, null, false);
  const reorder = await reorderListed(c, {});
  const since = await stockSince(c, x.today);
  const dead = (await deadStockRows(c, x.today, since, DEAD_DAYS, {}, x.values)).filter(
    (r) => r.kind === 'dead' || r.kind === 'notSoldSinceGoLive',
  );
  return {
    value: x.values ? onHand.reduce((t, i) => t + i.value, 0) : null,
    atMinimum: reorder.listed.length,
    negative: onHand.filter((i) => i.qty < 0).length,
    dead: { count: dead.length, value: x.values ? dead.reduce((t, r) => t + (r.value ?? 0), 0) : null },
  };
}

// ---- Customers and suppliers: what they owe and are owed, limits, money received ----

async function partyPart(c: Client, x: Context) {
  const customers = await ageingOf(c, 'customers', x.today);
  const customers30 = await ageingOf(c, 'customers', addDays(x.today, -30));
  const received = await moneyRegister(c, 'received', { from: x.today, to: x.today });
  const limits = await limitRows(c, x.today);
  const sup = await ageingOf(c, 'suppliers', x.today);
  // What falls due in the next 7 days: not yet due today, but due by then (RPT-06's own buckets).
  const sup7 = await ageingOf(c, 'suppliers', addDays(x.today, 7));
  const balances = biggestBalances(
    customers.rows.map((r) => ({ id: r.partyId, name: r.name, amount: r.balance })),
    TOP_BALANCES,
  );
  return {
    customersOwe: {
      now: customers.totals.balance,
      before: customers30.totals.balance,
      chip: chipOf({ now: customers.totals.balance, before: customers30.totals.balance, goodWhenUp: false }),
      customers: balances.count,
      receivedToday: received.reduce((t, r) => t + r.amount, 0),
    },
    owe: balances,
    overLimit: limits.out.filter((r) => r.state === 'over').length,
    suppliers: {
      total: sup.totals.balance,
      overdue: sup.totals.balance - sup.totals.notDue,
      dueIn7Days: sup.totals.notDue - sup7.totals.notDue,
    },
  };
}

// ---- The books: cash, bank, the donut; cash sessions, counters, exceptions ----

async function booksPart(c: Client, x: Context) {
  const accounts = await c.query<{ id: string; role: string }>(
    `SELECT id, system_role AS role FROM erp.accounts
     WHERE system_role IN ('CASH_DRAWER', 'CASH_SAFE', 'CASH_IN_TRANSIT')`,
  );
  const banks = await c.query<{
    id: string;
    name: string;
    kind: 'bank' | 'wallet' | 'card_clearing';
    gl: string;
  }>(
    `SELECT id, name, kind, gl_account_id AS gl FROM erp.bank_accounts WHERE is_active AND deleted_at IS NULL
     ORDER BY kind, name`,
  );
  const balanceMap = async (at: string) =>
    new Map((await balancesAt(c, at, null)).map((b) => [b.accountId, b.balance]));
  const balNow = await balanceMap(x.today);
  const balStart = await balanceMap(dayBefore(x.today));
  const roleSum = (m: Map<string, number>, role: string) =>
    accounts.rows.filter((a) => a.role === role).reduce((t, a) => t + (m.get(a.id) ?? 0), 0);
  const cashOf = (m: Map<string, number>) =>
    roleSum(m, 'CASH_DRAWER') + roleSum(m, 'CASH_SAFE') + roleSum(m, 'CASH_IN_TRANSIT');
  const realBanks = banks.rows.filter((b) => b.kind !== 'card_clearing');
  const bankOf = (m: Map<string, number>) => realBanks.reduce((t, b) => t + (m.get(b.gl) ?? 0), 0);
  const sessions = await c.query<{ open: number; first: Date | null }>(
    `SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
       min(opened_at) FILTER (WHERE business_date = $1) AS first
     FROM erp.cash_sessions`,
    [x.today],
  );
  const unseen = await c.query<{ name: string; minutes: number }>(
    `SELECT coalesce(d.name, d.code) AS name,
       floor(extract(epoch FROM ($1::timestamptz - coalesce(st.last_seen_at, cs.opened_at))) / 60)::int AS minutes
     FROM erp.devices d
     JOIN erp.cash_sessions cs ON cs.device_id = d.id AND cs.status = 'open'
     LEFT JOIN erp.device_status st ON st.tenant_id = d.tenant_id AND st.device_id = d.id
     WHERE d.deleted_at IS NULL AND d.status = 'active'
       AND coalesce(st.last_seen_at, cs.opened_at) < $1::timestamptz - make_interval(mins => $2)`,
    [x.now.toISOString(), UNSEEN_MINUTES],
  );
  const exceptions = await openExceptions(c, x.today);

  // Where this month's gross profit went (owner answer 4).
  let donut: DashboardView['donut'] = null;
  if (x.values) {
    const month = periodOf('thisMonth', x.today, x.startMonth);
    const pl = profitAndLoss({
      accounts: await chart(c),
      periods: [{ ...month, sums: await periodSums(c, month) }],
    });
    const gp = pl.grossProfit[0]!;
    const d = gpDonut({
      grossProfit: gp,
      expenses: pl.expenses.rows
        .filter((r) => !r.group)
        .map((r) => ({ name: r.name, amount: r.amounts[0]! })),
    });
    donut = { from: month.from, to: month.to, grossProfit: gp, ...d };
  }

  const cashNow = cashOf(balNow);
  const cashStart = cashOf(balStart);
  const bankNow = bankOf(balNow);
  const bankStart = bankOf(balStart);
  return {
    money: await moneyOf(c),
    dayOpenedAt: sessions.rows[0]!.first?.toISOString() ?? null,
    cash: {
      now: cashNow,
      atDayStart: cashStart,
      chip: chipOf({ now: cashNow, before: cashStart, goodWhenUp: true }),
      drawers: roleSum(balNow, 'CASH_DRAWER'),
      safe: roleSum(balNow, 'CASH_SAFE'),
      inTransit: roleSum(balNow, 'CASH_IN_TRANSIT'),
      openSessions: sessions.rows[0]!.open,
    },
    bank: {
      now: bankNow,
      atDayStart: bankStart,
      chip: chipOf({ now: bankNow, before: bankStart, goodWhenUp: true }),
      accounts: realBanks.map((b) => ({
        id: b.id,
        name: b.name,
        kind: b.kind as 'bank' | 'wallet',
        balance: balNow.get(b.gl) ?? 0,
      })),
      cardClearing: banks.rows
        .filter((b) => b.kind === 'card_clearing')
        .reduce((t, b) => t + (balNow.get(b.gl) ?? 0), 0),
    },
    unseen: unseen.rows,
    highExceptions: exceptions.high,
    donut,
  };
}

export async function dashboardOf(
  run: Run,
  now: Date,
  period: DashboardPeriodView,
  values: boolean,
  userId: string,
): Promise<DashboardView> {
  const x = await run(async (c): Promise<Context> => {
    const s = await shop(c, now);
    const clock = await clockOf(c, now);
    const since = await salesSince(c, s.today);
    const w = dashboardWindows({
      period,
      today: s.today,
      minute: clock.minute,
      firstDay: since < s.today ? since : null,
    });
    return { period, today: s.today, startMonth: s.startMonth, w, clock, values, userId, now };
  });
  const [sales, stock, parties, books] = await Promise.all([
    salesPart(run, x),
    run((c) => stockPart(c, x)),
    run((c) => partyPart(c, x)),
    run((c) => booksPart(c, x)),
  ]);
  return {
    money: books.money,
    values,
    period,
    today: x.today,
    readAt: now.toISOString(),
    dayOpenedAt: books.dayOpenedAt,
    current: x.w.current,
    comparison: x.w.comparison,
    upToMinute: x.w.upToMinute,
    beforeGoLive: x.w.beforeFirstDay,
    netSales: sales.netSales,
    grossProfit: sales.grossProfit,
    cash: books.cash,
    bank: books.bank,
    customersOwe: parties.customersOwe,
    trend: sales.trend,
    attention: attentionList({
      highExceptions: books.highExceptions,
      negativeStock: stock.negative,
      unseenCounters: books.unseen,
      atMinimum: stock.atMinimum,
      overLimit: parties.overLimit,
      openSessions: books.cash.openSessions,
    }),
    busyHours: sales.busyHours,
    topCategories: sales.topCategories,
    leak: sales.leak,
    donut: books.donut,
    owe: parties.owe,
    suppliers: parties.suppliers,
    stock,
    bestItems: sales.bestItems,
    salesmen: sales.salesmen,
  };
}

export function registerDashboard(scope: FastifyInstance, { pool, now, requireAuth }: Deps) {
  const owner = requirePermission(requireAuth, 'dashboard.view');
  scope.get('/dashboard', { preHandler: owner }, async (req: FastifyRequest, reply) => {
    const raw = (req.query as Record<string, string | undefined>)['period'] ?? 'today';
    if (!(DASHBOARD_PERIOD_VIEWS as readonly string[]).includes(raw))
      return reply.code(400).send({ error: 'bad_request' });
    const ctx = { tenantId: req.auth!.tenantId, userId: req.auth!.userId, requestId: req.id };
    const run: Run = (fn) => withTenant(pool, ctx, async (_db, c) => fn(c));
    return dashboardOf(
      run,
      now(),
      raw as DashboardPeriodView,
      can(req.auth!.grants, 'cost.view', null),
      req.auth!.userId,
    );
  });
}
