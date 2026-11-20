import {
  JOURNAL_SOURCES,
  type BalanceSheetView,
  type CashBookView,
  type DayBookEntry,
  type DayBookView,
  type ExpensesView,
  type ProfitLossCompare,
  type ProfitLossView,
  type StatementSectionView,
  type TrialBalanceView,
} from '@erp/contracts';
import { changeOf } from '@erp/domain';
import { Checkbox, Input, Label, Panel, StatusChip, TableCell, TableRow } from '@erp/ui';
import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import type { Badges } from '../layout/Sidebar';
import { REPORT_SECTIONS, REPORTS, mayOpen } from './catalog';
import { apiQuery, useFilters } from './frame/filters';
import { documentHref, ledgerHref } from './frame/links';
import {
  ChoiceFilter,
  DateFilter,
  ListTable,
  moneyText,
  percentText,
  PeriodFilter,
  periodOf,
  periodQuery,
  periodWords,
  ReportPage,
  StatementTable,
  useReport,
  type StatementLine,
} from './frame/ReportFrame';

// The Reports home and the financial statements (W2-01 plan; ACC-07, RPT-11; owner answers 1–7; D-116), each on the
// report frame. Read only; every one needs reports.financial (the API refuses anyone else).

type Money = TrialBalanceView['money'];

// ---- The Reports home (owner answer 1) ----

