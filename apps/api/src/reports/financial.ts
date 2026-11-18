import {
  JOURNAL_SOURCES,
  type BalanceSheetView,
  type CashBookAccount,
  type CashBookView,
  type DayBookEntry,
  type DayBookView,
  type ExpensesView,
  type ProfitLossView,
  type StatementSectionView,
  type TrialBalanceView,
} from '@erp/contracts';
import { withTenant } from '@erp/db';
import {
  balanceSheet,
  cashBook,
  checkRange,
  DomainError,
  fiscalYearOf,
  lastYearPeriod,
  monthEnd,
  monthsOf,
  PERIOD_PRESETS,
  periodOf,
  previousPeriod,
  profitAndLoss,
  stockAndPurchases,
  trialBalance,
  type Period,
  type PeriodPreset,
  type StatementAccount,
} from '@erp/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';

import { requirePermission } from '../auth/routes';
import { csv, moneyOf, sendCsv, type Cell } from './routes';

// The financial statements and the day book (W2-01 plan; ACC-07, RPT-11; D-110, D-116): read only, computed on request
// from the journal inside withTenant under the app role (rule 5), the arithmetic in @erp/domain's statements.ts. Every
// report needs reports.financial (owner, accountant). Lists of lines (the cash book, the day book) take up to 92 days,
// the summaries up to a year, statements any date (D-116 answer 4); every one downloads as CSV (answer 5).

interface Deps {
  pool: pg.Pool;
  now: () => Date;
  requireAuth: preHandlerAsyncHookHandler;
}

type Client = pg.ClientBase;
type Query = Record<string, string | undefined>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Lists of documents or lines (D-116 answer 4). */
export const LIST_DAYS = 92;
/** Summaries: a year, 29 February included. */
export const SUMMARY_DAYS = 366;
/** One page of a cash book account's lines, or of the day book's entries; totals still count them all. */
const PAGE = 1000;

class BadRequest extends Error {
  constructor(readonly error: string) {
    super(error);
  }
}

const num = (v: string | number) => Number(v);
/** The document's own number: journal memos start with it (W1-08), as in the account ledger. */
const numberOf = (memo: string | null) => memo?.split(' ')[0] ?? null;

/** The shop's business date now, and its fiscal year's first month. */
async function shop(c: Client, now: Date): Promise<{ today: string; startMonth: number }> {
  const { rows } = await c.query<{ d: string; m: number }>(
    `SELECT (($1::timestamptz AT TIME ZONE timezone) - make_interval(hours => day_cutoff_hour))::date::text AS d,
       fiscal_year_start_month AS m FROM erp.tenants`,
    [now.toISOString()],
  );
  return { today: rows[0]!.d, startMonth: rows[0]!.m };
}

/** The chart: every live account, and any removed one that still has lines. */
async function chart(c: Client): Promise<StatementAccount[]> {
  const { rows } = await c.query<{
    id: string;
    code: string;
    name: string;
    type: StatementAccount['type'];
    parent_id: string | null;
    is_postable: boolean;
    system_role: string | null;
  }>(
    `SELECT a.id, a.code, a.name, a.type, a.parent_id, a.is_postable, a.system_role FROM erp.accounts a
     WHERE a.deleted_at IS NULL OR EXISTS (SELECT 1 FROM erp.journal_lines l WHERE l.account_id = a.id)
     ORDER BY a.code`,
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    type: r.type,
    parentId: r.parent_id,
    postable: r.is_postable,
    role: r.system_role,
  }));
}

/** Per account: debits − credits before `from`, and the debits and credits from `from` to `to`. */
async function periodSums(c: Client, p: Period) {
  const { rows } = await c.query<{ account_id: string; opening: string; debit: string; credit: string }>(
    `SELECT l.account_id,
       coalesce(sum(l.debit - l.credit) FILTER (WHERE e.entry_date < $1), 0)::text AS opening,
       coalesce(sum(l.debit) FILTER (WHERE e.entry_date >= $1), 0)::text AS debit,
       coalesce(sum(l.credit) FILTER (WHERE e.entry_date >= $1), 0)::text AS credit
     FROM erp.journal_lines l JOIN erp.journal_entries e ON e.id = l.entry_id
     WHERE e.entry_date <= $2 GROUP BY l.account_id`,
    [p.from, p.to],
  );
  return rows.map((r) => ({
    accountId: r.account_id,
    opening: num(r.opening),
    debit: num(r.debit),
    credit: num(r.credit),
  }));
}