export function ReportsHomeScreen({
  permissions,
  badges = {},
}: {
  permissions: readonly string[];
  badges?: Badges;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const q = search.trim().toLocaleLowerCase();
  const reports = REPORTS.filter((r) => mayOpen(r, permissions)).filter(
    (r) =>
      q === '' || `${t(`nav.${r.key}`)}\n${t(`reports.home.about.${r.key}`)}`.toLocaleLowerCase().includes(q),
  );
  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 font-display text-[28px] leading-tight font-bold">{t('reports.home.title')}</h1>
          <p className="m-0 max-w-[75ch] text-muted-foreground">{t('reports.home.help')}</p>
        </div>
        <Input
          type="search"
          aria-label={t('reports.home.search')}
          placeholder={t('reports.home.search')}
          className="h-9 w-72"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </header>
      {reports.length === 0 && <p className="text-muted-foreground">{t('reports.home.none')}</p>}
      <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
        {REPORT_SECTIONS.map((section) => {
          const inSection = reports.filter((r) => r.section === section);
          if (inSection.length === 0) return null;
          return (
            <Panel key={section} title={t(`reports.home.sections.${section}`)} className="pb-2">
              <ul className="m-0 list-none p-0">
                {inSection.map((r) => {
                  const count = r.key === 'exceptions' ? (badges.reports ?? 0) : 0;
                  return (
                    <li key={r.key}>
                      <a
                        href={r.href}
                        className="flex flex-col gap-0.5 px-3.5 py-2 text-ink no-underline hover:bg-surface-2"
                      >
                        <span className="flex items-center gap-2 font-semibold">
                          {t(`nav.${r.key}`)}
                          {count > 0 && <StatusChip tone="bad">{t('nav.badge', { count })}</StatusChip>}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          {t(`reports.home.about.${r.key}`)}
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          );
        })}
      </div>
    </>
  );
}

// ---- Shared pieces ----

/** A statement section as lines: its heading, its rows down the chart (each opening its ledger), its total. */
function sectionLines(
  key: string,
  title: string,
  total: string,
  s: StatementSectionView,
  drill: ((id: string) => string) | null,
  extra: (amounts: number[]) => (number | string | null)[] = (a) => a,
): StatementLine[] {
  return [
    { key: `${key}-h`, kind: 'heading', depth: 0, name: title, cells: [] },
    ...s.rows.map((r): StatementLine => ({
      key: `${key}-${r.id}`,
      kind: r.group ? 'group' : 'account',
      depth: r.depth + 1,
      code: r.code,
      name: r.name,
      cells: extra(r.amounts),
      href: !r.group && drill ? drill(r.id) : null,
    })),
    { key: `${key}-t`, kind: 'total', depth: 0, name: total, cells: extra(s.total) },
  ];
}

const figureLine = (key: string, name: string, cells: (number | string | null)[]): StatementLine => ({
  key,
  kind: 'total',
  depth: 0,
  name,
  cells,
});

// ---- Trial balance (owner answer 4) ----

export function TrialBalanceScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [filters, setFilters] = useFilters('trialBalance');
  const period = periodOf(filters, 'thisMonth');
  const level = filters['level'] === 'groups' ? 'groups' : 'accounts';
  const empty = filters['empty'] === 'show';
  const set = (next: Record<string, string>) =>
    setFilters({ ...periodQuery(period), level, empty: empty ? 'show' : '', ...next });
  const url = `/api/reports/trial-balance?${apiQuery({ ...periodQuery(period), level, empty: empty ? 'show' : 'hide' })}`;
  const { report, error } = useReport<TrialBalanceView>(api, url);
  const m = report?.money;
  const sides = (s: { debit: number; credit: number }) => [s.debit, s.credit];
  const lines: StatementLine[] =
    report && m
      ? [
          ...report.rows.map((r): StatementLine => ({
            key: r.id,
            kind: r.group ? 'group' : 'account',
            depth: r.depth,
            code: r.code,
            name: r.name,
            cells: [...sides(r.opening), ...sides(r.movement), ...sides(r.closing)],
            href: r.group ? null : ledgerHref(r.id, report.from, report.to),
          })),
          figureLine('total', t('reports.tb.total'), [
            ...sides(report.totals.opening),
            ...sides(report.totals.movement),
            ...sides(report.totals.closing),
          ]),
        ]
      : [];
  return (
    <ReportPage
      title={t('nav.trialBalance')}
      help={t('reports.tb.help')}
      filters={
        <>
          <PeriodFilter value={period} shown={report} onChange={(p) => set(periodQuery(p))} />
          <ChoiceFilter
            label={t('reports.tb.show')}
            value={level}
            options={[
              { value: 'accounts', label: t('reports.tb.accounts') },
              { value: 'groups', label: t('reports.tb.groups') },
            ]}
            onChange={(v) => set({ level: v })}
          />
          <div className="flex h-9 items-center gap-2">
            <Checkbox
              id="tb-empty"
              checked={empty}
              onCheckedChange={(c) => set({ empty: c === true ? 'show' : '' })}
            />
            <Label htmlFor="tb-empty">{t('reports.tb.empty')}</Label>
          </div>
        </>
      }
      printFilters={periodWords(report)}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={report === null}
      figures={
        report && m
          ? [
              {
                key: 'debit',
                label: t('reports.tb.closingDebit'),
                value: moneyText(report.totals.closing.debit, m),
              },
              {
                key: 'credit',
                label: t('reports.tb.closingCredit'),
                value: moneyText(report.totals.closing.credit, m),
              },
              {
                key: 'balanced',
                label: t('reports.tb.check'),
                value: report.balanced ? t('reports.tb.balanced') : t('reports.tb.unbalanced'),
                tone: report.balanced ? 'good' : 'bad',
              },
            ]
          : []
      }
    >
      {report && m && (
        <StatementTable
          label={t('nav.trialBalance')}
          money={m}
          blankZero
          lines={lines}
          columns={[
            t('reports.tb.openingDebit'),
            t('reports.tb.openingCredit'),
            t('reports.tb.debit'),
            t('reports.tb.credit'),
            t('reports.tb.closingDebit'),
            t('reports.tb.closingCredit'),
          ]}
        />
      )}
    </ReportPage>
  );
}

// ---- Profit and loss (owner answers 2 and 3) ----

const COMPARES: ProfitLossCompare[] = ['previous', 'last-year', 'months', 'none'];

const periodHeading = (p: { from: string; to: string }) => (p.from === p.to ? p.from : `${p.from} – ${p.to}`);

export function ProfitLossScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [filters, setFilters] = useFilters('profitLoss');
  const period = periodOf(filters, 'thisMonth');
  const compare = COMPARES.find((c) => c === filters['compare']) ?? 'previous';
  const url = `/api/reports/profit-loss?${apiQuery({ ...periodQuery(period), compare })}`;
  const { report, error } = useReport<ProfitLossView>(api, url);
  const m = report?.money;
  // Against one other period: the change in rupees and %, beside the two columns.
  const withChange = compare === 'previous' || compare === 'last-year';
  const extra = (a: (number | null)[]): (number | string | null)[] => {
    if (!withChange || !m) return a;
    const change = changeOf(a[0] ?? 0, a[1] ?? 0);
    return [...a, change.amount, percentText(change.bp, m.locale)];
  };
  const drill = report ? (id: string) => ledgerHref(id, report.from, report.to) : null;
  const margins = (v: (number | null)[]) => v.map((x) => (m ? percentText(x, m.locale) : null));
  const lines: StatementLine[] =
    report && m
      ? [
          ...sectionLines(
            'rev',
            t('reports.pl.revenue'),
            t('reports.pl.totalRevenue'),
            report.revenue,
            drill,
            extra,
          ),
          ...sectionLines(
            'cos',
            t('reports.pl.costOfSales'),
            t('reports.pl.totalCostOfSales'),
            report.costOfSales,
            drill,
            extra,
          ),
          figureLine('gp', t('reports.pl.grossProfit'), extra(report.grossProfit)),
          figureLine('gm', t('reports.pl.grossMargin'), [
            ...margins(report.grossMargin),
            ...(withChange ? ['', ''] : []),
          ]),
          ...sectionLines(
            'exp',
            t('reports.pl.expenses'),
            t('reports.pl.totalExpenses'),
            report.expenses,
            drill,
            extra,
          ),
          figureLine('np', t('reports.pl.netProfit'), extra(report.netProfit)),
          figureLine('nm', t('reports.pl.netMargin'), [
            ...margins(report.netMargin),
            ...(withChange ? ['', ''] : []),
          ]),
        ]
      : [];
  return (
    <ReportPage
      title={t('nav.profitLoss')}
      help={t('reports.pl.help')}
      filters={
        <>
          <PeriodFilter
            value={period}
            shown={report}
            onChange={(p) => setFilters({ ...periodQuery(p), compare })}
          />
          <ChoiceFilter
            label={t('reports.pl.compare')}
            value={compare}
            options={COMPARES.map((c) => ({ value: c, label: t(`reports.pl.compareTo.${c}`) }))}
            onChange={(v) => setFilters({ ...periodQuery(period), compare: v })}
          />
        </>
      }
      printFilters={`${periodWords(report)} · ${t(`reports.pl.compareTo.${compare}`)}`}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={report === null}
      figures={
        report && m
          ? [
              {
                key: 'revenue',
                label: t('reports.pl.revenue'),
                value: moneyText(report.revenue.total[0]!, m),
              },
              {
                key: 'gross',
                label: t('reports.pl.grossProfit'),
                value: moneyText(report.grossProfit[0]!, m),
              },
              {
                key: 'net',
                label: t('reports.pl.netProfit'),
                value: moneyText(report.netProfit[0]!, m),
                tone: report.netProfit[0]! < 0 ? 'bad' : 'good',
              },
              {
                key: 'margin',
                label: t('reports.pl.netMargin'),
                value: percentText(report.netMargin[0]!, m.locale),
              },
            ]
          : []
      }
    >
      {report && m && (
        <>
          <StatementTable
            label={t('nav.profitLoss')}
            money={m}
            lines={lines}
            columns={[
              ...report.periods.map(periodHeading),
              ...(withChange ? [t('reports.pl.change'), t('reports.pl.changePct')] : []),
            ]}
          />
          <StockPanel stock={report.stock} m={m} t={t} />
        </>
      )}
    </ReportPage>
  );
}

/** The familiar "stock and purchases" view under the cost of goods sold, made from the same books (owner answer 2). */
function StockPanel({ stock, m, t }: { stock: ProfitLossView['stock']; m: Money; t: TFunction }) {
  const rows: [string, number][] = [
    [t('reports.pl.stock.opening'), stock.opening],
    [t('reports.pl.stock.purchases'), stock.purchases],
    [t('reports.pl.stock.purchaseReturns'), stock.purchaseReturns],
    [t('reports.pl.stock.adjustments'), stock.adjustments],
    ...(stock.other !== 0 ? [[t('reports.pl.stock.other'), stock.other] as [string, number]] : []),
    [t('reports.pl.stock.closing'), -stock.closing],
  ];
  return (
    <Panel title={t('reports.pl.stock.title')} className="pb-2">
      <table className="w-full max-w-xl border-collapse" aria-label={t('reports.pl.stock.title')}>
        <tbody>
          {rows.map(([label, v]) => (
            <tr key={label}>
              <td className="px-3.5 py-1">{label}</td>
              <td className="px-3.5 py-1 text-end tabular-nums">{moneyText(v, m)}</td>
            </tr>
          ))}
          <tr className="border-t border-line font-semibold">
            <td className="px-3.5 py-1">{t('reports.pl.stock.used')}</td>
            <td className="px-3.5 py-1 text-end tabular-nums">{moneyText(stock.stockUsed, m)}</td>
          </tr>
          <tr>
            <td className="px-3.5 py-1">{t('reports.pl.stock.books')}</td>
            <td className="px-3.5 py-1 text-end tabular-nums">{moneyText(stock.costOfGoodsSold, m)}</td>
          </tr>
          {stock.difference !== 0 && (
            <tr className="font-semibold text-bad">
              <td className="px-3.5 py-1">{t('reports.pl.stock.difference')}</td>
              <td className="px-3.5 py-1 text-end tabular-nums">{moneyText(stock.difference, m)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </Panel>
  );
}

// ---- Balance sheet (owner answer 3) ----

export function BalanceSheetScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [filters, setFilters] = useFilters('balanceSheet');
  const at = filters['at'] ?? '';
  const compareAt = filters['compareAt'] ?? '';
  const asked = { ...(at ? { at } : {}), ...(compareAt ? { compareAt } : {}) };
  const query = apiQuery(asked);
  const url = query ? `/api/reports/balance-sheet?${query}` : '/api/reports/balance-sheet';
  const { report, error } = useReport<BalanceSheetView>(api, url);
  const m = report?.money;
  const compared = report !== null && report.columns.length > 1;
  const extra = (a: (number | null)[]): (number | string | null)[] => {
    if (!compared || !m) return a;
    const change = changeOf(a[0] ?? 0, a[1] ?? 0);
    return [...a, change.amount, percentText(change.bp, m.locale)];
  };
  // An amount opens its ledger up to the date, from the start of that month.
  const drill = report ? (id: string) => ledgerHref(id, `${report.at.slice(0, 8)}01`, report.at) : null;
  const lines: StatementLine[] =
    report && m
      ? [
          ...sectionLines(
            'a',
            t('reports.bs.assets'),
            t('reports.bs.totalAssets'),
            report.assets,
            drill,
            extra,
          ),
          ...sectionLines(
            'l',
            t('reports.bs.liabilities'),
            t('reports.bs.totalLiabilities'),
            report.liabilities,
            drill,
            extra,
          ),
          ...sectionLines(
            'e',
            t('reports.bs.equity'),
            t('reports.bs.totalEquity'),
            report.equity,
            drill,
            extra,
          ).flatMap((l) =>
            l.key === 'e-t'
              ? [
                  ...(report.earlierInRetained
                    ? []
                    : [
                        {
                          key: 'e-earlier',
                          kind: 'account' as const,
                          depth: 1,
                          name: t('reports.bs.earlierProfit'),
                          cells: extra(report.earlierProfit),
                        },
                      ]),
                  {
                    key: 'e-profit',
                    kind: 'account' as const,
                    depth: 1,
                    name: t('reports.bs.profitForYear'),
                    cells: extra(report.profitForYear),
                  },
                  l,
                ]
              : [l],
          ),
          figureLine('le', t('reports.bs.liabilitiesAndEquity'), extra(report.liabilitiesAndEquity)),
          ...(report.difference.some((d) => d !== 0)
            ? [figureLine('diff', t('reports.bs.difference'), report.difference)]
            : []),
        ]
      : [];
  const shownCompare = report?.compareAt ?? 'none';
  return (
    <ReportPage
      title={t('nav.balanceSheet')}
      help={t('reports.bs.help')}
      filters={
        <>
          <DateFilter
            label={t('reports.bs.at')}
            value={report?.at ?? at}
            onChange={(v) => setFilters({ at: v, compareAt })}
          />
          <DateFilter
            label={t('reports.bs.compareAt')}
            value={shownCompare === 'none' ? '' : shownCompare}
            onChange={(v) => setFilters({ at, compareAt: v || 'none' })}
          />
        </>
      }
      printFilters={report ? `${report.at}${report.compareAt ? ` · ${report.compareAt}` : ''}` : ''}
      csv={report && `${url}${query ? '&' : '?'}format=csv`}
      error={error}
      loading={report === null}
      figures={
        report && m
          ? [
              {
                key: 'assets',
                label: t('reports.bs.totalAssets'),
                value: moneyText(report.assets.total[0]!, m),
              },
              {
                key: 'profit',
                label: t('reports.bs.profitForYear'),
                value: moneyText(report.profitForYear[0]!, m),
                tone: report.profitForYear[0]! < 0 ? 'bad' : 'good',
              },
              {
                key: 'check',
                label: t('reports.tb.check'),
                value: report.difference[0] === 0 ? t('reports.tb.balanced') : t('reports.tb.unbalanced'),
                tone: report.difference[0] === 0 ? 'good' : 'bad',
              },
            ]
          : []
      }
    >
      {report && m && (
        <StatementTable
          label={t('nav.balanceSheet')}
          money={m}
          lines={lines}
          columns={[
            ...report.columns.map((c) => c.at),
            ...(compared ? [t('reports.pl.change'), t('reports.pl.changePct')] : []),
          ]}
        />
      )}
    </ReportPage>
  );
}

// ---- Cash book (owner answer 5) ----

export function CashBookScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [filters, setFilters] = useFilters('cashBook');
  const period = periodOf(filters, 'today');
  const accountId = filters['accountId'] ?? '';
  const url = `/api/reports/cash-book?${apiQuery({ ...periodQuery(period), ...(accountId ? { accountId } : {}) })}`;
  const { report, error } = useReport<CashBookView>(api, url);
  const m = report?.money;
  const total = (k: 'opening' | 'in' | 'out' | 'closing') =>
    report?.accounts.reduce((s, a) => s + a[k], 0) ?? 0;
  return (
    <ReportPage
      title={t('nav.cashBook')}
      help={t('reports.cash.help')}
      filters={
        <>
          <PeriodFilter
            value={period}
            shown={report}
            onChange={(p) => setFilters({ ...periodQuery(p), accountId })}
          />
          <ChoiceFilter
            label={t('reports.cash.account')}
            value={accountId}
            options={[
              { value: '', label: t('reports.cash.all') },
              ...(report?.choices ?? []).map((a) => ({ value: a.id, label: `${a.code} ${a.name}` })),
            ]}
            onChange={(v) => setFilters({ ...periodQuery(period), accountId: v })}
          />
        </>
      }
      printFilters={periodWords(report)}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={report === null}
      figures={
        report && m
          ? [
              { key: 'opening', label: t('reports.cash.opening'), value: moneyText(total('opening'), m) },
              { key: 'in', label: t('reports.cash.in'), value: moneyText(total('in'), m) },
              { key: 'out', label: t('reports.cash.out'), value: moneyText(total('out'), m) },
              { key: 'closing', label: t('reports.cash.closing'), value: moneyText(total('closing'), m) },
            ]
          : []
      }
    >
      {report &&
        m &&
        report.accounts.map((a) => (
          <section key={a.id} aria-label={`${a.code} ${a.name}`} className="flex flex-col gap-2">
            <h2 className="m-0 font-display text-lg font-semibold">
              <a
                href={ledgerHref(a.id, report.from, report.to)}
                className="underline-offset-4 hover:underline"
              >
                {a.code} {a.name}
              </a>
              <span className="ms-3 text-sm font-normal text-muted-foreground">
                {t('reports.cash.summary', {
                  opening: moneyText(a.opening, m),
                  in: moneyText(a.in, m),
                  out: moneyText(a.out, m),
                  closing: moneyText(a.closing, m),
                })}
              </span>
            </h2>
            {a.lines.length > 0 && (
              <ListTable
                label={`${a.code} ${a.name}`}
                rows={a.lines.map((l, i) => ({ ...l, i }))}
                rowKey={(l) => String(l.i)}
                text={(l) => `${l.journalNumber} ${l.number ?? ''} ${l.memo ?? ''} ${l.partyName ?? ''}`}
                columns={[
                  { key: 'date', label: t('accounting.fields.date'), cell: (l) => l.date },
                  {
                    key: 'document',
                    label: t('reports.frame.document'),
                    cell: (l) => {
                      const link = documentHref(l.sourceType, l.sourceId, l.number);
                      const text = l.number ?? l.journalNumber;
                      return link ? (
                        <a href={link} className="font-mono underline-offset-4 hover:underline">
                          {text}
                        </a>
                      ) : (
                        <span className="font-mono">{text}</span>
                      );
                    },
                  },
                  {
                    key: 'memo',
                    label: t('accounting.ledger.memo'),
                    cell: (l) => (
                      <>
                        {l.memo ?? ''}
                        {l.transfer && (
                          <span className="ms-2">
                            <StatusChip tone="neutral">{t('reports.cash.transfer')}</StatusChip>
                          </span>
                        )}
                      </>
                    ),
                  },
                  { key: 'party', label: t('accounting.fields.party'), cell: (l) => l.partyName ?? '' },
                  {
                    key: 'in',
                    label: t('reports.cash.in'),
                    end: true,
                    cell: (l) => moneyText(l.debit, m, true),
                  },
                  {
                    key: 'out',
                    label: t('reports.cash.out'),
                    end: true,
                    cell: (l) => moneyText(l.credit, m, true),
                  },
                  {
                    key: 'balance',
                    label: t('accounting.accounts.balance'),
                    end: true,
                    cell: (l) => moneyText(l.balance, m),
                  },
                ]}
              />
            )}
            {a.days.length > 1 && (
              <ListTable
                label={t('reports.cash.days', { account: `${a.code} ${a.name}` })}
                rows={a.days}
                rowKey={(d) => d.date}
                text={(d) => d.date}
                columns={[
                  {
                    key: 'date',
                    label: t('accounting.fields.date'),
                    sort: (d) => d.date,
                    cell: (d) => d.date,
                  },
                  {
                    key: 'opening',
                    label: t('reports.cash.opening'),
                    end: true,
                    cell: (d) => moneyText(d.opening, m),
                  },
                  {
                    key: 'in',
                    label: t('reports.cash.in'),
                    end: true,
                    sort: (d) => d.in,
                    cell: (d) => moneyText(d.in, m),
                  },
                  {
                    key: 'out',
                    label: t('reports.cash.out'),
                    end: true,
                    sort: (d) => d.out,
                    cell: (d) => moneyText(d.out, m),
                  },
                  {
                    key: 'closing',
                    label: t('reports.cash.closing'),
                    end: true,
                    cell: (d) => moneyText(d.closing, m),
                  },
                ]}
              />
            )}
            {a.truncated && <p className="m-0 px-2 text-sm text-warn">{t('reports.frame.truncated')}</p>}
          </section>
        ))}
    </ReportPage>
  );
}

// ---- Day book (RPT-11) ----

export function DayBookScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [filters, setFilters] = useFilters('dayBook');
  const period = periodOf(filters, 'today');
  const type = filters['type'] ?? '';
  const url = `/api/reports/day-book?${apiQuery({ ...periodQuery(period), ...(type ? { type } : {}) })}`;
  const { report, error } = useReport<DayBookView>(api, url);
  const m = report?.money;
  return (
    <ReportPage
      title={t('nav.dayBook')}
      help={t('reports.dayBook.help')}
      filters={
        <>
          <PeriodFilter
            value={period}
            shown={report}
            onChange={(p) => setFilters({ ...periodQuery(p), type })}
          />
          <ChoiceFilter
            label={t('reports.dayBook.type')}
            value={type}
            options={[
              { value: '', label: t('reports.dayBook.all') },
              ...JOURNAL_SOURCES.map((s) => ({ value: s, label: t(`reports.sources.${s}`) })),
            ]}
            onChange={(v) => setFilters({ ...periodQuery(period), type: v })}
          />
        </>
      }
      printFilters={`${periodWords(report)}${type ? ` · ${t(`reports.sources.${type}`)}` : ''}`}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={report === null}
      figures={
        report && m
          ? [
              { key: 'entries', label: t('reports.dayBook.entries'), value: report.totals.entries },
              { key: 'debit', label: t('accounting.fields.debit'), value: moneyText(report.totals.debit, m) },
              {
                key: 'credit',
                label: t('accounting.fields.credit'),
                value: moneyText(report.totals.credit, m),
              },
            ]
          : []
      }
    >
      {report && m && (
        <>
          <ListTable<DayBookEntry>
            label={t('nav.dayBook')}
            rows={report.entries}
            rowKey={(e) => e.id}
            text={(e) =>
              `${e.journalNumber} ${e.number ?? ''} ${e.memo ?? ''} ${t(`reports.sources.${e.sourceType}`)} ${e.lines
                .map((l) => `${l.accountCode} ${l.accountName} ${l.partyName ?? ''}`)
                .join(' ')}`
            }
            columns={[
              { key: 'date', label: t('accounting.fields.date'), sort: (e) => e.date, cell: (e) => e.date },
              {
                key: 'journal',
                label: t('accounting.ledger.journal'),
                sort: (e) => e.journalNumber,
                cell: (e) => <span className="font-mono">{e.journalNumber}</span>,
              },
              {
                key: 'document',
                label: t('reports.frame.document'),
                cell: (e) => {
                  const link = documentHref(e.sourceType, e.sourceId, e.number);
                  return link ? (
                    <a href={link} className="font-mono underline-offset-4 hover:underline">
                      {e.number ?? e.journalNumber}
                    </a>
                  ) : (
                    <span className="font-mono">{e.number ?? ''}</span>
                  );
                },
              },
              {
                key: 'type',
                label: t('reports.dayBook.type'),
                sort: (e) => e.sourceType,
                cell: (e) => (
                  <>
                    {t(`reports.sources.${e.sourceType}`)}
                    {e.reversal && (
                      <span className="ms-2">
                        <StatusChip tone="warn">{t('reports.dayBook.reversal')}</StatusChip>
                      </span>
                    )}
                  </>
                ),
              },
              { key: 'memo', label: t('accounting.ledger.memo'), cell: (e) => e.memo ?? '' },
              {
                key: 'amount',
                label: t('reports.dayBook.amount'),
                end: true,
                sort: (e) => e.debit,
                cell: (e) => moneyText(e.debit, m),
              },
            ]}
            details={(e) =>
              e.lines.map((l, i) => (
                <TableRow key={`${e.id}-${i}`} className="text-sm text-muted-foreground">
                  <TableCell />
                  <TableCell colSpan={3} style={{ paddingInlineStart: '1.5rem' }}>
                    <span className="me-2 font-mono">{l.accountCode}</span>
                    {l.accountName}
                    {l.partyName ? ` · ${l.partyName}` : ''}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">{moneyText(l.debit, m, true)}</TableCell>
                  <TableCell className="text-end tabular-nums">{moneyText(l.credit, m, true)}</TableCell>
                </TableRow>
              ))
            }
          />
          {report.truncated && <p className="m-0 px-2 text-sm text-warn">{t('reports.frame.truncated')}</p>}
        </>
      )}
    </ReportPage>
  );
}

// ---- Expenses by month (RPT-11) ----

export function ExpensesScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [filters, setFilters] = useFilters('expensesReport');
  const period = periodOf(filters, 'thisYear');
  const url = `/api/reports/expenses?${apiQuery(periodQuery(period))}`;
  const { report, error } = useReport<ExpensesView>(api, url);
  const m = report?.money;
  const lines: StatementLine[] =
    report && m
      ? [
          ...report.rows.map((r): StatementLine => ({
            key: r.id,
            kind: r.group ? 'group' : 'account',
            depth: r.depth,
            code: r.code,
            name: r.name,
            cells: r.amounts,
            href: r.group ? null : ledgerHref(r.id, report.from, report.to),
          })),
          figureLine('total', t('reports.pl.totalExpenses'), report.total),
        ]
      : [];
  return (
    <ReportPage
      title={t('nav.expensesReport')}
      help={t('reports.expenses.help')}
      filters={<PeriodFilter value={period} shown={report} onChange={(p) => setFilters(periodQuery(p))} />}
      printFilters={periodWords(report)}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={report === null}
      figures={
        report && m
          ? [
              {
                key: 'total',
                label: t('reports.pl.totalExpenses'),
                value: moneyText(report.total.at(-1)!, m),
              },
            ]
          : []
      }
    >
      {report && m && (
        <StatementTable
          label={t('nav.expensesReport')}
          money={m}
          lines={lines}
          columns={[...report.months.map((p) => p.from.slice(0, 7)), t('reports.expenses.total')]}
        />
      )}
    </ReportPage>
  );
}