/** Per account: debits − credits from `since` (or the start) up to and including `at`. */
async function balancesAt(c: Client, at: string, since: string | null) {
  const { rows } = await c.query<{ account_id: string; balance: string }>(
    `SELECT l.account_id, sum(l.debit - l.credit)::text AS balance
     FROM erp.journal_lines l JOIN erp.journal_entries e ON e.id = l.entry_id
     WHERE e.entry_date <= $1 AND ($2::date IS NULL OR e.entry_date >= $2) GROUP BY l.account_id`,
    [at, since],
  );
  return rows.map((r) => ({ accountId: r.account_id, balance: num(r.balance) }));
}

/**
 * The period: a preset (`thisMonth`…, on the shop's today and fiscal year), else from/to, else `fallback`; at most
 * `maxDays` (range_too_long), real dates the right way round. A preset keeps a saved link relative ("this month").
 */
function rangeOf(
  q: Query,
  fallback: Period,
  maxDays: number,
  s: { today: string; startMonth: number },
): Period {
  const preset = q['preset'];
  if (preset && !(PERIOD_PRESETS as readonly string[]).includes(preset)) throw new BadRequest('bad_request');
  const p = preset
    ? periodOf(preset as PeriodPreset, s.today, s.startMonth)
    : { from: q['from'] || fallback.from, to: q['to'] || fallback.to };
  try {
    checkRange(p, maxDays);
  } catch (err) {
    if (err instanceof DomainError && err.code === 'range_too_long') throw new BadRequest('range_too_long');
    throw new BadRequest('bad_request');
  }
  return p;
}

const dateOr = (v: string | undefined, fallback: string) => {
  const d = v || fallback;
  if (!DATE.test(d)) throw new BadRequest('bad_request');
  try {
    monthEnd(d);
  } catch {
    throw new BadRequest('bad_request');
  }
  return d;
};

/** The day before a date. */
const dayBefore = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

const periodLabel = (p: Period) => (p.from === p.to ? p.from : `${p.from} to ${p.to}`);

function sectionCsv(name: string, s: StatementSectionView): Cell[][] {
  return [
    ...s.rows.map((r): Cell[] => [name, r.code, `${'  '.repeat(r.depth)}${r.name}`, ...r.amounts]),
    [name, '', 'total', ...s.total],
  ];
}

export function registerFinancialReports(scope: FastifyInstance, { pool, now, requireAuth }: Deps) {
  const financial = requirePermission(requireAuth, 'reports.financial');
  const query = (req: FastifyRequest) => req.query as Query;
  const wantsCsv = (req: FastifyRequest) => query(req)['format'] === 'csv';

  /** Runs a report in one tenant transaction; bad filters are a 400. */
  const run = async <T>(
    req: FastifyRequest,
    reply: FastifyReply,
    fn: (c: Client, s: { today: string; startMonth: number }) => Promise<T>,
  ): Promise<T | FastifyReply> => {
    try {
      return await withTenant(
        pool,
        { tenantId: req.auth!.tenantId, userId: req.auth!.userId, requestId: req.id },
        async (_db, c) => fn(c, await shop(c, now())),
      );
    } catch (err) {
      if (err instanceof BadRequest) return reply.code(400).send({ error: err.error });
      throw err;
    }
  };

  // ---- Trial balance (ACC-07, owner answer 4) ----
  scope.get('/reports/trial-balance', { preHandler: financial }, async (req, reply) =>
    run(req, reply, async (c, s) => {
      const q = query(req);
      const p = rangeOf(q, periodOf('thisMonth', s.today, s.startMonth), SUMMARY_DAYS, s);
      const level = q['level'] === 'groups' ? 'groups' : 'accounts';
      const showEmpty = q['empty'] === 'show';
      const tb = trialBalance({ accounts: await chart(c), sums: await periodSums(c, p), level, showEmpty });
      const result: TrialBalanceView = { money: await moneyOf(c), ...p, level, showEmpty, ...tb };
      if (!wantsCsv(req)) return result;
      const sides = (x: { debit: number; credit: number }) => [x.debit, x.credit];
      return sendCsv(
        reply,
        `trial-balance-${p.from}-${p.to}.csv`,
        csv(
          [
            'code',
            'account',
            'level',
            'opening_debit',
            'opening_credit',
            'debit',
            'credit',
            'closing_debit',
            'closing_credit',
          ],
          [
            ...tb.rows.map((r): Cell[] => [
              r.code,
              r.name,
              r.depth,
              ...sides(r.opening),
              ...sides(r.movement),
              ...sides(r.closing),
            ]),
            [
              '',
              'total',
              '',
              ...sides(tb.totals.opening),
              ...sides(tb.totals.movement),
              ...sides(tb.totals.closing),
            ],
          ],
        ),
      );
    }),
  );

  // ---- Profit and loss (ACC-07, owner answers 2 and 3) ----
  scope.get('/reports/profit-loss', { preHandler: financial }, async (req, reply) =>
    run(req, reply, async (c, s) => {
      const q = query(req);
      const p = rangeOf(q, periodOf('thisMonth', s.today, s.startMonth), SUMMARY_DAYS, s);
      const compare =
        (['previous', 'last-year', 'none', 'months'] as const).find((v) => v === q['compare']) ?? 'previous';
      const periods: Period[] =
        compare === 'months'
          ? monthsOf(p)
          : compare === 'previous'
            ? [p, previousPeriod(p)]
            : compare === 'last-year'
              ? [p, lastYearPeriod(p)]
              : [p];
      const accounts = await chart(c);
      const withSums = await Promise.all(
        periods.map(async (period) => ({
          ...period,
          sums: (await periodSums(c, period)).map(({ accountId, debit, credit }) => ({
            accountId,
            debit,
            credit,
          })),
        })),
      );
      const pl = profitAndLoss({ accounts, periods: withSums });
      const stock = await stockPanel(c, accounts, p);
      const result: ProfitLossView = {
        money: await moneyOf(c),
        ...p,
        compare: compare,
        ...pl,
        stock,
      };
      if (!wantsCsv(req)) return result;
      const figure = (name: string, values: (number | null)[]): Cell[] => ['', '', name, ...values];
      return sendCsv(
        reply,
        `profit-and-loss-${p.from}-${p.to}.csv`,
        csv(
          ['section', 'code', 'account', ...pl.periods.map(periodLabel)],
          [
            ...sectionCsv('revenue', pl.revenue),
            ...sectionCsv('cost_of_sales', pl.costOfSales),
            figure('gross_profit', pl.grossProfit),
            figure('gross_margin_bp', pl.grossMargin),
            ...sectionCsv('expenses', pl.expenses),
            figure('net_profit', pl.netProfit),
            figure('net_margin_bp', pl.netMargin),
          ],
        ),
      );
    }),
  );

  /** The stock and purchases panel: the Inventory account's lines by source, and the COGS account (owner answer 2). */
  async function stockPanel(c: Client, accounts: StatementAccount[], p: Period) {
    const inventory = accounts.find((a) => a.role === 'INVENTORY')?.id ?? null;
    const cogs = accounts.find((a) => a.role === 'COGS')?.id ?? null;
    const opening = await c.query<{ b: string }>(
      `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b FROM erp.journal_lines l
       JOIN erp.journal_entries e ON e.id = l.entry_id WHERE l.account_id = $1 AND e.entry_date < $2`,
      [inventory, p.from],
    );
    const movements = await c.query<{ source_type: string; amount: string }>(
      `SELECT x.source_type, sum(l.debit - l.credit)::text AS amount FROM erp.journal_lines l
       JOIN erp.journal_entries e ON e.id = l.entry_id JOIN erp.postings x ON x.seq = e.posting_seq
       WHERE l.account_id = $1 AND e.entry_date BETWEEN $2 AND $3 GROUP BY x.source_type ORDER BY x.source_type`,
      [inventory, p.from, p.to],
    );
    const sold = await c.query<{ b: string }>(
      `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b FROM erp.journal_lines l
       JOIN erp.journal_entries e ON e.id = l.entry_id WHERE l.account_id = $1 AND e.entry_date BETWEEN $2 AND $3`,
      [cogs, p.from, p.to],
    );
    return stockAndPurchases({
      opening: num(opening.rows[0]!.b),
      movements: movements.rows.map((m) => ({ sourceType: m.source_type, amount: num(m.amount) })),
      costOfGoodsSold: num(sold.rows[0]!.b),
    });
  }

  // ---- Balance sheet (ACC-07, owner answer 3) ----
  scope.get('/reports/balance-sheet', { preHandler: financial }, async (req, reply) =>
    run(req, reply, async (c, s) => {
      const q = query(req);
      const at = dateOr(q['at'], s.today);
      // The end of the month before `at`'s, unless another date (or none) is asked for.
      const compareAt =
        q['compareAt'] === 'none' ? null : dateOr(q['compareAt'], dayBefore(`${at.slice(0, 8)}01`));
      const dates = compareAt === null ? [at] : [at, compareAt];
      const accounts = await chart(c);
      const pl = new Set(
        accounts.filter((a) => a.type === 'income' || a.type === 'expense').map((a) => a.id),
      );
      const columns = await Promise.all(
        dates.map(async (d) => ({
          at: d,
          balances: await balancesAt(c, d, null),
          year: (await balancesAt(c, d, fiscalYearOf(d, s.startMonth).start)).filter((b) =>
            pl.has(b.accountId),
          ),
        })),
      );
      const bs = balanceSheet({ accounts, columns });
      const result: BalanceSheetView = { money: await moneyOf(c), at, compareAt, ...bs };
      if (!wantsCsv(req)) return result;
      const figure = (name: string, values: number[]): Cell[] => ['', '', name, ...values];
      return sendCsv(
        reply,
        `balance-sheet-${at}.csv`,
        csv(
          ['section', 'code', 'account', ...dates],
          [
            ...sectionCsv('assets', bs.assets),
            ...sectionCsv('liabilities', bs.liabilities),
            figure('profit_for_year', bs.profitForYear),
            ...(bs.earlierInRetained ? [] : [figure('earlier_profit', bs.earlierProfit)]),
            ...sectionCsv('equity', bs.equity),
            figure('liabilities_and_equity', bs.liabilitiesAndEquity),
            figure('difference', bs.difference),
          ],
        ),
      );
    }),
  );

  // ---- Cash book (ACC-07, owner answer 5) ----
  scope.get('/reports/cash-book', { preHandler: financial }, async (req, reply) =>
    run(req, reply, async (c, s) => {
      const q = query(req);
      const p = rangeOf(q, { from: s.today, to: s.today }, LIST_DAYS, s);
      const accountId = q['accountId'] || null;
      if (accountId !== null && !UUID.test(accountId)) throw new BadRequest('bad_request');
      // One definition of cash and bank with the Money screen: the drawer, cash in transit, the safe, and every
      // account a bank or wallet is linked to.
      const accounts = (
        await c.query<{ id: string; code: string; name: string }>(
          `SELECT a.id, a.code, a.name FROM erp.accounts a
           WHERE a.deleted_at IS NULL AND (a.system_role IN ('CASH_DRAWER', 'CASH_IN_TRANSIT', 'CASH_SAFE')
             OR EXISTS (SELECT 1 FROM erp.bank_accounts b WHERE b.gl_account_id = a.id AND b.deleted_at IS NULL))
           ORDER BY a.code`,
        )
      ).rows;
      const ids = accounts.map((a) => a.id);
      if (accountId !== null && !ids.includes(accountId)) throw new BadRequest('bad_request');
      const shown = accounts.filter((a) => accountId === null || a.id === accountId);
      const openings = new Map(
        (
          await c.query<{ account_id: string; b: string }>(
            `SELECT l.account_id, sum(l.debit - l.credit)::text AS b FROM erp.journal_lines l
             JOIN erp.journal_entries e ON e.id = l.entry_id
             WHERE l.account_id = ANY ($1) AND e.entry_date < $2 GROUP BY l.account_id`,
            [shown.map((a) => a.id), p.from],
          )
        ).rows.map((r) => [r.account_id, num(r.b)]),
      );
      const { rows } = await c.query<{
        account_id: string;
        date: string;
        journal: string;
        source_type: string;
        source_id: string;
        memo: string | null;
        party: string | null;
        debit: string;
        credit: string;
        transfer: boolean;
      }>(
        `SELECT l.account_id, e.entry_date::text AS date, e.number AS journal, x.source_type, x.source_id, e.memo,
           p.name AS party, l.debit::text AS debit, l.credit::text AS credit,
           EXISTS (SELECT 1 FROM erp.journal_lines o
                   WHERE o.entry_id = l.entry_id AND o.id <> l.id AND o.account_id = ANY ($4)) AS transfer
         FROM erp.journal_lines l JOIN erp.journal_entries e ON e.id = l.entry_id
         JOIN erp.postings x ON x.seq = e.posting_seq LEFT JOIN erp.parties p ON p.id = l.party_id
         WHERE l.account_id = ANY ($1) AND e.entry_date BETWEEN $2 AND $3
         ORDER BY e.entry_date, e.posting_seq, l.line_no`,
        [shown.map((a) => a.id), p.from, p.to, ids],
      );
      const book = cashBook({
        accounts: shown.map((a) => ({ id: a.id, opening: openings.get(a.id) ?? 0 })),
        lines: rows.map((r) => ({
          accountId: r.account_id,
          date: r.date,
          debit: num(r.debit),
          credit: num(r.credit),
          journalNumber: r.journal,
          sourceType: r.source_type,
          sourceId: r.source_id,
          number: numberOf(r.memo),
          memo: r.memo,
          partyName: r.party,
          transfer: r.transfer,
        })),
      });
      const names = new Map(shown.map((a) => [a.id, a]));
      const out: CashBookAccount[] = book.map((a) => ({
        id: a.id,
        code: names.get(a.id)!.code,
        name: names.get(a.id)!.name,
        opening: a.opening,
        in: a.in,
        out: a.out,
        closing: a.closing,
        days: a.days,
        lines: a.lines.slice(0, PAGE).map((l) => ({
          date: l.date,
          journalNumber: l.journalNumber,
          sourceType: l.sourceType,
          sourceId: l.sourceId,
          number: l.number,
          memo: l.memo,
          partyName: l.partyName,
          debit: l.debit,
          credit: l.credit,
          balance: l.balance,
          transfer: l.transfer,
        })),
        truncated: a.lines.length > PAGE,
      }));
      const result: CashBookView = {
        money: await moneyOf(c),
        ...p,
        accountId,
        choices: accounts.map((a) => ({ id: a.id, code: a.code, name: a.name })),
        accounts: out,
      };
      if (!wantsCsv(req)) return result;
      return sendCsv(
        reply,
        `cash-book-${p.from}-${p.to}.csv`,
        csv(
          [
            'account',
            'date',
            'journal',
            'document',
            'source',
            'memo',
            'party',
            'in',
            'out',
            'balance',
            'transfer',
          ],
          book.flatMap((a) => [
            [names.get(a.id)!.code, p.from, '', '', 'opening', '', '', '', '', a.opening, ''],
            ...a.lines.map((l): Cell[] => [
              names.get(a.id)!.code,
              l.date,
              l.journalNumber,
              l.number,
              l.sourceType,
              l.memo,
              l.partyName,
              l.debit,
              l.credit,
              l.balance,
              l.transfer ? 'yes' : '',
            ]),
            [names.get(a.id)!.code, p.to, '', '', 'closing', '', '', a.in, a.out, a.closing, ''],
          ]),
        ),
      );
    }),
  );

  // ---- Day book (RPT-11) ----
  scope.get('/reports/day-book', { preHandler: financial }, async (req, reply) =>
    run(req, reply, async (c, s) => {
      const q = query(req);
      const p = rangeOf(q, { from: s.today, to: s.today }, LIST_DAYS, s);
      const type = q['type'] || null;
      if (type !== null && !(JOURNAL_SOURCES as readonly string[]).includes(type))
        throw new BadRequest('bad_request');
      const entries = await c.query<{
        id: string;
        date: string;
        journal: string;
        source_type: string;
        source_id: string;
        memo: string | null;
        reversal: boolean;
      }>(
        `SELECT e.id, e.entry_date::text AS date, e.number AS journal, x.source_type, x.source_id, e.memo,
           (e.reversal_of_id IS NOT NULL
            OR EXISTS (SELECT 1 FROM erp.journal_entries r WHERE r.reversal_of_id = e.id)
            OR EXISTS (SELECT 1 FROM erp.journal_vouchers v
                       WHERE v.reverses_id IS NOT NULL AND (v.id = x.source_id OR v.reverses_id = x.source_id))) AS reversal
         FROM erp.journal_entries e JOIN erp.postings x ON x.seq = e.posting_seq
         WHERE e.entry_date BETWEEN $1 AND $2 AND ($3::text IS NULL OR x.source_type = $3)
         ORDER BY e.posting_seq, e.number LIMIT ${PAGE + 1}`,
        [p.from, p.to, type],
      );
      const page = entries.rows.slice(0, PAGE);
      const lines = await c.query<{
        entry_id: string;
        account_id: string;
        code: string;
        name: string;
        party: string | null;
        debit: string;
        credit: string;
        memo: string | null;
      }>(
        `SELECT l.entry_id, l.account_id, a.code, a.name, p.name AS party, l.debit::text AS debit,
           l.credit::text AS credit, l.memo
         FROM erp.journal_lines l JOIN erp.accounts a ON a.id = l.account_id
         LEFT JOIN erp.parties p ON p.id = l.party_id
         WHERE l.entry_id = ANY ($1) ORDER BY l.entry_id, l.line_no`,
        [page.map((e) => e.id)],
      );
      const totals = (
        await c.query<{ entries: number; debit: string; credit: string }>(
          `SELECT count(DISTINCT e.id)::int AS entries, coalesce(sum(l.debit), 0)::text AS debit,
             coalesce(sum(l.credit), 0)::text AS credit
           FROM erp.journal_entries e JOIN erp.postings x ON x.seq = e.posting_seq
           JOIN erp.journal_lines l ON l.entry_id = e.id
           WHERE e.entry_date BETWEEN $1 AND $2 AND ($3::text IS NULL OR x.source_type = $3)`,
          [p.from, p.to, type],
        )
      ).rows[0]!;
      const linesOf = new Map<string, DayBookEntry['lines']>();
      for (const l of lines.rows)
        linesOf.set(l.entry_id, [
          ...(linesOf.get(l.entry_id) ?? []),
          {
            accountId: l.account_id,
            accountCode: l.code,
            accountName: l.name,
            partyName: l.party,
            debit: num(l.debit),
            credit: num(l.credit),
            memo: l.memo,
          },
        ]);
      const list: DayBookEntry[] = page.map((e) => {
        const ls = linesOf.get(e.id) ?? [];
        return {
          id: e.id,
          date: e.date,
          journalNumber: e.journal,
          sourceType: e.source_type,
          sourceId: e.source_id,
          number: numberOf(e.memo),
          memo: e.memo,
          reversal: e.reversal,
          debit: ls.reduce((t, l) => t + l.debit, 0),
          credit: ls.reduce((t, l) => t + l.credit, 0),
          lines: ls,
        };
      });
      const result: DayBookView = {
        money: await moneyOf(c),
        ...p,
        type,
        entries: list,
        totals: { entries: totals.entries, debit: num(totals.debit), credit: num(totals.credit) },
        truncated: entries.rows.length > PAGE,
      };
      if (!wantsCsv(req)) return result;
      return sendCsv(
        reply,
        `day-book-${p.from}-${p.to}.csv`,
        csv(
          [
            'date',
            'journal',
            'document',
            'source',
            'reversal',
            'account',
            'account_name',
            'party',
            'debit',
            'credit',
            'memo',
          ],
          list.flatMap((e) =>
            e.lines.map((l): Cell[] => [
              e.date,
              e.journalNumber,
              e.number,
              e.sourceType,
              e.reversal ? 'yes' : '',
              l.accountCode,
              l.accountName,
              l.partyName,
              l.debit,
              l.credit,
              l.memo ?? e.memo,
            ]),
          ),
        ),
      );
    }),
  );

  // ---- Expenses by month (RPT-11) ----
  scope.get('/reports/expenses', { preHandler: financial }, async (req, reply) =>
    run(req, reply, async (c, s) => {
      const q = query(req);
      const year = fiscalYearOf(s.today, s.startMonth);
      const p = rangeOf(
        q,
        { from: year.start, to: periodOf('thisMonth', s.today, s.startMonth).to },
        SUMMARY_DAYS,
        s,
      );
      const months = monthsOf(p);
      const accounts = await chart(c);
      // The months, then the whole range: its column is each row's total.
      const periods = await Promise.all(
        [...months, p].map(async (period) => ({
          ...period,
          sums: (await periodSums(c, period)).map(({ accountId, debit, credit }) => ({
            accountId,
            debit,
            credit,
          })),
        })),
      );
      const { expenses } = profitAndLoss({ accounts, periods });
      const result: ExpensesView = {
        money: await moneyOf(c),
        ...p,
        months,
        rows: expenses.rows,
        total: expenses.total,
      };
      if (!wantsCsv(req)) return result;
      return sendCsv(
        reply,
        `expenses-${p.from}-${p.to}.csv`,
        csv(
          ['code', 'account', ...months.map(periodLabel), 'total'],
          [
            ...expenses.rows.map((r): Cell[] => [r.code, `${'  '.repeat(r.depth)}${r.name}`, ...r.amounts]),
            ['', 'total', ...expenses.total],
          ],
        ),
      );
    }),
  );
}
